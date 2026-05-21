import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import { JobRecord, JobType, JobStatus } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as events from './events'
import * as state from './state'

// --- State ---

let jobs: JobRecord[] = []
let queueFilePath = ''
let saveTimer: NodeJS.Timeout | null = null

// Fix 6: Map index for O(1) routine lookup
const routineIndex = new Map<string, JobRecord[]>()

function rebuildRoutineIndex(): void {
  routineIndex.clear()
  for (const job of jobs) {
    let arr = routineIndex.get(job.routineId)
    if (!arr) {
      arr = []
      routineIndex.set(job.routineId, arr)
    }
    arr.push(job)
  }
}

function indexAdd(job: JobRecord): void {
  let arr = routineIndex.get(job.routineId)
  if (!arr) {
    arr = []
    routineIndex.set(job.routineId, arr)
  }
  arr.push(job)
}

function indexRemove(job: JobRecord): void {
  const arr = routineIndex.get(job.routineId)
  if (!arr) return
  const idx = arr.indexOf(job)
  if (idx !== -1) arr.splice(idx, 1)
  if (arr.length === 0) routineIndex.delete(job.routineId)
}

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
  rebuildRoutineIndex()
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
  indexAdd(job)
  logger.app.info(`Job queue: enqueued ${type} job ${job.id} for routine ${routineId}`)
  if (type !== 'upload' || jobs.length % 100 === 0) {
    events.emit('queue.enqueued', {
      jobId: job.id,
      type,
      routineId,
      status: job.status,
      totalJobs: jobs.length,
    })
  }
  // T-V7-21: debounced save instead of flushSync. Bulk-enqueue bursts (SD
  // imports of 10k+ photos) used to hit the disk 10k+ times and thrash the
  // main thread. 500ms debounce coalesces the burst into a single write
  // while preserving crash-survival for the trailing edge. Critical
  // transitions (enqueue→running, running→done, running→failed) still
  // flushSync via updateStatus.
  save()
  return job
}

