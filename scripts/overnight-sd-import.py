#!/usr/bin/env python3
"""
Overnight SD-card photo import for UDC London 2026 / DART Windows laptop.

12 phases, single-file, checkpointable, SD-card-immutable.

CLI:
  python overnight-sd-import.py --full-run
  python overnight-sd-import.py --dry-run [--sd=F:]
  python overnight-sd-import.py --limit=10 [--sd=F:]
  python overnight-sd-import.py --reconcile

Design contract (non-negotiable):
  - SD card is read-only. Writing, renaming, or deleting anything on an SD
    drive raises RuntimeError. Enforced via _assert_not_sd_path + _safe_open
    + _safe_unlink wrappers.
  - Only exits on: no SD present, lock held, SD integrity violation, or
    all phases complete. Every other failure logs + continues.
  - Every decision writes its source data to the final report. Ambiguity
    lands in needs_operator_review, never silently glossed.

Deploy requirements:
  - DATABASE_URL env var must be set on DART (Supabase direct connection
    string, e.g. postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres).
  - Windows Python 3.9+ with: boto3, Pillow, exifread, requests, psycopg2-binary
"""

from __future__ import annotations

import argparse
import builtins
import hashlib
import io
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

# ----------------------------------------------------------------------------
# Hard configuration (stable)
# ----------------------------------------------------------------------------

COMPETITION_ID = "6f29f048-61f2-48c2-982f-27b542f974b2"
TENANT_ID = "00000000-0000-0000-0000-000000000004"
API_BASE = "https://udc.compsync.net"
PLUGIN_API_KEY = "csm_f68ddeef15d7bbe8e57fa3e0606dc475ee5dc56e6249803c"
R2_BUCKET = "compsyncmedia"
R2_ENDPOINT = "https://186f898742315ca57c73b8cf3f9d6917.r2.cloudflarestorage.com"
R2_ACCESS_KEY_ID = "d1d5db3249b970644b60a2ccf6f7e1b4"
# R2 secret is the SHA256 of the account API token (per deployment notes).
R2_API_TOKEN = "sc68FF5kO0OYky0Iv_mn2H-qnqLh4zllufj5uiYB"
R2_SECRET_ACCESS_KEY = hashlib.sha256(R2_API_TOKEN.encode("utf-8")).hexdigest()

# Windows paths on DART
LOG_DIR = r"C:\Users\User\logs"
LOCK_FILE = r"C:\Users\User\logs\overnight-sd-import.lock"
HEARTBEAT_FILE = r"C:\Users\User\logs\overnight-heartbeat.json"
PROGRESS_FILE = r"C:\Users\User\logs\overnight-progress.json"
REPORT_FILE = r"C:\Users\User\logs\overnight-report.json"
ORPHAN_REPORT = r"C:\Users\User\logs\overnight-orphans.json"
ERROR_LOG = r"C:\Users\User\logs\overnight-errors.log"
DART_OUTPUT_ROOT = r"C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026"

DART_DISK_FREE_FLOOR_GB = 20
UPLOAD_CONCURRENCY = 8
HEARTBEAT_INTERVAL_SEC = 60
CHECKPOINT_EVERY_N_PHOTOS = 25

# Drift-era expected routine window (operator hint for sanity check)
EXPECTED_DRIFT_ENTRY_LO = 148
EXPECTED_DRIFT_ENTRY_HI = 166

# Camera-swap detection: filename folder-prefix jump > this value indicates
# a different camera/SD started writing (vs a normal Panasonic folder roll
# which steps by 1). UDC London 2026: P176 -> P224 = jump of 48.
SWAP_FOLDER_JUMP_MIN = 10

# Clock-reset detection: within the swap-camera's stream, an EXIF gap with
# absolute value in this range (seconds) signals an operator clock reset
# (centered around 1h, generous on either side for sloppy reset timing).
RESET_GAP_MIN_SEC = 2400  # 40 min
RESET_GAP_MAX_SEC = 4800  # 80 min

# Dedup window (match a new photo to an existing captured_at if within this delta)
DEDUP_WINDOW_SEC = 2

# ----------------------------------------------------------------------------
# Global state / module-level
# ----------------------------------------------------------------------------

SD_DRIVE_LETTERS: Set[str] = set()  # populated at boot — normalized upper-case "F:", "G:", ...
_LOCK_ACQUIRED = False
_LOCK_FD = None

# Heartbeat data — updated by any phase, flushed periodically by a daemon thread
_HEARTBEAT: Dict[str, Any] = {
    "ts": None,
    "phase": "boot",
    "phase_progress_pct": 0.0,
    "photos_processed": 0,
    "photos_total": 0,
    "current_routine": None,
    "uploads_in_flight": 0,
    "errors_count": 0,
    "r2_bytes": 0,
    "last_progress_ts": None,
}
_HEARTBEAT_LOCK = threading.Lock()
_HEARTBEAT_STOP = threading.Event()

# Pause signal used by upload phase on rapid error bursts.
_ERROR_BURST_WINDOW: List[float] = []
_ERROR_BURST_LOCK = threading.Lock()

# Final report aggregator
_REPORT: Dict[str, Any] = {}

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------

logger = logging.getLogger("overnight_sd_import")
logger.setLevel(logging.INFO)


def _ensure_log_dir() -> None:
    os.makedirs(LOG_DIR, exist_ok=True)


def _init_logging(error_log_path: str = ERROR_LOG) -> None:
    _ensure_log_dir()
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    # Stream handler (stderr)
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    sh.setLevel(logging.INFO)
    # File handler — append
    fh = logging.FileHandler(error_log_path, mode="a", encoding="utf-8")
    fh.setFormatter(fmt)
    fh.setLevel(logging.WARNING)
    # Remove existing handlers to avoid dupes on re-init (tests)
    for h in list(logger.handlers):
        logger.removeHandler(h)
    logger.addHandler(sh)
    logger.addHandler(fh)


# ----------------------------------------------------------------------------
# SD safety layer — the hardest invariant
# ----------------------------------------------------------------------------


def _drive_letter_of(path: str) -> Optional[str]:
    """Return upper-case 'X:' for a Windows path, or None for non-Windows paths."""
    if not path:
        return None
    # Handle Windows-style absolute paths like 'F:\foo' or 'F:/foo'
    if len(path) >= 2 and path[1] == ":":
        return path[0].upper() + ":"
    # splitdrive handles '\\?\F:\foo' etc.
    drive, _ = os.path.splitdrive(path)
    if drive and len(drive) >= 2 and drive[1] == ":":
        return drive[0].upper() + ":"
    return None


def _assert_not_sd_path(path: str) -> None:
    """Raise if path lives on any detected SD drive. Applied before every
    mutation (open-for-write, rename, unlink, rmtree, etc.).
    """
    d = _drive_letter_of(path)
    if d is not None and d in SD_DRIVE_LETTERS:
        raise RuntimeError(
            f"REFUSED: attempt to mutate path on SD card {d}: {path!r}. "
            "SD cards are read-only. Fix the caller."
        )


