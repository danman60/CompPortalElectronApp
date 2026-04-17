import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { IPC_CHANNELS, UploadProgress, Routine } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import { getResolvedConnection } from './schedule'
import { getSettings } from './settings'
import * as state from './state'
import * as jobQueue from './jobQueue'
import { broadcastFullState, broadcastRoutineUpdate } from './recording'
import { ThrottleStream } from '../utils/throttle'
import * as importManifest from './importManifest'

interface UploadPayload {
  routineId: string
  entryId: string
  competitionId: string
  filePath: string
  objectName: string
  contentType: string
  type: 'videos' | 'photos'
  role?: string // 'performance' | 'judge1' etc for videos
}

export interface EnqueueRoutineResult {
  queuedJobs: number
  skippedReason?: 'no-connection' | 'no-files' | 'already-queued'
}

const API_TIMEOUT_MS = 30000

let isUploading = false
let isPaused = false
let currentAbortController: AbortController | null = null
let currentAbortRoutineId: string | null = null

// Fix 8/9: external pause flags (disk space low / drive lost)
let pausedByDiskSpace = false
let pausedByDriveLoss = false

export function pauseForDiskSpace(): void {
  if (pausedByDiskSpace) return
  pausedByDiskSpace = true
  isPaused = true
  logger.upload.warn('Upload paused: disk space critical')
}

export function resumeFromDiskSpace(): void {
  if (!pausedByDiskSpace) return
  pausedByDiskSpace = false
  if (!pausedByDriveLoss) {
    isPaused = false
    logger.upload.info('Upload resumed after disk space recovery')
    startUploads()
  }
}

export function pauseForDriveLoss(): void {
  if (pausedByDriveLoss) return
  pausedByDriveLoss = true
  isPaused = true
  logger.upload.warn('Upload paused: drive lost')
}

export function resumeFromDriveLoss(): void {
  if (!pausedByDriveLoss) return
  pausedByDriveLoss = false
  if (!pausedByDiskSpace) {
    isPaused = false
    logger.upload.info('Upload resumed after drive recovery')
    startUploads()
  }
}

// Fix 4: Track uploading routines for O(1) lookup in stopUploads
const activeUploadRoutineIds = new Set<string>()

function sendProgress(routineId: string, progress: UploadProgress): void {
  sendToRenderer(IPC_CHANNELS.UPLOAD_PROGRESS, { routineId, progress })
}

function getConnection(): { apiBase: string; apiKey: string; competitionId: string } {
  const conn = getResolvedConnection()
  if (!conn) throw new Error('No active connection. Load a competition via share code first.')
  return { apiBase: conn.apiBase, apiKey: conn.apiKey, competitionId: conn.competitionId }
}

export function hasResolvedUploadConnection(): boolean {
  return getResolvedConnection() !== null
}

export function enqueueRoutine(routine: Routine, force = false): EnqueueRoutineResult {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.upload.warn(`Skipping upload queue for routine ${routine.entryNumber}: no resolved upload connection`)
    return { queuedJobs: 0, skippedReason: 'no-connection' }
  }

  const hasVideos = (routine.encodedFiles?.length || 0) > 0
  const hasPhotos = (routine.photos?.length || 0) > 0
  if (!hasVideos && !hasPhotos) {
    return { queuedJobs: 0, skippedReason: 'no-files' }
  }

  const existing = jobQueue.getByRoutine(routine.id)

  let jobCount = 0

  // Collect objectNames of already-queued/running/done jobs to avoid duplicates
  const skipObjectNames = new Set(
    existing
      .filter(j => j.type === 'upload' && (j.status === 'done' || j.status === 'pending' || j.status === 'running'))
      .map(j => (j.payload as Record<string, unknown>).objectName as string)
  )

  // Queue video files
  for (const file of routine.encodedFiles || []) {
    if (!force && file.uploaded) continue
    const role = file.role
    const objectName = `${role}.mp4`
    if (skipObjectNames.has(objectName)) continue
    jobQueue.enqueue('upload', routine.id, {
      routineId: routine.id,
      entryId: routine.id,
      competitionId: conn.competitionId,
      filePath: file.filePath,
      objectName,
      contentType: 'video/mp4',
      type: 'videos',
      role,
    } satisfies UploadPayload as unknown as Record<string, unknown>)
    jobCount++
  }

  // Queue photos
  if (routine.photos) {
    for (const photo of routine.photos) {
      if (!force && photo.uploaded) continue
      const photoObjectName = path.basename(photo.filePath)
      if (skipObjectNames.has(photoObjectName)) continue
      jobQueue.enqueue('upload', routine.id, {
        routineId: routine.id,
        entryId: routine.id,
        competitionId: conn.competitionId,
        filePath: photo.filePath,
        objectName: photoObjectName,
        contentType: 'image/jpeg',
        type: 'photos',
      } satisfies UploadPayload as unknown as Record<string, unknown>)
      jobCount++
    }
  }

  if (jobCount === 0) return { queuedJobs: 0, skippedReason: 'no-files' }

  logger.upload.info(`Queued ${jobCount} upload jobs for routine ${routine.entryNumber}`)

  sendProgress(routine.id, {
    state: 'queued',
    percent: 0,
    filesCompleted: 0,
    filesTotal: jobCount,
  })

  return { queuedJobs: jobCount }
}

