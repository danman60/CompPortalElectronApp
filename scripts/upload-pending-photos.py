#!/usr/bin/env python3
"""
upload-pending-photos.py — resume photo upload backlog via plugin API.

When the Electron app is restarted mid-drain, the in-memory upload job queue
is lost but photos persist on local disk with `uploaded:false` in
compsync-state.json. UPLOAD_ALL in-app has a filter that misses some of
these (the 2026-04-19 incident: 33 routines / 4,000 photos stranded). This
script bypasses the app entirely — reads state.json, enumerates pending
photos, and uploads via the same /api/plugin/upload-url + /api/plugin/complete
endpoints the app uses.

Running on SpyBalloon via SSHFS-mounted DART paths (/tmp/dart-to/...).

Usage
-----
    # Smoke (no writes)
    python3 upload-pending-photos.py --dry-run

    # Target one routine
    python3 upload-pending-photos.py --dry-run --entry 291

    # Real run
    python3 upload-pending-photos.py --execute

    # Real run scoped to one routine (SAFE first test)
    python3 upload-pending-photos.py --execute --entry 291
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests

# Defaults — UDC London 2026
STATE_FILE = Path("/tmp/cse-upload-recovery/state.json")
SSHFS_ROOT = Path("/tmp/dart-to")  # SSHFS-mounted DART TesterOutput
API_BASE = "https://udc.compsync.net"
ENV_FILE = Path("/tmp/env.compsync-r2")
COMPETITION_ID = "6f29f048-61f2-48c2-982f-27b542f974b2"


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def windows_to_sshfs(win_path: str) -> Path:
    """Convert a DART Windows path to the SSHFS mount equivalent.
    'C:\\Users\\User\\OneDrive\\Desktop\\TesterOutput\\UDC London 2026\\291\\photos\\photo_1.jpg'
    → /tmp/dart-to/UDC London 2026/291/photos/photo_1.jpg
    """
    win_path = win_path.replace("\\", "/")
    marker = "/TesterOutput/"
    idx = win_path.find(marker)
    if idx == -1:
        raise RuntimeError(f"Can't normalize path (no TesterOutput segment): {win_path}")
    tail = win_path[idx + len(marker):]
    return SSHFS_ROOT / tail


def get_upload_url(api_key: str, entry_id: str, filename: str, content_type: str, type_: str, run_id: str) -> tuple[str, str]:
    resp = requests.post(
        f"{API_BASE}/api/plugin/upload-url",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        json={
            "entryId": entry_id,
            "competitionId": COMPETITION_ID,
            "type": type_,
            "filename": filename,
            "contentType": content_type,
            "uploadRunId": run_id,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["signedUrl"], data["storagePath"]


def put_file(signed_url: str, file_path: Path, content_type: str) -> None:
    with file_path.open("rb") as f:
        body = f.read()
    resp = requests.put(
        signed_url,
        data=body,
        headers={"Content-Type": content_type, "Content-Length": str(len(body))},
        timeout=max(300, len(body) // 100_000),
    )
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f"PUT failed: {resp.status_code} {resp.text[:200]}")


def call_plugin_complete(
    api_key: str,
    entry_id: str,
    run_id: str,
    photo_paths: list[str],
    thumb_paths: list[str],
    captured_at: list[str],
) -> None:
    body = {
        "entryId": entry_id,
        "competitionId": COMPETITION_ID,
        "uploadRunId": run_id,
        "files": {
            "photos": photo_paths,
            "photo_thumbnails": thumb_paths,
            "photo_captured_at": captured_at,
        },
    }
    resp = requests.post(
        f"{API_BASE}/api/plugin/complete",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        json=body,
        timeout=60,
    )
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f"plugin/complete failed: {resp.status_code} {resp.text[:400]}")


def process_routine(routine: dict[str, Any], api_key: str, dry_run: bool, run_id: str) -> dict[str, Any]:
    entry_num = routine.get("entryNumber")
    entry_id = routine["id"]
    photos = [p for p in (routine.get("photos") or []) if not p.get("uploaded")]

    uploaded_photo_paths: list[str] = []
    uploaded_thumb_paths: list[str] = []
    captured_at_list: list[str] = []
    errors: list[str] = []
    skipped = 0

    for i, photo in enumerate(photos):
        local_win = photo["filePath"]
        local = windows_to_sshfs(local_win)
        thumb_win = photo.get("thumbnailPath")
        thumb_local = windows_to_sshfs(thumb_win) if thumb_win else None

        if not local.exists():
            errors.append(f"missing source: {local}")
            skipped += 1
            continue

        filename = local.name
        capture_iso = photo.get("captureTime") or ""

        if dry_run:
            uploaded_photo_paths.append(f"DRY-{entry_id}/photos/{filename}")
            uploaded_thumb_paths.append(
                f"DRY-{entry_id}/photos/{local.stem}_thumb.webp" if (thumb_local and thumb_local.exists()) else ""
            )
            captured_at_list.append(capture_iso)
            continue

        try:
            signed, storage_path = get_upload_url(api_key, entry_id, filename, "image/jpeg", "photos", run_id)
            put_file(signed, local, "image/jpeg")
            uploaded_photo_paths.append(storage_path)
        except Exception as e:
            errors.append(f"photo {filename}: {e}")
            skipped += 1
            continue

        thumb_storage_path = ""
        if thumb_local and thumb_local.exists():
            try:
                thumb_filename = f"{local.stem}_thumb.webp"
                signed_t, thumb_storage_path = get_upload_url(api_key, entry_id, thumb_filename, "image/webp", "photos", run_id)
                put_file(signed_t, thumb_local, "image/webp")
            except Exception as e:
                errors.append(f"thumb {filename}: {e}")
                thumb_storage_path = ""
        uploaded_thumb_paths.append(thumb_storage_path)
        captured_at_list.append(capture_iso)

        if (i + 1) % 20 == 0:
            print(f"  R{entry_num}: {i+1}/{len(photos)} uploaded", flush=True)

    if not dry_run and uploaded_photo_paths:
        try:
            call_plugin_complete(
                api_key,
                entry_id,
                run_id,
                uploaded_photo_paths,
                uploaded_thumb_paths,
                captured_at_list,
            )
        except Exception as e:
            errors.append(f"plugin/complete: {e}")

    return {
        "entry": entry_num,
        "total_pending": len(photos),
        "uploaded": len(uploaded_photo_paths),
        "thumbs_uploaded": sum(1 for t in uploaded_thumb_paths if t),
        "skipped": skipped,
        "errors": errors,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--execute", action="store_true", help="Actually upload (default: dry-run)")
    p.add_argument("--dry-run", action="store_true", help="Force dry-run (default)")
    p.add_argument("--entry", type=int, help="Limit to this entry number")
    p.add_argument("--state", default=str(STATE_FILE), help="Path to compsync-state.json")
    p.add_argument("--limit-photos", type=int, help="Per-routine photo cap (debug)")
    args = p.parse_args()

    dry_run = not args.execute
    env = load_env()
    api_key = env["COMPSYNC_PLUGIN_KEY"]

    state = json.loads(Path(args.state).read_text())
    all_routines = state.get("competition", {}).get("routines", [])

    pending = []
    for r in all_routines:
        if args.entry is not None and r.get("entryNumber") != args.entry and str(r.get("entryNumber")) != str(args.entry):
            continue
        unup = [p for p in (r.get("photos") or []) if not p.get("uploaded")]
        if unup:
            if args.limit_photos:
                r = {**r, "photos": [p for p in (r.get("photos") or []) if not p.get("uploaded")][: args.limit_photos]}
                # mark all kept as unuploaded
                for p in r["photos"]:
                    p["uploaded"] = False
            pending.append(r)

    total_photos = sum(len([p for p in r.get("photos") or [] if not p.get("uploaded")]) for r in pending)
    mode = "DRY-RUN" if dry_run else "EXECUTE"
    print(f"[{mode}] routines={len(pending)} total unuploaded photos={total_photos}")
    print(f"         api_base={API_BASE} comp={COMPETITION_ID}")

    run_id = f"recovery-{int(time.time())}"
    print(f"         run_id={run_id}")
    print()

    started = time.time()
    summary = []
    for r in pending:
        entry_num = r.get("entryNumber")
        unup = [p for p in (r.get("photos") or []) if not p.get("uploaded")]
        print(f"--- R{entry_num}: {len(unup)} photos pending ---")
        result = process_routine(r, api_key, dry_run, run_id)
        summary.append(result)
        print(
            f"  R{entry_num}: uploaded {result['uploaded']}/{result['total_pending']}"
            f" thumbs {result['thumbs_uploaded']} skipped {result['skipped']} errors {len(result['errors'])}"
        )
        if result["errors"]:
            for e in result["errors"][:3]:
                print(f"    err: {e}")
            if len(result["errors"]) > 3:
                print(f"    ... +{len(result['errors']) - 3} more errors")

    elapsed = time.time() - started
    total_up = sum(s["uploaded"] for s in summary)
    total_err = sum(len(s["errors"]) for s in summary)
    print()
    print(f"Done in {elapsed:.1f}s — {total_up}/{total_photos} photos uploaded, {total_err} errors")
    if dry_run:
        print("(dry-run — no actual uploads or DB writes)")
    return 0 if total_err == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
