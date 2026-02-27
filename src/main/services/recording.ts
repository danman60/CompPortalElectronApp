import fs from 'fs'
import path from 'path'
import * as obs from './obs'
import * as state from './state'
import * as ffmpegService from './ffmpeg'
import * as overlay from './overlay'
import * as wsHub from './wsHub'
import * as uploadService from './upload'
import { getSettings } from './settings'
import * as schedule from './schedule'
import { IPC_CHANNELS, Routine } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'

// --- Active recording tracking ---
let activeRecordingRoutineId: string | null = null

// --- Navigation busy guard (prevents rapid double-advance) ---
let navBusy = false

// --- Auto-fire lower third ---
let autoFireEnabled = false
let autoFireTimer: NodeJS.Timeout | null = null

export function setAutoFire(enabled: boolean): void {
  autoFireEnabled = enabled
  if (!enabled && autoFireTimer) {
    clearTimeout(autoFireTimer)
    autoFireTimer = null
  }
  logger.app.info(`Lower third auto-fire: ${enabled ? 'ON' : 'OFF'}`)
}

export function getAutoFire(): boolean {
  return autoFireEnabled
}

function scheduleAutoFire(): void {
  if (!autoFireEnabled) return
  if (autoFireTimer) clearTimeout(autoFireTimer)
  autoFireTimer = setTimeout(() => {
    overlay.fireLowerThird()
    autoFireTimer = null
    logger.app.info('Overlay lower third auto-fired (3s delay)')
  }, 3000)
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
  const routineId = activeRecordingRoutineId
  activeRecordingRoutineId = null

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

  try {
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
  } catch (err) {
    logger.app.error('File move failed:', err)
    state.updateRoutineStatus(routine.id, 'recorded', { outputPath, error: String(err) })
  }

  broadcastFullState()
}

export async function handleRecordingStarted(timestamp: string): Promise<void> {
  const routine = state.getCurrentRoutine()
  if (!routine) return

  activeRecordingRoutineId = routine.id

  state.updateRoutineStatus(routine.id, 'recording', {
    recordingStartedAt: timestamp,
  })

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

  broadcastFullState()
}

export async function next(): Promise<void> {
  if (navBusy) { logger.app.debug('next() blocked — already in progress'); return }
  navBusy = true
  try {
    const settings = getSettings()
    const obsState = obs.getState()

    // If recording, stop first
    if (obsState.isRecording && obsState.connectionStatus === 'connected') {
      try {
        await obs.stopRecord()
      } catch (err) {
        logger.app.error('Failed to stop recording on Next:', err instanceof Error ? err.message : err)
      }
      // RecordStateChanged event will handle file rename and encoding
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
    if (autoFireEnabled) {
      scheduleAutoFire()
    }

    // Auto-record if enabled
    if (settings.behavior.autoRecordOnNext && obsState.connectionStatus === 'connected') {
      try {
        await obs.startRecord()
      } catch (err) {
        logger.app.error('Auto-record failed:', err instanceof Error ? err.message : err)
      }
    }

    broadcastFullState()
  } finally {
    navBusy = false
  }
}

export async function nextFull(): Promise<void> {
  if (navBusy) { logger.app.debug('nextFull() blocked — already in progress'); return }
  navBusy = true
  try {
    const connected = obs.getState().connectionStatus === 'connected'

    if (connected && obs.getState().isRecording) {
      try {
        // Wait for OBS to confirm recording stopped (event-driven, 15s timeout fallback)
        const stopPromise = obs.waitForRecordStop()
        await obs.stopRecord()
        await stopPromise
      } catch (err) {
        logger.app.error('nextFull: stop recording failed:', err instanceof Error ? err.message : err)
      }
    }

    const nextRoutine = state.advanceToNext()
    if (!nextRoutine) {
      logger.app.info('nextFull: no more routines')
      return
    }

    broadcastFullState()

    if (connected) {
      try {
        await obs.startRecord()
      } catch (err) {
        logger.app.error('nextFull: start recording failed:', err instanceof Error ? err.message : err)
      }
    }

    setTimeout(() => {
      overlay.fireLowerThird()
    }, 5000)

    logger.app.info(`nextFull: advanced to #${nextRoutine.entryNumber} "${nextRoutine.routineTitle}"`)
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
  broadcastFullState()
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

function broadcastFullState(): void {
  const competition = state.getCompetition()
  const current = state.getCurrentRoutine()
  const nextR = state.getNextRoutine()

  syncOverlayFromCurrent()

  sendToRenderer(IPC_CHANNELS.STATE_UPDATE, {
    competition,
    currentRoutine: current,
    nextRoutine: nextR,
    currentIndex: state.getCurrentRoutineIndex(),
  })

  wsHub.broadcastState()
}

export { broadcastFullState }
