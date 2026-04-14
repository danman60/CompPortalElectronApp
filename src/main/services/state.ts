import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { Competition, Routine, RoutineStatus } from '../../shared/types'
import { logger } from '../logger'

const STATE_FILE = 'compsync-state.json'

// Media loss prevention — reconcile pass gate.
// First deployment runs in dry-run mode: logs intended demotes but never mutates
// local routine status. Flip to false after verifying reconcile logs on a real
// competition load. A backup snapshot of compsync-state.json is written BEFORE
// any mutation when this is false.
const RECONCILE_DRY_RUN = true

interface PersistedState {
  competition: Competition | null
  currentRoutineId: string | null   // ID-based (was index-based)
  currentRoutineIndex?: number      // legacy — used for migration only
  savedAt: string
}

let currentCompetition: Competition | null = null
let currentRoutineId: string | null = null
let saveTimer: NodeJS.Timeout | null = null

// Fix 8: Cached counts for WS broadcasts — updated incrementally
let cachedSkippedCount = 0
let cachedActiveCount = 0  // routines that are not skipped

function getStatePath(): string {
  // Keep operator session state in app userData so changing media output directories
  // does not silently switch the persisted competition/session file.
  return path.join(app.getPath('userData'), STATE_FILE)
}

// --- Persistence (debounced + atomic) ---

/** Debounced save — 500ms. For critical moments use saveStateImmediate(). */
export function saveState(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    doSave()
  }, 500)
}

/** Immediate flush for critical transitions (recording start/stop, app closing). */
export function saveStateImmediate(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
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
  } catch (err) {
    logger.app.error('Failed to save state:', err)
  }
}

export function loadState(): PersistedState | null {
  const statePath = getStatePath()
  try {
    if (fs.existsSync(statePath)) {
      const data: PersistedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      logger.app.info(`State loaded from ${statePath}`)
      currentCompetition = data.competition
      recomputeCachedCounts()

      // Migrate from index-based to ID-based
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

      return data
    }
  } catch (err) {
    logger.app.error('Failed to load state:', err)
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

    // Restore current routine by ID (migrated or native)
    if (currentRoutineId) {
      const found = comp.routines.find(r => r.id === currentRoutineId)
      if (!found) {
        logger.app.warn(`Persisted current routine ID ${currentRoutineId} not found in loaded competition`)
        currentRoutineId = null
      }
    }

    logger.app.info(`Restored state for ${comp.name}, currentId=${currentRoutineId}, ${matchedCount}/${comp.routines.length} routines matched`)
    if (matchedCount === 0 && existing.competition.routines.length > 0) {
      logger.app.warn(`No routine IDs matched — routine IDs may have changed. All progress reset to pending.`)
    } else if (matchedCount < comp.routines.length) {
      logger.app.warn(`${comp.routines.length - matchedCount} routines had no persisted state (new or changed IDs)`)
    }
  }

  // Default to first routine if none set
  if (!currentRoutineId && comp.routines.length > 0) {
    const visible = comp.routines.filter(r => r.status !== 'skipped')
    if (visible.length > 0) currentRoutineId = visible[0].id
  }

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
  if (status === 'recording' || oldStatus === 'recording') {
    saveStateImmediate()
  } else {
    saveState()
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
