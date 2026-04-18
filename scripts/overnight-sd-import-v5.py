#!/usr/bin/env python3
"""
Overnight SD-card photo import — v5 (2026-04-18 evening run).

Designed from lessons of v4 (Friday) + today's catastrophe postmortems:
  - docs/plans/2026-04-18-friday-recovery-truths.md
  - docs/plans/2026-04-18-friday-script-mistakes-postmortem.md
  - docs/plans/2026-04-18-saturday-photo-import-incident.md

MAJOR CHANGES FROM v4:
  1. EDT timezone awareness: raw EXIF DateTimeOriginal is treated as America/New_York
     (camera-local clock). Conversion to UTC = +4h in April. No more "+00:00" lie.
  2. Routine windows come from media_packages.video_start_timestamp/video_end_timestamp,
     scoped to a --day filter (Friday 2026-04-17 OR Saturday 2026-04-18).
  3. Camera identity by filename folder prefix (regex [FH]:[/\\]DCIM[/\\](\d+)_PANA).
     Friday: 101-110 = Camera A (0 offset), 166-167 Cam B pre (+60m), 168 flips at
     P1687292, 169+ post (0 offset). Saturday: all folders = 0 offset.
  4. +/- 5s buffer on video window edges.
  5. EXIF date sanity check: compare photo date to expected competition date before
     scanning; loud warnings + abort gate if anything looks wrong.
  6. Per-photo manifest JSON (imports/<run-id>.json) with full provenance.
  7. Filename preservation: R2 keys stored as photo_NNN__<original>.jpg (backwards
     compat numeric + forensic audit trail).
  8. Idempotency via preload of existing media_photos.storage_url for the competition
     and per-source-path tracking.
  9. Separate --purge-misassigned mode for the 846 rows whose url_entry_id differs
     from the package entry_id (today's recovery).
 10. Skip F:224 hard-coded (Camera 2, wrong clock — irrelevant).
 11. Input source is flexible: either fresh SD scan OR a pre-computed orphan JSON
     (so we don't re-walk 21k files on a laptop mid-show).

MODES:
  python overnight-sd-import-v5.py --dry-run --day 2026-04-17
      Scan OR load orphan JSON, compute all proposed writes, print a report.
  python overnight-sd-import-v5.py --execute --day 2026-04-17
      Apply the writes (R2 uploads + CompPortal /complete calls). Operator gates.
  python overnight-sd-import-v5.py --purge-misassigned --day 2026-04-17 [--execute]
      Separate recovery mode: delete media_photos rows whose storage_url prefix
      points at a DIFFERENT entry_id than the one the row is attached to.
      Does NOT touch R2 objects (those can be reclaimed later).

SAFETY:
  - Dry-run is default when mode is ambiguous.
  - SD card writes blocked via _assert_not_sd_path.
  - --execute + --purge-misassigned together require --i-really-mean-it.
  - All destination files/manifests under LOG_DIR and cwd/imports/.
"""

from __future__ import annotations

import argparse
import builtins
import hashlib
import io
import json
import logging
import os
import re
import socket
import sys
import threading
import time
import traceback
from bisect import bisect_right
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

# ----------------------------------------------------------------------------
# Hard configuration
# ----------------------------------------------------------------------------

COMPETITION_ID = "6f29f048-61f2-48c2-982f-27b542f974b2"
TENANT_ID = "00000000-0000-0000-0000-000000000004"
API_BASE = "https://udc.compsync.net"
PLUGIN_API_KEY = "csm_f68ddeef15d7bbe8e57fa3e0606dc475ee5dc56e6249803c"

R2_BUCKET = "compsyncmedia"
R2_ENDPOINT = "https://186f898742315ca57c73b8cf3f9d6917.r2.cloudflarestorage.com"
R2_ACCESS_KEY_ID = "d1d5db3249b970644b60a2ccf6f7e1b4"
R2_API_TOKEN = "sc68FF5kO0OYky0Iv_mn2H-qnqLh4zllufj5uiYB"
R2_SECRET_ACCESS_KEY = hashlib.sha256(R2_API_TOKEN.encode("utf-8")).hexdigest()

# DART (Windows) paths — harmlessly fall back to cwd if not present.
if os.name == "nt":
    LOG_DIR_DEFAULT = r"C:\Users\User\logs"
else:
    LOG_DIR_DEFAULT = os.path.join(os.getcwd(), "imports-logs")
LOG_DIR = os.environ.get("OVERNIGHT_LOG_DIR", LOG_DIR_DEFAULT)

MANIFEST_ROOT = os.environ.get(
    "OVERNIGHT_MANIFEST_ROOT",
    os.path.join(os.getcwd(), "imports"),
)

# Timezone handling — EXIF values are naive, captured in this zone.
CAMERA_TZ_NAME = os.environ.get("OVERNIGHT_CAMERA_TZ", "America/New_York")

