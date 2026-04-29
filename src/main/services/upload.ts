import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { IPC_CHANNELS, UploadProgress, Routine, PhotoMatch } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import { getResolvedConnection } from './schedule'
import { getSettings } from './settings'
import * as state from './state'
import * as jobQueue from './jobQueue'
import { broadcastFullState, broadcastRoutineUpdate } from './recording'
import { ThrottleStream } from '../utils/throttle'
import * as importManifest from './importManifest'
import { generatePhotoThumbnail } from './ffmpeg'
import os from 'os'

interface UploadPayload {
  routineId: string
  entryId: string
  competitionId: string
  filePath: string
  objectName: string
  contentType: string
  type: 'videos' | 'photos'
  role?: string // 'performance' | 'judge1' etc for videos
  thumbnailPath?: string // local path to 200×200 WebP thumb (SD-import photos only)
  // Keyframe marker — when present, this upload is a video-keyframe (WebP).
  // Uploaded under `<entry>/videos/keyframes/<objectName>` even though
  // `type === 'videos'` by default path convention.
  isKeyframe?: boolean
  keyframeIndex?: number // 0, 1, 2
  isPhotoThumbRepair?: boolean
  sourcePhotoStoragePath?: string
  photoCaptureTime?: string
}

export interface EnqueueRoutineResult {
  queuedJobs: number
  skippedReason?: 'no-connection' | 'no-files' | 'already-queued'
}

const API_TIMEOUT_MS = 30000

/**
 * Derive the thumbnail R2 object name from the original photo's object name.
 * Example: `photo_001.jpg` → `photo_001_thumb.webp`. Used so the thumb lands
 * as a sibling of the original under the same R2 prefix.
 */
function deriveThumbObjectName(originalObjectName: string): string {
  // Strip trailing .jpg/.jpeg (case-insensitive) and append `_thumb.webp`.
  const base = originalObjectName.replace(/\.(jpe?g)$/i, '')
  return `${base}_thumb.webp`
}

/**
 * Generate a thumbnail for a photo file on demand via the bundled ffmpeg.
 * Returns the local thumbnail path (inside the photo's sibling `thumbnails`
 * dir) on success, or null on failure. Sharp was moved out of the import
 * loop (T-H17) because the sharp 0.32.6/0.33.x asar runtime on Windows
 * produced a 100% failure rate during the UDC London 2026-04-19 H:\ import.
 * ffmpeg is stable, bundled, and already a dep — slower (~200ms/photo)
 * but runs off the main thread as a subprocess.
 */
