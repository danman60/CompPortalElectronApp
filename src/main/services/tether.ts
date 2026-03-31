import fs from 'fs'
import path from 'path'
import ExifReader from 'exifreader'
import sharp from 'sharp'
import { IPC_CHANNELS, Routine, PhotoMatch } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import * as state from './state'
import { broadcastFullState } from './recording'
import { getSettings } from './settings'
import * as uploadService from './upload'

// Use dynamic import for chokidar (ESM)
let chokidar: typeof import('chokidar') | null = null

export interface TetherState {
  active: boolean
  watchPath: string | null
  photosReceived: number
  lastPhotoTime: string | null
  cameraClockOffset: number
  clockSyncStatus: 'unknown' | 'ok' | 'warning' | 'error'
}

interface RecordingWindow {
  routineId: string
  entryNumber: string
  recordingStarted: Date
  recordingStopped: Date
}

const PHOTO_EXTENSIONS = /\.(jpg|jpeg|arw|cr3|nef|raf)$/i
const BUFFER_MS = 30_000
const CLOCK_OK_THRESHOLD = 5_000
const CLOCK_WARN_THRESHOLD = 30_000

let tetherState: TetherState = {
  active: false,
  watchPath: null,
  photosReceived: 0,
  lastPhotoTime: null,
  cameraClockOffset: 0,
  clockSyncStatus: 'unknown',
}

let watcher: import('chokidar').FSWatcher | null = null
const importedFiles = new Set<string>()
const clockOffsetSamples: number[] = []
const MAX_OFFSET_SAMPLES = 10

// --- EXIF reading (same as photos.ts) ---

async function getPhotoCaptureTime(filePath: string): Promise<Date | null> {
  try {
    const EXIF_HEADER_SIZE = 128 * 1024
    const fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(EXIF_HEADER_SIZE)
    const { bytesRead } = await fh.read(buf, 0, EXIF_HEADER_SIZE, 0)
    await fh.close()
    const buffer = buf.subarray(0, bytesRead)
    const tags = ExifReader.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    )
    const dateTime = tags['DateTimeOriginal']?.description
    if (!dateTime) return null

    const [datePart, timePart] = dateTime.split(' ')
    if (!datePart || !timePart) return null
    const isoString = datePart.replace(/:/g, '-') + 'T' + timePart
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return null
    return d
  } catch (err) {
    logger.photos.warn(`Tether: Failed to read EXIF from ${path.basename(filePath)}:`, err)
    return null
  }
}

// --- Recording window helpers ---

