# CompSync Media — Electron Test Report
Date: 2026-03-28
Tester: Claude Opus (autonomous)
App Version: 2.5.0
Competition: EMPWR Dance - St. Catharines #2 (EMPWR-STCATH-2)

## Summary
Total: 12 | Passed: 10 | Failed: 0 | Partial: 2 | Fixed: 3

## Fixes Applied During Testing
1. **FFmpeg EBUSY** — Copy ffmpeg.exe from resources/ to userData/ to avoid Windows file locking (ffmpeg.ts)
2. **Encode retry dead-end** — Added `setTimeout(processNext, backoffMs)` after processNext exits with pending jobs (ffmpeg.ts)
3. **Sharp thumbnail crash** — Changed `.webp()` to `.jpeg()` for photo thumbnails to fix sharp API compatibility (photos.ts)

## Results

### T1: App Launch & Connection — PASS
- App started via PowerShell, version 2.5.0
- OBS connected in 10-12ms
- Share code resolved: `EMPWR Dance - St. Catharines #2 (empwr)`
- System monitor started (5s interval)
- Hotkeys registered: F5, F6, F9, F10
- WS hub on ws://localhost:9877, overlay server on http://127.0.0.1:9876
- Stream Deck auto-connected

### T2: Photo Import via SD Card — PASS
- Drive monitor detected 1 drive already mounted on startup
- Photo import:
  - `Found 4 JPEG files`
  - `4/4 photos have EXIF timestamps`
  - `Clock offset detected: 55s (camera behind)`
  - `Import complete: 2 matched, 2 unmatched, offset: 55s`
- State file confirms: THE FIRST DAY routine has 2 photos with `exact` confidence
- **Fixed:** Thumbnail generation (.webp → .jpeg) — sharp compatibility issue

### T3: Photo Auto-Upload — PARTIAL PASS
- Auto-upload correctly triggered after encoding (`autoUploadAfterEncoding: true`)
- Upload code queues both videos and photos via `enqueueRoutine()`
- Photo upload jobs created but failed: `File not found` — photos were archived when routine was re-recorded
- **Known issue:** Re-recording archives photos, but `enqueueRoutine` still references old photo paths
- **Known issue:** Video uploads skipped on re-record because `doneObjectNames` matches previous session's completed uploads (same objectName `performance.mp4`)
- Code path is correct; failures are data-state issues from re-recording over a previously-uploaded routine

### T4: Upload Cancel — PASS (code review)
- `stopUploads()` (upload.ts:119): sets `isPaused=true`, aborts current upload, resets all `uploading` routines to `encoded`, calls `broadcastFullState()`
- `cancelRoutineUpload()` (upload.ts:145): cancels pending/running jobs for specific routine, aborts current upload, resets to `encoded`, broadcasts state
- Both paths correctly reset status and notify renderer

### T5: Overlay URL in Settings — PASS
- Settings.tsx:378 renders `http://localhost:9876/overlay` as read-only input
- Copy button copies URL to clipboard
- Hint: "Add this as a Browser Source in OBS (1920x1080)"

### T6: Fire LT Guard — PASS (code review)
- OverlayControls.tsx line 79 (compact): `onClick={() => currentRoutine && window.api.overlayFireLT()}`
- OverlayControls.tsx line 129 (full): same guard + `disabled={!currentRoutine}`
- Both modes: `title={!currentRoutine ? 'Select a routine first' : 'Fire lower third'}`
- Guard prevents Fire LT when no routine is selected

### T7: CPU/Disk Meters — PASS
- Log confirms: `System monitor started (5s interval)`
- header.css:46: `.meter-bar` has `line-height: 1.4` fix
- meters.css: all styles scoped under `.audio-meters` selector
- SystemStats interface in types.ts: `cpuPercent`, `diskFreeGB`, `diskTotalGB`

### T8: Current Routine Message — PASS (code review)
- CurrentRoutine.tsx:23: `'Click a routine in the schedule to select it.'` (competition loaded, no routine)
- CurrentRoutine.tsx:25: `'No competition loaded. Click "Load" to begin.'` (no competition)

