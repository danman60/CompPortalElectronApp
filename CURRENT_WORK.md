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

**Code review fixes (round 1):**
22. Header importFolder crash — settingsBrowseFile→settingsBrowseDir
23. IPC listener leak — cleanup captured and returned from useEffect
24. importConfirm dead code — removed from preload and types
25. Magic string channel — APP_STARTUP_REPORT added to IPC_CHANNELS
26. file.path type safety — guarded cast in RoutineTable drag-drop

**Production safety (round 2 — showstoppers + high-risk):**
27. storagePaths persistence — storagePath saved in job payload for plugin/complete
28. nextFull race — event-driven waitForRecordStop() replaces 1.5s sleep
29. OBS auto-reconnect — ConnectionClosed triggers scheduleReconnect()
30. Upload abort stall — reject() called on abort signal
31. FFmpeg cancel zombie — local var ref pattern for SIGKILL timer
32. Recording attribution — no getCurrentRoutine() fallback, logs error + preserves raw file

**Medium/low hardening (round 3):**
33. FFmpeg processNext — recursive → iterative while loop
34. Job queue pruning — startup (24h) + hourly auto-prune
35. Audio meter throttle — InputVolumeMeters IPC limited to ~15Hz
36. Async file lock — fs.promises.open instead of openSync
37. Archive version — max+1 instead of count+1
38. Startup order — state.loadState() before createWindow()
39. Single Date instance — buildFileName consistency
40. OBS disconnect — await with 3s timeout on shutdown

**Production hardening (round 4):**
41. Cross-drive rename — copy+delete fallback on EXDEV error
42. Fetch timeouts — 30s AbortController on all API calls
43. Navigation debounce — navBusy guard on next()/nextFull()
44. Upload completion recovery — callPluginComplete failure → 'encoded' + error msg
45. Server security — overlay + WebSocket bound to 127.0.0.1
46. Photo EXIF memory — read 128KB header instead of entire file
47. systemMonitor cleanup — stopMonitoring() on shutdown
48. Manual encode dir — uses routine.outputDir, not path derivation

## Known Bugs

(none currently tracked)
