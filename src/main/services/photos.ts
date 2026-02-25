import fs from 'fs'
import path from 'path'
import { dialog, BrowserWindow } from 'electron'
import ExifReader from 'exifreader'
import sharp from 'sharp'
import { Routine, PhotoMatch, IPC_CHANNELS } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'

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

export async function browseForFolder(): Promise<string | null> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null

  const result = await dialog.showOpenDialog(win, {
    title: 'Select Photo Folder',
    properties: ['openDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

async function getPhotoCaptureTime(filePath: string): Promise<Date | null> {
  try {
    const buffer = fs.readFileSync(filePath)
    const tags = ExifReader.load(buffer.buffer as ArrayBuffer)
    const dateTime = tags['DateTimeOriginal']?.description
    if (!dateTime) return null

    // Parse EXIF date format "YYYY:MM:DD HH:MM:SS"
    const [datePart, timePart] = dateTime.split(' ')
    const isoString = datePart.replace(/:/g, '-') + 'T' + timePart
    return new Date(isoString)
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

  // Find first photo and nearest recording window
  const sortedPhotos = [...photos].sort(
    (a, b) => a.captureTime.getTime() - b.captureTime.getTime(),
  )
  const sortedWindows = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )

  const firstPhoto = sortedPhotos[0]
  const nearestWindow = sortedWindows.reduce((nearest, w) => {
    const midpoint =
      (w.recordingStarted.getTime() + w.recordingStopped.getTime()) / 2
    const dist = Math.abs(firstPhoto.captureTime.getTime() - midpoint)
    const nearestDist = Math.abs(
      firstPhoto.captureTime.getTime() -
        (nearest.recordingStarted.getTime() + nearest.recordingStopped.getTime()) / 2,
    )
    return dist < nearestDist ? w : nearest
  })

  const windowMidpoint =
    (nearestWindow.recordingStarted.getTime() +
      nearestWindow.recordingStopped.getTime()) /
    2
  const offset = windowMidpoint - firstPhoto.captureTime.getTime()

  // Only apply if offset seems like a genuine clock difference (> 30s)
  if (Math.abs(offset) > 30000) {
    logger.photos.info(
      `Clock offset detected: ${Math.round(offset / 1000)}s (camera ${offset > 0 ? 'behind' : 'ahead'})`,
    )
    return offset
  }

  return 0
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

  return photos.map((photo) => {
    const adjustedTime = photo.captureTime.getTime() + clockOffsetMs

    // Exact match — within recording window
    const exactMatch = sorted.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() &&
        adjustedTime <= w.recordingStopped.getTime(),
    )

    if (exactMatch) {
      return {
        filePath: photo.path,
        captureTime: photo.captureTime.toISOString(),
        confidence: 'exact' as const,
        uploaded: false,
      }
    }

    // Gap match — within 30s buffer
    const gapMatch = sorted.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() - BUFFER_MS &&
        adjustedTime <= w.recordingStopped.getTime() + BUFFER_MS,
    )

    if (gapMatch) {
      return {
        filePath: photo.path,
        captureTime: photo.captureTime.toISOString(),
        confidence: 'gap' as const,
        uploaded: false,
      }
    }

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

  // Scan for JPG files
  const files = fs.readdirSync(folderPath).filter((f) => /\.(jpg|jpeg)$/i.test(f))
  logger.photos.info(`Found ${files.length} JPEG files`)

  sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
    stage: 'scanning',
    total: files.length,
    current: 0,
  })

  // Read EXIF timestamps
  const photos: { path: string; captureTime: Date }[] = []
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(folderPath, files[i])
    const captureTime = await getPhotoCaptureTime(filePath)
    if (captureTime) {
      photos.push({ path: filePath, captureTime })
    }

    if (i % 10 === 0) {
      sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
        stage: 'reading-exif',
        total: files.length,
        current: i,
      })
    }
  }

  logger.photos.info(`${photos.length}/${files.length} photos have EXIF timestamps`)

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

    // Build output folder name
    const routineDir = path.join(
      outputDir,
      `${routine.entryNumber}_${routine.routineTitle.replace(/\s+/g, '_')}_${routine.studioCode}`,
      'photos',
    )

    if (!fs.existsSync(routineDir)) {
      fs.mkdirSync(routineDir, { recursive: true })
    }

    const destFile = path.join(routineDir, `photo_${String(copiedCount + 1).padStart(3, '0')}.jpg`)
    fs.copyFileSync(match.filePath, destFile)
    match.filePath = destFile

    // Generate thumbnail
    try {
      const thumbDir = path.join(routineDir, 'thumbnails')
      if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })
      const thumbPath = path.join(thumbDir, `thumb_${String(copiedCount + 1).padStart(3, '0')}.webp`)
      await sharp(destFile).resize(200, 200, { fit: 'cover' }).webp({ quality: 80 }).toFile(thumbPath)
      match.thumbnailPath = thumbPath
    } catch (err) {
      logger.photos.warn(`Thumbnail generation failed for ${destFile}:`, err)
    }

    copiedCount++
  }

  const result: ImportResult = {
    totalPhotos: photos.length,
    matched: matches.filter((m) => m.confidence !== 'unmatched').length,
    unmatched: matches.filter((m) => m.confidence === 'unmatched').length,
    clockOffsetMs,
    matches,
  }

  logger.photos.info(
    `Import complete: ${result.matched} matched, ${result.unmatched} unmatched, offset: ${Math.round(clockOffsetMs / 1000)}s`,
  )

  sendToRenderer(IPC_CHANNELS.PHOTOS_MATCH_RESULT, result)
  return result
}
