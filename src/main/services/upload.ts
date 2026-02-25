import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { IPC_CHANNELS, UploadProgress, Routine } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import { getResolvedConnection } from './schedule'

interface UploadJob {
  routineId: string
  filePath: string
  objectName: string
  contentType: string
  type: 'videos' | 'photos'
}

interface RoutineUploadState {
  routineId: string
  entryId: string
  competitionId: string
  jobs: UploadJob[]
  completedJobs: number
  storagePaths: Record<string, string> // role -> storagePath
  photoStoragePaths: string[]
}

const queue: RoutineUploadState[] = []
let isUploading = false
let isPaused = false
let currentAbortController: AbortController | null = null
let currentRoutineId: string | null = null
let uploadingCount = 0

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

  // Check if already queued
  if (queue.some((q) => q.routineId === routine.id)) return

  const state: RoutineUploadState = {
    routineId: routine.id,
    entryId: routine.id,
    competitionId,
    jobs: [],
    completedJobs: 0,
    storagePaths: {},
    photoStoragePaths: [],
  }

  // Queue video files
  for (const file of routine.encodedFiles) {
    if (file.uploaded) continue
    state.jobs.push({
      routineId: routine.id,
      filePath: file.filePath,
      objectName: `${file.role}.mp4`,
      contentType: 'video/mp4',
      type: 'videos',
    })
  }

  // Queue photos
  if (routine.photos) {
    for (const photo of routine.photos) {
      if (photo.uploaded) continue
      state.jobs.push({
        routineId: routine.id,
        filePath: photo.filePath,
        objectName: path.basename(photo.filePath),
        contentType: 'image/jpeg',
        type: 'photos',
      })
    }
  }

  if (state.jobs.length === 0) return

  queue.push(state)
  uploadingCount++

  logger.upload.info(
    `Queued ${state.jobs.length} files for routine ${routine.entryNumber}`,
  )

  sendProgress(routine.id, {
    state: 'queued',
    percent: 0,
    filesCompleted: 0,
    filesTotal: state.jobs.length,
  })
}

export function startUploads(): void {
  if (isUploading && !isPaused) return
  isPaused = false
  logger.upload.info(`Starting upload queue, ${queue.length} routines pending`)
  processNextRoutine()
}

export function stopUploads(): void {
  isPaused = true
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
    logger.upload.info('Upload paused')
  }
  if (currentRoutineId) {
    sendProgress(currentRoutineId, {
      state: 'paused',
      percent: 0,
      filesCompleted: 0,
      filesTotal: 0,
    })
  }
}

async function processNextRoutine(): Promise<void> {
  if (isPaused || queue.length === 0) {
    isUploading = false
    return
  }

  isUploading = true
  const routineState = queue[0]
  currentRoutineId = routineState.routineId

  try {
    // Upload each file
    for (let i = routineState.completedJobs; i < routineState.jobs.length; i++) {
      if (isPaused) return

      const job = routineState.jobs[i]
      sendProgress(routineState.routineId, {
        state: 'uploading',
        percent: Math.round((i / routineState.jobs.length) * 100),
        currentFile: path.basename(job.filePath),
        filesCompleted: i,
        filesTotal: routineState.jobs.length,
      })

      // Step 1: Get signed upload URL from our API
      const { signedUrl, storagePath } = await getSignedUploadUrl(
        routineState.entryId,
        routineState.competitionId,
        job.type,
        job.objectName,
        job.contentType,
      )

      // Track storage path for the complete call
      if (job.type === 'videos') {
        // Extract role from filename (performance.mp4, judge1.mp4, etc.)
        const role = job.objectName.replace('.mp4', '')
        routineState.storagePaths[role] = storagePath
      } else {
        routineState.photoStoragePaths.push(storagePath)
      }

      // Step 2: Upload file to the signed URL
      await uploadFileToSignedUrl(signedUrl, job)

      routineState.completedJobs = i + 1
      logger.upload.info(`Uploaded ${i + 1}/${routineState.jobs.length}: ${job.objectName}`)
    }

    // Step 3: Call plugin/complete to register in database
    await callPluginComplete(routineState)

    sendProgress(routineState.routineId, {
      state: 'complete',
      percent: 100,
      filesCompleted: routineState.jobs.length,
      filesTotal: routineState.jobs.length,
    })

    logger.upload.info(`All uploads complete for routine ${routineState.routineId}`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.upload.error(`Upload failed for routine ${routineState.routineId}:`, errMsg)
    sendProgress(routineState.routineId, {
      state: 'failed',
      percent: 0,
      filesCompleted: routineState.completedJobs,
      filesTotal: routineState.jobs.length,
      error: errMsg,
    })
  }

  // Remove completed/failed routine from queue
  queue.shift()
  uploadingCount = Math.max(0, uploadingCount - 1)
  currentRoutineId = null
  processNextRoutine()
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
  job: UploadJob,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(job.filePath).size
    const fileStream = fs.createReadStream(job.filePath)
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
          'Content-Type': job.contentType,
        },
      },
      (res) => {
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

    currentAbortController = new AbortController()
    currentAbortController.signal.addEventListener('abort', () => {
      req.destroy()
      fileStream.destroy()
    })

    req.on('error', (err) => {
      fileStream.destroy()
      reject(err)
    })

    fileStream.on('data', (chunk) => {
      bytesUploaded += chunk.length
      const percent = Math.round((bytesUploaded / fileSize) * 100)

      const milestone = Math.floor(percent / 25) * 25
      if (milestone > lastLoggedMilestone) {
        lastLoggedMilestone = milestone
        logger.upload.info(`Upload ${job.objectName}: ${percent}%`)
      }

      sendProgress(job.routineId, {
        state: 'uploading',
        percent,
        currentFile: path.basename(job.filePath),
        filesCompleted: 0,
        filesTotal: 1,
      })
    })

    fileStream.pipe(req)
  })
}

async function callPluginComplete(
  state: RoutineUploadState,
): Promise<void> {
  const { apiBase, apiKey } = getConnection()

  const body = {
    entryId: state.entryId,
    competitionId: state.competitionId,
    files: {
      performance: state.storagePaths['performance'] || undefined,
      judge1: state.storagePaths['judge1'] || undefined,
      judge2: state.storagePaths['judge2'] || undefined,
      judge3: state.storagePaths['judge3'] || undefined,
      judge4: state.storagePaths['judge4'] || undefined,
      photos: state.photoStoragePaths.length > 0 ? state.photoStoragePaths : undefined,
    },
  }

  logger.upload.info(`Calling plugin/complete for routine ${state.routineId}`)
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

  logger.upload.info(`Plugin complete success for routine ${state.routineId}`)
}

export function getQueueLength(): number {
  return queue.length
}

export function getUploadingCount(): number {
  return uploadingCount
}

export function getQueueState(): RoutineUploadState[] {
  return [...queue]
}
