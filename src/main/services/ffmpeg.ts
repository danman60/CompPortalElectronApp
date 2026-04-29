import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import os from 'os'
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
import { broadcastFullState, broadcastRoutineUpdate } from './recording'

let ffmpegProcess: ChildProcess | null = null
let isProcessing = false
let isPaused = false
let pausedByDriveLoss = false

export function pauseForDriveLoss(): void {
  if (pausedByDriveLoss) return
  pausedByDriveLoss = true
  isPaused = true
  logger.ffmpeg.warn('Encode paused: drive lost')
}

export function resumeFromDriveLoss(): void {
  if (!pausedByDriveLoss) return
  pausedByDriveLoss = false
  isPaused = false
  logger.ffmpeg.info('Encode resumed after drive recovery')
  processNext()
}

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

/** Cache the resolved path so we only copy once per session. */
let resolvedFFmpegPath: string | null = null

function getFFmpegPath(): string {
  if (resolvedFFmpegPath) return resolvedFFmpegPath

  const settings = getSettings()
  if (settings.ffmpeg.path && settings.ffmpeg.path !== '(bundled)') {
    if (fs.existsSync(settings.ffmpeg.path)) {
      resolvedFFmpegPath = settings.ffmpeg.path
      return resolvedFFmpegPath
    }
    logger.ffmpeg.warn(`Custom ffmpeg path not found: ${settings.ffmpeg.path}, falling back to bundled`)
  }

  const resourcePath = path.join(process.resourcesPath || '.', 'ffmpeg.exe')
  if (fs.existsSync(resourcePath)) {
    // Copy to userData to avoid EBUSY lock on resources/ directory
    const userDataCopy = path.join(app.getPath('userData'), 'ffmpeg.exe')
    try {
      // Only copy if missing or different size (indicates update)
      const srcStat = fs.statSync(resourcePath)
      let needsCopy = true
      if (fs.existsSync(userDataCopy)) {
        const dstStat = fs.statSync(userDataCopy)
        if (dstStat.size === srcStat.size) needsCopy = false
      }
      if (needsCopy) {
        fs.copyFileSync(resourcePath, userDataCopy)
        logger.ffmpeg.info(`Copied ffmpeg to ${userDataCopy}`)
      }
      resolvedFFmpegPath = userDataCopy
      return resolvedFFmpegPath
    } catch (err) {
      logger.ffmpeg.warn(`Failed to copy ffmpeg to userData, using resources path: ${err}`)
      resolvedFFmpegPath = resourcePath
      return resolvedFFmpegPath
    }
  }

  try {
    const ffmpegStatic = require('ffmpeg-static') as string
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      resolvedFFmpegPath = ffmpegStatic
      return resolvedFFmpegPath
    }
  } catch {}

  logger.ffmpeg.warn('No bundled ffmpeg found, assuming ffmpeg is on PATH')
  return 'ffmpeg'
}

