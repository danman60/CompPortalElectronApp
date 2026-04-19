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
import * as manifest from './importManifest'
import type { ManifestEntry } from './importManifest'

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
  cancelled?: boolean
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function cancelledResult(): ImportResult {
  return {
    totalPhotos: 0,
    matched: 0,
    unmatched: 0,
    clockOffsetMs: 0,
    matches: [],
    cancelled: true,
  }
}

/** Local YYYY-MM-DD comparison — uses the same interpretation as getPhotoCaptureTime. */
function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function fmtLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Bug F mitigation: sample up to 20 EXIF DateTimeOriginal stamps from the
 * import set, compare to today (local). If majority do NOT match today, ask
 * the operator to confirm/skip/cancel before the matcher pollutes today's
 * routine folders with yesterday's photos. Saturday 2026-04-18 incident:
 * Friday's 21k SD imported on Saturday matched Saturday routines purely by
 * time-of-day overlap.
 *
 * Uses the existing EXIF interpretation — no timezone change.
 */
async function checkSourceDateMatchesToday(
  paths: string[],
): Promise<{ action: 'continue' | 'skip-mismatched' | 'cancel'; todayDate: string; dominantDate: string }> {
  const today = new Date()
  const todayDate = fmtLocalDate(today)

  if (paths.length === 0) {
    return { action: 'continue', todayDate, dominantDate: todayDate }
  }

  // Sample up to 20 photos evenly spaced through the partitionedPaths list.
  const sampleCount = Math.min(20, paths.length)
  const step = Math.max(1, Math.floor(paths.length / sampleCount))
  const samples: string[] = []
  for (let i = 0; i < paths.length && samples.length < sampleCount; i += step) {
    samples.push(paths[i])
  }

  const dateCounts = new Map<string, number>()
  let sampledOk = 0
  let todayCount = 0
  for (const fp of samples) {
    const d = await getPhotoCaptureTime(fp).catch(() => null)
    if (!d) continue
    sampledOk++
    const iso = fmtLocalDate(d)
    dateCounts.set(iso, (dateCounts.get(iso) || 0) + 1)
    if (iso === todayDate) todayCount++
  }

  if (sampledOk === 0) {
    // No EXIF reads succeeded — let the import continue, downstream logic
    // already handles "no captureTime" by dropping the photo.
    return { action: 'continue', todayDate, dominantDate: todayDate }
  }

  // If majority match today, no prompt needed.
  if (todayCount * 2 >= sampledOk) {
    return { action: 'continue', todayDate, dominantDate: todayDate }
  }

  // Pick dominant non-today date for the prompt.
  let dominantDate = todayDate
  let dominantCount = -1
  for (const [iso, count] of dateCounts) {
    if (count > dominantCount) {
      dominantCount = count
      dominantDate = iso
    }
  }

  logger.photos.warn(
    `Import date mismatch: ${sampledOk - todayCount}/${sampledOk} sampled photos NOT from today. ` +
    `Dominant date=${dominantDate}, today=${todayDate}. Asking operator.`,
  )

  // Show a blocking confirm dialog. Lazy-import dialog/BrowserWindow so this
  // module stays unit-testable.
  try {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      // No window — default to continue (legacy behavior). Logged above.
      return { action: 'continue', todayDate, dominantDate }
    }
    const summaryDates = [...dateCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([d, c]) => `  ${d}: ${c}`)
      .join('\n')
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'SD Card Date Mismatch',
      message: `This SD has photos from ${dominantDate}, but today is ${todayDate}.`,
      detail:
        `${sampledOk - todayCount}/${sampledOk} sampled photos do NOT match today's date.\n\n` +
        `Sampled date breakdown:\n${summaryDates}\n\n` +
        `Importing yesterday's photos onto today's routines will pollute the routine folders ` +
        `(Saturday 2026-04-18 incident).`,
      buttons: [
        'Cancel import',
        'Skip mismatched dates',
        'Import anyway',
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (result.response === 0) return { action: 'cancel', todayDate, dominantDate }
    if (result.response === 1) return { action: 'skip-mismatched', todayDate, dominantDate }
    return { action: 'continue', todayDate, dominantDate }
  } catch (err) {
    logger.photos.warn(
      'Date-mismatch dialog failed — defaulting to continue:',
      err instanceof Error ? err.message : err,
    )
    return { action: 'continue', todayDate, dominantDate }
  }
}

/**
 * Bug E mitigation: pre-flight check before feeding a file to sharp. The
 * libvips backend throws "TypeError: A boolean was expected" on certain
 * malformed/zero-byte/in-progress JPEGs. Validate file size + minimal JPEG
 * magic before calling sharp() so the failure mode is a clean log line
 * instead of a flood of cryptic stack traces.
 */
async function isThumbnailSafe(filePath: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(filePath)
    if (!st.isFile() || st.size < 256) return false
    // JPEG starts with 0xFFD8FFE0/E1/E8 — read first 4 bytes.
    const fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(4)
    await fh.read(buf, 0, 4, 0)
    await fh.close()
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  } catch {
    return false
  }
}

