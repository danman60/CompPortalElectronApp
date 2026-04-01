# Current Work - CompSync Electron App

## Last Session Summary
Fixed 4 bugs from code audit + 7 production safety fixes. Full audit completed. Deployed to DART.

## What Changed
- `1f69ae6` fix: 11 production safety fixes — upload targeting, recovery multi-file, encoding guards, disk monitoring
- `a560798` chore: update CURRENT_WORK.md — session wrap-up
- `cdb3388` fix: 5 critical safety fixes — recording race, upload safety, state decoupling, tether offset, async photos

## Build Status
PASSING — deployed to DART at 2026-04-01, app running v2.6.0

## Fixes Applied This Session
1. Upload cancel targets correct routine (was killing wrong upload)
2. Recovery splits from correct MKV via sourceFileIndex (was hardcoded [0])
3. Crash recovery looks up routine by entry number (was using folder name as ID)
4. OBS max record time configurable (was hardcoded 15min)
5. Pre-encode disk space check (~2x input file)
6. Audio track validation + auto-clamp judgeCount
7. NVENC auto-fallback to libx264
8. Job queue flushSync on enqueue (crash-safe)
9. retryOrphanedCompletions() on startup
10. Temp judge video cleanup in crash recovery
11. Disk meter glow indicator (yellow <10GB, red <2GB)

## Known Issues
- Visual editor drag targets are half-scale approximations of 1920px overlay elements
- WPD helper is polling-based MVP, not COM event-driven yet
- No UI banner for "uploads disabled — no share code"

## Next Steps (priority order)
1. Hardware smoke test on DART with OBS — full recording + encoding + upload flow
2. Test overlay in OBS browser source
3. Test camera tethering with real camera
4. Add upload-disabled UI banner
5. Test recovery mode with actual MKV

## Gotchas
- Hot update to DART requires BOTH app.asar AND CompSync Media.exe
- DART Desktop is OneDrive: `C:\Users\User\OneDrive\Desktop\`
- npm install needs `--force` on Linux (sharp win32 platform constraint)
- WPD helper built on DART (.NET 8), exe at `C:\Program Files\CompSync Media\resources\wpd-helper.exe`
- UDC-LONDON share code active, 526 routines