# Friday camera-offset map. Saturday: all 0 offset (single camera, correct clock).
# Tuples: (folder_lo, folder_hi) -> offset_hours_to_add_to_utc
FRIDAY_OFFSET_MAP: List[Tuple[int, int, str]] = [
    (101, 110, "cam_a_edt"),             # Camera A, no offset
    (166, 167, "cam_b_pre"),             # Cam B pre-correction (+60m fast)
    (168, 168, "cam_b_flip"),             # flip folder — filename-based split
    (169, 189, "cam_b_post"),            # Cam B post-correction (0 offset)
    (224, 224, "ignore_camera2"),        # Cam 2 wrong clock — skip
]
SATURDAY_OFFSET_MAP: List[Tuple[int, int, str]] = []  # placeholder — all 0 offset

# Flip marker (Friday Cam B): filename >= P1687292.JPG on H:168 = post-correction.
FRI_CAMB_FLIP_FILENAME = "P1687292.JPG"

# Window match buffer
BUFFER_SEC = 5

# Upload concurrency
UPLOAD_CONCURRENCY = 8

# Regex helpers
FOLDER_RE = re.compile(r"[FH]:[\\/]DCIM[\\/](\d+)_PANA", re.IGNORECASE)
DRIVE_RE = re.compile(r"^([FH]):", re.IGNORECASE)

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------

logger = logging.getLogger("overnight_sd_import_v5")
logger.setLevel(logging.INFO)


def _ensure_log_dir() -> None:
    os.makedirs(LOG_DIR, exist_ok=True)
    os.makedirs(MANIFEST_ROOT, exist_ok=True)


def _init_logging() -> None:
    _ensure_log_dir()
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    sh.setLevel(logging.INFO)
    fh = logging.FileHandler(os.path.join(LOG_DIR, "overnight-v5.log"), mode="a", encoding="utf-8")
    fh.setFormatter(fmt)
    fh.setLevel(logging.INFO)
    for h in list(logger.handlers):
        logger.removeHandler(h)
    logger.addHandler(sh)
    logger.addHandler(fh)


# ----------------------------------------------------------------------------
# SD safety layer — carried over from v4 (same guard surface)
# ----------------------------------------------------------------------------

SD_DRIVE_LETTERS: Set[str] = set()


def _drive_letter_of(path: str) -> Optional[str]:
    if not path:
        return None
    if len(path) >= 2 and path[1] == ":":
        return path[0].upper() + ":"
    drive, _ = os.path.splitdrive(path)
    if drive and len(drive) >= 2 and drive[1] == ":":
        return drive[0].upper() + ":"
    return None


def _assert_not_sd_path(path: str) -> None:
    d = _drive_letter_of(path)
    if d is not None and d in SD_DRIVE_LETTERS:
        raise RuntimeError(
            f"REFUSED: attempt to mutate path on SD card {d}: {path!r}. SD cards are read-only."
        )


