import fs from 'fs'
import path from 'path'
import ExifReader from 'exifreader'
import { IPC_CHANNELS, CameraClockMismatchEvent } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'

/**
 * Drive Monitor — detects when removable storage (SD cards, USB drives) is plugged in.
 * Windows-only: polls drive letters for new mounts with DCIM folders (camera storage).
 */

const POLL_INTERVAL_MS = 3000
let pollTimer: NodeJS.Timeout | null = null
let knownDrives = new Set<string>()
let dismissed = new Set<string>() // drives user has dismissed this session

/** Get list of currently mounted drive letters on Windows */
function getWindowsDrives(): string[] {
  if (process.platform !== 'win32') return []
  const drives: string[] = []
  // Check drive letters D: through Z: (skip A:, B: floppy, C: system)
  for (let code = 68; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    const drivePath = `${letter}:\\`
    try {
      fs.accessSync(drivePath)
      drives.push(drivePath)
    } catch {
      // Drive not mounted
    }
  }
  return drives
}

/** Check if a drive looks like a camera SD card (has DCIM folder or JPEGs at root) */
function isCameraDrive(drivePath: string): { isDcim: boolean; photoPath: string; photoCount: number } {
  // Check for DCIM (standard camera folder structure)
  const dcimPath = path.join(drivePath, 'DCIM')
  try {
    if (fs.existsSync(dcimPath) && fs.statSync(dcimPath).isDirectory()) {
      const count = countJpegsRecursive(dcimPath, 2) // 2 levels deep
      return { isDcim: true, photoPath: dcimPath, photoCount: count }
    }
  } catch {}

  // Some cameras dump photos at root or in a folder
  try {
    const rootFiles = fs.readdirSync(drivePath)
    const jpegs = rootFiles.filter(f => /\.(jpg|jpeg)$/i.test(f))
    if (jpegs.length >= 3) {
      return { isDcim: false, photoPath: drivePath, photoCount: jpegs.length }
    }
  } catch {}

  return { isDcim: false, photoPath: '', photoCount: 0 }
}

/** Count JPEGs up to N directory levels deep */
function countJpegsRecursive(dir: string, maxDepth: number): number {
  if (maxDepth < 0) return 0
  let count = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && /\.(jpg|jpeg)$/i.test(entry.name)) {
        count++
      } else if (entry.isDirectory() && maxDepth > 0) {
        count += countJpegsRecursive(path.join(dir, entry.name), maxDepth - 1)
      }
      if (count > 999) return count // stop counting after 999
    }
  } catch {}
  return count
}

/** Collect up to N JPEG paths (shallow-first BFS) for EXIF sampling. */
function collectJpegSamples(dir: string, max: number, maxDepth = 3): string[] {
  const results: string[] = []
  const pendingDirs: { dir: string; depth: number }[] = [{ dir, depth: 0 }]
  while (pendingDirs.length > 0 && results.length < max) {
    const cur = pendingDirs.shift()!
    if (cur.depth > maxDepth) continue
    try {
      const entries = fs.readdirSync(cur.dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(cur.dir, entry.name)
        if (entry.isFile() && /\.(jpg|jpeg)$/i.test(entry.name)) {
          results.push(fullPath)
          if (results.length >= max) return results
        } else if (entry.isDirectory()) {
          pendingDirs.push({ dir: fullPath, depth: cur.depth + 1 })
        }
      }
    } catch {}
  }
  return results
}

