import fs from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import { Competition, Routine, RoutineStatus, IPC_CHANNELS } from '../../shared/types'
import { logger } from '../logger'
import * as jobQueue from './jobQueue'

const STATE_FILE = 'compsync-state.json'
const STATE_BACKUP_KEEP = 10
const STATE_BACKUP_PRUNE_THRESHOLD = 15

function listStateBackups(statePath: string): string[] {
  try {
    const dir = path.dirname(statePath)
    const base = path.basename(statePath)
    const prefix = `${base}.bak-`
    const entries = fs.readdirSync(dir)
    return entries
      .filter((e) => e.startsWith(prefix))
      .map((e) => path.join(dir, e))
      .sort((a, b) => {
        const ta = parseInt(path.basename(a).slice(prefix.length), 10) || 0
        const tb = parseInt(path.basename(b).slice(prefix.length), 10) || 0
        return tb - ta
      })
  } catch {
    return []
  }
}

function pruneStateBackups(statePath: string, keep: number): void {
  const backups = listStateBackups(statePath)
  if (backups.length <= keep) return
  for (const old of backups.slice(keep)) {
    try { fs.unlinkSync(old) } catch {}
  }
}

// Media loss prevention — reconcile pass gate.
// Live mode (false): on each fresh schedule load, routines locally flagged
// 'uploaded'/'confirmed' but which the server authoritatively reports as
// having no media_package (mediaPackageStatus === 'none') are demoted so
// the operator can re-upload. A backup snapshot of compsync-state.json is
// written BEFORE the first mutation in each reconcile pass.
const RECONCILE_DRY_RUN = false

interface CameraOffsetEntry {
  offsetMs: number
  appliedAt: string // ISO
  date: string      // YYYY-MM-DD local; cleared on day boundary
  source: 'auto' | 'manual' | 'day-shift'
}

interface SdWatermarkEntry {
  lastCaptureTime: string // ISO EXIF DateTimeOriginal of latest processed photo for this body
  lastFilename?: string   // legacy/back-compat log aid only
  setAt: string          // ISO
}

interface PersistedState {
  competition: Competition | null
  currentRoutineId: string | null   // ID-based (was index-based)
  currentRoutineIndex?: number      // legacy — used for migration only
  savedAt: string
  cameraOffsets?: Record<string, CameraOffsetEntry>
  sdWatermarks?: Record<string, SdWatermarkEntry>
}

let currentCompetition: Competition | null = null
let currentRoutineId: string | null = null
let saveTimer: NodeJS.Timeout | null = null
let savePending = false
let cameraOffsets: Record<string, CameraOffsetEntry> = {}
let sdWatermarks: Record<string, SdWatermarkEntry> = {}

// Fix 8: Cached counts for WS broadcasts — updated incrementally
let cachedSkippedCount = 0
let cachedActiveCount = 0  // routines that are not skipped

function isNonPerformingStatus(status: RoutineStatus): boolean {
  return status === 'skipped' || status === 'scratched'
}

function getStatePath(): string {
  // Keep operator session state in app userData so changing media output directories
  // does not silently switch the persisted competition/session file.
  return path.join(app.getPath('userData'), STATE_FILE)
}

// --- Persistence (debounced + atomic) ---

/**
 * Leading-edge + trailing-edge debounced save (500ms window).
 * - First call saves immediately.
 * - Calls within 500ms are coalesced: a single trailing save runs when the timer fires.
 * This caps writes at ~2/sec max during photo-match bursts instead of dropping them.
 */
export function saveState(): void {
  if (saveTimer) {
    savePending = true
    return
  }
  doSave()
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (savePending) {
      savePending = false
      doSave()
    }
  }, 500)
}

/** Immediate flush for critical transitions (recording start/stop, app closing). */
export function saveStateImmediate(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  savePending = false
  doSave()
}

function doSave(): void {
  if (!currentCompetition) return

  const statePath = getStatePath()
  const state: PersistedState = {
    competition: currentCompetition,
    currentRoutineId,
    savedAt: new Date().toISOString(),
    cameraOffsets,
    sdWatermarks,
  }

  try {
    const dir = path.dirname(statePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    // Atomic write: write to .tmp then rename
    const tmpPath = statePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2))
    fs.renameSync(tmpPath, statePath)
    logger.app.debug(`State saved to ${statePath}`)

    // Fix 12: rolling backup
    try {
      const backupPath = `${statePath}.bak-${Date.now()}`
      fs.copyFileSync(statePath, backupPath)
      const existing = listStateBackups(statePath)
      if (existing.length > STATE_BACKUP_PRUNE_THRESHOLD) {
        pruneStateBackups(statePath, STATE_BACKUP_KEEP)
      }
    } catch (bErr) {
      logger.app.warn(`State backup failed: ${bErr instanceof Error ? bErr.message : bErr}`)
    }
  } catch (err) {
    logger.app.error('Failed to save state:', err)
  }
}

function tryParseStateFile(filePath: string): PersistedState | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedState
  } catch {
    return null
  }
}

function applyLoadedState(data: PersistedState): void {
  currentCompetition = data.competition
  // Hydrate persisted camera offsets and prune stale (not from today).
  const today = localDateString(new Date())
  const loaded = data.cameraOffsets ?? {}
  cameraOffsets = {}
  for (const [key, entry] of Object.entries(loaded)) {
    if (entry && entry.date === today) {
      cameraOffsets[key] = entry
    } else if (entry) {
      logger.app.info(`Pruned stale camera offset for "${key}" (from ${entry.date}, today ${today})`)
    }
  }
  // Hydrate SD watermarks — these do NOT expire with day boundaries. An
  // operator's "mark everything on the SD as processed" decision should
  // persist across app restarts until explicitly cleared or overwritten
  // by a larger filename during a subsequent import.
  sdWatermarks = { ...(data.sdWatermarks ?? {}) }
  const wmCount = Object.keys(sdWatermarks).length
  if (wmCount > 0) {
    logger.app.info(`Hydrated ${wmCount} SD watermark(s): ` +
      Object.entries(sdWatermarks).map(([k, v]) => `${k}=${v.lastCaptureTime}`).join(', '))
  }
  recomputeCachedCounts()

  if (data.currentRoutineId) {
    currentRoutineId = data.currentRoutineId
  } else if (data.currentRoutineIndex !== undefined && data.competition) {
    const visibleRoutines = data.competition.routines.filter(r => !isNonPerformingStatus(r.status))
    const routine = visibleRoutines[data.currentRoutineIndex]
    currentRoutineId = routine?.id || null
    logger.app.info(`Migrated state from index ${data.currentRoutineIndex} to ID ${currentRoutineId}`)
  } else {
    currentRoutineId = null
  }

  if (currentCompetition) {
    const validRoutineIds = new Set(currentCompetition.routines.map((routine) => routine.id))
    jobQueue.pruneForCompetition(currentCompetition.competitionId, validRoutineIds)
  }
}

