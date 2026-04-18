import fs from 'fs'
import path from 'path'
import * as obs from './obs'
import * as state from './state'
import * as ffmpegService from './ffmpeg'
import * as overlay from './overlay'
// Auto-fire state is persisted via overlay config
import * as wsHub from './wsHub'
import * as uploadService from './upload'
import * as tether from './tether'
import * as jobQueue from './jobQueue'
import { getSettings } from './settings'
import * as schedule from './schedule'
import { postNowPlaying } from './compPortal'
import { dialog, BrowserWindow } from 'electron'
import { IPC_CHANNELS, Routine } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'

// --- Active recording tracking ---
let activeRecordingRoutineId: string | null = null
let pendingStopProcessing: { promise: Promise<void>; resolve: () => void } | null = null

// --- Fix 11: Watchdog tracking ---
let recordStartedAt: number | null = null
let expectedObsOutputDir: string | null = null
let watchdogTimer: NodeJS.Timeout | null = null
let lastDisconnectAlert = 0
let silentStopAlertFired = false
let stuckAlertFired = false

function startRecordingWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer)
  lastDisconnectAlert = 0
  silentStopAlertFired = false
  stuckAlertFired = false
  watchdogTimer = setInterval(() => {
    if (!activeRecordingRoutineId) { stopRecordingWatchdog(); return }
    const s = obs.getState()
    const now = Date.now()
    if (s.connectionStatus !== 'connected') {
      if (now - lastDisconnectAlert > 30000) {
        lastDisconnectAlert = now
        sendToRenderer(IPC_CHANNELS.RECORDING_ALERT, {
          level: 'error',
          message: `OBS disconnected mid-record for routine ${activeRecordingRoutineId}`,
          routineId: activeRecordingRoutineId,
        })
        logger.app.error(`Watchdog: OBS disconnected mid-record for routine ${activeRecordingRoutineId}`)
      }
      return
    }
    if (!s.isRecording && recordStartedAt && now - recordStartedAt > 10000 && !silentStopAlertFired) {
      silentStopAlertFired = true
      sendToRenderer(IPC_CHANNELS.RECORDING_ALERT, {
        level: 'error',
        message: 'OBS stopped recording but routine still marked recording',
        routineId: activeRecordingRoutineId,
      })
      logger.app.error('Watchdog: OBS stopped recording but routine still marked recording')
      reconcileOrphanedRecording().catch((err) => logger.app.warn('Reconcile from watchdog failed:', err))
    }
    const maxMinutes = getSettings().obs.maxRecordMinutes || 0
    if (maxMinutes > 0 && recordStartedAt && !stuckAlertFired) {
      const elapsedMs = now - recordStartedAt
      if (elapsedMs > (maxMinutes + 2) * 60000) {
        stuckAlertFired = true
        sendToRenderer(IPC_CHANNELS.RECORDING_ALERT, {
          level: 'error',
          message: `Recording has been active > ${maxMinutes + 2}min. Check OBS.`,
          routineId: activeRecordingRoutineId,
        })
        logger.app.error(`Watchdog: recording stuck > ${maxMinutes + 2}min for routine ${activeRecordingRoutineId}`)
      }
    }
  }, 5000)
}

function stopRecordingWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
  recordStartedAt = null
  expectedObsOutputDir = null
  lastDisconnectAlert = 0
  silentStopAlertFired = false
  stuckAlertFired = false
}

