# Event-Day Hardening Fixes — 2026-04-15

## Summary

- tsc: PASS (exit 0)
- build: PASS (electron-vite build — main, preload, renderer all built)
- No files from prior dirty working tree were modified.
- No commits, no pushes.

## Fix-by-fix Status

| # | Fix | Status | Notes |
|---|-----|--------|-------|
| 1 | 15-min auto-stop → warning only | PASS | Fires IPC `recording:max-warning` once per session; `stopRecord()` no longer auto-called. |
| 2 | Block record on blank/unwritable output dir | PASS | `canStartRecording()` wired into `OBS_START_RECORD` IPC and into `nextFull`/`next`. |
| 3 | Dev build banner | PASS | Main sends `app:dev-build-warning` after window ready; renderer banner dismissable per session. |
| 4 | Immediate save on `uploaded`/`encoded` | PASS | One-line extension of conditional in `updateRoutineStatus`. |
| 5 | Windows elevation gate | PASS | Dialog + `app.exit(1)` before any window creation. Bypass via `behavior.allowNonElevated`. |
| 6 | Clean OBS sentinel on startup | PASS | Cleans `%APPDATA%\obs-studio\safe_mode` and legacy `.sentinel`. |
| 7 | powerSaveBlocker + sync folder + battery warnings | PASS | `powerSaveBlocker.start('prevent-display-sleep')` at ready, release at before-quit. Sync folder + wmic battery checks added to `runStartupChecks`. StartupReport now carries `warnings: string[]`. |
| 8 | Live disk threshold alerts + record-time gate | PASS | `systemMonitor.poll()` classifies disk with hysteresis, fires `disk:space-alert` on transitions, and calls `uploadService.pauseForDiskSpace/resumeFromDiskSpace`. `canStartRecording()` also blocks <5GB. |
| 9 | Drive disconnect detection + recovery | PASS | `systemMonitor` fires `drive:lost` / `drive:recovered`, toggles `pauseForDriveLoss` on upload + ffmpeg. |
| 10 | Share code confirmation dialog | PASS | `LoadCompetition.tsx` — `window.confirm()` when current competition is loaded and code differs. |
| 11 | OBS watchdog + disconnect reconciliation | PASS | Watchdog interval fires `recording:alert` for disconnects / silent stops / stuck recordings. `syncState()` reconnect path calls `handleObsReconcile` which salvages orphan MKVs or flips routine to new `recording_interrupted` status. |
| 12 | Rolling state backups + fallback load | PASS | Rolling `.bak-<ts>` in `doSave`, prune above 15 keep 10. `loadState()` falls through to newest parseable backup. Renderer IPC `state:recovered-from-backup`. |
| 13 | Rolling settings backups + secondary Documents copy | PASS | Debounced 250ms backup in `getSettings()`, keep 5. Secondary copy at `~/Documents/CompSync/settings-backup.json`. Corruption branch now attempts restore before `store.clear()`. |
| 14 | Black-frame / silent-audio detection | PASS | Silence: on `InputVolumeMeters` event, fire `recording:alert` after >5s flat-line. Black frames: 10s interval pulls `GetSourceScreenshot` at 64×36 JPG and decodes via `sharp` to compute mean brightness. Alerts after 2 consecutive black frames. Both monitors stopped on `stopRecordingTimer`. |
| 15 | Stale renderer bundle detection | PASS | Dev-only check at startup: compares `out/main/index.js` mtime vs `out/renderer/assets/*.js`. Warns via `app:dev-build-warning` channel when main is >60s newer. |
| 16 | (Spec said 16 fixes — #5 double-referenced; FIX 14 covers #5) | N/A | As noted in prompt. |

## Files Modified

- `src/shared/types.ts`
- `src/main/index.ts`
- `src/main/ipc.ts`
- `src/main/services/obs.ts`
- `src/main/services/recording.ts`
- `src/main/services/state.ts`
- `src/main/services/settings.ts`
- `src/main/services/startup.ts`
- `src/main/services/systemMonitor.ts`
- `src/main/services/upload.ts`
- `src/main/services/ffmpeg.ts`
- `src/renderer/App.tsx`
- `src/renderer/components/LoadCompetition.tsx`

## New IPC Channels

Added to `IPC_CHANNELS` in `src/shared/types.ts`:

- `RECORDING_MAX_WARNING` = `'recording:max-warning'`
- `RECORDING_BLOCKED` = `'recording:blocked'`
- `RECORDING_ALERT` = `'recording:alert'`
- `DEV_BUILD_WARNING` = `'app:dev-build-warning'`
- `DISK_SPACE_ALERT` = `'disk:space-alert'`
- `DRIVE_LOST` = `'drive:lost'`
- `DRIVE_RECOVERED` = `'drive:recovered'`
- `STATE_RECOVERED_FROM_BACKUP` = `'state:recovered-from-backup'`

## New Types / Fields

- `RoutineStatus` union extended with `'recording_interrupted'`.
- `AppSettings.behavior.allowNonElevated: boolean` (default `false`).
- `StartupReport.warnings: string[]`.

## Decisions Not Obvious From Spec

- **OBS sentinel path**: Modern OBS (v30+) uses `safe_mode` file, not `.sentinel`. I clean both for robustness.
- **Black-frame decode**: I used `require('sharp')` lazily inside the interval to avoid any module-init-time coupling and to sidestep circular-import risk.
- **Watchdog fires reconcile on its own**: Rather than waiting only for OBS reconnect, the watchdog also triggers `reconcileOrphanedRecording()` when it detects OBS has silently stopped. This covers the failure case where the operator kills OBS manually and it never recovers.
- **`handleObsReconcile` is exported from recording.ts**: Wired from `index.ts` via `obs.setOnReconcile(...)` to avoid `obs` importing `recording` (which would be circular).
- **Dev-build banner uses the same IPC channel for stale bundle warning**: Both are dev-only banners; reusing `DEV_BUILD_WARNING` avoids adding another channel for a near-identical UI.
- **Share code confirm uses `window.confirm`, not a modal**: Matches the rest of the renderer's terse style — a native confirm is accepted by Electron and follows the spec's "not typed confirmation — that's too annoying for typo corrections".
- **State backup prune threshold is 15 keep 10**: matches the spec instruction "don't prune on every save … only prune when there are > 15 backups".
- **Settings backup is debounced 250ms**: `getSettings()` can be called many times per tick. Debouncing prevents a burst of `.bak-<ts>` files.
- **Power save blocker mode is `prevent-display-sleep`**: matches the spec; this also prevents system sleep on Windows for most scenarios.
- **Disk alert hysteresis**: I used a single `lastDiskAlertLevel` state with an explicit rule — only re-alert when classification changes; only clear to `ok` when free GB >= 60 AND previously in alert.
- **`canStartRecording()` uses `statfsSync` on the configured dir directly**: Matches the pattern used in `startup.ts`. On Windows it already passes the raw path; `systemMonitor.ts`'s drive-root heuristic was not duplicated here since `statfsSync` with a directory path works on modern Node.
- **Watchdog disconnect alert cooldown 30s**: avoids banner spam during long disconnects.

## Known-Good-But-Untested Aspects

- **Elevation check**: Not executed on Linux dev host (always returns true). The `execSync('net session')` path is Windows-only and was not runtime-tested.
- **Battery check (wmic)**: Windows-only. Not runtime-tested on this Linux dev machine.
- **OBS reconcile salvage path**: The file-scan logic (`reconcileOrphanedRecording`) was not exercised — needs a real OBS disconnect during a live recording to verify.
- **Black-frame detection**: `sharp` raw decode path compiles and types cleanly, but pixel-brightness threshold (<5) was chosen without photographic calibration. May need tuning.
- **Silent audio**: Threshold `0.001` was chosen from the existing meter envelope. May false-positive on quiet mics in an empty room.
- **Settings backup secondary path**: `~/Documents/CompSync/settings-backup.json` creation was not runtime-tested; directory creation is guarded but permissions on Windows `%USERPROFILE%\Documents` should be fine.
- **Drive-lost detection**: Uses `fs.existsSync` + `statfsSync` failure; does not distinguish "drive unplugged" from "network share temporarily slow". May false-positive on NAS output directories during brief outages.
- **Stale bundle check**: Uses `out/main/index.js` vs `out/renderer/assets/*.js` mtimes. In packaged builds `app.isPackaged` is true so it is skipped — correct.

## Build Output

```
> compsync-media@2.7.0 build
> electron-vite build

out/main/index.js  353.12 kB
out/preload/index.js  14.13 kB
out/renderer/index.html                   0.39 kB
out/renderer/assets/index-KkZiwxUY.css   87.60 kB
out/renderer/assets/index-BvVXe_FO.js   492.83 kB
```

All three bundles compiled. The pre-existing `schedule.ts` dynamic/static import warning is unchanged.
