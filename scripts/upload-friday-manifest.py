#!/usr/bin/env python3
"""
upload-friday-manifest.py — Friday-recovery photo re-assignment executor.

Mechanical R2 + DB writer for the UDC London 2026 Friday 2026-04-17 photo
re-sort. Takes an operator-approved match manifest (produced by the
`match-v3.py` / `build-mapping.py` pipeline under /tmp/fri-recovery/) and
assigns each orphan photo to its correct routine by:

  1. Reading the source JPG off the local filesystem (DART SD or ASTEROID
     Transfer drive snapshot).
  2. Generating a 200x200 WebP thumbnail (matches the in-app SD-import
     behavior in `src/main/services/photos.ts`).
  3. PUTting original + thumb to R2 at the tenant/competition/entry
     convention used by the live Electron pipeline.
  4. Inserting a row in `media_photos` under the entry's `media_package`,
     with `captured_at` set from the manifest's `real_utc_used`.

The script is **dry-run-safe by default semantics** — the operator must
pass `--execute` to actually upload / write. Without `--execute`, every
code path that would touch R2 or the DB prints what it WOULD do and
returns.

Usage
-----

    # Smoke test (no writes, no uploads)
    python3 upload-friday-manifest.py \\
        --manifest /tmp/fri-recovery/match-v3.json \\
        --dry-run --limit 5

    # Partial test, still dry
    python3 upload-friday-manifest.py \\
        --manifest /tmp/fri-recovery/match-v3.json \\
        --dry-run --limit 500

    # Real run — requires --execute AND an env-vars file for R2 + Supabase
    python3 upload-friday-manifest.py \\
        --manifest /tmp/fri-recovery/match-v3.json \\
        --env-file /home/danman60/.env.friday-recovery \\
        --execute

    # Resume interrupted real run (auto-detects state file by manifest hash)
    python3 upload-friday-manifest.py \\
        --manifest /tmp/fri-recovery/match-v3.json \\
        --env-file /home/danman60/.env.friday-recovery \\
        --execute \\
        --resume

State, logs, failures
---------------------
  /tmp/fri-recovery/upload-state-<ts>.json     — processed-entry checkpoint
  /tmp/fri-recovery/upload-log-<ts>.log        — per-entry outcome log
  /tmp/fri-recovery/failed-entries-<ts>.json   — entries that failed 3 retries

Path mapping (Windows SD → local Linux)
----------------------------------------
Manifest paths look like `F:\\DCIM\\101_PANA\\P1011943.JPG`. The script
rewrites these using `--source-root` (e.g. `/mnt/firmament/friday-sd-dumps`)
so that `F:\\DCIM\\...` becomes `<source-root>/F/DCIM/...`. Set
`--source-root` to wherever the SD dumps live on whatever machine this
runs on. Path resolution is verified at startup.

Env vars (via --env-file, KEY=VAL format)
------------------------------------------
  R2_ACCOUNT_ID
  R2_ENDPOINT                   (e.g. https://<acct>.r2.cloudflarestorage.com)
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_BUCKET_NAME                (default: compsyncmedia)
  SUPABASE_URL                  (https://cafugvuaatsgihrsmvvl.supabase.co)
  SUPABASE_SERVICE_ROLE_KEY     (service role — REQUIRED for inserts)

R2 / DB are NEVER touched unless --execute is set. --dry-run implies
nothing is touched regardless.

Idempotency
-----------
A `media_photos` row is considered a duplicate when a row exists for the
same `media_package_id` AND `storage_url`. The script computes the target
`storage_url` before insert and queries for it; if present, the row is
skipped. R2 PUT dedup is best-effort via HEAD pre-check when the bucket
is directly accessible with the given credentials.

Storage-path convention (matches live Electron flow)
----------------------------------------------------
    <tenant>/<competition>/<entry>/photos/<filename>
    <tenant>/<competition>/<entry>/photos/<filename-stem>_thumb.webp

We intentionally do NOT inject an `uploadRunId` subdir — this is an
out-of-band recovery insert and the manifest already defines the target
keys. This matches how legacy rows were stored (see media_photos
existing rows sampled 2026-04-18).
"""

from __future__ import annotations

import sys as _sys
try:
    _sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    _sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

import argparse
import dataclasses
import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Third-party (required for --execute, optional for --dry-run)
try:
    from PIL import Image  # pillow
except ImportError:
    Image = None  # lazily required