def _safe_open(path: str, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
    if any(ch in mode for ch in ("w", "a", "x", "+")):
        _assert_not_sd_path(path)
    return builtins.open(path, mode, *args, **kwargs)


# ----------------------------------------------------------------------------
# EXIF reader — EDT-aware
# ----------------------------------------------------------------------------


def _parse_exif_dt_naive(path: str) -> Optional[datetime]:
    """Parse EXIF DateTimeOriginal as NAIVE datetime (the camera clock value).

    The camera stores "2026:04:17 08:24:03" without TZ. We DO NOT tag it as UTC —
    the value is the camera's local clock display. Caller adds offset_hours to
    derive real UTC.
    """
    try:
        import exifread
        with _safe_open(path, "rb") as f:
            tags = exifread.process_file(f, stop_tag="EXIF DateTimeOriginal", details=False)
        if "EXIF DateTimeOriginal" not in tags:
            return None
        raw = str(tags["EXIF DateTimeOriginal"])
        return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S")
    except Exception:
        return None


def _parse_naive_from_iso(iso_str: str) -> Optional[datetime]:
    """Parse 'YYYY-MM-DDTHH:MM:SS[+00:00]' → naive datetime (strip TZ suffix)."""
    if not iso_str:
        return None
    try:
        return datetime.fromisoformat(iso_str[:19])
    except Exception:
        return None


# ----------------------------------------------------------------------------
# Per-camera offset resolution
# ----------------------------------------------------------------------------


def _extract_folder(path: str) -> Optional[int]:
    m = FOLDER_RE.search(path)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _extract_drive(path: str) -> Optional[str]:
    m = DRIVE_RE.search(path)
    return m.group(1).upper() if m else None


def _edt_to_utc(exif_naive: datetime) -> datetime:
    """Convert naive EDT → UTC by adding 4h (April, NY is EDT UTC-4)."""
    return exif_naive + timedelta(hours=4)


def _resolve_offsets_for_photo(
    day_tag: str, path: str, filename: str, exif_naive: datetime
) -> List[Tuple[str, datetime]]:
    """Return list of (label, candidate_utc) to try matching against windows.

    For Friday Cam B folder 168 the flip is filename-based. Other zones are
    deterministic (single candidate). Unknown folders: both offsets tried.
    """
    folder = _extract_folder(path)
    drive = _extract_drive(path)
    base_utc = _edt_to_utc(exif_naive)

    if day_tag == "2026-04-17":
        if folder is None:
            return [
                ("cam?_pre_tiebreak", base_utc - timedelta(minutes=60)),
                ("cam?_post_tiebreak", base_utc),
            ]
        if folder == 224:
            return []  # ignore
        if 101 <= folder <= 110:
            return [("cam_a_edt", base_utc)]
        if 166 <= folder <= 167:
            # Clock was +1h fast → real utc = EXIF_EDT - 60m + 4h = base_utc - 60m
            return [("cam_b_pre", base_utc - timedelta(minutes=60))]
        if folder == 168:
            if drive == "H" and filename >= FRI_CAMB_FLIP_FILENAME:
                return [("cam_b_post_flip", base_utc)]
            if drive == "H" and filename < FRI_CAMB_FLIP_FILENAME:
                return [("cam_b_pre_flip", base_utc - timedelta(minutes=60))]
            # F:168 (or unknown drive) — ambiguous. Try both, matcher picks one.
            return [
                ("cam_b_pre_f168_tiebreak", base_utc - timedelta(minutes=60)),
                ("cam_b_post_f168_tiebreak", base_utc),
            ]
        if 169 <= folder <= 189:
            return [("cam_b_post", base_utc)]
        return [
            ("unclassified_pre", base_utc - timedelta(minutes=60)),
            ("unclassified_post", base_utc),
        ]

    if day_tag == "2026-04-18":
        if folder == 224:
            return []
        # Operator confirms single body, no clock issues. 0 offset.
        return [("saturday_edt", base_utc)]

    # Unknown day — assume EDT raw
    return [("default_edt", base_utc)]


# ----------------------------------------------------------------------------
# DB access (READ-ONLY in dry-run)
# ----------------------------------------------------------------------------


def _db_connect() -> Any:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL not set. Needed for routine-window + idempotency queries."
        )
    import psycopg2
    import psycopg2.extras
    return psycopg2.connect(url, connect_timeout=15)


def _load_routines_for_day(conn: Any, day_tag: str) -> List[Dict[str, Any]]:
    """Query media_packages scoped to competition + local-day.

    day_tag = 'YYYY-MM-DD' in America/New_York.
    Returns list of { entry_id, entry_number, window_start, window_end, photo_count,
                      routine_window_source, package_id }.
    """
    import psycopg2.extras
    out: List[Dict[str, Any]] = []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT mp.id AS package_id,
                   mp.entry_id AS entry_id,
                   mp.entry_number,
                   mp.video_start_timestamp AS window_start,
                   mp.video_end_timestamp AS window_end,
                   mp.photo_count,
                   mp.routine_window_source
            FROM media_packages mp
            WHERE mp.competition_id = %s
              AND mp.deleted_at IS NULL
              AND mp.video_start_timestamp IS NOT NULL
              AND DATE(mp.video_start_timestamp AT TIME ZONE 'America/New_York') = %s
            ORDER BY mp.entry_number
            """,
            (COMPETITION_ID, day_tag),
        )
        for row in cur.fetchall():
            out.append({
                "package_id": str(row["package_id"]),
                "entry_id": str(row["entry_id"]),
                "entry_number": row["entry_number"],
                "window_start": row["window_start"],
                "window_end": row["window_end"],
                "photo_count": row.get("photo_count") or 0,
                "routine_window_source": row.get("routine_window_source"),
            })
    return out


def _load_existing_photo_urls(conn: Any) -> Dict[str, Dict[str, Any]]:
    """Return { storage_url: { entry_id, package_id, misassigned(bool) } } for the
    whole competition — the full audit set we compare against for idempotency AND
    for --purge-misassigned.
    """
    import psycopg2.extras
    out: Dict[str, Dict[str, Any]] = {}
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT ph.id AS photo_id,
                   ph.storage_url,
                   ph.media_package_id,
                   mp.entry_id AS pkg_entry_id,
                   mp.entry_number AS pkg_entry_number
            FROM media_photos ph
            JOIN media_packages mp ON ph.media_package_id = mp.id
            WHERE mp.competition_id = %s
              AND ph.deleted_at IS NULL
            """,
            (COMPETITION_ID,),
        )
        for row in cur.fetchall():
            url = row["storage_url"] or ""
            url_entry = url.split("/")[2] if url.count("/") >= 3 else ""
            pkg_entry = str(row["pkg_entry_id"])
            out[url] = {
                "photo_id": str(row["photo_id"]),
                "package_id": str(row["media_package_id"]),
                "pkg_entry_id": pkg_entry,
                "pkg_entry_number": row.get("pkg_entry_number"),
                "url_entry_id": url_entry,
                "misassigned": url_entry != pkg_entry and bool(url_entry),
            }
    return out


