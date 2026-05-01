/**
 * A56 — Universal pipeline detector (narrow slice).
 *
 * Tracks last-activity timestamps + pending counts for 4 stages:
 *   - recording      (zero tolerance — red on first 'recorded' without video)
 *   - photoImport    (~30 routine durations until yellow, 60 until red)
 *   - photoUpload    (5 min yellow / 10 min red while comp active)
 *   - videoUpload    (5 min yellow / 10 min red while comp active)
 *
 * Periodic evaluator (every 30s) classifies each stage and broadcasts the
 * snapshot via PIPELINE_HEALTH IPC. Renderer subscribes for the header chip.
 *
 * Encode + thumb + keyframe stages deferred (not in tonight's slice).
 *
 * No OS-level notifications (operator picked option (b) at decision 22:01 EDT).
 */

import {
  IPC_CHANNELS,
  type PipelineHealthSnapshot,
  type PipelineStageId,
  type PipelineStageState,
} from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import * as state from './state'
import * as jobQueue from './jobQueue'

const stages: Record<PipelineStageId, PipelineStageState> = {
  recording:    { id: 'recording',    lastActivityMs: 0, pendingCount: 0, health: 'unknown' },
  photoImport:  { id: 'photoImport',  lastActivityMs: 0, pendingCount: 0, health: 'unknown' },
  photoUpload:  { id: 'photoUpload',  lastActivityMs: 0, pendingCount: 0, health: 'unknown' },
  videoUpload:  { id: 'videoUpload',  lastActivityMs: 0, pendingCount: 0, health: 'unknown' },
}

// Photo-import staleness thresholds (operator-locked 2026-05-01 EDT — relaxed).
// Burlington UDC 2026-05-01: prior 10/30 min yellow/red was too tight — photos
// are normally imported every ~60 min (between SD swaps), so 10 min idle is
// the expected steady state, not a stall. Operator wants the chip to reflect
// "no GENERAL activity across encode/upload" rather than tight per-stage
// timers. As an interim fix, raise photo-import thresholds to ~75/120 min so
// the yellow fires only when an SD swap is overdue — not between normal swaps.
const PHOTO_IMPORT_YELLOW_MS = 75 * 60_000   // chip → yellow
const PHOTO_IMPORT_RED_MS    = 120 * 60_000  // chip → red
// Sticky HardeningBanner fires once per session when crossed (visual only —
// no audio anywhere in the app, ever).
const PHOTO_IMPORT_BANNER_MS = 150 * 60_000

const UPLOAD_YELLOW_MS = 5 * 60_000
const UPLOAD_RED_MS    = 10 * 60_000

let evalTimer: NodeJS.Timeout | null = null
let stallBannerFiredAt = 0   // session-scoped; resets on activity bump.

export function bumpActivity(stage: PipelineStageId): void {
  stages[stage].lastActivityMs = Date.now()
  // Activity on photoImport clears the one-shot banner gate so a future stall
  // (after recovery) re-fires the banner instead of staying dormant.
  if (stage === 'photoImport') stallBannerFiredAt = 0
}

export function setPendingCount(stage: PipelineStageId, n: number): void {
  stages[stage].pendingCount = Math.max(0, n)
}

export function flagRecordingMissingVideo(routineId: string): void {
  // A56: zero-tolerance trigger — fired when a routine transitions to
  // 'recorded' but no encoded video file is found. Goes red immediately.
  stages.recording.health = 'red'
  stages.recording.reason = `Routine ${routineId.slice(0, 8)} recorded with no video output`
  emitSnapshot()
}

function isCompetitionActive(): boolean {
  // Competition is "active" when a competition is loaded AND has at least
  // one routine in pending/recording status (i.e. operator is in a show day,
  // not idle post-event).
  const comp = state.getCompetition()
  if (!comp) return false
  return comp.routines.some((r) => r.status === 'pending' || r.status === 'recording')
}

function classifyStaleness(lastMs: number, yellowMs: number, redMs: number): 'green' | 'yellow' | 'red' {
  if (lastMs === 0) return 'green' // never activated this session = idle, not stale
  const age = Date.now() - lastMs
  if (age >= redMs) return 'red'
  if (age >= yellowMs) return 'yellow'
  return 'green'
}

function refreshPendingCounts(): void {
  // Photo-import pending: any in-flight 'photo-import' jobs.
  stages.photoImport.pendingCount = jobQueue.getPending('photo-import').length

  // Photo / video upload pending: 'upload' jobs split by payload.kind.
  // Payload shape (per upload.ts enqueue): { kind: 'photo'|'video', ... }.
  // Treat unknown kinds as video (safer — videos are the bigger blockers).
  let photoPending = 0
  let videoPending = 0
  for (const job of jobQueue.getPending('upload')) {
    const kind = (job.payload as Record<string, unknown>).kind
    if (kind === 'photo') photoPending++
    else videoPending++
  }
  stages.photoUpload.pendingCount = photoPending
  stages.videoUpload.pendingCount = videoPending
}