async function ensurePhotoThumbnail(localPhotoPath: string): Promise<string | null> {
  try {
    if (!fs.existsSync(localPhotoPath)) return null
    const parsed = path.parse(localPhotoPath)
    // Prefer sibling `thumbnails` dir next to the photo (keeps everything
    // within the routine output dir). Falls back to os.tmpdir() on any
    // unexpected permission error.
    const preferredDir = path.join(parsed.dir, '..', 'thumbnails')
    let thumbDir = preferredDir
    try {
      await fs.promises.mkdir(thumbDir, { recursive: true })
    } catch {
      thumbDir = os.tmpdir()
    }
    const thumbPath = path.join(thumbDir, `${parsed.name}_thumb.webp`)
    if (fs.existsSync(thumbPath)) return thumbPath
    const ok = await generatePhotoThumbnail(localPhotoPath, thumbPath)
    if (!ok) return null
    return thumbPath
  } catch (err) {
    logger.upload.warn(`ensurePhotoThumbnail failed for ${localPhotoPath}: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

/**
 * Best-effort existence check on a signed R2 URL via HEAD.
 * Returns:
 *   'exists' — HTTP 2xx (object is already in the bucket; skip PUT)
 *   'missing' — HTTP 404 (object absent; proceed with PUT)
 *   'unknown' — auth rejection (signed URL method mismatch), network error, or
 *              any other non-terminal status. Caller should fall through to PUT
 *              rather than trust the negative.
 *
 * Note: CompPortal's /api/plugin/upload-url currently only signs PUT URLs, so
 * on real R2 the HEAD will typically return 403 SignatureDoesNotMatch and this
 * check becomes a no-op (falls through to PUT). Tests that mock the signed URL
 * endpoint to honour HEAD get real dedup. When CompPortal grows a HEAD-signer
 * this becomes a one-line swap to sign HEAD-specific URLs.
 */
function checkR2ObjectExists(signedUrl: string, timeoutMs = 5000): Promise<'exists' | 'missing' | 'unknown'> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (v: 'exists' | 'missing' | 'unknown'): void => {
      if (settled) return
      settled = true
      resolve(v)
    }
    try {
      const url = new URL(signedUrl)
      const httpModule = url.protocol === 'https:' ? https : http
      const req = httpModule.request(signedUrl, { method: 'HEAD' }, (res) => {
        const code = res.statusCode || 0
        // Drain response so socket can be reused / closed cleanly.
        res.on('data', () => {})
        res.on('end', () => {
          if (code >= 200 && code < 300) settle('exists')
          else if (code === 404) settle('missing')
          else settle('unknown')
        })
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        settle('unknown')
      })
      req.on('error', () => settle('unknown'))
      req.end()
    } catch {
      settle('unknown')
    }
  })
}

let isUploading = false
let isPaused = false
let currentAbortController: AbortController | null = null
let currentAbortRoutineId: string | null = null
let idleReconcileTimer: NodeJS.Timeout | null = null

// Tracks photos already included in a plugin/complete call per routine,
// so incremental mode knows when the threshold has been crossed again.
const publishedPhotoCountByRoutine = new Map<string, number>()

// Fix 8/9: external pause flags (disk space low / drive lost)
let pausedByDiskSpace = false
let pausedByDriveLoss = false

export function getUploadRuntimeState(): {
  isUploading: boolean
  isPaused: boolean
  pausedByDiskSpace: boolean
  pausedByDriveLoss: boolean
  pending: number
  running: number
  quarantined: number
} {
  return {
    isUploading,
    isPaused,
    pausedByDiskSpace,
    pausedByDriveLoss,
    pending: jobQueue.getPending('upload').length,
    running: jobQueue.getRunning('upload').length,
    quarantined: jobQueue.getQuarantined('upload').length,
  }
}

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

  // Queue video keyframes — nested under the video's R2 prefix as
  // `videos/keyframes/keyframe_N.webp`. Used by CompPortal's Gemini
  // spot-check validator as reference frames for the routine's dancer(s).
  const keyframes = routine.keyframes || []
  for (let i = 0; i < keyframes.length; i++) {
    const kfPath = keyframes[i]
    if (!kfPath || !fs.existsSync(kfPath)) continue
    const objectName = `keyframes/keyframe_${i}.webp`
    if (skipObjectNames.has(objectName)) continue
    jobQueue.enqueue('upload', routine.id, {
      routineId: routine.id,
      entryId: routine.id,
      competitionId: conn.competitionId,
      filePath: kfPath,
      objectName,
      contentType: 'image/webp',
      type: 'videos',
      isKeyframe: true,
      keyframeIndex: i,
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
        photoCaptureTime: photo.captureTime,
        // Carry the local thumb path (if any) so the upload loop can PUT it next
        // to the original. Only SD-import photos have this; tether-flow photos
        // skip the thumb upload (thumbnailPath undefined).
        thumbnailPath: photo.thumbnailPath,
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

export function enqueuePhotoThumbRepair(
  routine: Routine,
  photo: PhotoMatch,
): EnqueueRoutineResult {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.upload.warn(`Skipping thumb repair for routine ${routine.entryNumber}: no resolved upload connection`)
    return { queuedJobs: 0, skippedReason: 'no-connection' }
  }
  if (!photo.uploaded || !photo.storagePath) {
    return { queuedJobs: 0, skippedReason: 'no-files' }
  }

  const existing = jobQueue.getByRoutine(routine.id)
  const alreadyQueued = existing.some((j) => {
    if (j.type !== 'upload') return false
    const payload = j.payload as Record<string, unknown>
    return (
      payload.isPhotoThumbRepair === true &&
      payload.sourcePhotoStoragePath === photo.storagePath &&
      (j.status === 'pending' || j.status === 'running' || j.status === 'done')
    )
  })
  if (alreadyQueued) return { queuedJobs: 0, skippedReason: 'already-queued' }

  const thumbObjectName = deriveThumbObjectName(path.basename(photo.filePath))
  jobQueue.enqueue('upload', routine.id, {
    routineId: routine.id,
    entryId: routine.id,
    competitionId: conn.competitionId,
    filePath: photo.filePath,
    objectName: thumbObjectName,
    contentType: 'image/webp',
    type: 'photos',
    thumbnailPath: photo.thumbnailPath,
    isPhotoThumbRepair: true,
    sourcePhotoStoragePath: photo.storagePath,
  } satisfies UploadPayload as unknown as Record<string, unknown>)

  logger.upload.info(
    `Queued thumb repair for routine ${routine.entryNumber}: ${path.basename(photo.filePath)} -> ${thumbObjectName}`,
  )
  return { queuedJobs: 1 }
}

/**
 * Interleave photo uploads across multiple routines — slideshow-friendly
 * breadth-first ordering. Videos + keyframes still enqueue per-routine up
 * front (they're few, fast, valuable early). Photos then round-robin pop
 * across all provided routines.
 *
 * Call INSTEAD OF calling enqueueRoutine(r) per-routine when
 * settings.upload.strategy === 'round-robin'.
 */
export function enqueueRoundRobin(routines: Routine[]): EnqueueRoutineResult {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.upload.warn('Skipping round-robin enqueue: no resolved upload connection')
    return { queuedJobs: 0, skippedReason: 'no-connection' }
  }

  let total = 0

  // Pass 1: videos + keyframes per routine (strip photos temporarily)
  for (const routine of routines) {
    const photoBackup = routine.photos
    routine.photos = []
    const res = enqueueRoutine(routine)
    routine.photos = photoBackup
    total += res.queuedJobs
  }

  // Pass 2: bucket each routine's unuploaded photos, round-robin pop
  const buckets: Array<{ routine: Routine; queue: PhotoMatch[] }> = []
  for (const routine of routines) {
    const pending = (routine.photos || [])
      .filter((p) => !p.uploaded && p.confidence !== 'unmatched')
      .sort((a, b) => (a.captureTime || '').localeCompare(b.captureTime || ''))
    if (pending.length > 0) {
      buckets.push({ routine, queue: pending })
    }
  }

  // Per-routine skip-sets to avoid dupe-enqueue against existing jobs
  const skipByRoutine = new Map<string, Set<string>>()
  for (const { routine } of buckets) {
    const existing = jobQueue.getByRoutine(routine.id)
    const skip = new Set(
      existing
        .filter((j) => j.type === 'upload' && (j.status === 'done' || j.status === 'pending' || j.status === 'running'))
        .map((j) => (j.payload as Record<string, unknown>).objectName as string),
    )
    skipByRoutine.set(routine.id, skip)
  }

  let cursor = 0
  let photoJobs = 0
  while (buckets.length > 0) {
    const idx = cursor % buckets.length
    const bucket = buckets[idx]
    const photo = bucket.queue.shift()
    if (!photo) {
      buckets.splice(idx, 1)
      continue
    }
    const objectName = path.basename(photo.filePath)
    const skip = skipByRoutine.get(bucket.routine.id)!
    if (!skip.has(objectName)) {
      jobQueue.enqueue('upload', bucket.routine.id, {
        routineId: bucket.routine.id,
        entryId: bucket.routine.id,
        competitionId: conn.competitionId,
        filePath: photo.filePath,
        objectName,
        contentType: 'image/jpeg',
        type: 'photos',
        photoCaptureTime: photo.captureTime,
        thumbnailPath: photo.thumbnailPath,
      } satisfies UploadPayload as unknown as Record<string, unknown>)
      photoJobs++
    }
    if (bucket.queue.length === 0) {
      buckets.splice(idx, 1)
      continue
    }
    cursor++
  }

  total += photoJobs
  logger.upload.info(`Round-robin enqueue: ${photoJobs} photo jobs across ${routines.length} routines (plus videos/keyframes)`)
  return { queuedJobs: total }
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

function scheduleIdleSelfHeal(): void {
  if (idleReconcileTimer) return
  idleReconcileTimer = setTimeout(() => {
    idleReconcileTimer = null
    if (isPaused || isUploading || !hasResolvedUploadConnection()) return
    if (getSettings().behavior.autoUploadAfterEncoding === false) return
    try {
      // Dynamic import (not require) so electron-vite's bundler emits the
      // chunk and the asar resolver finds it at runtime.
      void import('./mediaReconciler').then((reconciler) =>
        reconciler.reconcileMedia({
          scope: 'ambient',
          silent: true,
        }).catch((err: unknown) => {
          logger.upload.warn(`idle self-heal reconcile failed: ${err instanceof Error ? err.message : err}`)
        }),
      ).catch((err: unknown) => {
        logger.upload.warn(`idle self-heal load failed: ${err instanceof Error ? err.message : err}`)
      })
    } catch (err) {
      logger.upload.warn(`idle self-heal reconcile bootstrap failed: ${err instanceof Error ? err.message : err}`)
    }
  }, 2000)
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

    const activeCompetitionId = state.getCompetition()?.competitionId
    const payload = job.payload as unknown as UploadPayload
    if (
      activeCompetitionId &&
      payload.competitionId &&
      payload.competitionId !== activeCompetitionId
    ) {
      logger.upload.warn(
        `Dropping stale upload job ${job.id} for competition ${payload.competitionId}; active competition is ${activeCompetitionId}`,
      )
      jobQueue.remove(job.id)
      continue
    }

    jobQueue.updateStatus(job.id, 'running')

    // Ensure the routine is in an upload attempt with a persisted uploadRunId.
    //
    // uploadRunId lives on the Routine itself (persisted via updateRoutineStatus).
    // Rationale: a single upload attempt for one routine spans multiple processLoop
    // iterations (one per file). All jobs in the same attempt must share a runId so
    // the R2 paths land under a single {.../uploadRunId/...} prefix AND /complete
    // can match them. On retry after failure the routine is reset to 'encoded', so
    // the next 'encoded → uploading' transition naturally generates a fresh runId.
    // Persisting on the routine also survives app crashes mid-attempt.
    //
    // Self-heal: crash-recovered / older queued jobs can be resumed while the local
    // routine is already marked `uploading` but has no uploadRunId persisted. In
    // that case, mint a fresh runId instead of failing every job in a tight loop.
    const routine = state.getCompetition()?.routines.find(r => r.id === payload.routineId)
    if (!routine) {
      const errMsg = `Missing routine ${payload.routineId} for upload job ${job.id}`
      logger.upload.error(errMsg)
      jobQueue.quarantine(job.id, errMsg)
      continue
    }
    if (routine.status !== 'uploading' || !routine.uploadRunId) {
      const uploadRunId = crypto.randomUUID()
      if (routine.status === 'uploading' && !routine.uploadRunId) {
        logger.upload.warn(`Routine ${payload.routineId} was uploading with no uploadRunId; minting a new runId`)
      }
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
      jobQueue.quarantine(job.id, errMsg)
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

      let storagePath: string | undefined
      let thumbStoragePath: string | undefined

      if (payload.isPhotoThumbRepair) {
        if (!payload.sourcePhotoStoragePath) {
          throw new Error(`Thumb repair missing sourcePhotoStoragePath for ${payload.objectName}`)
        }
        if (!payload.thumbnailPath || !fs.existsSync(payload.thumbnailPath)) {
          const jit = await ensurePhotoThumbnail(payload.filePath)
          if (jit) payload.thumbnailPath = jit
        }
        if (!payload.thumbnailPath || !fs.existsSync(payload.thumbnailPath)) {
          throw new Error(`Thumb repair could not generate thumbnail for ${payload.filePath}`)
        }

        const repair = await getSignedUploadUrl(
          payload.entryId,
          payload.competitionId,
          payload.type,
          payload.objectName,
          'image/webp',
          uploadRunId,
        )
        await uploadFileToSignedUrl(repair.signedUrl, {
          ...payload,
          filePath: payload.thumbnailPath,
          contentType: 'image/webp',
        })
        thumbStoragePath = repair.storagePath
        logger.upload.info(`Uploaded thumb repair: ${payload.objectName} for routine ${payload.routineId}`)
      } else {
        // Step 1: Get signed upload URL
        const signed = await getSignedUploadUrl(
          payload.entryId,
          payload.competitionId,
          payload.type,
          payload.objectName,
          payload.contentType,
          uploadRunId,
        )
        storagePath = signed.storagePath

        // Step 2: Upload file with timeout
        await uploadFileToSignedUrl(signed.signedUrl, payload)

        // Step 2b (SD-import photos only): upload the 200×200 WebP thumb as a sibling
      // of the original. Thumb R2 key mirrors `storagePath` but with the extension
      // swapped to `_thumb.webp` (e.g. `photos/photo_001.jpg` → `photos/photo_001_thumb.webp`).
      // If the thumb PUT fails, we log + continue — the original already landed, so the
      // routine isn't blocked. CompPortal will fall back to on-the-fly serving.
      //
      // T-H17 (2026-04-19): if the upload payload didn't ship a pre-generated
      // thumb path (import loop no longer creates them), generate one now
      // via ffmpeg. Keeps main thread free during bulk SD imports.
        if (
          payload.type === 'photos' &&
          (!payload.thumbnailPath || !fs.existsSync(payload.thumbnailPath))
        ) {
          const jit = await ensurePhotoThumbnail(payload.filePath)
          if (jit) {
            payload.thumbnailPath = jit
          }
        }
        if (payload.type === 'photos' && payload.thumbnailPath && fs.existsSync(payload.thumbnailPath)) {
          try {
            const thumbObjectName = deriveThumbObjectName(payload.objectName)
            const { signedUrl: thumbSignedUrl, storagePath: tsp } = await getSignedUploadUrl(
              payload.entryId,
              payload.competitionId,
              payload.type,
              thumbObjectName,
              'image/webp',
              uploadRunId,
            )
            const headStatus = await checkR2ObjectExists(thumbSignedUrl)
            if (headStatus === 'exists') {
              thumbStoragePath = tsp
              logger.upload.info(`Thumb HEAD-hit, skipping PUT: ${thumbObjectName} for routine ${payload.routineId}`)
            } else {
              await uploadFileToSignedUrl(thumbSignedUrl, {
                ...payload,
                filePath: payload.thumbnailPath,
                objectName: thumbObjectName,
                contentType: 'image/webp',
              })
              thumbStoragePath = tsp
              logger.upload.info(`Uploaded thumb: ${thumbObjectName} for routine ${payload.routineId}`)
            }
          } catch (thumbErr) {
            logger.upload.warn(
              `Thumb upload failed for ${payload.objectName} (non-fatal):`,
              thumbErr instanceof Error ? thumbErr.message : thumbErr,
            )
          }
        }
      }

      // Persist storagePath (and thumb path if we got one) in the job for plugin/complete
      jobQueue.updateStatus(job.id, 'done', { storagePath, thumbStoragePath })
      logger.upload.info(`Uploaded: ${payload.objectName} for routine ${payload.routineId}`)

      // Check if all uploads for this routine are done (exclude cancelled jobs from prior recordings)
      const updatedJobs = jobQueue.getByRoutine(payload.routineId).filter(j => j.type === 'upload' && j.status !== 'cancelled')
      const allDone = updatedJobs.every(j => j.status === 'done')

      // Fire incremental /plugin/complete on every completed photo (reverts 452a6de8
      // regression that batched them behind a 20-photo threshold). Each call is
      // idempotent on (media_package_id, storage_url) so duplicates are safe, and
      // Latest Photos stays real-time during live shows. Skipped when allDone fires
      // the final /plugin/complete just below.
      if (payload.type === 'photos' && !allDone) {
        void callPluginCompletePartial(payload.routineId, uploadRunId)
      }

      if (allDone) {
        // Call plugin/complete — collect storagePaths from completed jobs + already-uploaded files
        try {
          const storagePaths: Record<string, string> = {}
          const photoStoragePaths: string[] = []
          // Parallel array, indexed same as photoStoragePaths. Empty string = no thumb
          // for that index (tether-flow photo, or thumb PUT failed). CompPortal-3 reads
          // this as `photoThumbnailStoragePaths[i]` → `media_photos.thumbnail_url` for
          // `media_photos[i]`. An empty string means "no thumb, fall back to on-the-fly".
          const photoThumbnailStoragePaths: string[] = []
          // Parallel array of EXIF DateTimeOriginal ISO timestamps per photo. Maps to
          // `media_photos[i].captured_at` on the CompPortal side. Empty string when the
          // photo carries no EXIF capture time (should be rare — tether path always has
          // one). Persisting captured_at enables post-hoc dedup + forensic audit.
          const photoCapturedAt: string[] = []
          // Parallel-indexed keyframe storage paths (3 elements expected,
          // or fewer if extraction failed). Goes to CompPortal as
          // `files.video_keyframes` — used by the Gemini spot-check
          // validator as reference frames for the routine's dancer(s).
          const videoKeyframeStoragePaths: string[] = []

          // Include already-uploaded files from routine state (covers prior session uploads)
          const routineState = state.getCompetition()?.routines.find(r => r.id === payload.routineId)
          if (routineState) {
            for (const f of routineState.encodedFiles || []) {
              if (f.uploaded && f.storagePath) storagePaths[f.role] = f.storagePath
            }
            for (const p of routineState.photos || []) {
              if (p.uploaded && p.storagePath) {
                photoStoragePaths.push(p.storagePath)
                photoThumbnailStoragePaths.push(p.thumbnailStoragePath || '')
                photoCapturedAt.push(p.captureTime || '')
              }
            }
          }

          // Overlay with paths from current job batch (freshest)
          for (const doneJob of updatedJobs) {
            const jp = doneJob.payload as unknown as UploadPayload
            const sp = (doneJob.payload as Record<string, unknown>).storagePath as string | undefined
            const tsp = (doneJob.payload as Record<string, unknown>).thumbStoragePath as string | undefined
            if (jp.isPhotoThumbRepair) {
              const sourcePhotoStoragePath = jp.sourcePhotoStoragePath
              if (sourcePhotoStoragePath && tsp) {
                const idx = photoStoragePaths.indexOf(sourcePhotoStoragePath)
                if (idx !== -1) {
                  photoThumbnailStoragePaths[idx] = tsp
                }
              }
              continue
            }
            if (!sp) continue
            if (jp.isKeyframe && typeof jp.keyframeIndex === 'number') {
              // Keyframes are indexed by `keyframeIndex` (0..2) — slot in at that position.
              while (videoKeyframeStoragePaths.length <= jp.keyframeIndex) {
                videoKeyframeStoragePaths.push('')
              }
              videoKeyframeStoragePaths[jp.keyframeIndex] = sp
            } else if (jp.type === 'photos') {
              if (!photoStoragePaths.includes(sp)) {
                photoStoragePaths.push(sp)
                photoThumbnailStoragePaths.push(tsp || '')
                // Look up capture time from routine.photos keyed by filePath/storagePath,
                // fall back to the payload (set at enqueue from fresh EXIF read) when
                // state.photos has been wiped mid-upload (SD re-ingest, re-record, restart race).
                // Observed 2026-04-24: 27% of UDC Toronto photos landed with NULL captured_at
                // because state.photos.find() returned undefined for in-flight upload bursts.
                const photo = routineState?.photos?.find(
                  (p) => p.storagePath === sp || p.filePath === jp.filePath,
                )
                photoCapturedAt.push(photo?.captureTime || jp.photoCaptureTime || '')
              }
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
            photoThumbnailStoragePaths,
            photoCapturedAt,
            videoKeyframeStoragePaths,
          })

          publishedPhotoCountByRoutine.delete(payload.routineId)

          // Mark individual files as uploaded with their storage paths
          const routine = state.getCompetition()?.routines.find(r => r.id === payload.routineId)
          if (routine) {
            const updatedFiles = (routine.encodedFiles || []).map(f => {
              const sp = storagePaths[f.role]
              return sp ? { ...f, uploaded: true, storagePath: sp } : f
            })
            const updatedPhotos = (routine.photos || []).map((p, i) => {
              const sp = photoStoragePaths[i]
              const tsp = photoThumbnailStoragePaths[i]
              if (!sp) return p
              return {
                ...p,
                uploaded: true,
                storagePath: sp,
                thumbnailStoragePath: tsp && tsp.length > 0 ? tsp : undefined,
              }
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
          // T-V7-26: fire-and-forget post-record reconcile for this routine
          // to catch plugin/complete partial failures or any drift the
          // server-side ingest introduced. Silent — log-only.
          try {
            void import('./mediaReconciler').then((reconciler) =>
              reconciler.reconcileMedia({
                scope: 'post-record',
                routineIds: [payload.routineId],
                silent: true,
              }).catch(() => {}),
            ).catch(() => {})
          } catch {}
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
      const nonRetryable =
        errMsg.includes('File not found:') ||
        errMsg.includes('File too large for single upload') ||
        errMsg.includes('Missing uploadRunId') ||
        errMsg.includes('Missing routine ')
      if (nonRetryable) {
        jobQueue.quarantine(job.id, errMsg)
      } else {
        jobQueue.updateStatus(job.id, 'failed', { error: errMsg })
      }

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

// Resolve a synthetic late-insert id (`empty-<isoTimestamp>`) to the real
// CompPortal entry uuid by calling `/api/plugin/late-insert-resolve`. Patches
// the local routine.id + entryNumber and persists state so the standard
// upload-url + complete flow can proceed against the real uuid.
//
// Idempotent on (competitionId, syntheticId) — CompPortal enforces this at
// the DB layer via UNIQUE (competition_id, synthetic_id). Calling twice for
// the same recording returns the same entryId.
//
// Wired in 2026-04-25 against the spec in CompPortal/INBOX.md (15:30+15:35
// EDT). Waits for the CompPortal session to ship the endpoint; until then
// this throws and uploads of late-insert routines fail gracefully (file
// stays on disk for retry).
async function resolveLateInsertEntryId(
  routineId: string,
  competitionId: string,
): Promise<string> {
  const routine = state.getCompetition()?.routines.find((r) => r.id === routineId)
  if (!routine) throw new Error(`resolveLateInsertEntryId: routine ${routineId} not found`)
  if (!routine.lateInsert || !routine.id.startsWith('empty-')) return routine.id
  const { apiBase, apiKey } = getConnection()
  // Find the entry that was current immediately before this late-insert was
  // spliced in (the late-insert routine sits at fullList[<prior>+1]).
  const fullList = state.getCompetition()?.routines ?? []
  const idx = fullList.findIndex((r) => r.id === routineId)
  const afterRoutine = idx > 0 ? fullList[idx - 1] : null
  // Synthetic id is everything after the `empty-` prefix; recordedAt comes
  // from recordingStartedAt if set, else parsed back from the synthetic id.
  const syntheticId = routine.id
  const recordedAt = routine.recordingStartedAt
    ?? routine.id.replace(/^empty-/, '').replace(/-/g, (m, i) => i === 10 ? 'T' : (i === 13 || i === 16 ? ':' : (i === 19 ? '.' : '-')))
  const payload = {
    competitionId,
    syntheticId,
    recordedAt,
    afterEntryId: afterRoutine?.id ?? null,
    afterEntryNumber: afterRoutine?.entryNumber ?? null,
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), API_TIMEOUT_MS)
  try {
    const response = await fetch(`${apiBase}/api/plugin/late-insert-resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: abort.signal,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`late-insert-resolve failed: ${response.status} ${text}`)
    }
    const body = (await response.json()) as { entryId?: string; entryNumber?: string }
    if (!body.entryId) throw new Error(`late-insert-resolve returned no entryId: ${JSON.stringify(body)}`)
    state.replaceLateInsertId(routineId, body.entryId, body.entryNumber)
    logger.upload.info(`Late-insert resolved: ${syntheticId} → ${body.entryId}${body.entryNumber ? ` (entry ${body.entryNumber})` : ''}`)
    return body.entryId
  } finally {
    clearTimeout(timer)
  }
}

