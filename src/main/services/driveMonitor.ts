import fs from 'fs'
import path from 'path'
import { IPC_CHANNELS } from '../../shared/types'
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
