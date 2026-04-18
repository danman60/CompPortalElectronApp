# Saturday 2026-04-18 — SD Import Catastrophic Failure Incident

**Discovered:** ~14:29 ET when operator attempted SD import for Saturday R342 → got EBUSY error.
**Impact:** Friday SD photos (~21k JPEGs) matched and dumped into Saturday routine folders. Thumbnail generation errors across many routines. App had to be closed mid-show to stop runaway.

## Timeline

| Time (ET) | Event |
|---|---|
| 07:21 | CompSync Media app launched. F: and H: SDs already plugged in (still containing all of Friday's data). |
| ~07:30 | Saturday show begins. **No camera tether today** (camera not connected to laptop). |
| 08:06–08:09 | **144 photos appear in R310/photos** (mtime today). Origin unclear — possibly from a sync flow or earlier manual import that worked. |
| 08:55+ | Saturday routines recording normally via OBS. Tether rescan logs `0 new matches` (no camera connected — expected). |
| 10:19:15 | Operator clicks Photos button → selects `F:\` → **21,806 JPEGs found**. Import begins (no UI feedback). |
| 10:20:39 | Operator clicks Photos again → selects `F:\DCIM` → **21,792 JPEGs found**. **Second parallel import** kicks off. |
| 10:19–10:29+ | Both imports run simultaneously. Each processes 21k+ photos: EXIF read → matcher → copy → thumbnail. Sharp library throws `TypeError: A boolean was expected` on thumbnail generation for many routines. |
| ~14:29 | Operator inserts SD for Saturday R342, sees EBUSY: source file `F:\London Top Picks-Sat\P1965014.JPG` locked (runaway holds read lock). Screenshot reported. |
| ~14:30 | App closed cleanly to stop runaway. |

## Bugs identified

### Bug A — Drive monitor suppresses startup-mounted SDs
**File:** `src/main/services/driveMonitor.ts:283-284`
**Behavior:** On startup, all currently-mounted drives are seeded into `knownDrives`. The drive-detection loop (line 237) only fires `DRIVE_DETECTED` for drives NOT in `knownDrives`. F: and H: were mounted before app launch, so the popup never fires for them.
**Workaround:** Eject + reinsert SD to clear the set.

### Bug B — Manual Photos button has no visible progress
**Files:** `src/renderer/components/Header.tsx:88-104`, `src/renderer/components/DriveAlert.tsx:244`
**Behavior:** `handleImportPhotos` awaits the entire import with only a final `alert()`. The progress events (`photos:progress`) DO fire, but the only subscriber is `DriveAlert`, which returns null when no drive was detected. So a Header-triggered import is silent until completion (could be 20+ minutes for 21k photos).
**Consequence:** Operator can't tell the import is running. Likely clicks again, spawns parallel run.

### Bug C — No deduplication / single-flight on photo import
**File:** `src/main/services/photos.ts` and IPC handler in `src/main/ipc.ts`
**Behavior:** `photos:import` IPC accepts multiple invocations, runs them in parallel with no lock. Two imports of overlapping/identical paths race each other, generating EBUSY collisions, thumbnail conflicts, and double work.

### Bug D — Imports don't filter by date or new files
**Behavior:** `photos:import` on `F:\` scans EVERY JPEG on the drive (21,806). When SD has Friday's data still on it from yesterday, the entire prior day gets re-processed. Should support filtering to today's date or to new files (mtime > last import).

### Bug E — Sharp thumbnail generation throws on certain inputs
**Behavior:** `Thumbnail generation failed for ...: TypeError: A boolean was expected` flooding the log starting at 10:27. Affects existing photo files (mtime today 8:06 AM), not new ones — suggests a delayed thumbnail catch-up worker hits malformed sharp arguments.
**Stack:** `at importPhotos (... main/index.js:8060:86)`

### Bug F — Cross-day photo pollution via EXIF matching
**Behavior:** When yesterday's SD with 21k Friday photos is imported on Saturday, the matcher matches photos to today's routines based on EXIF time-of-day overlap (e.g., a Friday morning photo at 08:30 EDT matches a Saturday morning routine at 08:30 EDT). Result: Saturday routine folders get polluted with Friday data.
**Root cause:** Matcher uses time-of-day comparison without checking the photo's date matches today's date. Should reject (or warn loudly) when source photo date ≠ today's date.

## Concurrency observation

When the operator clicked Photos at 10:19, **two flows ran in parallel from the same trigger**:
- A **legitimate per-routine sync** (worked correctly) — pulled the right SD photos into the right routine folders. The 144 photos in R310/photos at 08:06–08:09 AM mtime came from this path running successfully against R310's video window.
- The **runaway full-SD catchup** described above (Bug C: no single-flight, processes all 21k photos blindly).

Both flows wrote to the same routine folders simultaneously, causing thumbnail-generator races and EBUSY collisions. That the legitimate path worked is good — but it shouldn't have been kicked off at the same time as a 21k-photo full-drive scan.

## What still needs investigation

1. **How many Saturday routines got polluted by the 10:19–14:30 runaway.** Need to enumerate folders + check for non-Saturday-date EXIFs.
2. **Why the Sharp library throws TypeError** — likely a sharp version mismatch or missing parameter.

## Mitigation actions taken

- App closed cleanly (operator-initiated, after consultation).
- Runaway terminated.
- This document created.
- Bug fix proposal (not yet deployed) at `/tmp/fri-recovery/sd-import-fix-proposal.md`.

## Recommended remediation

**Pre-relaunch (today):**
- Manually identify Saturday routine folders polluted with Friday data and quarantine.
- Operator unplugs SDs before relaunch, plugs in only after app fully loaded → triggers DRIVE_DETECTED properly.

**Post-show (deploy fix):**
- Bug A fix: drive monitor fires for camera drives at startup (with optional one-shot dismiss).
- Bug B fix: Header import shows pill / progress modal.
- Bug C fix: single-flight lock on `photos:import`.
- Bug D fix: import dialog defaults to "today's photos only" with override.
- Bug E fix: investigate sharp version, fix TypeError.
- Bug F fix: reject (or warn) source photos whose EXIF date doesn't match today's expected day.
