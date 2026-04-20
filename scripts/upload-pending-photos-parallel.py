#!/usr/bin/env python3
"""
upload-pending-photos-parallel.py — parallelized version of
upload-pending-photos.py. Uploads N photos concurrently per routine via
ThreadPoolExecutor. Gets upload URLs + PUTs in parallel; plugin/complete
still serial per routine (called after all photos done).

Same semantics as the serial script — idempotent against existing DB rows
(plugin/complete UPSERTs). Safe to run over a partially-completed routine.

Usage
-----
    python3 upload-pending-photos-parallel.py --execute [--entry N] [--workers 8]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import requests

STATE_FILE = Path("/tmp/cse-upload-recovery/state.json")
SSHFS_ROOT = Path("/tmp/dart-to")
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
    win_path = win_path.replace("\\", "/")
    marker = "/TesterOutput/"
    idx = win_path.find(marker)
    if idx == -1:
        raise RuntimeError(f"Bad path: {win_path}")
    return SSHFS_ROOT / win_path[idx + len(marker):]


def get_upload_url(session: requests.Session, api_key: str, entry_id: str, filename: str, content_type: str, type_: str, run_id: str) -> tuple[str, str]:
    resp = session.post(
        f"{API_BASE}/api/plugin/upload-url",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        json={
            "entryId": entry_id, "competitionId": COMPETITION_ID, "type": type_,
            "filename": filename, "contentType": content_type, "uploadRunId": run_id,
        },
        timeout=30,
    )
    resp.raise_for_status()
    d = resp.json()
    return d["signedUrl"], d["storagePath"]


def put_file(session: requests.Session, signed_url: str, file_path: Path, content_type: str) -> None:
    body = file_path.read_bytes()
    resp = session.put(
        signed_url, data=body,
        headers={"Content-Type": content_type, "Content-Length": str(len(body))},
        timeout=max(300, len(body) // 100_000),
    )
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f"PUT {resp.status_code}: {resp.text[:200]}")


def upload_one_photo(session: requests.Session, api_key: str, entry_id: str, photo: dict[str, Any], run_id: str) -> dict[str, Any]:
    local_win = photo["filePath"]
    local = windows_to_sshfs(local_win)
    thumb_win = photo.get("thumbnailPath")
    thumb_local = windows_to_sshfs(thumb_win) if thumb_win else None
    filename = local.name
    capture_iso = photo.get("captureTime") or ""
    result: dict[str, Any] = {"photo_storage_path": "", "thumb_storage_path": "", "captured_at": capture_iso, "error": None}

    if not local.exists():
        result["error"] = f"missing: {local}"
        return result

    try:
        signed, storage_path = get_upload_url(session, api_key, entry_id, filename, "image/jpeg", "photos", run_id)
        put_file(session, signed, local, "image/jpeg")
        result["photo_storage_path"] = storage_path
    except Exception as e:
        result["error"] = f"photo {filename}: {e}"
        return result

    if thumb_local and thumb_local.exists():
        try:
            thumb_filename = f"{local.stem}_thumb.webp"
            signed_t, thumb_storage_path = get_upload_url(session, api_key, entry_id, thumb_filename, "image/webp", "photos", run_id)
            put_file(session, signed_t, thumb_local, "image/webp")
            result["thumb_storage_path"] = thumb_storage_path
        except Exception as e:
            result["error"] = f"thumb {filename}: {e}"
            # non-fatal; photo still landed
    return result


def call_plugin_complete(session: requests.Session, api_key: str, entry_id: str, run_id: str,
                         photo_paths: list[str], thumb_paths: list[str], captured_at: list[str]) -> None:
    body = {
        "entryId": entry_id, "competitionId": COMPETITION_ID, "uploadRunId": run_id,
        "files": {"photos": photo_paths, "photo_thumbnails": thumb_paths, "photo_captured_at": captured_at},
    }
    resp = session.post(
        f"{API_BASE}/api/plugin/complete",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        json=body, timeout=90,
    )
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f"plugin/complete {resp.status_code}: {resp.text[:400]}")


def process_routine(routine: dict[str, Any], api_key: str, run_id: str, workers: int) -> dict[str, Any]:
    entry_num = routine.get("entryNumber")
    entry_id = routine["id"]
    photos = [p for p in (routine.get("photos") or []) if not p.get("uploaded")]

    # Stable indexed results so the final plugin/complete payload preserves order
    results: list[dict[str, Any]] = [{}] * len(photos)
    errors: list[str] = []

    session = requests.Session()
    done_count = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(upload_one_photo, session, api_key, entry_id, photo, run_id): i for i, photo in enumerate(photos)}
        for fut in as_completed(futures):
            i = futures[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {"photo_storage_path": "", "thumb_storage_path": "", "captured_at": "", "error": f"worker: {e}"}
            results[i] = r
            if r.get("error"):
                errors.append(r["error"])
            done_count += 1
            if done_count % 20 == 0 or done_count == len(photos):
                elapsed = time.time() - t0
                rate = done_count / elapsed if elapsed > 0 else 0
                print(f"  R{entry_num}: {done_count}/{len(photos)} done ({rate:.1f}/s, {elapsed:.0f}s elapsed)", flush=True)

    # Build parallel arrays in original order
    photo_paths = [r.get("photo_storage_path", "") for r in results]
    thumb_paths = [r.get("thumb_storage_path", "") for r in results]
    captured_at = [r.get("captured_at", "") for r in results]

    # Filter to successful uploads for plugin/complete
    valid_indices = [i for i, p in enumerate(photo_paths) if p]
    photo_paths_ok = [photo_paths[i] for i in valid_indices]
    thumb_paths_ok = [thumb_paths[i] for i in valid_indices]
    captured_at_ok = [captured_at[i] for i in valid_indices]

    if photo_paths_ok:
        try:
            call_plugin_complete(session, api_key, entry_id, run_id, photo_paths_ok, thumb_paths_ok, captured_at_ok)
        except Exception as e:
            errors.append(f"plugin/complete: {e}")

    return {
        "entry": entry_num,
        "total_pending": len(photos),
        "uploaded": len(photo_paths_ok),
        "thumbs_uploaded": sum(1 for t in thumb_paths_ok if t),
        "skipped": sum(1 for r in results if r.get("error") and not r.get("photo_storage_path")),
        "errors": errors,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--execute", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--entry", type=int)
    p.add_argument("--entry-min", type=float, help="Only process entry_number >= this")
    p.add_argument("--state", default=str(STATE_FILE))
    p.add_argument("--workers", type=int, default=6, help="Concurrent uploads per routine (default 6)")
    args = p.parse_args()

    dry_run = not args.execute
    if dry_run:
        print("DRY-RUN mode not supported in parallel script (skipping is redundant). Re-run with --execute.")
        return 2

    env = load_env()
    api_key = env["COMPSYNC_PLUGIN_KEY"]

    state = json.loads(Path(args.state).read_text())
    all_routines = state.get("competition", {}).get("routines", [])

    pending = []
    for r in all_routines:
        en = r.get("entryNumber")
        if args.entry is not None and en != args.entry and str(en) != str(args.entry):
            continue
        if args.entry_min is not None:
            try:
                en_num = float(en) if en is not None else None
            except (TypeError, ValueError):
                en_num = None
            if en_num is None or en_num < args.entry_min:
                continue
        unup = [p for p in (r.get("photos") or []) if not p.get("uploaded")]
        if unup:
            pending.append(r)

    total_photos = sum(len([p for p in r.get("photos") or [] if not p.get("uploaded")]) for r in pending)
    print(f"[EXECUTE workers={args.workers}] routines={len(pending)} total unuploaded photos={total_photos}")
    print(f"         api_base={API_BASE} comp={COMPETITION_ID}")

    run_id = f"recovery-parallel-{int(time.time())}"
    print(f"         run_id={run_id}")
    print()

    started = time.time()
    summary = []
    for r in pending:
        entry_num = r.get("entryNumber")
        unup_count = len([p for p in r.get("photos") or [] if not p.get("uploaded")])
        print(f"--- R{entry_num}: {unup_count} photos pending ---", flush=True)
        result = process_routine(r, api_key, run_id, args.workers)
        summary.append(result)
        overall_rate = sum(s["uploaded"] for s in summary) / max(1, time.time() - started)
        print(f"  R{entry_num}: uploaded {result['uploaded']}/{result['total_pending']} thumbs {result['thumbs_uploaded']} errors {len(result['errors'])}  [overall: {overall_rate*60:.1f}/min]", flush=True)
        if result["errors"]:
            for e in result["errors"][:2]:
                print(f"    err: {e}", flush=True)

    elapsed = time.time() - started
    total_up = sum(s["uploaded"] for s in summary)
    total_err = sum(len(s["errors"]) for s in summary)
    print()
    print(f"Done in {elapsed:.1f}s — {total_up}/{total_photos} photos uploaded ({total_up/elapsed*60:.1f}/min), {total_err} errors")
    return 0 if total_err == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