async function reconcileOrphanedRecording(): Promise<void> {
  if (!activeRecordingRoutineId || !recordStartedAt) return
  const searchDirs: string[] = []
  if (expectedObsOutputDir) searchDirs.push(expectedObsOutputDir)
  const dynamicDir = await obs.getRecordDirectory().catch(() => null)
  if (dynamicDir && !searchDirs.includes(dynamicDir)) searchDirs.push(dynamicDir)

  const windowStart = recordStartedAt - 5000
  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue
      const entries = await fs.promises.readdir(dir)
      const candidates: Array<{ p: string; mtime: number }> = []
      for (const e of entries) {
        if (!/\.(mkv|mp4|flv)$/i.test(e)) continue
        const p = path.join(dir, e)
        try {
          const st = await fs.promises.stat(p)
          if (st.mtimeMs >= windowStart) candidates.push({ p, mtime: st.mtimeMs })
        } catch {}
      }
      candidates.sort((a, b) => b.mtime - a.mtime)
      if (candidates.length > 0) {
        const best = candidates[0]
        logger.app.warn(`Reconcile: salvaging orphaned recording ${best.p}`)
        await handleRecordingStopped(best.p, new Date().toISOString())
        return
      }
    } catch (err) {
      logger.app.warn(`Reconcile: scan failed for ${dir}: ${err instanceof Error ? err.message : err}`)
    }
  }
  const routineId = activeRecordingRoutineId
  logger.app.error(`Reconcile: no orphaned file found for routine ${routineId} — marking interrupted`)
  state.updateRoutineStatus(routineId, 'recording_interrupted', {
    error: 'Recording interrupted (OBS disconnected or stopped silently). No output file recovered.',
  })
  // Venue TV "now playing" sync — clear on interrupt
  postNowPlaying(null).catch(() => {})
  activeRecordingRoutineId = null
  stopRecordingWatchdog()
  obs.setActiveAlertRoutineId(null)
  broadcastFullStateImmediate()
}

export function handleObsReconcile(info: { outputActive: boolean; recordDirectory: string | null }): void {
  if (!activeRecordingRoutineId) {
    if (info.outputActive) {
      logger.app.warn('OBS reports active recording but no activeRecordingRoutineId — ghost recording')
    }
    return
  }
  if (info.outputActive) {
    logger.app.info(`Reconcile: OBS still recording for routine ${activeRecordingRoutineId} — no action`)
    if (info.recordDirectory) expectedObsOutputDir = info.recordDirectory
    return
  }
  logger.app.warn('Reconcile: OBS not recording but routine still marked active — attempting salvage')
  if (info.recordDirectory) expectedObsOutputDir = info.recordDirectory
  reconcileOrphanedRecording().catch((err) => logger.app.warn('Reconcile salvage failed:', err))
}

// --- Navigation busy guard (prevents rapid double-advance) ---
let navBusy = false

// --- Auto-fire lower third (persisted via overlay config) ---
let autoFireTimer: NodeJS.Timeout | null = null

export function setAutoFire(enabled: boolean): void {
  overlay.setAutoFirePersisted(enabled)
  if (!enabled && autoFireTimer) {
    clearTimeout(autoFireTimer)
    autoFireTimer = null
  }
  logger.app.info(`Lower third auto-fire: ${enabled ? 'ON' : 'OFF'}`)
}

export function getAutoFire(): boolean {
  return overlay.getAutoFirePersisted()
}

function scheduleAutoFire(): void {
  if (!getAutoFire()) return
  if (autoFireTimer) clearTimeout(autoFireTimer)
  autoFireTimer = setTimeout(() => {
    overlay.fireLowerThird()
    autoFireTimer = null
    logger.app.info('Overlay lower third auto-fired (3s delay)')
  }, 3000)
}

const MIN_FREE_GB_TO_RECORD = 5

/** Fix 2 + Fix 8: Validate that recording can start. Returns null if OK, or a blocked reason. */
export function canStartRecording(): { blocked: true; reason: 'no-output-dir' | 'dir-not-accessible' | 'disk-space-low'; detail?: string } | null {
  const settings = getSettings()
  const outputDir = settings.fileNaming.outputDirectory
  if (!outputDir || outputDir.trim() === '') {
    logger.app.error('No output directory configured — recording blocked')
    sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'no-output-dir' })
    return { blocked: true, reason: 'no-output-dir' }
  }
  if (!fs.existsSync(outputDir)) {
    logger.app.error(`Output directory not found: ${outputDir}`)
    sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'dir-not-accessible', detail: outputDir })
    return { blocked: true, reason: 'dir-not-accessible', detail: outputDir }
  }
  try {
    fs.accessSync(outputDir, fs.constants.W_OK)
  } catch {
    logger.app.error(`Output directory not writable: ${outputDir}`)
    sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'dir-not-accessible', detail: outputDir })
    return { blocked: true, reason: 'dir-not-accessible', detail: outputDir }
  }
  try {
    const drive = outputDir.match(/^[a-zA-Z]:\\/) ? outputDir.slice(0, 3) : outputDir
    const stats = fs.statfsSync(drive)
    const freeGB = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024)
    if (freeGB < MIN_FREE_GB_TO_RECORD) {
      logger.app.error(`Disk space too low to record: ${freeGB.toFixed(1)}GB free`)
      sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'disk-space-low', detail: `${freeGB.toFixed(1)}GB free` })
      return { blocked: true, reason: 'disk-space-low', detail: `${freeGB.toFixed(1)}GB free` }
    }
  } catch (err) {
    logger.app.warn(`Could not check disk space for ${outputDir}: ${err instanceof Error ? err.message : err}`)
  }
  return null
}

