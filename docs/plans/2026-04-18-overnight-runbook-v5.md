# Overnight Import Runbook — v5

**When:** 2026-04-18 evening, after Saturday show closes.
**Purpose:** Apply Friday recovery AND process Saturday photos before tomorrow morning.
**Script:** `scripts/overnight-sd-import-v5.py`
**Operator:** approves every destructive step. No auto-execute.

## What changed from v4 (read before running)

- **EDT-aware EXIF matching** (v4 treated EXIF as UTC, off by 4h).
- **Video-window routines** from `media_packages.video_start_timestamp/end_timestamp` (v4 used scheduled times).
- **Camera-by-folder-prefix** classification (Friday Cam A = 101-110, Cam B = 166-189, ignore 224).
- **Filename-based Cam B correction split** at `H:168/P1687292.JPG`.
- **+/-5s window buffer.**
- **`photo_NNN__<original>.jpg`** naming (numeric + source-filename for forensic trail).
- **Per-photo manifest** JSON written to `imports/<run-id>.json`.
- **Day filter** via `--day YYYY-MM-DD` to scope to Fri OR Sat.
- **EXIF date sanity check** — warns/aborts if photos don't match expected day.
- **Separate `--purge-misassigned` mode** for the 846 wrong-entry rows from today.

## Pre-flight (required before ANY execute)

### 1. Environment
- `DATABASE_URL` set to CompPortal pooled Supabase URL (in `.env.production.local`):
  ```
  postgresql://postgres.cafugvuaatsgihrsmvvl:<pw>@aws-1-us-east-2.pooler.supabase.com:6543/postgres
  ```
- R2 creds are hard-coded in the script (account-level, matches MEMORY.md).
- Python 3.9+ with `psycopg2-binary boto3 Pillow exifread requests`.
- `OVERNIGHT_LOG_DIR` and `OVERNIGHT_MANIFEST_ROOT` set (Linux default = `./imports-logs/`, `./imports/`; Windows default = `C:\Users\User\logs`, `.\imports\`).

### 2. App / process state
- **CompSync Media.exe CLOSED.** No other import can race with this script.
- No prior v5 run alive (check `ps` / Task Manager).
- Free disk > 20 GB on the machine running the script.

### 3. Data state
- Confirm 207 Friday routines + 57 (or more) Saturday routines exist with video windows:
  ```sql
  SELECT DATE(video_start_timestamp AT TIME ZONE 'America/New_York') AS day,
         COUNT(*) FROM media_packages
  WHERE competition_id = '6f29f048-61f2-48c2-982f-27b542f974b2'
    AND deleted_at IS NULL AND video_start_timestamp IS NOT NULL
  GROUP BY day ORDER BY day;
  ```
- SDs physically present + readable. Run `dir F:\DCIM` and `dir H:\DCIM` on DART.

### 4. Confirm input source
- **Friday**: use pre-computed `/tmp/overnight-orphans-v4.json` from last night's v4 run (18,325 photos with EXIF). Do NOT rescan Friday SDs — the orphan JSON already has all needed EXIF + paths.
- **Saturday**: needs fresh SD scan. Plug F: and H: into DART, confirm `DCIM/` has new Saturday content, then use `--sd F:\ --sd H:\` in the script.

## Phase 1 — Friday recovery (expected ~20-30 min)

### 1.1 Dry-run
```bash
python scripts/overnight-sd-import-v5.py \
  --dry-run \
  --day 2026-04-17 \
  --from-orphan-json /tmp/overnight-orphans-v4.json
```

**Expected output:**
- `Loaded 18325 photos`
- `Loaded 207 routines for day 2026-04-17`
- `Loaded 15145 existing media_photos rows across competition`
- `Match stats: {'ignored_folder': 171, 'no_window': 218, 'matched_unique': 17936}`
- `Matched: 17936   Unmatched: 389`
- `Manifest written: .../v5-2026-04-17-<ts>.json (17936 entries)`
- `proposed_uploads: 17936, skipped_already_uploaded: 0`
- EXIF date sanity: `pass: True` (197/200 samples = 2026-04-17).

**Operator review:**
- Open the `-final.json` log; confirm `matched` ≈ 17936, `unmatched` ≈ 389.
- Per-routine counts: match manifest against `match-v3-summary.md` in fri-recovery.
- Eyeball 10 random entries in `imports/<run-id>.json` — confirm `target_entry_number` aligns with `real_utc_iso` and `source_folder`.

### 1.2 Execute Friday
```bash
python scripts/overnight-sd-import-v5.py \
  --execute \
  --day 2026-04-17 \
  --from-orphan-json /tmp/overnight-orphans-v4.json
```

**Watch for:**
- `errors` should be 0 or very low.
- `ok_routines` should approach 162.
- If any R2 head/put fails, script logs + continues; rerun will skip already-uploaded by new-format URL match.

### 1.3 Verify
SQL:
```sql
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE storage_url LIKE '%photo_%__%') AS v5_uploads
FROM media_photos ph JOIN media_packages mp ON ph.media_package_id = mp.id
WHERE mp.competition_id = '6f29f048-61f2-48c2-982f-27b542f974b2'
  AND ph.deleted_at IS NULL;
