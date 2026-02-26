# Stability & Pipeline Rewrite Design

**Date:** 2026-02-26
**Scope:** Comprehensive pipeline rewrite + stability hardening + recovery features
**Approach:** Replace in-memory job processing with persistent, crash-safe pipeline

---

## Context

CompSync Media is a live-event mission-critical controller. A full audit found 27 stability issues across the codebase. Rather than surgical fixes, this design replaces the core recording→encoding→upload pipeline with a durable, crash-recoverable architecture.

**Key principles:**
- No job is ever lost (write-ahead persistence)
- Every async operation has a timeout
- Every process has cleanup
- App restart resumes exactly where it left off
- Operator can manually feed recordings into the pipeline

---

## Audit Summary (27 Issues)

### Critical (5)
1. **FFmpeg hangs forever** — no timeout on spawn (ffmpeg.ts:266)
2. **Upload promise chain breaks silently** — recursive call not awaited (upload.ts:207)
3. **2s hardcoded file lock wait** — rename fails on slow disks (recording.ts:196)
4. **AbortController never cleaned** — wrong upload aborted (upload.ts:241)
5. **Crash recovery misses partial encodes** — only scans for MKV without ANY MP4 (crashRecovery.ts:35)

### High (10)
6. **No FFmpeg process timeout** — queue blocks indefinitely (ffmpeg.ts:266)
7. **State persistence on every update** — no debounce, I/O spikes (state.ts:126)
8. **WebSocket heartbeat pings dead sockets** — no readyState check (wsHub.ts:63)
9. **Synchronous file ops block main thread** — renameSync, readdirSync in loops (recording.ts:100)
10. **OBS event listeners never removed** — duplicate on reconnect (obs.ts:243)
11. **Upload never sets routine status to 'uploading'** — state mismatch (upload.ts:46)
12. **Uncaught exceptions continue running** — no dialog, no shutdown (index.ts:15)
13. **No validation of routine index on jump** — index/visible array mismatch (state.ts:143)
14. **Settings migration not atomic** — half-migrated on crash (settings.ts:46)
15. **No FFmpeg path validation at startup** — cryptic spawn error (ffmpeg.ts:19)

### Medium (8)
16. Preview polling timer stacks on repeated calls (obs.ts:306)
17. Photo import has no error handling on copy/sharp (photos.ts:152)
18. Overlay auto-hide timer not canceled on toggle (overlay.ts:74)
19. Recording timer has no overflow cap (obs.ts:175)
20. Settings defaults not deeply merged — one bad key nukes all (settings.ts:31)
21. Renderer IPC listeners stack on hot reload (useStore.ts:177)
22. Zoom save timer fires after window destroyed (ipc.ts:400)
23. OBS reconnect timer — actually OK, included for completeness

### Low (4)
24. WebSocket double-delete on close+error — harmless (wsHub.ts:36)
25. No bounds on reconnect attempts counter (obs.ts:113)
26. Logger doesn't rotate or cap file size
27. No disk space check before encoding

---

## Section 1: Persistent Job Queue

**New file:** `src/main/services/jobQueue.ts`

Replaces the in-memory arrays in ffmpeg.ts (`queue: FFmpegJob[]`) and upload.ts (`queue: RoutineUploadState[]`).

### Data Model

```typescript
interface JobRecord {
  id: string                    // uuid
  type: 'encode' | 'upload' | 'photo-import'
  routineId: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  maxAttempts: number           // default 3
  payload: Record<string, unknown>  // FFmpegJob | UploadPayload | PhotoPayload
  createdAt: string             // ISO
  updatedAt: string             // ISO
  error?: string                // last error message
  progress?: number             // 0-100 for UI
}
```

### Persistence

- **File:** `{userData}/job-queue.json`
- **Write strategy:** Atomic write (write to `.tmp`, then rename — atomic on NTFS/ext4)
- **Debounced:** 500ms debounce on writes. Immediate flush on `running` → any transition.
- **On startup:** Load file, reset any `running` jobs to `pending` (they were interrupted)

### API