try:
    import boto3
    from botocore.client import Config as BotoConfig
    from botocore.exceptions import ClientError
except ImportError:
    boto3 = None
    BotoConfig = None  # type: ignore
    ClientError = Exception  # type: ignore

try:
    import urllib.request
    import urllib.error
except ImportError:  # pragma: no cover
    urllib = None  # type: ignore


# ──────────────────────────────────────────────────────────────────────────
# Constants — UDC London 2026 Friday-recovery context
# ──────────────────────────────────────────────────────────────────────────
TENANT_ID = "00000000-0000-0000-0000-000000000004"
COMPETITION_ID = "6f29f048-61f2-48c2-982f-27b542f974b2"
DEFAULT_R2_BUCKET = "compsyncmedia"
DEFAULT_MANIFEST = "/tmp/fri-recovery/match-v3.json"
STATE_DIR = Path("/tmp/fri-recovery")
RETRY_ATTEMPTS = 3
BACKOFF_SECONDS = [2, 5, 15]  # per attempt


# ──────────────────────────────────────────────────────────────────────────
# Data model
# ──────────────────────────────────────────────────────────────────────────
@dataclasses.dataclass
class ManifestEntry:
    """One row from match-v3.json. Matches the real input schema."""
    path: str
    filename: str
    drive: str
    folder: Any
    camera: str
    raw_exif: Optional[str]
    real_utc_used: Optional[str]
    offset_label: Optional[str]
    matched_entry_number: Optional[int]
    matched_entry_id: Optional[str]
    status: str

    @classmethod
    def from_dict(cls, d: dict) -> "ManifestEntry":
        # Support either matched_entry_id (real input) or matched_routine_id
        # (the name used in the task-brief example).
        entry_id = d.get("matched_entry_id") or d.get("matched_routine_id")
        return cls(
            path=d["path"],
            filename=d["filename"],
            drive=d.get("drive", ""),
            folder=d.get("folder"),
            camera=d.get("camera", ""),
            raw_exif=d.get("raw_exif"),
            real_utc_used=d.get("real_utc_used"),
            offset_label=d.get("offset_label"),
            matched_entry_number=d.get("matched_entry_number"),
            matched_entry_id=entry_id,
            status=d.get("status", "unknown"),
        )

    def is_actionable(self) -> bool:
        """Only matched_unique entries with a target entry_id get written."""
        return self.status == "matched_unique" and bool(self.matched_entry_id)