export function updateStatus(
  jobId: string,
  status: JobStatus,
  extra?: { error?: string; progress?: number; storagePath?: string; thumbStoragePath?: string; retryable?: boolean },
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
  if (extra?.storagePath !== undefined) {
    ;(job.payload as Record<string, unknown>).storagePath = extra.storagePath
  }
  if (extra?.thumbStoragePath !== undefined) {
    ;(job.payload as Record<string, unknown>).thumbStoragePath = extra.thumbStoragePath
  }

  // Failed but retryable — reset to pending
  if (status === 'failed' && extra?.retryable !== false && job.attempts < job.maxAttempts) {
    job.status = 'pending'
    logger.app.info(
      `Job queue: ${job.type} job ${jobId} failed (attempt ${job.attempts}/${job.maxAttempts}), will retry`,
    )
  }

  logger.app.info(`Job queue: job ${jobId} ${prev} → ${job.status}`)
  if (prev !== job.status || status === 'failed') {
    events.emit('queue.status', {
      jobId,
      type: job.type,
      routineId: job.routineId,
      from: prev,
      to: job.status,
      requestedStatus: status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      error: job.error || null,
    })
  }

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
  const eligible: JobRecord[] = []
  for (const job of jobs) {
    if (job.type !== type || job.status !== 'pending') continue

    // Backoff: if this job has failed before, wait before retrying
    if (job.attempts > 0) {
      const backoffMs = Math.min(5000 * Math.pow(2, job.attempts - 1), 60000)
      const lastUpdate = new Date(job.updatedAt).getTime()
      if (now - lastUpdate < backoffMs) continue
    }

    eligible.push(job)
  }
  if (eligible.length === 0) return null
  if (type !== 'upload') return eligible[0]

  // ── Burlington UDC 2026-05-16 photo-tier rule — ORDER A ──
  // Operator-locked: each routine's photos split into a PRIORITY slice (the
  // first ~1/3, tagged payload.photoTier='priority' at enqueue) and a
  // REMAINING slice (the other ~2/3, photoTier='remaining').
  //
  // Order of preference (ORDER A — priority photos beat videos):
  //   1. PRIORITY photos — beat EVERYTHING, including video uploads. A MISSING
  //      photoTier is treated as 'priority' so legacy / in-flight jobs never
  //      deadlock. Round-robin newest-routine-first within the slice.
  //   2. Pending VIDEO uploads — newest entry_number first.
  //   3. REMAINING photos — still gated behind video work: released ONLY when
  //      no video work is outstanding (zero pending+running 'encode' AND zero
  //      pending 'videos'-type 'upload'). Otherwise withheld; getNext may
  //      return null and the caller (processLoop) re-checks once video work
  //      drains.
  //   4. Other (keyframes, thumb-repairs) — FIFO via eligible[0] fallback.
  //
  // Rationale: the priority slice is the operator-facing "first looks" set;
  // it must reach the portal ahead of full-length video encodes. The bulk
  // remaining slice still lags behind video work so newly-encoded videos are
  // not starved by ~344-per-SD-card photo backlogs.
  const comp = state.getCompetition()
  const entryByRoutineId = new Map<string, number>()
  if (comp) {
    for (const r of comp.routines) {
      const en = parseInt(r.entryNumber, 10)
      entryByRoutineId.set(r.id, Number.isFinite(en) ? en : 0)
    }
  }

  const priority = getSettings().upload?.photoPriority ?? 'newest-first'

  // Count done+running photo uploads per routine from the FULL job list
  // (not just eligible) — served count reflects actual progress. Shared by
  // both photo tiers so round-robin fairness spans the priority→remaining
  // handoff (a routine fully served in tier 1 stays fairly ordered in tier 3).
  let servedByRoutine: Map<string, number> | null = null
  const ensureServedByRoutine = (): Map<string, number> => {
    if (servedByRoutine) return servedByRoutine
    const m = new Map<string, number>()
    for (const j of jobs) {
      if (j.type !== 'upload') continue
      if (j.status !== 'done' && j.status !== 'running') continue
      const p = j.payload as Record<string, unknown>
      if (p.type !== 'photos' || p.isPhotoThumbRepair === true) continue
      const rid = p.routineId as string
      m.set(rid, (m.get(rid) ?? 0) + 1)
    }
    servedByRoutine = m
    return m
  }

  // Existing least-served-routine-first round-robin sort, unchanged math —
  // applied per tier. entryByRoutineId reuses the map built above.
  const pickRoundRobin = (candidates: JobRecord[]): JobRecord => {
    const served = ensureServedByRoutine()
    candidates.sort((a, b) => {
      const aRid = (a.payload as Record<string, unknown>).routineId as string
      const bRid = (b.payload as Record<string, unknown>).routineId as string
      const aServed = served.get(aRid) ?? 0
      const bServed = served.get(bRid) ?? 0
      if (aServed !== bServed) return aServed - bServed
      const aEn = entryByRoutineId.get(aRid) ?? 0
      const bEn = entryByRoutineId.get(bRid) ?? 0
      if (aEn !== bEn) return bEn - aEn
      return priority === 'oldest-first'
        ? getPhotoPriorityTs(a) - getPhotoPriorityTs(b)
        : getPhotoPriorityTs(b) - getPhotoPriorityTs(a)
    })
    return candidates[0]
  }

  const realPhotoJobs = eligible.filter((job) => {
    const payload = job.payload as Record<string, unknown>
    return payload.type === 'photos' && payload.isPhotoThumbRepair !== true
  })

  // Tier 1 — PRIORITY photos (photoTier !== 'remaining'; missing => priority).
  // ORDER A: these beat video uploads.
  const priorityPhotoJobs = realPhotoJobs.filter((job) => {
    const tier = (job.payload as Record<string, unknown>).photoTier
    return tier !== 'remaining'
  })
  if (priorityPhotoJobs.length > 0) {
    return pickRoundRobin(priorityPhotoJobs)
  }

  // Tier 2 — VIDEO uploads. Newest entry_number first.
  const videoJobs = eligible.filter((job) => {
    const payload = job.payload as Record<string, unknown>
    return payload.type === 'videos'
  })
  if (videoJobs.length > 0) {
    videoJobs.sort((a, b) => {
      const aRid = (a.payload as Record<string, unknown>).routineId as string
      const bRid = (b.payload as Record<string, unknown>).routineId as string
      const aEn = entryByRoutineId.get(aRid) ?? 0
      const bEn = entryByRoutineId.get(bRid) ?? 0
      return bEn - aEn // newest entry_number first
    })
    return videoJobs[0]
  }

  // Tier 3 — REMAINING photos. Still gated on video work being fully drained
  // (unchanged from order B — only the priority/video order swapped).
  const remainingPhotoJobs = realPhotoJobs.filter((job) => {
    return (job.payload as Record<string, unknown>).photoTier === 'remaining'
  })
  if (remainingPhotoJobs.length > 0 && !hasOutstandingVideoWork()) {
    return pickRoundRobin(remainingPhotoJobs)
  }

  // Either no photos at all, or remaining photos are withheld behind video
  // work. Fall through: a non-photo eligible job (keyframe/thumb-repair) may
  // still run; if none, return null and let processLoop re-check later.
  const nonPhotoEligible = eligible.filter((job) => {
    const payload = job.payload as Record<string, unknown>
    return !(payload.type === 'photos' && payload.isPhotoThumbRepair !== true)
  })
  if (nonPhotoEligible.length > 0) return nonPhotoEligible[0]
  return null
}