// ── Single-flight import lock + cancel (Saturday 2026-04-18 incident) ──
// The Photos button accepted parallel imports, causing two 21k-photo scans
// to race each other (EBUSY collisions, double thumbnails, runaway state).
// Reject the second invocation with an explicit error and expose a cancel
// IPC so the operator can stop a runaway without killing the app.
type CurrentImport = {
  abortController: AbortController
  folderPath: string
  startedAt: number
}
let currentImport: CurrentImport | null = null

export function isImportRunning(): boolean {
  return currentImport !== null
}

export function getCurrentImportInfo(): { folderPath: string; startedAt: number } | null {
  return currentImport
    ? { folderPath: currentImport.folderPath, startedAt: currentImport.startedAt }
    : null
}

export function cancelCurrentImport(): { ok: boolean; cancelled?: string; error?: string } {
  if (!currentImport) return { ok: false, error: 'No import in progress' }
  const folder = currentImport.folderPath
  try {
    currentImport.abortController.abort()
    logger.photos.warn(`Import cancellation requested for ${folder}`)
    return { ok: true, cancelled: folder }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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

/**
 * Camera body identifier derived from the filename prefix. Panasonic Lumix
 * (the operator's cameras) names files as `P<3-digit folder><4-digit seq>.JPG`.
 * We use `P<folder>` as the body key. NOT drive letter — SD cards rotate.
 *
 * Operator-confirmed camera body grouping (UDC London 2026-04-17):
 *   Cam 1 "OLD": folders 101-110 (prefixes P10x)
 *   Cam 2 "NEW": folders 166-189 (prefixes P16x/P17x/P18x)
 *
 * So the 4-character prefix (e.g. "P166") is a folder-level key; the first
 * 2 digits give a body-level key when the camera rolls multiple folders.
 * We use the body-level key (P1 + first digit, like "P16") for offset
 * persistence — same camera across folders gets the same offset.
 */
function getCameraBodyKey(filePath: string): string | null {
  const base = path.basename(filePath)
  const m = base.match(/^(P\d{2})\d{5}\.(?:jpg|jpeg)$/i)
  return m ? m[1].toUpperCase() : null
}

/**
 * DCIM folder name partitioning key. Lumix cameras create `DCIM/NNN_PANA/`
 * subfolders and increment NNN as each fills. Two sequential SDs in the
 * same reader slot can share the same drive letter but have different
 * NNN_PANA folders with different photos under the same filenames — we
 * must partition on folder to prevent filename-collision merge.
 */
function getDcimFolderKey(filePath: string): string {
  const segments = filePath.split(/[\\/]/)
  // Walk back to the DCIM/<folder>/ segment.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/^\d{3}_?/.test(segments[i])) {
      return segments[i].toUpperCase()
    }
  }
  return ''
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
  seedOffsetMs = 0,
): number {
  if (photos.length === 0 || windows.length === 0) return 0

  // Sample up to 10 evenly-spaced photos to generate candidate offsets
  const sampleCount = Math.min(10, photos.length)
  const step = Math.max(1, Math.floor(photos.length / sampleCount))
  const samplePhotos: typeof photos = []
  for (let i = 0; i < photos.length && samplePhotos.length < sampleCount; i += step) {
    samplePhotos.push(photos[i])
  }

  // For each sample photo, find the 3 nearest windows and generate candidate offsets.
  // seedOffsetMs is injected at the head of candidates — when a persisted
  // per-camera offset exists, it's evaluated first so sparse imports don't
  // re-learn from scratch when the second SD from the same body arrives.
  const candidates: number[] = [0]
  if (seedOffsetMs !== 0) candidates.unshift(seedOffsetMs)
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
): Promise<ImportResult | { error: string }> {
  // ── Single-flight guard (Bug C) ──
  // Reject parallel imports — double-clicking Photos used to race two 21k-photo
  // imports against each other and corrupt routine folders.
  if (currentImport) {
    const elapsedSec = Math.round((Date.now() - currentImport.startedAt) / 1000)
    const msg = `Already importing ${currentImport.folderPath} (running ${elapsedSec}s). Cancel the running import before starting a new one.`
    logger.photos.warn(`Rejected concurrent import attempt for ${folderPath}: ${msg}`)
    return { error: msg }
  }

  const abortController = new AbortController()
  const signal = abortController.signal
  currentImport = { abortController, folderPath, startedAt: Date.now() }

  try {
    return await runImport(folderPath, routines, outputDir, signal)
  } finally {
    currentImport = null
  }
}

