# Lunch Break — Session 2 SD Card Ingest Runbook

**Trigger:** operator inserts camera SD card into DART during lunch break.
**Goal:** get session 2 photos (~#148 through ~#170) from SD card onto
DART disk in their correct per-routine folders, then upload + reconcile DB.

**Session rules still apply:** DART reads are cheap during live show, but
writes must wait until show is paused or in break. This runbook assumes
show is paused for the lunch break duration.

---

## Phase 0 — Pre-break prep (do NOW while show is still live)

These are cheap reads only. Safe to run now.

### 0.1 — Capture session 2 routine windows from DART state.json
```bash
ssh dart "type C:\\Users\\User\\AppData\\Roaming\\compsync-state.json" > /tmp/dart-state-lunch-prep.json
# Or wherever state.json lives — confirm path first
```

Parse to extract, for each routine #148 through #180 (buffer): `entryNumber`,
`recordStartedAt`, `recordStoppedAt`. Save as:
`/tmp/session2-windows.json` → array of `{entryNumber, startMs, endMs}`.

### 0.2 — Confirm SD mount convention
Question for operator (before break): **what drive letter does Windows
assign to the camera SD when inserted?** Usually `D:` or `E:` or `F:`.
Once known, the photos directory is typically `<LETTER>:\DCIM\<FOLDER>\`.

### 0.3 — Stage the EXIF-bucket script
Write `/tmp/sd-bucket.py` that:
- Accepts `--sd-root`, `--windows`, `--dest-root`, `--dry-run`
- Walks SD for `*.JPG`, reads EXIF `DateTimeOriginal`
- For each file: find matching window (start-5s ≤ exif ≤ end+5s)
- Dry-run: emit per-routine counts + orphan list (no window match)
- Real run: copy files into `<dest-root>\<entryNumber>\` with filenames
  `photo_NNN.JPG` continuing from the max existing in that dir
- Never overwrite; collision → append `_dup` + warn

**Destination root**: `C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026\`
(confirm — this is where Electron watches, per CURRENT_WORK.md)

### 0.4 — Confirm jobQueue path on DART
```bash
ssh dart "type C:\\Users\\User\\AppData\\Roaming\\job-queue.json | findstr /C:\"\\\"status\\\"\"" | wc -l
# Count current jobQueue entries so we have a baseline
```

---

## Phase 1 — During break (fast path, ~15 min of work)

### 1.1 — Ask operator for exact SD drive letter + DCIM subfolder
One message. Don't start until confirmed.

### 1.2 — Dry-run the EXIF-bucket script
```bash
ssh dart "python C:\\path\\to\\sd-bucket.py \
  --sd-root <DRIVE>:\\DCIM\\<FOLDER> \
  --windows /tmp/session2-windows.json \
  --dest-root \"C:\\Users\\User\\OneDrive\\Desktop\\TesterOutput\\UDC London 2026\" \
  --dry-run"
```
Report per-routine counts + orphans. STOP here and show operator before
real run. Look for surprises:
- Any routine with way more/fewer photos than expected (~100-300 each)
- Orphan count — these didn't match any window

### 1.3 — Apply the 1hr EXIF discontinuity if needed
The camera clock was reset ~#166. Pre-reset photos have ~1hr offset.
If dry-run shows lots of orphans with EXIF ~1hr earlier than session 2
windows, add `--offset-minutes=60` (or -60) and re-dry-run.

### 1.4 — Real bucket copy (after operator OK)
Same command without `--dry-run`. Report final file counts per routine.

### 1.5 — Clean jobQueue
```bash
# Stop app first (operator does this)
# Back up job-queue.json
ssh dart "copy C:\\Users\\User\\AppData\\Roaming\\job-queue.json C:\\Users\\User\\AppData\\Roaming\\job-queue.json.bak-<timestamp>"

# Clear stale entries — keep only 'completed' + any successfully retrying.
# Write a cleaner script; run it; report diff.
```

**Decision point**: do we want to nuke the whole jobQueue (simplest)
or surgically remove only the 82 stale #113-era entries? Simplest =
nuke during lunch since show is paused.

### 1.6 — Restart app, trigger Upload All for session 2 range
Operator reopens app. App sees new photos on disk, rescanPhotos picks
them up (if C2.6 fix is NOT yet deployed, may need manual walk — check).
Click "Upload All" or per-routine upload.

### 1.7 — Verify
```sql
-- Watch R2 object count + DB rows for 148-170
SELECT entry_number, photo_count, status
FROM media_packages
WHERE competition_id = '6f29f048-61f2-48c2-982f-27b542f974b2'
  AND entry_number BETWEEN 148 AND 170
ORDER BY entry_number;
```

Expected: photo_count matches post-bucket file counts.

---

## Phase 2 — Post-lunch, show resumes

Leave:
- #114-147 (never uploaded, disk only) → post-event
- Class 3 re-upload → post-event
- R2 orphan cleanup → post-event
- Partials (#101, #102, #110) → post-event
- Asar redeploy with video timestamps → post-event

---

## Open decision points for operator

1. **SD drive letter / DCIM folder path?** (need before step 1.1)
2. **OK to nuke entire jobQueue during break?** (simplest) or surgical only?
3. **Apply 1hr clock offset?** — will know after dry-run shows orphans
4. **Do orphans get dropped, flagged, or dumped to `orphan/` dir?** Suggest
   dump to `orphan-session2/` inside TesterOutput so nothing is lost.
5. **Upload during lunch?** — yes if time permits; defer if it'd run into
   show resume.

---

## If something goes wrong

- Don't modify state.json while app is running (C8.2) — always stop app first
- Back up everything before overwriting (jobQueue, state.json)
- If bucket script miscategorizes, delete copies and re-run — SD card is
  the source of truth, not modified
