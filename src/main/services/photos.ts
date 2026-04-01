import fs from 'fs'
import path from 'path'
import { dialog, BrowserWindow } from 'electron'
import ExifReader from 'exifreader'
import sharp from 'sharp'
import { Routine, PhotoMatch, IPC_CHANNELS } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import * as state from './state'
import { broadcastFullState } from './recording'
import { getSettings } from './settings'
import * as uploadService from './upload'

interface RecordingWindow {
  routineId: string
  entryNumber: string
  recordingStarted: Date
  recordingStopped: Date
}

interface ImportResult {
  totalPhotos: number
  matched: number
  unmatched: number
  clockOffsetMs: number
  matches: PhotoMatch[]
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export async function browseForFolder(): Promise<string | null> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null

  const result = await dialog.showOpenDialog(win, {
    title: 'Select Photo Folder (SD Card / DCIM)',
    defaultPath: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', // This PC CLSID
    properties: ['openDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

async function getPhotoCaptureTime(filePath: string): Promise<Date | null> {
  try {
    // Read only first 128KB — EXIF data is always in the file header
    const EXIF_HEADER_SIZE = 128 * 1024
    const fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(EXIF_HEADER_SIZE)
    const { bytesRead } = await fh.read(buf, 0, EXIF_HEADER_SIZE, 0)
    await fh.close()
    const buffer = buf.subarray(0, bytesRead)
    const tags = ExifReader.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
    const dateTime = tags['DateTimeOriginal']?.description
    if (!dateTime) return null

    // Parse EXIF date format "YYYY:MM:DD HH:MM:SS"
    // EXIF DateTimeOriginal is LOCAL time (no timezone) — cameras don't store UTC.
    // Treat as local by NOT appending 'Z'. new Date("2026-03-24T14:30:00") parses as local.
    const [datePart, timePart] = dateTime.split(' ')
    if (!datePart || !timePart) return null
    const isoString = datePart.replace(/:/g, '-') + 'T' + timePart
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return null
    return d
  } catch (err) {
    logger.photos.warn(`Failed to read EXIF from ${path.basename(filePath)}:`, err)
    return null
  }
}

function detectClockOffset(
  photos: { path: string; captureTime: Date }[],
  windows: RecordingWindow[],
): number {
  if (photos.length === 0 || windows.length === 0) return 0

  // Sample up to 10 evenly-spaced photos to generate candidate offsets
  const sampleCount = Math.min(10, photos.length)
  const step = Math.max(1, Math.floor(photos.length / sampleCount))
  const samplePhotos: typeof photos = []
  for (let i = 0; i < photos.length && samplePhotos.length < sampleCount; i += step) {
    samplePhotos.push(photos[i])
  }

  // For each sample photo, find the 3 nearest windows and generate candidate offsets
  const candidates: number[] = [0]
  const sortedWindows = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )
  for (const photo of samplePhotos) {
    const distances = sortedWindows.map((w) => ({
      w,
      dist: Math.abs(photo.captureTime.getTime() - (w.recordingStarted.getTime() + w.recordingStopped.getTime()) / 2),
    }))
    distances.sort((a, b) => a.dist - b.dist)
    for (const { w } of distances.slice(0, 3)) {
      const mid = (w.recordingStarted.getTime() + w.recordingStopped.getTime()) / 2
      candidates.push(mid - photo.captureTime.getTime())
    }
  }

  // Score each candidate using all photos (but deduplicate candidates first)
  const BUFFER = 30_000
  let bestOffset = 0
  let bestScore = 0

  const tested = new Set<number>()
  for (const candidate of candidates) {
    const rounded = Math.round(candidate / 1000) * 1000
    if (tested.has(rounded)) continue
    tested.add(rounded)

    let score = 0
    for (const photo of photos) {
      const adjusted = photo.captureTime.getTime() + rounded
      // Binary search would be ideal but linear is fine for ~700 windows
      for (const w of sortedWindows) {
        if (adjusted >= w.recordingStarted.getTime() - BUFFER &&
            adjusted <= w.recordingStopped.getTime() + BUFFER) {
          score++
          break
        }
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestOffset = rounded
    }
  }

  if (bestOffset !== 0) {
    logger.photos.info(
      `Clock offset detected: ${Math.round(bestOffset / 1000)}s (camera ${bestOffset > 0 ? 'behind' : 'ahead'}) — matched ${bestScore}/${photos.length} photos`,
    )
  } else {
    logger.photos.info(`No clock offset needed — ${bestScore}/${photos.length} photos match at zero offset`)
  }

  return bestOffset
}

function matchPhotosToRoutines(
  photos: { path: string; captureTime: Date }[],
  windows: RecordingWindow[],
  clockOffsetMs: number,
): PhotoMatch[] {
  const sorted = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )
  const BUFFER_MS = 30_000

  // Log all recording windows for debugging
  for (const w of sorted) {
    logger.photos.info(`  Window: ${w.entryNumber} ${w.routineId.slice(0, 8)} ${w.recordingStarted.toISOString()} → ${w.recordingStopped.toISOString()}`)
  }

  return photos.map((photo) => {
    const adjustedTime = photo.captureTime.getTime() + clockOffsetMs
    const adjustedDate = new Date(adjustedTime)
    const fileName = path.basename(photo.path)

    // Exact match — within recording window
    const exactMatch = sorted.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() &&
        adjustedTime <= w.recordingStopped.getTime(),
    )

    if (exactMatch) {
      logger.photos.info(`  ${fileName}: EXIF=${photo.captureTime.toISOString()} adjusted=${adjustedDate.toISOString()} → EXACT match #${exactMatch.entryNumber}`)
      return {
        filePath: photo.path,
        captureTime: photo.captureTime.toISOString(),
        confidence: 'exact' as const,
        uploaded: false,
        matchedRoutineId: exactMatch.routineId,
      }
    }

    // Gap match — within 30s buffer
    const gapMatch = sorted.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() - BUFFER_MS &&
        adjustedTime <= w.recordingStopped.getTime() + BUFFER_MS,
    )

    if (gapMatch) {
      logger.photos.info(`  ${fileName}: EXIF=${photo.captureTime.toISOString()} adjusted=${adjustedDate.toISOString()} → GAP match #${gapMatch.entryNumber}`)
      return {
        filePath: photo.path,
        captureTime: photo.captureTime.toISOString(),
        confidence: 'gap' as const,
        uploaded: false,
        matchedRoutineId: gapMatch.routineId,
      }
    }

    // Find nearest window for debug
    let nearestDist = Infinity
    let nearestEntry = ''
    for (const w of sorted) {
      const distStart = Math.abs(adjustedTime - w.recordingStarted.getTime())
      const distStop = Math.abs(adjustedTime - w.recordingStopped.getTime())
      const dist = Math.min(distStart, distStop)
      if (dist < nearestDist) { nearestDist = dist; nearestEntry = w.entryNumber }
    }
    logger.photos.info(`  ${fileName}: EXIF=${photo.captureTime.toISOString()} adjusted=${adjustedDate.toISOString()} → UNMATCHED (nearest: #${nearestEntry}, ${Math.round(nearestDist / 1000)}s away)`)

    return {
      filePath: photo.path,
      captureTime: photo.captureTime.toISOString(),
      confidence: 'unmatched' as const,
      uploaded: false,
    }
  })
}

export async function importPhotos(
  folderPath: string,
  routines: Routine[],
  outputDir: string,
): Promise<ImportResult> {
  logger.photos.info(`Importing photos from: ${folderPath}`)

  // Scan recursively in batches so the main event loop stays responsive during large imports.
  async function scanDir(rootDir: string): Promise<string[]> {
    const results: string[] = []
    const pendingDirs: string[] = [rootDir]
    let processedDirs = 0

    while (pendingDirs.length > 0) {
      const dir = pendingDirs.pop()!
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          pendingDirs.push(entryPath)
        } else if (/\.(jpg|jpeg)$/i.test(entry.name)) {
          results.push(entryPath)
        }
      }

      processedDirs++
      if (processedDirs % 25 === 0) {
        await yieldToEventLoop()
      }
    }

