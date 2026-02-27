import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { FFmpegJob, FFmpegProgress, IPC_CHANNELS, EncodedFile } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as state from './state'
import * as uploadService from './upload'
import * as jobQueue from './jobQueue'
import { broadcastFullState } from './recording'

let ffmpegProcess: ChildProcess | null = null
let isProcessing = false

const PID_FILE = 'ffmpeg.pid'
const DEFAULT_TIMEOUT_MS = 600000 // 10 minutes

function perfFileName(prefix: string): string { return prefix ? `${prefix}_P_performance.mp4` : 'P_performance.mp4' }
function judgeFileName(prefix: string, i: number): string { return prefix ? `${prefix}_J${i}_commentary.mp4` : `J${i}_commentary.mp4` }

function getPidFilePath(): string {
  return path.join(app.getPath('userData'), PID_FILE)
}

function writePid(pid: number): void {
  try {
    fs.writeFileSync(getPidFilePath(), String(pid))
  } catch {}
}

function clearPid(): void {
  try {
    const pidPath = getPidFilePath()
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath)
  } catch {}
}

/** Kill orphaned FFmpeg from a previous crash. Called at startup. */
export function killOrphanedProcess(): void {
  try {
    const pidPath = getPidFilePath()
    if (!fs.existsSync(pidPath)) return
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
    if (isNaN(pid)) { clearPid(); return }
    try {
      process.kill(pid, 'SIGTERM')
      logger.ffmpeg.warn(`Killed orphaned FFmpeg process (PID ${pid})`)
    } catch {
      // Process already dead — fine
    }
    clearPid()
  } catch {}
}

function getFFmpegPath(): string {
  const settings = getSettings()
  if (settings.ffmpeg.path && settings.ffmpeg.path !== '(bundled)') {
    if (fs.existsSync(settings.ffmpeg.path)) {
      return settings.ffmpeg.path
    }
    logger.ffmpeg.warn(`Custom ffmpeg path not found: ${settings.ffmpeg.path}, falling back to bundled`)
  }

  const resourcePath = path.join(process.resourcesPath || '.', 'ffmpeg.exe')
  if (fs.existsSync(resourcePath)) {
    return resourcePath
  }

  try {
    const ffmpegStatic = require('ffmpeg-static') as string
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic
    }
  } catch {}

  logger.ffmpeg.warn('No bundled ffmpeg found, assuming ffmpeg is on PATH')
  return 'ffmpeg'
}

/** Validate FFmpeg is available. Returns version string or null. */
export function validateFFmpeg(): Promise<string | null> {
  return new Promise((resolve) => {
    const ffmpegPath = getFFmpegPath()
    try {
      const proc = spawn(ffmpegPath, ['-version'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let output = ''
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
      proc.on('close', (code) => {
        if (code === 0) {
          const versionLine = output.split('\n')[0] || 'unknown'
          resolve(versionLine.trim())
        } else {
          resolve(null)
        }
      })
      proc.on('error', () => resolve(null))
      setTimeout(() => { proc.kill(); resolve(null) }, 10000)
    } catch {
      resolve(null)
    }
  })
}

function getSpawnOptions(): SpawnOptions {
  const opts: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'] }
  if (process.platform === 'win32') {
    opts.windowsHide = true
  }
  return opts
}

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
    const wmic = spawn('wmic', ['process', 'where', `ProcessId=${pid}`, 'CALL', 'setpriority', level], {
      stdio: 'ignore',
      windowsHide: true,
    })
    wmic.on('error', () => {})
    logger.ffmpeg.info(`Set FFmpeg PID ${pid} priority to ${level}`)
  } catch {
    logger.ffmpeg.warn(`Failed to set FFmpeg priority to ${level}`)
  }
}

function sendProgress(progress: FFmpegProgress): void {
  sendToRenderer(IPC_CHANNELS.FFMPEG_PROGRESS, progress)
}

/** Enqueue an FFmpeg job via the persistent job queue. */
export function enqueueJob(job: FFmpegJob): void {
  jobQueue.enqueue('encode', job.routineId, job as unknown as Record<string, unknown>)
  logger.ffmpeg.info(`Job queued for routine ${job.routineId}`)
  sendProgress({
    routineId: job.routineId,
    state: 'queued',
    tracksCompleted: 0,
    tracksTotal: job.judgeCount + 1,
  })
  processNext()
}

async function processNext(): Promise<void> {
  if (isProcessing) return

  const jobRecord = jobQueue.getNext('encode')
  if (!jobRecord) return

  isProcessing = true
  jobQueue.updateStatus(jobRecord.id, 'running')

  const job = jobRecord.payload as unknown as FFmpegJob

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

    const encodedFiles: EncodedFile[] = []
    const perfPath = path.join(job.outputDir, perfFileName(job.filePrefix))
    if (fs.existsSync(perfPath)) {
      encodedFiles.push({ role: 'performance', filePath: perfPath, uploaded: false })
    } else {
      logger.ffmpeg.warn(`Expected output file not found: ${perfPath}`)
    }
    for (let i = 1; i <= job.judgeCount; i++) {
      const judgePath = path.join(job.outputDir, judgeFileName(job.filePrefix, i))
      if (fs.existsSync(judgePath)) {
        encodedFiles.push({ role: `judge${i}` as EncodedFile['role'], filePath: judgePath, uploaded: false })
      } else {
        logger.ffmpeg.warn(`Expected output file not found: ${judgePath}`)
      }
    }

    if (encodedFiles.length === 0) {
      logger.ffmpeg.error(`No output files found after encoding routine ${job.routineId}`)
    }

    state.updateRoutineStatus(job.routineId, 'encoded', { encodedFiles })
    jobQueue.updateStatus(jobRecord.id, 'done')
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
    jobQueue.updateStatus(jobRecord.id, 'failed', { error: errMsg })

    // Clean up any temp files on failure
    cleanupTempFiles(job.outputDir)

    sendProgress({
      routineId: job.routineId,
      state: 'error',
      tracksCompleted: 0,
      tracksTotal: job.judgeCount + 1,
      error: errMsg,
    })
  }

  isProcessing = false
  clearPid()
  // Process next job (properly awaited)
  await processNext()
}

