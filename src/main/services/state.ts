import fs from 'fs'
import path from 'path'
import { Competition, Routine, RoutineStatus } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'

const STATE_FILE = 'compsync-state.json'

interface PersistedState {
  competition: Competition | null
  currentRoutineIndex: number
  savedAt: string
}

let currentCompetition: Competition | null = null
let currentRoutineIndex = 0

function getStatePath(): string {
  const settings = getSettings()
  const outputDir = settings.fileNaming.outputDirectory
  if (outputDir) {
    return path.join(outputDir, STATE_FILE)
  }
  // Fallback to current dir
  return STATE_FILE
}

export function saveState(): void {
  if (!currentCompetition) return

  const statePath = getStatePath()
  const state: PersistedState = {
    competition: currentCompetition,
    currentRoutineIndex,
    savedAt: new Date().toISOString(),
  }

  try {
    const dir = path.dirname(statePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    logger.app.debug(`State saved to ${statePath}`)
  } catch (err) {
    logger.app.error('Failed to save state:', err)
  }
}

export function loadState(): PersistedState | null {
  const statePath = getStatePath()
  try {
    if (fs.existsSync(statePath)) {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      logger.app.info(`State loaded from ${statePath}`)
      currentCompetition = data.competition
      currentRoutineIndex = data.currentRoutineIndex || 0
      return data
    }
  } catch (err) {
    logger.app.error('Failed to load state:', err)
  }
  return null
}

export function setCompetition(comp: Competition): void {
  currentCompetition = comp
  currentRoutineIndex = 0

  // Try to restore routine states from persisted state
  const existing = loadState()
  if (existing?.competition?.competitionId === comp.competitionId) {
    // Merge statuses from persisted state
    let matchedCount = 0
    for (const routine of comp.routines) {
      const persisted = existing.competition.routines.find((r) => r.id === routine.id)
      if (persisted) {
        routine.status = persisted.status
        routine.recordingStartedAt = persisted.recordingStartedAt
        routine.recordingStoppedAt = persisted.recordingStoppedAt
        routine.outputPath = persisted.outputPath
        routine.encodedFiles = persisted.encodedFiles
        routine.photos = persisted.photos
        routine.uploadProgress = persisted.uploadProgress
        matchedCount++
      }
    }
    currentRoutineIndex = existing.currentRoutineIndex
    logger.app.info(`Restored state for ${comp.name}, index ${currentRoutineIndex}, ${matchedCount}/${comp.routines.length} routines matched`)
    if (matchedCount === 0 && existing.competition.routines.length > 0) {
      logger.app.warn(`No routine IDs matched — routine IDs may have changed. All progress reset to pending.`)
    } else if (matchedCount < comp.routines.length) {
      logger.app.warn(`${comp.routines.length - matchedCount} routines had no persisted state (new or changed IDs)`)
    }
  }

  saveState()
}

export function getCompetition(): Competition | null {
  return currentCompetition
}

export function getCurrentRoutine(): Routine | null {
  if (!currentCompetition) return null
  const visibleRoutines = currentCompetition.routines.filter((r) => r.status !== 'skipped')
  return visibleRoutines[currentRoutineIndex] || null
}

export function getCurrentRoutineIndex(): number {
  return currentRoutineIndex
}

export function getNextRoutine(): Routine | null {
  if (!currentCompetition) return null
  const visibleRoutines = currentCompetition.routines.filter((r) => r.status !== 'skipped')
  return visibleRoutines[currentRoutineIndex + 1] || null
}

export function advanceToNext(): Routine | null {
  if (!currentCompetition) return null
  const visibleRoutines = currentCompetition.routines.filter((r) => r.status !== 'skipped')
  if (currentRoutineIndex < visibleRoutines.length - 1) {
    currentRoutineIndex++
    saveState()
    return visibleRoutines[currentRoutineIndex]
  }
  return null
}

export function goToPrev(): Routine | null {
  if (!currentCompetition) return null
  if (currentRoutineIndex > 0) {
    currentRoutineIndex--
    saveState()
    const visibleRoutines = currentCompetition.routines.filter((r) => r.status !== 'skipped')
    return visibleRoutines[currentRoutineIndex]
  }
  return null
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

  logger.app.info(`Routine ${routine.entryNumber} "${routine.routineTitle}": ${oldStatus} → ${status}`)
  saveState()
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