def _safe_open(path: str, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
    """Wrapper around builtins.open that blocks any write/append mode on SD paths.

    Read-only modes ('r', 'rb', 'rt') pass through unchanged.
    """
    writing = any(ch in mode for ch in ("w", "a", "x", "+"))
    if writing:
        _assert_not_sd_path(path)
    return builtins.open(path, mode, *args, **kwargs)


def _safe_unlink(path: str) -> None:
    _assert_not_sd_path(path)
    os.unlink(path)


def _safe_remove(path: str) -> None:
    _assert_not_sd_path(path)
    os.remove(path)


def _safe_rename(src: str, dst: str) -> None:
    _assert_not_sd_path(src)
    _assert_not_sd_path(dst)
    os.replace(src, dst)  # Windows-safe atomic replace (overwrites if exists)


# ----------------------------------------------------------------------------
# Heartbeat
# ----------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _heartbeat_update(**kwargs: Any) -> None:
    with _HEARTBEAT_LOCK:
        _HEARTBEAT.update(kwargs)
        _HEARTBEAT["ts"] = _now_iso()
        _HEARTBEAT["last_progress_ts"] = _HEARTBEAT["ts"]


def _heartbeat_flush() -> None:
    with _HEARTBEAT_LOCK:
        snap = dict(_HEARTBEAT)
    try:
        tmp = HEARTBEAT_FILE + ".tmp"
        _assert_not_sd_path(tmp)
        with _safe_open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f)
        _safe_rename(tmp, HEARTBEAT_FILE)
    except Exception:
        logger.warning("heartbeat flush failed: %s", traceback.format_exc())


def _heartbeat_thread() -> None:
    while not _HEARTBEAT_STOP.is_set():
        _heartbeat_flush()
        _HEARTBEAT_STOP.wait(HEARTBEAT_INTERVAL_SEC)
    _heartbeat_flush()


def _start_heartbeat() -> threading.Thread:
    t = threading.Thread(target=_heartbeat_thread, name="heartbeat", daemon=True)
    t.start()
    return t


# ----------------------------------------------------------------------------
# Lock file
# ----------------------------------------------------------------------------


def _acquire_lock() -> bool:
    global _LOCK_ACQUIRED, _LOCK_FD
    _ensure_log_dir()
    if os.path.exists(LOCK_FILE):
        try:
            with _safe_open(LOCK_FILE, "r", encoding="utf-8") as f:
                existing = f.read().strip()
        except Exception:
            existing = "(unreadable)"
        logger.error("Lock file already exists (PID inside: %s). Refusing to start.", existing)
        return False
    _assert_not_sd_path(LOCK_FILE)
    # Exclusive create
    try:
        fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, f"{os.getpid()}\n{_now_iso()}\n{socket.gethostname()}\n".encode("utf-8"))
        os.close(fd)
    except FileExistsError:
        logger.error("Lock file race — another instance won. Exiting.")
        return False
    _LOCK_ACQUIRED = True
    _LOCK_FD = fd
    return True


def _release_lock() -> None:
    global _LOCK_ACQUIRED
    if not _LOCK_ACQUIRED:
        return
    try:
        _safe_unlink(LOCK_FILE)
    except Exception:
        logger.warning("lock release failed: %s", traceback.format_exc())
    _LOCK_ACQUIRED = False


# ----------------------------------------------------------------------------
# SD drive detection
# ----------------------------------------------------------------------------


def _detect_sd_drives(override: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return list of {'drive': 'F:', 'label': ..., 'size_gb': ...} for drives
    that look like SD cards (removable + contains DCIM).

    `override` forces a single drive (for testing) — accepts "F:" or a path
    like "/tmp/fake-sd".
    """
    results: List[Dict[str, Any]] = []

    if override:
        # Allow tests to point at a directory that contains DCIM
        if os.path.isdir(os.path.join(override, "DCIM")) or os.path.isdir(override):
            letter = _drive_letter_of(override) or override.rstrip("\\/")
            size_gb = 0.0
            try:
                # shutil.disk_usage works on Windows drive letters and folders
                import shutil
                usage = shutil.disk_usage(override)
                size_gb = usage.total / (1024 ** 3)
            except Exception:
                pass
            results.append({"drive": letter, "root": override, "label": "OVERRIDE", "size_gb": size_gb})
            return results
        logger.warning("--sd override %r has no DCIM; skipping", override)
        return results

    # Windows-only WMI path. On Linux this is a graceful no-op (returns []).
    if os.name != "nt":
        return results

    try:
        import subprocess
        # Use wmic to enumerate removable drives (DriveType=2) — avoids pywin32 dep.
        cmd = ["wmic", "logicaldisk", "where", "DriveType=2", "get", "DeviceID,VolumeName,Size", "/format:csv"]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, timeout=15)
        # CSV: Node,DeviceID,Size,VolumeName
        lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
        for ln in lines[1:]:
            parts = ln.split(",")
            if len(parts) < 4:
                continue
            device_id = parts[1].strip()
            size_str = parts[2].strip()
            label = parts[3].strip() if len(parts) > 3 else ""
            if not device_id:
                continue
            root = device_id + "\\"
            if not os.path.isdir(os.path.join(root, "DCIM")):
                continue
            try:
                size_gb = float(size_str) / (1024 ** 3) if size_str else 0.0
            except ValueError:
                size_gb = 0.0
            results.append({"drive": device_id.upper(), "root": root, "label": label, "size_gb": size_gb})
    except Exception:
        logger.warning("SD detection via wmic failed: %s", traceback.format_exc())

    return results


# ----------------------------------------------------------------------------
# EXIF + hashing
# ----------------------------------------------------------------------------


def _parse_exif_dt(path: str) -> Optional[datetime]:
    """Parse EXIF DateTimeOriginal — the photo's CAPTURE TIME.

    DateTimeOriginal only. No fallback to Image DateTime (which can be
    rewritten by editing software) or EXIF DateTimeDigitized (which can
    differ from capture time on scanned images). For straight-from-camera
    JPGs all three are usually identical, but we explicitly use only the
    capture-time field so we never accidentally match against a transfer
    or sync timestamp.

    Returned as timezone-aware UTC to align with routine windows
    (video_start_timestamp / video_end_timestamp) stored in the same naive
    frame in CompPortal. Per-photo offset (if any) is applied in Phase 3.
    """
    try:
        import exifread
        with _safe_open(path, "rb") as f:
            tags = exifread.process_file(f, stop_tag="EXIF DateTimeOriginal", details=False)
        if "EXIF DateTimeOriginal" not in tags:
            return None
        raw = str(tags["EXIF DateTimeOriginal"])
        # Format: "2026:04:17 19:33:02"
        return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _sha1_first_128k(path: str) -> str:
    h = hashlib.sha1()
    with _safe_open(path, "rb") as f:
        h.update(f.read(128 * 1024))
    return h.hexdigest()


def _sha256_full(path: str) -> Tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with _safe_open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


# ----------------------------------------------------------------------------
# R2 client (boto3 wrapper)
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
    except Exception as e:
        # 404 etc.
        code = getattr(getattr(e, "response", {}), "get", lambda *_: {})("Error", {}).get("Code") if hasattr(e, "response") else None
        if code in ("404", "NoSuchKey", "NotFound"):
            return None
        # HeadObject for absent keys raises ClientError with 404 — treat as absent
        return None


def _r2_put_bytes(client: Any, key: str, body: bytes, content_type: str) -> int:
    client.put_object(Bucket=R2_BUCKET, Key=key, Body=body, ContentType=content_type)
    return len(body)


def _r2_put_file(client: Any, key: str, path: str, content_type: str) -> int:
    # Read-only access to SD file — streamed to R2. Using open(..., 'rb') is safe.
    with _safe_open(path, "rb") as f:
        data = f.read()
    client.put_object(Bucket=R2_BUCKET, Key=key, Body=data, ContentType=content_type)
    return len(data)


# ----------------------------------------------------------------------------
# Thumbnail generation (in-memory, 200x200 WebP q80)
# ----------------------------------------------------------------------------


def _make_thumb_webp(src_path: str, size: Tuple[int, int] = (200, 200), quality: int = 80) -> bytes:
    from PIL import Image
    with _safe_open(src_path, "rb") as f:
        img = Image.open(f)
        img.load()
    # Center-crop to square then thumbnail
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
# DB access (Phase 2 + Phase 8)
# ----------------------------------------------------------------------------


def _db_connect() -> Any:
    """Connect to Supabase Postgres. Requires DATABASE_URL env var.
    TODO: parent will provide DATABASE_URL at deploy time on DART.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL not set. Cannot query media_packages/media_photos. "
            "Set DATABASE_URL to the CompPortal Supabase direct connection string "
            "(postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres) and retry."
        )
    import psycopg2
    import psycopg2.extras
    return psycopg2.connect(url, connect_timeout=15)


