import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { IPC_CHANNELS, UploadProgress, Routine } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import { getResolvedConnection } from './schedule'
import * as state from './state'
import * as jobQueue from './jobQueue'

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

let isUploading = false
let isPaused = false
let currentAbortController: AbortController | null = null

function sendProgress(routineId: string, progress: UploadProgress): void {
  sendToRenderer(IPC_CHANNELS.UPLOAD_PROGRESS, { routineId, progress })
}

function getConnection(): { apiBase: string; apiKey: string; competitionId: string } {
  const conn = getResolvedConnection()
  if (!conn) throw new Error('No active connection. Load a competition via share code first.')
  return { apiBase: conn.apiBase, apiKey: conn.apiKey, competitionId: conn.competitionId }
}

export function enqueueRoutine(routine: Routine): void {
  const { competitionId } = getConnection()

  if (!routine.encodedFiles) return

  // Check if already queued (any pending/running upload job for this routine)
  const existing = jobQueue.getByRoutine(routine.id)
  if (existing.some(j => j.type === 'upload' && (j.status === 'pending' || j.status === 'running'))) {
    return
  }

  let jobCount = 0

  // Queue video files
  for (const file of routine.encodedFiles) {
    if (file.uploaded) continue
    const role = file.role
    jobQueue.enqueue('upload', routine.id, {
      routineId: routine.id,
      entryId: routine.id,
      competitionId,
      filePath: file.filePath,
      objectName: `${role}.mp4`,
      contentType: 'video/mp4',
      type: 'videos',
      role,
    } satisfies UploadPayload as unknown as Record<string, unknown>)
    jobCount++
  }

  // Queue photos
  if (routine.photos) {
    for (const photo of routine.photos) {
      if (photo.uploaded) continue
      jobQueue.enqueue('upload', routine.id, {
        routineId: routine.id,
        entryId: routine.id,
        competitionId,
        filePath: photo.filePath,
        objectName: path.basename(photo.filePath),
        contentType: 'image/jpeg',
        type: 'photos',
      } satisfies UploadPayload as unknown as Record<string, unknown>)
      jobCount++
    }
  }

  if (jobCount === 0) return

  logger.upload.info(`Queued ${jobCount} upload jobs for routine ${routine.entryNumber}`)

  sendProgress(routine.id, {
    state: 'queued',
    percent: 0,
    filesCompleted: 0,
    filesTotal: jobCount,
  })
}

export function startUploads(): void {
  if (isUploading && !isPaused) return
  isPaused = false
  const pendingCount = jobQueue.getPending('upload').length
  logger.upload.info(`Starting upload queue, ${pendingCount} jobs pending`)
  processLoop()
}

export function stopUploads(): void {
  isPaused = true
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
    logger.upload.info('Upload paused — current upload aborted')
  }
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

    // Set routine status to uploading
    state.updateRoutineStatus(payload.routineId, 'uploading')

    const allRoutineJobs = jobQueue.getByRoutine(payload.routineId).filter(j => j.type === 'upload')
    const completedCount = allRoutineJobs.filter(j => j.status === 'done').length
    const totalCount = allRoutineJobs.length

    sendProgress(payload.routineId, {
      state: 'uploading',
      percent: Math.round((completedCount / totalCount) * 100),
      currentFile: path.basename(payload.filePath),
      filesCompleted: completedCount,
      filesTotal: totalCount,
    })

    try {
      // Step 1: Get signed upload URL
      const { signedUrl, storagePath } = await getSignedUploadUrl(
        payload.entryId,
        payload.competitionId,
        payload.type,
        payload.objectName,
        payload.contentType,
      )

      // Step 2: Upload file with timeout
      await uploadFileToSignedUrl(signedUrl, payload)

      // Persist storagePath in the job for plugin/complete
      jobQueue.updateStatus(job.id, 'done', { storagePath })
      logger.upload.info(`Uploaded: ${payload.objectName} for routine ${payload.routineId}`)

      // Check if all uploads for this routine are done
      const updatedJobs = jobQueue.getByRoutine(payload.routineId).filter(j => j.type === 'upload')
      const allDone = updatedJobs.every(j => j.status === 'done')

      if (allDone) {
        // Call plugin/complete — collect storagePaths from completed jobs
        try {
          const storagePaths: Record<string, string> = {}
          const photoStoragePaths: string[] = []

          for (const doneJob of updatedJobs) {
            const jp = doneJob.payload as unknown as UploadPayload
            const sp = (doneJob.payload as Record<string, unknown>).storagePath as string | undefined
            if (!sp) continue
            if (jp.type === 'photos') {
              photoStoragePaths.push(sp)
            } else if (jp.role) {
              storagePaths[jp.role] = sp
            }
          }

          await callPluginComplete({
            routineId: payload.routineId,
            entryId: payload.entryId,
            competitionId: payload.competitionId,
            storagePaths,
            photoStoragePaths,
          })

          state.updateRoutineStatus(payload.routineId, 'uploaded')
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
    } finally {
      // ALWAYS clean up abort controller
      currentAbortController = null
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
): Promise<{ signedUrl: string; storagePath: string }> {
  const { apiBase, apiKey } = getConnection()
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
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to get upload URL: ${response.status} ${text}`)
  }

  return response.json()
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

    // Timeout timer
    const timer = setTimeout(() => {
      req.destroy()
      fileStream.destroy()
      reject(new Error(`Upload timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    // Abort controller for pause/cancel
    currentAbortController = new AbortController()
    currentAbortController.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      req.destroy()
      fileStream.destroy()
      reject(new Error('Upload aborted'))
    })

    req.on('error', (err) => {
      clearTimeout(timer)
      fileStream.destroy()
      reject(err)
    })

    fileStream.on('data', (chunk) => {
      bytesUploaded += chunk.length
      const percent = Math.round((bytesUploaded / fileSize) * 100)

      const milestone = Math.floor(percent / 25) * 25
      if (milestone > lastLoggedMilestone) {
        lastLoggedMilestone = milestone
        logger.upload.info(`Upload ${payload.objectName}: ${percent}%`)
      }

      sendProgress(payload.routineId, {
        state: 'uploading',
        percent,
        currentFile: path.basename(payload.filePath),
        filesCompleted: 0,
        filesTotal: 1,
      })
    })

    fileStream.pipe(req)
  })
}

async function callPluginComplete(info: {
  routineId: string
  entryId: string
  competitionId: string
  storagePaths: Record<string, string>
  photoStoragePaths: string[]
}): Promise<void> {
  const { apiBase, apiKey } = getConnection()

  const body = {
    entryId: info.entryId,
    competitionId: info.competitionId,
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
  const response = await fetch(`${apiBase}/api/plugin/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Plugin complete failed: ${response.status} ${text}`)
  }

  logger.upload.info(`Plugin complete success for routine ${info.routineId}`)
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
