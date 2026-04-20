/**
 * T-V7-26 — Unified media reconciler.
 *
 * Single engine every sync-to-DB path routes through. Boot, manual button,
 * SD plug-in, post-record, tether-error, and the ambient setInterval all
 * call reconcileMedia({scope:...}). The engine:
 *   1. Fetches server inventory for the target routines (≤100 per batch).
 *   2. Diffs local state against DB for photos / videos / thumbs / keyframes.
 *   3. Heals stale `uploaded:false` flags for items already in DB.
 *   4. Enqueues only truly-missing items.
 *   5. Calls retryOrphanedCompletions() at the end to catch lost plugin/complete.
 *   6. Starts uploads if anything queued.
 *
 * Gates (skip cycle if any true):
 *   - No resolved upload connection
 *   - Active SD import in progress
 *   - Active ffmpeg encoding queue
 *   - Routine on exponential backoff (nextAttemptAt > now)
 *
 * Graceful degrade: if the server returns the v1 shape (filenames only),
 * the reconciler runs photo-only reconcile and skips videos/thumbs/keyframes.
 * If the endpoint is entirely unavailable (404/5xx/network), the reconciler
 * returns early with a warning — no state mutation, no enqueue.
 */

import fs from 'fs'
import path from 'path'
import { IPC_CHANNELS, Routine, PhotoMatch, EncodedFile } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import * as state from './state'
import * as uploadService from './upload'
import * as photoService from './photos'
import * as ffmpegService from './ffmpeg'
import { getSettings } from './settings'
import type { RemoteRoutineInventory } from './upload'

export interface ReconcileResult {
  scanned: number
  repaired: number
  queued: number
  errors: string[]
  scope: string
  tookMs: number
  endpointAvailable: boolean
  skippedReason?: string
}

export interface ReconcileOpts {
  scope: 'boot' | 'manual' | 'sd-plugin' | 'post-record' | 'ambient' | 'tether-error'
  routineIds?: string[]
  silent?: boolean
}

interface BackoffEntry {
  failCount: number
  nextAttemptAt: number
}
const backoffByRoutine = new Map<string, BackoffEntry>()

const BACKOFF_BASE_MS = 15 * 60 * 1000 // 15 min
const BACKOFF_CAP_MS = 24 * 60 * 60 * 1000 // 24 h

function nowMs(): number { return Date.now() }

function onRoutineFailure(routineId: string): void {
  const prev = backoffByRoutine.get(routineId)
  const failCount = (prev?.failCount ?? 0) + 1
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, failCount), BACKOFF_CAP_MS)
  backoffByRoutine.set(routineId, { failCount, nextAttemptAt: nowMs() + delay })
}

function onRoutineSuccess(routineId: string): void {
  backoffByRoutine.delete(routineId)
}

function isOnBackoff(routineId: string): boolean {
  const b = backoffByRoutine.get(routineId)
  return b != null && b.nextAttemptAt > nowMs()
}

/**
 * Pick the candidate routines for this scope. Default: all routines that
 * have any potentially-unfinished media (pending photos, pending videos,
 * missing keyframes, status looks uploaded but photos are stale).
 */
function selectCandidates(routineIds?: string[]): Routine[] {
  const comp = state.getCompetition()
  if (!comp) return []
  const all = comp.routines
  const subset = routineIds && routineIds.length > 0
    ? all.filter((r) => routineIds.includes(r.id))
    : all

  const out: Routine[] = []
  for (const r of subset) {
    const pendingPhotos = (r.photos || []).some((p) => !p.uploaded)
    const pendingVideos = (r.encodedFiles || []).some((f) => !f.uploaded)
    const hasVideos = (r.encodedFiles || []).length > 0
    const keyframesIncomplete = hasVideos && (r.keyframes || []).filter(Boolean).length < 3
    if (pendingPhotos || pendingVideos || keyframesIncomplete) {
      out.push(r)
    } else if (routineIds && routineIds.length > 0) {
      // Explicit target: include even if nothing obvious pending — the
      // DB might still say something's missing, and the caller asked for it.
      out.push(r)
    }
  }
  return out
}

/**
 * Heal + enqueue one routine against its remote inventory. Returns the
 * per-routine deltas so the engine can tally totals. Caller owns whether to
 * actually enqueue — this function mutates state and the job queue directly
 * (via state.updateRoutineStatus + uploadService.enqueueRoutine).
 */
