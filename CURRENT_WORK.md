# Current Work - CompSync Electron App

## Last Session Summary
Major hardware testing session (2026-03-28). ~15 build/deploy cycles to DART. Fixed upload state sync, photo import, overlay editor, scaling for 700 routines, and ran autonomous test suite (63/78 passed, 0 failed, 14 skipped, 1 bug fixed during testing).

## What Changed
- `5e83939` feat: hardware testing — upload sync, photo import, overlay editor, NVENC (23 files)
- `633db07` fix: clear stale upload jobs and photo state on re-record
- `9ab0821` feat: scaling fixes (delta broadcasts, Map indexes, cached counts) + 10-flow test suite
- `21a7a7c` fix: exclude cancelled jobs from upload completion check (found by test runner)

### Key Features Added
- Visual overlay editor (drag/drop layout from BroadcastBuddy)
- Overlay URL in Settings with Copy button
- Per-routine cancel/retry buttons on upload rows
- Judge resolution setting (same/720p/480p) + NVENC toggle
- 15-min recording hard limit
- Recursive DCIM photo scan
- Smart clock offset detection (sampled, scales to 700 routines)
- Stream Deck native plugin built and deployed

### Scaling Fixes (for 700-routine competitions)
- Delta broadcasts (single routine, not all 700)
- Job queue Map index (O(1) getByRoutine)
- Cached WS counts (skip/active)
- Upload progress at 25% milestones only (not every chunk)
- Memoized Zustand recalcCounts
- State restore via Map lookup

## Build Status
PASSING — `npm run dist` builds successfully. Latest deployed to DART.

## Known Bugs & Issues
- Routine stuck at "recording" status after force-kill crash — not reset on restart (LOW)
- `encodedFiles[].uploaded` flags not set per-file after upload — cosmetic, routine-level status correct (LOW)
- Photo import test scripts use WSL `/mnt/d/` paths instead of `cmd.exe "dir D:\"` — test bug, not app bug
- Photo clock offset of -61s detected from old photos may confuse matching for newly synced camera — user synced camera, needs re-test
- Sharp thumbnail generation uses `.jpeg()` now but may still fail on some images (TypeError seen in logs)
- Settings button clipped at header right edge when all elements visible

## Incomplete Work
- Photo import flow not fully validated with synced camera (user synced clock but test not rerun)
- Overlay visual editor save → OBS layout update not tested end-to-end with actual OBS
- Stream Deck plugin not bundled with installer (manual copy to AppData/Roaming/Elgato)
- Photo sorter (CLIP-based) deferred — code preserved but UI removed

## Tests
- Autonomous test suite: 63/78 passed, 0 failed, 14 skipped (SD card WSL path issue, OBS restart issue)
- Report: `tests/reports/electron-20260328-202738/report.md`
- 10 flow files in `tests/agent/` covering startup, pipeline, photos, uploads, overlay, WS, errors, scale, settings, edge cases
- Test scripts need fix: use `cmd.exe` paths for USB drive access instead of WSL `/mnt/` paths

## Next Steps (priority order)
1. Re-test photo import with synced camera clock (SD card at D:, 19 JPGs, should match routines recorded today)
2. Fix 2 low-severity bugs: crash recovery for "recording" status, per-file uploaded flags
3. Fix test scripts to use cmd.exe for SD card access, rerun photo flow
4. Test NVENC encoding on DART's 3060 (toggle in settings, record+encode)
5. Test overlay visual editor save → verify layout updates in OBS
6. Bundle Stream Deck plugin with electron-builder installer
7. Full human operator test per `tests/HUMAN_TEST_CHECKLIST.md`

## Gotchas for Next Session
- App on DART has latest build (commit `21a7a7c`) deployed and running
- Deploy path: `scp -r release/win-unpacked/* 'dart:/mnt/c/Program Files/CompSync Media/'`
- MUST close app before deploying (taskkill via PowerShell: `ssh dart '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Stop-Process -Name \"CompSync Media\" -Force -ErrorAction SilentlyContinue"'`)
- WSL2 on DART cannot see USB drives via /mnt/ — use cmd.exe full path for SD card operations
- OBS WS server doesn't auto-restart after OBS process kill — need manual OBS restart
- Competition: EMPWR Dance - St. Catharines #2 (share code EMPWR-STCATH-2, 561 routines)
- SD card: D:\ (LUMIX), 19 JPGs in D:\DCIM\224_PANA\
- CS-TEST and CS-TEST2 tmux windows have completed test sessions

## Files Touched This Session
### Source (committed)
- src/main/services/upload.ts (cancel, retry, broadcastFullState, delta broadcasts, cached progress)
- src/main/services/photos.ts (recursive scan, smart offset, state update, auto-upload, debug logging)
- src/main/services/recording.ts (re-record cleanup, broadcastRoutineUpdate, jobQueue import)
- src/main/services/ffmpeg.ts (NVENC, judge resolution, EBUSY fix, retry backoff, userData copy)
- src/main/services/overlay.ts (layout types, updateLayout, WS layout broadcast, percentage positions)
- src/main/services/obs.ts (15-min recording limit)
- src/main/services/state.ts (cached counts, Map restore, getSkippedCount/getActiveCount)
- src/main/services/wsHub.ts (cached counts, overlayLayout in state message)
- src/main/services/jobQueue.ts (routineIndex Map, O(1) getByRoutine)
- src/main/ipc.ts (uploadCancelRoutine, overlayUpdateLayout handlers)
- src/preload/index.ts (uploadCancelRoutine, overlayUpdateLayout bridges)
- src/shared/types.ts (ElementPosition, OverlayLayout, judge/NVENC settings, IPC channels)
- src/renderer/components/RoutineTable.tsx (cancel/retry buttons, statusToLabel with routine)
- src/renderer/components/Settings.tsx (overlay URL, judge resolution, NVENC toggle)
- src/renderer/components/Header.tsx (photo import feedback, useStore import)
- src/renderer/components/OverlayControls.tsx (fire LT guard, edit layout button, useStore)
- src/renderer/components/CurrentRoutine.tsx (comp-loaded-no-routine message)
- src/renderer/components/DriveAlert.tsx (non-blocking import, background button)
- src/renderer/components/LeftPanel.tsx (removed photo sorter button)
- src/renderer/components/VisualEditor.tsx (NEW — drag/drop overlay editor)
- src/renderer/store/useStore.ts (showVisualEditor, STATE_ROUTINE_UPDATE, memoized recount)
- src/renderer/styles/header.css (meter line-height fix)
- src/renderer/styles/meters.css (scoped under .audio-meters)
- src/renderer/styles/visualEditor.css (NEW)

### Tests (committed)
- tests/agent/TEST_PLAN.md, lib/common.md, flow-01 through flow-10
- tests/reports/electron-20260328-165750/report.md (first test run)
- tests/reports/electron-20260328-202738/report.md (full test run)

### Other
- streamdeck-plugin/com.compsync.streamdeck.sdPlugin/manifest.json (Category fix)
- streamdeck-plugin/com.compsync.streamdeck.sdPlugin/package.json (ws dependency)