async function runImport(
  folderPath: string,
  routines: Routine[],
  outputDir: string,
  signal: AbortSignal,
): Promise<ImportResult> {
  logger.photos.info(`Importing photos from: ${folderPath}`)

  const importRunId = new Date().toISOString()
  const seenHashes = await manifest.getUploadedHashes(outputDir).catch(() => new Set<string>())

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

  // Multi-SD / multi-camera namespace awareness (UDC London 2026-04-18):
  // F:\DCIM\166_PANA and H:\DCIM\166_PANA can both exist with DIFFERENT photos
  // that share filenames (P1667001.JPG on each). Partition by drive letter (or
  // top-level mount root on non-Windows) so any downstream ordering honours the
  // drive boundary. Matching/copying key off full paths + sourceHash so a
  // filename collision across drives cannot silently merge them. This is a
  // belt-and-suspenders guard against a future caller passing a union of two
  // roots, or scanDir returning entries from two drives via a symlink.
  // Partition on {driveRoot}::{dcimFolder}. Drive root alone is insufficient
  // because two sequential SDs swapped into the same reader share the same
  // drive letter. DCIM folder alone is insufficient because two SDs mounted
  // simultaneously can both expose 166_PANA. The composite key prevents
  // filename-collision merge across both dimensions (confirmed 2026-04-18
  // UDC London F:\DCIM\166_PANA + H:\DCIM\166_PANA both had P1667001.JPG
  // with different photos).
  const byDrive = new Map<string, string[]>()
  for (const fp of filePaths) {
    // On Windows "F:\foo" → "F:". On POSIX → "" (no drive) — fall back to first
    // path segment so SMB mounts like /mnt/sd1 vs /mnt/sd2 still partition.
    let driveKey = path.parse(fp).root
    if (!driveKey) {
      const first = fp.split(path.sep).filter(Boolean)[0]
      driveKey = first ? path.sep + first : path.sep
    }
    driveKey = driveKey.toUpperCase()
    const dcimKey = getDcimFolderKey(fp)
    const key = dcimKey ? `${driveKey}::${dcimKey}` : driveKey
    let arr = byDrive.get(key)
    if (!arr) { arr = []; byDrive.set(key, arr) }
    arr.push(fp)
  }
  if (byDrive.size > 1) {
    logger.photos.warn(
      `Import spans ${byDrive.size} partitions (${[...byDrive.keys()].join(', ')}) — ` +
      `processing in partition order to prevent filename-collision merge`,
    )
  }

  // Rebuild filePaths in drive-partitioned order: all photos from drive A, then
  // all photos from drive B, etc. Within a drive, preserve scan order so EXIF
  // reads stay sequential for disk locality.
  const partitionedPathsRaw: string[] = []
  for (const arr of byDrive.values()) {
    partitionedPathsRaw.push(...arr)
  }

  // ── SD watermark filter ──
  // Skip photos whose filename is <= the persisted watermark for that
  // camera body. Operator directive (2026-04-19): SDs always contain the
  // full competition's photos; each insertion should ONLY process photos
  // taken AFTER the app last saw this SD. Without this filter the
  // 2nd-day import re-scans yesterday's 10k photos (wasted EXIF reads,
  // potential mis-match against today's routines).
  const partitionedPaths: string[] = []
  let skippedByWatermark = 0
  for (const fp of partitionedPathsRaw) {
    const bodyKey = getCameraBodyKey(fp)
    if (!bodyKey) {
      partitionedPaths.push(fp)
      continue
    }
    const wm = state.getSdWatermark(bodyKey)
    if (wm) {
      const fileName = path.basename(fp).toUpperCase()
      // String comparison: "P1678123.JPG" > "P1668050.JPG" — valid because
      // Panasonic filenames are fixed-width and monotonically increasing.
      if (fileName <= wm.lastFilename.toUpperCase()) {
        skippedByWatermark++
        continue
      }
    }
    partitionedPaths.push(fp)
  }
  if (skippedByWatermark > 0) {
    logger.photos.info(
      `SD watermark filter: skipped ${skippedByWatermark}/${partitionedPathsRaw.length} photos (already processed in prior sessions)`,
    )
  }

  sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
    stage: 'scanning',
    total: filePaths.length,
    current: 0,
  })

  if (signal.aborted) {
    logger.photos.warn(`Import cancelled before EXIF read (${folderPath})`)
    return cancelledResult()
  }

  // ── Bug F: cross-day pollution check (Saturday 2026-04-18 incident) ──
  // Sample 20 photos' EXIF dates against today's local date BEFORE matching.
  // Friday's 21k SD photos were matched to Saturday routines by time-of-day
  // overlap because the matcher ignored the date portion of the EXIF stamp.
  // Surface a confirm dialog so the operator sees the wrong-day SD before
  // the matcher pollutes today's routine folders.
  // Uses the same EXIF interpretation as the rest of the code (no timezone
  // changes — see getPhotoCaptureTime).
  const dateGuard = await checkSourceDateMatchesToday(partitionedPaths)
  if (dateGuard.action === 'cancel') {
    logger.photos.warn(
      `Import cancelled by operator after wrong-date detection: dominant=${dateGuard.dominantDate}, today=${dateGuard.todayDate}`,
    )
    return cancelledResult()
  }
  const skipMismatchedDates = dateGuard.action === 'skip-mismatched'

  // Read EXIF timestamps + compute source hash per file, drop ones already uploaded.
  // Iterate partitionedPaths so multi-drive scans process drive-by-drive (see above).
  const photos: { path: string; captureTime: Date; sourceHash: string }[] = []
  let skippedDupes = 0
  let skippedWrongDate = 0
  for (let i = 0; i < partitionedPaths.length; i++) {
    if (signal.aborted) {
      logger.photos.warn(`Import cancelled during EXIF read at ${i}/${partitionedPaths.length}`)
      return cancelledResult()
    }
    const sourceHash = await manifest.computeSourceHash(partitionedPaths[i]).catch(() => '')
    if (sourceHash && seenHashes.has(sourceHash)) {
      skippedDupes++
      continue
    }
    const captureTime = await getPhotoCaptureTime(partitionedPaths[i])
    if (captureTime) {
      // Bug F skip-mismatched mode: drop photos whose EXIF date != today.
      if (skipMismatchedDates && !isSameLocalDate(captureTime, new Date())) {
        skippedWrongDate++
      } else {
        photos.push({ path: partitionedPaths[i], captureTime, sourceHash })
      }
    }

    // Yield more frequently for large imports so progress is visible and the
    // UI stays responsive (Bug B2: every-10 was fine for 500-photo imports
    // but causes ~500ms stalls at 21k).
    if (partitionedPaths.length >= 5000 || i % 10 === 0) {
      sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
        stage: 'reading-exif',
        total: partitionedPaths.length,
        current: i,
      })
      await yieldToEventLoop()
    }
  }
  if (skippedWrongDate > 0) {
    logger.photos.info(`Skipped ${skippedWrongDate} photos with non-today EXIF dates`)
  }

  logger.photos.info(`${photos.length}/${partitionedPaths.length} photos have EXIF timestamps (skipped ${skippedDupes} already-uploaded)`)

  // Build recording windows from routines
  const windows: RecordingWindow[] = routines
    .filter((r) => r.recordingStartedAt && r.recordingStoppedAt)
    .map((r) => ({
      routineId: r.id,
      entryNumber: r.entryNumber,
      recordingStarted: new Date(r.recordingStartedAt!),
      recordingStopped: new Date(r.recordingStoppedAt!),
    }))

  // ── Per-camera-body offset detection ────────────────────────────────
  // Group photos by filename-prefix body key ("P16", "P10", etc). Run
  // detection per body so Cam 1 and Cam 2 can have different offsets
  // (confirmed 2026-04-17 UDC London: Cam 2 was +60min before lunch but
  // reset to +0 after lunch, same camera). Seed with persisted offset so
  // a thin second SD from the same body doesn't re-learn from scratch.
  const photosByBody = new Map<string, typeof photos>()
  const photoBodyIndex: (string | null)[] = new Array(photos.length)
  for (let i = 0; i < photos.length; i++) {
    const body = getCameraBodyKey(photos[i].path) ?? '_unknown'
    photoBodyIndex[i] = body
    let arr = photosByBody.get(body)
    if (!arr) { arr = []; photosByBody.set(body, arr) }
    arr.push(photos[i])
  }

  const offsetByBody = new Map<string, number>()
  for (const [body, bodyPhotos] of photosByBody.entries()) {
    const seed = body !== '_unknown' ? (state.getCameraOffset(body)?.offsetMs ?? 0) : 0
    const detected = detectClockOffset(bodyPhotos, windows, seed)
    offsetByBody.set(body, detected)
    if (body !== '_unknown' && detected !== 0) {
      state.setCameraOffset(body, detected, 'auto')
      sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
        stage: 'matching',
        total: photos.length,
        current: 0,
        message: `Camera ${body}: offset ${Math.round(detected / 1000)}s applied`,
      })
    }
  }

  // Fallback for downstream code paths that still reference a single offset
  // (orphan sidecar write, manifest, etc). Pick the offset with the most
  // photos behind it as the "dominant" clockOffsetMs. Unknown-body photos
  // inherit this dominant offset.
  let dominantBody = '_unknown'
  let dominantCount = -1
  for (const [body, arr] of photosByBody.entries()) {
    if (arr.length > dominantCount) {
      dominantCount = arr.length
      dominantBody = body
    }
  }
  const clockOffsetMs = offsetByBody.get(dominantBody) ?? 0

  // Match photos to routines. We run matchPhotosToRoutines once per body
  // with that body's offset, then stitch the results back into original
  // input order so callers referencing photos[i] ↔ matches[i] stay valid.
  const matches = new Array<PhotoMatch>(photos.length)
  const matchesByBody = new Map<string, PhotoMatch[]>()
  const bodyIndexCursor = new Map<string, number>()
  for (const [body, bodyPhotos] of photosByBody.entries()) {
    const bodyOffset = offsetByBody.get(body) ?? 0
    const bodyMatches = matchPhotosToRoutines(bodyPhotos, windows, bodyOffset)
    matchesByBody.set(body, bodyMatches)
    bodyIndexCursor.set(body, 0)
  }
  for (let i = 0; i < photos.length; i++) {
    const body = photoBodyIndex[i] ?? '_unknown'
    const cursor = bodyIndexCursor.get(body) ?? 0
    const bodyMatches = matchesByBody.get(body)!
    matches[i] = bodyMatches[cursor]
    bodyIndexCursor.set(body, cursor + 1)
  }

  // Attach sourceHash to each match — used downstream for dedup + safe-delete gating.
  for (let i = 0; i < matches.length; i++) {
    const src = photos[i]
    if (!src) continue
    matches[i].sourceHash = src.sourceHash
    matches[i].sourcePath = src.path
  }

  const manifestEntries: ManifestEntry[] = []

  // Copy matched photos to routine folders and generate thumbnails
  let copiedCount = 0
  for (const match of matches) {
    if (signal.aborted) {
      logger.photos.warn(`Import cancelled during copy at ${copiedCount}/${matches.length}`)
      return cancelledResult()
    }
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
    const sourceForCopy = match.filePath
    await fs.promises.copyFile(sourceForCopy, destFile)
    match.sourcePath = sourceForCopy
    match.filePath = destFile

    // Generate thumbnail (WebP — small, fast, served directly by CompPortal Media Portal)
    // Bug E mitigation: validate the JPEG before feeding sharp. libvips throws
    // "TypeError: A boolean was expected" on zero-byte / partial / non-JPEG inputs.
    // Pre-flight check (isThumbnailSafe) turns those into a single info-line skip.
    //
    // UDC London 2026-04-19: sharp 0.33.5 in the asar runtime was throwing that
    // same TypeError on valid JPEGs too — 3,649/3,649 failures during Sunday SD
    // import. Root cause was an option default not propagating cleanly through
    // the asar bundle (pipeline call at sharp/lib/output.js:1536). Setting every
    // boolean option explicitly + failOn:'none' sidesteps the default-lookup
    // misfire.
    try {
      const thumbDir = path.join(routineDir, 'thumbnails')
      if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })
      const thumbPath = path.join(thumbDir, `thumb_${String(copiedCount + 1).padStart(3, '0')}.webp`)
      if (await isThumbnailSafe(destFile)) {
        await sharp(destFile, {
          failOn: 'none',
          sequentialRead: true,
          unlimited: false,
        })
          .rotate()
          .resize({
            width: 200,
            height: 200,
            fit: 'cover',
            withoutEnlargement: false,
            withoutReduction: false,
            fastShrinkOnLoad: true,
          })
          .webp({
            quality: 80,
            effort: 4,
            lossless: false,
            nearLossless: false,
            smartSubsample: false,
            alphaQuality: 100,
          })
          .toFile(thumbPath)
        match.thumbnailPath = thumbPath
      } else {
        logger.photos.info(`Thumbnail skipped (not a valid JPEG): ${destFile}`)
      }
    } catch (err) {
      logger.photos.warn(`Thumbnail generation failed for ${destFile}:`, err)
    }

    manifestEntries.push({
      sourcePath: match.sourcePath,
      sourceHash: match.sourceHash || '',
      routineId: routine.id,
      entryNumber: routine.entryNumber,
      destPath: destFile,
      uploaded: false,
      importedAt: new Date().toISOString(),
    })

    copiedCount++
    if (copiedCount % 10 === 0) {
      await yieldToEventLoop()
    }
  }

  // Route unmatched photos into _orphans/<runId>/ with a sidecar describing the nearest window.
  const orphanDir = path.join(outputDir, '_orphans', importRunId.replace(/[:.]/g, '-'))
  let orphanCount = 0
  const sortedWindows = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )
  for (const match of matches) {
    if (signal.aborted) {
      logger.photos.warn(`Import cancelled during orphan handling at ${orphanCount}`)
      return cancelledResult()
    }
    if (match.confidence !== 'unmatched') continue

    const sourceForCopy = match.filePath
    const captureMs = new Date(match.captureTime).getTime() + clockOffsetMs

    let nearestWindow: RecordingWindow | null = null
    let nearestDistMs = Infinity
    for (const w of sortedWindows) {
      const distStart = Math.abs(captureMs - w.recordingStarted.getTime())
      const distStop = Math.abs(captureMs - w.recordingStopped.getTime())
      const d = Math.min(distStart, distStop)
      if (d < nearestDistMs) { nearestDistMs = d; nearestWindow = w }
    }

    if (!fs.existsSync(orphanDir)) {
      await fs.promises.mkdir(orphanDir, { recursive: true })
    }
    const orphanName = `orphan_${String(orphanCount + 1).padStart(4, '0')}.jpg`
    const orphanDest = path.join(orphanDir, orphanName)
    await fs.promises.copyFile(sourceForCopy, orphanDest)

    const sidecar = {
      exifTime: match.captureTime,
      // Offset applied during this import's clock-offset detection. Rematch
      // code downstream adds this to `exifTime` before comparing to new
      // recording windows — otherwise an orphan imported under a +15min
      // offset would fail to rematch because its sidecar holds the raw
      // (offset-unaware) EXIF time while new windows are in real time.
      clockOffsetMs,
      nearestWindow: nearestWindow
        ? {
            routineId: nearestWindow.routineId,
            entryNumber: nearestWindow.entryNumber,
            recordingStarted: nearestWindow.recordingStarted.toISOString(),
            recordingStopped: nearestWindow.recordingStopped.toISOString(),
            distanceSec: Math.round(nearestDistMs / 1000),
          }
        : null,
      reason: sortedWindows.length === 0 ? 'no-recordings' : 'outside-all-windows',
    }
    await fs.promises.writeFile(orphanDest + '.json', JSON.stringify(sidecar, null, 2))

    match.sourcePath = sourceForCopy
    match.filePath = orphanDest

    manifestEntries.push({
      sourcePath: sourceForCopy,
      sourceHash: match.sourceHash || '',
      routineId: null,
      entryNumber: null,
      destPath: orphanDest,
      uploaded: false,
      importedAt: new Date().toISOString(),
    })

    orphanCount++
    if (orphanCount % 10 === 0) {
      await yieldToEventLoop()
    }
  }

  if (manifestEntries.length > 0) {
    try {
      await manifest.appendEntries(outputDir, importRunId, folderPath, manifestEntries)
    } catch (err) {
      logger.photos.warn('Manifest append failed (continuing):', err)
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
    const strategy = settings.upload?.strategy || 'routine-batch'
    if (strategy === 'round-robin') {
      const routinesWithPhotos: Routine[] = []
      for (const [routineId] of photosByRoutine) {
        const updatedRoutine = state.getCompetition()?.routines.find(r => r.id === routineId)
        if (updatedRoutine) routinesWithPhotos.push(updatedRoutine)
      }
      if (routinesWithPhotos.length > 0) {
        uploadService.enqueueRoundRobin(routinesWithPhotos)
        uploadService.startUploads()
      }
    } else {
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
  }

  logger.photos.info(
    `Import complete: ${result.matched} matched, ${result.unmatched} unmatched, offset: ${Math.round(clockOffsetMs / 1000)}s`,
  )

  // Advance SD watermark per camera body to the highest filename we saw
  // this import. Subsequent inserts will skip everything up through this
  // filename — enforcing the "only scan NEW photos" rule.
  const maxFileByBody: Record<string, string> = {}
  for (const p of partitionedPathsRaw) {
    const body = getCameraBodyKey(p)
    if (!body) continue
    const f = path.basename(p).toUpperCase()
    if (!maxFileByBody[body] || f > maxFileByBody[body]) maxFileByBody[body] = f
  }
  if (Object.keys(maxFileByBody).length > 0) {
    state.setSdWatermarksBulk(maxFileByBody)
  }

  // ── Distribution-sanity validator ──
  // Surface routines with unexpected photo counts so the operator sees silent
  // mis-matches without reading logs. These are soft warnings only — toast,
  // never block.
  //
  // UDC London 2026-04-19 calibration: flat 300 ceiling mis-flagged legitimate
  // Productions (R410 = 970 photos, real 7.7-min Production) AND couldn't
  // distinguish contaminated solos (R117 SOLO = 692 photos, almost certainly
  // mis-matched) from them. Fri+Sat data: every non-Production size category
  // maxes at ≤463 photos; only PRODUCTIONS exceeds that. Two-band model
  // matches operator's actual workflow: Production = extra-length, everything
  // else shoots for similar duration.
  const PRODUCTION_MAX = 1500
  const DEFAULT_MAX = 500
  const MIN_RECORDED = 10
  const routinesOverMax: Array<{ entryNumber: string; count: number; sizeCategory?: string; threshold: number }> = []
  const routinesUnderMin: Array<{ entryNumber: string; count: number; sizeCategory?: string; threshold: number }> = []
  for (const [routineId, list] of photosByRoutine.entries()) {
    const r = routines.find(rr => rr.id === routineId)
    const entryNumber = r?.entryNumber ?? routineId.slice(0, 8)
    const sizeCategory = r?.sizeCategory
    // Case-insensitive prefix match: schedule API returns 'PRODUCTIONS' today
    // but accept 'Production'/'Productions' too for future casing drift.
    const isProduction = (sizeCategory ?? '').toUpperCase().startsWith('PRODUCTION')
    const maxBound = isProduction ? PRODUCTION_MAX : DEFAULT_MAX
    if (list.length > maxBound) {
      routinesOverMax.push({ entryNumber, count: list.length, sizeCategory, threshold: maxBound })
    }
    // Only flag "under min" when the routine has been recorded — pending
    // routines legitimately have zero photos.
    if (list.length > 0 && list.length < MIN_RECORDED && r?.recordingStartedAt) {
      routinesUnderMin.push({ entryNumber, count: list.length, sizeCategory, threshold: MIN_RECORDED })
    }
  }
  if (routinesOverMax.length > 0) {
    logger.photos.warn(`Distribution sanity: ${routinesOverMax.length} routine(s) over max — ` +
      routinesOverMax.slice(0, 5).map(x => `R${x.entryNumber}[${x.sizeCategory ?? '?'}]=${x.count}>${x.threshold}`).join(', '))
  }
  if (routinesUnderMin.length > 0) {
    logger.photos.warn(`Distribution sanity: ${routinesUnderMin.length} recorded routine(s) under min — ` +
      routinesUnderMin.slice(0, 5).map(x => `R${x.entryNumber}[${x.sizeCategory ?? '?'}]=${x.count}<${x.threshold}`).join(', '))
  }

  sendToRenderer(IPC_CHANNELS.PHOTOS_MATCH_RESULT, result)

  // Completion summary — consumed by renderer toast + OrphanReview drawer.
  // Shape is stable (see tests/e2e-sd-import.mjs); extend by adding fields,
  // never rename existing keys. New distribution fields + per-camera offset
  // summary ride alongside existing data — old renderers ignore them.
  try {
    const cameraOffsetSummary: Record<string, number> = {}
    for (const [body, offsetMs] of offsetByBody.entries()) {
      if (body !== '_unknown') cameraOffsetSummary[body] = offsetMs
    }
    sendToRenderer(IPC_CHANNELS.PHOTOS_IMPORT_COMPLETE_SUMMARY, {
      runId: importRunId,
      routinesUpdated: photosByRoutine.size,
      photosUploaded: result.matched, // uploads happen async; this is "photos queued for upload"
      thumbsUploaded: matches.filter(m => m.confidence !== 'unmatched' && m.thumbnailPath).length,
      orphaned: result.unmatched,
      routinesOverMax,
      routinesUnderMin,
      cameraOffsets: cameraOffsetSummary,
    })
  } catch (err) {
    logger.photos.warn('import summary broadcast failed:', err instanceof Error ? err.message : err)
  }

  return result
}

/**
 * Reassign an orphaned photo to a routine. Moves the file from `_orphans/{runId}/`
 * into the target routine's photos folder, deletes the sidecar, and adds the
 * photo to the routine's state. Re-uses the existing auto-upload pipeline.
 *
 * Best-effort — if the routine lacks an outputDir or settings haven't loaded, we
 * log and no-op.
 */
export async function reassignOrphan(orphanPath: string, routineId: string): Promise<{ ok: boolean; error?: string; newPath?: string }> {
  try {
    const comp = state.getCompetition()
    if (!comp) return { ok: false, error: 'no-competition' }
    const routine = comp.routines.find(r => r.id === routineId)
    if (!routine) return { ok: false, error: 'routine-not-found' }
    const outputDir = getSettings().fileNaming.outputDirectory
    const baseDir = routine.outputDir
      ? routine.outputDir
      : path.join(outputDir, `${routine.entryNumber}_${routine.routineTitle.replace(/\s+/g, '_')}_${routine.studioCode}`)
    const photoDir = path.join(baseDir, 'photos')
    if (!fs.existsSync(photoDir)) await fs.promises.mkdir(photoDir, { recursive: true })

    const existing = routine.photos || []
    const nextIdx = existing.length + 1
    const destFile = path.join(photoDir, `photo_${String(nextIdx).padStart(3, '0')}.jpg`)
    await fs.promises.rename(orphanPath, destFile).catch(async () => {
      // Cross-device fallback: copy + unlink.
      await fs.promises.copyFile(orphanPath, destFile)
      await fs.promises.unlink(orphanPath)
    })
    // Remove sidecar (best-effort)
    await fs.promises.unlink(orphanPath + '.json').catch(() => {})

    // Generate thumb for the reassigned photo to keep /complete parallel arrays consistent.
    // Bug E mitigation: pre-flight JPEG validity check (see isThumbnailSafe).
    let thumbnailPath: string | undefined
    try {
      const thumbDir = path.join(photoDir, 'thumbnails')
      if (!fs.existsSync(thumbDir)) await fs.promises.mkdir(thumbDir, { recursive: true })
      thumbnailPath = path.join(thumbDir, `thumb_${String(nextIdx).padStart(3, '0')}.webp`)
      if (await isThumbnailSafe(destFile)) {
        await sharp(destFile, {
          failOn: 'none',
          sequentialRead: true,
          unlimited: false,
        })
          .rotate()
          .resize({
            width: 200,
            height: 200,
            fit: 'cover',
            withoutEnlargement: false,
            withoutReduction: false,
            fastShrinkOnLoad: true,
          })
          .webp({
            quality: 80,
            effort: 4,
            lossless: false,
            nearLossless: false,
            smartSubsample: false,
            alphaQuality: 100,
          })
          .toFile(thumbnailPath)
      } else {
        logger.photos.info(`Thumbnail skipped (not a valid JPEG): ${destFile}`)
        thumbnailPath = undefined
      }
    } catch (err) {
      logger.photos.warn(`Thumbnail generation failed for reassigned ${destFile}:`, err)
      thumbnailPath = undefined
    }

    const newPhoto: PhotoMatch = {
      filePath: destFile,
      thumbnailPath,
      captureTime: new Date().toISOString(),
      confidence: 'gap',
      uploaded: false,
      matchedRoutineId: routineId,
    }
    const nextPhotos = [...existing, newPhoto]
    state.updateRoutineStatus(routineId, routine.status, { photos: nextPhotos })
    broadcastFullState()

    // Queue for upload if auto-upload is on.
    if (getSettings().behavior.autoUploadAfterEncoding) {
      const fresh = state.getCompetition()?.routines.find(r => r.id === routineId)
      if (fresh) {
        const r = uploadService.enqueueRoutine(fresh)
        if (r.queuedJobs > 0) uploadService.startUploads()
      }
    }
    return { ok: true, newPath: destFile }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.photos.error(`reassignOrphan failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * Scan existing `_orphans/<runId>/` directories and reassign any orphans
 * whose EXIF DateTimeOriginal falls inside a newly-recorded routine's
 * window (with a small buffer). Called from handleRecordingStopped so
 * the "drop SD mid-session, later recordings auto-pick-up" flow works.
 *
 * Best-effort: errors on individual orphans are logged and skipped; the
 * function always resolves. Returns the count of photos successfully
 * reassigned.
 */
export async function rematchOrphansForWindow(
  routineId: string,
  startedAt: Date,
  stoppedAt: Date,
): Promise<number> {
  try {
    const outputDir = getSettings().fileNaming.outputDirectory
    if (!outputDir) return 0
    const orphanRoot = path.join(outputDir, '_orphans')
    if (!fs.existsSync(orphanRoot)) return 0

    // 30s buffer on each side so photos taken right at the boundary count.
    const BUFFER_MS = 30_000
    const winStart = startedAt.getTime() - BUFFER_MS
    const winStop = stoppedAt.getTime() + BUFFER_MS

    const runDirs = await fs.promises.readdir(orphanRoot)
    let reassigned = 0
    for (const runDir of runDirs) {
      const fullRunDir = path.join(orphanRoot, runDir)
      let files: string[]
      try {
        const s = await fs.promises.stat(fullRunDir)
        if (!s.isDirectory()) continue
        files = await fs.promises.readdir(fullRunDir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        const sidecarPath = path.join(fullRunDir, f)
        const jpgPath = sidecarPath.replace(/\.json$/, '')
        try {
          if (!fs.existsSync(jpgPath)) continue
          const raw = await fs.promises.readFile(sidecarPath, 'utf-8')
          const parsed = JSON.parse(raw) as { exifTime?: string; clockOffsetMs?: number }
          if (!parsed.exifTime) continue
          const exifMs = Date.parse(parsed.exifTime)
          if (!Number.isFinite(exifMs)) continue
          // Apply the offset that was detected during the original import.
          // Missing in old orphans (pre-fix) — treat as 0 for back-compat.
          const offset = Number.isFinite(parsed.clockOffsetMs) ? (parsed.clockOffsetMs as number) : 0
          const adjustedMs = exifMs + offset
          if (adjustedMs < winStart || adjustedMs > winStop) continue
          // Match. Reassign.
          const res = await reassignOrphan(jpgPath, routineId)
          if (res.ok) {
            reassigned++
            logger.photos.info(`rematchOrphans: moved ${jpgPath} -> routine ${routineId}`)
          } else {
            logger.photos.warn(`rematchOrphans: reassign failed for ${jpgPath}: ${res.error}`)
          }
        } catch (err) {
          logger.photos.warn(`rematchOrphans: skip ${sidecarPath}: ${err instanceof Error ? err.message : err}`)
        }
      }
    }
    if (reassigned > 0) {
      logger.photos.info(`rematchOrphans: reassigned ${reassigned} photo(s) to routine ${routineId}`)
    }
    return reassigned
  } catch (err) {
    logger.photos.warn(`rematchOrphans failed: ${err instanceof Error ? err.message : err}`)
    return 0
  }
}

/**
 * Scan all currently-mounted camera drives and advance SD watermarks to
 * the highest filename on each. Operator's "mark SDs as processed" button
 * fires this — after invocation, subsequent imports only pick up photos
 * with a filename greater than what's on the SD right now.
 *
 * Side-effect: does NOT import any photos, does NOT modify state.routines.
 * Only writes to state.sdWatermarks.
 *
 * Returns a summary of what was marked, for operator confirmation toast.
 */
export async function markCurrentSdsAsProcessed(): Promise<{
  scannedDrives: number
  watermarksSet: Record<string, string>
  error?: string
}> {
  try {
    // Lazy require to avoid any main-bundle cycle concerns.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const driveMonitor = require('./driveMonitor') as typeof import('./driveMonitor')
    const drives = driveMonitor.scanCurrentCameraDrives()
    if (drives.length === 0) {
      return { scannedDrives: 0, watermarksSet: {} }
    }
    const maxByBody: Record<string, string> = {}
    for (const d of drives) {
      // Recursively scan this drive's photo folder for JPEGs. Cheap — just
      // filename enumeration, no content reads.
      const files = await collectJpegFilenames(d.photoPath)
      for (const full of files) {
        const body = getCameraBodyKey(full)
        if (!body) continue
        const f = path.basename(full).toUpperCase()
        if (!maxByBody[body] || f > maxByBody[body]) maxByBody[body] = f
      }
    }
    state.setSdWatermarksBulk(maxByBody)
    return { scannedDrives: drives.length, watermarksSet: maxByBody }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.photos.error(`markCurrentSdsAsProcessed failed: ${msg}`)
    return { scannedDrives: 0, watermarksSet: {}, error: msg }
  }
}

async function collectJpegFilenames(root: string): Promise<string[]> {
  const out: string[] = []
  const pending: string[] = [root]
  while (pending.length > 0) {
    const dir = pending.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) pending.push(full)
      else if (/\.(jpg|jpeg)$/i.test(e.name)) out.push(full)
    }
  }
  return out
}

/** Delete an orphan photo and its sidecar. */
export async function discardOrphan(orphanPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fs.promises.unlink(orphanPath).catch(() => {})
    await fs.promises.unlink(orphanPath + '.json').catch(() => {})
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}
