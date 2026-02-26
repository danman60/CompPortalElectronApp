import fs from 'fs'
import path from 'path'
import { dialog, BrowserWindow } from 'electron'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as ffmpegService from './ffmpeg'

interface OrphanedFile {
  filePath: string
  fileName: string
  size: number
  modifiedAt: Date
}

export async function scanForOrphans(): Promise<OrphanedFile[]> {
  const settings = getSettings()
  const outputDir = settings.fileNaming.outputDirectory
  if (!outputDir || !fs.existsSync(outputDir)) return []

  logger.app.info(`Scanning for orphaned MKVs in ${outputDir}`)
  const orphans: OrphanedFile[] = []

  // Look for MKV files that don't have corresponding MP4 splits
  const entries = fs.readdirSync(outputDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const routineDir = path.join(outputDir, entry.name)
    const files = fs.readdirSync(routineDir)
    const mkvFiles = files.filter((f) => f.endsWith('.mkv'))
    const mp4Files = files.filter((f) => f.endsWith('.mp4'))

    for (const mkv of mkvFiles) {
      // If MKV exists but no performance.mp4, it's orphaned
      if (!mp4Files.includes('performance.mp4')) {
        const mkvPath = path.join(routineDir, mkv)
        const stat = fs.statSync(mkvPath)
        orphans.push({
          filePath: mkvPath,
          fileName: mkv,
          size: stat.size,
          modifiedAt: stat.mtime,
        })
      }
    }
  }

  logger.app.info(`Found ${orphans.length} orphaned MKV files`)
  return orphans
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

export async function checkAndRecover(): Promise<void> {
  const orphans = await scanForOrphans()
  if (orphans.length > 0) {
    await recoverOrphans(orphans)
  }
}