```typescript
// Core operations
enqueue(type, routineId, payload, maxAttempts?): JobRecord
updateStatus(jobId, status, error?): void
getNext(type): JobRecord | null       // oldest pending job of type
getByRoutine(routineId): JobRecord[]  // all jobs for a routine
pruneCompleted(olderThanMs): void     // cleanup done jobs

// Query
getPending(type?): JobRecord[]
getRunning(type?): JobRecord[]
getFailed(type?): JobRecord[]
getAll(): JobRecord[]
```

### Retry Logic

- Failed jobs with `attempts < maxAttempts` stay in queue as `pending`
- Backoff: `Math.min(5000 * 2^attempts, 60000)` ms before next attempt
- After `maxAttempts` exhausted: status = `failed`, operator notified via renderer IPC
- Operator can manually retry failed jobs from UI (resets attempts to 0)

---

## Section 2: FFmpeg Process Manager

**Rewrite:** `src/main/services/ffmpeg.ts`

### Changes

1. **Timeout on every FFmpeg spawn** — default 10 minutes per track, configurable
2. **PID tracking** — write active FFmpeg PID to `{userData}/ffmpeg.pid` so crash recovery can kill orphans
3. **Graceful cancel** — send SIGTERM, wait 5s, then SIGKILL
4. **Progress parsing** — parse FFmpeg stderr for `time=` to report real progress (not just track count)
5. **Queue driven by jobQueue** — no more internal array. `processNext()` calls `jobQueue.getNext('encode')`
6. **Temp file cleanup** — on error or cancel, delete `_temp_video.mp4` and partial outputs

### Process Lifecycle

```
enqueue → jobQueue.enqueue('encode', ...)
         → processNext() picks it up
         → jobQueue.updateStatus(id, 'running')
         → write PID to ffmpeg.pid
         → spawn with timeout
         → on success: jobQueue.updateStatus(id, 'done'), delete PID file
         → on error: jobQueue.updateStatus(id, 'failed', err), cleanup temps
         → on timeout: kill process, treat as error
         → processNext() (awaited this time)
```

### Timeout Implementation

```typescript
function spawnFFmpeg(path, args, timeoutMs = 600000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(path, args, opts)
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL') }, 5000)
      reject(new Error(`FFmpeg timed out after ${timeoutMs/1000}s`))
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`FFmpeg exit code ${code}`))
    })
  })
}
```

### Crash Recovery (on startup)

1. Read `ffmpeg.pid` — if exists, kill that PID (orphaned FFmpeg from previous crash)
2. jobQueue resets `running` encode jobs to `pending`
3. Scan output dirs for `_temp_video.mp4` — delete them (partial smart-encode artifacts)
4. Auto-start processing if pending jobs exist

---

## Section 3: Upload Pipeline

**Rewrite:** `src/main/services/upload.ts`

### Changes

1. **Driven by jobQueue** — one upload job per file (not per routine). Granular retry.
2. **Properly awaited processing loop** — `while` loop instead of recursive call
3. **AbortController cleanup** — nulled after each upload completes
4. **Routine status sync** — `state.updateRoutineStatus(id, 'uploading')` called when first file starts
5. **Timeout per upload** — 5 minutes per file default, scales with file size
6. **Resume support** — if server supports `Content-Range`, resume partial uploads

### Processing Loop

```typescript
async function processLoop(): Promise<void> {
  while (!isPaused) {
    const job = jobQueue.getNext('upload')
    if (!job) { isUploading = false; return }

    jobQueue.updateStatus(job.id, 'running')
    state.updateRoutineStatus(job.routineId, 'uploading')

    try {
      await uploadFile(job)
      jobQueue.updateStatus(job.id, 'done')
    } catch (err) {
      jobQueue.updateStatus(job.id, 'failed', err.message)
    } finally {
      currentAbortController = null  // ALWAYS cleanup
    }
  }
}
```

### Upload Timeout

```typescript
const timeoutMs = Math.max(300000, fileSizeBytes / 100000) // min 5min, scale with size
const timer = setTimeout(() => {
  currentAbortController?.abort()
}, timeoutMs)
```

---

## Section 4: File Lock Retry

**Fix in:** `src/main/services/recording.ts`

Replace the hardcoded 2-second wait with a retry loop:

