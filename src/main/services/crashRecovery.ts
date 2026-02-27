import fs from 'fs'
import path from 'path'
import { dialog, BrowserWindow } from 'electron'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as ffmpegService from './ffmpeg'
import * as jobQueue from './jobQueue'

interface OrphanedFile {
  filePath: string
  fileName: string
  size: number
  modifiedAt: Date
}

/** Scan for orphaned MKVs without corresponding encoded MP4s. */
export async function scanForOrphans(): Promise<OrphanedFile[]> {
  const settings = getSettings()
  const outputDir = settings.fileNaming.outputDirectory
  if (!outputDir || !fs.existsSync(outputDir)) return []

  logger.app.info(`Scanning for orphaned MKVs in ${outputDir}`)
  const orphans: OrphanedFile[] = []

  try {
    const entries = await fs.promises.readdir(outputDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const routineDir = path.join(outputDir, entry.name)
      try {
        const files = await fs.promises.readdir(routineDir)
        const mkvFiles = files.filter((f) => f.endsWith('.mkv'))
        const mp4Files = files.filter((f) => f.endsWith('.mp4') && !f.startsWith('_temp_'))

        for (const mkv of mkvFiles) {
          // Check for any performance MP4 (handles prefix-aware naming)
          const hasPerformance = mp4Files.some(f =>
            f.includes('performance') || f === 'P_performance.mp4',
          )
          if (!hasPerformance) {
            const mkvPath = path.join(routineDir, mkv)
            try {
              const stat = await fs.promises.stat(mkvPath)
              orphans.push({
                filePath: mkvPath,
                fileName: mkv,
                size: stat.size,
                modifiedAt: stat.mtime,
              })
            } catch {}
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }
  } catch (err) {
    logger.app.error('Error scanning for orphans:', err)
  }

  logger.app.info(`Found ${orphans.length} orphaned MKV files`)
  return orphans
}

/** Clean up temp files from interrupted smart encodes. */
export async function cleanupTempFiles(): Promise<number> {
  const settings = getSettings()
  const outputDir = settings.fileNaming.outputDirectory
  if (!outputDir || !fs.existsSync(outputDir)) return 0

  let cleaned = 0
  try {
    const entries = await fs.promises.readdir(outputDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const routineDir = path.join(outputDir, entry.name)
      const tempPath = path.join(routineDir, '_temp_video.mp4')
      try {
        await fs.promises.access(tempPath)
        await fs.promises.unlink(tempPath)
        cleaned++
        logger.app.info(`Cleaned temp file: ${tempPath}`)
      } catch {
        // No temp file — fine
      }
    }
  } catch {}

  return cleaned
}

export async function recoverOrphans(orphans: OrphanedFile[]): Promise<void> {
  if (orphans.length === 0) return

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return

  const result = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Recover', 'Ignore'],
    defaultId: 0,
    title: 'Orphaned Recordings Found',
    message: `Found ${orphans.length} recording(s) without processed video files.`,
    detail: orphans.map((o) => `${o.fileName} (${Math.round(o.size / 1024 / 1024)}MB)`).join('\n'),
  })

  if (result.response !== 0) return

  const settings = getSettings()

  for (const orphan of orphans) {
    const dir = path.dirname(orphan.filePath)
    logger.app.info(`Recovering orphan: ${orphan.fileName}`)

    ffmpegService.enqueueJob({
      routineId: path.basename(dir),
      inputPath: orphan.filePath,
      outputDir: dir,
      judgeCount: settings.competition.judgeCount,
      trackMapping: settings.audioTrackMapping,
      processingMode: settings.ffmpeg.processingMode,
      filePrefix: '',
    })
  }
}

export async function checkAndRecover(): Promise<{
  resumedJobs: number
  orphanedFiles: number
  tempsCleaned: number
}> {
  // Job queue already resets running→pending on init
  const resumedJobs = jobQueue.getPending().length

  // Clean temp files from interrupted encodes
  const tempsCleaned = await cleanupTempFiles()

  // Scan for unprocessed MKVs
  const orphans = await scanForOrphans()

  if (resumedJobs > 0 || tempsCleaned > 0 || orphans.length > 0) {
    logger.app.info(
      `Crash recovery: ${resumedJobs} jobs resumed, ${tempsCleaned} temps cleaned, ${orphans.length} orphaned MKVs`,
    )
  }

  if (orphans.length > 0) {
    await recoverOrphans(orphans)
  }

  return { resumedJobs, orphanedFiles: orphans.length, tempsCleaned }
}