function reconcileOne(
  routine: Routine,
  inv: RemoteRoutineInventory | undefined,
): { repaired: number; queued: number; error?: string } {
  let repaired = 0

  // ── Photo reconcile ──
  const remoteFilenames = inv?.filenames ?? new Set<string>()
  const localPhotos = routine.photos || []
  let photosTouched = false
  const healedPhotos: PhotoMatch[] = localPhotos.map((p) => {
    if (p.uploaded) return p
    const basename = path.basename(p.filePath)
    if (remoteFilenames.has(basename)) {
      repaired++
      photosTouched = true
      return { ...p, uploaded: true }
    }
    return p
  })

  // ── Video reconcile (v2 field) ──
  const localVideos = routine.encodedFiles || []
  let videosTouched = false
  let healedVideos: EncodedFile[] = localVideos
  if (inv?.videos) {
    healedVideos = localVideos.map((v) => {
      if (v.uploaded) return v
      const remote = inv.videos!.get(v.role)
      if (remote?.present) {
        repaired++
        videosTouched = true
        return { ...v, uploaded: true }
      }
      return v
    })
  }

  if (photosTouched || videosTouched) {
    const extra: Partial<Routine> = {}
    if (photosTouched) extra.photos = healedPhotos
    if (videosTouched) extra.encodedFiles = healedVideos
    state.updateRoutineStatus(routine.id, routine.status, extra)
  }

  // Re-read so enqueueRoutine sees the healed flags.
  const fresh = state.getCompetition()?.routines.find((r) => r.id === routine.id) ?? routine
  const enqResult = uploadService.enqueueRoutine(fresh)
  let queued = enqResult.queuedJobs

  // ── Thumbs (v2): for each local photo already uploaded but DB says thumb
  //    is missing, force-enqueue a thumb-only upload. Rare — the normal
  //    upload path PUTs the thumb as a sibling — but during recovery of
  //    old data where thumbs never made it, this plugs the gap.
  if (inv?.photos && localPhotos.length > 0) {
    // Build a set of basename→localPhoto for O(1) lookup.
    const byName = new Map<string, PhotoMatch>()
    for (const p of localPhotos) byName.set(path.basename(p.filePath), p)
    for (const [fname, remotePhoto] of inv.photos.entries()) {
      if (remotePhoto.thumbnail_present) continue
      const local = byName.get(fname)
      if (!local) continue
      if (!local.thumbnailPath) continue
      if (!fs.existsSync(local.thumbnailPath)) continue
      // Thumb regeneration is handled by the upload worker's ensurePhotoThumbnail
      // path (T-H17). For a thumb-only backfill we'd need a separate IPC path;
      // for now, log at info so the operator knows thumbs are lagging.
      // Future T-V7-27: add uploadService.enqueueThumbOnly(routineId, filename).
      logger.app.info(
        `Reconcile: R${routine.entryNumber} thumb missing in DB for ${fname} — flagged (no thumb-only enqueue yet)`,
      )
    }
  }

  // ── Keyframes (v2): if any of 3 keyframe slots missing AND local routine
  //    has a performance video + local keyframe files, re-enqueue. The existing
  //    enqueueRoutine already handles keyframes when routine.keyframes is set —
  //    so any keyframe gap is picked up by the call above. Log the gap for
  //    visibility.
  if (inv?.keyframes) {
    for (const [idx, remoteKf] of inv.keyframes.entries()) {
      if (remoteKf.present) continue
      const localPath = (routine.keyframes || [])[idx]
      if (!localPath) {
        logger.app.info(
          `Reconcile: R${routine.entryNumber} keyframe[${idx}] missing in DB AND locally — nothing to send`,
        )
      }
    }
  }

  if (queued > 0) onRoutineSuccess(routine.id)
  return { repaired, queued }
}

/**
 * Main entry point.
 */