/**
 * True while any video work is still outstanding — i.e. there is at least one
 * pending OR running 'encode' job, OR at least one pending 'videos'-type
 * 'upload' job. While this is true, REMAINING-tier photos (the ~2/3 slice)
 * are withheld by getNext('upload') so the priority slice + all video work
 * win. Exported so the upload loop can decide whether withheld remaining
 * photos can ever progress yet (deadlock-avoidance re-check), and so the
 * proof harness can assert against the real gate (primary source, not a
 * re-implementation).
 */
export function hasOutstandingVideoWork(): boolean {
  for (const j of jobs) {
    if (j.type === 'encode' && (j.status === 'pending' || j.status === 'running')) {
      return true
    }
    if (j.type === 'upload' && j.status === 'pending') {
      const p = j.payload as Record<string, unknown>
      if (p.type === 'videos') return true
    }
  }
  return false
}

/**
 * True when there is at least one pending REMAINING-tier photo upload job.
 * Used by processLoop to distinguish "queue genuinely empty" (exit) from
 * "only remaining photos left, withheld behind video work" (sleep + re-check)
 * so the loop never busy-spins and never permanently strands the ~2/3 slice.
 */
export function hasPendingRemainingPhotos(): boolean {
  const now = Date.now()
  for (const j of jobs) {
    if (j.type !== 'upload' || j.status !== 'pending') continue
    const p = j.payload as Record<string, unknown>
    if (p.type !== 'photos' || p.isPhotoThumbRepair === true) continue
    if (p.photoTier !== 'remaining') continue
    // Mirror getNext's backoff filter so a job stuck in backoff doesn't make
    // this report "work pending" forever (it can't be selected yet anyway,
    // but it WILL become selectable — so it still warrants a re-check, just
    // not a tight one; processLoop's fixed sleep covers that cadence).
    if (j.attempts > 0) {
      const backoffMs = Math.min(5000 * Math.pow(2, j.attempts - 1), 60000)
      const lastUpdate = new Date(j.updatedAt).getTime()
      if (now - lastUpdate < backoffMs) {
        // still counts as pending remaining work that will need a re-check
        return true
      }
    }
    return true
  }
  return false
}

function getPhotoPriorityTs(job: JobRecord): number {
  const payload = job.payload as Record<string, unknown>
  const captureTime = typeof payload.photoCaptureTime === 'string' ? payload.photoCaptureTime : ''
  const captureTs = Date.parse(captureTime)
  if (Number.isFinite(captureTs)) return captureTs

  const createdTs = Date.parse(job.createdAt)
  if (Number.isFinite(createdTs)) return createdTs

  const updatedTs = Date.parse(job.updatedAt)
  return Number.isFinite(updatedTs) ? updatedTs : 0
}

