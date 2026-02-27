import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import { JobRecord, JobType, JobStatus } from '../../shared/types'
import { logger } from '../logger'

// --- State ---

let jobs: JobRecord[] = []
let queueFilePath = ''
let saveTimer: NodeJS.Timeout | null = null

// --- Persistence ---

function getQueuePath(): string {
  if (!queueFilePath) {
    queueFilePath = path.join(app.getPath('userData'), 'job-queue.json')
  }
  return queueFilePath
}

function load(): void {
  const filePath = getQueuePath()
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        jobs = parsed
        // Reset any 'running' jobs to 'pending' — they were interrupted
        let resetCount = 0
        for (const job of jobs) {
          if (job.status === 'running') {
            job.status = 'pending'
            job.updatedAt = new Date().toISOString()
            resetCount++
          }
        }
        if (resetCount > 0) {
          logger.app.info(`Job queue: reset ${resetCount} interrupted jobs to pending`)
          flushSync()
        }
        logger.app.info(`Job queue: loaded ${jobs.length} jobs from disk`)
      }
    }
  } catch (err) {
    logger.app.error('Job queue: failed to load from disk, starting fresh', err)
    jobs = []
  }
}

/** Debounced save — 500ms. Use flushSync() for critical transitions. */
function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    doSave()
  }, 500)
}

function doSave(): void {
  try {
    const filePath = getQueuePath()
    const data = JSON.stringify(jobs, null, 2)
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, data, 'utf-8')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    logger.app.error('Job queue: failed to save to disk', err)
  }
}

/** Synchronous flush for critical moments (crash, shutdown). */
export function flushSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  doSave()
}

// --- Core Operations ---

export function enqueue(
  type: JobType,
  routineId: string,
  payload: Record<string, unknown>,
  maxAttempts = 3,
): JobRecord {
  const now = new Date().toISOString()
  const job: JobRecord = {
    id: crypto.randomUUID(),
    type,
    routineId,
    status: 'pending',
    attempts: 0,
    maxAttempts,
    payload,
    createdAt: now,
    updatedAt: now,
  }
  jobs.push(job)
  logger.app.info(`Job queue: enqueued ${type} job ${job.id} for routine ${routineId}`)
  save()
  return job
}

export function updateStatus(
  jobId: string,
  status: JobStatus,
  extra?: { error?: string; progress?: number },
): void {
  const job = jobs.find(j => j.id === jobId)
  if (!job) {
    logger.app.warn(`Job queue: job ${jobId} not found for status update`)
    return
  }

  const prev = job.status
  job.status = status
  job.updatedAt = new Date().toISOString()

  if (status === 'running') {
    job.attempts++
  }

  if (extra?.error !== undefined) {
    job.error = extra.error
  }
  if (extra?.progress !== undefined) {
    job.progress = extra.progress
  }

  // Failed but retryable — reset to pending
  if (status === 'failed' && job.attempts < job.maxAttempts) {
    job.status = 'pending'
    logger.app.info(
      `Job queue: ${job.type} job ${jobId} failed (attempt ${job.attempts}/${job.maxAttempts}), will retry`,
    )
  }

  logger.app.info(`Job queue: job ${jobId} ${prev} → ${job.status}`)

  // Immediate flush for status transitions (running→done, running→failed)
  if (prev === 'running' || status === 'done' || status === 'failed') {
    flushSync()
  } else {
    save()
  }
}

/** Get the next pending job of a given type, respecting backoff. */
export function getNext(type: JobType): JobRecord | null {
  const now = Date.now()
  for (const job of jobs) {
    if (job.type !== type || job.status !== 'pending') continue

    // Backoff: if this job has failed before, wait before retrying
    if (job.attempts > 0) {
      const backoffMs = Math.min(5000 * Math.pow(2, job.attempts - 1), 60000)
      const lastUpdate = new Date(job.updatedAt).getTime()
      if (now - lastUpdate < backoffMs) continue
    }

    return job
  }
  return null
}

export function getByRoutine(routineId: string): JobRecord[] {
  return jobs.filter(j => j.routineId === routineId)
}

/** Remove completed jobs older than the given age. */
export function pruneCompleted(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs
  const before = jobs.length
  jobs = jobs.filter(j => {
    if (j.status !== 'done') return true
    return new Date(j.updatedAt).getTime() > cutoff
  })
  const pruned = before - jobs.length
  if (pruned > 0) {
    logger.app.info(`Job queue: pruned ${pruned} completed jobs`)
    save()
  }
  return pruned
}

/** Remove a specific job (cancel). Only pending/failed jobs can be removed. */
export function remove(jobId: string): boolean {
  const idx = jobs.findIndex(j => j.id === jobId)
  if (idx === -1) return false
  const job = jobs[idx]
  if (job.status === 'running') {
    logger.app.warn(`Job queue: cannot remove running job ${jobId}`)
    return false
  }
  jobs.splice(idx, 1)
  logger.app.info(`Job queue: removed ${job.type} job ${jobId}`)
  save()
  return true
}

/** Reset a failed job for manual retry. */
export function retry(jobId: string): boolean {
  const job = jobs.find(j => j.id === jobId)
  if (!job || job.status !== 'failed') return false
  job.status = 'pending'
  job.attempts = 0
  job.error = undefined
  job.progress = undefined
  job.updatedAt = new Date().toISOString()
  logger.app.info(`Job queue: manually retrying job ${jobId}`)
  flushSync()
  return true
}

// --- Query ---

export function getPending(type?: JobType): JobRecord[] {
  return jobs.filter(j => j.status === 'pending' && (!type || j.type === type))
}

export function getRunning(type?: JobType): JobRecord[] {
  return jobs.filter(j => j.status === 'running' && (!type || j.type === type))
}

export function getFailed(type?: JobType): JobRecord[] {
  return jobs.filter(j => j.status === 'failed' && (!type || j.type === type))
}

export function getAll(): JobRecord[] {
  return [...jobs]
}

// --- Init ---

export function init(): void {
  load()
}

export function cleanup(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  flushSync()
}
