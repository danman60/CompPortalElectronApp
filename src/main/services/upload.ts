import fs from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import { Upload } from 'tus-js-client'
import { IPC_CHANNELS, UploadProgress, Routine } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'

interface UploadJob {
  routineId: string
  filePath: string
  objectName: string
  contentType: string
}

const queue: UploadJob[] = []
let isUploading = false
let isPaused = false
let currentUpload: Upload | null = null
let currentRoutineId: string | null = null

function sendProgress(routineId: string, progress: UploadProgress): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, { routineId, progress })
  }
}

export function enqueueRoutine(routine: Routine): void {
  const settings = getSettings()
  const { tenantId, competitionId } = { tenantId: settings.compsync.tenant, competitionId: settings.compsync.competition }

  if (!routine.encodedFiles) return

  const basePath = `${tenantId}/${competitionId}/${routine.id}`

  // Queue video files
  for (const file of routine.encodedFiles) {
    if (file.uploaded) continue
    queue.push({
      routineId: routine.id,
      filePath: file.filePath,
      objectName: `${basePath}/videos/${path.basename(file.filePath)}`,
      contentType: 'video/mp4',
    })
  }

  // Queue photos
  if (routine.photos) {
    for (const photo of routine.photos) {
      if (photo.uploaded) continue
      queue.push({
        routineId: routine.id,
        filePath: photo.filePath,
        objectName: `${basePath}/photos/${path.basename(photo.filePath)}`,
        contentType: 'image/jpeg',
      })
    }
  }

  const totalFiles = routine.encodedFiles.length + (routine.photos?.length || 0)
  logger.upload.info(
    `Queued ${queue.length} files for routine ${routine.entryNumber}, total queue: ${queue.length}`,
  )

  sendProgress(routine.id, {
    state: 'queued',
    percent: 0,
    filesCompleted: 0,
    filesTotal: totalFiles,
  })
}

export function startUploads(): void {
  if (isUploading && !isPaused) return
  isPaused = false
  logger.upload.info(`Starting upload queue, ${queue.length} files pending`)
  processNext()
}

export function stopUploads(): void {
  isPaused = true
  if (currentUpload) {
    currentUpload.abort()
    currentUpload = null
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

async function processNext(): Promise<void> {
  if (isPaused || queue.length === 0) {
    isUploading = false
    return
  }

  isUploading = true
  const job = queue.shift()!
  currentRoutineId = job.routineId

  try {
    await uploadFile(job)
    logger.upload.info(`Upload complete: ${job.objectName}`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.upload.error(`Upload failed: ${job.objectName}:`, errMsg)
    sendProgress(job.routineId, {
      state: 'failed',
      percent: 0,
      filesCompleted: 0,
      filesTotal: 0,
      error: errMsg,
    })
  }

  currentRoutineId = null
  processNext()
}

function uploadFile(job: UploadJob): Promise<void> {
  return new Promise((resolve, reject) => {
    const settings = getSettings()
    const apiKey = settings.compsync.pluginApiKey

    if (!apiKey) {
      reject(new Error('No plugin API key configured'))
      return
    }

    const fileStream = fs.createReadStream(job.filePath)
    const fileSize = fs.statSync(job.filePath).size

    let lastLoggedMilestone = 0

    currentUpload = new Upload(fileStream as unknown as Blob, {
      endpoint: settings.compsync.uploadEndpoint || `https://${settings.compsync.tenant}.supabase.co/storage/v1/upload/resumable`,
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      metadata: {
        bucketName: 'media',
        objectName: job.objectName,
        contentType: job.contentType,
      },
      uploadSize: fileSize,
      onProgress: (bytesUploaded: number, bytesTotal: number) => {
        const percent = Math.round((bytesUploaded / bytesTotal) * 100)

        // Log at 25% milestones
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
      },
      onSuccess: () => {
        currentUpload = null
        resolve()
      },
      onError: (error: Error) => {
        currentUpload = null
        reject(error)
      },
    })

    currentUpload.start()
  })
}

export async function callPluginComplete(
  routine: Routine,
  tenantId: string,
  competitionId: string,
): Promise<void> {
  const settings = getSettings()
  const apiKey = settings.compsync.pluginApiKey
  const endpoint = settings.compsync.uploadEndpoint || `https://${settings.compsync.tenant}.compsync.net/api/media/plugin/complete`

  const body = {
    entryId: routine.id,
    competitionId,
    tenantId,
    files: {
      performance: routine.encodedFiles?.find((f) => f.role === 'performance')?.uploadUrl,
      judge1: routine.encodedFiles?.find((f) => f.role === 'judge1')?.uploadUrl,
      judge2: routine.encodedFiles?.find((f) => f.role === 'judge2')?.uploadUrl,
      judge3: routine.encodedFiles?.find((f) => f.role === 'judge3')?.uploadUrl,
      judge4: routine.encodedFiles?.find((f) => f.role === 'judge4')?.uploadUrl,
      photos: routine.photos?.map((p) => p.filePath) || [],
    },
  }

  logger.upload.info(`Calling plugin/complete for routine ${routine.entryNumber}`)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Plugin complete failed: ${response.status} ${response.statusText}`)
  }

  logger.upload.info(`Plugin complete success for routine ${routine.entryNumber}`)
}

export function getQueueLength(): number {
  return queue.length + (isUploading ? 1 : 0)
}

// Persist queue state for resume on restart
export function getQueueState(): UploadJob[] {
  return [...queue]
}