async function runFFmpeg(job: FFmpegJob): Promise<void> {
  const ffmpegPath = getFFmpegPath()

  if (!fs.existsSync(job.outputDir)) {
    await fs.promises.mkdir(job.outputDir, { recursive: true })
  }

  if (job.processingMode === 'smart') {
    await runSmartEncode(job, ffmpegPath)
    return
  }

  const args: string[] = ['-y', '-i', job.inputPath]

  if (job.processingMode === '720p') {
    args.push(...buildReencodeArgs(job, '1280:720').slice(3))
  } else if (job.processingMode === '1080p') {
    args.push(...buildReencodeArgs(job, '1920:1080').slice(3))
  } else {
    const perfOutput = path.join(job.outputDir, perfFileName(job.filePrefix))
    args.push('-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', perfOutput)
    for (let i = 1; i <= job.judgeCount; i++) {
      const judgeOutput = path.join(job.outputDir, judgeFileName(job.filePrefix, i))
      args.push('-map', '0:v:0', '-map', `0:a:${i}`, '-c', 'copy', judgeOutput)
    }
  }

  await spawnFFmpegWithTimeout(ffmpegPath, args)
}

async function runSmartEncode(job: FFmpegJob, ffmpegPath: string): Promise<void> {
  const tempVideo = path.join(job.outputDir, '_temp_video.mp4')

  try {
    // Step 1: Encode video once (no audio)
    logger.ffmpeg.info('Smart encode step 1: encoding video...')
    await spawnFFmpegWithTimeout(ffmpegPath, [
      '-y', '-i', job.inputPath,
      '-map', '0:v:0',
      '-an',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      tempVideo,
    ])

    // Step 2: Mux encoded video + each audio track
    logger.ffmpeg.info('Smart encode step 2: muxing audio tracks...')

    const perfOutput = path.join(job.outputDir, perfFileName(job.filePrefix))
    await spawnFFmpegWithTimeout(ffmpegPath, [
      '-y', '-i', tempVideo, '-i', job.inputPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      perfOutput,
    ])

    for (let i = 1; i <= job.judgeCount; i++) {
      const judgeOutput = path.join(job.outputDir, judgeFileName(job.filePrefix, i))
      await spawnFFmpegWithTimeout(ffmpegPath, [
        '-y', '-i', tempVideo, '-i', job.inputPath,
        '-map', '0:v:0', '-map', `1:a:${i}`,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        judgeOutput,
      ])
    }
  } finally {
    // Clean up temp video
    try { await fs.promises.unlink(tempVideo) } catch {}
  }
}

/** Spawn FFmpeg with a timeout. Kills process on timeout. */
function spawnFFmpegWithTimeout(ffmpegPath: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.ffmpeg.info(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`)

    const spawnOpts = getSpawnOptions()
    ffmpegProcess = spawn(ffmpegPath, args, spawnOpts)

    if (ffmpegProcess.pid) {
      setPriority(ffmpegProcess.pid)
      writePid(ffmpegProcess.pid)
    }

    // Timeout — kill if FFmpeg hangs
    const timer = setTimeout(() => {
      logger.ffmpeg.error(`FFmpeg timed out after ${timeoutMs / 1000}s, killing process`)
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM')
        setTimeout(() => {
          if (ffmpegProcess && !ffmpegProcess.killed) {
            ffmpegProcess.kill('SIGKILL')
          }
        }, 5000)
      }
      reject(new Error(`FFmpeg timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

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
      clearTimeout(timer)
      ffmpegProcess = null
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`))
      }
    })

    ffmpegProcess.on('error', (err) => {
      clearTimeout(timer)
      ffmpegProcess = null
      reject(err)
    })
  })
}

function buildReencodeArgs(job: FFmpegJob, scale: string): string[] {
  const args: string[] = ['-y', '-i', job.inputPath]

  const perfOutput = path.join(job.outputDir, perfFileName(job.filePrefix))
  args.push(
    '-map', '0:v:0', '-map', '0:a:0',
    '-vf', `scale=${scale}`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    perfOutput,
  )

  for (let i = 1; i <= job.judgeCount; i++) {
    const judgeOutput = path.join(job.outputDir, judgeFileName(job.filePrefix, i))
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

/** Clean up temp files from failed smart encode */
function cleanupTempFiles(outputDir: string): void {
  try {
    const tempPath = path.join(outputDir, '_temp_video.mp4')
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath)
      logger.ffmpeg.info(`Cleaned up temp file: ${tempPath}`)
    }
  } catch {}
}

export function getQueueLength(): number {
  return jobQueue.getPending('encode').length + jobQueue.getRunning('encode').length
}

export function cancelCurrent(): void {
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM')
    setTimeout(() => {
      if (ffmpegProcess && !ffmpegProcess.killed) {
        ffmpegProcess.kill('SIGKILL')
      }
    }, 5000)
    ffmpegProcess = null
    isProcessing = false
    clearPid()
    logger.ffmpeg.warn('Current FFmpeg process cancelled')
  }
}