/** Validate FFmpeg is available. Returns version string or null. Retries once on EBUSY. */
export function validateFFmpeg(retries = 2): Promise<string | null> {
  return new Promise((resolve) => {
    const ffmpegPath = getFFmpegPath()
    logger.ffmpeg.info(`Validating FFmpeg at: ${ffmpegPath} (retries=${retries})`)
    try {
      const proc = spawn(ffmpegPath, ['-version'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let output = ''
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('close', (code) => {
        if (code === 0) {
          const versionLine = output.split('\n')[0] || 'unknown'
          resolve(versionLine.trim())
        } else {
          logger.ffmpeg.warn(`FFmpeg validation exited with code ${code} (path: ${ffmpegPath})${stderr ? `, stderr: ${stderr.slice(0, 200)}` : ''}`)
          if (retries > 0) {
            logger.ffmpeg.warn(`Retrying FFmpeg validation in 3s (${retries} retries left)...`)
            setTimeout(() => validateFFmpeg(retries - 1).then(resolve), 3000)
          } else {
            resolve(null)
          }
        }
      })
      proc.on('error', (err: NodeJS.ErrnoException) => {
        logger.ffmpeg.warn(`FFmpeg validation spawn error: ${err.code || err.message} (path: ${ffmpegPath})`)
        if ((err.code === 'EBUSY' || err.code === 'ENOENT') && retries > 0) {
          logger.ffmpeg.warn(`Retrying FFmpeg validation in 3s (${retries} retries left)...`)
          setTimeout(() => validateFFmpeg(retries - 1).then(resolve), 3000)
        } else {
          resolve(null)
        }
      })
      setTimeout(() => { proc.kill(); resolve(null) }, 10000)
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
      logger.ffmpeg.warn(`FFmpeg validation sync error: ${msg}`)
      if (msg.includes('EBUSY') && retries > 0) {
        logger.ffmpeg.warn(`Retrying FFmpeg validation in 3s (${retries} retries left)...`)
        setTimeout(() => validateFFmpeg(retries - 1).then(resolve), 3000)
      } else {
        resolve(null)
      }
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

/**
 * Probe the video duration (seconds) from an MKV/MP4 via ffmpeg -i.
 * Returns 0 on failure; caller treats 0 as "skip keyframes".
 */
function probeDurationSeconds(ffmpegPath: string, inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', inputPath, '-hide_banner'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/)
      if (!m) { resolve(0); return }
      const hours = parseInt(m[1], 10)
      const minutes = parseInt(m[2], 10)
      const seconds = parseFloat(m[3])
      resolve(hours * 3600 + minutes * 60 + seconds)
    })
    proc.on('error', () => resolve(0))
    setTimeout(() => { proc.kill(); resolve(0) }, 10000)
  })
}

/**
 * Extract 3 keyframes at 20%, 50%, 80% of the video for CompPortal's
 * Gemini spot-check validator. 400x400 WebP, quality 80 (tradeoff: large
 * enough for Gemini to identify dancers, small enough to keep upload
 * cost low). Failure is warn+skip — never blocks the encode/upload flow.
 *
 * Returns absolute paths of successfully-written keyframe files. Empty
 * array on failure or if the source is too short (<3s).
 */
export async function extractKeyframes(
  mkvPath: string,
  outputDir: string,
): Promise<string[]> {
  const ffmpegPath = getFFmpegPath()
  if (!fs.existsSync(mkvPath)) {
    logger.ffmpeg.warn(`extractKeyframes: source missing: ${mkvPath}`)
    return []
  }
  const durationSec = await probeDurationSeconds(ffmpegPath, mkvPath)
  if (durationSec < 3) {
    logger.ffmpeg.info(`extractKeyframes: source too short (${durationSec.toFixed(1)}s), skipping`)
    return []
  }

  const keyframesDir = path.join(outputDir, 'keyframes')
  try {
    await fs.promises.mkdir(keyframesDir, { recursive: true })
  } catch (err) {
    logger.ffmpeg.warn(`extractKeyframes: mkdir failed: ${err instanceof Error ? err.message : err}`)
    return []
  }

  const percentages = [0.20, 0.50, 0.80]
  const written: string[] = []

  for (let i = 0; i < percentages.length; i++) {
    const seekSec = durationSec * percentages[i]
    const outPath = path.join(keyframesDir, `keyframe_${i}.webp`)
    const args = [
      '-ss', String(seekSec.toFixed(3)),
      '-i', mkvPath,
      '-frames:v', '1',
      '-vf', 'scale=400:400:force_original_aspect_ratio=increase,crop=400:400',
      '-q:v', '5',
      '-f', 'webp',
      '-y',
      outPath,
    ]
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stderr = ''
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(outPath)) {
            resolve()
          } else {
            reject(new Error(`ffmpeg keyframe ${i} failed (code ${code}): ${stderr.slice(0, 200)}`))
          }
        })
        proc.on('error', reject)
        setTimeout(() => { proc.kill(); reject(new Error(`ffmpeg keyframe ${i} timed out`)) }, 30000)
      })
      written.push(outPath)
    } catch (err) {
      logger.ffmpeg.warn(`extractKeyframes: ${i} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  logger.ffmpeg.info(`extractKeyframes: wrote ${written.length}/3 keyframes to ${keyframesDir}`)
  return written
}

/**
 * Generate a 200×200 WebP thumbnail from a JPEG using the bundled ffmpeg.
 *
 * Replaces the sharp-based thumbnailing path that has been failing with
 * "TypeError: A boolean was expected" inside the Windows asar runtime
 * (confirmed 2026-04-19 UDC London: sharp 0.33.5 works standalone on
 * Linux with identical options but throws on every photo inside the
 * Electron/Windows runtime). ffmpeg is already bundled, runs as a
 * subprocess (off main thread), and produces identical output.
 *
 * Returns true on success, false on any failure (caller treats false as
 * "no thumb this photo — backfill will handle").
 */
export async function generatePhotoThumbnail(
  inputJpgPath: string,
  outputWebpPath: string,
  timeoutMs = 15000,
): Promise<boolean> {
  if (!fs.existsSync(inputJpgPath)) return false
  const ffmpegPath = getFFmpegPath()
  const args = [
    '-y',
    '-i', inputJpgPath,
    '-vf', 'scale=w=200:h=200:force_original_aspect_ratio=increase,crop=200:200',
    '-c:v', 'libwebp',
    '-quality', '80',
    '-compression_level', '4',
    '-frames:v', '1',
    '-f', 'webp',
    outputWebpPath,
  ]
  return new Promise<boolean>((resolve) => {
    try {
      const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
        logger.ffmpeg.warn(`generatePhotoThumbnail: timed out after ${timeoutMs}ms for ${inputJpgPath}`)
        resolve(false)
      }, timeoutMs)
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && fs.existsSync(outputWebpPath)) {
          resolve(true)
        } else {
          logger.ffmpeg.warn(`generatePhotoThumbnail: code=${code} stderr=${stderr.slice(-200)}`)
          resolve(false)
        }
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        logger.ffmpeg.warn(`generatePhotoThumbnail: spawn error: ${err.message}`)
        resolve(false)
      })
    } catch (err) {
      logger.ffmpeg.warn(`generatePhotoThumbnail: sync throw: ${err instanceof Error ? err.message : err}`)
      resolve(false)
    }
  })
}

/** Probe input file for audio track count using ffprobe/ffmpeg. */
function probeAudioTrackCount(ffmpegPath: string, inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    // Use ffmpeg -i to get stream info (works without ffprobe binary)
    const proc = spawn(ffmpegPath, ['-i', inputPath, '-hide_banner'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', () => {
      // Count "Stream #0:N: Audio" lines
      const audioStreams = stderr.match(/Stream #\d+:\d+.*Audio/g)
      resolve(audioStreams ? audioStreams.length : 0)
    })
    proc.on('error', () => resolve(0))
    setTimeout(() => { proc.kill(); resolve(0) }, 10000)
  })
}

// ── A53 / A55: post-encode audio audit ──────────────────────────────────────

/** Hash an MP4's audio stream (SHA-256). Returns null on failure. */
function hashAudioStream(ffmpegPath: string, mp4Path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-i', mp4Path, '-map', '0:a', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    let stdout = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', () => {
      const m = stdout.match(/SHA256=([0-9a-f]+)/i)
      resolve(m ? m[1].toLowerCase() : null)
    })
    proc.on('error', () => resolve(null))
    setTimeout(() => { proc.kill(); resolve(null) }, 30000)
  })
}

/** Run silencedetect on an MP4 and return total silent fraction (0..1). */
function detectSilenceFraction(
  ffmpegPath: string,
  mp4Path: string,
  noiseFloorDb: number,
  minDurationSec: number,
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-nostats', '-i', mp4Path,
       '-af', `silencedetect=noise=${noiseFloorDb}dB:d=${minDurationSec}`,
       '-f', 'null', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', () => {
      const durMatch = stderr.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/)
      if (!durMatch) { resolve(0); return }
      const totalSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3])
      if (totalSec <= 0) { resolve(0); return }
      // Sum silence_duration: lines.
      let silentSec = 0
      const re = /silence_duration:\s+([0-9.]+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(stderr)) !== null) {
        silentSec += parseFloat(m[1])
      }
      resolve(Math.min(1, silentSec / totalSec))
    })
    proc.on('error', () => resolve(0))
    setTimeout(() => { proc.kill(); resolve(0) }, 60000)
  })
}

/** Measure mean RMS volume in dBFS. Returns 0 on failure (treat as inconclusive). */
function measureMeanRmsDb(ffmpegPath: string, mp4Path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-nostats', '-i', mp4Path, '-af', 'volumedetect', '-f', 'null', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', () => {
      const m = stderr.match(/mean_volume:\s+(-?[0-9.]+)\s+dB/)
      resolve(m ? parseFloat(m[1]) : null)
    })
    proc.on('error', () => resolve(null))
    setTimeout(() => { proc.kill(); resolve(null) }, 60000)
  })
}

/**
 * Run audio audit on a routine's encoded MP4s. Fires IPC events for any
 * findings (identical hashes, excessive silence, low loudness). Otherwise
 * fires AUDIO_AUDIT_PASS for a small dismissable success toast.
 *
 * Fully fire-and-forget. Errors logged, never thrown. ~7s background CPU
 * for 4 files (perf + 3 judges) with all checks on.
 */
async function runAudioAudit(
  routineId: string,
  entryNumber: string,
  encodedFiles: EncodedFile[],
): Promise<void> {
  const cfg = getSettings().audioAudit
  if (!cfg) return
  if (encodedFiles.length === 0) return
  const ffmpegPath = getFFmpegPath()

  let anyFinding = false

  // A53: identity check
  if (cfg.identityCheckEnabled) {
    const hashByRole: Record<string, string> = {}
    for (const ef of encodedFiles) {
      try {
        const h = await hashAudioStream(ffmpegPath, ef.filePath)
        if (h) hashByRole[ef.role] = h
      } catch (err) {
        logger.ffmpeg.warn(`A53 hash failed for ${ef.role}: ${err instanceof Error ? err.message : err}`)
      }
    }
    const byHash: Record<string, string[]> = {}
    for (const [role, hash] of Object.entries(hashByRole)) {
      if (!byHash[hash]) byHash[hash] = []
      byHash[hash].push(role)
    }
    const matchedPairs: Array<[string, string]> = []
    for (const roles of Object.values(byHash)) {
      if (roles.length < 2) continue
      for (let i = 0; i < roles.length; i++) {
        for (let j = i + 1; j < roles.length; j++) {
          matchedPairs.push([roles[i], roles[j]])
        }
      }
    }
    if (matchedPairs.length > 0) {
      anyFinding = true
      logger.ffmpeg.warn(
        `A53 identical-tracks: routine ${entryNumber} — ${matchedPairs.map(p => `${p[0]}=${p[1]}`).join(', ')}`,
      )
      sendToRenderer(IPC_CHANNELS.AUDIO_IDENTICAL_TRACKS_DETECTED, {
        routineId, entryNumber, matchedPairs, byHash,
      })
    }
  }

  // A55: silence + loudness per file
  for (const ef of encodedFiles) {
    if (cfg.silenceCheckEnabled) {
      try {
        const frac = await detectSilenceFraction(
          ffmpegPath, ef.filePath, cfg.silenceNoiseFloorDb, cfg.silenceMinDurationSec,
        )
        if (frac > 0.5) {
          anyFinding = true
          logger.ffmpeg.warn(
            `A55 silence: routine ${entryNumber} ${ef.role} silent fraction ${(frac * 100).toFixed(0)}%`,
          )
          sendToRenderer(IPC_CHANNELS.AUDIO_SILENCE_DETECTED, {
            routineId, entryNumber, role: ef.role,
            silentFraction: frac,
            noiseFloorDb: cfg.silenceNoiseFloorDb,
            minDurationSec: cfg.silenceMinDurationSec,
          })
        }
      } catch (err) {
        logger.ffmpeg.warn(`A55 silence failed for ${ef.role}: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (cfg.loudnessCheckEnabled) {
      try {
        const rms = await measureMeanRmsDb(ffmpegPath, ef.filePath)
        if (rms !== null && rms < cfg.loudnessFloorDb) {
          anyFinding = true
          logger.ffmpeg.warn(
            `A55 loudness: routine ${entryNumber} ${ef.role} mean ${rms.toFixed(1)} dB < ${cfg.loudnessFloorDb} dB`,
          )
          sendToRenderer(IPC_CHANNELS.AUDIO_LOW_LOUDNESS_DETECTED, {
            routineId, entryNumber, role: ef.role,
            meanRmsDb: rms,
            thresholdDb: cfg.loudnessFloorDb,
          })
        }
      } catch (err) {
        logger.ffmpeg.warn(`A55 loudness failed for ${ef.role}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  if (!anyFinding) {
    sendToRenderer(IPC_CHANNELS.AUDIO_AUDIT_PASS, {
      routineId, entryNumber, trackCount: encodedFiles.length,
    })
  }
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
  isProcessing = true

  // Iterative loop — no recursion, no deep call stacks
  while (true) {
    if (isPaused) {
      logger.ffmpeg.info('Encode queue paused')
      break
    }
    const jobRecord = jobQueue.getNext('encode')
    if (!jobRecord) break

    jobQueue.updateStatus(jobRecord.id, 'running')
    const job = jobRecord.payload as unknown as FFmpegJob

    logger.ffmpeg.info(`Processing routine ${job.routineId}: ${job.inputPath}`)
    state.updateRoutineStatus(job.routineId, 'encoding')
    broadcastRoutineUpdate(job.routineId)
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

      // Extract 3 keyframes from the source MKV for CompPortal's Gemini
      // spot-check validator. Non-blocking — if extraction fails, the
      // encode is already done and upload proceeds without keyframes.
      let keyframePaths: string[] = []
      try {
        keyframePaths = await extractKeyframes(job.inputPath, job.outputDir)
      } catch (err) {
        logger.ffmpeg.warn(`Keyframe extraction threw for ${job.routineId}:`, err instanceof Error ? err.message : err)
      }

      state.updateRoutineStatus(job.routineId, 'encoded', { encodedFiles, keyframes: keyframePaths })
      jobQueue.updateStatus(jobRecord.id, 'done')
      broadcastRoutineUpdate(job.routineId)

      // A53 / A55: post-encode audio audit. Fire-and-forget — runs in
      // background while the next routine queues up. Settings-gated; each
      // check (identity / silence / loudness) toggleable independently.
      const compForAudit = state.getCompetition()
      const routineForAudit = compForAudit?.routines.find((r) => r.id === job.routineId)
      const entryNumberForAudit = routineForAudit?.entryNumber ?? job.routineId.slice(0, 8)
      void runAudioAudit(job.routineId, entryNumberForAudit, encodedFiles).catch((err) => {
        logger.ffmpeg.warn(`Audio audit threw for ${job.routineId}: ${err instanceof Error ? err.message : err}`)
      })

      // Auto-upload if enabled
      const settings = getSettings()
      if (settings.behavior.autoUploadAfterEncoding) {
        const comp = state.getCompetition()
        const routine = comp?.routines.find((r) => r.id === job.routineId)
        if (routine) {
          const result = uploadService.enqueueRoutine(routine)
          if (result.queuedJobs > 0) {
            uploadService.startUploads()
          }
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

      cleanupTempFiles(job.outputDir)

      sendProgress({
        routineId: job.routineId,
        state: 'error',
        tracksCompleted: 0,
        tracksTotal: job.judgeCount + 1,
        error: errMsg,
      })
    }

    clearPid()
  }

  isProcessing = false

  // If there are still pending jobs (e.g. failed jobs waiting for backoff), schedule a retry
  const pendingJobs = jobQueue.getPending('encode')
  if (pendingJobs.length > 0) {
    const nextBackoffMs = Math.min(5000 * Math.pow(2, (pendingJobs[0].attempts || 1) - 1), 60000)
    logger.ffmpeg.info(`${pendingJobs.length} pending encode jobs, retrying in ${nextBackoffMs / 1000}s`)
    setTimeout(() => processNext(), nextBackoffMs)
  }
}

async function runFFmpeg(job: FFmpegJob): Promise<void> {
  const ffmpegPath = getFFmpegPath()

  if (!fs.existsSync(job.outputDir)) {
    await fs.promises.mkdir(job.outputDir, { recursive: true })
  }

  // Pre-flight: ensure enough disk space (need ~2x input file for encoding headroom)
  try {
    const inputStat = fs.statSync(job.inputPath)
    const requiredBytes = inputStat.size * 2
    const driveRoot = job.outputDir.match(/^[a-zA-Z]:\\/) ? job.outputDir.slice(0, 3) : job.outputDir
    const diskStats = fs.statfsSync(driveRoot)
    const freeBytes = diskStats.bavail * diskStats.bsize
    if (freeBytes < requiredBytes) {
      const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(1)
      const needGB = (requiredBytes / (1024 * 1024 * 1024)).toFixed(1)
      throw new Error(`Insufficient disk space: ${freeGB}GB free, need ~${needGB}GB for encoding`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Insufficient disk space')) throw err
    // statfsSync may fail on network drives — log and continue
    logger.ffmpeg.warn(`Disk space pre-check failed (non-fatal): ${err instanceof Error ? err.message : err}`)
  }

  // Validate audio track count matches expected judge count
  const audioTrackCount = await probeAudioTrackCount(ffmpegPath, job.inputPath)
  if (audioTrackCount > 0 && audioTrackCount <= job.judgeCount) {
    logger.ffmpeg.warn(
      `Input has ${audioTrackCount} audio tracks but ${job.judgeCount + 1} expected (1 performance + ${job.judgeCount} judges). ` +
      `Judge tracks ${audioTrackCount}..${job.judgeCount} will fail. Clamping judgeCount to ${audioTrackCount - 1}.`
    )
    job.judgeCount = Math.max(0, audioTrackCount - 1)
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
  const settings = getSettings()
  const useNvenc = settings.ffmpeg.useHardwareEncoding ?? false
  const judgeRes = settings.ffmpeg.judgeResolution ?? 'same'
  const encoder = useNvenc ? 'h264_nvenc' : 'libx264'
  const encoderArgs = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']

  const tempVideo = path.join(job.outputDir, '_temp_video.mp4')
  const tempJudgeVideo = judgeRes !== 'same'
    ? path.join(job.outputDir, '_temp_judge_video.mp4')
    : null

  try {
    // Step 1: Encode performance video (full resolution)
    // Try NVENC first, fall back to CPU if GPU unavailable
    let actualEncoder = encoder
    let actualEncoderArgs = encoderArgs
    try {
      logger.ffmpeg.info(`Smart encode step 1: encoding video (${encoder})...`)
      await spawnFFmpegWithTimeout(ffmpegPath, [
        '-y', '-i', job.inputPath,
        '-map', '0:v:0',
        '-an',
        ...encoderArgs,
        tempVideo,
      ])
    } catch (err) {
      if (useNvenc) {
        logger.ffmpeg.warn(`NVENC failed (${err instanceof Error ? err.message : err}), falling back to CPU (libx264)`)
        actualEncoder = 'libx264'
        actualEncoderArgs = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']
        await spawnFFmpegWithTimeout(ffmpegPath, [
          '-y', '-i', job.inputPath,
          '-map', '0:v:0',
          '-an',
          ...actualEncoderArgs,
          tempVideo,
        ])
      } else {
        throw err
      }
    }

    // Step 1b: Encode judge video at lower resolution if configured
    if (tempJudgeVideo) {
      const scale = judgeRes === '480p' ? '854:480' : '1280:720'
      logger.ffmpeg.info(`Smart encode step 1b: encoding judge video at ${judgeRes} (${actualEncoder})...`)
      await spawnFFmpegWithTimeout(ffmpegPath, [
        '-y', '-i', job.inputPath,
        '-map', '0:v:0',
        '-an',
        ...actualEncoderArgs,
        '-vf', `scale=${scale}:force_original_aspect_ratio=decrease,pad=${scale}:(ow-iw)/2:(oh-ih)/2`,
        tempJudgeVideo,
      ])
    }

    // Step 2: Mux encoded video + each audio track
    logger.ffmpeg.info('Smart encode step 2: muxing audio tracks...')

    const perfOutput = path.join(job.outputDir, perfFileName(job.filePrefix))
    await spawnFFmpegWithTimeout(ffmpegPath, [
      '-y', '-i', tempVideo, '-i', job.inputPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      perfOutput,
    ])

    const judgeVideoSource = tempJudgeVideo || tempVideo
    for (let i = 1; i <= job.judgeCount; i++) {
      const judgeOutput = path.join(job.outputDir, judgeFileName(job.filePrefix, i))
      await spawnFFmpegWithTimeout(ffmpegPath, [
        '-y', '-i', judgeVideoSource, '-i', job.inputPath,
        '-map', '0:v:0', '-map', `1:a:${i}`,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        judgeOutput,
      ])
    }
  } finally {
    try { await fs.promises.unlink(tempVideo) } catch {}
    if (tempJudgeVideo) {
      try { await fs.promises.unlink(tempJudgeVideo) } catch {}
    }
  }
}

/** Spawn FFmpeg with a timeout. Kills process on timeout. */
function spawnFFmpegWithTimeout(ffmpegPath: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    // Inject -threads to keep FFmpeg from monopolising the box.
    // - settings.ffmpeg.threadCount > 0 → explicit operator override (used as-is)
    // - settings.ffmpeg.threadCount = 0 / unset → auto-cap at 70% of cores so
    //   OBS / wifi-display / queue have headroom (operator request 2026-04-25
    //   Day 2: ffmpeg was using 100% of cores and clogging encode pipeline).
    let finalArgs = args
    try {
      const threads = getSettings().ffmpeg.threadCount
      let effective: number | null = null
      if (typeof threads === 'number' && threads > 0) {
        effective = threads
      } else {
        const cores = os.cpus().length
        effective = Math.max(1, Math.floor(cores * 0.7))
      }
      finalArgs = ['-threads', String(effective), ...args]
      logger.ffmpeg.info(`FFmpeg thread cap: ${effective} (auto: ${!(typeof threads === 'number' && threads > 0)}, cores: ${os.cpus().length})`)
    } catch {
      // settings unavailable — fall back to no cap
    }
    logger.ffmpeg.info(`FFmpeg command: ${ffmpegPath} ${finalArgs.join(' ')}`)

    const spawnOpts = getSpawnOptions()
    ffmpegProcess = spawn(ffmpegPath, finalArgs, spawnOpts)

    if (ffmpegProcess.pid) {
      setPriority(ffmpegProcess.pid)
      writePid(ffmpegProcess.pid)
    }

    // Timeout — kill if FFmpeg hangs
    const timer = setTimeout(() => {
      logger.ffmpeg.error(`FFmpeg timed out after ${timeoutMs / 1000}s, killing process`)
      const proc = ffmpegProcess
      if (proc) {
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL')
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
  const tempFiles = ['_temp_video.mp4', '_temp_judge_video.mp4']
  for (const tempName of tempFiles) {
    try {
      const tempPath = path.join(outputDir, tempName)
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
        logger.ffmpeg.info(`Cleaned up temp file: ${tempPath}`)
      }
    } catch {}
  }
}

export function getQueueLength(): number {
  return jobQueue.getPending('encode').length + jobQueue.getRunning('encode').length
}

export function getEncodingRuntimeState(): {
  isPaused: boolean
  pending: number
  running: number
} {
  return {
    isPaused,
    pending: jobQueue.getPending('encode').length,
    running: jobQueue.getRunning('encode').length,
  }
}

export function pauseEncoding(): void {
  isPaused = true
  logger.ffmpeg.info('Encoding paused — will finish current job then stop')
}

export function resumeEncoding(): void {
  if (!isPaused) return
  isPaused = false
  logger.ffmpeg.info('Encoding resumed')
  processNext()
}

export function resumeRecordedRoutines(): number {
  const comp = state.getCompetition()
  if (!comp) return 0

  const settings = getSettings()
  const existingEncodeRoutineIds = new Set(
    jobQueue
      .getAll()
      .filter((j) => j.type === 'encode' && (j.status === 'pending' || j.status === 'running'))
      .map((j) => j.routineId),
  )

  let queued = 0
  for (const routine of comp.routines) {
    if (routine.status !== 'recorded' || !routine.outputPath) continue
    if (existingEncodeRoutineIds.has(routine.id)) continue

    const dir = routine.outputDir || path.dirname(routine.outputPath)
    const encodeInput = pickLongestMkv(dir, routine.outputPath)
    enqueueJob({
      routineId: routine.id,
      inputPath: encodeInput,
      outputDir: dir,
      judgeCount: settings.competition.judgeCount,
      trackMapping: settings.audioTrackMapping,
      processingMode: settings.ffmpeg.processingMode,
      filePrefix: schedule.buildFilePrefix(routine.entryNumber),
    })
    queued++
  }

  if (queued > 0) {
    logger.ffmpeg.info(`Resume recorded: queued ${queued} recorded routine(s) for encoding`)
  }
  return queued
}

export function isEncodingPaused(): boolean {
  return isPaused
}

export function cancelCurrent(): void {
  if (ffmpegProcess) {
    const proc = ffmpegProcess
    ffmpegProcess = null
    isProcessing = false
    clearPid()
    proc.kill('SIGTERM')
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL')
      }
    }, 5000)
    logger.ffmpeg.warn('Current FFmpeg process cancelled')
  }
}
