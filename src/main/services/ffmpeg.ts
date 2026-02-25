import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import path from 'path'
import fs from 'fs'
import { FFmpegJob, FFmpegProgress, IPC_CHANNELS, EncodedFile } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as state from './state'
import * as uploadService from './upload'
import { broadcastFullState } from './recording'

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

function getSpawnOptions(): SpawnOptions {
  const settings = getSettings()
  const priority = settings.ffmpeg.cpuPriority

  const opts: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'] }

  // On Windows, use priority class flags
  if (process.platform === 'win32' && priority !== 'normal') {
    // Node.js spawn on Windows supports windowsHide + we use wmic to set priority after spawn
    // But the cleanest way is using CREATE_SUSPENDED isn't available.
    // Instead we'll use 'start /LOW' wrapper or set priority post-spawn.
    // For simplicity, we spawn normally and set priority via child PID.
    opts.windowsHide = true
  }

  return opts
}

/** Set process priority on Windows after spawn */
function setPriority(pid: number): void {
  const settings = getSettings()
  if (process.platform !== 'win32' || settings.ffmpeg.cpuPriority === 'normal') return

  const priorityMap: Record<string, string> = {
    'below-normal': 'belownormal',
    'idle': 'idle',
  }
  const level = priorityMap[settings.ffmpeg.cpuPriority]
  if (!level) return

  try {
    // Use wmic to set priority (works without elevation)
    const wmic = spawn('wmic', ['process', 'where', `ProcessId=${pid}`, 'CALL', 'setpriority', level], {
      stdio: 'ignore',
      windowsHide: true,
    })
    wmic.on('error', () => {}) // ignore errors
    logger.ffmpeg.info(`Set FFmpeg PID ${pid} priority to ${level}`)
  } catch {
    logger.ffmpeg.warn(`Failed to set FFmpeg priority to ${level}`)
  }
}

function sendProgress(progress: FFmpegProgress): void {
  sendToRenderer(IPC_CHANNELS.FFMPEG_PROGRESS, progress)
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
  state.updateRoutineStatus(job.routineId, 'encoding')
  broadcastFullState()
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
    } else {
      logger.ffmpeg.warn(`Expected output file not found: ${perfPath}`)
    }
    for (let i = 1; i <= job.judgeCount; i++) {
      const judgePath = path.join(job.outputDir, `judge${i}_commentary.mp4`)
      if (fs.existsSync(judgePath)) {
        encodedFiles.push({ role: `judge${i}` as EncodedFile['role'], filePath: judgePath, uploaded: false })
      } else {
        logger.ffmpeg.warn(`Expected output file not found: ${judgePath}`)
      }
    }

    if (encodedFiles.length === 0) {
      logger.ffmpeg.error(`No output files found after encoding routine ${job.routineId}`)
    }

    // Update routine with encoded files and status
    state.updateRoutineStatus(job.routineId, 'encoded', { encodedFiles })

    // Broadcast updated state to renderer
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

async function runFFmpeg(job: FFmpegJob): Promise<void> {
  const ffmpegPath = getFFmpegPath()

  // Ensure output directory exists
  if (!fs.existsSync(job.outputDir)) {
    fs.mkdirSync(job.outputDir, { recursive: true })
  }

  if (job.processingMode === 'smart') {
    await runSmartEncode(job, ffmpegPath)
    return
  }

  // Build args: single command, multiple outputs
  const args: string[] = ['-y', '-i', job.inputPath]

  if (job.processingMode === '720p') {
    args.push(...buildReencodeArgs(job, '1280:720').slice(3)) // skip -y -i input
  } else if (job.processingMode === '1080p') {
    args.push(...buildReencodeArgs(job, '1920:1080').slice(3))
  } else {
    // Copy mode
    const perfOutput = path.join(job.outputDir, 'performance.mp4')
    args.push('-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', perfOutput)
    for (let i = 1; i <= job.judgeCount; i++) {
      const judgeOutput = path.join(job.outputDir, `judge${i}_commentary.mp4`)
      args.push('-map', '0:v:0', '-map', `0:a:${i}`, '-c', 'copy', judgeOutput)
    }
  }

  await spawnFFmpeg(ffmpegPath, args)
}

/** Smart encode: encode video once, then mux with each audio track */
async function runSmartEncode(job: FFmpegJob, ffmpegPath: string): Promise<void> {
  const tempVideo = path.join(job.outputDir, '_temp_video.mp4')

  try {
    // Step 1: Encode video once (no audio)
    logger.ffmpeg.info('Smart encode step 1: encoding video...')
    await spawnFFmpeg(ffmpegPath, [
      '-y', '-i', job.inputPath,
      '-map', '0:v:0',
      '-an',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      tempVideo,
    ])

    // Step 2: Mux encoded video + each audio track
    logger.ffmpeg.info('Smart encode step 2: muxing audio tracks...')

    // Performance (audio track 0)
    const perfOutput = path.join(job.outputDir, 'performance.mp4')
    await spawnFFmpeg(ffmpegPath, [
      '-y', '-i', tempVideo, '-i', job.inputPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      perfOutput,
    ])

    // Judge tracks
    for (let i = 1; i <= job.judgeCount; i++) {
      const judgeOutput = path.join(job.outputDir, `judge${i}_commentary.mp4`)
      await spawnFFmpeg(ffmpegPath, [
        '-y', '-i', tempVideo, '-i', job.inputPath,
        '-map', '0:v:0', '-map', `1:a:${i}`,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        judgeOutput,
      ])
    }
  } finally {
    // Clean up temp video
    try { fs.unlinkSync(tempVideo) } catch {}
  }
}

function spawnFFmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.ffmpeg.info(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`)

    const spawnOpts = getSpawnOptions()
    ffmpegProcess = spawn(ffmpegPath, args, spawnOpts)

    if (ffmpegProcess.pid) {
      setPriority(ffmpegProcess.pid)
    }

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
