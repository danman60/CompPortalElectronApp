# Friday 2026-04-17 Photo Recovery — Known Truths

**Last updated:** 2026-04-18
**Source:** Direct operator confirmation + DB query verification

## Operator-confirmed facts

1. Friday competition has **207 routines**, numbered **R100 to R307** (one number skipped).
2. **Two cameras shot Friday:** Camera A and Camera B.
3. **Camera identity = filename folder prefix** (NOT drive letter). Both cameras shot to both F: and H: SD cards.
4. **Camera A** = filename prefix folders **101-110**. Shot the morning. Clock was correct (no offset).
5. **Camera B** = filename prefix folders **166-187**. Shot post-lunch. Started with **+1hr offset** (clock 1hr ahead of real time). The offset **was corrected** at some point (timing per operator memory, not yet derived from data).
6. **F:224 / Camera 2** (EXIF dates Apr 2-3) is **irrelevant** — ignore.
7. **No between-routine shots exist.** Every photo was taken during a routine.
8. **EXIF always means capture time** (`DateTimeOriginal`), not file transfer time or mtime.
9. **Authoritative routine windows = video recording timestamps**, NOT scheduled performance times.

## Data-confirmed facts

10. DB table `media_packages` has columns `video_start_timestamp` + `video_end_timestamp`.
11. **192 of 207 Friday routines have video recording windows.**
12. **15 routines have no video window** (mostly early: R101-R119 area).
13. Competition ID: `6f29f048-61f2-48c2-982f-27b542f974b2`. Tenant ID: `00000000-0000-0000-0000-000000000004`.
14. Overnight orphan pool contains **18,325 photos** with capture-time EXIF, across folders 101-110, 166-189, and 224.

## Timezone facts (CRITICAL — easy to mis-handle)

15. **Cameras are set to EST/EDT (operator's local time, UTC-4 in April).**
16. **EXIF DateTimeOriginal values are camera-local EDT clock display.**
17. **Overnight script labels EXIF as `+00:00` (UTC) but the time values are actually EDT.** The label is wrong; the underlying numeric value is EDT.
18. **DB `video_start_timestamp` / `video_end_timestamp` ARE correctly stored as real UTC** (postgres `timestamptz`).
19. **To match EXIF against video windows:** treat the stored EXIF time value as EDT and add 4 hours to get real UTC, OR convert video window UTC down by 4 hours to compare in EDT space.
20. **Verification:** Cam A morning EXIF clusters at hours 08-10 (EDT clock value), corresponding to morning competition R100-R150 area. Cam B afternoon EXIF clusters appropriately for post-lunch routines.

## Match v3 results (after backfill, 2026-04-18)

21. **17,944 of 18,325 orphans matched** (97.9%) when using the corrected algorithm + backfilled video windows for R101-R119.
22. **Cam A**: 9,162/9,227 matched (99.3%). Folder prefix 101-110, no offset.
23. **Cam B**: 8,782/8,927 matched (98.4%). Folder prefix 166-189.
24. **Cam B clock correction point confirmed at filename `H:168/P1687292.JPG`** (first post-correction frame, EXIF 11:50:57 EDT). Photos with EXIF naive < this boundary use +60min Cam B offset; at/after use 0 offset.
25. **R101-R119 video windows backfilled from MKV file mtimes** (`routine_window_source = 'mkv_mtime_backfill_2026-04-18'`). 15 routines.
26. **Remaining 210 unmatched orphans:**
    - 65 pre-event Cam A photos (folder 101 starts EXIF 2026-04-16; warmup/setup before R101 began at 12:01:35 UTC)
    - 145 in a single between-routine gap R129→R130 (2,405-second break; appears to be Cam B test shots — needs operator review whether these are legit)
27. **F:224 / Camera 2** (171 photos with EXIF Apr 2-3) confirmed irrelevant; matcher correctly ignored.
28. **Routines run continuously within sessions** — confirmed by photo density check (90-160 photos/min steady across populated routines, no leakage). Used to anchor backfilled windows.

## Goal

Every Friday photo (not yet correctly assigned) placed in its correct routine in the DB, with R2 storage paths matching.

## Working artifacts

All under `/tmp/fri-recovery/`:
- `video-windows.json` — 207 Friday routines with video timestamps
- `orphan-to-routine-by-video.json` — first-pass video-window match (3,823 matched, 14,502 unmatched, needs rerun with corrected camera identity)
- `db-state.json` — current DB photo counts per routine in scope
- `r2-inventory.json` — R2 object inventory per entry_id
- `reassignment-manifest.json` + `reassignment-dry-run.py` — proposed move plan (PRE-truths-correction; needs revision)
