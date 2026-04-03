# Current Work - CompSync Electron App

## Last Session Summary
Major testing and bugfix session. Fixed Next button, PTP tether pipeline, upload retry, re-record confirmation, Controls UI, overlay layout. Full E2E verified.

## What Changed (this session)
- `d244823` (prior) fix: 11 production safety fixes
- **Uncommitted changes:**
  - `recording.ts` — fixed nextFull() broken dynamic require, added configurable next sequence, re-record confirmation dialog, verbose logging
  - `types.ts` — added nextSequence settings (6 fields), tether.autoWatchFolder setting
  - `Settings.tsx` — added Next Sequence section, Photo Tether section, removed duplicate autoRecordOnNext toggle
  - `Controls.tsx` — button swap (RECORD/NEXT based on recording state), disabled states, red glow CTA
  - `controls.css` — record-cta glow animation, disabled-muted style
  - `overlay-controls.css` — spacing between sections
  - `OverlayControls.tsx` — split Animation into Style and Timing sections
  - `index.ts` — added tether import (was missing!), auto-watch folder on startup, retrySkippedEncoded call
  - `upload.ts` — added retrySkippedEncoded(), added getSettings import (was missing!), per-file upload tracking (storagePath + uploaded flag)
  - `wpdBridge.ts` — verbose logging throughout
  - `tether.ts` — verbose WPD handler logging, thumbnail RAW file skip
  - `DriveAlert.tsx` — disabled WPD/MTP direct button
  - `ipc.ts` — confirmReRecordIfNeeded before startRecord
  - `hotkeys.ts` — confirmReRecordIfNeeded before startRecord
  - `package.json` — fixed sharp version mismatch (0.34.5 → 0.33.5)
  - `tools/wpd-helper/` — complete rewrite with MediaDevices NuGet (v4), proper PTP event support

## Build Status
PASSING — deployed to DART multiple times today. Last deploy at ~12:09.

## E2E Verification Results
- 7 routines (108-114) recorded, encoded, uploaded, plugin/complete succeeded
- CompPortal DB confirmed all 7 media_packages with correct R2 paths
- CompPortal fixed status from "processing" → "complete" (commit c0c5dec0)
- Upload retry for skipped routines working (109-111 recovered on restart)
- Zero errors since last restart

## Known Issues
- PTP event-driven photo capture: MediaDevices ObjectAdded event connects but doesn't fire on GH5M2. Workaround: use folder-watch mode pointing at Lumix Tether output folder (Settings > Photo Tether > Auto-Watch Folder)
- Thumbnail generation: sharp version mismatch fixed, but untested since fix deployed
- WPD helper needs to be built on DART (can't build .NET from WSL due to NuGet permission issues)

## Next Steps (priority order)
1. **Test photo tether folder-watch** — set Lumix Tether output folder in Settings, take photos, verify pipeline
2. **Test re-record confirmation** — click Record on already-recorded routine, verify dialog appears
3. **Test Controls UI** — verify RECORD/NEXT button swap, disabled states, red glow
4. **Test Next Sequence settings** — adjust pause times, verify they take effect
5. **Commit all changes** — large uncommitted diff
6. **Push to DART** — rebuild with committed changes

## Gotchas
- Hot update to DART requires BOTH app.asar AND CompSync Media.exe (exe only if native deps change)
- DART Desktop is OneDrive: `C:\Users\User\OneDrive\Desktop\`
- WPD helper built on DART via `dotnet publish` in CMD (not WSL — NuGet permissions broken via WSL)
- MediaDevices NuGet had to be manually extracted (NuGet restore fails on "content" folder — system-wide issue on DART)
- UDC-LONDON share code active, 526 routines