```
Expected: ~33,000 total (15,145 pre-existing + 17,936 v5).

Spot-check: download a random R2 `photo_NNN__P1011943.jpg` via signed URL — confirm it plays, EXIF matches the routine window.

## Phase 2 — Saturday processing (expected ~20-30 min)

### 2.1 Fresh SD scan (dry-run)
```bash
python scripts/overnight-sd-import-v5.py \
  --dry-run \
  --day 2026-04-18 \
  --sd F:\ --sd H:\
```

**Expected:**
- `Loaded N photos from [F:\, H:\]` — N depends on how much Saturday shot.
- EXIF date sanity: 80%+ of samples should bucket into `2026-04-18`. If < 30% you'll see a warning banner; investigate before executing (was a camera clock off?).
- `Loaded ~57 routines for day 2026-04-18` (more if the show added more by end of day).
- Match stats: mostly `matched_unique`, little `ignored_folder` (no 224 on Saturday unless you left Cam 2 in the kit).

### 2.2 Execute Saturday
```bash
python scripts/overnight-sd-import-v5.py \
  --execute \
  --day 2026-04-18 \
  --sd F:\ --sd H:\
```

### 2.3 Verify
- Spot-check 5 Saturday routines: SQL for each `entry_id`, confirm `photo_count > 0` and EXIF `captured_at` lands inside `video_start_timestamp/video_end_timestamp`.
- Open Media Portal for one studio dancer — confirm Saturday photos show up.

## Phase 3 — Cleanup misassigned rows (Friday) [OPTIONAL]

Only run if the 846 misassigned rows are causing confusion in Media Portal. They are R2-valid photos whose `media_photos` row points at the wrong entry — the photos ARE in R2 but the parent package is wrong. Soft-deleting these removes Media Portal clutter. R2 objects are untouched (recoverable later).

### 3.1 Dry-run
```bash
python scripts/overnight-sd-import-v5.py \
  --day 2026-04-17 \
  --purge-misassigned
```
Expected: `Misassigned rows detected: 846`.

### 3.2 Execute (requires explicit consent flag)
```bash
python scripts/overnight-sd-import-v5.py \
  --day 2026-04-17 \
  --purge-misassigned \
  --execute \
  --i-really-mean-it
```

### 3.3 Verify
```sql
SELECT COUNT(*) FROM media_photos ph
JOIN media_packages mp ON ph.media_package_id = mp.id
WHERE mp.competition_id = '6f29f048-61f2-48c2-982f-27b542f974b2'
  AND ph.deleted_at IS NULL
  AND split_part(ph.storage_url, '/', 3) <> mp.entry_id::text;