export function loadState(): PersistedState | null {
  const statePath = getStatePath()

  // Primary path
  const primary = tryParseStateFile(statePath)
  if (primary) {
    logger.app.info(`State loaded from ${statePath}`)
    applyLoadedState(primary)
    return primary
  }

  if (fs.existsSync(statePath)) {
    logger.app.error(`Primary state file ${statePath} unreadable — trying backups`)
  }

  // Fix 12: fall back to most-recent backup that parses
  const backups = listStateBackups(statePath)
  for (const backup of backups) {
    const data = tryParseStateFile(backup)
    if (data) {
      let ageMs = 0
      try {
        const match = path.basename(backup).match(/\.bak-(\d+)$/)
        if (match) ageMs = Date.now() - parseInt(match[1], 10)
      } catch {}
      logger.app.warn(`State recovered from backup: ${backup} (ageMs=${ageMs})`)
      applyLoadedState(data)
      try {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.STATE_RECOVERED_FROM_BACKUP, { backupFile: backup, ageMs })
        }
      } catch {}
      return data
    }
  }

  return null
}

// --- Helper: resolve current routine index from ID ---

function getVisibleRoutines(): Routine[] {
  if (!currentCompetition) return []
  const routines = currentCompetition.routines
  // Item 5 (2026-04-25): when a manual displayOrder is set, sort by it.
  // Routines whose IDs are not in displayOrder fall to the end in their
  // original schedule sequence so newly-added routines stay visible.
  if (currentCompetition.displayOrder && currentCompetition.displayOrder.length > 0) {
    const order = currentCompetition.displayOrder
    const orderIdx = new Map<string, number>()
    order.forEach((id, i) => orderIdx.set(id, i))
    const inOrder: Routine[] = []
    const trailing: Routine[] = []
    for (const r of routines) {
      if (orderIdx.has(r.id)) inOrder.push(r)
      else trailing.push(r)
    }
    inOrder.sort((a, b) => (orderIdx.get(a.id)! - orderIdx.get(b.id)!))
    return inOrder.concat(trailing).filter(r => !isNonPerformingStatus(r.status))
  }
  return routines.filter(r => !isNonPerformingStatus(r.status))
}

// Compute the time of the next "awards" / break for the current routine
// (operator-spec 2026-04-25). Walks forward from the current routine looking
// for the first scheduled gap >= 15 min; the awards time is the END of the
// last routine BEFORE the gap. For the final session of a day with no future
// gap, falls back to the end of the last scheduled routine on that day.
//
// Returns "HH:MM" string, or null if it can't be determined (e.g. no
// scheduled times, current routine in a fresh-load null state, etc.).
const SESSION_GAP_MIN = 15

function parseHHMM(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm)
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

