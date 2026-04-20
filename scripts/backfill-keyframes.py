#!/usr/bin/env python3
"""
backfill-keyframes.py — extract + upload 3 video keyframes per already-
encoded routine for CompPortal's Gemini spot-check validator.

Extracts keyframes at 20%, 50%, 80% of each routine's MKV via ffmpeg,
encodes as 400x400 WebP (quality 80), uploads to R2 under:

  <tenant>/<competition>/<entry_id>/videos/keyframes/keyframe_{0,1,2}.webp

Writes a per-entry success/failure manifest to
  /tmp/keyframe-backfill-<competitionId>-<ts>.json

Notes:
- Does NOT call any CompPortal PATCH endpoint. The endpoint is not live
  yet (CompPortal sibling session is building it). Once it is, a follow-up
  script can read the manifest here and POST/PATCH the paths. Skipping
  this step means the R2 objects exist but `media_packages` rows don't
  reference them yet — harmless.
- Idempotent: HEAD-checks each target R2 key before uploading.
- Dry-run-safe by default. Pass --execute to actually write.

Usage
-----
    # Smoke (no writes)
    python3 backfill-keyframes.py --dry-run --limit 3

    # Real run
    python3 backfill-keyframes.py --execute \\
        --env-file ~/.env.compsync-r2 \\
        --source-root "C:\\Users\\User\\OneDrive\\Desktop\\TesterOutput\\UDC London 2026" \\
        --competition-id 6f29f048-61f2-48c2-982f-27b542f974b2 \\
        --tenant-id 00000000-0000-0000-0000-000000000004

Env vars expected (via --env-file or shell):
    R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    import boto3  # type: ignore
    from botocore.client import Config as BotoConfig  # type: ignore
    from botocore.exceptions import ClientError  # type: ignore
except ImportError:
    boto3 = None  # type: ignore
    BotoConfig = None  # type: ignore
    ClientError = Exception  # type: ignore


DEFAULT_R2_BUCKET = "compsyncmedia"
DEFAULT_COMP = "6f29f048-61f2-48c2-982f-27b542f974b2"  # UDC London 2026
DEFAULT_TENANT = "00000000-0000-0000-0000-000000000004"

# 20/50/80% keyframe extraction — spec per CompPortal Gemini validator (2026-04-19)
KEYFRAME_PERCENTAGES = [0.20, 0.50, 0.80]
KEYFRAME_RESOLUTION = 400
KEYFRAME_QUALITY = "5"  # ffmpeg -q:v scale (2=highest, 31=lowest) → 5 ≈ WebP 80


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get_env(env: dict[str, str], key: str, default: Optional[str] = None, required: bool = False) -> Optional[str]:
    v = env.get(key) or os.environ.get(key) or default
    if required and not v:
        sys.exit(f"ERROR: required env var {key} is not set (use --env-file or export)")
    return v


def probe_duration_seconds(ffmpeg: str, input_path: Path) -> float:
    """Parse `Duration: HH:MM:SS.mmm` from ffmpeg -i stderr."""
    try:
        proc = subprocess.run(
            [ffmpeg, "-i", str(input_path), "-hide_banner"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        return 0.0
    stderr = proc.stderr.decode(errors="replace")
    m = re.search(r"Duration:\s+(\d+):(\d+):(\d+\.\d+)", stderr)
    if not m:
        return 0.0
    h, mn, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return h * 3600 + mn * 60 + s


def extract_keyframe(ffmpeg: str, mkv: Path, seek_sec: float, out_path: Path) -> bool:
    """Extract one 400x400 WebP keyframe. Returns True on success."""
    args = [
        ffmpeg,
        "-ss", f"{seek_sec:.3f}",
        "-i", str(mkv),
        "-frames:v", "1",
        "-vf", f"scale={KEYFRAME_RESOLUTION}:{KEYFRAME_RESOLUTION}:force_original_aspect_ratio=increase,crop={KEYFRAME_RESOLUTION}:{KEYFRAME_RESOLUTION}",
        "-q:v", KEYFRAME_QUALITY,
        "-f", "webp",
        "-y",
        str(out_path),
    ]
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        return proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0
    except subprocess.TimeoutExpired:
        return False


def find_mkv_for_entry(source_root: Path, entry_number: str) -> Optional[Path]:
    """
    Look for the routine's canonical MKV under `<source_root>/<entry_number>/*.mkv`.
    Picks the largest one in the folder (matches the app's pickLongestMkv
    behavior for choosing the main take when a re-record archive exists).
    """
    folder = source_root / entry_number
    if not folder.is_dir():
        return None
    candidates = list(folder.glob("*.mkv"))
    # Also check _archive/v*/ for larger takes (matches app's pickLongestMkv)
    archive = folder / "_archive"
    if archive.is_dir():
        for vdir in archive.iterdir():
            if vdir.is_dir():
                candidates.extend(vdir.glob("*.mkv"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_size)


class R2Client:
    def __init__(self, endpoint: str, access_key: str, secret_key: str, bucket: str):
        if boto3 is None:
            sys.exit("ERROR: boto3 not installed — `pip install boto3` before using --execute")
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


def process_entry(
    *,
    entry: dict,
    source_root: Path,
    r2: Optional[R2Client],
    tenant_id: str,
    competition_id: str,
    ffmpeg: str,
    dry_run: bool,
) -> dict:
    """
    Process a single entry. Returns a result dict:
      { entryId, entryNumber, ok, reason?, keyframesUploaded, r2Keys }
    """
    entry_id = entry["id"]
    entry_number = str(entry.get("entryNumber", "?"))
    result = {
        "entryId": entry_id,
        "entryNumber": entry_number,
        "ok": False,
        "reason": None,
        "keyframesUploaded": 0,
        "r2Keys": [],
    }

    mkv = find_mkv_for_entry(source_root, entry_number)
    if not mkv:
        result["reason"] = "no-mkv-found"
        return result

    r2_keys = [
        f"{tenant_id}/{competition_id}/{entry_id}/videos/keyframes/keyframe_{i}.webp"
        for i in range(3)
    ]
    result["r2Keys"] = r2_keys

    # Idempotence: if all 3 keyframes already exist in R2, skip entirely.
    if r2 is not None:
        try:
            if all(r2.head(k) for k in r2_keys):
                result["ok"] = True
                result["reason"] = "already-present"
                return result
        except Exception as e:
            # HEAD failure is non-terminal — fall through to extract + put.
            print(f"  [warn] R{entry_number}: HEAD failed ({e}); proceeding with extract+put")

    duration = probe_duration_seconds(ffmpeg, mkv)
    if duration < 3:
        result["reason"] = f"video-too-short ({duration:.1f}s)"
        return result

    with tempfile.TemporaryDirectory(prefix="kf-backfill-") as tmpdir:
        tmp = Path(tmpdir)
        success_count = 0
        keyframe_paths = []
        for i, pct in enumerate(KEYFRAME_PERCENTAGES):
            out_path = tmp / f"keyframe_{i}.webp"
            seek = duration * pct
            if extract_keyframe(ffmpeg, mkv, seek, out_path):
                keyframe_paths.append(out_path)
                success_count += 1
            else:
                keyframe_paths.append(None)
        if success_count == 0:
            result["reason"] = "extract-all-failed"
            return result

        # Upload (or pretend to, in dry-run)
        for i, p in enumerate(keyframe_paths):
            if p is None:
                continue
            key = r2_keys[i]
            if dry_run:
                result["keyframesUploaded"] += 1
                continue
            try:
                if r2 and r2.head(key):
                    # already uploaded by a prior run
                    result["keyframesUploaded"] += 1
                    continue
            except Exception:
                pass
            try:
                body = p.read_bytes()
                if r2:
                    r2.put(key, body, "image/webp")
                result["keyframesUploaded"] += 1
            except Exception as e:
                print(f"  [err] R{entry_number} keyframe {i}: PUT failed ({e})")

    if result["keyframesUploaded"] > 0:
        result["ok"] = True
    return result


def load_schedule(api_base: str, api_key: str, competition_id: str) -> list[dict]:
    """Fetch schedule via /api/plugin/schedule/<competitionId>."""
    import urllib.request
    url = f"{api_base.rstrip('/')}/api/plugin/schedule/{competition_id}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data.get("routines", []) or data.get("entries", []) or []


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill video keyframes for CompPortal's Gemini validator")
    ap.add_argument("--source-root", required=True, help="Local folder containing routine MKVs (e.g. TesterOutput/UDC London 2026)")
    ap.add_argument("--env-file", default=None, help="Env file with R2_*, compsync API creds")
    ap.add_argument("--api-base", default="https://udc.compsync.net", help="CompPortal API base URL")
    ap.add_argument("--api-key", default=None, help="Plugin API key (csm_...); falls back to COMPSYNC_PLUGIN_KEY env")
    ap.add_argument("--competition-id", default=DEFAULT_COMP)
    ap.add_argument("--tenant-id", default=DEFAULT_TENANT)
    ap.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg binary path (default: PATH)")
    ap.add_argument("--dry-run", action="store_true", help="Don't upload, just print what would happen")
    ap.add_argument("--execute", action="store_true", help="Opposite of --dry-run; required for real writes")
    ap.add_argument("--limit", type=int, default=0, help="Max routines to process (0 = all)")
    ap.add_argument("--skip", type=int, default=0, help="Skip first N routines (for sharding parallel workers)")
    ap.add_argument("--output", default=None, help="Manifest output path (default: /tmp/keyframe-backfill-<comp>-<ts>.json)")
    args = ap.parse_args()

    if not args.execute and not args.dry_run:
        print("Neither --execute nor --dry-run set; defaulting to --dry-run (no writes).")
        args.dry_run = True

    source_root = Path(args.source_root)
    if not source_root.is_dir():
        sys.exit(f"ERROR: source-root not found: {source_root}")

    env: dict[str, str] = {}
    if args.env_file:
        env = load_env_file(Path(args.env_file))

    api_key = args.api_key or get_env(env, "COMPSYNC_PLUGIN_KEY")
    if not api_key:
        sys.exit("ERROR: plugin API key required (--api-key or COMPSYNC_PLUGIN_KEY env)")

    # Fetch the schedule
    print(f"Fetching schedule from {args.api_base} for competition {args.competition_id}")
    try:
        routines = load_schedule(args.api_base, api_key, args.competition_id)
    except Exception as e:
        sys.exit(f"ERROR: schedule fetch failed: {e}")
    print(f"  → {len(routines)} routines")

    # Only process entries with recorded videos (schedule doesn't tell us — we
    # detect via folder existence in source_root).
    targets: list[dict] = []
    for r in routines:
        entry_number = str(r.get("entryNumber") or r.get("entry_number") or "")
        if not entry_number:
            continue
        folder = source_root / entry_number
        if not folder.is_dir():
            continue
        targets.append(r)
    print(f"  → {len(targets)} have local MKV folders")

    if args.skip > 0:
        targets = targets[args.skip:]
        print(f"  → skip={args.skip} → {len(targets)} remaining")
    if args.limit > 0:
        targets = targets[: args.limit]
        print(f"  → limit={args.limit} → processing {len(targets)}")

    r2: Optional[R2Client] = None
    if args.execute:
        r2 = R2Client(
            endpoint=get_env(env, "R2_ENDPOINT", required=True),  # type: ignore[arg-type]
            access_key=get_env(env, "R2_ACCESS_KEY_ID", required=True),  # type: ignore[arg-type]
            secret_key=get_env(env, "R2_SECRET_ACCESS_KEY", required=True),  # type: ignore[arg-type]
            bucket=get_env(env, "R2_BUCKET_NAME", DEFAULT_R2_BUCKET) or DEFAULT_R2_BUCKET,
        )

    # Process.
    started = time.time()
    results: list[dict] = []
    for idx, r in enumerate(targets):
        en = str(r.get("entryNumber") or r.get("entry_number") or "?")
        print(f"[{idx + 1}/{len(targets)}] R{en} ({r.get('id','?')[:8]}) ... ", end="", flush=True)
        try:
            res = process_entry(
                entry=r,
                source_root=source_root,
                r2=r2,
                tenant_id=args.tenant_id,
                competition_id=args.competition_id,
                ffmpeg=args.ffmpeg,
                dry_run=args.dry_run,
            )
            status = "ok" if res["ok"] else "SKIP"
            print(f"{status} ({res['keyframesUploaded']}/3 keyframes, reason={res['reason']})")
            results.append(res)
        except Exception as e:
            print(f"ERR {e}")
            results.append({
                "entryId": r.get("id"),
                "entryNumber": en,
                "ok": False,
                "reason": f"exception: {e}",
                "keyframesUploaded": 0,
                "r2Keys": [],
            })

    elapsed = time.time() - started
    ok_count = sum(1 for r in results if r["ok"])
    print()
    print(f"Done in {elapsed:.1f}s — {ok_count}/{len(results)} routines have keyframes in R2")

    # Write manifest
    out_path = Path(args.output) if args.output else Path(f"/tmp/keyframe-backfill-{args.competition_id}-{int(time.time())}.json")
    manifest = {
        "competitionId": args.competition_id,
        "tenantId": args.tenant_id,
        "runStartedAt": datetime.fromtimestamp(started, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "runFinishedAt": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "dryRun": args.dry_run,
        "totalTargets": len(results),
        "okCount": ok_count,
        "results": results,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=2))
    print(f"Manifest written: {out_path}")

    return 0 if ok_count == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
