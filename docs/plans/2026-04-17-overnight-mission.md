# Overnight SD Import — Mission (Locked)

**Date:** 2026-04-17 ~22:00 ET
**Show:** UDC London 2026, Day 1 (live, post-session)
**Status:** Pre-fire — scheduled task `OvernightSDImport` set for 22:15 ET tonight

---

## Mission

Every photo on the SD cards is paired to the correct routine and uploaded to R2 with a thumbnail. **Zero orphans accepted as a normal outcome.** If the matcher can't place a photo, that's a bug, not a feature.

## Inputs available

- Routine start/end times for every routine of the day (from DB: `media_packages.recording_started_at` / `recording_stopped_at`, or equivalent window fields)
- All photos on SD cards (F: + H: when H: is plugged tonight), with filename sequence + raw EXIF `DateTimeOriginal`
- Existing DB state (routines 100–120 already processed via in-app fixed flow — not to be reprocessed)

## Camera clock rules (core insight)

Raw EXIF is correct for the whole day **except** inside one window where a different camera was used and its clock wasn't synced.

- **Pre-swap photos:** raw EXIF correct
- **Swap window (~routines #148 to ~#166):** second camera, clock ~1h off
- **Post-reset photos:** clock was reset at ~#166, raw EXIF correct again

## Window detection (no guessing, read it from the data)

- **Start of 1h-off window:** sequence-number discontinuity in filenames — second camera resets its counter or uses a different prefix, making the jump obvious in sorted order
- **End of 1h-off window:** EXIF time jump within the second camera's own stream — clock gets set back, visible as a discontinuity in the corrected timestamp series
- **Correction:** apply ±1h only to photos between those two markers; everything else uses raw EXIF untouched

## Matcher requirements

1. Sort SD dump by filename sequence
2. Identify the two markers above
3. Apply ±1h correction inside the window, nothing outside it
4. Match each corrected timestamp to a routine window
5. Honor burst/sequence coherence — photos shot in a burst belong to the same routine
6. Expand routine windows by photographer reality (entry, applause) — modest ±s buffer
7. Fallback: nearest routine within a short cap for borderline photos
8. TRUE orphans are only: pre-first-routine test shots, post-last-routine, or >few-minute schedule gaps. Should be tens, not thousands.

## Outputs required per photo

- Original JPG uploaded to R2 at the correct path
- Thumbnail (`_thumb.webp`) uploaded alongside
- `media_photos` row created with `media_package_id` set to the matched routine
- `media_packages.photo_count` updated
- Post-run verification: DB row count vs R2 object count per routine

## Hard constraints (non-negotiable)

- **SD cards are read-only forever.** F: and H:. No writes, deletes, formats, renames.
- No action on DART without explicit operator approval.
- CompSync Media app stays quit through the overnight run.
- Master branch working tree (uncommitted edits from prior sessions) is off-limits.
- No pushing / merging `feat/sd-import-overnight` without operator go.

## Space management concerns

- **Desktop/OneDrive/PHOTOIMPORT** folder (tether landing zone) can be cleared — SDs hold the originals, routine folders hold the sorted copies, R2 holds what's been uploaded. Redundant storage.
- Overnight job stages JPGs transiently during upload. Needs a free-space guard so it doesn't crash mid-run.
- If space is tight before 22:15, PHOTOIMPORT clear is the first lever — but requires operator go (it's a destructive op even if safe).

## Thumbnails

- **Required as part of this mission.** Must be generated and uploaded inline, not deferred to a post-hoc backfill.
- Prior thumb backfill (CompPortal-3 session) handled 2,790 already-uploaded photos that lacked thumbs. We don't want to repeat that pattern for the overnight batch.

## Risks / known unknowns

- Is the current overnight script generating thumbs inline, or just originals? Needs verification.
- Is the current matcher using cluster-based discrete offsets (the 2,352-orphan producer), or does it already have the sequence-discontinuity logic? Needs verification.
- Is there a free-space guard in the script? Needs verification.
- What happens to the 2,352 orphans the dry-run predicted — are they saved for review, or dropped?
