# UDC London 2026 Day 1 — Overnight SD Import Mission Complete

**Time written:** 2026-04-18 ~01:05 ET
**Mission status:** COMPLETE within autonomous capability

## Final result

Today's competition photo data in DB:
- **15,145 total photos** for competition 6f29f048
- 6,754 from in-app/tether flow (during the show)
- **8,391 added by overnight script** across 62 routines that were zero pre-overnight
- 0 R2 errors, SD integrity verified (10 baseline files unchanged)

## Iterations and what we learned

The overnight job ran 4 versions tonight. The first two had matcher bugs that produced **contamination** (right photos to wrong routines). I rolled them back (R2 + DB) and re-ran with fixes.

| Version | matched | new uploads | issue | action |
|---|---|---|---|---|
| v2 | 12,193 | 8,649 | False swap window (2,732 photos shifted +3600s wrongly) | Rolled back |
| v3 | 10,659 | 7,232 | Per-SD fix exposed 2 false swaps (4,774 photos wrongly shifted) | Rolled back |
| v4 | **11,935** | **8,391** | Removed swap detection entirely, raw EXIF only | KEPT |

## Why swap detection was removed

The original algorithm tried to detect "camera-swap with clock reset" by:
1. Finding folder-prefix jumps in filenames (P176→P224)
2. Looking for ~1h EXIF gaps in the new camera's stream
3. Applying ±3600s offset to bad-clock photos

**The problem:** normal session boundaries (lunch, intermission) produce ~1h EXIF gaps that look identical to clock resets. There's no reliable way to distinguish them from EXIF alone. Both H: and F: SDs had natural ~1h gaps in P166-P189 ranges that the algorithm was misreading.

**v4 solution:** trust raw EXIF for everything. Only special-case Camera 2 (whose EXIF dates are days off from competition date — clearly unsalvageable by ±1h offset).

## What's still missing (operator morning tasks)

### Today's routines that have ZERO photos

These are entries where the overnight matcher couldn't find any SD photos in their windows. They may need manual handling:

- **126–147** (22 routines, mid-morning to early afternoon)
- **188–195** (8 routines, post Camera-2-swap)
- **228–231** (4 routines, late afternoon)

For 126–147 and 228–231: probably no photos were shot (tether dropped, camera off, gap between sessions). If the photographer confirms no shooting happened, leave as-is.

For 188–195: per the day's history, this is where tether was abandoned and Camera 2 was used. Camera 2's photos are tonight's special case (see below).

### Camera 2 photos (manual recovery needed)

171 photos in `F:\DCIM\224_PANA` cannot be auto-matched because their EXIF dates show **April 2–3** instead of April 17 (camera clock was set to wrong date entirely, ~15 days off).

Plus 54 photos with April 16 dates scattered elsewhere (likely yesterday's setup/test shots).

Total wrong-day photos surfaced by v4: **225** (sitting in `overnight-orphans.json`).

**Suggested manual approach for Camera 2 photos:**
1. SDs are still plugged at F: and H: — read-only, untouched by overnight job.
2. Browse `F:\DCIM\224_PANA\P2241063.JPG` through `P2241233.JPG` (171 files in chronological filename order).
3. The bulk likely belongs to routines 188–195 per operator narrative.
4. Either bulk-assign by filename order to those 8 routines, or have the photographer confirm which routines they shot Camera 2 for.
5. Use the in-app importPhotos flow with manual routine selection (don't try to auto-match).

## R2 storage state

- R2 bucket `compsyncmedia` contains all v4 uploads (8,391 originals + 8,391 thumbs = ~16,782 new objects, 9.5 GB)
- All v2/v3 uploads were cleanly deleted (17,298 + 14,464 = 31,762 objects removed)
- No leftover orphan R2 objects from the rolled-back runs

## Known DB issue (not from tonight)

`media_packages.photo_count` is double the actual `media_photos` row count for v2/v3/v4-uploaded routines (e.g., entry 121 shows photo_count=180 but has 90 actual rows). This is the pre-existing "photo_count double-increment bug" in `/api/plugin/complete` (open task #8 in CURRENT_WORK). Not introduced by tonight's work. Display-side will show inflated counts until that bug is fixed.

## Files / artifacts

- **Final overnight report:** `dart:C:\Users\User\logs\overnight-report.json` (also `/tmp/overnight-report-v4.json`)
- **Unassigned photos list:** `dart:C:\Users\User\logs\overnight-orphans.json`
- **Stdout log:** `dart:C:\Users\User\logs\overnight-stdout.log`
- **Working script (v4):** `scripts/overnight-sd-import.py` (committed locally to repo, deployed to DART)
- **Rollback snapshots:** `/tmp/rollback-snapshot-*.json` (audit trail for the v2 + v3 deletions)
- **SD safety:** F: and H: cards are READ-ONLY throughout, integrity verified (SHA256 baseline of 10 files unchanged)

## What changed in the script vs the original

- Removed cluster-based offset detection with discrete buckets
- Removed marker-based reset detection (kept the wrong-day-date detection)
- Phase 4 strict containment (no ±5s buffer, no nearest-routine fallback) — `window_start ≤ EXIF ≤ window_end` only
- Per-photo `photo_offset_sec` field instead of cluster-based offset
- Better report: `match_stats`, `unassigned_count`, `no_capture_time_count`, `offset_swap_windows` (now empty)
- All SD safety wrappers preserved (read-only enforcement triple-layer)
- Inline thumbnail generation + upload preserved
- Phase 7 `/api/plugin/complete` register preserved (with `photo_thumbnails` array)

## Mission completion criteria — verification

| Criterion | Status |
|---|---|
| SD integrity preserved | ✓ verified, 0 violations |
| All matchable photos uploaded | ✓ 8,391 new across 62 routines |
| All R2 uploads include thumbs | ✓ 16,782 objects (8,391 originals + 8,391 thumbs) |
| Pre-existing in-app data preserved | ✓ 6,754 in-app rows untouched |
| Rolled-back runs cleanly removed | ✓ 0 leftover R2 objects, 0 orphan DB rows |
| Camera 2 outcome explicitly documented | ✓ this document |
| 0 errors on final run | ✓ |