export function getByRoutine(routineId: string): JobRecord[] {
  return routineIndex.get(routineId) || []
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
    rebuildRoutineIndex()
    logger.app.info(`Job queue: pruned ${pruned} completed jobs`)
    save()
  }
  return pruned
}

export function quarantine(jobId: string, error: string): boolean {
  const job = jobs.find(j => j.id === jobId)
  if (!job) return false
  const prev = job.status
  job.status = 'quarantined'
  job.error = error
  job.updatedAt = new Date().toISOString()
  logger.app.warn(`Job queue: quarantined ${job.type} job ${jobId} (${prev} → quarantined): ${error}`)
  flushSync()
  return true
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
  indexRemove(job)
  logger.app.info(`Job queue: removed ${job.type} job ${jobId}`)
  save()
  return true
}

/** Remove jobs whose routineId is not present in the current competition. */
export function pruneMissingRoutines(validRoutineIds: Set<string>, type?: JobType): number {
  const before = jobs.length
  jobs = jobs.filter((job) => {
    if (type && job.type !== type) return true
    // A35: scratch-notify jobs survive routine prune — they reference work
    // that still needs to flush to CompPortal even if the routine isn't in
    // the current loaded competition (e.g., switched competitions).
    if (job.type === 'scratch-notify') return true
    return validRoutineIds.has(job.routineId)
  })
  const pruned = before - jobs.length
  if (pruned > 0) {
    rebuildRoutineIndex()
    logger.app.warn(`Job queue: pruned ${pruned} orphaned ${type ?? 'all'} job(s) for missing routines`)
    flushSync()
  }
  return pruned
}

/**
 * Remove jobs that do not belong to the currently loaded competition.
 * Upload jobs are additionally scoped by payload.competitionId so stale
 * persisted work from another competition cannot run after a schedule switch.
 */
export function pruneForCompetition(competitionId: string, validRoutineIds: Set<string>): number {
  const before = jobs.length
  jobs = jobs.filter((job) => {
    // A35: scratch-notify jobs survive competition switch — backstop for
    // the case where the operator switches comps before a scratch flushed.
    if (job.type === 'scratch-notify') return true
    if (!validRoutineIds.has(job.routineId)) return false
    if (job.type !== 'upload') return true

    const payloadCompetitionId = (job.payload as Record<string, unknown>).competitionId
    if (typeof payloadCompetitionId !== 'string' || payloadCompetitionId.length === 0) {
      return true
    }
    return payloadCompetitionId === competitionId
  })

  const pruned = before - jobs.length
  if (pruned > 0) {
    rebuildRoutineIndex()
    logger.app.warn(
      `Job queue: pruned ${pruned} stale job(s) not belonging to competition ${competitionId}`,
    )
    flushSync()
  }
  return pruned
}

/** Reset a failed job for manual retry. */
export function retry(jobId: string): boolean {
  const job = jobs.find(j => j.id === jobId)
  if (!job || (job.status !== 'failed' && job.status !== 'quarantined')) return false
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

export function getQuarantined(type?: JobType): JobRecord[] {
  return jobs.filter(j => j.status === 'quarantined' && (!type || j.type === type))
}

export function getAll(): JobRecord[] {
  return [...jobs]
}

// --- Init ---

const PRUNE_INTERVAL_MS = 3600000 // 1 hour
const PRUNE_AGE_MS = 86400000 // 24 hours
let pruneTimer: NodeJS.Timeout | null = null

export function init(): void {
  load()
  // Prune completed jobs older than 24h on startup
  pruneCompleted(PRUNE_AGE_MS)
  // Prune periodically every hour
  pruneTimer = setInterval(() => pruneCompleted(PRUNE_AGE_MS), PRUNE_INTERVAL_MS)
}

export function cleanup(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (pruneTimer) {
    clearInterval(pruneTimer)
    pruneTimer = null
  }
  flushSync()
}