/** Check if starting a recording would overwrite an existing one, and ask for confirmation. */
export async function confirmReRecordIfNeeded(): Promise<boolean> {
  const routine = state.getCurrentRoutine()
  if (!routine) return true
  // Only prompt if routine has already been recorded/encoded/uploaded
  if (routine.status === 'pending' || routine.status === 'skipped') return true

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return true

  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Re-record Routine?',
    message: `Routine #${routine.entryNumber} "${routine.routineTitle}" already has a recording (status: ${routine.status}).`,
    detail: 'Starting a new recording will archive the existing files. Continue?',
    buttons: ['Cancel', 'Re-record'],
    defaultId: 0,
    cancelId: 0,
  })
  return result.response === 1
}

function createStopProcessingBarrier(): Promise<void> {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  pendingStopProcessing = { promise, resolve }
  return promise
}

async function stopRecordingAndWait(reason: string): Promise<boolean> {
  const obsState = obs.getState()
  if (!(obsState.isRecording && obsState.connectionStatus === 'connected')) {
    return false
  }

  const stopEvent = obs.waitForRecordStop()
  const stopProcessing = createStopProcessingBarrier()

  try {
    const outputPath = await obs.stopRecord()
    await stopEvent

    // Wait until handleRecordingStopped finishes organizing the file before advancing.
    if (outputPath) {
      await Promise.race([stopProcessing, sleep(30000)])
    }
    return true
  } catch (err) {
    logger.app.error(`${reason}: stop recording failed:`, err instanceof Error ? err.message : err)
    if (pendingStopProcessing?.promise === stopProcessing) {
      pendingStopProcessing.resolve()
      pendingStopProcessing = null
    }
    return false
  }
}

/** Calculate human-readable offset between scheduled time (HH:MM) and actual time */
function calcOffset(scheduledTime: string, actual: Date): string {
  const [h, m] = scheduledTime.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return 'invalid schedule time'
  const scheduled = new Date(actual)
  scheduled.setHours(h, m, 0, 0)
  const diffMs = actual.getTime() - scheduled.getTime()
  const absDiffMin = Math.abs(Math.round(diffMs / 60000))
  const sign = diffMs >= 0 ? '+' : '-'
  if (absDiffMin < 1) return 'on time'
  const hours = Math.floor(absDiffMin / 60)
  const mins = absDiffMin % 60
  return hours > 0 ? `${sign}${hours}h ${mins}m` : `${sign}${mins}m`
}

function buildFileName(routine: Routine): string {
  const settings = getSettings()
  const now = new Date()
  let name = settings.fileNaming.pattern
    .replace('{entry_number}', routine.entryNumber)
    .replace('{routine_title}', routine.routineTitle.replace(/\s+/g, '_'))
    .replace('{studio_code}', routine.studioCode)
    .replace('{category}', routine.category.replace(/\s+/g, '_'))
    .replace('{date}', now.toISOString().split('T')[0])
    .replace('{time}', now.toTimeString().split(' ')[0].replace(/:/g, '-'))

  // Sanitize for filesystem
  name = name.replace(/[<>:"/\\|?*]/g, '_')
  return name
}

function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '_').trim()
}

