import fs from 'fs'
import { StartupReport, IPC_CHANNELS } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as ffmpegService from './ffmpeg'
import * as jobQueue from './jobQueue'
import { sendToRenderer } from '../ipcUtil'

const DISK_WARNING_THRESHOLD_GB = 10

/** Run startup validation checks. Called after window is ready. */
export async function runStartupChecks(): Promise<StartupReport> {
  logger.app.info('Running startup validation...')

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

  const report: StartupReport = {
    ffmpegAvailable,
    diskFreeGB,
    diskWarning,
    resumedJobs,
    orphanedFiles,
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
