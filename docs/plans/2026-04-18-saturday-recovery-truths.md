# Saturday 2026-04-18 Photo Recovery — Known Truths

**Last updated:** 2026-04-18 17:17 EDT
**Source:** Direct operator confirmation.

## Operator-confirmed facts (2026-04-18 17:17 EDT)

1. **Camera never touched during the day.** Body never changed. Clock never adjusted. Settings never changed.
2. **Clock was set perfectly for the first routine of the day.** No offset. Real EDT throughout.
3. **Show ran through normally** end-to-end (no re-records / swaps expected to cause Friday-style chaos).

## Implications for match logic

- Single-camera day. One body, one clock, no offset.
- Every Saturday photo: **real UTC = raw EXIF + 4h** (straight EDT→UTC conversion).
- No pre/post reset split. No SD-swap identity problem. No `_archive/vN/` re-record mess expected.
- If a Saturday photo doesn't match a DB window: the cause is upload-pipeline / DB-window error, NOT a camera/clock issue.

## Do NOT apply any of Friday's exceptions to Saturday

- No +5h pre-reset offset
- No P1687292.JPG boundary
- No R100/R280 archived-MKV overrides
- No camera-identity split by filename prefix (if second camera was involved, it ran normally too — confirm with operator before assuming)

## Known late-record events (operator-confirmed 2026-04-18 17:19 EDT)

- **R418**: record button hit ~1 minute late. Video window in DB will be ~60s shorter than actual performance. Photos during the first ~60s of real performance will fall outside the DB window.
- **R425**: record button hit ~2 minutes late. Same issue, ~120s gap at the start.

For these two routines, the matcher may need a per-routine window backfill using `recordingStartedAt - 60s` (R418) or `recordingStartedAt - 120s` (R425). Or: use adjacent-photo-cluster boundaries. Confirm strategy with operator when processing Saturday.

## What still needs to be done

Tonight's plan (operator stated 2026-04-18 18:41 EDT):
1. Show ends ~22:00 EDT
2. Two SD cards go back into DART (from ASTEROID/wherever)
3. Full Saturday reconciliation + upload run on DART
4. Uses `C:\Python313\python.exe` (already present on DART with boto3)
5. Reuses `upload-friday-manifest.py` script (points at Saturday manifest instead)

Saturday-specific inputs:
- Source root: wherever DART mounts the SDs (likely F:\ and H:\ or equivalent)
- Offset: +4h only (single camera, no clock issues)
- Window overrides needed for late-hit routines:
  - R418: video_start - 60s (record button hit ~1 min late)
  - R425: video_start - 120s (record button hit ~2 min late)
- Saturday match algorithm needs a simple version of match-v6 with just the +4h offset

Durable artifacts to produce:
- /home/danman60/compsync-saturday-recovery/full-exif-scan-2026-04-18.jsonl
- match-saturday.json
- match-saturday-summary.md

## R2 paths (same tenant + competition_id as Friday — all part of UDC London 2026)

- Photos: `00000000-0000-0000-0000-000000000004/6f29f048-61f2-48c2-982f-27b542f974b2/<entry_id>/photos/<filename>`
- Thumbs: same path + `_thumb.webp`
- Videos: same path + `videos/performance.mp4` etc.

## See also

- `2026-04-18-friday-recovery-truths.md` — Friday had completely different issues (two cameras, clock reset at P1687292, SD swaps). Don't conflate.