# ──────────────────────────────────────────────────────────────────────────
# Config + env loading
# ──────────────────────────────────────────────────────────────────────────
def load_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VAL lines from a .env-style file. No shell evaluation."""
    out: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        out[k] = v
    return out


def get_env(env: dict[str, str], key: str, default: Optional[str] = None, required: bool = False) -> Optional[str]:
    val = env.get(key) or os.environ.get(key) or default
    if required and not val:
        raise SystemExit(f"Missing required env var: {key}")
    return val


# ──────────────────────────────────────────────────────────────────────────
# Path resolution — Windows-style manifest → local source file
# ──────────────────────────────────────────────────────────────────────────
_WIN_PATH_RE = re.compile(r"^([A-Za-z]):[\\/](.+)$")


def resolve_source_path(manifest_path: str, source_root: Path) -> Path:
    """
    Turn `F:\\DCIM\\101_PANA\\P1011943.JPG` into
    `<source-root>/F/DCIM/101_PANA/P1011943.JPG`.

    If source_root is empty ("" / Path(".")) and the manifest path is a Windows
    absolute path, return it as-is (file is readable at its original drive letter).

    If the manifest path is already a POSIX absolute path, return as-is.
    """
    if manifest_path.startswith("/") or manifest_path.startswith("\\\\"):
        return Path(manifest_path)

    m = _WIN_PATH_RE.match(manifest_path)
    if m and str(source_root) in (".", ""):
        # source_root is empty -> use manifest path as-is (Windows absolute).
        return Path(manifest_path)

    if not m:
        # fallback — treat as relative under source_root
        return source_root / manifest_path.replace("\\", "/")

    drive_letter = m.group(1).upper()
    rest = m.group(2).replace("\\", "/")
    return source_root / drive_letter / rest


# ──────────────────────────────────────────────────────────────────────────
# Storage path construction — matches CompPortal `/api/plugin/upload-url`
# convention as seen in live media_packages / media_photos rows.
# ──────────────────────────────────────────────────────────────────────────
def storage_path_for(entry_id: str, filename: str) -> str:
    """
    `<tenant>/<competition>/<entry_id>/photos/<filename>`.
    Recovery inserts skip the `uploadRunId/` subdir — existing
    media_photos rows show both forms. The live app adds a runId when it
    mints a signed URL; the DB-native rows that pre-date that change use
    the flat form. We match the flat form for recovery so dedup lookups
    by storage_url cleanly identify prior inserts.
    """
    return f"{TENANT_ID}/{COMPETITION_ID}/{entry_id}/photos/{filename}"


def thumb_storage_path_for(entry_id: str, filename: str) -> str:
    """Sibling `<stem>_thumb.webp` under the same photos/ prefix."""
    stem = re.sub(r"\.(jpe?g)$", "", filename, flags=re.IGNORECASE)
    return f"{TENANT_ID}/{COMPETITION_ID}/{entry_id}/photos/{stem}_thumb.webp"


# ──────────────────────────────────────────────────────────────────────────
# Thumbnail generation — 200x200 WebP, matches sharp() behavior
# ──────────────────────────────────────────────────────────────────────────
def generate_thumbnail_bytes(jpg_path: Path) -> bytes:
    """Return WebP-encoded 200x200 cover-cropped thumb for jpg_path."""
    if Image is None:
        raise RuntimeError("Pillow not installed — `pip install Pillow` before running with --execute")
    with Image.open(jpg_path) as im:
        im = im.convert("RGB")
        # cover: scale to fill 200x200, then center-crop
        w, h = im.size
        target = 200
        scale = max(target / w, target / h)
        new_w, new_h = int(round(w * scale)), int(round(h * scale))
        im = im.resize((new_w, new_h), Image.LANCZOS)
        left = (new_w - target) // 2
        top = (new_h - target) // 2
        im = im.crop((left, top, left + target, top + target))
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=80)
        return buf.getvalue()


# ──────────────────────────────────────────────────────────────────────────
# R2 client
# ──────────────────────────────────────────────────────────────────────────
class R2Client:
    def __init__(self, endpoint: str, access_key: str, secret_key: str, bucket: str):
        if boto3 is None:
            raise RuntimeError("boto3 not installed — `pip install boto3` before running with --execute")
        self.bucket = bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
            region_name="auto",
        )

    def head(self, key: str) -> bool:
        try:
            self._s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def put(self, key: str, body: bytes, content_type: str) -> None:
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)


# ──────────────────────────────────────────────────────────────────────────
# Supabase REST client (service-role)
# ──────────────────────────────────────────────────────────────────────────
class SupabaseClient:
    def __init__(self, url: str, service_key: str):
        self.url = url.rstrip("/")
        self.key = service_key
        self._pkg_cache: dict[str, Optional[str]] = {}  # entry_id → media_package_id

    def _req(self, method: str, path: str, *, params: dict | None = None, body: dict | list | None = None) -> Any:
        qs = ""
        if params:
            qs = "?" + "&".join(f"{k}={v}" for k, v in params.items())
        req = urllib.request.Request(
            f"{self.url}{path}{qs}",
            method=method,
            data=(json.dumps(body).encode() if body is not None else None),
            headers={
                "apikey": self.key,
                "Authorization": f"Bearer {self.key}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode(errors="replace") if e.fp else ""
            raise RuntimeError(f"Supabase {method} {path} → {e.code}: {body_txt}") from e

    def get_or_create_package(self, entry_id: str, entry_number: Optional[int], execute: bool, log: logging.Logger) -> Optional[str]:
        """
        Look up media_packages row for (tenant, competition, entry). Returns
        package_id. If not found AND execute=True, creates one; otherwise
        logs and returns None so caller can skip.
        """
        if entry_id in self._pkg_cache:
            return self._pkg_cache[entry_id]

        params = {
            "tenant_id": f"eq.{TENANT_ID}",
            "competition_id": f"eq.{COMPETITION_ID}",
            "entry_id": f"eq.{entry_id}",
            "select": "id,photo_count",
            "limit": "1",
        }
        rows = self._req("GET", "/rest/v1/media_packages", params=params) or []
        if rows:
            pid = rows[0]["id"]
            self._pkg_cache[entry_id] = pid
            return pid

        # Missing package → create (only under --execute)
        if not execute:
            log.warning(f"[dry] no media_packages row for entry {entry_id} — would CREATE")
            self._pkg_cache[entry_id] = None
            return None

        if entry_number is None:
            log.error(f"cannot create package for entry {entry_id}: no entry_number in manifest")
            self._pkg_cache[entry_id] = None
            return None

        body = {
            "tenant_id": TENANT_ID,
            "competition_id": COMPETITION_ID,
            "entry_id": entry_id,
            "entry_number": entry_number,
            "status": "complete",
        }
        created = self._req("POST", "/rest/v1/media_packages", body=body)
        pid = created[0]["id"] if isinstance(created, list) else created["id"]
        log.info(f"created media_packages row {pid} for entry {entry_id} (#{entry_number})")
        self._pkg_cache[entry_id] = pid
        return pid

    def photo_exists(self, package_id: str, storage_url: str) -> bool:
        params = {
            "media_package_id": f"eq.{package_id}",
            "storage_url": f"eq.{storage_url}",
            "select": "id",
            "limit": "1",
        }
        rows = self._req("GET", "/rest/v1/media_photos", params=params) or []
        return len(rows) > 0

    def insert_photo(self, *, package_id: str, storage_url: str, thumb_url: Optional[str], filename: str, file_size: int, captured_at: Optional[str], sort_order: int) -> str:
        body = {
            "media_package_id": package_id,
            "storage_url": storage_url,
            "thumbnail_url": thumb_url,
            "filename": filename,
            "file_size_bytes": file_size,
            "captured_at": captured_at,
            "sort_order": sort_order,
        }
        row = self._req("POST", "/rest/v1/media_photos", body=body)
        return (row[0]["id"] if isinstance(row, list) else row["id"])


# ──────────────────────────────────────────────────────────────────────────
# State / resume support
# ──────────────────────────────────────────────────────────────────────────
def manifest_hash(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        while True:
            chunk = f.read(128 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()[:12]


def state_file_for(manifest_path: Path, timestamp: str) -> Path:
    return STATE_DIR / f"upload-state-{manifest_hash(manifest_path)}-{timestamp}.json"


def load_resume_state(manifest_path: Path) -> tuple[Optional[Path], set[str]]:
    """Find the most recent state file for this manifest, return its path + processed keys."""
    prefix = f"upload-state-{manifest_hash(manifest_path)}-"
    candidates = sorted(STATE_DIR.glob(f"{prefix}*.json"))
    if not candidates:
        return None, set()
    latest = candidates[-1]
    try:
        data = json.loads(latest.read_text())
        return latest, set(data.get("processed", []))
    except Exception:
        return latest, set()


def dump_state(state_path: Path, processed: set[str]) -> None:
    state_path.write_text(json.dumps({"processed": sorted(processed), "updated_at": datetime.now(timezone.utc).isoformat()}, indent=2))


def entry_key(e: ManifestEntry) -> str:
    """Unique key per manifest entry for dedup / resume."""
    return f"{e.matched_entry_id}|{e.filename}|{e.path}"


# ──────────────────────────────────────────────────────────────────────────
# Core processor
# ──────────────────────────────────────────────────────────────────────────
@dataclasses.dataclass
class Stats:
    total: int = 0
    actionable: int = 0
    uploaded: int = 0
    skipped_dup: int = 0
    skipped_resume: int = 0
    skipped_non_actionable: int = 0
    skipped_missing_file: int = 0
    failed: int = 0


def process_entry(
    e: ManifestEntry,
    *,
    source_root: Path,
    r2: Optional[R2Client],
    sb: Optional[SupabaseClient],
    execute: bool,
    dry_run: bool,
    log: logging.Logger,
) -> str:
    """
    Returns one of: 'uploaded' | 'skipped-dup' | 'skipped-missing' | 'failed'.
    Never raises — all errors logged + returned as 'failed'.
    """
    local_path = resolve_source_path(e.path, source_root)

    # Storage paths up front — used for both dry-run logging and dedup
    target_url = storage_path_for(e.matched_entry_id, e.filename)  # type: ignore[arg-type]
    thumb_url = thumb_storage_path_for(e.matched_entry_id, e.filename)  # type: ignore[arg-type]

    log.info(f"-> {e.filename} entry={e.matched_entry_id} #{e.matched_entry_number} cam={e.camera} captured={e.real_utc_used}")
    log.info(f"    src:  {local_path}")
    log.info(f"    r2:   {target_url}")
    log.info(f"    thumb:{thumb_url}")

    if dry_run:
        if not local_path.exists():
            log.warning(f"    [dry] source file MISSING — would skip: {local_path}")
            return "skipped-missing"
        log.info(f"    [dry] would generate thumb, PUT original + thumb, upsert media_photos row")
        return "uploaded"

    if not execute:
        log.info(f"    [no-exec] would process; pass --execute to actually write")
        return "uploaded"

    # ── Real path ────────────────────────────────────────────────────────
    if not local_path.exists():
        log.warning(f"    source file MISSING: {local_path}")
        return "skipped-missing"

    assert sb is not None and r2 is not None
    pkg_id = sb.get_or_create_package(e.matched_entry_id, e.matched_entry_number, execute=True, log=log)  # type: ignore[arg-type]
    if not pkg_id:
        log.error(f"    no media_packages row; cannot insert photo")
        return "failed"

    # DB-level idempotency: if a row already exists for (pkg, storage_url), skip.
    if sb.photo_exists(pkg_id, target_url):
        log.info(f"    skip: media_photos row already exists for {target_url}")
        return "skipped-dup"

    # Retry loop — original PUT, thumb PUT, then DB insert.
    last_err: Optional[str] = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            # HEAD pre-check (best-effort dedup)
            if not r2.head(target_url):
                body = local_path.read_bytes()
                r2.put(target_url, body, content_type=mimetypes.guess_type(e.filename)[0] or "image/jpeg")
                file_size = len(body)
            else:
                file_size = local_path.stat().st_size
                log.info(f"    r2 original already present (HEAD-hit)")

            # Thumb (non-fatal if it fails — original is the primary object)
            try:
                if not r2.head(thumb_url):
                    thumb_bytes = generate_thumbnail_bytes(local_path)
                    r2.put(thumb_url, thumb_bytes, content_type="image/webp")
                else:
                    log.info(f"    r2 thumb already present (HEAD-hit)")
            except Exception as terr:
                log.warning(f"    thumb upload failed (non-fatal): {terr}")
                thumb_url_to_use = None
            else:
                thumb_url_to_use = thumb_url

            # DB insert
            photo_id = sb.insert_photo(
                package_id=pkg_id,
                storage_url=target_url,
                thumb_url=thumb_url_to_use,
                filename=e.filename,
                file_size=file_size,
                captured_at=e.real_utc_used,
                sort_order=0,
            )
            log.info(f"    OK media_photos.id={photo_id}")
            return "uploaded"
        except Exception as err:
            last_err = str(err)
            if attempt < RETRY_ATTEMPTS:
                delay = BACKOFF_SECONDS[attempt - 1]
                log.warning(f"    attempt {attempt} failed: {last_err} — retrying in {delay}s")
                time.sleep(delay)
            else:
                log.error(f"    FINAL FAIL after {RETRY_ATTEMPTS} attempts: {last_err}")
    return "failed"


# ──────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="Friday-recovery photo upload executor")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST, help=f"Path to match manifest JSON (default: {DEFAULT_MANIFEST})")
    ap.add_argument("--source-root", default="/mnt/firmament/friday-sd-dumps", help="Root dir where Windows-style drive letters map under. e.g. F:\\DCIM → <root>/F/DCIM")
    ap.add_argument("--limit", type=int, default=0, help="Process at most N actionable entries (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="No writes, no uploads, log-only")
    ap.add_argument("--execute", action="store_true", help="Actually upload to R2 and insert DB rows. Required for real run.")
    ap.add_argument("--env-file", help="Path to KEY=VAL env file with R2 + Supabase creds (required for --execute)")
    ap.add_argument("--resume", action="store_true", help="Pick up from most recent state file for this manifest")
    ap.add_argument("--verbose", action="store_true", help="Debug-level logging")
    args = ap.parse_args()

    if args.dry_run and args.execute:
        raise SystemExit("--dry-run and --execute are mutually exclusive")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = STATE_DIR / f"upload-log-{ts}.log"
    failed_path = STATE_DIR / f"failed-entries-{ts}.json"

    # Logger: stdout + file
    log = logging.getLogger("friday-upload")
    log.setLevel(logging.DEBUG if args.verbose else logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(sh)
    fh = logging.FileHandler(log_path)
    fh.setFormatter(fmt)
    log.addHandler(fh)

    mode = "DRY-RUN" if args.dry_run else ("EXECUTE" if args.execute else "PLAN-ONLY (no --execute)")
    log.info("=" * 72)
    log.info(f"Friday-recovery uploader — mode: {mode}")
    log.info(f"Manifest: {args.manifest}")
    log.info(f"Source root: {args.source_root}")
    log.info(f"Log file: {log_path}")
    log.info("=" * 72)

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        log.error(f"Manifest not found: {manifest_path}")
        return 2

    source_root = Path(args.source_root)
    raw = json.loads(manifest_path.read_text())
    entries = [ManifestEntry.from_dict(d) for d in raw]

    # Resume set
    state_path: Optional[Path] = None
    processed: set[str] = set()
    if args.resume:
        prev_state, processed = load_resume_state(manifest_path)
        if prev_state:
            state_path = prev_state  # reuse same state file
            log.info(f"Resuming from {prev_state} ({len(processed)} entries previously processed)")
        else:
            log.info("No prior state file for this manifest; starting fresh")
    if state_path is None:
        state_path = state_file_for(manifest_path, ts)
    log.info(f"State file: {state_path}")

    # R2 + Supabase clients (only when --execute)
    r2: Optional[R2Client] = None
    sb: Optional[SupabaseClient] = None
    if args.execute:
        if not args.env_file:
            raise SystemExit("--execute requires --env-file")
        env = load_env_file(Path(args.env_file))
        r2 = R2Client(
            endpoint=get_env(env, "R2_ENDPOINT", required=True),  # type: ignore[arg-type]
            access_key=get_env(env, "R2_ACCESS_KEY_ID", required=True),  # type: ignore[arg-type]
            secret_key=get_env(env, "R2_SECRET_ACCESS_KEY", required=True),  # type: ignore[arg-type]
            bucket=get_env(env, "R2_BUCKET_NAME", default=DEFAULT_R2_BUCKET) or DEFAULT_R2_BUCKET,
        )
        sb = SupabaseClient(
            url=get_env(env, "SUPABASE_URL", required=True),  # type: ignore[arg-type]
            service_key=get_env(env, "SUPABASE_SERVICE_ROLE_KEY", required=True),  # type: ignore[arg-type]
        )

    stats = Stats(total=len(entries))
    failures: list[dict[str, Any]] = []
    t0 = time.time()

    actionable_n = 0
    for e in entries:
        if not e.is_actionable():
            stats.skipped_non_actionable += 1
            continue
        stats.actionable += 1

        key = entry_key(e)
        if key in processed:
            stats.skipped_resume += 1
            continue

        if args.limit and actionable_n >= args.limit:
            break
        actionable_n += 1

        try:
            outcome = process_entry(
                e,
                source_root=source_root,
                r2=r2,
                sb=sb,
                execute=args.execute,
                dry_run=args.dry_run,
                log=log,
            )
        except Exception as err:
            log.error(f"process_entry crashed on {e.filename}: {err}")
            outcome = "failed"

        if outcome == "uploaded":
            stats.uploaded += 1
            processed.add(key)
        elif outcome == "skipped-dup":
            stats.skipped_dup += 1
            processed.add(key)
        elif outcome == "skipped-missing":
            stats.skipped_missing_file += 1
            failures.append({"reason": "source-file-missing", "entry": dataclasses.asdict(e)})
        elif outcome == "failed":
            stats.failed += 1
            failures.append({"reason": "upload-or-insert-failed", "entry": dataclasses.asdict(e)})

        # Checkpoint every 50 entries
        if args.execute and stats.actionable % 50 == 0:
            dump_state(state_path, processed)

    # Final state flush + failures
    if args.execute:
        dump_state(state_path, processed)
    if failures:
        failed_path.write_text(json.dumps(failures, indent=2))
        log.warning(f"{len(failures)} entries failed — see {failed_path}")

    elapsed = time.time() - t0
    log.info("=" * 72)
    log.info("SUMMARY")
    log.info(f"  manifest entries:        {stats.total}")
    log.info(f"  actionable (matched):    {stats.actionable}")
    log.info(f"  non-actionable skipped:  {stats.skipped_non_actionable}")
    log.info(f"  already-processed skip:  {stats.skipped_resume}")
    log.info(f"  uploaded (or would):     {stats.uploaded}")
    log.info(f"  skipped (dup in DB):     {stats.skipped_dup}")
    log.info(f"  skipped (missing file):  {stats.skipped_missing_file}")
    log.info(f"  failed:                  {stats.failed}")
    log.info(f"  elapsed:                 {elapsed:.1f}s")
    log.info("=" * 72)

    return 0 if stats.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