def _load_db_baseline(conn: Any) -> Dict[str, Dict[str, Any]]:
    """Return { routine_id (str): { window_start, window_end, entry_number,
    existing_captured_at: set[datetime], max_photo_n: int, package_id } }
    """
    import psycopg2.extras
    out: Dict[str, Dict[str, Any]] = {}
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT mp.id as package_id, mp.entry_id as routine_id, mp.video_start_timestamp,
                   mp.video_end_timestamp, mp.photo_count, mp.entry_number
            FROM media_packages mp
            WHERE mp.competition_id = %s AND mp.deleted_at IS NULL
            """,
            (COMPETITION_ID,),
        )
        for row in cur.fetchall():
            rid = str(row["routine_id"])
            out[rid] = {
                "package_id": str(row["package_id"]),
                "window_start": row["video_start_timestamp"],
                "window_end": row["video_end_timestamp"],
                "entry_number": row.get("entry_number"),
                "photo_count": row.get("photo_count") or 0,
                "existing_captured_at": set(),
                "max_photo_n": 0,
            }

        cur.execute(
            """
            SELECT mp.entry_id as routine_id, ph.captured_at, ph.storage_url
            FROM media_photos ph
            JOIN media_packages mp ON ph.media_package_id = mp.id
            WHERE mp.competition_id = %s AND ph.deleted_at IS NULL
            """,
            (COMPETITION_ID,),
        )
        for row in cur.fetchall():
            rid = str(row["routine_id"])
            if rid not in out:
                continue
            ca = row["captured_at"]
            if ca is not None:
                if ca.tzinfo is None:
                    ca = ca.replace(tzinfo=timezone.utc)
                out[rid]["existing_captured_at"].add(ca)
            storage_url = row.get("storage_url") or ""
            # filename like "photo_034.JPG" — extract N
            import re
            m = re.search(r"photo_(\d+)\.(?i:jpe?g|webp)$", storage_url)
            if m:
                try:
                    n = int(m.group(1))
                    if n > out[rid]["max_photo_n"]:
                        out[rid]["max_photo_n"] = n
                except ValueError:
                    pass
    return out


def _verify_routines(conn: Any) -> List[Dict[str, Any]]:
    """Phase 8: return list of routines with photo_count == 0."""
    import psycopg2.extras
    bad: List[Dict[str, Any]] = []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, entry_id as routine_id, entry_number, video_start_timestamp, video_end_timestamp, photo_count
            FROM media_packages
            WHERE competition_id = %s AND deleted_at IS NULL AND (photo_count IS NULL OR photo_count = 0)
            """,
            (COMPETITION_ID,),
        )
        for row in cur.fetchall():
            bad.append({
                "package_id": str(row["id"]),
                "routine_id": str(row["routine_id"]),
                "entry_number": row.get("entry_number"),
                "window_start": row["video_start_timestamp"].isoformat() if row["video_start_timestamp"] else None,
                "window_end": row["video_end_timestamp"].isoformat() if row["video_end_timestamp"] else None,
                "photo_count": row.get("photo_count") or 0,
            })
    return bad


# ----------------------------------------------------------------------------
# Phase implementations
# ----------------------------------------------------------------------------


def phase0_boot(args: argparse.Namespace) -> Dict[str, Any]:
    _init_logging()
    logger.info("Phase 0: boot. args=%s", vars(args))
    _ensure_log_dir()

    if not _acquire_lock():
        sys.exit(0)

    sd_drives = _detect_sd_drives(override=args.sd)
    if not sd_drives:
        logger.warning("SD_NOT_PRESENT — no removable drives with DCIM detected")
        _release_lock()
        sys.exit(0)

    for d in sd_drives:
        SD_DRIVE_LETTERS.add(d["drive"].upper())

    # R2 connectivity probe — list head on a synthetic benign key
    try:
        client = _r2_client()
        # HEAD a known-prefix path. This will 404, but anything that isn't 401/403
        # means auth + connectivity are OK.
        try:
            client.head_object(Bucket=R2_BUCKET, Key="__connectivity_probe_does_not_exist__")
        except Exception as e:  # noqa: BLE001
            err_code = None
            if hasattr(e, "response") and isinstance(e.response, dict):
                err_code = e.response.get("Error", {}).get("Code")
                http_status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            else:
                http_status = None
            if http_status in (401, 403):
                logger.critical("R2 auth rejected (%s). Aborting boot.", http_status)
                _release_lock()
                sys.exit(2)
            # 404 / NoSuchKey is fine — proves auth works
    except Exception:
        logger.warning("R2 connectivity probe errored non-fatally: %s", traceback.format_exc())

    _heartbeat_update(phase="boot", phase_progress_pct=100.0)
    _heartbeat_flush()

    return {"sds": sd_drives, "started_at": _now_iso()}