    return results
  }
  const filePaths = await scanDir(folderPath)
  logger.photos.info(`Found ${filePaths.length} JPEG files`)

  sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
    stage: 'scanning',
    total: filePaths.length,
    current: 0,
  })

  // Read EXIF timestamps
  const photos: { path: string; captureTime: Date }[] = []
  for (let i = 0; i < filePaths.length; i++) {
    const captureTime = await getPhotoCaptureTime(filePaths[i])
    if (captureTime) {
      photos.push({ path: filePaths[i], captureTime })
    }

    if (i % 10 === 0) {
      sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
        stage: 'reading-exif',
        total: filePaths.length,
        current: i,
      })
      await yieldToEventLoop()
    }
  }

  logger.photos.info(`${photos.length}/${filePaths.length} photos have EXIF timestamps`)

  // Build recording windows from routines
  const windows: RecordingWindow[] = routines
    .filter((r) => r.recordingStartedAt && r.recordingStoppedAt)
    .map((r) => ({
      routineId: r.id,
      entryNumber: r.entryNumber,
      recordingStarted: new Date(r.recordingStartedAt!),
      recordingStopped: new Date(r.recordingStoppedAt!),
    }))

  // Detect clock offset
  const clockOffsetMs = detectClockOffset(photos, windows)

  // Match photos to routines
  const matches = matchPhotosToRoutines(photos, windows, clockOffsetMs)

  // Copy matched photos to routine folders and generate thumbnails
  let copiedCount = 0
  for (const match of matches) {
    if (match.confidence === 'unmatched') continue

    // Find which routine this photo matched
    const adjustedTime = new Date(match.captureTime).getTime() + clockOffsetMs
    const matchedWindow = windows.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() - 30000 &&
        adjustedTime <= w.recordingStopped.getTime() + 30000,
    )

    if (!matchedWindow) continue

    const routine = routines.find((r) => r.id === matchedWindow.routineId)
    if (!routine) continue

    // Use existing routine output dir if available, otherwise construct from settings
    const baseDir = routine.outputDir
      ? routine.outputDir
      : path.join(
          outputDir,
          `${routine.entryNumber}_${routine.routineTitle.replace(/\s+/g, '_')}_${routine.studioCode}`,
        )
    const routineDir = path.join(baseDir, 'photos')

    if (!fs.existsSync(routineDir)) {
      await fs.promises.mkdir(routineDir, { recursive: true })
    }

    const destFile = path.join(routineDir, `photo_${String(copiedCount + 1).padStart(3, '0')}.jpg`)
    await fs.promises.copyFile(match.filePath, destFile)
    match.filePath = destFile

    // Generate thumbnail
    try {
      const thumbDir = path.join(routineDir, 'thumbnails')
      if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })
      const thumbPath = path.join(thumbDir, `thumb_${String(copiedCount + 1).padStart(3, '0')}.jpg`)
      await sharp(destFile).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(thumbPath)
      match.thumbnailPath = thumbPath
    } catch (err) {
      logger.photos.warn(`Thumbnail generation failed for ${destFile}:`, err)
    }

    copiedCount++
    if (copiedCount % 10 === 0) {
      await yieldToEventLoop()
    }
  }

  const result: ImportResult = {
    totalPhotos: photos.length,
    matched: matches.filter((m) => m.confidence !== 'unmatched').length,
    unmatched: matches.filter((m) => m.confidence === 'unmatched').length,
    clockOffsetMs,
    matches,
  }

  // Update routine state with matched photos
  const photosByRoutine = new Map<string, PhotoMatch[]>()
  for (const match of matches) {
    if (match.confidence === 'unmatched' || !match.matchedRoutineId) continue
    const list = photosByRoutine.get(match.matchedRoutineId) || []
    list.push(match)
    photosByRoutine.set(match.matchedRoutineId, list)
  }
  for (const [routineId, routinePhotos] of photosByRoutine) {
    const routine = routines.find(r => r.id === routineId)
    if (routine) {
      state.updateRoutineStatus(routineId, routine.status, { photos: routinePhotos })
    }
  }
  broadcastFullState()

  // Auto-upload photos if enabled
  const settings = getSettings()
  if (settings.behavior.autoUploadAfterEncoding) {
    for (const [routineId] of photosByRoutine) {
      const updatedRoutine = state.getCompetition()?.routines.find(r => r.id === routineId)
      if (updatedRoutine) {
        const result = uploadService.enqueueRoutine(updatedRoutine)
        if (result.queuedJobs > 0) {
          uploadService.startUploads()
        }
      }
    }
  }

  logger.photos.info(
    `Import complete: ${result.matched} matched, ${result.unmatched} unmatched, offset: ${Math.round(clockOffsetMs / 1000)}s`,
  )

  sendToRenderer(IPC_CHANNELS.PHOTOS_MATCH_RESULT, result)
  return result
}
