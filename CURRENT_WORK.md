# CompSync Media — v2.5.0 (Released)

## What shipped

**Stability & Pipeline Rewrite (backend):**
1. Persistent job queue — jobQueue.ts replaces in-memory arrays
2. State hardening — ID-based routine tracking, debounced atomic writes
3. Settings deep merge — missing keys filled from defaults
4. FFmpeg rewrite — 10min timeout, PID tracking, orphan kill, temp cleanup
5. Upload rewrite — awaited loop, abort cleanup, scaled timeout, per-file jobs
6. Error handling — crash dialog + flush, graceful shutdown, OBS event cleanup
7. WS heartbeat — readyState check, command error boundary
8. Overlay toggle — auto-hide timer canceled on manual dismiss
9. IPC cleanup — listener cleanup function from initIPCListeners
10. Crash recovery — async ops, temp cleanup, prefix-aware orphan detection
11. Import handlers — drag-drop file import, folder scan with entry# matching
12. Job queue IPC — get/retry/cancel handlers for UI management
13. Startup validation — FFmpeg check, disk space, output dir, job resume report
14. File lock retry — 500ms interval retry loop
15. Async file ops — archiveExistingFiles, mkdir, rename all async

**UI + Polish (renderer):**
16. Import drop zones — drag-drop video files onto routine rows
17. Import Video button — toolbar button for folder-based import
18. Job queue status panel — collapsible panel with running/queued/failed counts
19. Retry/cancel buttons — for failed jobs in queue panel
20. Startup report toast — auto-dismissing notification showing system check results
21. Preload API — importFile, importFolder, jobQueueGet/Retry/Cancel, removeAllListeners

## Known Bugs

(none currently tracked)