export function startUploads(): void {
  if (!hasResolvedUploadConnection()) {
    logger.upload.warn('Upload start requested without a resolved connection')
    return
  }
  if (isUploading && !isPaused) return
  isPaused = false
  const pendingCount = jobQueue.getPending('upload').length
  logger.upload.info(`Starting upload queue, ${pendingCount} jobs pending`)
  processLoop().catch((err) => {
    logger.upload.error('Upload process loop crashed:', err)
    isUploading = false
  })
}

export function stopUploads(): void {
  isPaused = true
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
    currentAbortRoutineId = null
    logger.upload.info('Upload paused — current upload aborted')
  }

  // Fix 4: Iterate only tracked uploading routines instead of scanning all 700
  if (activeUploadRoutineIds.size > 0) {
    for (const routineId of activeUploadRoutineIds) {
      state.updateRoutineStatus(routineId, 'encoded')
      sendProgress(routineId, {
        state: 'paused',
        percent: 0,
        filesCompleted: 0,
        filesTotal: 0,
      })
    }
    activeUploadRoutineIds.clear()
    broadcastFullState()
  }
}

export function cancelRoutineUpload(routineId: string): void {
  // Cancel all pending/running jobs for this routine
  const jobs = jobQueue.getByRoutine(routineId).filter(j => j.type === 'upload')
  for (const job of jobs) {
    if (job.status === 'pending' || job.status === 'running') {
      jobQueue.updateStatus(job.id, 'cancelled')
    }
  }

  // Only abort if the current in-flight upload belongs to THIS routine
  if (currentAbortController && currentAbortRoutineId === routineId) {
    currentAbortController.abort()
    currentAbortController = null
    currentAbortRoutineId = null
  }

  // Reset routine status back to encoded
  state.updateRoutineStatus(routineId, 'encoded')
  activeUploadRoutineIds.delete(routineId)
  broadcastRoutineUpdate(routineId)
  sendProgress(routineId, {
    state: 'paused',
    percent: 0,
    filesCompleted: 0,
    filesTotal: 0,
  })
  logger.upload.info(`Cancelled uploads for routine ${routineId}`)
}

