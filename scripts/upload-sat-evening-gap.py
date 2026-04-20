#!/usr/bin/env python3
"""
upload-sat-evening-gap.py — surgical uploader for the Sat 2026-04-18
21:01-21:25 EDT show gap.

Background: After the UDC London 2026 Saturday evening, DB has photos up
through Sat 21:01:26 EDT (R500 tail), then nothing until Sun 08:30 EDT
(R510 start). Routines R502-R509 ran in that 23-minute gap and have
photo_count=0.

The missing photos live on DART's D:\ SD in the P23 body (which took
over at Sat 21:02 when P22's counter maxed out at P2299999). Filenames
P2300001.JPG through P2311973.JPG, mtime Sat 21:02:59 -> Sat 21:24:56 EDT.
1,973 files total.

This script runs ON DART (where D:\ is local + Python 3.13 + PIL + requests
are available). Walks D:\DCIM\*P23*\*.JPG, filters to the gap window, reads
EXIF DateTimeOriginal per file, matches each photo to its R502-R509 window,
uploads via CompPortal /api/plugin/upload-url + PUT + /api/plugin/complete.

Idempotent via plugin/complete UPSERT. Safe to re-run.

Usage (on DART shell):
    python upload-sat-evening-gap.py --execute
    python upload-sat-evening-gap.py --execute --workers 6
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from PIL import Image, ExifTags


API_BASE = 'https://udc.compsync.net'
COMPETITION_ID = '6f29f048-61f2-48c2-982f-27b542f974b2'
API_KEY = os.environ.get('COMPSYNC_PLUGIN_KEY') or 'csm_f68ddeef15d7bbe8e57fa3e0606dc475ee5dc56e6249803c'

# Eastern time (-4 hours UTC offset during EDT)
EDT = timezone(timedelta(hours=-4))

# Window of photos we care about: Sat 21:01:00 EDT -> Sun 08:30:00 EDT
GAP_START = datetime(2026, 4, 18, 21, 1, 0, tzinfo=EDT)
GAP_END   = datetime(2026, 4, 19, 8, 30, 0, tzinfo=EDT)

# Routine windows (R502-R509) — pulled from media_packages 2026-04-19 21:04 EDT.
# R501 has no media_packages row (never recorded). Photos are matched to
# these windows via EXIF captured_at with a 30s buffer; outside all
# windows -> assigned to the nearest-routine by min distance.
ROUTINES = [
    {'n': 502, 'entry_id': '5e090836-ebb1-4d9c-9556-05ff9b1f0aec',
     'start': datetime(2026, 4, 18, 21,  1, 44, 626000, tzinfo=EDT),
     'end':   datetime(2026, 4, 18, 21,  4, 12,  79000, tzinfo=EDT)},
    {'n': 503, 'entry_id': '1f284b48-8ad6-45f7-ada3-7a69043f28f6',
     'start': datetime(2026, 4, 18, 21,  4, 16, 587000, tzinfo=EDT),
     'end':   datetime(2026, 4, 18, 21,  6, 43,  59000, tzinfo=EDT)},
    {'n': 504, 'entry_id': '638183af-5c19-4fbc-a86a-d760381cf851',
     'start': datetime(2026, 4, 18, 21,  6, 47, 535000, tzinfo=EDT),
     'end':   datetime(2026, 4, 18, 21,  9, 20, 860000, tzinfo=EDT)},
    {'n': 505, 'entry_id': '68517e49-e353-4639-b637-0d5ba1f7aab3',
     'start': datetime(2026, 4, 18, 21,  9, 25, 367000, tzinfo=EDT),
     'end':   datetime(2026, 4, 18, 21, 11, 49, 397000, tzinfo=EDT)},
    {'n': 506, 'entry_id': '02e918ae-92f7-4927-8654-8b9e2ae557b3',
     'start': datetime(2026, 4, 18, 21, 11, 53, 874000, tzinfo=EDT),
     'end':   datetime(2026, 4, 18, 21, 14, 59,  59000, tzinfo=EDT)},
    {'n': 507, 'entry_id': 'b8ed3c75-c7b4-437d-bfde-c91e8529d5a5',
     'start': datetime(2026, 4, 18, 21, 15,  3, 585000, tzinfo=EDT),
     'end':   datetime(2026, 4, 18, 21, 17, 36, 644000, tzinfo=EDT)},
    {'n': 508, 'entry_id': 'd0b3fa5a-22c8-4b58-8906-1eae2b7c89c1',
     'start': datetime(2026, 4, 18, 21, 17, 41, 145000, tzinfo=EDT),
     'end':   datetime(2026, 4, 18, 21, 20, 58, 612000, tzinfo=EDT)},
    {'n': 509, 'entry_id': 'da4e90d8-aae9-470b-a820-49e78bae7ab0',
     'start': datetime(2026, 4, 18, 21, 21,  3, 110000, tzinfo=EDT),
     'end':   datetime(2026, 4, 18, 21, 25,  1, 569000, tzinfo=EDT)},
]

BUFFER_SEC = 30


def read_exif_datetime(path: Path) -> datetime | None:
    """Return EXIF DateTimeOriginal (assumed camera local = EDT) or None."""
    try:
        with Image.open(path) as img:
            exif = img._getexif()
            if not exif:
                return None
            for tag_id, val in exif.items():
                tag = ExifTags.TAGS.get(tag_id)
                if tag == 'DateTimeOriginal':
                    # EXIF format: 'YYYY:MM:DD HH:MM:SS'
                    dt = datetime.strptime(val, '%Y:%m:%d %H:%M:%S')
                    return dt.replace(tzinfo=EDT)
            return None
    except Exception:
        return None


def match_to_routine(captured_at: datetime) -> dict | None:
    """Exact match within routine window + 30s buffer; else nearest routine."""
    ts = captured_at.timestamp()
    for r in ROUTINES:
        if r['start'].timestamp() - BUFFER_SEC <= ts <= r['end'].timestamp() + BUFFER_SEC:
            return r
    # Nearest-window fallback
    best = None
    best_dist = float('inf')
    for r in ROUTINES:
        d = min(abs(ts - r['start'].timestamp()), abs(ts - r['end'].timestamp()))
        if d < best_dist:
            best_dist = d
            best = r
    return best


def make_thumb_webp(path: Path) -> bytes:
    with Image.open(path) as img:
        img = img.convert('RGB')
        # Rotate by EXIF orientation if present (PIL's built-in helper)
        try:
            from PIL import ImageOps
            img = ImageOps.exif_transpose(img)
        except Exception:
            pass
        # Cover fit to 200x200
        w, h = img.size
        if w < h:
            new_w, new_h = 200, int(h * 200 / w)
        else:
            new_w, new_h = int(w * 200 / h), 200
        img = img.resize((new_w, new_h), Image.LANCZOS)
        # Center-crop to 200x200
        left = (new_w - 200) // 2
        top = (new_h - 200) // 2
        img = img.crop((left, top, left + 200, top + 200))
        out = io.BytesIO()
        img.save(out, 'WEBP', quality=80)
        return out.getvalue()


def get_upload_url(sess: requests.Session, entry_id: str, filename: str, content_type: str, retries: int = 3) -> tuple[str, str]:
    last_err = None
    for attempt in range(retries):
        try:
            resp = sess.post(
                f'{API_BASE}/api/plugin/upload-url',
                headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {API_KEY}'},
                json={
                    'entryId': entry_id,
                    'competitionId': COMPETITION_ID,
                    'type': 'photos',
                    'filename': filename,
                    'contentType': content_type,
                    'uploadRunId': RUN_ID,
                },
                timeout=120,
            )
            if resp.status_code == 500 and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            resp.raise_for_status()
            d = resp.json()
            return d['signedUrl'], d['storagePath']
        except (requests.Timeout, requests.ConnectionError) as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
    raise RuntimeError(f'upload-url failed after {retries} tries: {last_err}')


def put_bytes(sess: requests.Session, signed_url: str, body: bytes, content_type: str) -> None:
    resp = sess.put(
        signed_url, data=body,
        headers={'Content-Type': content_type, 'Content-Length': str(len(body))},
        timeout=max(300, len(body) // 100_000),
    )
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f'PUT {resp.status_code}: {resp.text[:200]}')


def upload_one(sess: requests.Session, photo: dict) -> dict:
    path = photo['path']
    entry_id = photo['entry_id']
    filename = path.name
    result = {'photo': None, 'thumb': None, 'captured_at': photo['captured_at'], 'error': None, 'routine_n': photo['routine_n']}

    try:
        body = path.read_bytes()
        signed, storage_path = get_upload_url(sess, entry_id, filename, 'image/jpeg')
        put_bytes(sess, signed, body, 'image/jpeg')
        result['photo'] = storage_path
    except Exception as e:
        result['error'] = f'photo {filename}: {e}'
        return result

    try:
        thumb_bytes = make_thumb_webp(path)
        thumb_name = f'{path.stem}_thumb.webp'
        signed_t, thumb_path_storage = get_upload_url(sess, entry_id, thumb_name, 'image/webp')
        put_bytes(sess, signed_t, thumb_bytes, 'image/webp')
        result['thumb'] = thumb_path_storage
    except Exception as e:
        result['error'] = f'thumb {filename}: {e}'

    return result


def call_complete(sess: requests.Session, entry_id: str, photo_paths: list[str], thumb_paths: list[str], captured_at: list[str]) -> None:
    body = {
        'entryId': entry_id,
        'competitionId': COMPETITION_ID,
        'uploadRunId': RUN_ID,
        'files': {
            'photos': photo_paths,
            'photo_thumbnails': thumb_paths,
            'photo_captured_at': captured_at,
        },
    }
    resp = sess.post(
        f'{API_BASE}/api/plugin/complete',
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {API_KEY}'},
        json=body,
        timeout=120,
    )
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f'plugin/complete {resp.status_code}: {resp.text[:400]}')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--execute', action='store_true')
    p.add_argument('--workers', type=int, default=6)
    p.add_argument('--limit', type=int, help='Debug: cap photos')
    p.add_argument('--dcim', default='D:\\DCIM', help='DCIM root on DART')
    args = p.parse_args()

    global RUN_ID
    RUN_ID = f'sat-gap-recovery-{int(time.time())}'

    print(f'[{"EXECUTE" if args.execute else "DRY-RUN"} workers={args.workers}] run_id={RUN_ID}')
    print(f'Scanning {args.dcim} for P23 photos in Sat 21:01 -> Sun 08:30 EDT window...')

    # Walk DCIM for P23 JPGs with mtime in gap window
    dcim_root = Path(args.dcim)
    all_photos = []
    for root, dirs, files in os.walk(dcim_root):
        for f in files:
            if not f.upper().startswith('P23'):
                continue
            if not f.upper().endswith(('.JPG', '.JPEG')):
                continue
            fp = Path(root) / f
            try:
                mtime = datetime.fromtimestamp(fp.stat().st_mtime, tz=EDT)
            except Exception:
                continue
            if not (GAP_START <= mtime < GAP_END):
                continue
            all_photos.append({'path': fp, 'mtime': mtime})

    all_photos.sort(key=lambda p: p['path'].name)
    print(f'Found {len(all_photos)} P23 photos in gap window')

    if args.limit:
        all_photos = all_photos[:args.limit]
        print(f'Capped to {len(all_photos)} for debug')

    # Read EXIF + assign to routines
    print('Reading EXIF + assigning routines...')
    t0 = time.time()
    to_upload = []
    by_routine: dict[int, list[dict]] = {}
    for i, photo in enumerate(all_photos):
        exif_dt = read_exif_datetime(photo['path'])
        captured_at = exif_dt or photo['mtime']
        routine = match_to_routine(captured_at)
        if not routine:
            continue
        entry = {
            'path': photo['path'],
            'entry_id': routine['entry_id'],
            'routine_n': routine['n'],
            'captured_at': captured_at.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }
        to_upload.append(entry)
        by_routine.setdefault(routine['n'], []).append(entry)
        if (i + 1) % 500 == 0:
            print(f'  EXIF-read {i+1}/{len(all_photos)}  ({time.time()-t0:.0f}s)')

    print(f'Assigned {len(to_upload)} photos across routines: {sorted(by_routine.keys())}')
    for rn, items in sorted(by_routine.items()):
        print(f'  R{rn}: {len(items)} photos')

    if not args.execute:
        print('[DRY-RUN] not uploading. Pass --execute to proceed.')
        return 0

    # Upload all photos in parallel
    print(f'\nUploading {len(to_upload)} photos with {args.workers} workers...')
    results_by_routine: dict[int, list[dict]] = {rn: [] for rn in by_routine}
    errors = []
    sess_factory = lambda: requests.Session()
    started = time.time()
    done_count = 0

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(upload_one, sess_factory(), entry): entry for entry in to_upload}
        for fut in as_completed(futures):
            entry = futures[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {'photo': None, 'thumb': None, 'error': str(e), 'captured_at': entry['captured_at'], 'routine_n': entry['routine_n']}
            if r.get('error'):
                errors.append(r['error'])
            if r.get('photo'):
                results_by_routine[entry['routine_n']].append(r)
            done_count += 1
            if done_count % 50 == 0 or done_count == len(to_upload):
                elapsed = time.time() - started
                rate = done_count / elapsed if elapsed > 0 else 0
                print(f'  uploaded {done_count}/{len(to_upload)}  ({rate:.1f}/s, ETA {(len(to_upload)-done_count)/max(rate,0.01):.0f}s)')

    # Call plugin/complete per routine
    print('\nCalling plugin/complete per routine...')
    sess = requests.Session()
    for rn, results in results_by_routine.items():
        if not results:
            print(f'  R{rn}: 0 successful photos, skipping')
            continue
        entry_id = next(r['entry_id'] for r in ROUTINES if r['n'] == rn)
        photos = [r['photo'] for r in results]
        thumbs = [r.get('thumb') or '' for r in results]
        captured = [r['captured_at'] for r in results]
        try:
            call_complete(sess, entry_id, photos, thumbs, captured)
            print(f'  R{rn}: complete OK ({len(photos)} photos)')
        except Exception as e:
            print(f'  R{rn}: complete FAILED: {e}')
            errors.append(f'R{rn} complete: {e}')

    print(f'\nDone in {time.time()-started:.0f}s. Uploaded {sum(len(v) for v in results_by_routine.values())}/{len(to_upload)}. Errors: {len(errors)}')
    for e in errors[:5]:
        print(f'  err: {e}')
    return 0 if not errors else 1


if __name__ == '__main__':
    sys.exit(main())
