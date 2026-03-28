# Test Plan — CompSync Media Electron App

## App Description
Competition media recording/processing/upload desktop app. Controls OBS for multi-camera recording, splits audio tracks per judge via FFmpeg, uploads to CompPortal via R2, imports photos from SD cards, serves an overlay for OBS browser source.

## App Type
Electron (Windows x64)

## Installed At
`C:\Program Files\CompSync Media\CompSync Media.exe` on DART

## Supabase Project
`supabase-COMPSYNC` (CompPortal DB — used for upload verification only)

## Auth
Bearer token via `plugin_api_keys` table. Share code resolves credentials on startup.

## Test Environment
- **Host:** SpyBalloon (Ubuntu 24.04) — source code, build, SSH to DART
- **Target:** DART (Windows 11, WSL2) — runs the Electron app
- **SSH alias:** `dart`
- **OBS:** Running on DART, ws://localhost:4455
- **WS Hub:** ws://localhost:9877 on DART
- **Overlay:** http://localhost:9876/overlay on DART
- **Logs:** `ssh dart 'cat /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'`
- **State:** `ssh dart 'cat /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json'`
- **Job Queue:** `ssh dart 'cat /mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json'`

## How to Interact
1. **Start app:** `ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'`
2. **Kill app:** `ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F"'`
3. **Send WS command:** `ssh dart 'node -e "const ws=new(require(\"ws\"))(\"ws://localhost:9877\");ws.on(\"open\",()=>{ws.send(JSON.stringify({type:\"identify\",client:\"test\"}));ws.send(JSON.stringify(COMMAND));setTimeout(()=>ws.close(),1000)})"'`
4. **Read logs:** `ssh dart 'tail -N /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'`
5. **Read state:** Parse JSON state file via SSH + python

## Routine Status Lifecycle
```
pending → recording → recorded → queued → encoding → encoded → uploading → uploaded → confirmed
         ↕ skipped                                    ↕ failed (any stage)
```

## Test Flows (execution order)
1. `flow-01-startup.md` — App launch, OBS connect, competition load, state restore
2. `flow-02-recording-pipeline.md` — Record → encode → upload full lifecycle with state verification at every transition
3. `flow-03-photo-import.md` — SD card detection, recursive scan, EXIF matching, clock offset, state update, auto-upload
4. `flow-04-upload-management.md` — Cancel, retry, pause, resume, re-record cleanup, 5GB limit guard
5. `flow-05-overlay-system.md` — Toggle elements, fire/hide LT, layout persistence via WS, animation selection
6. `flow-06-ws-commands.md` — All WebSocket commands from Stream Deck/remote, state broadcasts
7. `flow-07-error-resilience.md` — OBS disconnect mid-record, file locked, upload timeout, corrupt state, crash recovery
8. `flow-08-scale-stress.md` — 700 routine simulation, upload progress performance, state broadcast size, job queue operations
9. `flow-09-settings.md` — All settings groups, NVENC toggle, judge resolution, hotkeys, behavior toggles
10. `flow-10-edge-cases.md` — Re-record over uploaded routine, skip/unskip during recording, simultaneous encode+upload, 15min recording limit

## Verification Methods
| Method | Use For |
|--------|---------|
| Log grep | State transitions, error detection, timing |
| State JSON | Routine status, photos array, encoded files |
| Job queue JSON | Upload/encode job status, attempt counts |
| WS state message | Real-time state, overlay, counts |
| Supabase SQL | Upload verification on CompPortal side |
| File system check | MKV/MP4 existence, photo copies, thumbnails |

## Pre-flight Checklist
- [ ] OBS running on DART and connected
- [ ] Competition loaded (share code EMPWR-STCATH-2)
- [ ] Output directory set in settings
- [ ] Auto-encode ON
- [ ] Auto-upload ON
- [ ] At least 2 cameras configured in OBS
- [ ] FFmpeg available (startup log confirms)
