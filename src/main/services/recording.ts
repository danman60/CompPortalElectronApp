import fs from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import * as obs from './obs'
import * as state from './state'
import * as ffmpegService from './ffmpeg'
import * as lowerThird from './lowerThird'
import { getSettings } from './settings'
import { IPC_CHANNELS, Routine } from '../../shared/types'
import { logger } from '../logger'

function sendToRenderer(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

function buildFileName(routine: Routine): string {
  const settings = getSettings()
  let name = settings.fileNaming.pattern
    .replace('{entry_number}', routine.entryNumber)
    .replace('{routine_title}', routine.routineTitle.replace(/\s+/g, '_'))
    .replace('{studio_code}', routine.studioCode)
    .replace('{category}', routine.category.replace(/\s+/g, '_'))
    .replace('{date}', new Date().toISOString().split('T')[0])
    .replace('{time}', new Date().toTimeString().split(' ')[0].replace(/:/g, '-'))

  // Sanitize for filesystem
  name = name.replace(/[<>:"/\\|?*]/g, '_')
  return name
}

function getRoutineOutputDir(routine: Routine): string {
  const settings = getSettings()
  const fileName = buildFileName(routine)
  return path.join(settings.fileNaming.outputDirectory, fileName)
}

async function archiveExistingFiles(routineDir: string): Promise<void> {
  if (!fs.existsSync(routineDir)) return

  // Find next version number
  const archiveDir = path.join(routineDir, '_archive')
  let version = 1
  if (fs.existsSync(archiveDir)) {
    const versions = fs.readdirSync(archiveDir).filter((d) => d.startsWith('v'))
    version = versions.length + 1
  }

  const versionDir = path.join(archiveDir, `v${version}`)
  fs.mkdirSync(versionDir, { recursive: true })

  // Move all files (not _archive folder) to version dir
  const entries = fs.readdirSync(routineDir)
  for (const entry of entries) {
    if (entry === '_archive') continue
    const src = path.join(routineDir, entry)
    const dest = path.join(versionDir, entry)
    fs.renameSync(src, dest)
  }

  logger.app.info(`Archived existing files to ${versionDir}`)
}

export async function handleRecordingStopped(
  outputPath: string,
  timestamp: string,
): Promise<void> {
  const routine = state.getCurrentRoutine()
  if (!routine) {
    logger.app.warn('Recording stopped but no current routine')
    return
  }

  // Update routine state
  state.updateRoutineStatus(routine.id, 'recorded', {
    recordingStoppedAt: timestamp,
    outputPath,
  })

  const settings = getSettings()
  const routineDir = getRoutineOutputDir(routine)
  const fileName = buildFileName(routine)

  // Check if we need to archive existing files (re-recording)
  if (fs.existsSync(routineDir) && settings.behavior.confirmBeforeOverwrite) {
    await archiveExistingFiles(routineDir)
  }

  // Create routine directory
  if (!fs.existsSync(routineDir)) {
    fs.mkdirSync(routineDir, { recursive: true })
  }

  // Rename the MKV file
  const ext = path.extname(outputPath)
  const newPath = path.join(routineDir, `${fileName}${ext}`)

  // Wait for file lock release
  await new Promise((resolve) => setTimeout(resolve, 1500))

  try {
    fs.renameSync(outputPath, newPath)
    logger.app.info(`Renamed: ${path.basename(outputPath)} → ${path.basename(newPath)}`)

    state.updateRoutineStatus(routine.id, 'recorded', { outputPath: newPath })

    // Auto-encode if enabled
    if (settings.behavior.autoEncodeRecordings) {
      state.updateRoutineStatus(routine.id, 'encoding')
      ffmpegService.enqueueJob({
        routineId: routine.id,
        inputPath: newPath,
        outputDir: routineDir,
        judgeCount: settings.competition.judgeCount,
        trackMapping: settings.audioTrackMapping,
        processingMode: settings.ffmpeg.processingMode,
      })
    }
  } catch (err) {
    logger.app.error('File rename failed:', err)
    state.updateRoutineStatus(routine.id, 'recorded', { outputPath, error: String(err) })
  }

  broadcastFullState()
}

export async function handleRecordingStarted(timestamp: string): Promise<void> {
  const routine = state.getCurrentRoutine()
  if (!routine) return

  state.updateRoutineStatus(routine.id, 'recording', {
    recordingStartedAt: timestamp,
  })
  broadcastFullState()
}

export async function next(): Promise<void> {
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

  // Update lower third
  if (settings.behavior.syncLowerThird) {
    lowerThird.updateLowerThird({
      entryNumber: nextRoutine.entryNumber,
      routineName: nextRoutine.routineTitle,
      dancers: nextRoutine.dancers.split(',').map((d) => d.trim()),
      studioName: nextRoutine.studioName,
      category: `${nextRoutine.ageGroup} ${nextRoutine.category}`,
    })

    if (settings.lowerThird.autoHideSeconds > 0) {
      lowerThird.fireWithAutoHide(settings.lowerThird.autoHideSeconds)
    } else {
      lowerThird.fire()
    }
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
}

export async function prev(): Promise<void> {
  const prevRoutine = state.goToPrev()
  if (!prevRoutine) {
    logger.app.info('Already at first routine')
    return
  }
  broadcastFullState()
}

function broadcastFullState(): void {
  const competition = state.getCompetition()
  const current = state.getCurrentRoutine()
  const nextR = state.getNextRoutine()

  sendToRenderer(IPC_CHANNELS.STATE_UPDATE, {
    competition,
    currentRoutine: current,
    nextRoutine: nextR,
    currentIndex: state.getCurrentRoutineIndex(),
  })
}

export { broadcastFullState }
