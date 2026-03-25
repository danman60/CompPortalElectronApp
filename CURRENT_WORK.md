# Current Work - CompSync Electron App

## Last Session Summary
Major testing, bug-fixing, and automation session (2026-03-24/25). Committed all prior uncommitted UI work, fixed 12 bugs found through E2E testing, built automated test suite, added auto-load share code on startup.

## What Changed
- `d5136b6` feat: pipeline status UI, action bar, SD card detection, test suite (29 files)
- `6dbaf84` fix: bundle ffmpeg.exe for Windows builds from Linux host
- `75b7bae` fix: upload dedup — force re-upload, skip done jobs
- `54d187d` fix: validate file size before upload (5GB R2 PUT limit)
- `d46026b` feat: E2E test suite + auto-load share code + WS hub loadShareCode
- `2561c7f` fix: state file defaults to userData, not CWD (EPERM on Program Files)
- `e9b6b7f` fix: use static import for schedule (resolvedConnection module instance)
- `1b3ce2e` fix: always resolve share code on startup for upload credentials

### CompPortal (separate repo, auto-deploys via Vercel)
- `a17792ee` fix: prevent duplicate photos on re-upload
- `5f9c7bc5` fix: empty complete preserves status, bump upload URL TTL to 2hr
- `ed47ff26` fix: avoid unique constraint collision on null entry_number

## Build Status
PASSING — `npm run dist` builds successfully. ffmpeg.exe auto-downloaded and bundled. Output in `release/win-unpacked/`.

## Known Bugs & Issues
- Routine 2 encoding sometimes not detected by E2E log monitor (timing issue in test script, not app)
- Entry numbers show as `#?` in WS hub state for some routines (missing entryNumber in state broadcast after advance)
- `compsync-state.json` in project root is stale/orphaned — app now writes to userData path
- 12 stale upload jobs in job-queue.json on DART from test runs — will auto-expire or can be cleared

## Incomplete Work
- E2E test `--skip-upload` was used — upload verification in test not yet validated end-to-end
- SD card detection (`driveMonitor.ts` + `DriveAlert.tsx`) untested with real hardware
- `netsh portproxy` entries may still exist on DART (ports 9876/9877) — harmless but should clean up

## Tests
- E2E pipeline test: 18/19 passed, 1 failed (CompPortal 500 on plugin/complete — fixed in `ed47ff26`, awaiting Vercel deploy)
- 6 Playwright specs exist but require Electron launcher (not runnable remotely)
- Human operator checklist at `tests/HUMAN_TEST_CHECKLIST.md`

## Next Steps (priority order)
1. Rerun E2E test after Vercel deploys CompPortal fix (`ed47ff26`) — should get 19/19
2. Run E2E with `--routines 3` and WITHOUT `--skip-upload` to test full upload pipeline
3. Test SD card detection with real camera SD card on DART
4. Fix entry number display in WS hub state (routines after advance show `#?`)
5. Set output directory in app settings (currently empty — recordings go to OBS default)
6. Full human operator test with OBS cameras per `tests/HUMAN_TEST_CHECKLIST.md`

## Gotchas for Next Session
- App on DART has latest build (`1b3ce2e`) deployed and running
- OBS is running on DART and connected to the app
- E2E test runs ON DART via: `ssh dart 'cd /mnt/c && cmd.exe /c "cd C:\temp && node e2e-pipeline.mjs --host localhost --routines 2 --record-sec 10 --log-path C:\Users\User\AppData\Roaming\compsync-media\logs\main.log"'`
- SSH tunnels DON'T work for WS hub testing (WSL2 → Windows localhost isolation). Run test on DART Windows side.
- `COMPSYNC_BIND_HOST=0.0.0.0` env var opens ports for remote access if needed
- CompPortal Vercel auto-deploys on push to main — allow ~2min after push
- R2 credentials: aws CLI works with env vars from memory file

## Files Touched This Session
### Electron App
- src/main/index.ts (auto-load share code, static schedule import)
- src/main/ipc.ts (force param on upload routine)
- src/main/services/upload.ts (dedup, force, file size check)
- src/main/services/state.ts (userData path fix)
- src/main/services/overlay.ts (configurable bind host)
- src/main/services/wsHub.ts (configurable bind host, loadShareCode command)
- src/main/services/photos.ts (EXIF UTC fix, matchedRoutineId)
- src/main/services/driveMonitor.ts (NEW — SD card detection)
- src/preload/index.ts (drive dismiss API)
- src/renderer/App.tsx (DriveAlert import)
- src/renderer/components/Header.tsx (unified action bar)
- src/renderer/components/RoutineTable.tsx (pipeline status columns)
- src/renderer/components/LoadCompetition.tsx (share code error handling)
- src/renderer/components/DriveAlert.tsx (NEW — SD card modal)
- src/renderer/styles/header.css, table.css, drive-alert.css
- src/shared/types.ts (DriveDetectedEvent, WSCommandMessage.shareCode)
- scripts/fetch-ffmpeg-win.sh (NEW — Windows ffmpeg download)
- tests/e2e-pipeline.mjs (NEW — E2E test suite)
- tests/run-e2e-dart.sh (NEW — SSH tunnel runner)
- tests/*.spec.ts (6 new Playwright specs)
- .gitignore (resources/ffmpeg/)
- package.json (predist hook, extraResources path)

### CompPortal
- src/app/api/plugin/complete/route.ts (photo dedup, status preservation, null entry_number)
- src/app/api/plugin/upload-url/route.ts (2hr TTL)
