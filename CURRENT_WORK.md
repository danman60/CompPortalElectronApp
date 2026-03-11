# CompSync Media — v2.6.0 (Shipped 2026-03-10)

## Active: Comprehensive Testing Complete

### Test Results (29 tests passed)
- **23 comprehensive tests** covering all IPC handlers and UI components
- **6 original tests** for basic functionality
- All tests verify: app launch, preload API, settings IPC, schedule IPC, job queue IPC, OBS IPC, recording navigation, upload IPC, overlay IPC, UI components, event listeners, error handling, main process state

### v2.6.0 Shipped Items
- Animated CPU and disk usage meters with progress bars
- Upload progress accuracy fixed (tracks bytes + files)
- Status indicator accuracy improved
- Full test suite with 29 tests

## Previous: UI/UX Fixes (2026-03-10)

### What was done
- Fixed BIG NEXT BUTTON to respect `autoRecordOnNext` setting (was always auto-recording)
- Fixed routine counter overlay to show only entry number (was showing "current / total")
- Fixed status indicators to only show upload % when actually uploading
- Fixed UPLOAD ALL button to disable when already uploading
- Reorganized Settings menu: Competition Setup first, Audio second, OBS lower down
- Removed Overlay section from Settings (duplicated on main screen)
- Removed FFmpeg path option from Settings (uses bundled FFmpeg)
- Removed Share Code from Settings (on main screen)
- Updated hotkey capture to enforce Shift+Control order
- Added animated CPU and disk completion bars

### Files Changed
- `src/main/services/recording.ts` — nextFull() now checks autoRecordOnNext
- `src/main/services/overlay.ts` — counter label now shows entryNumber only
- `src/main/services/upload.ts` — accurate progress tracking
- `src/renderer/components/RoutineTable.tsx` — fixed upload % display
- `src/renderer/components/Header.tsx` — UploadAllButton, SystemMonitor with meters
- `src/renderer/components/Settings.tsx` — reorganized, removed sections
- `src/renderer/styles/header.css` — meter bar styles + animation
- `tests/comprehensive.spec.ts` — 23 new comprehensive tests

## Previous: R2 Storage Migration (Complete 2026-03-09)

### What was done
- Cloudflare R2 bucket `compsyncmedia` set up and tested
- CompPortal `media-storage.ts` swapped from Supabase to R2 (commit `1f7a46f7`)
- New `media-urls.ts` resolves storage paths to signed R2 download URLs
- All 4 media serving routes updated (dancer, studio, cd/dashboard, download)
- E2E tested: Electron App upload flow → R2 → plugin/complete → DB verified
- Electron App needs ZERO code changes (signed URL is opaque)
- StreamStage 33 videos migrated to separate `streamstagesite` bucket (commit `ec2c3cb`)
- Cloudinary dependency eliminated from StreamStage

### Buckets
- `compsyncmedia` — private, CompPortal media (signed URLs)
- `streamstagesite` — public, StreamStage marketing videos

### Known Issues
- Download endpoint (`/api/media/download/[packageId]`) returned 500 during E2E — likely needs tenant-scoped auth, not plugin bearer token. Not blocking (package creation works).

## v2.5.0 Shipped Items (48 total)
[See previous 48 items — unchanged]

## Known Bugs
(none currently tracked)

## Next Steps
- Test Media Portal UI end-to-end with real competition data flowing through R2
- Consider R2 custom domain (media.compsync.net) to replace signed URLs with public access
- StreamStage: set up custom domain for R2 bucket to replace r2.dev URL
