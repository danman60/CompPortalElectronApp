import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { BrowserWindow } from 'electron'
import { FFmpegJob, FFmpegProgress, IPC_CHANNELS, EncodedFile } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as state from './state'
import * as uploadService from './upload'

let ffmpegProcess: ChildProcess | null = null
const queue: FFmpegJob[] = []
let isProcessing = false

function getFFmpegPath(): string {
  const settings = getSettings()
  if (settings.ffmpeg.path && settings.ffmpeg.path !== '(bundled)') {
    if (fs.existsSync(settings.ffmpeg.path)) {
      return settings.ffmpeg.path
    }
    logger.ffmpeg.warn(`Custom ffmpeg path not found: ${settings.ffmpeg.path}, falling back to bundled`)
  }

  // Check extraResources (primary location in packaged app)
  const resourcePath = path.join(process.resourcesPath || '.', 'ffmpeg.exe')
  if (fs.existsSync(resourcePath)) {
    return resourcePath
  }

  // Dev fallback: try ffmpeg-static npm package
  try {
    const ffmpegStatic = require('ffmpeg-static') as string
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic
    }
  } catch {
    // Not available
  }

  // Last resort: assume on PATH
  logger.ffmpeg.warn('No bundled ffmpeg found, assuming ffmpeg is on PATH')
  return 'ffmpeg'
}

function sendProgress(progress: FFmpegProgress): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.FFMPEG_PROGRESS, progress)
  }
}

export function enqueueJob(job: FFmpegJob): void {
  queue.push(job)
  logger.ffmpeg.info(
    `Job queued for routine ${job.routineId}, queue size: ${queue.length}`,
  )
  sendProgress({
    routineId: job.routineId,
    state: 'queued',
    tracksCompleted: 0,
    tracksTotal: job.judgeCount + 1,
  })
  processNext()
}

async function processNext(): Promise<void> {
  if (isProcessing || queue.length === 0) return

  isProcessing = true
  const job = queue.shift()!

  logger.ffmpeg.info(`Processing routine ${job.routineId}: ${job.inputPath}`)
  sendProgress({
    routineId: job.routineId,
    state: 'encoding',
    tracksCompleted: 0,
    tracksTotal: job.judgeCount + 1,
  })

  try {
    await runFFmpeg(job)
    logger.ffmpeg.info(`Encoding complete for routine ${job.routineId}`)

    // Build encodedFiles list from output directory
    const encodedFiles: EncodedFile[] = []
    const perfPath = path.join(job.outputDir, 'performance.mp4')
    if (fs.existsSync(perfPath)) {
      encodedFiles.push({ role: 'performance', filePath: perfPath, uploaded: false })
    }
    for (let i = 1; i <= job.judgeCount; i++) {
      const judgePath = path.join(job.outputDir, `judge${i}_commentary.mp4`)
      if (fs.existsSync(judgePath)) {
        encodedFiles.push({ role: `judge${i}` as EncodedFile['role'], filePath: judgePath, uploaded: false })
      }
    }

    // Update routine with encoded files and status
    state.updateRoutineStatus(job.routineId, 'encoded', { encodedFiles })

    // Broadcast updated state to renderer
    const { broadcastFullState } = require('./recording')
    broadcastFullState()

    // Auto-upload if enabled
    const settings = getSettings()
    if (settings.behavior.autoUploadAfterEncoding) {
      const comp = state.getCompetition()
      const routine = comp?.routines.find((r) => r.id === job.routineId)
      if (routine) {
        uploadService.enqueueRoutine(routine)
        uploadService.startUploads()
      }
    }

    sendProgress({
      routineId: job.routineId,
      state: 'done',
      tracksCompleted: job.judgeCount + 1,
      tracksTotal: job.judgeCount + 1,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.ffmpeg.error(`Encoding failed for routine ${job.routineId}:`, errMsg)
    sendProgress({
      routineId: job.routineId,
      state: 'error',
      tracksCompleted: 0,
      tracksTotal: job.judgeCount + 1,
      error: errMsg,
    })
  }

  isProcessing = false
  processNext()
}

function runFFmpeg(job: FFmpegJob): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFFmpegPath()

    // Ensure output directory exists
    if (!fs.existsSync(job.outputDir)) {
      fs.mkdirSync(job.outputDir, { recursive: true })
    }

    // Build args: single command, multiple outputs
    const args: string[] = ['-y', '-i', job.inputPath]

    // Performance track (track 0 = video + audio track 0)
    const perfOutput = path.join(job.outputDir, 'performance.mp4')
    args.push('-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', perfOutput)

    // Judge tracks
    for (let i = 1; i <= job.judgeCount; i++) {
      const judgeOutput = path.join(job.outputDir, `judge${i}_commentary.mp4`)
      args.push('-map', '0:v:0', '-map', `0:a:${i}`, '-c', 'copy', judgeOutput)
    }

    // If re-encoding is selected, modify the args
    if (job.processingMode === '720p') {
      // Override copy with re-encode — rebuild args
      const reencodeArgs = buildReencodeArgs(job, '1280:720')
      args.length = 0
      args.push(...reencodeArgs)
    } else if (job.processingMode === '1080p') {
      const reencodeArgs = buildReencodeArgs(job, '1920:1080')
      args.length = 0
      args.push(...reencodeArgs)
    }

    logger.ffmpeg.info(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`)

    ffmpegProcess = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    ffmpegProcess.stdout?.on('data', (data: Buffer) => {
      logger.ffmpeg.debug(`stdout: ${data.toString().trim()}`)
    })

    ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) {
        logger.ffmpeg.debug(`stderr: ${line}`)
      }
    })

    ffmpegProcess.on('close', (code) => {
      ffmpegProcess = null
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`))
      }
    })

    ffmpegProcess.on('error', (err) => {
      ffmpegProcess = null
      reject(err)
    })
  })
}

function buildReencodeArgs(job: FFmpegJob, scale: string): string[] {
  const args: string[] = ['-y', '-i', job.inputPath]

  const perfOutput = path.join(job.outputDir, 'performance.mp4')
  args.push(
    '-map', '0:v:0', '-map', '0:a:0',
    '-vf', `scale=${scale}`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    perfOutput,
  )

  for (let i = 1; i <= job.judgeCount; i++) {
    const judgeOutput = path.join(job.outputDir, `judge${i}_commentary.mp4`)
    args.push(
      '-map', '0:v:0', '-map', `0:a:${i}`,
      '-vf', `scale=${scale}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      judgeOutput,
    )
  }

  return args
}

export function getQueueLength(): number {
  return queue.length + (isProcessing ? 1 : 0)
}

export function cancelCurrent(): void {
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM')
    ffmpegProcess = null
    isProcessing = false
    logger.ffmpeg.warn('Current FFmpeg process cancelled')
  }
}