function getRoutineOutputDir(routine: Routine, obsOutputPath?: string): string {
  const settings = getSettings()
  const conn = schedule.getResolvedConnection()

  // Base directory: explicit setting > OBS recording dir
  let baseDir = settings.fileNaming.outputDirectory
  if (!baseDir && obsOutputPath) {
    baseDir = path.dirname(obsOutputPath)
  }
  if (!baseDir) return ''

  // Build subfolder: ShareCode/Entry# when using share code, else pattern-based
  if (conn) {
    const shareCode = sanitize(conn.name)
    const entry = sanitize(routine.entryNumber || buildFileName(routine))
    return path.join(baseDir, shareCode, entry)
  }

  return path.join(baseDir, buildFileName(routine))
}

/** Retry opening a file until the lock is released (OBS finishes writing). */
async function waitForFileLock(filePath: string, maxWaitMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const fh = await fs.promises.open(filePath, 'r+')
      await fh.close()
      return // file is free
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  // File may still be usable — log warning but don't throw
  logger.app.warn(`File may still be locked after ${maxWaitMs / 1000}s: ${filePath}`)
}

async function archiveExistingFiles(routineDir: string): Promise<void> {
  if (!fs.existsSync(routineDir)) return

  const archiveDir = path.join(routineDir, '_archive')
  let version = 1
  if (fs.existsSync(archiveDir)) {
    const versions = (await fs.promises.readdir(archiveDir)).filter((d) => d.startsWith('v'))
    const nums = versions.map(v => parseInt(v.slice(1), 10)).filter(n => !isNaN(n))
    version = nums.length > 0 ? Math.max(...nums) + 1 : 1
  }

  const versionDir = path.join(archiveDir, `v${version}`)
  await fs.promises.mkdir(versionDir, { recursive: true })

  const entries = await fs.promises.readdir(routineDir)
  for (const entry of entries) {
    if (entry === '_archive') continue
    const src = path.join(routineDir, entry)
    const dest = path.join(versionDir, entry)
    await fs.promises.rename(src, dest)
  }

  logger.app.info(`Archived existing files to ${versionDir}`)
}