# ----------------------------------------------------------------------------
# R2 client
# ----------------------------------------------------------------------------


def _r2_client() -> Any:
    import boto3
    from botocore.config import Config as BotoConfig
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
    )


def _r2_head(client: Any, key: str) -> Optional[Dict[str, Any]]:
    try:
        return client.head_object(Bucket=R2_BUCKET, Key=key)
    except Exception:
        return None


def _r2_put_file(client: Any, key: str, path: str, content_type: str) -> int:
    with _safe_open(path, "rb") as f:
        data = f.read()
    client.put_object(Bucket=R2_BUCKET, Key=key, Body=data, ContentType=content_type)
    return len(data)


def _r2_put_bytes(client: Any, key: str, body: bytes, content_type: str) -> int:
    client.put_object(Bucket=R2_BUCKET, Key=key, Body=body, ContentType=content_type)
    return len(body)


# ----------------------------------------------------------------------------
# Thumbnail
# ----------------------------------------------------------------------------


def _make_thumb_webp(src_path: str, size: Tuple[int, int] = (200, 200), quality: int = 80) -> bytes:
    from PIL import Image
    with _safe_open(src_path, "rb") as f:
        img = Image.open(f)
        img.load()
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img.thumbnail(size, Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="WEBP", quality=quality)
    return buf.getvalue()


# ----------------------------------------------------------------------------
# Input source: fresh SD scan vs pre-scan JSON
# ----------------------------------------------------------------------------


def _scan_sd(sd_roots: List[str]) -> List[Dict[str, Any]]:
    """Walk SD roots and collect JPEGs with EXIF naive + stat."""
    out: List[Dict[str, Any]] = []
    for root in sd_roots:
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.lower().endswith((".jpg", ".jpeg")):
                    continue
                fp = os.path.join(dirpath, fn)
                try:
                    st = os.stat(fp)
                except Exception:
                    continue
                exif_naive = _parse_exif_dt_naive(fp)
                out.append({
                    "path": fp,
                    "filename": fn,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "exif_naive_iso": exif_naive.isoformat() if exif_naive else None,
                    "folder": _extract_folder(fp),
                    "drive": _extract_drive(fp),
                })
    return out


def _load_orphan_json(path: str) -> List[Dict[str, Any]]:
    """Load a pre-computed orphan JSON (v4 overnight-orphans format OR simple list).

    v4 shape: { ts, orphans: [ { path, filename, raw_exif_iso, ... } ] }
    """
    with open(path) as f:
        doc = json.load(f)
    if isinstance(doc, dict) and "orphans" in doc:
        rows = doc["orphans"]
    elif isinstance(doc, list):
        rows = doc
    else:
        raise RuntimeError(f"Unknown orphan JSON shape: {type(doc)}")

    out: List[Dict[str, Any]] = []
    for r in rows:
        raw_iso = r.get("raw_exif_iso") or r.get("exif_dt") or r.get("exif_naive_iso")
        exif_naive = _parse_naive_from_iso(raw_iso) if raw_iso else None
        path = r.get("path")
        out.append({
            "path": path,
            "filename": r.get("filename") or (os.path.basename(path) if path else None),
            "size": r.get("size"),
            "mtime": r.get("mtime"),
            "exif_naive_iso": exif_naive.isoformat() if exif_naive else None,
            "folder": _extract_folder(path) if path else None,
            "drive": _extract_drive(path) if path else None,
        })
    return out


# ----------------------------------------------------------------------------
# Matcher
# ----------------------------------------------------------------------------


def _build_window_index(routines: List[Dict[str, Any]]) -> Tuple[List[Tuple[datetime, datetime, Dict[str, Any]]], List[datetime]]:
    wins: List[Tuple[datetime, datetime, Dict[str, Any]]] = []
    for r in routines:
        ws = r["window_start"]
        we = r["window_end"]
        # Normalize to UTC-aware
        if ws is None or we is None:
            continue
        if ws.tzinfo is None:
            ws = ws.replace(tzinfo=timezone.utc)
        if we.tzinfo is None:
            we = we.replace(tzinfo=timezone.utc)
        wins.append((ws, we, r))
    wins.sort(key=lambda t: t[0])
    starts = [t[0] for t in wins]
    return wins, starts


def _find_containing(
    wins: List[Tuple[datetime, datetime, Dict[str, Any]]],
    starts: List[datetime],
    dt_utc: datetime,
    buffer_sec: int,
) -> Optional[Dict[str, Any]]:
    idx = bisect_right(starts, dt_utc + timedelta(seconds=buffer_sec)) - 1
    for i in range(max(0, idx - 3), min(len(wins), idx + 4)):
        s, e, r = wins[i]
        if (s - timedelta(seconds=buffer_sec)) <= dt_utc <= (e + timedelta(seconds=buffer_sec)):
            return r
    return None