export async function reconcileMedia(opts: ReconcileOpts): Promise<ReconcileResult> {
  const t0 = nowMs()
  const scope = opts.scope
  const silent = opts.silent ?? (scope === 'ambient' ? (getSettings().upload?.reconcileSilent ?? true) : false)

  const result: ReconcileResult = {
    scanned: 0,
    repaired: 0,
    queued: 0,
    errors: [],
    scope,
    tookMs: 0,
    endpointAvailable: true,
  }

  // ── Gates ──
  if (!uploadService.hasResolvedUploadConnection()) {
    result.skippedReason = 'no-upload-connection'
    result.tookMs = nowMs() - t0
    logger.app.info(`reconcileMedia[${scope}]: skipped (${result.skippedReason})`)
    return result
  }
  if (photoService.isImportRunning?.()) {
    result.skippedReason = 'sd-import-in-progress'
    result.tookMs = nowMs() - t0
    logger.app.info(`reconcileMedia[${scope}]: skipped (${result.skippedReason})`)
    return result
  }
  if (ffmpegService.getQueueLength?.() > 0) {
    result.skippedReason = 'ffmpeg-busy'
    result.tookMs = nowMs() - t0
    logger.app.info(`reconcileMedia[${scope}]: skipped (${result.skippedReason})`)
    return result
  }

  // ── Candidate routines ──
  const candidatesPreBackoff = selectCandidates(opts.routineIds)
  const candidates = candidatesPreBackoff.filter((r) => !isOnBackoff(r.id))
  const backoffSkipped = candidatesPreBackoff.length - candidates.length
  if (backoffSkipped > 0) {
    logger.app.info(
      `reconcileMedia[${scope}]: skipping ${backoffSkipped} routine(s) on exponential backoff`,
    )
  }
  result.scanned = candidates.length
  if (candidates.length === 0) {
    result.tookMs = nowMs() - t0
    logger.app.info(`reconcileMedia[${scope}]: scanned=0 repaired=0 queued=0 errors=0 in ${result.tookMs}ms`)
    return result
  }

  // ── Fetch remote inventory ──
  let invMap: Record<string, RemoteRoutineInventory> = {}
  let endpointAvailable = true
  try {
    const resp = await uploadService.fetchMediaInventory(candidates.map((r) => r.id))
    invMap = resp.map
    endpointAvailable = resp.endpointAvailable
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`fetchMediaInventory: ${msg}`)
    endpointAvailable = false
  }
  result.endpointAvailable = endpointAvailable

  if (!endpointAvailable) {
    // Graceful degrade: can't make informed decisions without DB. Bail.
    result.skippedReason = 'endpoint-unavailable'
    result.tookMs = nowMs() - t0
    logger.app.info(
      `reconcileMedia[${scope}]: endpoint unavailable — no state mutation, no enqueue (tookMs=${result.tookMs})`,
    )
    return result
  }

  // ── Per-routine reconcile ──
  for (const routine of candidates) {
    try {
      const inv = invMap[routine.id]
      const { repaired, queued } = reconcileOne(routine, inv)
      result.repaired += repaired
      result.queued += queued
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`R${routine.entryNumber}: ${msg}`)
      onRoutineFailure(routine.id)
    }
  }

  // ── Post-reconcile: retry orphaned completions (lost /plugin/complete) ──
  try {
    const recovered = await uploadService.retryOrphanedCompletions()
    if (recovered > 0) {
      logger.app.info(`reconcileMedia[${scope}]: recovered ${recovered} orphaned plugin/complete calls`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`retryOrphanedCompletions: ${msg}`)
  }

  // ── Kick uploads if we queued anything ──
  if (result.queued > 0) {
    uploadService.startUploads()
  }

  result.tookMs = nowMs() - t0
  logger.app.info(
    `reconcileMedia[${scope}]: scanned=${result.scanned} repaired=${result.repaired} queued=${result.queued} errors=${result.errors.length} in ${result.tookMs}ms`,
  )

  // ── Surface result to renderer when non-silent + actionable ──
  if (!silent && (result.queued > 0 || result.errors.length > 0)) {
    sendToRenderer(IPC_CHANNELS.MEDIA_RECONCILE_RESULT, result)
  }

  return result
}

// ── Ambient timer ──────────────────────────────────────────────────────
//
// Runs reconcileMedia({scope:'ambient'}) on a cadence while the app is
// open. Settings:
//   upload.reconcileCadenceMinutes — 0 disables, min 2, max 1440
//   upload.reconcileSilent — if true, no toast on ambient ticks

let ambientTimer: NodeJS.Timeout | null = null
let ambientFirstTick: NodeJS.Timeout | null = null

export function startAmbientReconciler(): void {
  if (ambientTimer) return
  const s = getSettings()
  const rawMinutes = s.upload?.reconcileCadenceMinutes
  const minutes = typeof rawMinutes === 'number' ? rawMinutes : 15
  if (minutes <= 0) {
    logger.app.info('Ambient reconciler: disabled (reconcileCadenceMinutes=0)')
    return
  }
  const clamped = Math.max(2, Math.min(1440, minutes))
  const intervalMs = clamped * 60 * 1000

  // First tick: fire shortly after boot so the operator doesn't wait N minutes
  // for the first pass. 30s delay lets share-code resolve + any boot-time
  // autoResumeUnfinished call complete first.
  if (ambientFirstTick) clearTimeout(ambientFirstTick)
  ambientFirstTick = setTimeout(() => {
    void reconcileMedia({ scope: 'ambient' }).catch((err) => {
      logger.app.warn(`ambient reconcile (first tick) failed: ${err instanceof Error ? err.message : err}`)
    })
  }, 30_000)

  ambientTimer = setInterval(() => {
    void reconcileMedia({ scope: 'ambient' }).catch((err) => {
      logger.app.warn(`ambient reconcile failed: ${err instanceof Error ? err.message : err}`)
    })
  }, intervalMs)

  logger.app.info(`Ambient reconciler: started, cadence=${clamped}min (requested ${minutes})`)
}

export function stopAmbientReconciler(): void {
  if (ambientTimer) {
    clearInterval(ambientTimer)
    ambientTimer = null
  }
  if (ambientFirstTick) {
    clearTimeout(ambientFirstTick)
    ambientFirstTick = null
  }
  logger.app.info('Ambient reconciler: stopped')
}

/**
 * Re-apply the ambient cadence after a settings change. Idempotent.
 */
export function restartAmbientReconciler(): void {
  stopAmbientReconciler()
  startAmbientReconciler()
}
