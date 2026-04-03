import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import ExifReader from 'exifreader'
import sharp from 'sharp'
import { IPC_CHANNELS, Routine, PhotoMatch } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import * as state from './state'
import { broadcastFullState } from './recording'
import { getSettings } from './settings'
import * as uploadService from './upload'
import * as wpdBridge from './wpdBridge'
import type { WPDDevice, WPDDeviceEvent } from '../../shared/types'

// Use dynamic import for chokidar (ESM)
let chokidar: typeof import('chokidar') | null = null

export interface TetherState {
  active: boolean
  watchPath: string | null
  source: 'folder-watch' | 'wpd-mtp'
  sourceLabel?: string
  deviceId?: string | null
  deviceName?: string | null
  stagingDir?: string | null
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

interface StagedPhotoMetadata {
  filename?: string
  deviceName?: string
  captureTime?: string
  transferredAt?: string
}

const PHOTO_EXTENSIONS = /\.(jpg|jpeg|arw|cr3|nef|raf)$/i
const BUFFER_MS = 30_000
const CLOCK_OK_THRESHOLD = 5_000
const CLOCK_WARN_THRESHOLD = 30_000

let tetherState: TetherState = {
  active: false,
  watchPath: null,
  source: 'folder-watch',
  photosReceived: 0,
  lastPhotoTime: null,
  cameraClockOffset: 0,
  clockSyncStatus: 'unknown',
}

let watcher: import('chokidar').FSWatcher | null = null
// path → matched routineId, or null if seen but unmatched
const importedFiles = new Map<string, string | null>()
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

async function getStagedPhotoMetadata(filePath: string): Promise<StagedPhotoMetadata | null> {
  const sidecarPath = `${filePath}.json`

  try {
    const raw = await fs.promises.readFile(sidecarPath, 'utf8')
    return JSON.parse(raw) as StagedPhotoMetadata
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.photos.warn(`Tether: Failed to read metadata sidecar for ${path.basename(filePath)}:`, err)
    }
    return null
  }
}

function parseCaptureTime(value?: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
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

function getAdjustedCaptureTime(captureTime: Date): Date {
  return new Date(captureTime.getTime() - tetherState.cameraClockOffset)
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

async function processNewPhoto(
  filePath: string,
  incomingMetadata: Partial<StagedPhotoMetadata> = {},
): Promise<void> {
  const normalizedPath = path.normalize(filePath)
  const previousMatch = importedFiles.get(normalizedPath)
  if (previousMatch) return // already matched to a routine — skip
  // previousMatch === null → seen but unmatched, retry
  // previousMatch === undefined → never seen

  const isRetry = previousMatch === null

  if (!isRetry) {
    logger.photos.info(`Tether: New photo detected: ${path.basename(filePath)}`)
  }

  const stagedMetadata = await getStagedPhotoMetadata(filePath)
  const captureTime =
    parseCaptureTime(incomingMetadata.captureTime) ||
    parseCaptureTime(stagedMetadata?.captureTime) ||
    (await getPhotoCaptureTime(filePath))
  if (!captureTime) {
    if (!isRetry) {
      logger.photos.warn(`Tether: No EXIF timestamp for ${path.basename(filePath)} — skipping`)
    }
    importedFiles.set(normalizedPath, null)
    return
  }

  // Update clock offset
  updateClockOffset(captureTime)

  // Match to routine
  const windows = getRecordingWindows()
  const adjustedCaptureTime = getAdjustedCaptureTime(captureTime)
  const match = matchSinglePhoto(adjustedCaptureTime, windows)

  if (!match) {
    if (!isRetry) {
      logger.photos.info(
        `Tether: Photo ${path.basename(filePath)} at ${captureTime.toISOString()} (adjusted ${adjustedCaptureTime.toISOString()}) — no routine match`,
      )
      tetherState.photosReceived++
      tetherState.lastPhotoTime = captureTime.toISOString()
      broadcastTetherState()
    }
    importedFiles.set(normalizedPath, null)
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

  // Generate thumbnail (only for formats sharp can handle — JPEG, PNG, TIFF, WebP)
  let thumbPath: string | undefined
  const thumbableExts = /\.(jpg|jpeg|png|tiff?|webp)$/i
  if (thumbableExts.test(ext)) {
    try {
      const thumbDir = path.join(photosDir, 'thumbnails')
      if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })
      thumbPath = path.join(thumbDir, `thumb_${String(photoNum).padStart(3, '0')}.jpg`)
      await sharp(destFile).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(thumbPath)
    } catch (err) {
      logger.photos.warn(`Tether: Thumbnail failed for ${destFile}:`, err)
      thumbPath = undefined
    }
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

  // Update routine state + mark as matched
  const updatedPhotos = [...existingPhotos, photoMatch]
  state.updateRoutineStatus(routine.id, routine.status, { photos: updatedPhotos })
  importedFiles.set(normalizedPath, match.routineId)

  logger.photos.info(
    `Tether: Photo matched to #${routine.entryNumber} "${routine.routineTitle}" (${match.confidence}) — ${updatedPhotos.length} total photos`,
  )

  // Auto-upload if enabled
  if (settings.behavior.autoUploadAfterEncoding) {
    const updatedRoutine = state.getCompetition()?.routines.find((r) => r.id === routine.id)
    if (updatedRoutine) {
      const result = uploadService.enqueueRoutine(updatedRoutine)
      if (result.queuedJobs > 0) {
        uploadService.startUploads()
      }
    }
  }

  // Update tether state
  tetherState.photosReceived++
  tetherState.lastPhotoTime = captureTime.toISOString()

  broadcastFullState()
  broadcastTetherState()
}

function getWPDStagingDir(deviceId: string): string {
  const safeId = deviceId.replace(/[^a-zA-Z0-9_-]+/g, '_')
  return path.join(appDataTetherDir(), 'wpd-staging', safeId)
}

function appDataTetherDir(): string {
  return path.join(app.getPath('userData'), 'tether')
}

function broadcastTetherState(): void {
  sendToRenderer(IPC_CHANNELS.TETHER_PROGRESS, { ...tetherState })
}

// --- Rescan: retry unmatched + pick up new files (called after recording stops) ---

async function walkPhotos(dir: string, depth = 0): Promise<string[]> {
  if (depth > 5) return []
  const results: string[] = []
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walkPhotos(fullPath, depth + 1))
    } else if (PHOTO_EXTENSIONS.test(entry.name)) {
      results.push(fullPath)
    }
  }
  return results
}