function fmtHHMM(min: number): string {
  const norm = ((min % 1440) + 1440) % 1440
  const h = Math.floor(norm / 60)
  const m = norm % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function getNextAwardsTime(): string | null {
  if (!currentCompetition) return null
  const all = currentCompetition.routines
  if (all.length === 0) return null

  // Find current routine. If none, use first routine's day; else use that routine's day.
  let curIdx = 0
  if (currentRoutineId) {
    const found = all.findIndex(r => r.id === currentRoutineId)
    if (found >= 0) curIdx = found
  }
  const day = all[curIdx]?.scheduledDay
  if (!day) return null

  // Today's routines, in schedule order, with valid scheduledTime.
  const todays = all.filter(r =>
    r.scheduledDay === day && typeof r.scheduledTime === 'string' && parseHHMM(r.scheduledTime) !== null,
  )
  if (todays.length === 0) return null

  // Locate the current routine's position in todays (may not match curIdx if filtered).
  const curId = all[curIdx].id
  const curInToday = todays.findIndex(r => r.id === curId)
  const startSearchIdx = Math.max(0, curInToday)

  // Walk forward; find first gap >= 15 min between consecutive todays routines.
  let lastEndMin: number | null = null
  for (let i = startSearchIdx; i < todays.length; i++) {
    const r = todays[i]
    const startMin = parseHHMM(r.scheduledTime!)
    if (startMin === null) continue
    const dur = r.durationMinutes || 3
    if (lastEndMin !== null) {
      let gap = startMin - lastEndMin
      if (gap < -12 * 60) gap += 24 * 60
      if (gap >= SESSION_GAP_MIN) {
        return fmtHHMM(lastEndMin)
      }
    }
    lastEndMin = startMin + dur
  }

  // No future gap found — fall back to end of last routine on this day
  // (operator-spec: last session of day still shows NEXT AWARDS).
  if (lastEndMin !== null) return fmtHHMM(lastEndMin)
  return null
}

export function setDisplayOrder(routineIds: string[]): void {
  if (!currentCompetition) return
  // Validate: only IDs that exist in the current routines list.
  const valid = new Set(currentCompetition.routines.map(r => r.id))
  currentCompetition.displayOrder = routineIds.filter(id => valid.has(id))
  saveState()
  logger.app.info(`displayOrder updated: ${currentCompetition.displayOrder.length} ids`)
}

function getCurrentIndex(): number {
  if (!currentRoutineId) return 0
  const visible = getVisibleRoutines()
  const idx = visible.findIndex(r => r.id === currentRoutineId)
  return idx >= 0 ? idx : 0
}

// --- Cached count helpers ---

function recomputeCachedCounts(): void {
  if (!currentCompetition) {
    cachedSkippedCount = 0
    cachedActiveCount = 0
    return
  }
  let skipped = 0
  for (const r of currentCompetition.routines) {
    if (isNonPerformingStatus(r.status)) skipped++
  }
  cachedSkippedCount = skipped
  cachedActiveCount = currentCompetition.routines.length - skipped
}

export function getSkippedCount(): number {
  return cachedSkippedCount
}

export function getActiveCount(): number {
  return cachedActiveCount
}

// --- Public API ---

export function setCompetition(comp: Competition): void {
  // Venue TV "now playing" — clear stale entry on schedule reload (fire-and-forget,
  // before swapping currentCompetition so the post still has the old conn context).
  // Lazy import to avoid circular dep: state ↔ compPortal ↔ schedule ↔ state.
  void import('./compPortal').then(m => m.postNowPlaying(null).catch(() => {})).catch(() => {})

  currentCompetition = comp
  currentRoutineId = null

  const validRoutineIds = new Set(comp.routines.map((routine) => routine.id))
  jobQueue.pruneForCompetition(comp.competitionId, validRoutineIds)

  // Try to restore routine states from persisted state (read file directly, don't call loadState which has side effects)
  let existing: PersistedState | null = null
  const statePath = getStatePath()
  try {
    if (fs.existsSync(statePath)) {
      existing = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    }
  } catch (_err) {
    // ignore — no persisted state to restore
  }
  if (existing?.competition?.competitionId === comp.competitionId) {
    // Fix 7: Build Map for O(1) lookup instead of O(n) .find() per routine
    const persistedMap = new Map<string, Routine>()
    for (const r of existing.competition.routines) {
      persistedMap.set(r.id, r)
    }

    let matchedCount = 0
    for (const routine of comp.routines) {
      const persisted = persistedMap.get(routine.id)
      if (persisted) {
        routine.status = persisted.status
        routine.recordingStartedAt = persisted.recordingStartedAt
        routine.recordingStoppedAt = persisted.recordingStoppedAt
        routine.outputPath = persisted.outputPath
        routine.encodedFiles = persisted.encodedFiles
        routine.photos = persisted.photos
        routine.uploadProgress = persisted.uploadProgress
        routine.notes = persisted.notes
        matchedCount++
      }
    }

    // Item 5 (2026-04-25): preserve operator drag/drop order across schedule
    // re-imports. Drop IDs no longer in the schedule, append new IDs to the
    // end in schedule order.
    if (existing.competition.displayOrder && existing.competition.displayOrder.length > 0) {
      const newIds = new Set(comp.routines.map(r => r.id))
      const kept = existing.competition.displayOrder.filter((id: string) => newIds.has(id))
      const keptSet = new Set(kept)
      const appended = comp.routines.map(r => r.id).filter(id => !keptSet.has(id))
      comp.displayOrder = kept.concat(appended)
    }

    // Restore currentRoutineId from persisted state. This was nulled at
    // line 250 when we swapped in the new competition reference; bring it
    // back so post-restart the operator's selection (and the next-routine
    // pointer) survive. Without this, every app restart falls through to
    // the "default to first visible routine" fallback below and lands on
    // R#100 — causing accidental re-records when the operator hits RECORD.
    if (existing.currentRoutineId) {
      const found = comp.routines.find(r => r.id === existing.currentRoutineId)
      if (found) {
        currentRoutineId = existing.currentRoutineId
      } else {
        logger.app.warn(`Persisted current routine ID ${existing.currentRoutineId} not found in loaded competition`)
      }
    }

    logger.app.info(`Restored state for ${comp.name}, currentId=${currentRoutineId}, ${matchedCount}/${comp.routines.length} routines matched`)
    if (matchedCount === 0 && existing.competition.routines.length > 0) {
      logger.app.warn(`No routine IDs matched — routine IDs may have changed. All progress reset to pending.`)
    } else if (matchedCount < comp.routines.length) {
      logger.app.warn(`${comp.routines.length - matchedCount} routines had no persisted state (new or changed IDs)`)
    }
  }

  // Previously defaulted to the first visible routine (= R100 in practice)
  // when currentRoutineId was null. That caused accidental recordings of
  // R100 every time the app restarted or the schedule was reloaded,
  // because pressing RECORD while currentRoutineId is null silently binds
  // to whatever getCurrentRoutine returns. Operator's rule: the selected
  // routine must come from an explicit click, not a fallback. Leave
  // currentRoutineId null until the operator sets it.

  // ── Reconcile pass (Media loss prevention, Phase 4) ──
  //
  // Intent: if the server authoritatively reports mediaPackageStatus === 'none'
  // for a routine we locally believe is 'uploaded' or 'confirmed', demote the
  // local copy so the operator can re-upload. Strict safety rules:
  //   1. Never run without a positive signal (mediaPackageStatus field present).
  //      undefined → old server, never downgrade.
  //   2. Only 'uploaded' and 'confirmed' are eligible. Any mid-pipeline status
  //      (recording/recorded/queued/encoding/encoded/uploading) is skipped.
  //   3. If encoded files still exist on disk → demote to 'encoded' (keep files,
  //      outputPath, photos, notes — everything else untouched).
  //   4. If encoded files are missing → demote to 'pending' and clear
  //      encodedFiles/photos (nothing to re-upload from).
  //   5. Backup compsync-state.json before first mutation (once per pass).
  //
  // Dry-run: logs every intended action without mutating.
  const demoteCandidates: Array<{
    routine: Routine
    newStatus: RoutineStatus
    filesExist: boolean
    reason: string
  }> = []

  for (const routine of comp.routines) {
    if (routine.mediaPackageStatus === undefined) continue // old server, no signal
    if (routine.mediaPackageStatus !== 'none') continue
    if (routine.status !== 'uploaded' && routine.status !== 'confirmed') continue

    // Extra belt-and-suspenders: never touch mid-pipeline (shouldn't match above
    // guard but cheap to double-check).
    const midPipeline: RoutineStatus[] = ['recording', 'recorded', 'queued', 'encoding', 'encoded', 'uploading']
    if (midPipeline.includes(routine.status)) continue

    const encoded = routine.encodedFiles || []
    if (encoded.length === 0) {
      demoteCandidates.push({
        routine,
        newStatus: 'pending',
        filesExist: false,
        reason: 'no encodedFiles on local routine',
      })
      continue
    }

    const allExist = encoded.every(f => {
      try { return fs.existsSync(f.filePath) } catch { return false }
    })

    if (allExist) {
      demoteCandidates.push({
        routine,
        newStatus: 'encoded',
        filesExist: true,
        reason: 'server has no media package; local encoded files still on disk',
      })
    } else {
      demoteCandidates.push({
        routine,
        newStatus: 'pending',
        filesExist: false,
        reason: 'server has no media package; local encoded files missing from disk',
      })
    }
  }

  if (demoteCandidates.length > 0) {
    let demoted = 0
    let dryRun = 0
    const skipped = 0 // reserved for future filter branches; currently unused

    // Backup BEFORE mutating — only if we will actually mutate.
    if (!RECONCILE_DRY_RUN) {
      try {
        const statePathForBackup = getStatePath()
        if (fs.existsSync(statePathForBackup)) {
          const backupPath = `${statePathForBackup}.bak-${Date.now()}`
          fs.copyFileSync(statePathForBackup, backupPath)
          logger.app.info(`Reconcile: snapshotted state to ${backupPath}`)
        }
      } catch (err) {
        logger.app.error('Reconcile: failed to snapshot state backup; aborting mutation', err)
        // Safety: if we can't back up, don't mutate.
        recomputeCachedCounts()
        saveState()
        return
      }
    }

    for (const c of demoteCandidates) {
      const oldStatus = c.routine.status
      if (RECONCILE_DRY_RUN) {
        logger.app.info(
          `[DRY RUN] would demote entry #${c.routine.entryNumber} "${c.routine.routineTitle}": ${oldStatus} → ${c.newStatus} (filesExistOnDisk=${c.filesExist}, reason: ${c.reason})`,
        )
        dryRun++
      } else {
        logger.app.info(
          `Reconcile demote: entry #${c.routine.entryNumber} "${c.routine.routineTitle}": ${oldStatus} → ${c.newStatus} (filesExistOnDisk=${c.filesExist}, reason: ${c.reason})`,
        )
        c.routine.status = c.newStatus
        if (c.newStatus === 'pending') {
          c.routine.encodedFiles = undefined
          c.routine.photos = undefined
        }
        demoted++
      }
    }

    logger.app.info(`Reconcile: ${demoted} demoted, ${dryRun} dry-run, ${skipped} skipped`)
  }

  recomputeCachedCounts()
  saveState()

  // A35: bulk-sync currently-scratched routines to CompPortal as a backstop
  // for any individual scratch-notify jobs that were lost across sessions.
  // Idempotent — server upserts. Fires after persisted state is restored so
  // we have the up-to-date scratched list for this comp.
  void import('./compPortal').then((m) => {
    const scratched: Array<{ entryId: string; status: 'scratched' | 'unscratched'; scratchedAt?: string }> = []
    for (const r of comp.routines) {
      if (r.status === 'scratched') {
        scratched.push({ entryId: r.id, status: 'scratched' })
      }
    }
    if (scratched.length === 0) return
    m.postRoutineStatusBulk(comp.competitionId, scratched).catch(() => {})
    // Also try to drain any pending scratch-notify jobs now that we have a connection.
    m.drainScratchNotifyQueue().catch(() => {})
  }).catch(() => {})
}

export function getCompetition(): Competition | null {
  return currentCompetition
}

export function getCurrentRoutine(): Routine | null {
  if (!currentCompetition || !currentRoutineId) return null
  const visible = getVisibleRoutines()
  return visible.find(r => r.id === currentRoutineId) || null
}

export function getCurrentRoutineIndex(): number {
  return getCurrentIndex()
}

export function getNextRoutine(): Routine | null {
  if (!currentCompetition) return null
  const visible = getVisibleRoutines()
  const idx = getCurrentIndex()
  return visible[idx + 1] || null
}

export function getUpcomingRoutines(count: number): Routine[] {
  if (!currentCompetition) return []
  const visible = getVisibleRoutines()
  const idx = getCurrentIndex()
  return visible.slice(idx + 1, idx + 1 + count)
}

export function advanceToNext(): Routine | null {
  if (!currentCompetition) return null
  const visible = getVisibleRoutines()
  if (visible.length === 0) return null

  // No current routine selected (e.g., fresh app start, post-restart before
  // the operator has clicked anything). "Next" here means "pick up where we
  // left off" — the first routine that still needs recording. Falling back
  // to visible[0] or visible[1] would silently jump to R100 or R101, which
  // is the bug operator's been chasing.
  if (!currentRoutineId) {
    const firstPending = visible.find(r => r.status === 'pending')
    const target = firstPending ?? visible[0]
    currentRoutineId = target.id
    saveState()
    logger.app.info(`advanceToNext: no current routine — jumping to ${firstPending ? 'first pending' : 'first visible'} #${target.entryNumber}`)
    return target
  }

  // Defensive: if currentRoutineId points to a routine that's been marked
  // scratched/skipped, it isn't in `visible`. getCurrentIndex() returns 0,
  // which would make NEXT jump to visible[1] from the start — wrong. Resolve
  // its position in the FULL routine list and advance to the next non-scratched
  // routine after it.
  const fullList = currentCompetition.routines
  const fullIdx = fullList.findIndex(r => r.id === currentRoutineId)
  const currentInVisible = visible.findIndex(r => r.id === currentRoutineId)
  if (currentInVisible < 0 && fullIdx >= 0) {
    const next = fullList.slice(fullIdx + 1).find(r => !isNonPerformingStatus(r.status))
    if (next) {
      currentRoutineId = next.id
      saveState()
      logger.app.info(`advanceToNext: current routine was scratched/skipped — advancing past to #${next.entryNumber}`)
      return next
    }
    return null
  }

  const idx = currentInVisible >= 0 ? currentInVisible : 0
  if (idx < visible.length - 1) {
    currentRoutineId = visible[idx + 1].id
    saveState()
    return visible[idx + 1]
  }
  return null
}

export function goToPrev(): Routine | null {
  if (!currentCompetition) return null
  const visible = getVisibleRoutines()
  const idx = getCurrentIndex()
  if (idx > 0) {
    currentRoutineId = visible[idx - 1].id
    saveState()
    return visible[idx - 1]
  }
  return null
}

export function jumpToRoutine(routineId: string): Routine | null {
  if (!currentCompetition) return null
  const visible = getVisibleRoutines()
  const found = visible.find(r => r.id === routineId)
  if (found) {
    currentRoutineId = routineId
    saveState()
    logger.app.info(`Jumped to routine #${found.entryNumber} (id ${routineId})`)
    return found
  }
  // If routine is skipped, unskip it first and jump
  const allRoutine = currentCompetition.routines.find(r => r.id === routineId)
  if (allRoutine && isNonPerformingStatus(allRoutine.status)) {
    allRoutine.status = 'pending'
    currentRoutineId = routineId
    saveState()
    return allRoutine
  }
  return null
}

export function setRoutineNote(routineId: string, note: string): void {
  if (!currentCompetition) return
  const routine = currentCompetition.routines.find((r) => r.id === routineId)
  if (routine) {
    routine.notes = note || undefined
    saveState()
  }
}

// Insert an ad-hoc / late-insert routine right after the current one.
// Used by START EMPTY ROUTINE flow (operator-spec 2026-04-25 UDC Toronto)
// when an off-schedule performance happens and the operator needs a slot
// to record into without contaminating an existing scheduled routine.
//
// The new routine:
// - Gets a synthesized id `empty-<isoTimestamp>` so it's clearly distinguishable
// - Inherits scheduledDay from the current routine (so day-filtering still works)
// - Has blank title/dancer/etc — operator fills in post-show
// - Goes into the routines array right after the current routine, so advance
//   navigation lands on it next
// - Becomes the new current routine immediately (caller can then start recording)
//
// Returns the new routine, or null if the comp isn't loaded.
// Operator-spec 2026-04-25: when a late-insert routine finishes recording, the
// "current" cursor should snap back to where the operator was BEFORE pressing
// START EMPTY ROUTINE — otherwise the schedule view jumps and stays there,
// which is disorienting mid-show. Captured on insertLateRoutine, consumed by
// returnFromLateInsert (called from recording.ts when stop fires on a
// late-insert routine).
let priorBeforeLateInsertId: string | null = null

export function insertLateRoutine(): Routine | null {
  if (!currentCompetition) return null
  const visible = getVisibleRoutines()
  const fullList = currentCompetition.routines
  // Determine insertion index: right after the current routine in fullList.
  let insertIdx = fullList.length
  if (currentRoutineId) {
    const curIdx = fullList.findIndex((r) => r.id === currentRoutineId)
    if (curIdx >= 0) insertIdx = curIdx + 1
  }
  const cur = currentRoutineId ? fullList.find((r) => r.id === currentRoutineId) : null
  const sourceForFields = cur ?? visible[0] ?? null
  // Capture prior position so we can return after recording stops.
  priorBeforeLateInsertId = currentRoutineId
  const isoNow = new Date().toISOString()
  const newId = 'empty-' + isoNow.replace(/[:.]/g, '-')
  const baseEntry = sourceForFields?.entryNumber ?? '0'
  const newEntry = baseEntry + '.5'
  const newRoutine: Routine = {
    id: newId,
    entryNumber: newEntry,
    routineTitle: '(Late insert — fill in post-show)',
    dancers: '',
    studioName: '',
    studioCode: sourceForFields?.studioCode ?? '',
    category: '',
    classification: '',
    ageGroup: '',
    sizeCategory: '',
    durationMinutes: 0,
    scheduledDay: sourceForFields?.scheduledDay ?? '',
    position: (sourceForFields?.position ?? 0) + 0.5,
    status: 'pending',
    lateInsert: true,
  }
  fullList.splice(insertIdx, 0, newRoutine)
  currentRoutineId = newId
  recomputeCachedCounts()
  saveState()
  logger.app.info(`Late-insert routine created: ${newId} (entry ${newEntry}) inserted at fullList[${insertIdx}], now current (prior=${priorBeforeLateInsertId})`)
  return newRoutine
}

/**
 * Item 17: assign an overflow routine for a take that finished without an
 * explicit slot. If `emptyRoutineNumber` is provided (operator typed a number
 * via SAVE AS EMPTY ROUTINE flow), use that. Otherwise mint a 999-decrement
 * fallback. Either path produces a lateInsert row that the operator can edit
 * post-show.
 *
 * Returns the routine, or null when no competition is loaded.
 */
export function assignOverflowRoutineForTake(emptyRoutineNumber: string | null): Routine | null {
  if (!currentCompetition) return null
  const fullList = currentCompetition.routines

  let entryNumber: string
  if (emptyRoutineNumber && emptyRoutineNumber.trim().length > 0) {
    entryNumber = emptyRoutineNumber.trim()
    // Reuse an existing routine by entryNumber if one already exists (operator
    // typed a slot they meant to target).
    const existing = fullList.find((r) => r.entryNumber === entryNumber)
    if (existing) {
      logger.app.info(`assignOverflowRoutineForTake: typed entry ${entryNumber} matched existing routine ${existing.id}`)
      return existing
    }
  } else {
    const next = (currentCompetition.nextOverflowNumber ?? 999)
    entryNumber = String(next)
    currentCompetition.nextOverflowNumber = next - 1
  }

  const isoNow = new Date().toISOString()
  const newId = 'empty-' + isoNow.replace(/[:.]/g, '-')

  // Position the new row. Pure 999-overflow with no typed entry → end of
  // table. Typed entry like "3.5" or "226.5" → insert immediately after the
  // routine whose entryNumber matches the integer prefix (so 3.5 lands
  // between R3 and R4, not at the bottom). Falls back to end if no match.
  let insertIdx = fullList.length
  let scheduledDay = ''
  if (emptyRoutineNumber) {
    const baseMatch = entryNumber.match(/^(\d+)/)
    if (baseMatch) {
      const baseNumber = baseMatch[1]
      const baseIdx = fullList.findIndex((r) => r.entryNumber === baseNumber)
      if (baseIdx >= 0) {
        insertIdx = baseIdx + 1
        scheduledDay = fullList[baseIdx].scheduledDay
      }
    }
  }

  const newRoutine: Routine = {
    id: newId,
    entryNumber,
    routineTitle: emptyRoutineNumber
      ? '(Empty routine — fill in post-show)'
      : `(Auto-overflow — fill in post-show)`,
    dancers: '',
    studioName: '',
    studioCode: '',
    category: '',
    classification: '',
    ageGroup: '',
    sizeCategory: '',
    durationMinutes: 0,
    scheduledDay,
    position: insertIdx + 0.5,
    status: 'pending',
    lateInsert: true,
  }
  fullList.splice(insertIdx, 0, newRoutine)
  recomputeCachedCounts()
  saveState()
  logger.app.info(`assignOverflowRoutineForTake: minted ${newId} entry=${entryNumber} (lateInsert) at index ${insertIdx} of ${fullList.length}`)
  return newRoutine
}

/**
 * Item 17 / A54: retarget the active recording. Reverts the old slot to
 * pending (clearing its recordingStartedAt) and marks the new slot as
 * recording. Returns the new routine, or null on any failure (no comp,
 * routines not found, etc.).
 */
export function reassignActiveTake(
  oldRoutineId: string | null,
  newRoutineId: string,
  takeStartedAt: string,
): Routine | null {
  if (!currentCompetition) return null
  const fullList = currentCompetition.routines
  const newRoutine = fullList.find((r) => r.id === newRoutineId)
  if (!newRoutine) {
    logger.app.warn(`reassignActiveTake: new routine ${newRoutineId} not found`)
    return null
  }
  if (oldRoutineId && oldRoutineId !== newRoutineId) {
    const oldRoutine = fullList.find((r) => r.id === oldRoutineId)
    if (oldRoutine && oldRoutine.status === 'recording') {
      oldRoutine.status = 'pending'
      oldRoutine.recordingStartedAt = undefined
      logger.app.info(`reassignActiveTake: reverted ${oldRoutine.entryNumber} to pending`)
    }
  }
  // Use updateRoutineStatus so cached counts + persistence + critical-flush
  // logic all run consistently.
  updateRoutineStatus(newRoutine.id, 'recording', { recordingStartedAt: takeStartedAt })
  currentRoutineId = newRoutine.id
  saveState()
  logger.app.info(`reassignActiveTake: retargeted to ${newRoutine.entryNumber} (id ${newRoutine.id})`)
  return newRoutine
}

// Restore current cursor to the position the operator was at before pressing
// START EMPTY ROUTINE. Called from recording.ts after a late-insert recording
// stops. The late-insert routine remains in the schedule (operator fills in
// metadata post-show); only the "current" pointer moves back. No-op if the
// captured prior id is no longer visible (was scratched/skipped/removed).
export function returnFromLateInsert(): void {
  const priorId = priorBeforeLateInsertId
  priorBeforeLateInsertId = null
  if (!priorId || !currentCompetition) return
  const stillVisible = getVisibleRoutines().some((r) => r.id === priorId)
  if (!stillVisible) {
    logger.app.info(`returnFromLateInsert: prior id ${priorId} no longer visible — leaving cursor on late-insert`)
    return
  }
  currentRoutineId = priorId
  saveState()
  logger.app.info(`returnFromLateInsert: cursor restored to ${priorId}`)
}

// Swap a late-insert routine's synthetic local id (`empty-<ts>`) for the
// real CompPortal entry uuid returned by `/api/plugin/late-insert-resolve`.
// Also updates the displayed entry_number if CompPortal computed a different
// `.5`/`.6`/etc. (in case our locally-derived value collided with another
// entry on the server). currentRoutineId is updated if it matched the old id.
//
// Idempotent: if the routine already has the new id, this is a no-op.
export function replaceLateInsertId(
  oldId: string,
  newEntryId: string,
  newEntryNumber?: string,
): boolean {
  if (!currentCompetition) return false
  if (oldId === newEntryId) return true
  // Defensive: don't accept an empty/falsy uuid
  if (!newEntryId) return false
  // Bail if a routine with the new id already exists (idempotent re-resolve).
  if (currentCompetition.routines.some((r) => r.id === newEntryId)) {
    if (currentRoutineId === oldId) currentRoutineId = newEntryId
    saveState()
    return true
  }
  const routine = currentCompetition.routines.find((r) => r.id === oldId)
  if (!routine) return false
  if (!routine.lateInsert) {
    logger.app.warn(`replaceLateInsertId: routine ${oldId} is not a lateInsert — refusing swap to ${newEntryId}`)
    return false
  }
  routine.id = newEntryId
  if (newEntryNumber && newEntryNumber !== routine.entryNumber) {
    logger.app.info(`Late-insert entry_number reassigned: ${routine.entryNumber} → ${newEntryNumber}`)
    routine.entryNumber = newEntryNumber
  }
  if (currentRoutineId === oldId) currentRoutineId = newEntryId
  saveState()
  logger.app.info(`Late-insert id resolved: ${oldId} → ${newEntryId}`)
  return true
}

export function updateRoutineStatus(
  routineId: string,
  status: RoutineStatus,
  extra?: Partial<Routine>,
): Routine | null {
  if (!currentCompetition) return null

  const routine = currentCompetition.routines.find((r) => r.id === routineId)
  if (!routine) return null

  const oldStatus = routine.status
  routine.status = status
  if (extra) {
    Object.assign(routine, extra)
  }

  // T-V7-23 — Auto-rollback: if photos just got appended to a routine whose
  // status was 'uploaded' or 'confirmed' and the incoming photo list has any
  // `uploaded:false` entries, demote to 'encoded' so the standard UPLOAD_ALL
  // + auto-resume filters pick it up on the next pass. Without this, an SD
  // import adding 40 new photos to R528 (already `uploaded`) would leave
  // R528's status unchanged and those 40 photos would sit unqueued until the
  // operator manually clicked Resume. `extra.photos` is the freshly-written
  // photos list — SD import / reassignOrphan / photoWorker all pass it.
  if (extra && Array.isArray(extra.photos)) {
    const anyPending = extra.photos.some((p) => !p.uploaded)
    if (anyPending && (routine.status === 'uploaded' || routine.status === 'confirmed')) {
      const newCount = extra.photos.filter((p) => !p.uploaded).length
      logger.app.info(
        `Routine ${routine.entryNumber} status demoted ${routine.status} → encoded: ${newCount} new photos pending upload`,
      )
      routine.status = 'encoded'
    }
  }

  // Fix 8: Update cached counts incrementally
  if (isNonPerformingStatus(oldStatus) && !isNonPerformingStatus(status)) {
    cachedSkippedCount--
    cachedActiveCount++
  } else if (!isNonPerformingStatus(oldStatus) && isNonPerformingStatus(status)) {
    cachedSkippedCount++
    cachedActiveCount--
  }

  logger.app.info(`Routine ${routine.entryNumber} "${routine.routineTitle}": ${oldStatus} → ${status}`)

  // A56: pipeline-health activity bumps for status transitions.
  if (status === 'recording' || status === 'recorded' || status === 'encoded' || status === 'uploaded') {
    void import('./pipelineHealth').then((m) => m.bumpActivity('recording')).catch(() => {})
  }
  // A56: red-flag if a routine moves to 'recorded' without a video output.
  if (status === 'recorded' && oldStatus !== 'recorded' && !routine.outputPath && (!routine.encodedFiles || routine.encodedFiles.length === 0)) {
    void import('./pipelineHealth').then((m) => m.flagRecordingMissingVideo(routine.id)).catch(() => {})
  }

  // Critical transitions get immediate flush
  if (status === 'recording' || oldStatus === 'recording' || status === 'uploaded' || status === 'encoded') {
    saveStateImmediate()
  } else {
    saveState()
  }

  // End-of-day checklist trigger. Fires on the pending → recorded transition
  // only (not on re-records). Lazy-required to avoid any chance of a circular
  // import between state.ts and dayChecklist.ts at module load.
  if (oldStatus !== 'recorded' && status === 'recorded') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const dc = require('./dayChecklist') as typeof import('./dayChecklist')
      dc.maybeFireEndOfDay(routine)
    } catch (err) {
      logger.app.warn(`dayChecklist end-of-day trigger failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  return routine
}

/**
 * Update only mediaPackageStatus on a routine, without touching pipeline status.
 * Used by the plugin/complete response handler so the "Portal" pill reflects
 * the authoritative server state immediately after upload succeeds, without
 * waiting for the next schedule refetch (which only runs on startup).
 */
export function setRoutineMediaPackageStatus(
  routineId: string,
  mediaPackageStatus: NonNullable<Routine['mediaPackageStatus']>,
): void {
  if (!currentCompetition) return
  const routine = currentCompetition.routines.find((r) => r.id === routineId)
  if (!routine) return
  if (routine.mediaPackageStatus === mediaPackageStatus) return
  const prev = routine.mediaPackageStatus ?? 'unset'
  routine.mediaPackageStatus = mediaPackageStatus
  routine.mediaUpdatedAt = new Date().toISOString()
  logger.app.info(
    `Routine ${routine.entryNumber} mediaPackageStatus: ${prev} → ${mediaPackageStatus}`,
  )
  saveState()
}

export function skipRoutine(routineId: string): void {
  updateRoutineStatus(routineId, 'skipped')
}

export function unskipRoutine(routineId: string): void {
  updateRoutineStatus(routineId, 'pending')
}

export function scratchRoutine(routineId: string): void {
  updateRoutineStatus(routineId, 'scratched', {
    recordingStartedAt: undefined,
    recordingStoppedAt: undefined,
    outputPath: undefined,
    outputDir: undefined,
    encodedFiles: undefined,
    keyframes: undefined,
    uploadProgress: undefined,
    error: undefined,
  })
  enqueueScratchNotify(routineId, 'scratched')
}

export function unscratchedRoutine(routineId: string): void {
  updateRoutineStatus(routineId, 'pending')
  enqueueScratchNotify(routineId, 'unscratched')
}

// A35: enqueue a scratch-notify job and try to drain immediately. If
// CompPortal is unreachable, the job sits in the queue and gets retried
// later (drain on next scratch action OR next share-resolve bulk sync).
function enqueueScratchNotify(routineId: string, status: 'scratched' | 'unscratched'): void {
  const comp = currentCompetition
  if (!comp) return
  const payload: Record<string, unknown> = {
    competitionId: comp.competitionId,
    entryId: routineId,
    status,
  }
  if (status === 'scratched') payload.scratchedAt = new Date().toISOString()
  jobQueue.enqueue('scratch-notify', routineId, payload)
  // Lazy import to avoid circular dep: state ↔ compPortal ↔ schedule ↔ state.
  void import('./compPortal').then(m => m.drainScratchNotifyQueue().catch(() => {})).catch(() => {})
}

export function getFilteredRoutines(dayFilter?: string): Routine[] {
  if (!currentCompetition) return []
  let routines = currentCompetition.routines
  if (dayFilter) {
    routines = routines.filter((r) => r.scheduledDay === dayFilter)
  }
  return routines
}

export function exportReport(): string {
  if (!currentCompetition) return ''

  const lines: string[] = []
  const now = new Date()
  const csvEscape = (s: string) => s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s

  lines.push(`CompSync Media — Session Report`)
  lines.push(`Competition: ${currentCompetition.name}`)
  lines.push(`Generated: ${now.toLocaleString()}`)
  lines.push(`Source: ${currentCompetition.source}`)
  lines.push('')

  const total = currentCompetition.routines.length
  const recorded = currentCompetition.routines.filter((r) => r.status !== 'pending' && !isNonPerformingStatus(r.status)).length
  const errors = currentCompetition.routines.filter((r) => r.status === 'failed' || r.error).length
  const withNotes = currentCompetition.routines.filter((r) => r.notes).length
  lines.push(`Total routines: ${total}`)
  lines.push(`Recorded: ${recorded}`)
  lines.push(`Errors: ${errors}`)
  lines.push(`With notes: ${withNotes}`)
  lines.push('')

  lines.push('Entry#,Title,Studio,Category,Status,Notes,Error,RecordStart,RecordStop,Duration')

  for (const r of currentCompetition.routines) {
    const startTime = r.recordingStartedAt || ''
    const stopTime = r.recordingStoppedAt || ''
    let duration = ''
    if (r.status !== 'scratched' && r.recordingStartedAt && r.recordingStoppedAt) {
      const sec = Math.round((new Date(r.recordingStoppedAt).getTime() - new Date(r.recordingStartedAt).getTime()) / 1000)
      duration = `${Math.floor(sec / 60)}m${sec % 60}s`
    }
    lines.push([
      r.entryNumber,
      csvEscape(r.routineTitle),
      csvEscape(r.studioName),
      csvEscape(`${r.ageGroup} ${r.category}`),
      r.status,
      csvEscape(r.notes || ''),
      csvEscape(r.error || ''),
      startTime,
      stopTime,
      duration,
    ].join(','))
  }

  return lines.join('\n')
}

export function exportVerificationReport(): string {
  if (!currentCompetition) return ''

  const lines: string[] = []
  const now = new Date()
  const csvEscape = (s: string) => s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s

  const issueRows = currentCompetition.routines.map((routine) => {
    const photos = routine.photos || []
    const encodedFiles = routine.encodedFiles || []
    const videosUploaded = encodedFiles.filter((f) => f.uploaded).length
    const photosUploaded = photos.filter((p) => p.uploaded).length
    const thumbsMissing = photos.filter((p) => p.uploaded && !p.thumbnailStoragePath).length
    const keyframesPresent = (routine.keyframes || []).filter(Boolean).length
    const hasMediaState = routine.status !== 'pending' && !isNonPerformingStatus(routine.status)

    const issues: string[] = []
    if (routine.status === 'failed' || routine.error) issues.push('error')
    if (hasMediaState && encodedFiles.length === 0 && !['recording', 'recorded', 'encoding', 'queued'].includes(routine.status)) {
      issues.push('missing-video')
    }
    if (encodedFiles.length > 0 && videosUploaded < encodedFiles.length) issues.push('video-upload-pending')
    if (hasMediaState && photos.length === 0) issues.push('no-photos-matched')
    if (photos.length > 0 && photosUploaded < photos.length) issues.push('photo-upload-pending')
    if (thumbsMissing > 0) issues.push('thumbnail-missing')
    if (encodedFiles.length > 0 && keyframesPresent < 3) issues.push('keyframes-missing')
    if (routine.notes) issues.push('operator-note')
    if (routine.status === 'scratched') issues.push('scratched')

    return {
      routine,
      videosUploaded,
      videosTotal: encodedFiles.length,
      photosUploaded,
      photosTotal: photos.length,
      thumbsMissing,
      keyframesPresent,
      issues,
    }
  })

  lines.push('# CompSync Media Verification Report')
  lines.push(`Competition: ${currentCompetition.name}`)
  lines.push(`Generated: ${now.toLocaleString()}`)
  lines.push(`Routines with issues: ${issueRows.filter((row) => row.issues.length > 0).length}`)
  lines.push(`Routines with notes: ${issueRows.filter((row) => row.routine.notes).length}`)
  lines.push(`Video issues: ${issueRows.filter((row) => row.issues.includes('missing-video') || row.issues.includes('video-upload-pending')).length}`)
  lines.push(`Photo issues: ${issueRows.filter((row) => row.issues.includes('no-photos-matched') || row.issues.includes('photo-upload-pending')).length}`)
  lines.push(`Thumbnail issues: ${issueRows.filter((row) => row.issues.includes('thumbnail-missing')).length}`)
  lines.push('')
  lines.push('Entry#,Title,Studio,Status,Videos Uploaded,Photos Uploaded,Thumbs Missing,Keyframes Present,Notes,Issues')

  for (const row of issueRows) {
    lines.push([
      row.routine.entryNumber,
      csvEscape(row.routine.routineTitle),
      csvEscape(row.routine.studioName),
      row.routine.status,
      `${row.videosUploaded}/${row.videosTotal}`,
      `${row.photosUploaded}/${row.photosTotal}`,
      String(row.thumbsMissing),
      `${row.keyframesPresent}/3`,
      csvEscape(row.routine.notes || ''),
      csvEscape(row.issues.join('; ') || 'ok'),
    ].join(','))
  }

  return lines.join('\n')
}

export function cleanup(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  doSave()
}

// ── Per-camera offset API ─────────────────────────────────────────────────
// Keys are camera-body identifiers derived by photos.ts (EXIF Make+Model+
// BodySerialNumber, with a filename-prefix fallback like "P16"). Offsets
// are day-scoped — entries from prior dates are dropped on state load. The
// operator's rule (2026-04-18): per-camera offset applied silently after
// confirmation, persists for the rest of the day. Photos.ts seeds the
// detection step with the persisted offset so SD swaps don't re-learn
// from scratch when the second SD has few photos.

function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function getCameraOffset(bodyId: string): CameraOffsetEntry | null {
  const entry = cameraOffsets[bodyId]
  if (!entry) return null
  const today = localDateString(new Date())
  if (entry.date !== today) {
    delete cameraOffsets[bodyId]
    saveState()
    return null
  }
  return entry
}

export function setCameraOffset(
  bodyId: string,
  offsetMs: number,
  source: CameraOffsetEntry['source'],
): void {
  cameraOffsets[bodyId] = {
    offsetMs,
    appliedAt: new Date().toISOString(),
    date: localDateString(new Date()),
    source,
  }
  logger.app.info(`Camera offset set: body="${bodyId}" offsetMs=${offsetMs} source=${source}`)
  saveState()
}

export function listCameraOffsets(): Record<string, CameraOffsetEntry> {
  return { ...cameraOffsets }
}

export function clearCameraOffsets(): void {
  const count = Object.keys(cameraOffsets).length
  cameraOffsets = {}
  logger.app.info(`Cleared ${count} camera offset(s)`)
  saveState()
}

// ── SD watermark API ───────────────────────────────────────────────────
// Operator workflow: SDs always contain the full competition's photos. On
// each insertion we ONLY want to process photos newer than the last time
// the app saw this SD/camera body. Keyed by camera body ID (same prefix
// scheme as cameraOffsets — e.g. "P16"). Value is the latest processed
// EXIF DateTimeOriginal (ISO). This is intentionally time-based rather than
// filename-sequence-based so previous-photo skipping never depends on camera
// naming order.

export function getSdWatermark(bodyId: string): SdWatermarkEntry | null {
  return sdWatermarks[bodyId] ?? null
}

export function setSdWatermark(bodyId: string, lastCaptureTime: string, lastFilename?: string): void {
  const existing = sdWatermarks[bodyId]
  // Only bump forward — never regress a watermark on accident.
  if (existing && existing.lastCaptureTime >= lastCaptureTime) return
  sdWatermarks[bodyId] = {
    lastCaptureTime,
    lastFilename,
    setAt: new Date().toISOString(),
  }
  logger.app.info(`SD watermark set: body="${bodyId}" lastCaptureTime="${lastCaptureTime}"`)
  saveState()
}

export function setSdWatermarksBulk(
  entries: Record<string, { lastCaptureTime: string; lastFilename?: string }>,
): number {
  let updated = 0
  const now = new Date().toISOString()
  for (const [bodyId, entry] of Object.entries(entries)) {
    const existing = sdWatermarks[bodyId]
    if (existing && existing.lastCaptureTime >= entry.lastCaptureTime) continue
    sdWatermarks[bodyId] = { lastCaptureTime: entry.lastCaptureTime, lastFilename: entry.lastFilename, setAt: now }
    updated++
  }
  if (updated > 0) {
    logger.app.info(`Bulk SD watermark update: ${updated} body(ies) advanced`)
    saveState()
  }
  return updated
}

export function clearSdWatermarks(): void {
  const count = Object.keys(sdWatermarks).length
  sdWatermarks = {}
  logger.app.info(`Cleared ${count} SD watermark(s)`)
  saveState()
}

export function listSdWatermarks(): Record<string, SdWatermarkEntry> {
  return { ...sdWatermarks }
}