/** Read EXIF DateTimeOriginal → local Date. No mtime/DateTime/DateTimeDigitized fallback. */
async function readExifDateTimeOriginal(filePath: string): Promise<Date | null> {
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
    return isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Sample up to 5 photos' EXIF DateTimeOriginal and compare to today's local date.
 * If any sampled photo has a non-today date, emit DRIVE_CAMERA_CLOCK_MISMATCH
 * so the renderer can surface a "camera clock is N days off" modal.
 *
 * Runs in the background after DRIVE_DETECTED so the existing import flow isn't
 * blocked — the operator sees both alerts and chooses how to proceed.
 */
async function sampleAndReportCameraClock(
  drivePath: string,
  photoPath: string,
  label: string,
): Promise<void> {
  try {
    const samples = collectJpegSamples(photoPath, 5)
    if (samples.length === 0) return

    const today = new Date()
    const todayDate = toLocalIsoDate(today)
    const dateCounts = new Map<string, number>()
    let sampledCount = 0
    let daysOffMax = 0

    for (const filePath of samples) {
      const dt = await readExifDateTimeOriginal(filePath)
      if (!dt) continue
      sampledCount++
      const isoDate = toLocalIsoDate(dt)
      dateCounts.set(isoDate, (dateCounts.get(isoDate) || 0) + 1)

      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      const shotMidnight = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
      const diffDays = Math.abs(Math.round(
        (shotMidnight.getTime() - todayMidnight.getTime()) / (24 * 60 * 60 * 1000),
      ))
      if (diffDays > daysOffMax) daysOffMax = diffDays
    }

    if (sampledCount === 0) {
      logger.photos.info(`Drive ${drivePath}: no EXIF timestamps in samples — skipping clock check`)
      return
    }
    if (daysOffMax === 0) {
      logger.photos.info(`Drive ${drivePath}: camera clock matches today (${sampledCount} samples OK)`)
      return
    }

    // Pick dominant date: highest count, tiebreaker = furthest from today.
    let dominantDate = todayDate
    let dominantCount = -1
    let dominantDiff = -1
    for (const [iso, count] of dateCounts) {
      const d = new Date(iso + 'T00:00:00')
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      const diffDays = Math.abs(Math.round(
        (d.getTime() - todayMidnight.getTime()) / (24 * 60 * 60 * 1000),
      ))
      if (count > dominantCount || (count === dominantCount && diffDays > dominantDiff)) {
        dominantCount = count
        dominantDiff = diffDays
        dominantDate = iso
      }
    }

    const sortedDates = [...dateCounts.keys()].sort().reverse()
    const payload: CameraClockMismatchEvent = {
      drivePath,
      photoPath,
      label,
      sampledDates: sortedDates,
      dominantDate,
      todayDate,
      daysOffMax,
      sampleCount: sampledCount,
    }
    logger.photos.warn(
      `CAMERA_CLOCK_MISMATCH: ${drivePath} (${label}) — ` +
      `dominant=${dominantDate}, today=${todayDate}, daysOff=${daysOffMax}, samples=${sampledCount}`,
    )
    sendToRenderer(IPC_CHANNELS.DRIVE_CAMERA_CLOCK_MISMATCH, payload)
  } catch (err) {
    logger.photos.warn(
      `sampleAndReportCameraClock failed for ${drivePath}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/** Get drive label via Windows vol command */
function getDriveLabel(drivePath: string): string {
  try {
    const { execSync } = require('child_process')
    const letter = drivePath.charAt(0)
    const output = execSync(`vol ${letter}:`, { timeout: 3000, windowsHide: true, encoding: 'utf-8' })
    // Output: " Volume in drive E is CANON_EOS\n Volume Serial Number is XXXX-XXXX"
    const match = output.match(/Volume in drive [A-Z] is (.+)/i)
    if (match) return match[1].trim()
  } catch {}
  return drivePath
}

function poll(): void {
  const currentDrives = getWindowsDrives()
  const currentSet = new Set(currentDrives)

  // Detect newly appeared drives
  for (const drive of currentDrives) {
    if (!knownDrives.has(drive) && !dismissed.has(drive)) {
      // New drive detected — check if it's a camera
      const camera = isCameraDrive(drive)
      if (camera.photoCount > 0) {
        const label = getDriveLabel(drive)
        logger.photos.info(
          `Camera drive detected: ${drive} (${label}) — ${camera.photoCount} photos in ${camera.isDcim ? 'DCIM' : 'root'}`,
        )
        sendToRenderer(IPC_CHANNELS.DRIVE_DETECTED, {
          drivePath: drive,
          photoPath: camera.photoPath,
          photoCount: camera.photoCount,
          isDcim: camera.isDcim,
          label,
        })
        // Background EXIF sample to catch wrong-day cameras (UDC London Cam 2
        // disaster: 15 days off, 171 unmatchable photos). Fire-and-forget so
        // the regular drive-detected flow isn't blocked.
        sampleAndReportCameraClock(drive, camera.photoPath, label).catch(() => {})
      }
    }
  }

  // Detect removed drives — clean up dismissed set
  for (const drive of dismissed) {
    if (!currentSet.has(drive)) {
      dismissed.delete(drive)
    }
  }

  knownDrives = currentSet
}

export function dismissDrive(drivePath: string): void {
  dismissed.add(drivePath)
  logger.photos.info(`Drive dismissed: ${drivePath}`)
}

export function startMonitoring(): void {
  if (pollTimer) return
  if (process.platform !== 'win32') {
    logger.photos.info('Drive monitor skipped (not Windows)')
    return
  }

  // Seed known drives so we don't alert on already-mounted drives at startup
  knownDrives = new Set(getWindowsDrives())
  logger.photos.info(`Drive monitor started — ${knownDrives.size} drives already mounted`)

  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
}

export function stopMonitoring(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