function evaluate(): void {
  refreshPendingCounts()
  const compActive = isCompetitionActive()

  // Recording: zero tolerance — only goes red on flagRecordingMissingVideo.
  // Otherwise green if any activity, unknown if no activity yet this session.
  if (stages.recording.health !== 'red') {
    stages.recording.health = stages.recording.lastActivityMs > 0 ? 'green' : 'unknown'
    stages.recording.reason = undefined
  }

  // Photo import: stale if no activity for 10+ min during active comp.
  // Idle outside active comp = green.
  if (compActive) {
    stages.photoImport.health = classifyStaleness(
      stages.photoImport.lastActivityMs, PHOTO_IMPORT_YELLOW_MS, PHOTO_IMPORT_RED_MS,
    )
    if (stages.photoImport.health !== 'green') {
      const ageMin = Math.round((Date.now() - stages.photoImport.lastActivityMs) / 60_000)
      stages.photoImport.reason = `No new photos imported in ${ageMin} min`
    } else {
      stages.photoImport.reason = undefined
    }
    // 60-min sticky banner — fires ONCE per stall episode. bumpActivity()
    // resets stallBannerFiredAt so a recovered-then-stalled-again pipeline
    // re-fires. Skipped for fresh-boot (lastActivityMs===0) so the banner
    // doesn't appear in idle competitions that haven't ingested yet today.
    if (
      stages.photoImport.lastActivityMs > 0 &&
      stallBannerFiredAt === 0 &&
      Date.now() - stages.photoImport.lastActivityMs >= PHOTO_IMPORT_BANNER_MS
    ) {
      stallBannerFiredAt = Date.now()
      const ageMin = Math.round((Date.now() - stages.photoImport.lastActivityMs) / 60_000)
      sendToRenderer(IPC_CHANNELS.PHOTO_IMPORT_STALL, {
        ageMin,
        lastActivityMs: stages.photoImport.lastActivityMs,
      })
      logger.app.warn(`Pipeline health: photo-import stall ≥ 60 min — banner fired (${ageMin} min since last activity)`)
    }
  } else {
    stages.photoImport.health = 'green'
    stages.photoImport.reason = undefined
  }

  // Uploads: 5/10 min thresholds; only meaningful when there's pending work
  // OR when the competition is active. Idle queue = green.
  for (const id of ['photoUpload', 'videoUpload'] as PipelineStageId[]) {
    const s = stages[id]
    const hasPending = s.pendingCount > 0
    if (compActive && hasPending) {
      s.health = classifyStaleness(s.lastActivityMs, UPLOAD_YELLOW_MS, UPLOAD_RED_MS)
      if (s.health !== 'green') {
        const ageMin = Math.round((Date.now() - s.lastActivityMs) / 60_000)
        s.reason = `${s.pendingCount} pending — no progress in ${ageMin} min`
      } else {
        s.reason = undefined
      }
    } else {
      s.health = 'green'
      s.reason = undefined
    }
  }

  emitSnapshot()
}

function worstHealth(snapshot: PipelineStageState[]): 'green' | 'yellow' | 'red' | 'unknown' {
  let worst: 'green' | 'yellow' | 'red' | 'unknown' = 'green'
  for (const s of snapshot) {
    if (s.health === 'red') return 'red'
    if (s.health === 'yellow' && worst !== 'red') worst = 'yellow'
    if (s.health === 'unknown' && worst === 'green') worst = 'unknown'
  }
  return worst
}

function emitSnapshot(): void {
  const stagesList = Object.values(stages)
  const snapshot: PipelineHealthSnapshot = {
    worst: worstHealth(stagesList),
    evaluatedAtMs: Date.now(),
    stages: stagesList.map((s) => ({ ...s })),
  }
  sendToRenderer(IPC_CHANNELS.PIPELINE_HEALTH, snapshot)
}

export function init(): void {
  if (evalTimer) return
  evalTimer = setInterval(evaluate, 30_000)
  // Fire once on init so renderer immediately has a baseline.
  evaluate()
  logger.app.info('Pipeline health monitor initialized (eval every 30s)')
}

export function cleanup(): void {
  if (evalTimer) { clearInterval(evalTimer); evalTimer = null }
}

export function getSnapshot(): PipelineHealthSnapshot {
  const stagesList = Object.values(stages)
  return {
    worst: worstHealth(stagesList),
    evaluatedAtMs: Date.now(),
    stages: stagesList.map((s) => ({ ...s })),
  }
}
