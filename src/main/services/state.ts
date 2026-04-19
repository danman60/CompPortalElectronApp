import fs from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import { Competition, Routine, RoutineStatus, IPC_CHANNELS } from '../../shared/types'
import { logger } from '../logger'

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

interface PersistedState {
  competition: Competition | null
  currentRoutineId: string | null   // ID-based (was index-based)
  currentRoutineIndex?: number      // legacy — used for migration only
  savedAt: string
}

let currentCompetition: Competition | null = null
let currentRoutineId: string | null = null
let saveTimer: NodeJS.Timeout | null = null
let savePending = false

// Fix 8: Cached counts for WS broadcasts — updated incrementally
let cachedSkippedCount = 0
let cachedActiveCount = 0  // routines that are not skipped

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
  recomputeCachedCounts()

  if (data.currentRoutineId) {
    currentRoutineId = data.currentRoutineId
  } else if (data.currentRoutineIndex !== undefined && data.competition) {
    const visibleRoutines = data.competition.routines.filter(r => r.status !== 'skipped')
    const routine = visibleRoutines[data.currentRoutineIndex]
    currentRoutineId = routine?.id || null
    logger.app.info(`Migrated state from index ${data.currentRoutineIndex} to ID ${currentRoutineId}`)
  } else {
    currentRoutineId = null
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
  return currentCompetition.routines.filter(r => r.status !== 'skipped')
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
    if (r.status === 'skipped') skipped++
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
  if (allRoutine && allRoutine.status === 'skipped') {
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

  // Fix 8: Update cached counts incrementally
  if (oldStatus === 'skipped' && status !== 'skipped') {
    cachedSkippedCount--
    cachedActiveCount++
  } else if (oldStatus !== 'skipped' && status === 'skipped') {
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

  lines.push(`CompSync Media — Session Report`)
  lines.push(`Competition: ${currentCompetition.name}`)
  lines.push(`Generated: ${now.toLocaleString()}`)
  lines.push(`Source: ${currentCompetition.source}`)
  lines.push('')

  const total = currentCompetition.routines.length
  const recorded = currentCompetition.routines.filter((r) => r.status !== 'pending' && r.status !== 'skipped').length
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
    if (r.recordingStartedAt && r.recordingStoppedAt) {
      const sec = Math.round((new Date(r.recordingStoppedAt).getTime() - new Date(r.recordingStartedAt).getTime()) / 1000)
      duration = `${Math.floor(sec / 60)}m${sec % 60}s`
    }
    const csvEscape = (s: string) => s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
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

export function cleanup(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  doSave()
}
