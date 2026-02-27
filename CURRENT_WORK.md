# Next Build — v2.5.0

## Completed (Stability & Pipeline Rewrite)

All 27 audit issues addressed across 6 batches:

1. **Persistent job queue** — jobQueue.ts replaces in-memory arrays in ffmpeg/upload
2. **State hardening** — ID-based routine tracking, debounced atomic writes
3. **Settings deep merge** — missing keys filled from defaults, atomic migrations
4. **FFmpeg rewrite** — 10min timeout, PID tracking, orphan kill, temp cleanup
5. **Upload rewrite** — awaited loop, abort cleanup, scaled timeout, per-file jobs
6. **Error handling** — crash dialog + flush, graceful shutdown, OBS event cleanup
7. **WS heartbeat** — readyState check, command error boundary
8. **Overlay toggle** — auto-hide timer canceled on manual dismiss
9. **IPC cleanup** — listener cleanup function returned from initIPCListeners
10. **Crash recovery** — async ops, temp cleanup, prefix-aware orphan detection
11. **Import handlers** — drag-drop file import, folder scan with entry# matching
12. **Job queue IPC** — get/retry/cancel handlers for UI management
13. **Startup validation** — FFmpeg check, disk space, output dir, job resume report
14. **File lock retry** — 500ms interval retry loop (was hardcoded 2s wait)
15. **Async file ops** — archiveExistingFiles, mkdir, rename all async

## Remaining (UI + Polish)

- Import drop zones on routine rows (renderer)
- Import toolbar button + confirmation dialog
- Job queue status panel (pending/running/failed counts)
- Retry/cancel buttons for failed jobs
- Startup report notification in UI

## Known Bugs

(none currently tracked)
