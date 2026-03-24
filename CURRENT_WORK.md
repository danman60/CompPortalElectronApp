# Current Work - CompSync Electron App

## Last Session Summary
Testing & UI session (2026-03-24): Built comprehensive test suite, remote-tested on DART Windows, redesigned routine status UI, added SD card auto-detection, fixed silent share code failures, fixed CompPortal tenant_paused blocking API routes.

## Active Task
Building testing protocols + UI improvements. User is verifying on DART.

## Recent Changes (2026-03-24)

### Testing Infrastructure
- 6 new Playwright test specs: overlay, websocket-hub, system-monitor, upload-dispatch, ffmpeg-pipeline, photo-sorting
- Human operator checklist: `tests/HUMAN_TEST_CHECKLIST.md`
- 38/38 remote tests passed on DART Windows via Tailscale

### UI Improvements
- **Pipeline status columns** in RoutineTable: REC / SPLIT / PHOTO / UP per row with state icons
- **Unified Action Bar** in Header: Load/Process/Upload/Video/Photos with AUTO badges
- **SD Card auto-detection**: `driveMonitor.ts` + `DriveAlert.tsx` modal with real-time progress

### Bug Fixes
- Silent share code failure in LoadCompetition.tsx (checks `{ error }` from safeHandle)
- CompPortal: `/api/plugin/*` exempted from tenant_paused middleware (deployed)
- EXIF UTC fix: DateTimeOriginal parsed as local time
- PhotoMatch now includes matchedRoutineId

## Hot-Deploy Pattern (DART)
```bash
cd ~/projects/CompSyncElectronApp && npm run dist
ssh dart 'cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c "taskkill /F /IM CompSync*"'
scp release/win-unpacked/resources/app.asar "dart:/mnt/c/Program Files/CompSync Media/resources/app.asar"
# User relaunches manually
```

## Blockers
- Bundled ffmpeg.exe missing (ffmpeg-static doesn't cross-compile)
- SSH can't launch GUI apps on DART desktop session

## Next Steps
1. Verify UI changes on DART (action bar, pipeline columns, share code)
2. Test SD card detection with real camera
3. Commit all changes
4. Add ffmpeg.exe to build
5. Full human operator test with OBS cameras
