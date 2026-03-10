# CompSync Media — v2.5.1 (In Progress)

## Active: UI/UX Fixes (2026-03-10)

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

### Files Changed
- `src/main/services/recording.ts` — nextFull() now checks autoRecordOnNext
- `src/main/services/overlay.ts` — counter label now shows entryNumber only
- `src/renderer/components/RoutineTable.tsx` — fixed upload % display
- `src/renderer/components/Header.tsx` — UploadAllButton with disabled state
- `src/renderer/components/Settings.tsx` — reorganized, removed sections

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