/** Main upload processing loop — properly awaited, no recursion. */
async function processLoop(): Promise<void> {
  if (isUploading) return
  isUploading = true

  while (!isPaused) {
    const job = jobQueue.getNext('upload')
    if (!job) break

    jobQueue.updateStatus(job.id, 'running')
    const payload = job.payload as unknown as UploadPayload

    // Set routine status to uploading (only if not already uploading).
    //
    // uploadRunId lives on the Routine itself (persisted via updateRoutineStatus).
    // Rationale: a single upload attempt for one routine spans multiple processLoop
    // iterations (one per file). All jobs in the same attempt must share a runId so
    // the R2 paths land under a single {.../uploadRunId/...} prefix AND /complete
    // can match them. On retry after failure the routine is reset to 'encoded', so
    // the next 'encoded → uploading' transition naturally generates a fresh runId.
    // Persisting on the routine also survives app crashes mid-attempt.
    const routine = state.getCompetition()?.routines.find(r => r.id === payload.routineId)
    if (routine && routine.status !== 'uploading') {
      const uploadRunId = crypto.randomUUID()
      state.updateRoutineStatus(payload.routineId, 'uploading', { uploadRunId })
      activeUploadRoutineIds.add(payload.routineId)
      broadcastRoutineUpdate(payload.routineId)
    }

    // Read the current runId for this attempt (just set above, or already set by a
    // prior iteration of this same attempt).
    const currentRoutine = state.getCompetition()?.routines.find(r => r.id === payload.routineId)
    const uploadRunId = currentRoutine?.uploadRunId
    if (!uploadRunId) {
      const errMsg = `Missing uploadRunId for routine ${payload.routineId} — cannot proceed`
      logger.upload.error(errMsg)
      jobQueue.updateStatus(job.id, 'failed', { error: errMsg })
      continue
    }

    const allRoutineJobs = jobQueue.getByRoutine(payload.routineId).filter(j => j.type === 'upload')
    const completedCount = allRoutineJobs.filter(j => j.status === 'done').length
    const totalCount = allRoutineJobs.length

    // Initial progress: show completed files, 0% for current file
    const initialPercent = Math.round((completedCount / totalCount) * 100)

    sendProgress(payload.routineId, {
      state: 'uploading',
      percent: initialPercent,
      currentFile: path.basename(payload.filePath),
      filesCompleted: completedCount,
      filesTotal: totalCount,
    })

    try {
      // Pre-check: R2 single PUT limit is 5GB
      const MAX_SINGLE_PUT = 5 * 1024 * 1024 * 1024
      try {
        const fileStat = fs.statSync(payload.filePath)
        if (fileStat.size > MAX_SINGLE_PUT) {
          throw new Error(`File too large for single upload (${(fileStat.size / 1024 / 1024 / 1024).toFixed(1)}GB > 5GB limit): ${payload.objectName}`)
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`File not found: ${payload.filePath}`)
        }
        throw statErr
      }

      // Step 1: Get signed upload URL
      const { signedUrl, storagePath } = await getSignedUploadUrl(
        payload.entryId,
        payload.competitionId,
        payload.type,
        payload.objectName,
        payload.contentType,
        uploadRunId,
      )

      // Step 2: Upload file with timeout
      await uploadFileToSignedUrl(signedUrl, payload)

      // Persist storagePath in the job for plugin/complete
      jobQueue.updateStatus(job.id, 'done', { storagePath })
      logger.upload.info(`Uploaded: ${payload.objectName} for routine ${payload.routineId}`)

      // Check if all uploads for this routine are done (exclude cancelled jobs from prior recordings)
      const updatedJobs = jobQueue.getByRoutine(payload.routineId).filter(j => j.type === 'upload' && j.status !== 'cancelled')
      const allDone = updatedJobs.every(j => j.status === 'done')

      if (allDone) {
        // Call plugin/complete — collect storagePaths from completed jobs + already-uploaded files
        try {
          const storagePaths: Record<string, string> = {}
          const photoStoragePaths: string[] = []

          // Include already-uploaded files from routine state (covers prior session uploads)
          const routineState = state.getCompetition()?.routines.find(r => r.id === payload.routineId)
          if (routineState) {
            for (const f of routineState.encodedFiles || []) {
              if (f.uploaded && f.storagePath) storagePaths[f.role] = f.storagePath
            }
            for (const p of routineState.photos || []) {
              if (p.uploaded && p.storagePath) photoStoragePaths.push(p.storagePath)
            }
          }

          // Overlay with paths from current job batch (freshest)
          for (const doneJob of updatedJobs) {
            const jp = doneJob.payload as unknown as UploadPayload
            const sp = (doneJob.payload as Record<string, unknown>).storagePath as string | undefined
            if (!sp) continue
            if (jp.type === 'photos') {
              if (!photoStoragePaths.includes(sp)) photoStoragePaths.push(sp)
            } else if (jp.role) {
              storagePaths[jp.role] = sp
            }
          }

          await callPluginComplete({
            routineId: payload.routineId,
            entryId: payload.entryId,
            competitionId: payload.competitionId,
            uploadRunId,
            storagePaths,
            photoStoragePaths,
          })

          // Mark individual files as uploaded with their storage paths
          const routine = state.getCompetition()?.routines.find(r => r.id === payload.routineId)
          if (routine) {
            const updatedFiles = (routine.encodedFiles || []).map(f => {
              const sp = storagePaths[f.role]
              return sp ? { ...f, uploaded: true, storagePath: sp } : f
            })
            const updatedPhotos = (routine.photos || []).map((p, i) => {
              const sp = photoStoragePaths[i]
              return sp ? { ...p, uploaded: true, storagePath: sp } : p
            })

            // SD-import path: after /complete 2xx, record uploaded=true in the manifest
            // (fsync first) THEN unlink the local routine-folder copy. Only acts on photos
            // that carry a sourceHash — proves they flowed through the new SD-import path.
            // Tether-flow photos (no sourceHash) are NOT deleted, preserving prior behavior.
            const outDir = getSettings().fileNaming.outputDirectory
            for (const p of updatedPhotos) {
              if (!p.uploaded || !p.storagePath || !p.sourceHash) continue
              try {
                await importManifest.markUploaded(outDir, p.sourceHash, p.storagePath)
              } catch (err) {
                logger.upload.warn(`Manifest markUploaded failed for ${p.filePath}:`, err instanceof Error ? err.message : err)
                continue
              }
              try {
                await fs.promises.unlink(p.filePath)
              } catch (err) {
                logger.upload.warn(`Local photo unlink failed for ${p.filePath}:`, err instanceof Error ? err.message : err)
              }
            }

            state.updateRoutineStatus(payload.routineId, 'uploaded', {
              encodedFiles: updatedFiles,
              photos: updatedPhotos,
            })
          } else {
            state.updateRoutineStatus(payload.routineId, 'uploaded')
          }
          activeUploadRoutineIds.delete(payload.routineId)
          broadcastRoutineUpdate(payload.routineId)
          broadcastFullState()
          sendProgress(payload.routineId, {
            state: 'complete',
            percent: 100,
            filesCompleted: updatedJobs.length,
            filesTotal: updatedJobs.length,
          })
          logger.upload.info(`All uploads complete for routine ${payload.routineId}`)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          logger.upload.error(`Plugin complete failed for ${payload.routineId}:`, errMsg)
          // Files ARE uploaded to storage — mark as encoded so user can retry completion
          state.updateRoutineStatus(payload.routineId, 'encoded', {
            error: `Files uploaded but completion call failed: ${errMsg}`,
          })
          activeUploadRoutineIds.delete(payload.routineId)
          broadcastRoutineUpdate(payload.routineId)
          sendProgress(payload.routineId, {
            state: 'failed',
            percent: 100,
            filesCompleted: updatedJobs.length,
            filesTotal: updatedJobs.length,
            error: `Completion failed: ${errMsg}. Files uploaded — retry upload to re-send.`,
          })
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.upload.error(`Upload failed for ${payload.objectName}:`, errMsg)
      jobQueue.updateStatus(job.id, 'failed', { error: errMsg })

      sendProgress(payload.routineId, {
        state: 'failed',
        percent: 0,
        filesCompleted: 0,
        filesTotal: 1,
        error: errMsg,
      })

      // Backoff before next attempt: 5s, 10s, 20s, 40s, 60s max
      const attempts = job.attempts || 1
      const backoffMs = Math.min(5000 * Math.pow(2, attempts - 1), 60000)
      logger.upload.info(`Upload backoff: waiting ${backoffMs / 1000}s before next job`)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
    } finally {
      // ALWAYS clean up abort controller
      currentAbortController = null
      currentAbortRoutineId = null
    }
  }

  isUploading = false
}

async function getSignedUploadUrl(
  entryId: string,
  competitionId: string,
  type: 'videos' | 'photos',
  filename: string,
  contentType: string,
  uploadRunId: string,
): Promise<{ signedUrl: string; storagePath: string }> {
  const { apiBase, apiKey } = getConnection()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), API_TIMEOUT_MS)
  try {
    const response = await fetch(`${apiBase}/api/plugin/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        entryId,
        competitionId,
        type,
        filename,
        contentType,
        uploadRunId,
      }),
      signal: abort.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to get upload URL: ${response.status} ${text}`)
    }

    return response.json()
  } finally {
    clearTimeout(timer)
  }
}