```
Expected: 0.

Rollback: `UPDATE media_photos SET deleted_at = NULL WHERE deleted_at >= NOW() - INTERVAL '1 hour' AND id IN (<ids from manifest>);` — manifest for purge runs written to `imports-logs/<run-id>-purge.json`.

## Rollback plan (if something is off)

### Rollback an execute run
- `imports/<run-id>.json` is the source of truth for what was uploaded. Every entry has `r2_photo_key`, `r2_thumb_key`, `target_entry_id`, `source_path`.
- To un-register (reverse /complete): there is no reverse API. Soft-delete via:
  ```sql
  UPDATE media_photos
  SET deleted_at = NOW()
  WHERE storage_url IN (<list of r2_photo_keys from manifest>);
  ```
- To delete R2 objects: walk manifest and `aws --endpoint ... s3 rm` (leave as manual step — operator reviews before destruction).

### Rollback a purge
- `imports-logs/<run-id>-purge.json` logs each `photo_id` soft-deleted. Flip `deleted_at` back to NULL for that list.

## What NOT to do

- Do NOT run `--execute --purge-misassigned` without `--i-really-mean-it`. Script will refuse.
- Do NOT re-scan F:224 / Camera 2 — those EXIFs are from April 2-3, 15 days off, irrelevant to the competition. Script auto-skips (`ignored_folder: 171`).
- Do NOT touch Saturday videos in R2 — they were uploaded by the normal app flow today. This script only uploads photos.
- Do NOT run this while CompSync Media.exe is active — race conditions on SD file locks. Close app first.
- Do NOT set `--day` to a Sunday or future date; the routine loader will return 0 rows and the match phase will produce no matches.
- Do NOT run with both `--from-orphan-json` AND `--sd` — the script prefers orphan JSON (would skip SD scan), resulting in confusing logs.

## Troubleshooting quick-ref

| Symptom | Cause | Action |
|---|---|---|
| `DATABASE_URL not set` | env var missing | `export DATABASE_URL=...` |
| `Loaded 0 routines` | wrong `--day` or windows missing | verify SQL day filter |
| `Match stats: no_window: <high>` | camera offset wrong or SD has extra data | check `-match.json`, look for concentrated `source_folder` values |
| `EXIF date sanity: pass=False` | wrong SD for the day OR clock issue | eyeball `buckets` in `-sanity.json`; abort if wildly off-day |
| `REFUSED: attempt to mutate path on SD card` | safety guard (expected) | should never happen — script only reads from SDs |
| `upload err: <path>: ...` | R2/network transient | re-run `--execute` — idempotency skips re-uploads |

## Files the script writes

- `<LOG_DIR>/overnight-v5.log` — running log
- `<LOG_DIR>/<run-id>-sanity.json` — EXIF date distribution
- `<LOG_DIR>/<run-id>-match.json` — full match/unmatch records
- `<LOG_DIR>/<run-id>-final.json` — top-level summary
- `<LOG_DIR>/<run-id>-purge.json` — (purge mode only)
- `<MANIFEST_ROOT>/<run-id>.json` — per-photo manifest with source path, EXIF, applied offset, R2 keys

Keep these after the run. They are the forensic record + enable rollback.

## Tonight's operator checklist (strike through as you go)

- [ ] App closed (CompSync Media.exe)
- [ ] DATABASE_URL exported
- [ ] `/tmp/overnight-orphans-v4.json` present on DART (or transfer from Ubuntu)
- [ ] Python deps installed
- [ ] Friday dry-run → review `-final.json` → approve
- [ ] Friday execute → verify count ~33k
- [ ] Saturday SDs plugged in, verified readable
- [ ] Saturday dry-run → review sanity PASS → approve
- [ ] Saturday execute → verify count increase
- [ ] (Optional) Purge misassigned dry-run → 846 count → approve
- [ ] (Optional) Purge misassigned execute → verify 0 remaining
- [ ] Spot-check Media Portal in browser
- [ ] Close session, SDs ejected, app stays closed overnight
