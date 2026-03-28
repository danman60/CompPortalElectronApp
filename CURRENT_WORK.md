# Current Work - CompSync Electron App

## Last Session Summary
Hardware testing session (2026-03-28). Rapid hotfix cycle — 10+ build/deploy iterations to DART. Fixed many UI/state sync issues found during live testing.

## What Changed This Session

### UI Fixes
- CPU/Disk meter text clipping — scoped audio meter CSS that was overriding system monitor
- "No competition loaded" message changed to "Click a routine to select it" when comp is loaded
- Removed "Sort Photos by Subject" button from left panel (auto-offered after import instead)
- Settings button clipping at header edge (still needs attention)

### Upload System
- Cancel button per-routine (cancels jobs + resets status to encoded)
- Retry button on failed rows
- `broadcastFullState()` added after ALL state changes in upload.ts — UI now updates in real-time
- "Videos Uploaded" vs "All Media Uploaded" status labels

### Photo Import
- Recursive JPEG scan — finds photos in DCIM subfolders (100LUMIX/, 224_PANA/, etc.)
- Photos saved to routine's existing outputDir, not app install directory
- Photo state updates routine rows via broadcastFullState
- Import results shown via confirm dialog (not auto-open sorter)
- DriveAlert modal dismissable while working ("Background" button)
- Import is non-blocking (fire-and-forget with progress events)

### Overlay System
- Overlay browser source URL shown in Settings with Copy button
- Visual Editor (drag/drop layout customizer) ported from BroadcastBuddy
- Layout positions applied via WebSocket (no OBS page reload needed)
- Fire LT blocked when no routine selected

### FFmpeg / Recording
- 15-minute hard recording limit (auto-stops)
- Judge video resolution setting (same/720p/480p)
- NVENC hardware encoding toggle (DART has mobile 3060)

### Stream Deck
- Native plugin already existed — built and deployed to DART
- Fixed category name from "CUSTOM" to "CompSync Media" in manifest

## Build & Deploy
- Deploy path: `scp -r release/win-unpacked/* 'dart:/mnt/c/Program Files/CompSync Media/'`
- MUST close app before deploying (locked exe files cause permission errors, previous deploy killed app mid-encoding)
- Stream Deck plugin: `streamdeck-plugin/com.compsync.streamdeck.sdPlugin/` → `AppData/Roaming/Elgato/StreamDeck/Plugins/`

## Known Bugs & Issues
- Thumbnail generation failing: `TypeError: A boolean was expected` in sharp (minor — photos copy fine)
- Settings button clipped at header right edge when all elements visible
- Stream Deck plugin needs to be bundled with installer for production
- Overlay visual editor save needs testing with OBS
- 4 stale "Born To Entertain" upload jobs were manually cleared (18.8GB files exceeded R2 5GB PUT limit)

## Not Yet Committed
- All changes are uncommitted (25 files, +383/-157 lines)

## Next Steps
1. Test photo import with SD card (recursive scan + state update)
2. Test NVENC encoding on DART's 3060
3. Test judge resolution downscale (720p/480p)
4. Test cancel/retry buttons on upload rows
5. Bundle Stream Deck plugin with installer
6. Fix sharp thumbnail TypeError
7. Full human operator test per HUMAN_TEST_CHECKLIST.md