function getRecordingWindows(): RecordingWindow[] {
  const comp = state.getCompetition()
  if (!comp) return []
  return comp.routines
    .filter((r) => r.recordingStartedAt && r.recordingStoppedAt)
    .map((r) => ({
      routineId: r.id,
      entryNumber: r.entryNumber,
      recordingStarted: new Date(r.recordingStartedAt!),
      recordingStopped: new Date(r.recordingStoppedAt!),
    }))
    .sort((a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime())
}

function matchSinglePhoto(
  captureTime: Date,
  windows: RecordingWindow[],
): { routineId: string; confidence: 'exact' | 'gap' } | null {
  const t = captureTime.getTime()

  // Exact match
  const exact = windows.find(
    (w) => t >= w.recordingStarted.getTime() && t <= w.recordingStopped.getTime(),
  )
  if (exact) return { routineId: exact.routineId, confidence: 'exact' }

  // Gap match (within 30s buffer)
  const gap = windows.find(
    (w) =>
      t >= w.recordingStarted.getTime() - BUFFER_MS &&
      t <= w.recordingStopped.getTime() + BUFFER_MS,
  )
  if (gap) return { routineId: gap.routineId, confidence: 'gap' }

  // Fallback: assign to most recently completed routine
  const completed = windows.filter((w) => w.recordingStopped.getTime() <= t)
  if (completed.length > 0) {
    return { routineId: completed[completed.length - 1].routineId, confidence: 'gap' }
  }

  return null
}

// --- Clock offset ---

function updateClockOffset(exifTime: Date): void {
  const offset = exifTime.getTime() - Date.now()
  clockOffsetSamples.push(offset)
  if (clockOffsetSamples.length > MAX_OFFSET_SAMPLES) {
    clockOffsetSamples.shift()
  }

  // Rolling average
  const avg = clockOffsetSamples.reduce((sum, v) => sum + v, 0) / clockOffsetSamples.length
  tetherState.cameraClockOffset = Math.round(avg)

  const absOffset = Math.abs(avg)
  if (absOffset < CLOCK_OK_THRESHOLD) {
    tetherState.clockSyncStatus = 'ok'
  } else if (absOffset < CLOCK_WARN_THRESHOLD) {
    tetherState.clockSyncStatus = 'warning'
  } else {
    tetherState.clockSyncStatus = 'error'
  }
}

// --- Photo processing ---

async function processNewPhoto(filePath: string): Promise<void> {
  const normalizedPath = path.normalize(filePath)
  if (importedFiles.has(normalizedPath)) return
  importedFiles.add(normalizedPath)

  logger.photos.info(`Tether: New photo detected: ${path.basename(filePath)}`)

  const captureTime = await getPhotoCaptureTime(filePath)
  if (!captureTime) {
    logger.photos.warn(`Tether: No EXIF timestamp for ${path.basename(filePath)} — skipping`)
    return
  }

  // Update clock offset
  updateClockOffset(captureTime)

  // Match to routine
  const windows = getRecordingWindows()
  const match = matchSinglePhoto(captureTime, windows)

  if (!match) {
    logger.photos.info(
      `Tether: Photo ${path.basename(filePath)} at ${captureTime.toISOString()} — no routine match`,
    )
    tetherState.photosReceived++
    tetherState.lastPhotoTime = captureTime.toISOString()
    broadcastTetherState()
    return
  }

  const comp = state.getCompetition()
  if (!comp) return
  const routine = comp.routines.find((r) => r.id === match.routineId)
  if (!routine) return

  // Determine destination directory
  const settings = getSettings()
  const baseDir = routine.outputDir
    ? routine.outputDir
    : settings.fileNaming.outputDirectory
      ? path.join(
          settings.fileNaming.outputDirectory,
          `${routine.entryNumber}_${routine.routineTitle.replace(/\s+/g, '_')}_${routine.studioCode}`,
        )
      : null

  if (!baseDir) {
    logger.photos.warn(`Tether: No output directory for routine #${routine.entryNumber}`)
    return
  }

  const photosDir = path.join(baseDir, 'photos')
  if (!fs.existsSync(photosDir)) {
    fs.mkdirSync(photosDir, { recursive: true })
  }

  // Copy photo
  const existingPhotos = routine.photos || []
  const photoNum = existingPhotos.length + 1
  const ext = path.extname(filePath)
  const destFile = path.join(photosDir, `photo_${String(photoNum).padStart(3, '0')}${ext}`)
  fs.copyFileSync(filePath, destFile)

  // Generate thumbnail
  let thumbPath: string | undefined
  try {
    const thumbDir = path.join(photosDir, 'thumbnails')
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })
    thumbPath = path.join(thumbDir, `thumb_${String(photoNum).padStart(3, '0')}.jpg`)
    await sharp(destFile).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(thumbPath)
  } catch (err) {
    logger.photos.warn(`Tether: Thumbnail failed for ${destFile}:`, err)
    thumbPath = undefined
  }

  // Build PhotoMatch
  const photoMatch: PhotoMatch = {
    filePath: destFile,
    thumbnailPath: thumbPath,
    captureTime: captureTime.toISOString(),
    confidence: match.confidence,
    uploaded: false,
    matchedRoutineId: match.routineId,
  }

  // Update routine state
  const updatedPhotos = [...existingPhotos, photoMatch]
  state.updateRoutineStatus(routine.id, routine.status, { photos: updatedPhotos })

  logger.photos.info(
    `Tether: Photo matched to #${routine.entryNumber} "${routine.routineTitle}" (${match.confidence}) — ${updatedPhotos.length} total photos`,
  )

  // Auto-upload if enabled
  if (settings.behavior.autoUploadAfterEncoding) {
    const updatedRoutine = state.getCompetition()?.routines.find((r) => r.id === routine.id)
    if (updatedRoutine) {
      uploadService.enqueueRoutine(updatedRoutine)
    }
  }

  // Update tether state
  tetherState.photosReceived++
  tetherState.lastPhotoTime = captureTime.toISOString()

  broadcastFullState()
  broadcastTetherState()
}

function broadcastTetherState(): void {
  sendToRenderer(IPC_CHANNELS.TETHER_PROGRESS, { ...tetherState })
}

// --- Public API ---

export async function startWatching(dcimPath: string): Promise<void> {
  if (watcher) {
    await stopWatching()
  }

  // Lazy-load chokidar
  if (!chokidar) {
    chokidar = await import('chokidar')
  }

  logger.photos.info(`Tether: Starting watch on ${dcimPath}`)

  // Reset state
  importedFiles.clear()
  clockOffsetSamples.length = 0
  tetherState = {
    active: true,
    watchPath: dcimPath,
    photosReceived: 0,
    lastPhotoTime: null,
    cameraClockOffset: 0,
    clockSyncStatus: 'unknown',
  }

  watcher = chokidar.watch(dcimPath, {
    ignored: /(^|[/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true, // only new files
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 200,
    },
    depth: 5,
  })

  watcher.on('add', (filePath: string) => {
    if (PHOTO_EXTENSIONS.test(filePath)) {
      processNewPhoto(filePath).catch((err) => {
        logger.photos.error(`Tether: Error processing ${path.basename(filePath)}:`, err)
      })
    }
  })

  watcher.on('error', (err: Error) => {
    logger.photos.error('Tether: Watcher error:', err)
  })

  broadcastTetherState()
  logger.photos.info(`Tether: Watching ${dcimPath} for new photos`)
}

export async function stopWatching(): Promise<void> {
  if (watcher) {
    await watcher.close()
    watcher = null
  }

  tetherState.active = false
  tetherState.watchPath = null
  broadcastTetherState()
  logger.photos.info('Tether: Stopped watching')
}

export function getTetherState(): TetherState {
  return { ...tetherState }
}
