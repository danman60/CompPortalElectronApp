import fs from 'fs'
import { execSync } from 'child_process'
import { StartupReport, IPC_CHANNELS } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as ffmpegService from './ffmpeg'
import * as jobQueue from './jobQueue'
import { sendToRenderer } from '../ipcUtil'

const DISK_WARNING_THRESHOLD_GB = 10
const SYNC_FOLDER_MARKERS = ['onedrive', 'dropbox', 'google drive', 'icloud']

function checkSyncFolder(dir: string): string | null {
  const lower = dir.toLowerCase()
  for (const marker of SYNC_FOLDER_MARKERS) {
    if (lower.includes(marker)) {
      return `Output directory appears to be inside a cloud sync folder (${marker}). Recordings may be copied in the background and cause sync conflicts.`
    }
  }
  return null
}

function checkBattery(): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic path Win32_Battery get EstimatedChargeRemaining /value', { timeout: 3000 }).toString()
      const match = out.match(/EstimatedChargeRemaining=(\d+)/i)
      if (match) {
        const pct = parseInt(match[1], 10)
        if (!isNaN(pct) && pct > 0 && pct < 30) {
          return `Battery is at ${pct}%. Plug in before the event.`
        }
      }
    }
  } catch {
    // No battery or wmic unavailable — skip silently
  }
  return null
}

/** Run startup validation checks. Called after window is ready. */
export async function runStartupChecks(): Promise<StartupReport> {
  logger.app.info('Running startup validation...')

  const warnings: string[] = []

  // 1. FFmpeg check
  const ffmpegVersion = await ffmpegService.validateFFmpeg()
  const ffmpegAvailable = ffmpegVersion !== null
  if (ffmpegAvailable) {
    logger.app.info(`FFmpeg available: ${ffmpegVersion}`)
  } else {
    logger.app.warn('FFmpeg not found — encoding will fail')
  }

  // 2. Disk space check
  let diskFreeGB = 0
  let diskWarning = false
  const settings = getSettings()
  const outputDir = settings.fileNaming.outputDirectory
  if (outputDir) {
    try {
      const stats = fs.statfsSync(outputDir)
      diskFreeGB = Math.round((stats.bavail * stats.bsize) / (1024 * 1024 * 1024) * 10) / 10
      diskWarning = diskFreeGB < DISK_WARNING_THRESHOLD_GB
      if (diskWarning) {
        logger.app.warn(`Low disk space on output drive: ${diskFreeGB}GB free`)
      } else {
        logger.app.info(`Disk space on output drive: ${diskFreeGB}GB free`)
      }
    } catch {
      logger.app.warn('Could not check disk space for output directory')
    }
  }

  // 3. Output dir check
  if (outputDir) {
    try {
      await fs.promises.access(outputDir, fs.constants.W_OK)
      logger.app.info(`Output directory writable: ${outputDir}`)
    } catch {
      logger.app.warn(`Output directory not writable: ${outputDir}`)
    }
  } else {
    logger.app.info('No output directory configured')
  }

  // 4. Job queue recovery count
  const resumedJobs = jobQueue.getPending().length

  // 5. Orphaned file count (from crash recovery — already ran)
  const orphanedFiles = 0 // crashRecovery handles this separately

  // Fix 7: sync-folder detection
  if (outputDir) {
    const syncWarning = checkSyncFolder(outputDir)
    if (syncWarning) {
      logger.app.warn(syncWarning)
      warnings.push(syncWarning)
    }
  }

  // Fix 7: battery check
  const batteryWarning = checkBattery()
  if (batteryWarning) {
    logger.app.warn(batteryWarning)
    warnings.push(batteryWarning)
  }

  if (diskWarning) {
    warnings.push(`Low disk space: ${diskFreeGB}GB free on output drive`)
  }
  if (!ffmpegAvailable) {
    warnings.push('FFmpeg not found — encoding will fail')
  }

  const report: StartupReport = {
    ffmpegAvailable,
    diskFreeGB,
    diskWarning,
    resumedJobs,
    orphanedFiles,
    warnings,
  }

  // Send to renderer for display
  sendToRenderer(IPC_CHANNELS.APP_STARTUP_REPORT, report)

  const parts: string[] = ['Startup complete.']
  if (!ffmpegAvailable) parts.push('WARNING: FFmpeg not found.')
  if (diskWarning) parts.push(`WARNING: Only ${diskFreeGB}GB disk space.`)
  if (resumedJobs > 0) parts.push(`${resumedJobs} jobs resumed from previous session.`)
  logger.app.info(parts.join(' '))

  return report
}