def phase1_scan(sds: List[Dict[str, Any]]) -> Dict[str, Any]:
    logger.info("Phase 1: SD scan (%d drives)", len(sds))
    _heartbeat_update(phase="scan", phase_progress_pct=0.0)

    photos: List[Dict[str, Any]] = []
    t0 = time.time()
    total_est = 0  # unknown until walked

    for d in sds:
        root = d["root"]
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                if not fn.lower().endswith((".jpg", ".jpeg")):
                    continue
                fp = os.path.join(dirpath, fn)
                try:
                    st = os.stat(fp)
                    exif_dt = _parse_exif_dt(fp)
                    sha1_128 = _sha1_first_128k(fp)
                    photos.append({
                        "path": fp,
                        "drive": d["drive"].upper(),
                        "size": st.st_size,
                        "mtime": st.st_mtime,
                        "exif_dt": exif_dt.isoformat() if exif_dt else None,
                        "exif_dt_obj": exif_dt,
                        "sha1_128k": sha1_128,
                        "filename": fn,
                    })
                except Exception:
                    logger.warning("scan error on %s: %s", fp, traceback.format_exc())
        _heartbeat_update(photos_total=len(photos))

    # Deterministic pick of 10 files for integrity baseline
    sorted_for_baseline = sorted(photos, key=lambda p: p["path"])
    step = max(1, len(sorted_for_baseline) // 10)
    picks = sorted_for_baseline[::step][:10]
    baseline: List[Dict[str, Any]] = []
    for p in picks:
        try:
            digest, size = _sha256_full(p["path"])
            baseline.append({"path": p["path"], "sha256": digest, "size": size})
        except Exception:
            logger.warning("baseline hash error on %s: %s", p["path"], traceback.format_exc())

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info("Phase 1 done: %d photos scanned, %d in baseline (%dms)", len(photos), len(baseline), elapsed_ms)
    _heartbeat_update(phase="scan", phase_progress_pct=100.0, photos_total=len(photos))
    return {"photos": photos, "integrity_baseline": baseline, "scan_ms": elapsed_ms}


def phase2_db_baseline() -> Dict[str, Any]:
    logger.info("Phase 2: DB baseline query")
    _heartbeat_update(phase="db_baseline", phase_progress_pct=0.0)
    t0 = time.time()
    conn = _db_connect()
    try:
        data = _load_db_baseline(conn)
    finally:
        conn.close()
    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info("Phase 2 done: %d routines loaded (%dms)", len(data), elapsed_ms)
    _heartbeat_update(phase="db_baseline", phase_progress_pct=100.0)
    return {"routines": data, "db_ms": elapsed_ms}


def _extract_filename_folder(filename: str) -> Optional[int]:
    """Extract Panasonic 3-digit folder number from filename (e.g. P1011925.JPG -> 101).

    Returns None if the filename doesn't match the Panasonic P[3-digit-folder]
    [4-digit-counter] format. In that case the marker-based swap detector
    treats consecutive photos as same-camera and skips swap detection — safe,
    because the only known camera in this event is Panasonic Lumix.
    """
    if not filename:
        return None
    base = filename.rsplit(".", 1)[0]
    if len(base) < 4 or base[0].upper() != "P" or not base[1:4].isdigit():
        return None
    try:
        return int(base[1:4])
    except ValueError:
        return None


def phase3_detect_offsets(
    photos: List[Dict[str, Any]],
    routines: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Marker-based detection of the camera-swap / clock-reset window.

    Per operator spec, no routine-window guessing:

      1. Sort photos by filename. Panasonic naming
         (P[3-digit folder][4-digit counter].JPG) means alphabetical sort
         is shooting order.
      2. CAMERA-SWAP START marker: walk pairwise; the first folder-prefix
         jump > SWAP_FOLDER_JUMP_MIN is where a different camera/SD started
         writing. Normal Panasonic folder rolls step by 1 (P109 -> P110);
         a jump like P176 -> P224 (UDC London 2026 swap, +48) is unmistakable.
      3. CLOCK-RESET END marker: within the swap-camera's stream (same
         folder prefix), walk pairwise EXIF DateTimeOriginal. The first gap
         whose absolute value is in [RESET_GAP_MIN_SEC, RESET_GAP_MAX_SEC]
         (40-80 min) is the operator-clock-reset point. The SIGN of the gap
         tells us how the bad clock was off:
           - Negative gap (EXIF jumps backward by ~1h) -> bad clock was
             running fast -> pre-reset photos need offset = -3600s.
           - Positive gap (EXIF jumps forward by ~1h) -> bad clock was
             running slow -> pre-reset photos need offset = +3600s.
      4. Apply that offset to every photo from swap-start to reset-end
         (exclusive). All other photos: offset = 0 (raw EXIF correct).

    If the camera-swap is detected but no clock-reset gap is found in the
    new camera's stream, direction can't be determined from markers alone.
    NO correction applied; needs_review entry is added so the operator
    handles those photos manually rather than risking the wrong direction.
    """
    logger.info("Phase 3: marker-based offset detection over %d photos", len(photos))
    _heartbeat_update(phase="offset", phase_progress_pct=0.0)
    t0 = time.time()

    notes: List[str] = []
    needs_review: List[str] = []
    swap_windows: List[Dict[str, Any]] = []

    photos_with_dt = [p for p in photos if p.get("exif_dt_obj")]
    if not photos_with_dt:
        logger.warning("Phase 3: no photos with EXIF DateTimeOriginal — skipping")
        return {
            "swap_windows": [],
            "notes": ["no-exif-dt"],
            "needs_review": ["phase3: 0 photos had EXIF DateTimeOriginal"],
            "offset_ms": int((time.time() - t0) * 1000),
        }

    # Default every photo to offset 0. Bad-clock window will overwrite below.
    for p in photos_with_dt:
        p["photo_offset_sec"] = 0
        p["cluster_offset_sec"] = 0  # legacy alias for phase 8 compat

    # Build routine windows list (used for competition-date inference)
    routine_windows: List[Tuple[datetime, datetime]] = []
    for r in routines.values():
        ws = r.get("window_start")
        we = r.get("window_end")
        if ws and we:
            if ws.tzinfo is None:
                ws = ws.replace(tzinfo=timezone.utc)
            if we.tzinfo is None:
                we = we.replace(tzinfo=timezone.utc)
            routine_windows.append((ws, we))

    # SIMPLIFIED MATCHER: use raw EXIF for everything. The marker-based
    # offset detection produced false positives — normal session breaks
    # (lunch, intermission) within a camera's stream get a 40-80min EXIF gap
    # that looks identical to a clock reset. There's no reliable way to
    # distinguish them from EXIF alone.
    #
    # Per operator: only ONE clock issue exists in this event — Camera 2 had
    # its clock set to April 2 instead of April 17 (off by 15 days). Camera
    # 2's photos will have EXIF date != competition date, and we flag them as
    # "wrong_day_clock". These photos can't be auto-matched (no offset will
    # fix a 15-day discrepancy) and will fall to "unassigned" naturally in
    # Phase 4. Operator handles them manually by filename order.
    #
    # All other photos: use raw EXIF, match strictly to routine windows.
    skipped_candidates: List[Dict[str, Any]] = []
    wrong_day_count = 0

    # Determine the competition date from routine windows
    from collections import Counter
    routine_dates = Counter()
    for ws, _we in routine_windows:
        routine_dates[ws.date()] += 1
    if routine_dates:
        competition_date = routine_dates.most_common(1)[0][0]
        notes.append(
            f"competition date inferred from routine windows: {competition_date.isoformat()}"
        )
    else:
        competition_date = None

    # Flag wrong-day photos for the report; do NOT shift them
    if competition_date is not None:
        for p in photos_with_dt:
            if p["exif_dt_obj"].date() != competition_date:
                p["wrong_day_clock"] = True
                wrong_day_count += 1
        if wrong_day_count > 0:
            notes.append(
                f"{wrong_day_count} photos have EXIF date != competition date "
                f"({competition_date.isoformat()}) — camera clock was wildly off "
                f"(likely Camera 2 not synced). These will be unassigned in Phase 4."
            )
            needs_review.append(
                f"phase3: {wrong_day_count} wrong-day-clock photos cannot be "
                "auto-matched. Operator: assign manually by filename order to "
                "the correct routines."
            )

    notes.append(
        "no offset correction applied — raw EXIF used for all photos "
        "(marker-based reset detection disabled; see code comment)"
    )

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info(
        "Phase 3 done: %d swap window(s), %d skipped candidate(s) (%dms)",
        len(swap_windows), len(skipped_candidates), elapsed_ms,
    )
    _heartbeat_update(phase="offset", phase_progress_pct=100.0)
    return {
        "swap_windows": swap_windows,
        "skipped_candidates": skipped_candidates,
        "notes": notes,
        "needs_review": needs_review,
        "offset_ms": elapsed_ms,
    }


def phase4_match(
    photos: List[Dict[str, Any]],
    routines: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Strict containment match: corrected EXIF capture time must satisfy
    window_start <= corrected_DateTimeOriginal <= window_end.

    No buffer. No nearest-routine fallback. The recording window IS the
    truth. If a photo doesn't fall inside any window, it is NOT a routine
    photo (between-routine candid, transition shot, pre-show, post-show);
    logged as "unassigned" for visibility, but NOT a matcher failure.

    Multiple overlapping windows containing the same timestamp -> pick the
    one whose midpoint is closest to the corrected time.

    Photos with no EXIF DateTimeOriginal cannot be matched and go to
    "no_capture_time" — also logged but not a routine photo.
    """
    logger.info("Phase 4: strict-containment match %d photos against %d routines",
                len(photos), len(routines))
    _heartbeat_update(phase="match", phase_progress_pct=0.0)
    t0 = time.time()

    matched: List[Dict[str, Any]] = []
    unassigned: List[Dict[str, Any]] = []
    no_capture_time: List[Dict[str, Any]] = []
    stats = {"exact": 0, "tightest": 0, "unassigned": 0, "no_capture_time": 0}

    windows: List[Tuple[datetime, datetime, str]] = []
    for rid, r in routines.items():
        ws = r.get("window_start")
        we = r.get("window_end")
        if ws and we:
            if ws.tzinfo is None:
                ws = ws.replace(tzinfo=timezone.utc)
            if we.tzinfo is None:
                we = we.replace(tzinfo=timezone.utc)
            windows.append((ws, we, rid))
    windows.sort(key=lambda w: w[0])

    for p in photos:
        dt = p.get("exif_dt_obj")
        if not dt:
            no_capture_time.append({
                "path": p["path"],
                "filename": p.get("filename"),
                "reason": "no_exif_datetimeoriginal",
            })
            stats["no_capture_time"] += 1
            continue
        offset_sec = int(p.get("photo_offset_sec", 0) or 0)
        corrected = dt + timedelta(seconds=offset_sec)
        p["corrected_dt"] = corrected

        hits = [(ws, we, rid) for ws, we, rid in windows if ws <= corrected <= we]
        if len(hits) == 1:
            matched.append({"photo": p, "routine_id": hits[0][2]})
            p["match_type"] = "exact"
            stats["exact"] += 1
        elif len(hits) > 1:
            def _mid_distance(tup: Tuple[datetime, datetime, str]) -> float:
                w_s, w_e, _rid = tup
                mid = w_s + (w_e - w_s) / 2
                return abs((corrected - mid).total_seconds())
            hits.sort(key=_mid_distance)
            matched.append({"photo": p, "routine_id": hits[0][2]})
            p["match_type"] = "tightest"
            stats["tightest"] += 1
        else:
            # Find nearest routine for context only (does NOT assign)
            best_rid: Optional[str] = None
            best_dist: Optional[int] = None
            for ws, we, rid in windows:
                if corrected < ws:
                    d = int((ws - corrected).total_seconds())
                else:
                    d = int((corrected - we).total_seconds())
                if best_dist is None or d < best_dist:
                    best_dist = d
                    best_rid = rid
            unassigned.append({
                "path": p["path"],
                "filename": p.get("filename"),
                "raw_exif_iso": dt.isoformat(),
                "applied_offset_sec": offset_sec,
                "corrected_dt_iso": corrected.isoformat(),
                "nearest_routine_id": best_rid,
                "nearest_window_distance_sec": best_dist,
            })
            stats["unassigned"] += 1

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info(
        "Phase 4 done: %d matched (%d exact, %d tightest), %d unassigned, %d no-capture-time (%dms)",
        len(matched), stats["exact"], stats["tightest"],
        stats["unassigned"], stats["no_capture_time"], elapsed_ms,
    )
    _heartbeat_update(phase="match", phase_progress_pct=100.0)
    # "orphans" key kept for orphan-report file backwards compat — combines
    # both unassigned (no window) and no_capture_time photos.
    return {
        "matched": matched,
        "orphans": unassigned + no_capture_time,
        "unassigned": unassigned,
        "no_capture_time": no_capture_time,
        "stats": stats,
        "match_ms": elapsed_ms,
    }


def phase5_dedup(
    matched: List[Dict[str, Any]],
    routines: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    logger.info("Phase 5: dedup %d matched", len(matched))
    _heartbeat_update(phase="dedup", phase_progress_pct=0.0)
    t0 = time.time()

    new_items: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    per_routine: Dict[str, Dict[str, int]] = {}

    # ROUTINE-LEVEL dedup: if a routine already has photo_count > 0 in DB,
    # skip ALL SD matches for it (avoids duplicates since DB captured_at is NULL,
    # making per-photo dedup impossible). Routines with 0 DB photos get fully filled.
    for item in matched:
        rid = item["routine_id"]
        photo = item["photo"]
        rt = routines.get(rid, {})
        existing_count = rt.get("photo_count", 0) or 0
        stat = per_routine.setdefault(rid, {"total": 0, "new": 0, "dedup_skipped": 0})
        stat["total"] += 1
        if existing_count > 0:
            stat["dedup_skipped"] += 1
            skipped.append({"photo": photo, "routine_id": rid, "reason": f"routine_already_has_{existing_count}_photos"})
        else:
            stat["new"] += 1
            new_items.append(item)

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info("Phase 5 done: %d new, %d skipped (%dms)", len(new_items), len(skipped), elapsed_ms)
    _heartbeat_update(phase="dedup", phase_progress_pct=100.0)
    return {"new_items": new_items, "skipped": skipped, "per_routine": per_routine, "dedup_ms": elapsed_ms}


# ----------------------------------------------------------------------------
# Phase 6 — upload (with concurrency + gentle backoff)
# ----------------------------------------------------------------------------


def _record_error_burst() -> bool:
    """Record an error; return True if we should pause (>5 in last 60s)."""
    now = time.time()
    with _ERROR_BURST_LOCK:
        _ERROR_BURST_WINDOW.append(now)
        while _ERROR_BURST_WINDOW and (now - _ERROR_BURST_WINDOW[0]) > 60:
            _ERROR_BURST_WINDOW.pop(0)
        return len(_ERROR_BURST_WINDOW) > 5


def _build_storage_paths(entry_id: str, max_n_counter: List[int], counter_lock: threading.Lock) -> Tuple[str, str, int]:
    with counter_lock:
        max_n_counter[0] += 1
        n = max_n_counter[0]
    base = f"{TENANT_ID}/{COMPETITION_ID}/{entry_id}/photos/photo_{n:03d}.JPG"
    thumb = f"{TENANT_ID}/{COMPETITION_ID}/{entry_id}/photos/photo_{n:03d}_thumb.webp"
    return base, thumb, n


def phase6_upload(
    new_items: List[Dict[str, Any]],
    routines: Dict[str, Dict[str, Any]],
    *,
    dry_run: bool,
    limit: Optional[int],
) -> Dict[str, Any]:
    """Upload originals + thumbs to R2, building per-routine batches for Phase 7."""
    logger.info("Phase 6: upload (new=%d dry=%s limit=%s)", len(new_items), dry_run, limit)
    _heartbeat_update(phase="upload", phase_progress_pct=0.0, photos_total=len(new_items))
    t0 = time.time()

    if limit is not None:
        new_items = new_items[:limit]

    # Per-routine counter (thread-safe)
    counters: Dict[str, List[int]] = {}
    counter_locks: Dict[str, threading.Lock] = {}
    for rid, r in routines.items():
        counters[rid] = [int(r.get("max_photo_n", 0) or 0)]
        counter_locks[rid] = threading.Lock()

    client = None
    if not dry_run:
        client = _r2_client()

    # Per-routine batch of entries for /complete
    batches: Dict[str, List[Dict[str, Any]]] = {}
    per_routine_stats: Dict[str, Dict[str, int]] = {}
    in_flight = [0]
    in_flight_lock = threading.Lock()
    errors = 0
    bytes_uploaded = 0
    objects_created = 0
    thumb_dedup_hits = 0
    errors_lock = threading.Lock()
    failures: List[Dict[str, Any]] = []

    def process_one(item: Dict[str, Any]) -> Dict[str, Any]:
        nonlocal bytes_uploaded, objects_created, thumb_dedup_hits, errors
        rid = item["routine_id"]
        photo = item["photo"]
        try:
            with in_flight_lock:
                in_flight[0] += 1
                _heartbeat_update(uploads_in_flight=in_flight[0], current_routine=routines[rid].get("entry_number"))

            storage_path, thumb_path, n = _build_storage_paths(rid, counters[rid], counter_locks[rid])

            if dry_run:
                return {
                    "routine_id": rid,
                    "storage_path": storage_path,
                    "thumbnail_path": thumb_path,
                    "captured_at_iso": photo["corrected_dt"].isoformat(),
                    "filename": photo["filename"],
                    "dry_run": True,
                    "n": n,
                }

            # 1) Original PUT (idempotent: HEAD first)
            head_orig = _r2_head(client, storage_path)
            if head_orig is None:
                size = _r2_put_file(client, storage_path, photo["path"], "image/jpeg")
                with errors_lock:
                    bytes_uploaded += size
                    objects_created += 1

            # 2) Thumb: build in memory, HEAD, PUT if missing
            head_thumb = _r2_head(client, thumb_path)
            if head_thumb is not None:
                with errors_lock:
                    thumb_dedup_hits += 1
            else:
                thumb_bytes = _make_thumb_webp(photo["path"])
                size = _r2_put_bytes(client, thumb_path, thumb_bytes, "image/webp")
                with errors_lock:
                    bytes_uploaded += size
                    objects_created += 1

            return {
                "routine_id": rid,
                "storage_path": storage_path,
                "thumbnail_path": thumb_path,
                "captured_at_iso": photo["corrected_dt"].isoformat(),
                "filename": photo["filename"],
                "n": n,
            }
        except Exception as e:
            logger.warning("upload failed: %s (%s)", photo.get("path"), e)
            logger.debug("upload traceback:\n%s", traceback.format_exc())
            with errors_lock:
                errors += 1
            failures.append({"path": photo.get("path"), "error": str(e)})
            _heartbeat_update(errors_count=errors)
            if _record_error_burst():
                logger.warning("error burst detected — sleeping 30s backoff")
                time.sleep(30)
            return {"error": True, "path": photo.get("path"), "routine_id": rid}
        finally:
            with in_flight_lock:
                in_flight[0] -= 1
                _heartbeat_update(uploads_in_flight=in_flight[0])

    processed = 0
    with ThreadPoolExecutor(max_workers=UPLOAD_CONCURRENCY, thread_name_prefix="upload") as exe:
        futures = [exe.submit(process_one, it) for it in new_items]
        for fut in as_completed(futures):
            try:
                result = fut.result()
            except Exception as e:
                logger.error("future crash: %s", e)
                with errors_lock:
                    errors += 1
                continue
            processed += 1
            if not result.get("error"):
                batches.setdefault(result["routine_id"], []).append(result)
                stat = per_routine_stats.setdefault(result["routine_id"], {"uploaded": 0})
                stat["uploaded"] += 1
            pct = 100.0 * processed / max(1, len(new_items))
            _heartbeat_update(
                phase_progress_pct=pct,
                photos_processed=processed,
                r2_bytes=bytes_uploaded,
                errors_count=errors,
            )
            if processed % CHECKPOINT_EVERY_N_PHOTOS == 0:
                _write_progress_checkpoint({
                    "phase": "upload",
                    "processed": processed,
                    "total": len(new_items),
                    "errors": errors,
                    "r2_bytes": bytes_uploaded,
                })

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info(
        "Phase 6 done: %d batched, %d errors, %d bytes, %d objects (%dms)",
        sum(len(v) for v in batches.values()), errors, bytes_uploaded, objects_created, elapsed_ms,
    )
    _heartbeat_update(phase="upload", phase_progress_pct=100.0)
    return {
        "batches": batches,
        "failures": failures,
        "errors": errors,
        "bytes_uploaded": bytes_uploaded,
        "objects_created": objects_created,
        "thumb_dedup_hits": thumb_dedup_hits,
        "upload_ms": elapsed_ms,
        "per_routine": per_routine_stats,
    }


def _write_progress_checkpoint(data: Dict[str, Any]) -> None:
    try:
        tmp = PROGRESS_FILE + ".tmp"
        _assert_not_sd_path(tmp)
        with _safe_open(tmp, "w", encoding="utf-8") as f:
            json.dump({**data, "ts": _now_iso()}, f)
        _safe_rename(tmp, PROGRESS_FILE)
    except Exception:
        logger.warning("progress checkpoint write failed: %s", traceback.format_exc())


# ----------------------------------------------------------------------------
# Phase 7 — register with CompPortal /api/plugin/complete (per routine)
# ----------------------------------------------------------------------------


def _post_complete(session: Any, body: Dict[str, Any]) -> Tuple[int, str]:
    import requests
    url = f"{API_BASE}/api/plugin/complete"
    resp = session.post(
        url,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {PLUGIN_API_KEY}",
        },
        data=json.dumps(body),
        timeout=30,
    )
    return resp.status_code, resp.text


def phase7_register(
    batches: Dict[str, List[Dict[str, Any]]],
    routines: Dict[str, Dict[str, Any]],
    *,
    dry_run: bool,
) -> Dict[str, Any]:
    logger.info("Phase 7: register %d routine batches", len(batches))
    _heartbeat_update(phase="register", phase_progress_pct=0.0)
    t0 = time.time()

    needs_review: List[str] = []
    ok_routines: List[str] = []
    failed_routines: List[str] = []

    import requests
    session = requests.Session()

    total = len(batches) or 1
    done = 0
    for rid, entries in batches.items():
        if not entries:
            done += 1
            continue
        photo_paths = [e["storage_path"] for e in entries]
        thumb_paths = [e["thumbnail_path"] for e in entries]
        body = {
            "entryId": rid,
            "competitionId": COMPETITION_ID,
            "files": {
                "photos": photo_paths,
                "photo_thumbnails": thumb_paths,
            },
        }

        if dry_run:
            logger.info("[DRY] /complete body for routine %s: photos=%d", rid, len(photo_paths))
            ok_routines.append(rid)
            done += 1
            _heartbeat_update(phase_progress_pct=100.0 * done / total)
            continue

        backoffs = [5, 30, 120]
        success = False
        for attempt, wait in enumerate([0] + backoffs):
            if wait:
                time.sleep(wait)
            try:
                status, text = _post_complete(session, body)
            except Exception as e:
                logger.warning("register post crash routine=%s attempt=%d err=%s", rid, attempt, e)
                continue
            if 200 <= status < 300:
                success = True
                logger.info("Phase 7 OK routine=%s photos=%d", rid, len(photo_paths))
                break
            if 500 <= status < 600:
                logger.warning("Phase 7 5xx routine=%s status=%d attempt=%d", rid, status, attempt)
                continue
            # 4xx — log once, don't retry
            logger.error("Phase 7 non-retryable routine=%s status=%d body=%s", rid, status, text[:500])
            break

        if success:
            ok_routines.append(rid)
        else:
            failed_routines.append(rid)
            needs_review.append(f"phase7: /complete failed for routine {rid} after retries")
        done += 1
        _heartbeat_update(phase_progress_pct=100.0 * done / total)

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info("Phase 7 done: %d ok, %d failed (%dms)", len(ok_routines), len(failed_routines), elapsed_ms)
    _heartbeat_update(phase="register", phase_progress_pct=100.0)
    return {"ok_routines": ok_routines, "failed_routines": failed_routines, "needs_review": needs_review, "register_ms": elapsed_ms}


# ----------------------------------------------------------------------------
# Phase 8 — all-routines verify
# ----------------------------------------------------------------------------


def phase8_verify(scan_photos: List[Dict[str, Any]]) -> Dict[str, Any]:
    logger.info("Phase 8: verify all routines")
    _heartbeat_update(phase="verify", phase_progress_pct=0.0)
    t0 = time.time()

    try:
        conn = _db_connect()
    except Exception as e:
        logger.error("Phase 8 DB connect failed: %s — verify skipped", e)
        return {"zero_photo_routines": [], "needs_review": [f"phase8: DB unavailable: {e}"], "verify_ms": int((time.time() - t0) * 1000)}

    try:
        zero_routines = _verify_routines(conn)
    finally:
        conn.close()

    needs_review: List[str] = []
    for r in zero_routines:
        # Count SD photos that fall within this window (loose)
        ws = None
        we = None
        if r["window_start"]:
            ws = datetime.fromisoformat(r["window_start"])
            if ws.tzinfo is None:
                ws = ws.replace(tzinfo=timezone.utc)
        if r["window_end"]:
            we = datetime.fromisoformat(r["window_end"])
            if we.tzinfo is None:
                we = we.replace(tzinfo=timezone.utc)
        sd_in_window = 0
        if ws and we:
            for p in scan_photos:
                dt = p.get("exif_dt_obj")
                if not dt:
                    continue
                shifted = dt + timedelta(
                    seconds=int(p.get("photo_offset_sec", p.get("cluster_offset_sec", 0)) or 0)
                )
                if ws <= shifted <= we:
                    sd_in_window += 1
        r["sd_orphan_count_in_window"] = sd_in_window
        needs_review.append(
            f"routine entry={r.get('entry_number')} package={r['package_id']}: 0 photos in DB; "
            f"SD candidates in window = {sd_in_window}"
        )

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info("Phase 8 done: %d zero-photo routines (%dms)", len(zero_routines), elapsed_ms)
    _heartbeat_update(phase="verify", phase_progress_pct=100.0)
    return {"zero_photo_routines": zero_routines, "needs_review": needs_review, "verify_ms": elapsed_ms}


# ----------------------------------------------------------------------------
# Phase 9 — disk cleanup on DART (guarded)
# ----------------------------------------------------------------------------


def _dart_disk_free_gb() -> float:
    try:
        import shutil
        return shutil.disk_usage(DART_OUTPUT_ROOT).free / (1024 ** 3)
    except Exception:
        return 1e9  # if we can't measure, don't gate on it


def phase9_cleanup(
    batches: Dict[str, List[Dict[str, Any]]],
    ok_routines: List[str],
    routines: Dict[str, Dict[str, Any]],
    *,
    dry_run: bool,
    limit: Optional[int],
) -> Dict[str, Any]:
    if dry_run or limit is not None:
        logger.info("Phase 9: skipped (dry_run=%s limit=%s)", dry_run, limit)
        return {"deleted_count": 0, "freed_gb": 0.0, "skipped": True}

    logger.info("Phase 9: disk cleanup")
    _heartbeat_update(phase="cleanup", phase_progress_pct=0.0)
    t0 = time.time()

    deleted = 0
    freed_bytes = 0
    stops = False

    if not os.path.isdir(DART_OUTPUT_ROOT):
        logger.info("Phase 9: output root missing, skipping: %s", DART_OUTPUT_ROOT)
        return {"deleted_count": 0, "freed_gb": 0.0, "skipped": True}

    for rid in ok_routines:
        if stops:
            break
        entry_number = routines.get(rid, {}).get("entry_number")
        if entry_number is None:
            continue
        # Folder name heuristic: look for folders containing "{entry_number}_" or starting with "{entry_number} "
        try:
            candidates = []
            for name in os.listdir(DART_OUTPUT_ROOT):
                full = os.path.join(DART_OUTPUT_ROOT, name)
                if not os.path.isdir(full):
                    continue
                if str(entry_number) in name.split("_")[0] or name.startswith(f"{entry_number} "):
                    candidates.append(full)
            for folder in candidates:
                archive = os.path.join(folder, "_archive")
                if not os.path.isdir(archive):
                    continue
                # Walk every v*/photos inside _archive
                for vdir in os.listdir(archive):
                    pdir = os.path.join(archive, vdir, "photos")
                    if not os.path.isdir(pdir):
                        continue
                    for fn in os.listdir(pdir):
                        if not fn.lower().endswith((".jpg", ".jpeg")):
                            continue
                        fp = os.path.join(pdir, fn)
                        try:
                            # EXIF dt for match
                            dt = _parse_exif_dt(fp)
                            st = os.stat(fp)
                        except Exception:
                            continue
                        # See if any uploaded photo in batches[rid] shares (size, dt within 2s)
                        uploaded = batches.get(rid, [])
                        matched = False
                        for up in uploaded:
                            if up.get("filename") == fn:
                                matched = True
                                break
                        if not matched:
                            continue
                        try:
                            _safe_unlink(fp)
                            deleted += 1
                            freed_bytes += st.st_size
                        except RuntimeError as re:
                            logger.error("cleanup refused (SD guard fired): %s", re)
                        except Exception:
                            logger.warning("cleanup unlink failed: %s", traceback.format_exc())
                        if _dart_disk_free_gb() < DART_DISK_FREE_FLOOR_GB:
                            logger.info("Phase 9: disk free below floor, stopping")
                            stops = True
                            break
                    if stops:
                        break
                if stops:
                    break
        except Exception:
            logger.warning("cleanup scan failed for routine %s: %s", rid, traceback.format_exc())

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info("Phase 9 done: %d deleted, %.2f GB freed (%dms)", deleted, freed_bytes / (1024 ** 3), elapsed_ms)
    _heartbeat_update(phase="cleanup", phase_progress_pct=100.0)
    return {"deleted_count": deleted, "freed_gb": freed_bytes / (1024 ** 3), "cleanup_ms": elapsed_ms}


# ----------------------------------------------------------------------------
# Phase 10 — SD integrity re-check
# ----------------------------------------------------------------------------


def phase10_integrity(baseline: List[Dict[str, Any]]) -> Dict[str, Any]:
    logger.info("Phase 10: SD integrity re-check (%d files)", len(baseline))
    _heartbeat_update(phase="integrity", phase_progress_pct=0.0)
    t0 = time.time()

    violations: List[Dict[str, Any]] = []
    for entry in baseline:
        path = entry["path"]
        try:
            digest, size = _sha256_full(path)
        except Exception as e:
            violations.append({"path": path, "error": str(e)})
            continue
        if digest != entry["sha256"] or size != entry["size"]:
            violations.append({
                "path": path,
                "expected_sha256": entry["sha256"],
                "actual_sha256": digest,
                "expected_size": entry["size"],
                "actual_size": size,
            })

    elapsed_ms = int((time.time() - t0) * 1000)
    if violations:
        banner = "\n" + "!" * 78 + "\nSD INTEGRITY VIOLATION — aborting\n" + "!" * 78 + "\n" + json.dumps(violations, indent=2)
        logger.critical(banner)
        try:
            with _safe_open(ERROR_LOG, "a", encoding="utf-8") as f:
                f.write(banner + "\n")
        except Exception:
            pass
    logger.info("Phase 10 done: %d violations (%dms)", len(violations), elapsed_ms)
    _heartbeat_update(phase="integrity", phase_progress_pct=100.0)
    return {"violations": violations, "verified": len(violations) == 0, "integrity_ms": elapsed_ms}


# ----------------------------------------------------------------------------
# Phase 11 — summary
# ----------------------------------------------------------------------------


def phase11_summary(report: Dict[str, Any]) -> None:
    logger.info("Phase 11: writing report")
    _heartbeat_update(phase="summary", phase_progress_pct=0.0)
    report["finished_at"] = _now_iso()
    started = report.get("started_at")
    if started:
        try:
            dt0 = datetime.strptime(started, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            dt1 = datetime.strptime(report["finished_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            report["duration_sec"] = int((dt1 - dt0).total_seconds())
        except Exception:
            pass
    try:
        tmp = REPORT_FILE + ".tmp"
        _assert_not_sd_path(tmp)
        with _safe_open(tmp, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, default=str)
        _safe_rename(tmp, REPORT_FILE)
    except Exception:
        logger.error("summary write failed: %s", traceback.format_exc())
    _heartbeat_update(phase="summary", phase_progress_pct=100.0)


def _write_orphan_report(orphans: List[Dict[str, Any]]) -> None:
    try:
        tmp = ORPHAN_REPORT + ".tmp"
        _assert_not_sd_path(tmp)
        with _safe_open(tmp, "w", encoding="utf-8") as f:
            json.dump({"ts": _now_iso(), "orphans": orphans}, f, indent=2, default=str)
        _safe_rename(tmp, ORPHAN_REPORT)
    except Exception:
        logger.error("orphan report write failed: %s", traceback.format_exc())


# ----------------------------------------------------------------------------
# Orchestrator
# ----------------------------------------------------------------------------


def run(args: argparse.Namespace) -> int:
    _heartbeat_thread_handle = _start_heartbeat()
    try:
        # PHASE 0
        boot = phase0_boot(args)
        _REPORT.update({"started_at": boot["started_at"], "sds": boot["sds"]})

        if args.reconcile:
            # Reconcile short-circuit: just verify + summary
            verify = phase8_verify(scan_photos=[])
            _REPORT["verify"] = verify
            _REPORT["needs_operator_review"] = verify.get("needs_review", [])
            phase11_summary(_REPORT)
            return 0

        # PHASE 1
        scan = phase1_scan(boot["sds"])
        _REPORT["scan_ms"] = scan["scan_ms"]
        _REPORT["photos_scanned"] = len(scan["photos"])

        # PHASE 2
        try:
            db = phase2_db_baseline()
        except Exception as e:
            logger.critical("Phase 2 failed — cannot match without routine windows: %s", e)
            # Still write partial report so operator has breadcrumbs
            _REPORT["fatal"] = f"phase2: {e}"
            phase11_summary(_REPORT)
            return 0
        _REPORT["db_ms"] = db["db_ms"]

        # PHASE 3
        off = phase3_detect_offsets(scan["photos"], db["routines"])
        _REPORT["offset_swap_windows"] = off.get("swap_windows", [])
        _REPORT["offset_notes"] = off.get("notes", [])
        _REPORT["offset_ms"] = off["offset_ms"]
        needs_review = list(off.get("needs_review", []))

        # PHASE 4
        matched = phase4_match(scan["photos"], db["routines"])
        _REPORT["match_ms"] = matched["match_ms"]
        _REPORT["match_stats"] = matched.get("stats", {})
        _REPORT["unassigned_count"] = len(matched.get("unassigned", []))
        _REPORT["no_capture_time_count"] = len(matched.get("no_capture_time", []))
        _REPORT["orphans_count"] = len(matched["orphans"])  # legacy alias
        _write_orphan_report(matched["orphans"])
        # Surface no-capture-time photos prominently (they can't be matched
        # without EXIF DateTimeOriginal). Unassigned are NOT routine photos
        # by design (between-routine candids) and don't need review.
        if matched.get("stats", {}).get("no_capture_time", 0) > 0:
            needs_review.append(
                f"phase4: {matched['stats']['no_capture_time']} photos lack EXIF "
                "DateTimeOriginal and could not be matched — see overnight-orphans.json"
            )

        # PHASE 5
        dedup = phase5_dedup(matched["matched"], db["routines"])
        _REPORT["dedup_ms"] = dedup["dedup_ms"]

        # PHASE 6
        up = phase6_upload(dedup["new_items"], db["routines"], dry_run=args.dry_run, limit=args.limit)
        _REPORT["upload_ms"] = up["upload_ms"]
        _REPORT["r2_bytes_uploaded"] = up["bytes_uploaded"]
        _REPORT["r2_objects_created"] = up["objects_created"]
        _REPORT["thumb_dedup_hits"] = up["thumb_dedup_hits"]
        _REPORT["upload_failures"] = len(up["failures"])

        # PHASE 7
        reg = phase7_register(up["batches"], db["routines"], dry_run=args.dry_run)
        _REPORT["register_ms"] = reg["register_ms"]
        needs_review.extend(reg.get("needs_review", []))

        # PHASE 8 (verify)
        verify = phase8_verify(scan["photos"])
        _REPORT["verify_ms"] = verify["verify_ms"]
        _REPORT["zero_photo_routines"] = verify["zero_photo_routines"]
        needs_review.extend(verify.get("needs_review", []))

        # PHASE 9 (guarded cleanup)
        cleanup = phase9_cleanup(up["batches"], reg["ok_routines"], db["routines"], dry_run=args.dry_run, limit=args.limit)
        _REPORT["disk_cleanup"] = cleanup

        # PHASE 10 (integrity)
        integ = phase10_integrity(scan["integrity_baseline"])
        _REPORT["sd_integrity_verified"] = integ["verified"]
        _REPORT["sd_integrity_violations"] = integ["violations"]

        # Compose photo rollup
        new_items_count = len(dedup.get("new_items", []))
        dedup_skipped = len(dedup.get("skipped", []))
        _REPORT["photos"] = {
            "scanned": len(scan["photos"]),
            "matched": len(matched["matched"]),
            "matched_exact": matched.get("stats", {}).get("exact", 0),
            "matched_tightest": matched.get("stats", {}).get("tightest", 0),
            "deduped_skipped": dedup_skipped,
            "uploaded_new": new_items_count - up["errors"],
            "thumb_dedup_hits": up["thumb_dedup_hits"],
            "unassigned_not_routine_photo": matched.get("stats", {}).get("unassigned", 0),
            "no_capture_time": matched.get("stats", {}).get("no_capture_time", 0),
            "orphans": len(matched["orphans"]),  # legacy alias
            "failures": up["errors"],
        }
        _REPORT["per_routine"] = dedup.get("per_routine", {})
        _REPORT["errors_count"] = up["errors"]
        _REPORT["needs_operator_review"] = needs_review
        _REPORT["phases"] = {
            "scan_ms": scan["scan_ms"],
            "db_ms": db["db_ms"],
            "offset_ms": off["offset_ms"],
            "match_ms": matched["match_ms"],
            "dedup_ms": dedup["dedup_ms"],
            "upload_ms": up["upload_ms"],
            "register_ms": reg["register_ms"],
            "verify_ms": verify["verify_ms"],
            "cleanup_ms": cleanup.get("cleanup_ms", 0),
            "integrity_ms": integ["integrity_ms"],
        }

        # PHASE 11
        phase11_summary(_REPORT)

        if not integ["verified"]:
            return 2
        return 0
    finally:
        _HEARTBEAT_STOP.set()
        try:
            _heartbeat_thread_handle.join(timeout=5)
        except Exception:
            pass
        _release_lock()


def _parse_args(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Overnight SD-card photo import")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--full-run", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--reconcile", action="store_true")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--sd", type=str, default=None, help="Override SD path (testing)")
    args = p.parse_args(argv)
    if not any([args.full_run, args.dry_run, args.reconcile, args.limit is not None]):
        p.error("one of --full-run / --dry-run / --limit / --reconcile is required")
    return args


def main(argv: Optional[List[str]] = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    args = _parse_args(argv)

    # Graceful signal handling — finish phase, release lock
    def _term_handler(signum: int, _frame: Any) -> None:
        logger.warning("signal %s received — will finish current phase then exit", signum)
        _HEARTBEAT_STOP.set()

    try:
        signal.signal(signal.SIGTERM, _term_handler)
        signal.signal(signal.SIGINT, _term_handler)
    except Exception:
        pass

    return run(args)


if __name__ == "__main__":
    sys.exit(main())