async function getSignedUploadUrl(
  entryId: string,
  competitionId: string,
  type: 'videos' | 'photos',
  filename: string,
  contentType: string,
  uploadRunId: string,
): Promise<{ signedUrl: string; storagePath: string }> {
  // Late-insert resolution: if entryId is a synthetic `empty-*` id, mint
  // the real CompPortal uuid first, then proceed with the standard upload
  // flow against the resolved uuid.
  if (entryId.startsWith('empty-')) {
    entryId = await resolveLateInsertEntryId(entryId, competitionId)
  }
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

/**
 * Fire an incremental /plugin/complete with cumulative paths built from
 * all currently-done jobs + already-uploaded files in routine state.
 * Called mid-upload when settings.upload.incrementalPublish is true and
 * the per-routine threshold has been crossed.
 *
 * Safe to call multiple times per routine — CompPortal's endpoint upserts
 * on (media_package_id, storage_url). If upsert semantics aren't deployed
 * yet, DO NOT enable incrementalPublish — the destructive-replace will
 * wipe prior rows on every call.
 */
async function callPluginCompletePartial(routineId: string, uploadRunId: string): Promise<void> {
  const routine = state.getCompetition()?.routines.find(r => r.id === routineId)
  if (!routine) return

  const conn = getResolvedConnection()
  if (!conn) return

  const allJobs = jobQueue.getByRoutine(routineId).filter(j => j.type === 'upload' && j.status !== 'cancelled')
  const doneJobs = allJobs.filter(j => j.status === 'done')

  const storagePaths: Record<string, string> = {}
  const photoStoragePaths: string[] = []
  const photoThumbnailStoragePaths: string[] = []
  const photoCapturedAt: string[] = []
  const videoKeyframeStoragePaths: string[] = []

  for (const f of routine.encodedFiles || []) {
    if (f.uploaded && f.storagePath) storagePaths[f.role] = f.storagePath
  }
  for (const p of routine.photos || []) {
    if (p.uploaded && p.storagePath) {
      photoStoragePaths.push(p.storagePath)
      photoThumbnailStoragePaths.push(p.thumbnailStoragePath || '')
      photoCapturedAt.push(p.captureTime || '')
    }
  }

  for (const doneJob of doneJobs) {
    const jp = doneJob.payload as unknown as UploadPayload
    const sp = (doneJob.payload as Record<string, unknown>).storagePath as string | undefined
    const tsp = (doneJob.payload as Record<string, unknown>).thumbStoragePath as string | undefined
    if (jp.isPhotoThumbRepair) {
      const sourcePhotoStoragePath = jp.sourcePhotoStoragePath
      if (sourcePhotoStoragePath && tsp) {
        const idx = photoStoragePaths.indexOf(sourcePhotoStoragePath)
        if (idx !== -1) photoThumbnailStoragePaths[idx] = tsp
      }
      continue
    }
    if (!sp) continue
    if (jp.isKeyframe && typeof jp.keyframeIndex === 'number') {
      while (videoKeyframeStoragePaths.length <= jp.keyframeIndex) videoKeyframeStoragePaths.push('')
      videoKeyframeStoragePaths[jp.keyframeIndex] = sp
    } else if (jp.type === 'photos') {
      if (!photoStoragePaths.includes(sp)) {
        photoStoragePaths.push(sp)
        photoThumbnailStoragePaths.push(tsp || '')
        // Fall back to payload captureTime when state lookup fails (see upload.ts:820 comment)
        const photo = routine.photos?.find(p => p.storagePath === sp || p.filePath === jp.filePath)
        photoCapturedAt.push(photo?.captureTime || jp.photoCaptureTime || '')
      }
    } else if (jp.role) {
      storagePaths[jp.role] = sp
    }
  }

  try {
    await callPluginComplete({
      routineId,
      entryId: routine.id,
      competitionId: conn.competitionId,
      uploadRunId,
      storagePaths,
      photoStoragePaths,
      photoThumbnailStoragePaths,
      photoCapturedAt,
      videoKeyframeStoragePaths,
    })
    publishedPhotoCountByRoutine.set(routineId, photoStoragePaths.length)
    logger.upload.info(`Incremental publish: routine ${routineId.slice(0,8)} now at ${photoStoragePaths.length} photos`)
  } catch (err) {
    logger.upload.warn(`Incremental publish failed for ${routineId.slice(0,8)} (non-fatal, terminal will retry):`, err instanceof Error ? err.message : err)
  }
}

async function callPluginComplete(info: {
  routineId: string
  entryId: string
  competitionId: string
  uploadRunId: string
  storagePaths: Record<string, string>
  photoStoragePaths: string[]
  photoThumbnailStoragePaths?: string[] // parallel array, indexed same as photoStoragePaths
  photoCapturedAt?: string[] // parallel array of ISO EXIF DateTimeOriginal per photo
  videoKeyframeStoragePaths?: string[] // 3-element array of R2 keys for keyframes 0,1,2
}): Promise<void> {
  const { apiBase, apiKey } = getConnection()

  const routine = state.getCompetition()?.routines.find(r => r.id === info.routineId)

  // CompPortal-3 contract (2026-04-17): `files.photo_thumbnails` is a parallel array
  // to `files.photos`, indexed identically. `files.photo_thumbnails[i]` is the R2
  // storage key for the thumbnail of `files.photos[i]`. Empty string or missing
  // array entry means "no thumb for this photo — CompPortal should fall back to
  // serving the original". Shape chosen to minimize diff from existing payload.
  //
  // 2026-04-18: `files.photo_captured_at` added as a second parallel array carrying
  // EXIF DateTimeOriginal (ISO) per photo. CompPortal persists as
  // `media_photos[i].captured_at`. Empty string means no EXIF timestamp available.
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
      photo_thumbnails:
        info.photoThumbnailStoragePaths && info.photoThumbnailStoragePaths.length > 0
          ? info.photoThumbnailStoragePaths
          : undefined,
      photo_captured_at:
        info.photoCapturedAt && info.photoCapturedAt.length > 0
          ? info.photoCapturedAt
          : undefined,
      // CompPortal-gemini contract (2026-04-19): 3-element array of R2
      // storage keys for `keyframe_{0,1,2}.webp` at 20/50/80% of the
      // performance video. Consumed by CompPortal's spot-check validator
      // as reference anchors. Omit when empty/all-empty — backwards
      // compatible with older CompPortal builds (field ignored).
      video_keyframes:
        info.videoKeyframeStoragePaths && info.videoKeyframeStoragePaths.some(k => k)
          ? info.videoKeyframeStoragePaths
          : undefined,
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

    // Parse the response so we can surface the authoritative server-side
    // package status on the local routine immediately. Without this the
    // "Portal" pill stays frozen at 'none' from startup until the next
    // schedule refetch (which only runs on app restart).
    try {
      const body = (await response.clone().json().catch(() => null)) as
        | { packageId?: string; status?: string }
        | null
      const returned = body?.status
      const valid = new Set(['none', 'pending', 'processing', 'ready', 'complete', 'published'])
      if (returned && valid.has(returned)) {
        state.setRoutineMediaPackageStatus(
          info.routineId,
          returned as NonNullable<Routine['mediaPackageStatus']>,
        )
        // Ensure the renderer's Routine row updates its Portal pill
        // without waiting for another broadcast.
        const fresh = state.getCompetition()?.routines.find(r => r.id === info.routineId)
        if (fresh) broadcastRoutineUpdate(fresh)
      }
    } catch {
      // Non-fatal — display lag is the only consequence.
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
      const photoThumbnailStoragePaths: string[] = []
      const photoCapturedAt: string[] = []
      const videoKeyframeStoragePaths: string[] = []
      for (const job of activeJobs) {
        const jp = job.payload as unknown as UploadPayload
        const sp = (job.payload as Record<string, unknown>).storagePath as string | undefined
        const tsp = (job.payload as Record<string, unknown>).thumbStoragePath as string | undefined
        if (jp.isPhotoThumbRepair) {
          const sourcePhotoStoragePath = jp.sourcePhotoStoragePath
          if (sourcePhotoStoragePath && tsp) {
            const idx = photoStoragePaths.indexOf(sourcePhotoStoragePath)
            if (idx !== -1) {
              photoThumbnailStoragePaths[idx] = tsp
            }
          }
          continue
        }
        if (!sp) continue
        if (jp.isKeyframe && typeof jp.keyframeIndex === 'number') {
          while (videoKeyframeStoragePaths.length <= jp.keyframeIndex) {
            videoKeyframeStoragePaths.push('')
          }
          videoKeyframeStoragePaths[jp.keyframeIndex] = sp
        } else if (jp.type === 'photos') {
          photoStoragePaths.push(sp)
          photoThumbnailStoragePaths.push(tsp || '')
          // Fall back to payload captureTime when state lookup fails (see upload.ts:820 comment)
          const photo = routine.photos?.find(
            (p) => p.storagePath === sp || p.filePath === jp.filePath,
          )
          photoCapturedAt.push(photo?.captureTime || jp.photoCaptureTime || '')
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
        photoThumbnailStoragePaths,
        photoCapturedAt,
        videoKeyframeStoragePaths,
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

// ─────────────────────────────────────────────────────────────────────────
// Recovery-resume cluster (T-V7-20 / T-V7-22)
// ─────────────────────────────────────────────────────────────────────────
//
// Rationale: compsync-state.json's `photo.uploaded` flag is an in-memory
// first-write surface; a crash or hard restart can lose unflushed updates.
// The 2026-04-19 UDC London post-restart stall re-uploaded ~1,000 photos
// that were already in R2+DB because the recovery path trusted the local
// `uploaded:false` flag without DB verification. The helpers below always
// cross-check against CompPortal before enqueueing so recovery is safe to
// re-run and cannot double-upload.
//
// Contract assumption (endpoint is CompPortal side, T-V7-24):
//   GET /api/plugin/list-photos?competitionId=X&entryIds=id1,id2,...
//   → { [entryId]: { filenames: string[] } }
// When the endpoint is unavailable, we FALL BACK to the pre-T-V7-20
// behavior: enqueue everything state says is pending. That preserves the
// status quo and makes the cross-check a pure safety net.

export interface ResumeUnfinishedReport {
  routinesScanned: number
  photosRepaired: number
  photosQueued: number
  jobsQueued: number
  endpointAvailable: boolean
  error?: string
}

// Contract locked with CompPortal hybrid session (2026-04-20 09:28 EDT),
// widened 2026-04-20 11:05 EDT for T-V7-26 unified reconciler:
//   GET /api/plugin/list-photos?competitionId=X&entryIds=id1,id2,...
//   Auth: Bearer plugin key (same as /api/plugin/complete)
//   200:  { ok: true, results: { [entryId]: {
//           filenames: string[],                                         // v1 field — kept
//           photos?: { filename: string, thumbnail_present: boolean }[], // v2
//           videos?: { role: 'performance'|'judge1'|'judge2'|'judge3'|'judge4', present: boolean }[],
//           video_keyframes?: { index: 0|1|2, present: boolean }[],
//         } } }
//   400:  > 100 entryIds
//   401:  bad auth
//   500:  server error
// Any non-200 → degrade to state-only enqueue.
// If the v2 fields (photos/videos/video_keyframes) are absent, the reconciler
// falls back to photo-only behavior (v1 shape) — see mediaReconciler.ts.
interface RemoteVideoEntry {
  role: 'performance' | 'judge1' | 'judge2' | 'judge3' | 'judge4'
  present: boolean
}
interface RemoteKeyframeEntry {
  index: 0 | 1 | 2
  present: boolean
}
interface RemotePhotoEntry {
  filename: string
  thumbnail_present: boolean
  storage_url?: string | null
  thumbnail_url?: string | null
}
export interface RemoteRoutineInventory {
  filenames: Set<string>                    // v1 photo names (always present when endpoint available)
  photos?: Map<string, RemotePhotoEntry>    // v2 per-photo record keyed by filename
  videos?: Map<string, RemoteVideoEntry>    // v2 keyed by role
  keyframes?: Map<number, RemoteKeyframeEntry> // v2 keyed by index 0..2
}

interface FilenameListResponse {
  ok?: boolean
  results?: { [entryId: string]: {
    filenames?: string[]
    photos?: RemotePhotoEntry[]
    videos?: RemoteVideoEntry[]
    video_keyframes?: RemoteKeyframeEntry[]
  } | undefined }
}

/**
 * Widened reconciler fetch. Returns the full per-routine inventory parsed
 * into maps the reconciler can diff. `endpointAvailable=false` when any
 * non-200 or network error — caller must fall back to state-only behavior.
 *
 * Back-compat: if the server returns the v1 shape (no photos/videos/video_keyframes),
 * the maps on the result entry are undefined and the reconciler skips those
 * axes. `filenames` is always populated when the endpoint answers.
 */
export async function fetchMediaInventory(
  entryIds: string[],
): Promise<{ map: Record<string, RemoteRoutineInventory>; endpointAvailable: boolean }> {
  const out: Record<string, RemoteRoutineInventory> = {}
  if (entryIds.length === 0) return { map: out, endpointAvailable: true }

  const conn = getResolvedConnection()
  if (!conn) return { map: out, endpointAvailable: false }

  const BATCH = 100
  let endpointAvailable = true
  for (let i = 0; i < entryIds.length; i += BATCH) {
    const batch = entryIds.slice(i, i + BATCH)
    const url = `${conn.apiBase}/api/plugin/list-photos?competitionId=${encodeURIComponent(conn.competitionId)}&entryIds=${batch.map(encodeURIComponent).join(',')}`
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), API_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${conn.apiKey}` },
        signal: abort.signal,
      })
      if (response.status === 404 || response.status === 405) {
        logger.upload.warn(`list-photos endpoint unavailable (HTTP ${response.status}) — reconciler degrades to state-only`)
        endpointAvailable = false
        break
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        logger.upload.warn(`list-photos batch ${i / BATCH}: HTTP ${response.status} ${text.slice(0, 120)} — treating endpoint as unavailable`)
        endpointAvailable = false
        break
      }
      const body = (await response.json()) as FilenameListResponse
      const results = body.results ?? {}
      for (const id of batch) {
        const entry = results[id]
        if (!entry) { out[id] = { filenames: new Set<string>() }; continue }
        const inv: RemoteRoutineInventory = {
          filenames: new Set(entry.filenames ?? []),
        }
        if (Array.isArray(entry.photos)) {
          inv.photos = new Map(entry.photos.map((p) => [p.filename, p]))
        }
        if (Array.isArray(entry.videos)) {
          inv.videos = new Map(entry.videos.map((v) => [v.role, v]))
        }
        if (Array.isArray(entry.video_keyframes)) {
          inv.keyframes = new Map(entry.video_keyframes.map((k) => [k.index, k]))
        }
        out[id] = inv
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.upload.warn(`list-photos fetch failed: ${msg} — reconciler degrades to state-only`)
      endpointAvailable = false
      break
    } finally {
      clearTimeout(timer)
    }
  }

  return { map: out, endpointAvailable }
}

/**
 * Back-compat shim. Callers (driveMonitor, resumeUnfinishedUploads) only need
 * the filename set — this flattens fetchMediaInventory back to the original
 * v1 shape. Do NOT add new callers; use fetchMediaInventory for richer diffs.
 */
export async function fetchExistingFilenames(
  entryIds: string[],
): Promise<{ map: Record<string, Set<string>>; endpointAvailable: boolean }> {
  const { map, endpointAvailable } = await fetchMediaInventory(entryIds)
  const out: Record<string, Set<string>> = {}
  for (const [k, v] of Object.entries(map)) {
    out[k] = v.filenames
  }
  return { map: out, endpointAvailable }
}

/**
 * Core resume path. Used by both autoResumeUnfinished (boot path) and the
 * manual "Resume Unfinished Uploads" button (T-V7-22). Idempotent: re-runs
 * never double-enqueue because enqueueRoutine de-dupes by objectName against
 * the existing job queue.
 *
 * Scans ALL routines (ignores routine.status — T-V7-22 requirement) for any
 * with pending photos or encodedFiles. For each, DB cross-check and:
 *   - photos present in DB → flip uploaded=true locally (heal stale flag)
 *   - photos missing from DB → enqueue
 *   - endpoint unavailable → fall back to state-based enqueue (degrade gracefully)
 */
export async function resumeUnfinishedUploads(): Promise<ResumeUnfinishedReport> {
  const comp = state.getCompetition()
  if (!comp) {
    return { routinesScanned: 0, photosRepaired: 0, photosQueued: 0, jobsQueued: 0, endpointAvailable: false, error: 'no-competition' }
  }
  if (!hasResolvedUploadConnection()) {
    return { routinesScanned: 0, photosRepaired: 0, photosQueued: 0, jobsQueued: 0, endpointAvailable: false, error: 'no-connection' }
  }

  const unfinished: Routine[] = []
  for (const r of comp.routines) {
    const hasPendingPhotos = (r.photos || []).some((p) => !p.uploaded)
    const hasPendingVideos = (r.encodedFiles || []).some((f) => !f.uploaded)
    if (hasPendingPhotos || hasPendingVideos) unfinished.push(r)
  }
  if (unfinished.length === 0) {
    return { routinesScanned: 0, photosRepaired: 0, photosQueued: 0, jobsQueued: 0, endpointAvailable: true }
  }

  const { map: existingByEntry, endpointAvailable } = await fetchExistingFilenames(
    unfinished.map((r) => r.id),
  )

  let photosRepaired = 0
  let photosQueued = 0
  let jobsQueued = 0

  for (const routine of unfinished) {
    const remoteNames = existingByEntry[routine.id] ?? new Set<string>()
    const photos = routine.photos || []
    let routineTouched = false
    const healedPhotos: PhotoMatch[] = photos.map((p) => {
      if (p.uploaded) return p
      const basename = path.basename(p.filePath)
      if (endpointAvailable && remoteNames.has(basename)) {
        photosRepaired++
        routineTouched = true
        return { ...p, uploaded: true }
      }
      photosQueued++
      return p
    })
    if (routineTouched) {
      state.updateRoutineStatus(routine.id, routine.status, { photos: healedPhotos })
    }
    // Re-read after heal so enqueueRoutine sees the updated flags.
    const fresh = state.getCompetition()?.routines.find((r) => r.id === routine.id) ?? routine
    const result = enqueueRoutine(fresh)
    jobsQueued += result.queuedJobs
  }

  if (jobsQueued > 0) startUploads()

  logger.upload.info(
    `Resume unfinished: ${unfinished.length} routines scanned, ${photosRepaired} photos repaired (already in DB), ${photosQueued} photos pending, ${jobsQueued} jobs queued. Endpoint=${endpointAvailable ? 'available' : 'unavailable (state-only fallback)'}`,
  )

  return {
    routinesScanned: unfinished.length,
    photosRepaired,
    photosQueued,
    jobsQueued,
    endpointAvailable,
  }
}

/**
 * Boot-path entry. Gated by settings.upload.autoResumeOnBoot (default true).
 * Fire-and-forget: callers can ignore the returned promise.
 *
 * T-V7-26: now a thin wrapper around reconcileMedia({scope:'boot'}). The
 * reconciler subsumes the resumeUnfinishedUploads logic AND also reconciles
 * videos/thumbs/keyframes. ResumeUnfinishedReport shape preserved for any
 * external callers (log/telemetry consumers); values mapped from
 * ReconcileResult. Lazy-require to dodge circular import with mediaReconciler.
 */
export async function autoResumeUnfinished(): Promise<ResumeUnfinishedReport> {
  const settings = getSettings()
  if (settings.behavior.autoUploadAfterEncoding === false) {
    logger.upload.info('Auto-resume on boot skipped because auto-upload is disabled')
    return { routinesScanned: 0, photosRepaired: 0, photosQueued: 0, jobsQueued: 0, endpointAvailable: false, error: 'disabled' }
  }
  const enabled = settings.upload?.autoResumeOnBoot !== false
  if (!enabled) {
    logger.upload.info('Auto-resume on boot disabled via setting — skipping')
    return { routinesScanned: 0, photosRepaired: 0, photosQueued: 0, jobsQueued: 0, endpointAvailable: false, error: 'disabled' }
  }
  // Dynamic import (not require) so the bundler emits the chunk and the
  // asar resolver can find it at runtime. require('./mediaReconciler')
  // throws Cannot-find-module inside packaged asar (v15.5 boot regression).
  const reconciler = await import('./mediaReconciler')
  const r = await reconciler.reconcileMedia({ scope: 'boot' })
  return {
    routinesScanned: r.scanned,
    photosRepaired: r.repaired,
    photosQueued: 0,
    jobsQueued: r.queued,
    endpointAvailable: r.endpointAvailable,
    error: r.skippedReason,
  }
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
