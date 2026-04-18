# Friday Overnight Script — Post-Mortem (what to fix for tonight's run)

**Source script:** `scripts/overnight-sd-import.py` v4
**Friday outcome:** 8,391 photos uploaded, 18,325 orphans, ~5,000 photos misassigned to wrong routines.
**Today's analysis revealed the actual bugs.**

## Bug 1 — EXIF treated as UTC, but cameras are set to EDT

**What happened:** Script reads EXIF `DateTimeOriginal` and stores it with `+00:00` (UTC) timezone label. But Panasonic cameras are set to operator-local time (EDT). The clock value `08:24` from camera was actually 08:24 EDT (= 12:24 UTC), not 08:24 UTC.

**Consequence:** Every match was off by 4 hours. When matching against routine windows (which are real UTC), the script compared 08:24 (mislabeled UTC) against video window 12:18 UTC — no match. Photos ended up orphaned or matched to wrong routines.

**Evidence:** Today's match v2 (with corrected timezone) jumped from 3,752 matched to **15,188 matched** (82.9%) — same data, just correct TZ interpretation.

**Fix for tonight:**
- Strip `+00:00` label entirely OR re-tag as `-04:00` (EDT during April).
- For any future flexibility: read camera timezone from a settings file, default to operator's local (`America/New_York`).
- Confirm by computing offset from a known-good reference: pick a tether-captured photo with both EXIF and DB `captured_at`; the difference should be ~0, not 4 hours.

## Bug 2 — Used scheduled performance time as routine windows, not video timestamps

**What happened:** Script matched against `performance_date + performance_time` (planned schedule). But shows run off-schedule — routines drift, breaks shorten, etc. The ground truth is `media_packages.video_start_timestamp` / `video_end_timestamp`, which captures what time the app actually recorded each routine.

**Consequence:** Even after the timezone fix, matching against scheduled time would still misassign photos when the show drifted from schedule.

**Fix for tonight:**
- Pull windows from `media_packages.video_start_timestamp/video_end_timestamp`.
- For routines missing video timestamps (15 on Friday — early R101–R119), fall back to scheduled time + a generous ±2 min buffer.

## Bug 3 — No camera identity awareness, no per-camera offset

**What happened:** Script treated all photos as one stream. In reality, two camera bodies were in use:
- Camera A (folder prefix 101–110): correct clock (no offset)
- Camera B (folder prefix 166–187): clock running +60 min fast post-lunch, corrected at H:168 between P1687267 and P1687292.

V2/v3 tried to detect "swap windows" via EXIF gaps, but session boundaries (lunch, intermission) look identical to clock resets. Both flagged false positives and shifted ~3,000 photos by ±3600s wrongly.

**Fix for tonight:**
- **Identify camera by folder prefix** (NOT drive letter — both cameras shoot to both SDs).
- Try multiple offsets per photo: 0, -60min. Pick whichever lands the photo's real-time inside SOME video window.
- Only apply +60min offset when explicitly known (operator confirmed for Cam B post-lunch on Friday).

## Bug 4 — F:224 (Camera 2, 15-day-off clock) was orphaned with no surfacing

**What happened:** 171 photos with EXIF April 2-3 (camera clock 15 days behind reality). v4 left them as orphans with no operator notification.

**Fix for tonight:**
- Detect EXIF dates that don't match expected day → flag loudly in report.
- For UDC London Friday: F:224 was confirmed irrelevant (different event). For tonight (Saturday), check for any cameras with similarly misset clocks before scanning starts.

## Bug 5 — Strict containment with no buffer

**What happened:** v4 required `window_start ≤ EXIF ≤ window_end` exact. Photos shot 1-2 seconds before window_start (warmup, anticipation) or after window_end (held shutter) were orphaned.

**Fix for tonight:**
- Allow ±5s buffer on window edges (operator confirmed photos are always during routines, but recording window vs shutter timing has small natural drift).
- Don't go larger than 5s — that's where session boundaries start to overlap.

## Bug 6 — No retry/correction loop after first match

**What happened:** Script ran once, produced orphans, stopped. No "re-examine orphan EXIF clusters and propose offset corrections" pass.

**Fix for tonight:**
- After initial pass, scan orphans for clusters whose EXIF range is N minutes off from a known routine window. Surface as candidate offsets for operator review.
- Don't apply automatically — log + ask.

## Bug 7 — No source-truth recording

**What happened:** Once a photo was matched and uploaded as `photo_NNN.jpg`, the original camera filename + folder + EXIF were lost. Made today's recovery 10x harder.

**Fix for tonight:**
- Every uploaded photo: record `source_filename`, `source_folder`, `source_drive`, `original_exif_iso`, `applied_offset_sec` to a per-run manifest JSON.
- Even better: name uploads `photo_NNN__P1965014.jpg` so source is in the filename itself.

## Tonight's checklist (in order)

1. Verify timezone interpretation: pick 5 photos already in DB, compare EXIF to DB `captured_at`. Should be 0 offset, not 4 hours.
2. Pull video windows from `media_packages.video_start_timestamp/end_timestamp`. Confirm 192/207 routines have them (or whatever's true tonight).
3. Per camera (folder prefix), try matching at offsets 0, -60min. Apply ±5s buffer.
4. For Camera 2-style wrong-day photos: flag and skip.
5. Write per-photo manifest with source filename, folder, original EXIF, applied offset.
6. Pause before upload — produce dry-run report. Operator approves before R2/DB writes.
7. Don't run a "v5 detection" loop in same script — separate analysis script if needed.

## What NOT to redo from v4

- Cluster-based offset detection (false positives).
- Per-SD heuristics (camera ≠ SD).
- Strict containment with no buffer.
- Trust-raw-EXIF-only fallback (misses real offsets).
- "+00:00" timezone label on EXIF (it's EDT).