export async function handleRecordingStopped(
  outputPath: string,
  timestamp: string,
): Promise<void> {
  let stoppedRoutineId: string | null = null
  try {
    const routineId = activeRecordingRoutineId
    stoppedRoutineId = routineId
    activeRecordingRoutineId = null
    stopRecordingWatchdog()
    obs.setActiveAlertRoutineId(null)

    if (!routineId) {
      logger.app.error(`Recording stopped but no activeRecordingRoutineId — raw file preserved at: ${outputPath}`)
      return
    }

    const comp = state.getCompetition()
    const routine = comp?.routines.find((r) => r.id === routineId) ?? null

    if (!routine) {
      logger.app.warn(`Recording stopped for unknown routine ${routineId} — raw file preserved at: ${outputPath}`)
      return
    }

    // Update routine state
    state.updateRoutineStatus(routine.id, 'recorded', {
      recordingStoppedAt: timestamp,
      outputPath,
    })

    // Venue TV "now playing" sync — clear on stop
    postNowPlaying(null).catch(() => {})

    const stopTime = new Date(timestamp)
    const stopStr = stopTime.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const startTime = routine.recordingStartedAt ? new Date(routine.recordingStartedAt) : null
    const durationSec = startTime ? Math.round((stopTime.getTime() - startTime.getTime()) / 1000) : 0
    const durationStr = durationSec > 0 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : '?'

    logger.app.info([
      `──── RECORDING STOPPED ────`,
      `  Entry #${routine.entryNumber} — "${routine.routineTitle}"`,
      `  Studio: ${routine.studioName} (${routine.studioCode})`,
      `  Category: ${routine.ageGroup} ${routine.category} ${routine.sizeCategory}`,
      `  Scheduled: Day ${routine.scheduledDay || '?'}, Position ${routine.position}${routine.scheduledTime ? `, Time ${routine.scheduledTime}` : ''}`,
      startTime ? `  Recording started: ${startTime.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '',
      `  Recording stopped: ${stopStr} (${timestamp})`,
      `  Actual duration: ${durationStr} (expected ${routine.durationMinutes} min)`,
      routine.scheduledTime ? `  Offset from schedule: ${calcOffset(routine.scheduledTime, startTime || stopTime)}` : '',
      `  Raw file: ${outputPath}`,
      `────────────────────────────`,
    ].filter(Boolean).join('\n'))

    const settings = getSettings()

    const routineDir = getRoutineOutputDir(routine, outputPath)
    if (!routineDir) {
      logger.app.warn('No output directory available — skipping file organization')
      broadcastFullState()
      return
    }
    const fileName = buildFileName(routine)

    logger.app.info(`Routine dir: ${routineDir}`)

    // Check if we need to archive existing files (re-recording)
    if (fs.existsSync(routineDir) && settings.behavior.confirmBeforeOverwrite) {
      await archiveExistingFiles(routineDir)

      // Clear stale upload jobs and photo state from previous recording
      const oldJobs = jobQueue.getByRoutine(routine.id).filter(j => j.type === 'upload')
      for (const job of oldJobs) {
        jobQueue.updateStatus(job.id, 'cancelled')
      }
      state.updateRoutineStatus(routine.id, routine.status, {
        photos: undefined,
        encodedFiles: undefined,
        uploadProgress: undefined,
        error: undefined,
      })
      logger.app.info(`Archived existing files to ${routineDir}/_archive — cleared ${oldJobs.length} old upload jobs`)
    }

    // Create routine directory
    if (!fs.existsSync(routineDir)) {
      await fs.promises.mkdir(routineDir, { recursive: true })
      logger.app.info(`Created routine directory: ${routineDir}`)
    }

    // Rename the MKV file
    const ext = path.extname(outputPath)
    const newPath = path.join(routineDir, `${fileName}${ext}`)

    // Wait for file lock release (OBS may still be writing) — retry loop instead of fixed 2s wait
    await waitForFileLock(outputPath)

    // Try rename first (fast, same-drive). Fall back to copy+delete for cross-drive (EXDEV).
    try {
      await fs.promises.rename(outputPath, newPath)
    } catch (renameErr: unknown) {
      const code = (renameErr as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        logger.app.info(`Cross-drive detected, copying: ${outputPath} → ${newPath}`)
        await fs.promises.copyFile(outputPath, newPath)
        await fs.promises.unlink(outputPath)
      } else {
        throw renameErr
      }
    }

    const stat = await fs.promises.stat(newPath)
    const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(1)
    logger.app.info(`Moved: ${outputPath} → ${newPath} (${fileSizeMB} MB)`)

    state.updateRoutineStatus(routine.id, 'recorded', { outputPath: newPath, outputDir: routineDir })

    // Auto-encode if enabled
    if (settings.behavior.autoEncodeRecordings) {
      const queueBusy = ffmpegService.getQueueLength() > 0
      state.updateRoutineStatus(routine.id, queueBusy ? 'queued' : 'encoding')
      broadcastFullState()
      ffmpegService.enqueueJob({
        routineId: routine.id,
        inputPath: newPath,
        outputDir: routineDir,
        judgeCount: settings.competition.judgeCount,
        trackMapping: settings.audioTrackMapping,
        processingMode: settings.ffmpeg.processingMode,
        filePrefix: schedule.buildFilePrefix(routine.entryNumber),
      })
    }

    // Rescan watch folder — retry unmatched photos + pick up new files
    tether.rescanPhotos().catch((err) => {
      logger.app.warn(`Photo rescan after recording stop failed: ${err.message}`)
    })
  } catch (err) {
    logger.app.error('File move failed:', err)
    if (stoppedRoutineId) {
      state.updateRoutineStatus(stoppedRoutineId, 'recorded', { outputPath, error: String(err) })
    }
  } finally {
    pendingStopProcessing?.resolve()
    pendingStopProcessing = null
    broadcastFullStateImmediate()
  }
}

export async function handleRecordingStarted(timestamp: string): Promise<void> {
  const routine = state.getCurrentRoutine()
  if (!routine) return

  activeRecordingRoutineId = routine.id
  recordStartedAt = Date.parse(timestamp) || Date.now()
  expectedObsOutputDir = await obs.getRecordDirectory().catch(() => null)
  obs.setActiveAlertRoutineId(routine.id)
  startRecordingWatchdog()

  state.updateRoutineStatus(routine.id, 'recording', {
    recordingStartedAt: timestamp,
  })

  // Venue TV "now playing" sync (fire-and-forget, semantic B / recording-driven)
  postNowPlaying(routine.id).catch(() => {})

  const now = new Date(timestamp)
  const timeStr = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  logger.app.info([
    `──── RECORDING STARTED ────`,
    `  Entry #${routine.entryNumber} — "${routine.routineTitle}"`,
    `  Studio: ${routine.studioName} (${routine.studioCode})`,
    `  Category: ${routine.ageGroup} ${routine.category} ${routine.sizeCategory}`,
    `  Scheduled: Day ${routine.scheduledDay || '?'}, Position ${routine.position}${routine.scheduledTime ? `, Time ${routine.scheduledTime}` : ''}`,
    `  Recording started: ${timeStr} (${timestamp})`,
    routine.scheduledTime ? `  Offset from schedule: ${calcOffset(routine.scheduledTime, now)}` : '',
    `  Duration expected: ${routine.durationMinutes} min`,
    `───────────────────────────`,
  ].filter(Boolean).join('\n'))

  broadcastFullStateImmediate()
}

export async function next(): Promise<void> {
  if (navBusy) { logger.app.debug('next() blocked — already in progress'); return }
  navBusy = true
  try {
    const settings = getSettings()
    const obsState = obs.getState()

    // If recording, stop first
    if (obsState.isRecording && obsState.connectionStatus === 'connected') {
      await stopRecordingAndWait('next')
    }

    // Advance to next routine
    const nextRoutine = state.advanceToNext()
    if (!nextRoutine) {
      logger.app.info('No more routines')
      return
    }

    // Update overlay data
    if (settings.behavior.syncLowerThird) {
      const comp = state.getCompetition()
      const visibleCount = comp ? comp.routines.filter(r => r.status !== 'skipped').length : 0
      overlay.updateRoutineData({
        entryNumber: nextRoutine.entryNumber,
        routineTitle: nextRoutine.routineTitle,
        dancers: nextRoutine.dancers,
        studioName: nextRoutine.studioName,
        category: `${nextRoutine.ageGroup} ${nextRoutine.category}`,
        current: state.getCurrentRoutineIndex() + 1,
        total: visibleCount,
      })
    }

    // Auto-fire: schedule 3s delay. Manual fire still works independently.
    if (getAutoFire()) {
      scheduleAutoFire()
    }

    // Auto-record if enabled
    if (settings.behavior.autoRecordOnNext && obsState.connectionStatus === 'connected') {
      const blocked = canStartRecording()
      if (blocked) {
        logger.app.error(`Auto-record blocked: ${blocked.reason}${blocked.detail ? ` (${blocked.detail})` : ''}`)
      } else {
        try {
          await obs.startRecord()
        } catch (err) {
          logger.app.error('Auto-record failed:', err instanceof Error ? err.message : err)
        }
      }
    }

    broadcastFullStateImmediate()
  } finally {
    navBusy = false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function nextFull(): Promise<void> {
  if (navBusy) { logger.app.info('nextFull() blocked — already in progress'); return }
  navBusy = true
  logger.app.info('nextFull: starting sequence')
  try {
    const obsState = obs.getState()
    const connected = obsState.connectionStatus === 'connected'
    const settings = getSettings()
    const seq = settings.nextSequence
    logger.app.info(`nextFull: OBS connected=${connected}, isRecording=${obsState.isRecording}, seq=${JSON.stringify(seq)}`)

    // 1. Stop recording if active
    if (seq.stopRecording && connected && obsState.isRecording) {
      logger.app.info('nextFull: stopping current recording...')
      await stopRecordingAndWait('nextFull')
      logger.app.info(`nextFull: recording stopped, waiting ${seq.pauseAfterStopMs}ms`)
      if (seq.pauseAfterStopMs > 0) await sleep(seq.pauseAfterStopMs)
    }

    // 2. Advance to next routine
    const nextRoutine = state.advanceToNext()
    if (!nextRoutine) {
      logger.app.info('nextFull: no more routines')
      return
    }

    broadcastFullStateImmediate()
    logger.app.info(`nextFull: advanced to #${nextRoutine.entryNumber} "${nextRoutine.routineTitle}"`)

    // 3. Start recording
    if (seq.startRecording && connected) {
      if (seq.pauseBeforeRecordMs > 0) await sleep(seq.pauseBeforeRecordMs)
      const blocked = canStartRecording()
      if (blocked) {
        logger.app.error(`nextFull: auto-record blocked: ${blocked.reason}${blocked.detail ? ` (${blocked.detail})` : ''}`)
      } else {
        logger.app.info('nextFull: starting recording...')
        try {
          await obs.startRecord()
          logger.app.info('nextFull: recording started')
        } catch (err) {
          logger.app.error('nextFull: auto-record failed:', err instanceof Error ? err.message : err)
        }
      }
    } else {
      logger.app.info(`nextFull: skipping auto-record (seq.startRecording=${seq.startRecording}, connected=${connected})`)
    }

    // 4. Fire lower third
    if (seq.fireLowerThird) {
      if (seq.pauseBeforeLowerThirdMs > 0) await sleep(seq.pauseBeforeLowerThirdMs)
      overlay.fireLowerThird()
      logger.app.info('nextFull: lower third fired — sequence complete')
    } else {
      logger.app.info('nextFull: lower third skipped — sequence complete')
    }
  } finally {
    navBusy = false
  }
}

export async function prev(): Promise<void> {
  const prevRoutine = state.goToPrev()
  if (!prevRoutine) {
    logger.app.info('Already at first routine')
    return
  }
  broadcastFullStateImmediate()
}

function syncOverlayFromCurrent(): void {
  const current = state.getCurrentRoutine()
  if (!current) return
  const comp = state.getCompetition()
  const visibleCount = comp ? comp.routines.filter(r => r.status !== 'skipped').length : 0
  overlay.updateRoutineData({
    entryNumber: current.entryNumber,
    routineTitle: current.routineTitle,
    dancers: current.dancers,
    studioName: current.studioName,
    category: `${current.ageGroup} ${current.category}`,
    current: state.getCurrentRoutineIndex() + 1,
    total: visibleCount,
  })
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null
const BROADCAST_DEBOUNCE_MS = 150

function broadcastFullState(): void {
  if (broadcastTimer) return // already scheduled
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    const competition = state.getCompetition()
    const current = state.getCurrentRoutine()
    const nextR = state.getNextRoutine()

    sendToRenderer(IPC_CHANNELS.STATE_UPDATE, {
      competition,
      currentRoutine: current,
      nextRoutine: nextR,
      currentIndex: state.getCurrentRoutineIndex(),
    })

    wsHub.broadcastState()
  }, BROADCAST_DEBOUNCE_MS)
}

/** Bypass debounce for critical moments (recording start/stop, navigation) */
function broadcastFullStateImmediate(): void {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
  }
  const competition = state.getCompetition()
  const current = state.getCurrentRoutine()
  const nextR = state.getNextRoutine()

  syncOverlayFromCurrent() // Only sync overlay on immediate (navigation/recording), not debounced

  sendToRenderer(IPC_CHANNELS.STATE_UPDATE, {
    competition,
    currentRoutine: current,
    nextRoutine: nextR,
    currentIndex: state.getCurrentRoutineIndex(),
  })

  wsHub.broadcastState()
}

export function broadcastRoutineUpdate(routineId: string): void {
  const competition = state.getCompetition()
  if (!competition) return
  const routine = competition.routines.find(r => r.id === routineId)
  if (!routine) return

  sendToRenderer(IPC_CHANNELS.STATE_ROUTINE_UPDATE, { routineId, routine })
  // Overlay gets state via broadcastFullState (debounced) — not here, to avoid rapid re-renders
}

export { broadcastFullState, broadcastFullStateImmediate }