```typescript
async function waitForFileLock(filePath: string, maxWaitMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      // Try opening file exclusively — if OBS still has it, this throws
      const fd = fs.openSync(filePath, 'r+')
      fs.closeSync(fd)
      return // file is free
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  throw new Error(`File still locked after ${maxWaitMs/1000}s: ${filePath}`)
}
```

This replaces the `await new Promise(r => setTimeout(r, 2000))` at recording.ts:197.

---

## Section 5: Recovery & Import Features

### 5A: Enhanced Crash Recovery (startup)

**Rewrite:** `src/main/services/crashRecovery.ts`

Current recovery only scans for MKVs without a `performance.mp4`. New version:

1. **Kill orphaned FFmpeg** — read `ffmpeg.pid`, kill if running
2. **Clean temp files** — delete `_temp_video.mp4` in any routine dir
3. **Re-queue interrupted jobs** — jobQueue handles this automatically (running → pending)
4. **Scan for unprocessed MKVs** — MKV exists but no `P_performance.mp4` (using new prefix-aware naming)
5. **Scan for unuploaded MP4s** — encoded files exist but routine status isn't `uploaded`
6. **Report to operator** — show dialog: "Found N interrupted jobs, M unprocessed recordings. Resume?"

### 5B: Manual Import — Drag & Drop

**New IPC channel:** `RECORDING_IMPORT_FILE`

Operator drags an MKV onto a routine row in the UI. Handler:

```typescript
safeHandle(IPC_CHANNELS.RECORDING_IMPORT_FILE, async (routineId, filePath) => {
  const routine = stateService.getRoutine(routineId)
  if (!routine) return { error: 'Routine not found' }

  const routineDir = getRoutineOutputDir(routine)
  fs.mkdirSync(routineDir, { recursive: true })

  // Copy (not move) — operator might want to keep original
  const ext = path.extname(filePath)
  const destPath = path.join(routineDir, `${buildFileName(routine)}${ext}`)
  await fs.promises.copyFile(filePath, destPath)

  state.updateRoutineStatus(routine.id, 'recorded', {
    outputPath: destPath,
    outputDir: routineDir,
  })

  // Auto-encode if enabled
  const settings = getSettings()
  if (settings.behavior.autoEncodeRecordings) {
    jobQueue.enqueue('encode', routine.id, {
      routineId: routine.id,
      inputPath: destPath,
      outputDir: routineDir,
      judgeCount: settings.competition.judgeCount,
      trackMapping: settings.audioTrackMapping,
      processingMode: settings.ffmpeg.processingMode,
      filePrefix: schedule.buildFilePrefix(routine.entryNumber),
    })
  }

  return { success: true, path: destPath }
})
```

### 5C: Manual Import — Folder Scan

**New IPC channel:** `RECORDING_IMPORT_FOLDER`

Operator points at a folder. App scans for video files and matches to routines:

**Matching strategy (in priority order):**
1. Filename contains entry number (e.g. `101_performance.mkv` → routine #101)
2. Filename matches routine title pattern
3. File creation timestamp falls within routine's scheduled time window (+/- 10min)
4. Unmatched files shown in a dialog for manual assignment

```typescript
safeHandle(IPC_CHANNELS.RECORDING_IMPORT_FOLDER, async (folderPath) => {
  const comp = stateService.getCompetition()
  if (!comp) return { error: 'No competition loaded' }

  const videoExts = ['.mkv', '.mp4', '.flv', '.avi', '.mov']
  const files = (await fs.promises.readdir(folderPath))
    .filter(f => videoExts.includes(path.extname(f).toLowerCase()))

  const matches: { file: string, routineId: string, confidence: string }[] = []
  const unmatched: string[] = []

  for (const file of files) {
    const match = matchFileToRoutine(file, comp.routines)
    if (match) {
      matches.push({ file, routineId: match.routine.id, confidence: match.confidence })
    } else {
      unmatched.push(file)
    }
  }

  return { matches, unmatched, folderPath }
  // Renderer shows confirmation UI, then calls RECORDING_IMPORT_FILE for each confirmed match
})
```

### 5D: UI for Import

**In RoutineRow component:**
- Drop zone on each routine row (drag MKV → associates with that routine)
- "Import..." button in toolbar opens folder picker
- Import dialog shows matched files with confidence levels, lets operator confirm/reassign

---

## Section 6: Async File Operations

**Fix in:** `recording.ts`, `state.ts`, `crashRecovery.ts`, `photos.ts`

Replace all synchronous file operations with async equivalents:

| Current (blocking) | Replace with |
|---|---|
| `fs.renameSync(src, dest)` | `await fs.promises.rename(src, dest)` |
| `fs.readdirSync(dir)` | `await fs.promises.readdir(dir)` |
| `fs.mkdirSync(dir, {recursive})` | `await fs.promises.mkdir(dir, {recursive})` |
| `fs.existsSync(path)` | `await fs.promises.access(path).then(()=>true).catch(()=>false)` or keep existsSync for simple checks (it's fast) |
| `fs.statSync(path)` | `await fs.promises.stat(path)` |
| `fs.copyFileSync(src,dst)` | `await fs.promises.copyFile(src,dst)` |
| `fs.writeFileSync(path,data)` | Atomic write: `await fs.promises.writeFile(path+'.tmp', data)` then `await fs.promises.rename(path+'.tmp', path)` |

**Exception:** `fs.existsSync` is acceptable for quick guards since it doesn't do I/O on modern OSes. Convert the rest.

---

## Section 7: State Persistence Hardening

**Fix in:** `src/main/services/state.ts`

### Debounced Writes

```typescript
let saveTimer: NodeJS.Timeout | null = null

function saveState(): void {
  if (saveTimer) return // already scheduled
  saveTimer = setTimeout(() => {
    saveTimer = null
    doSaveState()
  }, 500)
}

function saveStateImmediate(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  doSaveState()
}

async function doSaveState(): Promise<void> {
  const data = JSON.stringify({ currentRoutineIndex, competition: currentCompetition }, null, 2)
  const tmpPath = statePath + '.tmp'
  await fs.promises.writeFile(tmpPath, data)
  await fs.promises.rename(tmpPath, statePath)  // atomic
}
```

- `saveState()` called on routine updates (debounced 500ms)
- `saveStateImmediate()` called on critical transitions: recording start/stop, app closing
- Atomic write prevents corruption

### Index by ID, Not Position

Change `currentRoutineIndex` to `currentRoutineId: string`. On load, find the routine by ID instead of trusting the index. This prevents the wrong-routine-on-jump bug (#13).

---

## Section 8: Error Handling & Crash Safety

### 8A: Uncaught Exception Handler

**Fix in:** `src/main/index.ts`

```typescript
process.on('uncaughtException', (error) => {
  logger.app.error('FATAL uncaught exception:', error.message, error.stack)

  // Flush job queue to disk
  jobQueue.flushSync()

  // Save state immediately
  state.saveStateImmediate()

  // Show dialog to operator
  dialog.showErrorBox(
    'CompSync Media — Critical Error',
    `The app encountered an unexpected error:\n\n${error.message}\n\nYour data has been saved. Please restart the app.`
  )

  app.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.app.error('Unhandled promise rejection:', reason)
  // Don't crash — log and continue. These are non-fatal.
})
```

### 8B: Graceful Shutdown

**Fix in:** `src/main/index.ts`

```typescript
app.on('before-quit', async (e) => {
  e.preventDefault()

  // Cancel active FFmpeg
  ffmpegService.cancelCurrent()

  // Pause uploads (will resume on restart)
  uploadService.stopUploads()

  // Flush state
  await state.saveStateImmediate()
  jobQueue.flushSync()

  // Stop servers
  overlay.stopServer()
  wsHub.stopServer()

  app.exit(0)
})
```

### 8C: Error Boundaries for All Services

Wrap every service's public API with try/catch that logs + doesn't crash:

```typescript
// In wsHub.ts handleCommand:
async function handleCommand(cmd: WSCommandMessage): Promise<void> {
  try {
    switch (cmd.action) { ... }
  } catch (err) {
    logger.app.error(`WebSocket command ${cmd.action} failed:`, err)
  }
}
```

---

## Section 9: Resource Cleanup

### 9A: OBS Event Listeners

**Fix in:** `src/main/services/obs.ts`

Track listeners and remove on disconnect:

```typescript
let eventHandlers: Array<{ event: string; handler: Function }> = []

function registerOBSEvents(): void {
  const handlers = [
    ['RecordStateChanged', onRecordStateChanged],
    ['StreamStateChanged', onStreamStateChanged],
    // ...
  ]
  for (const [event, handler] of handlers) {
    obs.on(event, handler)
    eventHandlers.push({ event, handler })
  }
}

function removeOBSEvents(): void {
  for (const { event, handler } of eventHandlers) {
    obs.off(event, handler)
  }
  eventHandlers = []
}

// Call removeOBSEvents() in disconnect()
```

### 9B: WebSocket Heartbeat

**Fix in:** `src/main/services/wsHub.ts`

```typescript
// Check readyState before pinging
for (const client of clients) {
  if (client.readyState === WebSocket.OPEN) {
    client.ping()
  } else {
    clients.delete(client)
  }
}
```

### 9C: Renderer IPC Listener Cleanup

**Fix in:** `src/renderer/store/useStore.ts`

Return cleanup function from `initIPCListeners()`, call it on unmount:

```typescript
export function initIPCListeners(): () => void {
  const unsubs: Array<() => void> = []
  unsubs.push(window.api.on(IPC_CHANNELS.STATE_UPDATE, ...))
  // ...
  return () => unsubs.forEach(fn => fn())
}
```

### 9D: Timer Cleanup

All timers (`autoHideTimer`, `recordingTimer`, `previewTimer`, `zoomSaveTimer`, `reconnectTimer`) must be cleared in a central `cleanup()` function called on app quit.

---

## Section 10: Settings Hardening

### Deep Merge with Defaults

**Fix in:** `src/main/services/settings.ts`

```typescript
function deepMerge(target: any, defaults: any): any {
  for (const key of Object.keys(defaults)) {
    if (!(key in target)) {
      target[key] = defaults[key]
    } else if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
      target[key] = deepMerge(target[key] || {}, defaults[key])
    }
  }
  return target
}

// In getSettings():
settings = deepMerge(store.store, DEFAULT_SETTINGS)
```

This ensures missing keys get defaults without nuking existing settings.

### Atomic Migrations

Collect all migration changes, apply in one `store.set()` call instead of multiple.

---

## Section 11: Overlay Toggle Fix

**Fix in:** `src/main/services/overlay.ts`

```typescript
export function toggleElement(element: ...): OverlayState {
  const el = overlayState[element]
  el.visible = !el.visible

  // If toggling LT off, cancel auto-hide timer
  if (element === 'lowerThird' && !el.visible && autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }

  notifyChange()
  return overlayState
}
```

---

## Section 12: Startup Validation

**New:** `src/main/services/startup.ts`

Run on app launch, before UI shows:

1. **FFmpeg check** — verify FFmpeg path exists and runs `ffmpeg -version`
2. **Disk space check** — warn if < 10GB free on output drive
3. **Output dir check** — verify output directory exists and is writable
4. **OBS check** — attempt connection, warn if fails (non-blocking)
5. **Job queue recovery** — reset running jobs, report count
6. **Show startup report** — send to renderer: "Ready. 3 jobs resumed from previous session."

---

## New IPC Channels

```typescript
// Import
RECORDING_IMPORT_FILE: 'recording:import-file'      // (routineId, filePath)
RECORDING_IMPORT_FOLDER: 'recording:import-folder'   // (folderPath)
RECORDING_IMPORT_CONFIRM: 'recording:import-confirm'  // (matches[])

// Job Queue
JOB_QUEUE_GET: 'job:queue-get'           // get all jobs
JOB_QUEUE_RETRY: 'job:queue-retry'       // retry a failed job
JOB_QUEUE_CANCEL: 'job:queue-cancel'     // cancel a pending/running job
JOB_QUEUE_PROGRESS: 'job:queue-progress' // progress updates to renderer
```

---

## New Types

```typescript
// In shared/types.ts

export interface JobRecord {
  id: string
  type: 'encode' | 'upload' | 'photo-import'
  routineId: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  maxAttempts: number
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
  error?: string
  progress?: number
}

export interface ImportMatch {
  file: string
  routineId: string
  confidence: 'exact' | 'probable' | 'timestamp' | 'unmatched'
}

export interface StartupReport {
  ffmpegAvailable: boolean
  diskFreeGB: number
  diskWarning: boolean
  resumedJobs: number
  orphanedFiles: number
}
```

---

## Implementation Order

### Batch 1: Foundation (job queue + state hardening)
1. Create `jobQueue.ts` with persistence
2. Harden `state.ts` — debounced atomic writes, ID-based index
3. Deep merge settings defaults
4. Atomic settings migrations

### Batch 2: FFmpeg rewrite
5. Rewrite `ffmpeg.ts` to use jobQueue
6. Add timeout + PID tracking
7. Temp file cleanup on error
8. File lock retry in recording.ts

### Batch 3: Upload rewrite
9. Rewrite `upload.ts` to use jobQueue
10. Properly awaited loop
11. AbortController cleanup
12. Upload timeout scaling with file size
13. Routine status sync

### Batch 4: Error handling + cleanup
14. Uncaught exception handler with flush + dialog
15. Graceful shutdown
16. OBS event listener cleanup
17. WebSocket heartbeat readyState check
18. Renderer IPC listener cleanup
19. Timer cleanup registry
20. Async file operations

### Batch 5: Recovery + import
21. Enhanced crash recovery (startup.ts)
22. Kill orphaned FFmpeg on startup
23. Drag-drop import (IPC + handler)
24. Folder scan import (matching logic)
25. Import confirmation UI

### Batch 6: UI + polish
26. Import drop zones on routine rows
27. Import toolbar button + dialog
28. Job queue status panel (pending/running/failed counts)
29. Retry/cancel buttons for failed jobs
30. Startup report notification
31. Overlay toggle fix

### Batch 7: Verify
32. Type check (`npx tsc --noEmit`)
33. Build (`npx electron-vite build`)
34. Manual test: crash mid-encode → restart → jobs resume
35. Manual test: drag-drop MKV → encode → upload
36. Manual test: folder scan → match → import
37. Build installer, deploy

---

## Files Modified

| File | Changes |
|---|---|
| `src/shared/types.ts` | Add JobRecord, ImportMatch, StartupReport, new IPC channels |
| `src/main/services/jobQueue.ts` | **NEW** — persistent job queue |
| `src/main/services/startup.ts` | **NEW** — startup validation |
| `src/main/services/ffmpeg.ts` | Rewrite — jobQueue, timeout, PID, cleanup |
| `src/main/services/upload.ts` | Rewrite — jobQueue, await loop, abort cleanup |
| `src/main/services/recording.ts` | File lock retry, async ops, import handlers |
| `src/main/services/state.ts` | Debounced atomic writes, ID-based index |
| `src/main/services/settings.ts` | Deep merge, atomic migrations |
| `src/main/services/crashRecovery.ts` | Enhanced scan, temp cleanup, orphan FFmpeg |
| `src/main/services/overlay.ts` | Toggle cancels auto-hide |
| `src/main/services/obs.ts` | Event listener cleanup, heartbeat fix |
| `src/main/services/wsHub.ts` | Heartbeat readyState, command error boundary |
| `src/main/services/photos.ts` | Error handling on copy/sharp |
| `src/main/ipc.ts` | New import IPC channels, timer cleanup |
| `src/main/index.ts` | Uncaught handler, graceful shutdown |
| `src/renderer/store/useStore.ts` | IPC listener cleanup |
| `src/renderer/components/Settings.tsx` | (no changes this pass) |
| `src/renderer/components/RoutineRow.tsx` | Drop zone for import |
| `src/renderer/components/Toolbar.tsx` | Import button |
| `src/renderer/components/ImportDialog.tsx` | **NEW** — folder scan confirmation UI |
| `src/renderer/components/JobQueuePanel.tsx` | **NEW** — job status display |

---

## Risk Assessment

- **Highest risk:** FFmpeg and upload rewrites change core pipeline. Must preserve existing behavior while adding durability.
- **Mitigation:** Each batch is independently testable. Batch 1 (job queue) is pure addition. Batches 2-3 swap internals. Batch 4+ is fixes only.
- **Rollback:** Git commit per batch. Can revert any batch independently.