def match_photos(
    photos: List[Dict[str, Any]],
    routines: List[Dict[str, Any]],
    day_tag: str,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    """Return (matched, unmatched, stats).

    matched row: { photo, routine, chosen_label, real_utc, offset_sec }
    unmatched row: { photo, reason, all_candidates }
    """
    wins, starts = _build_window_index(routines)
    matched: List[Dict[str, Any]] = []
    unmatched: List[Dict[str, Any]] = []
    stats = Counter()

    for p in photos:
        exif_iso = p.get("exif_naive_iso")
        if not exif_iso:
            unmatched.append({"photo": p, "reason": "no_exif"})
            stats["no_exif"] += 1
            continue
        exif_naive = _parse_naive_from_iso(exif_iso)
        if exif_naive is None:
            unmatched.append({"photo": p, "reason": "bad_exif"})
            stats["bad_exif"] += 1
            continue

        candidates = _resolve_offsets_for_photo(day_tag, p["path"], p.get("filename") or "", exif_naive)
        if not candidates:
            unmatched.append({"photo": p, "reason": "ignored_folder"})
            stats["ignored_folder"] += 1
            continue

        hits: List[Tuple[str, datetime, Dict[str, Any]]] = []
        for label, utc_dt in candidates:
            hit = _find_containing(wins, starts, utc_dt.replace(tzinfo=timezone.utc) if utc_dt.tzinfo is None else utc_dt, BUFFER_SEC)
            if hit is not None:
                hits.append((label, utc_dt, hit))

        if not hits:
            unmatched.append({
                "photo": p,
                "reason": "no_window",
                "attempted_candidates": [(lbl, dt.isoformat()) for lbl, dt in candidates],
            })
            stats["no_window"] += 1
            continue

        # Resolve multi-hit: prefer 'post' variant if ambiguous (matches match-v3 behavior)
        if len(hits) > 1:
            # Stable preference order: explicit _post > cam_a_edt/saturday > pre
            def _rank(lbl: str) -> int:
                if "post" in lbl:
                    return 0
                if "cam_a" in lbl or "saturday" in lbl:
                    return 1
                if "pre" in lbl:
                    return 2
                return 3
            hits.sort(key=lambda h: _rank(h[0]))
            stats["matched_multi_resolved"] += 1
        else:
            stats["matched_unique"] += 1

        chosen_label, chosen_utc, chosen_routine = hits[0]
        offset_sec = int((chosen_utc - (exif_naive + timedelta(hours=4))).total_seconds())
        matched.append({
            "photo": p,
            "routine": chosen_routine,
            "chosen_label": chosen_label,
            "real_utc_iso": chosen_utc.isoformat(),
            "offset_sec": offset_sec,
        })

    return matched, unmatched, dict(stats)


# ----------------------------------------------------------------------------
# Sanity checks
# ----------------------------------------------------------------------------


def sanity_check_exif_dates(
    photos: List[Dict[str, Any]], expected_day_tag: str, max_samples: int = 200
) -> Dict[str, Any]:
    """Sample photos; return counter of EXIF local-date values vs expected.

    Raises if the WHOLE sample is off-date (catches wrong SD entirely).
    """
    expected_date = datetime.strptime(expected_day_tag, "%Y-%m-%d").date()
    sample = photos[::max(1, len(photos) // max_samples)][:max_samples]
    buckets: Counter = Counter()
    for p in sample:
        iso = p.get("exif_naive_iso")
        if not iso:
            buckets["__no_exif__"] += 1
            continue
        try:
            d = datetime.fromisoformat(iso[:19]).date()
        except Exception:
            buckets["__bad__"] += 1
            continue
        buckets[d.isoformat()] += 1
    expected_count = buckets.get(expected_day_tag, 0)
    total_with_exif = sum(v for k, v in buckets.items() if not k.startswith("__"))
    ratio = (expected_count / total_with_exif) if total_with_exif else 0.0
    result = {
        "expected_day": expected_day_tag,
        "sample_size": sum(buckets.values()),
        "buckets": dict(buckets),
        "expected_ratio": ratio,
        "pass": ratio >= 0.3,  # loose — Friday SDs contain Sat photos too; Sat SDs contain Fri residue
    }
    return result


# ----------------------------------------------------------------------------
# R2 upload + CompPortal register
# ----------------------------------------------------------------------------


def _build_r2_key(entry_id: str, n: int, original_filename: str, kind: str = "photo") -> str:
    """Key format:
       {tenant}/{comp}/{entry}/photos/photo_{NNN}__{original}.jpg
       {tenant}/{comp}/{entry}/photos/photo_{NNN}__{original}_thumb.webp
    """
    clean = re.sub(r"[^A-Za-z0-9._-]", "_", original_filename or "unknown.jpg")
    base, ext = os.path.splitext(clean)
    # Normalize ext for original; thumb always webp
    if kind == "thumb":
        return f"{TENANT_ID}/{COMPETITION_ID}/{entry_id}/photos/photo_{n:03d}__{base}_thumb.webp"
    ext_safe = (ext or ".jpg").lower()
    if ext_safe not in (".jpg", ".jpeg"):
        ext_safe = ".jpg"
    return f"{TENANT_ID}/{COMPETITION_ID}/{entry_id}/photos/photo_{n:03d}__{base}{ext_safe}"


def _build_manifest_entry(
    matched_row: Dict[str, Any],
    photo_n: int,
    r2_key: str,
    thumb_key: str,
    day_tag: str,
) -> Dict[str, Any]:
    p = matched_row["photo"]
    r = matched_row["routine"]
    return {
        "source_path": p.get("path"),
        "source_filename": p.get("filename"),
        "source_folder": p.get("folder"),
        "source_drive": p.get("drive"),
        "raw_exif_naive_iso": p.get("exif_naive_iso"),
        "applied_offset_label": matched_row["chosen_label"],
        "applied_offset_sec": matched_row["offset_sec"],
        "real_utc_iso": matched_row["real_utc_iso"],
        "target_day": day_tag,
        "target_entry_id": r["entry_id"],
        "target_entry_number": r["entry_number"],
        "target_package_id": r["package_id"],
        "r2_photo_key": r2_key,
        "r2_thumb_key": thumb_key,
        "photo_n": photo_n,
    }


def upload_and_register(
    matched: List[Dict[str, Any]],
    existing_urls: Dict[str, Dict[str, Any]],
    day_tag: str,
    run_id: str,
    execute: bool,
) -> Dict[str, Any]:
    """Stage uploads: for each routine, assign photo_n starting at max_n+1 in DB,
    write R2 keys, call /api/plugin/complete per routine.

    Returns summary dict + writes manifest.
    """
    # Group by routine, sort deterministic (by EXIF time), assign numbering.
    by_routine: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in matched:
        by_routine[row["routine"]["entry_id"]].append(row)

    for eid, rows in by_routine.items():
        rows.sort(key=lambda r: (r["real_utc_iso"], r["photo"].get("filename") or ""))

    # Pre-compute max_n per entry from existing_urls
    max_n_per_entry: Dict[str, int] = defaultdict(int)
    for url, info in existing_urls.items():
        eid = info["pkg_entry_id"]
        # photo_NNN__ or photo_NNN.JPG
        m = re.search(r"/photos/photo_(\d+)(?:__|\.)", url)
        if m:
            n = int(m.group(1))
            if n > max_n_per_entry[eid]:
                max_n_per_entry[eid] = n

    # Idempotency: build a per-entry set of source filenames already uploaded.
    # Matches anything like "photo_012__P1011943.jpg" (new format). The OLD format
    # ("photo_NNN.JPG" without source embedded) can't be reversed, so re-running
    # v5 after a v4 partial run might add duplicate files to already-filled
    # routines. Operator mitigation: check routine photo_count before running,
    # and only run v5 against routines that were empty OR the known-bad set.
    done_by_entry_filename: Dict[Tuple[str, str], bool] = {}
    for url in existing_urls.keys():
        parts = url.split("/")
        if len(parts) < 5:
            continue
        eid = parts[2]
        base = parts[-1]  # e.g. photo_012__P1011943.jpg OR photo_012.JPG
        m = re.search(r"photo_\d+__(.+?)(?:_thumb)?\.(?:jpe?g|webp|JPG|JPEG)$", base)
        if m:
            done_by_entry_filename[(eid, m.group(1).lower())] = True

    manifest: List[Dict[str, Any]] = []
    proposed_uploads = 0
    skipped_already_uploaded = 0
    per_routine_plan: Dict[str, Dict[str, int]] = {}

    client = _r2_client() if execute else None

    # Figure out what to upload and build manifest
    for eid, rows in by_routine.items():
        per_routine_plan[eid] = {"proposed": 0, "skipped_already_uploaded": 0}
        next_n = max_n_per_entry.get(eid, 0) + 1
        for row in rows:
            p = row["photo"]
            fname = p.get("filename") or "unknown.jpg"
            # Predict r2 key and check collision
            candidate_key = _build_r2_key(eid, next_n, fname, kind="photo")
            collision = candidate_key in existing_urls
            # Check source-filename dedup (new-format only — old photo_NNN.JPG uploads
            # have no source-filename trace and can't be deduped this way)
            clean = re.sub(r"[^A-Za-z0-9._-]", "_", fname)
            base_only, _ext = os.path.splitext(clean)
            source_already = done_by_entry_filename.get((eid, base_only.lower()), False)
            if collision or source_already:
                skipped_already_uploaded += 1
                per_routine_plan[eid]["skipped_already_uploaded"] += 1
                continue
            thumb_key = _build_r2_key(eid, next_n, fname, kind="thumb")
            manifest.append(_build_manifest_entry(row, next_n, candidate_key, thumb_key, day_tag))
            proposed_uploads += 1
            per_routine_plan[eid]["proposed"] += 1
            next_n += 1

    # Write manifest first
    manifest_path = os.path.join(MANIFEST_ROOT, f"{run_id}.json")
    os.makedirs(MANIFEST_ROOT, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({
            "run_id": run_id,
            "day_tag": day_tag,
            "executed": execute,
            "proposed_uploads": proposed_uploads,
            "skipped_already_uploaded": skipped_already_uploaded,
            "entries": manifest,
        }, f, indent=2, default=str)
    logger.info("Manifest written: %s (%d entries)", manifest_path, len(manifest))

    if not execute:
        return {
            "manifest_path": manifest_path,
            "proposed_uploads": proposed_uploads,
            "skipped_already_uploaded": skipped_already_uploaded,
            "per_routine_plan": per_routine_plan,
            "dry_run": True,
        }

    # EXECUTE path
    errors = 0
    bytes_uploaded = 0
    batches: Dict[str, List[Dict[str, str]]] = defaultdict(list)

    def _do(entry: Dict[str, Any]) -> Optional[str]:
        nonlocal errors, bytes_uploaded
        src = entry["source_path"]
        try:
            orig_key = entry["r2_photo_key"]
            thumb_key = entry["r2_thumb_key"]
            if _r2_head(client, orig_key) is None:
                bytes_uploaded += _r2_put_file(client, orig_key, src, "image/jpeg")
            if _r2_head(client, thumb_key) is None:
                thumb_bytes = _make_thumb_webp(src)
                bytes_uploaded += _r2_put_bytes(client, thumb_key, thumb_bytes, "image/webp")
            return None
        except Exception as e:
            errors += 1
            return f"{src}: {e}"

    with ThreadPoolExecutor(max_workers=UPLOAD_CONCURRENCY) as exe:
        futures = {exe.submit(_do, e): e for e in manifest}
        for fut in as_completed(futures):
            e = futures[fut]
            err = fut.result()
            if err:
                logger.warning("upload err: %s", err)
                continue
            batches[e["target_entry_id"]].append({
                "photo_key": e["r2_photo_key"],
                "thumb_key": e["r2_thumb_key"],
                "filename": e["source_filename"],
            })

    # Register with CompPortal per routine
    register_failures: List[str] = []
    ok_routines: List[str] = []
    import requests
    sess = requests.Session()
    for eid, rows in batches.items():
        body = {
            "entryId": eid,
            "competitionId": COMPETITION_ID,
            "files": {
                "photos": [r["photo_key"] for r in rows],
                "photo_thumbnails": [r["thumb_key"] for r in rows],
            },
        }
        try:
            resp = sess.post(
                f"{API_BASE}/api/plugin/complete",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {PLUGIN_API_KEY}"},
                data=json.dumps(body),
                timeout=30,
            )
            if 200 <= resp.status_code < 300:
                ok_routines.append(eid)
            else:
                register_failures.append(f"{eid} HTTP {resp.status_code}: {resp.text[:200]}")
        except Exception as e:
            register_failures.append(f"{eid} crash: {e}")

    return {
        "manifest_path": manifest_path,
        "proposed_uploads": proposed_uploads,
        "uploaded_bytes": bytes_uploaded,
        "errors": errors,
        "ok_routines": len(ok_routines),
        "register_failures": register_failures,
        "dry_run": False,
    }


# ----------------------------------------------------------------------------
# Purge misassigned
# ----------------------------------------------------------------------------


def purge_misassigned(
    existing_urls: Dict[str, Dict[str, Any]], execute: bool
) -> Dict[str, Any]:
    rows = [info for info in existing_urls.values() if info["misassigned"]]
    logger.info("Misassigned rows detected: %d", len(rows))
    if not execute:
        return {"misassigned_count": len(rows), "dry_run": True, "sample": rows[:5]}

    # Soft-delete (set deleted_at) rather than hard DELETE for recoverability.
    conn = _db_connect()
    try:
        with conn.cursor() as cur:
            ids = [r["photo_id"] for r in rows]
            cur.execute(
                "UPDATE media_photos SET deleted_at = NOW() WHERE id = ANY(%s::uuid[])",
                (ids,),
            )
            conn.commit()
    finally:
        conn.close()

    return {"misassigned_count": len(rows), "deleted": len(rows), "dry_run": False}


# ----------------------------------------------------------------------------
# Orchestrator
# ----------------------------------------------------------------------------


def run(args: argparse.Namespace) -> int:
    _init_logging()
    logger.info("=== overnight-sd-import-v5 start: args=%s ===", vars(args))
    run_id = f"v5-{args.day}-{datetime.now().strftime('%Y%m%dT%H%M%S')}"

    # Seed SD guard from any --sd roots (otherwise empty = no guards fire)
    for sd in args.sd or []:
        d = _drive_letter_of(sd)
        if d:
            SD_DRIVE_LETTERS.add(d)
    logger.info("SD guard: %s", SD_DRIVE_LETTERS or "(none)")

    # PURGE MODE (separate path)
    if args.purge_misassigned:
        if args.execute and not args.i_really_mean_it:
            logger.error("--purge-misassigned + --execute requires --i-really-mean-it")
            return 2
        conn = _db_connect()
        try:
            existing = _load_existing_photo_urls(conn)
        finally:
            conn.close()
        result = purge_misassigned(existing, execute=bool(args.execute))
        logger.info("PURGE result: %s", result)
        report_path = os.path.join(LOG_DIR, f"{run_id}-purge.json")
        with open(report_path, "w") as f:
            json.dump(result, f, indent=2, default=str)
        return 0 if result.get("misassigned_count") is not None else 1

    # Normal flow — load photos
    if args.from_orphan_json:
        photos = _load_orphan_json(args.from_orphan_json)
        logger.info("Loaded %d photos from %s", len(photos), args.from_orphan_json)
    elif args.sd:
        photos = _scan_sd(args.sd)
        logger.info("Scanned %d photos from %s", len(photos), args.sd)
    else:
        logger.error("Need --from-orphan-json OR --sd <drive>")
        return 2

    # EXIF date sanity check
    sanity = sanity_check_exif_dates(photos, args.day)
    logger.info("EXIF date sanity: %s", sanity)
    report_prefix = os.path.join(LOG_DIR, run_id)
    with open(report_prefix + "-sanity.json", "w") as f:
        json.dump(sanity, f, indent=2, default=str)
    if not sanity["pass"]:
        logger.warning(
            "SANITY CHECK DID NOT PASS: expected_ratio=%.2f < 0.3. Continuing for now but "
            "operator should review sanity output before --execute.",
            sanity["expected_ratio"],
        )

    # Load routines + existing URLs from DB
    conn = _db_connect()
    try:
        routines = _load_routines_for_day(conn, args.day)
        existing_urls = _load_existing_photo_urls(conn)
    finally:
        conn.close()
    logger.info("Loaded %d routines for day %s", len(routines), args.day)
    logger.info("Loaded %d existing media_photos rows across competition", len(existing_urls))

    # Match
    matched, unmatched, stats = match_photos(photos, routines, args.day)
    logger.info("Match stats: %s", stats)
    logger.info("Matched: %d   Unmatched: %d", len(matched), len(unmatched))

    # Write match report
    with open(report_prefix + "-match.json", "w") as f:
        # strip non-serializable routine datetimes
        safe_matched = []
        for row in matched:
            r = row["routine"]
            safe_matched.append({
                "photo": row["photo"],
                "chosen_label": row["chosen_label"],
                "real_utc_iso": row["real_utc_iso"],
                "offset_sec": row["offset_sec"],
                "routine_entry_id": r["entry_id"],
                "routine_entry_number": r["entry_number"],
                "routine_package_id": r["package_id"],
            })
        json.dump({"matched": safe_matched, "unmatched": unmatched, "stats": stats}, f, default=str)
    logger.info("Match report: %s-match.json", report_prefix)

    # Upload + register (or dry-run plan)
    summary = upload_and_register(
        matched, existing_urls, args.day, run_id, execute=bool(args.execute)
    )
    logger.info("Upload summary: %s", summary)

    # Final report
    final = {
        "run_id": run_id,
        "day": args.day,
        "executed": bool(args.execute),
        "photos_total": len(photos),
        "routines_total": len(routines),
        "matched": len(matched),
        "unmatched": len(unmatched),
        "match_stats": stats,
        "sanity": sanity,
        "upload_summary": summary,
    }
    with open(report_prefix + "-final.json", "w") as f:
        json.dump(final, f, indent=2, default=str)
    logger.info("=== FINAL REPORT ===\n%s", json.dumps(final, indent=2, default=str))

    return 0


def _parse_args(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Overnight SD-card photo import v5")
    p.add_argument("--day", required=True, help="YYYY-MM-DD (local, America/New_York)")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--execute", action="store_true")
    p.add_argument(
        "--purge-misassigned",
        action="store_true",
        help="Separate mode: soft-delete media_photos rows whose storage_url entry_id disagrees with package entry_id.",
    )
    p.add_argument(
        "--i-really-mean-it",
        action="store_true",
        help="Required to combine --purge-misassigned + --execute.",
    )
    p.add_argument(
        "--from-orphan-json",
        default=None,
        help="Use this pre-computed orphan JSON instead of scanning SDs.",
    )
    p.add_argument(
        "--sd",
        action="append",
        default=None,
        help="SD root path (repeatable). Example: F:\\ OR H:\\",
    )
    args = p.parse_args(argv)
    return args


def main(argv: Optional[List[str]] = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    args = _parse_args(argv)
    try:
        return run(args)
    except KeyboardInterrupt:
        logger.warning("interrupted by user")
        return 130
    except Exception:
        logger.critical("unhandled exception:\n%s", traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
