# Current Work - CompSync Electron App

## Last Session Summary
Major feature session spanning Mar 30 - Apr 1. Built post-event recovery mode, 3-pane layout, full overlay system (9 animations, ticker, starting soon), tethered photo capture (USB mass storage + MTP/PTP via WPD helper), and applied 5 critical safety fixes to the recording/upload/state pipeline.

## What Changed
- `c3cc4b1` feat: v2.6.0 — overlay system, 3-pane layout, tethered photos, recovery mode (34 files, +3701)
- `0ce5053` fix: WPD helper compile errors (COM activation, dynamic dispatch, type inference)
- `cdb3388` fix: 5 critical safety fixes — recording race, upload safety, state decoupling, tether offset, async photos (16 files, +700/-393)

## Build Status
PASSING — last build deployed to DART at 2026-03-31, app running v2.6.0

## Safety Fixes Applied
1. `next()` recording stop barrier — prevents routine mis-attribution
2. Upload `enqueueRoutine()` returns structured result — safe without share code
3. State file always in `app.getPath('userData')` — output dir change can't lose progress
4. Tether clock offset applied before matching — prevents silent mis-sorts
5. Photo import async with event loop yields — won't block operator UI

## Known Issues
- Visual editor drag targets are half-scale approximations of 1920px overlay elements
- WPD helper is polling-based MVP, not COM event-driven yet
- No UI banner for "uploads disabled — no share code"

## Next Steps (priority order)
1. Hardware test on DART with OBS — full recording + encoding + upload flow
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