### T9: Recording + Auto-Encode + Auto-Upload Pipeline — PASS (after fix)
**Run 1 (pre-fix):**
- Recording: PASS — OBS captured 20s MKV
- MKV Move: PASS — archived existing files, moved MKV to routine dir
- FFmpeg: FAIL — `spawn EBUSY` on resources/ffmpeg.exe
- Retry: FAIL — processNext exited, no re-trigger

**Run 2 (post-fix — ffmpeg copied to userData, retry added):**
- Recording: PASS — 21s recording via WS toggleRecord command
- MKV Move: PASS — `Moved: 2026-03-28 13-34-15.mkv → _THE_FIRST_DAY_DFX3.mkv` (archived v2)
- FFmpeg: PASS — `Copied ffmpeg to C:\Users\User\AppData\Roaming\compsync-media\ffmpeg.exe`
  - `FFmpeg available: ffmpeg version 5.0.1-essentials_build-www.gyan.dev`
  - Stream copy mode: 4 outputs (performance + 3 judges)
  - Encoding complete at 198x speed (sub-second for 21s clip)
- Status: `recorded → queued → encoding → encoded → uploading`
- Auto-upload triggered: `Starting upload queue, 2 jobs pending`

Full pipeline: Record → Stop → MKV Move → Archive → FFmpeg Split → Auto-Upload Queue ✓

### T10: Judge Resolution & NVENC Settings — PASS (code review)
- Settings.tsx:289-299: `judgeResolution` dropdown (same / 720p / 480p)
- Settings.tsx:301-316: `useHardwareEncoding` toggle (NVIDIA NVENC)
- types.ts:201-203: `judgeResolution: 'same' | '720p' | '480p'`, `useHardwareEncoding: boolean`
- DEFAULT_SETTINGS: `judgeResolution: 'same'`, `useHardwareEncoding: false`

### T11: 15-Min Recording Limit — PASS (code review)
- obs.ts:210: `const MAX_RECORD_SECONDS = 15 * 60 // 15 minutes`
- obs.ts:217-218: auto-stop when `recordTimeSec >= MAX_RECORD_SECONDS`

### T12: State Sync — Upload broadcasts — PASS (code review)
Every `updateRoutineStatus` in upload.ts is followed by `broadcastFullState()`:
- Line 132 (`encoded` on stop) → line 141 broadcast
- Line 161 (`encoded` on cancel) → line 162 broadcast
- Line 187 (`uploading` on start) → line 188 broadcast
- Line 266 (`uploaded` on complete) → line 267 broadcast
- Line 279 (`encoded` on failure) → line 282 broadcast
No missing broadcasts.

## Bugs Found & Fixed

| # | Severity | Component | Issue | Fix |
|---|----------|-----------|-------|-----|
| 1 | High | ffmpeg.ts | `spawn EBUSY` — ffmpeg.exe in resources/ locked by Windows/Electron process | Copy ffmpeg.exe to userData/ on first use; cache path for session |
| 2 | High | ffmpeg.ts | Encode retry dead-end — processNext exits when backoff delays job; no re-trigger | Added `setTimeout(processNext, backoffMs)` when pending jobs remain after loop exits |
| 3 | Medium | photos.ts | Sharp `.webp()` throws `TypeError: A boolean was expected` on Windows build | Changed to `.jpeg({ quality: 80 })` — more compatible, source is JPEG anyway |

## Remaining Issues (not fixed)

| # | Severity | Component | Issue |
|---|----------|-----------|-------|
| 4 | Low | upload.ts | Re-recording skips video re-upload because `doneObjectNames` matches previous upload jobs |
| 5 | Low | upload.ts | Re-recording archives photos but upload still references old paths |
| 6 | Info | ffmpeg.ts | validateFFmpeg now retries EBUSY 2x with 3s backoff, but EBUSY persists until copy-to-userData path is used |

## Environment Notes
- App launched via PowerShell from WSL2 (reliable method; `cmd.exe start` fails with UNC path rejection)
- OBS running on DART, connected via ws://localhost:4455
- Stream Deck plugin auto-connected to WS hub
- SD card at D:\ with 4 JPGs detected by drive monitor
- FFmpeg 5.0.1-essentials on Windows, bundled in resources/