export async function rescanPhotos(): Promise<number> {
  const watcherActive = tetherState.active && tetherState.source === 'folder-watch'
  const watchPath = tetherState.watchPath || getSettings().tether?.autoWatchFolder

  if (!watchPath) {
    logger.photos.info('Tether: rescanPhotos — no watch folder configured')
    return 0
  }

  let matched = 0
  const unmatchedCount = [...importedFiles.values()].filter((v) => v === null).length

  // 1. Retry previously unmatched photos (now we may have new recording windows)
  if (unmatchedCount > 0) {
    logger.photos.info(`Tether: Retrying ${unmatchedCount} unmatched photos`)
    for (const [filePath, routineId] of importedFiles) {
      if (routineId !== null) continue
      await processNewPhoto(filePath)
      if (importedFiles.get(filePath) !== null) matched++
    }
  }

  // 2. Only walk folder if watcher is NOT running (it already caught everything)
  if (!watcherActive) {
    if (!fs.existsSync(watchPath)) {
      logger.photos.warn(`Tether: rescanPhotos — folder not found: ${watchPath}`)
      return matched
    }
    logger.photos.info(`Tether: No live watcher — walking ${watchPath} for unseen files`)
    const allFiles = await walkPhotos(watchPath)
    for (const filePath of allFiles) {
      const normalized = path.normalize(filePath)
      if (importedFiles.has(normalized)) continue
      await processNewPhoto(filePath)
      if (importedFiles.get(normalized) !== null) matched++
    }
  }

  logger.photos.info(`Tether: Rescan complete — ${matched} new matches (${importedFiles.size} total tracked)`)
  return matched
}

// --- Public API ---

export async function startWatching(dcimPath: string): Promise<void> {
  await wpdBridge.stopWatching()
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
    source: 'folder-watch',
    sourceLabel: 'USB Drive',
    deviceId: null,
    deviceName: null,
    stagingDir: null,
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

export async function startWatchingWPD(deviceId: string): Promise<void> {
  await wpdBridge.stopWatching()
  if (watcher) {
    await stopWatching()
  }

  const devices = await wpdBridge.listDevices()
  const device = devices.find((entry) => entry.id === deviceId)
  if (!device) {
    throw new Error('WPD device not found')
  }

  const stagingDir = getWPDStagingDir(deviceId)
  await fs.promises.mkdir(stagingDir, { recursive: true })
  importedFiles.clear()
  clockOffsetSamples.length = 0

  tetherState = {
    active: true,
    watchPath: stagingDir,
    source: 'wpd-mtp',
    sourceLabel: 'MTP/PTP',
    deviceId,
    deviceName: device.name,
    stagingDir,
    photosReceived: 0,
    lastPhotoTime: null,
    cameraClockOffset: 0,
    clockSyncStatus: 'unknown',
  }

  await wpdBridge.watchDevice(deviceId, stagingDir)
  broadcastTetherState()
  logger.photos.info(`Tether: Watching WPD device ${device.name} (${deviceId}) via ${stagingDir}`)
}

export async function listWPDDevices(): Promise<WPDDevice[]> {
  return await wpdBridge.listDevices()
}

export async function stopWatching(): Promise<void> {
  if (watcher) {
    await watcher.close()
    watcher = null
  }

  await wpdBridge.stopWatching()

  tetherState.active = false
  tetherState.watchPath = null
  tetherState.source = 'folder-watch'
  tetherState.sourceLabel = undefined
  tetherState.deviceId = null
  tetherState.deviceName = null
  tetherState.stagingDir = null
  broadcastTetherState()
  logger.photos.info('Tether: Stopped watching')
}

export function getTetherState(): TetherState {
  return { ...tetherState }
}

export function initWPDHandlers(): void {
  logger.photos.info('Tether: Registering WPD handlers')
  wpdBridge.setHandlers({
    onPhoto: ({ path: filePath, captureTime, deviceName }) => {
      logger.photos.info(`Tether: WPD photo received — ${path.basename(filePath)} (captureTime=${captureTime || 'none'}, device=${deviceName || 'unknown'})`)
      processNewPhoto(filePath, { captureTime, deviceName }).catch((err) => {
        logger.photos.error(`Tether: WPD photo processing failed for ${path.basename(filePath)}:`, err)
      })
    },
    onDeviceEvent: (event: WPDDeviceEvent) => {
      logger.photos.info(`Tether: WPD device event — ${event.event}: ${event.device.name} (${event.device.id})`)
      sendToRenderer(IPC_CHANNELS.TETHER_WPD_DEVICE_EVENT, event)
    },
  })
  logger.photos.info('Tether: WPD handlers registered')
}
