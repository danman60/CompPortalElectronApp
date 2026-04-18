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

/**
 * Upstream metadata hint shape. We intentionally DO NOT use `captureTime`
 * from this struct for matching — EXIF DateTimeOriginal is the single source
 * of truth (see processNewPhoto). Kept for potential future use (deviceName
 * surfacing, filename logging), not currently read.
 */
interface StagedPhotoMetadata {
  filename?: string
  deviceName?: string
  captureTime?: string
  transferredAt?: string
}

const PHOTO_EXTENSIONS = /\.(jpg|jpeg|arw|cr3|nef|raf)$/i
function getBufferMs(): number {
  return getSettings().tether?.matchBufferMs ?? 5000
}
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

// getStagedPhotoMetadata + parseCaptureTime intentionally removed:
// they were the sidecar/incoming fallback path for captureTime. That path is
// now explicitly disallowed — EXIF DateTimeOriginal is the only accepted time
// source for tether matching (UDC London 2026-04-18 rule).

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
      t >= w.recordingStarted.getTime() - getBufferMs() &&
      t <= w.recordingStopped.getTime() + getBufferMs(),
  )
  if (gap) return { routineId: gap.routineId, confidence: 'gap' }

  // No fallback — return null so rescan can retry when more windows exist.
  // The old "assign to most recent completed routine" caused mis-matches
  // when photos arrived before the correct routine's window was set.
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

  // Use median (stable) instead of rolling average (bouncy)
  const sorted = [...clockOffsetSamples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  tetherState.cameraClockOffset = Math.round(median)

  const absOffset = Math.abs(median)
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

  // EXIF DateTimeOriginal only — no fallback to file mtime, sidecar metadata,
  // or incoming-metadata capture hints. UDC London 2026 postmortem rule:
  // copying / syncing files shifts mtime, contaminates matching. The sidecar
  // and WPD helper's captureTime hints are upstream best-effort and have been
  // observed to reflect transfer time rather than shutter time on some camera
  // bodies. If EXIF DateTimeOriginal is missing, fail loud and skip — never
  // silently fall back to a different time source.
  const captureTime = await getPhotoCaptureTime(filePath)
  if (!captureTime) {
    if (!isRetry) {
      logger.photos.warn(
        `Tether: EXIF DateTimeOriginal MISSING for ${path.basename(filePath)} — skipping ` +
        `(no mtime/sidecar fallback; fix the camera EXIF or import manually)`,
      )
    }
    // Discard any upstream captureTime hint we received — do NOT use it.
    void incomingMetadata
    importedFiles.set(normalizedPath, null)
    return
  }

  // Update clock offset
  updateClockOffset(captureTime)

  // Match to routine — use raw EXIF time directly. The clock offset
  // adjustment was corrupted by tether transfer delay: photos arrive
  // 10-30s after shutter, making updateClockOffset think the camera is
  // ahead, then overcorrecting by pushing timestamps into the future.
  // Camera clock is confirmed synced at the venue.
  const windows = getRecordingWindows()
  const adjustedCaptureTime = captureTime
  const match = matchSinglePhoto(adjustedCaptureTime, windows)

  if (!match) {
    if (isRetry) {
      logger.photos.info(
        `Tether: Retry still no match — ${path.basename(filePath)} at ${adjustedCaptureTime.toISOString()} vs ${windows.length} windows`,
      )
    } else {
      logger.photos.info(
        `Tether: Photo ${path.basename(filePath)} at ${captureTime.toISOString()} (adjusted ${adjustedCaptureTime.toISOString()}) — no routine match (${windows.length} windows)`,
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

  // Thumbnails disabled — sharp native module crashes on Windows with "A boolean was expected"
  // TODO: investigate sharp win32-x64 binary compatibility with Electron 33
  const thumbPath: string | undefined = undefined

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
    `Tether: ${isRetry ? 'RETRY ' : ''}Photo matched to #${routine.entryNumber} "${routine.routineTitle}" (${match.confidence}) — ${updatedPhotos.length} total photos`,
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