function uploadFileToSignedUrl(
  signedUrl: string,
  payload: UploadPayload,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let fileSize: number
    try {
      fileSize = fs.statSync(payload.filePath).size
    } catch (err) {
      reject(new Error(`Cannot read file: ${payload.filePath}`))
      return
    }

    // Timeout: min 5 minutes, scales with file size (~100KB/s minimum)
    const timeoutMs = Math.max(300000, Math.round(fileSize / 100000) * 1000)

    const fileStream = fs.createReadStream(payload.filePath)
    let bytesUploaded = 0
    let lastLoggedMilestone = 0

    const url = new URL(signedUrl)
    const httpModule = url.protocol === 'https:' ? https : http

    const req = httpModule.request(
      signedUrl,
      {
        method: 'PUT',
        headers: {
          'Content-Length': fileSize,
          'Content-Type': payload.contentType,
        },
      },
      (res) => {
        clearTimeout(timer)
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve()
        } else {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => {
            reject(new Error(`Upload failed: ${res.statusCode} ${body}`))
          })
        }
      },
    )

    function cleanup(): void {
      if (!fileStream.destroyed) fileStream.destroy()
      clearTimeout(timer)
    }

    // Timeout timer
    const timer = setTimeout(() => {
      cleanup()
      req.destroy()
      reject(new Error(`Upload timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    // Abort controller for pause/cancel — tag with routine so cancel targets correctly
    currentAbortController = new AbortController()
    currentAbortRoutineId = payload.routineId
    currentAbortController.signal.addEventListener('abort', () => {
      cleanup()
      req.destroy()
      reject(new Error('Upload aborted'))
    })

    req.on('error', (err) => {
      cleanup()
      reject(err)
    })

    // Cache job counts once before streaming — avoid O(n) scan per chunk
    const cachedJobs = jobQueue.getByRoutine(payload.routineId).filter(j => j.type === 'upload')
    const cachedCompleted = cachedJobs.filter(j => j.status === 'done').length
    const cachedTotal = cachedJobs.length

    fileStream.on('data', (chunk) => {
      bytesUploaded += chunk.length
      const filePercent = Math.round((bytesUploaded / fileSize) * 100)

      const milestone = Math.floor(filePercent / 25) * 25
      if (milestone > lastLoggedMilestone) {
        lastLoggedMilestone = milestone
        logger.upload.info(`Upload ${payload.objectName}: ${filePercent}%`)

        const overallPercent = Math.round(((cachedCompleted + (filePercent / 100)) / cachedTotal) * 100)
        sendProgress(payload.routineId, {
          state: 'uploading',
          percent: overallPercent,
          currentFile: path.basename(payload.filePath),
          filesCompleted: cachedCompleted,
          filesTotal: cachedTotal,
        })
      }
    })

    // Bandwidth cap (commit 2): wrap body in ThrottleStream if configured
    const bwCap = (getSettings() as any).upload?.bandwidthCapBytesPerSec ?? 0
    if (bwCap > 0) {
      logger.upload.info(`Upload bandwidth cap: ${Math.round(bwCap / 1024)} KB/s`)
      const throttle = new ThrottleStream(bwCap)
      throttle.on('error', (err) => {
        cleanup()
        reject(err)
      })
      fileStream.pipe(throttle).pipe(req)
    } else {
      fileStream.pipe(req)
    }
  })
}

async function callPluginComplete(info: {
  routineId: string
  entryId: string
  competitionId: string
  uploadRunId: string
  storagePaths: Record<string, string>
  photoStoragePaths: string[]
}): Promise<void> {
  const { apiBase, apiKey } = getConnection()

  const routine = state.getCompetition()?.routines.find(r => r.id === info.routineId)

  const body = {
    entryId: info.entryId,
    competitionId: info.competitionId,
    uploadRunId: info.uploadRunId,
    video_start_timestamp: routine?.recordingStartedAt || undefined,
    video_end_timestamp: routine?.recordingStoppedAt || undefined,
    files: {
      performance: info.storagePaths['performance'] || undefined,
      judge1: info.storagePaths['judge1'] || undefined,
      judge2: info.storagePaths['judge2'] || undefined,
      judge3: info.storagePaths['judge3'] || undefined,
      judge4: info.storagePaths['judge4'] || undefined,
      photos: info.photoStoragePaths.length > 0 ? info.photoStoragePaths : undefined,
    },
  }

  logger.upload.info(`Calling plugin/complete for routine ${info.routineId}`)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), API_TIMEOUT_MS)
  try {
    const response = await fetch(`${apiBase}/api/plugin/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Plugin complete failed: ${response.status} ${text}`)
    }

    logger.upload.info(`Plugin complete success for routine ${info.routineId}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Retry plugin/complete for routines where all uploads succeeded but completion wasn't called (crash recovery). */
export async function retryOrphanedCompletions(): Promise<number> {
  const allJobs = jobQueue.getAll().filter(j => j.type === 'upload')

  // Group by routine
  const byRoutine = new Map<string, typeof allJobs>()
  for (const job of allJobs) {
    let arr = byRoutine.get(job.routineId)
    if (!arr) { arr = []; byRoutine.set(job.routineId, arr) }
    arr.push(job)
  }

  let retried = 0
  for (const [routineId, routineJobs] of byRoutine) {
    const activeJobs = routineJobs.filter(j => j.status !== 'cancelled')
    if (activeJobs.length === 0) continue
    const allDone = activeJobs.every(j => j.status === 'done')
    if (!allDone) continue

    // Check if routine is still in 'uploading' state (completion never fired)
    const routine = state.getCompetition()?.routines.find(r => r.id === routineId)
    if (!routine || routine.status === 'uploaded') continue

    logger.upload.info(`Retrying orphaned completion for routine ${routineId}`)
    try {
      const storagePaths: Record<string, string> = {}
      const photoStoragePaths: string[] = []
      for (const job of activeJobs) {
        const jp = job.payload as unknown as UploadPayload
        const sp = (job.payload as Record<string, unknown>).storagePath as string | undefined
        if (!sp) continue
        if (jp.type === 'photos') {
          photoStoragePaths.push(sp)
        } else if (jp.role) {
          storagePaths[jp.role] = sp
        }
      }

      if (!hasResolvedUploadConnection()) continue

      // Reuse the routine's existing uploadRunId — the R2 files for this attempt
      // were already written under that prefix. If missing (shouldn't happen for
      // a routine with done jobs), skip this retry rather than invent a new one.
      if (!routine.uploadRunId) {
        logger.upload.warn(`Skipping orphaned completion for ${routineId}: no uploadRunId on routine`)
        continue
      }

      const conn = getConnection()
      await callPluginComplete({
        routineId,
        entryId: routineId,
        competitionId: conn.competitionId,
        uploadRunId: routine.uploadRunId,
        storagePaths,
        photoStoragePaths,
      })

      state.updateRoutineStatus(routineId, 'uploaded')
      broadcastRoutineUpdate(routineId)
      retried++
      logger.upload.info(`Orphaned completion succeeded for routine ${routineId}`)
    } catch (err) {
      logger.upload.error(`Orphaned completion retry failed for ${routineId}:`, err instanceof Error ? err.message : err)
    }
  }

  return retried
}

/**
 * Retry uploading any routines stuck at 'encoded' that were skipped due to missing connection.
 * Yields to the event loop every BATCH_SIZE routines to prevent AppHangB1 on startup
 * when thousands of routines trigger IPC broadcasts on enqueue. Fire-and-forget (callers
 * can ignore the returned promise).
 */
export async function retrySkippedEncoded(): Promise<number> {
  const comp = state.getCompetition()
  if (!comp) return 0
  if (!hasResolvedUploadConnection()) return 0

  const settings = getSettings()
  if (!settings.behavior.autoUploadAfterEncoding) return 0

  const BATCH_SIZE = 25
  let retried = 0
  let processed = 0
  for (const routine of comp.routines) {
    if (routine.status !== 'encoded') continue
    const existingJobs = jobQueue.getByRoutine(routine.id).filter(j => j.type === 'upload')
    const hasPendingOrDone = existingJobs.some(j => j.status === 'pending' || j.status === 'running' || j.status === 'done')
    if (hasPendingOrDone) continue

    const result = enqueueRoutine(routine)
    if (result.queuedJobs > 0) {
      retried++
      logger.upload.info(`Retrying skipped upload for encoded routine ${routine.entryNumber} "${routine.routineTitle}" (${result.queuedJobs} jobs)`)
    }
    processed++
    if (processed % BATCH_SIZE === 0) {
      await new Promise(r => setImmediate(r))
    }
  }

  if (retried > 0) {
    startUploads()
  }
  return retried
}

/** Retry incomplete photo uploads for routines already at 'uploaded' status. */
export function retryIncompletePhotoUploads(): number {
  const comp = state.getCompetition()
  if (!comp) return 0
  if (!hasResolvedUploadConnection()) return 0

  let retried = 0
  for (const routine of comp.routines) {
    if (routine.status !== 'uploaded') continue
    const photos = routine.photos || []
    const pendingPhotos = photos.filter(p => !p.uploaded)
    if (pendingPhotos.length === 0) continue

    const result = enqueueRoutine(routine)
    if (result.queuedJobs > 0) {
      retried++
      logger.upload.info(`Retrying ${pendingPhotos.length} incomplete photo uploads for routine ${routine.entryNumber} "${routine.routineTitle}"`)
    }
  }

  if (retried > 0) {
    startUploads()
  }
  return retried
}

export function getQueueLength(): number {
  return jobQueue.getPending('upload').length + jobQueue.getRunning('upload').length
}

export function getUploadingCount(): number {
  return jobQueue.getRunning('upload').length
}

export function getQueueState(): { routineId: string; status: string }[] {
  return jobQueue.getAll()
    .filter(j => j.type === 'upload')
    .map(j => ({ routineId: j.routineId, status: j.status }))
}
