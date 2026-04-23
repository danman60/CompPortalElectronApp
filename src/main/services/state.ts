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
  return currentCompetition.routines.filter(r => !isNonPerformingStatus(r.status))
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

  const idx = getCurrentIndex()
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
}

export function unscratchedRoutine(routineId: string): void {
  updateRoutineStatus(routineId, 'pending')
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
