import fs from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import {
  DayChecklistKind,
  DayChecklistItemState,
  DayChecklistDayState,
  DayChecklistPersistedState,
  DayChecklistShowEvent,
  IPC_CHANNELS,
  Routine,
} from '../../shared/types'
import { logger } from '../logger'
import * as state from './state'

/**
 * Start-of-Day / End-of-Day checklist modals. See INBOX entry
 * "startup + shutdown day-checklist modals" for the verbatim spec.
 *
 * Persistence lives in its own JSON (compsync-day-checklist.json) in userData
 * to keep this concern out of compsync-state.json and compsync-media-settings.json
 * (both freshly deployed). Never wipes or overwrites those files.
 */

const FILE_NAME = 'compsync-day-checklist.json'

/** Local YYYY-MM-DD in operator-local time (never UTC). */
function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function stateKey(date: string, kind: DayChecklistKind): string {
  return `${date}|${kind}`
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

let cache: DayChecklistPersistedState | null = null

function load(): DayChecklistPersistedState {
  if (cache) return cache
  const p = getFilePath()
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw) as DayChecklistPersistedState
      if (parsed && typeof parsed === 'object' && parsed.days) {
        cache = parsed
        return cache
      }
    }
  } catch (err) {
    logger.app.warn(`dayChecklist: failed to read ${p}: ${err instanceof Error ? err.message : err}`)
  }
  cache = { days: {} }
  return cache
}

function save(): void {
  if (!cache) return
  const p = getFilePath()
  try {
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2))
    fs.renameSync(tmp, p)
  } catch (err) {
    logger.app.error(`dayChecklist: failed to save ${p}: ${err instanceof Error ? err.message : err}`)
  }
}

function getOrCreateDay(date: string, kind: DayChecklistKind, scheduledDay: string | null): DayChecklistDayState {
  const s = load()
  const k = stateKey(date, kind)
  const existing = s.days[k]
  if (existing) return existing
  const fresh: DayChecklistDayState = {
    date,
    scheduledDay,
    items: {},
    autoDismissed: false,
    autoShownAt: 0,
    lastUpdatedAt: Date.now(),
  }
  s.days[k] = fresh
  save()
  return fresh
}

function broadcastShow(ev: DayChecklistShowEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.DAY_CHECKLIST_SHOW, ev)
    }
  }
}

/** Public: renderer asks for the state for a given date/kind. */
export function getDayState(date: string, kind: DayChecklistKind): DayChecklistDayState {
  const s = load()
  const k = stateKey(date, kind)
  return (
    s.days[k] ?? {
      date,
      scheduledDay: null,
      items: {},
      autoDismissed: false,
      autoShownAt: 0,
      lastUpdatedAt: 0,
    }
  )
}

export function setItemState(
  date: string,
  kind: DayChecklistKind,
  itemId: string,
  value: DayChecklistItemState,
): DayChecklistDayState {
  const day = getOrCreateDay(date, kind, null)
  day.items[itemId] = value
  day.lastUpdatedAt = Date.now()
  save()
  return day
}

export function markDismissed(date: string, kind: DayChecklistKind): DayChecklistDayState {
  const day = getOrCreateDay(date, kind, null)
  day.autoDismissed = true
  day.lastUpdatedAt = Date.now()
  save()
  return day
}

/** Manual re-open from Settings buttons. Doesn't flip autoDismissed. */
export function manualReopen(kind: DayChecklistKind): DayChecklistShowEvent {
  const date = todayKey()
  const sched = deriveScheduledDayForKind(kind)
  const day = getOrCreateDay(date, kind, sched)
  if (!day.scheduledDay && sched) {
    day.scheduledDay = sched
    save()
  }
  const ev: DayChecklistShowEvent = { kind, date, scheduledDay: day.scheduledDay, source: 'manual' }
  broadcastShow(ev)
  return ev
}

/**
 * Decide today's scheduledDay. For start-of-day: the scheduledDay of the first
 * pending routine (what we're about to record). For end-of-day: the
 * scheduledDay of the most recently finished routine. Falls back to the
 * currentRoutine if ambiguous, else null.
 */
function deriveScheduledDayForKind(kind: DayChecklistKind): string | null {
  const comp = state.getCompetition()
  if (!comp) return null
  const routines = comp.routines
  if (kind === 'start') {
    const nextPending = routines.find((r) => r.status === 'pending')
    if (nextPending?.scheduledDay) return nextPending.scheduledDay
    const cur = state.getCurrentRoutine()
    return cur?.scheduledDay || null
  }
  // end
  const finished = routines.filter(
    (r) => r.status === 'recorded' || r.status === 'encoded' || r.status === 'encoding' ||
           r.status === 'queued' || r.status === 'uploading' || r.status === 'uploaded' ||
           r.status === 'confirmed',
  )
  const last = finished[finished.length - 1]
  if (last?.scheduledDay) return last.scheduledDay
  const cur = state.getCurrentRoutine()
  return cur?.scheduledDay || null
}

/**
 * Routines a start-of-day modal should count against. Skipped routines don't
 * count as "first of the day" — we care about what the operator is about to
 * record. A day with zero pending routines returns an empty array.
 */
function pendingRoutinesForDay(routines: Routine[], day: string): Routine[] {
  return routines.filter((r) => r.scheduledDay === day && r.status === 'pending')
}

/**
 * Routines that live on `day` and are not skipped. Used for end-of-day: the
 * "last routine" is the last non-skipped one regardless of whether it finished
 * as recorded / encoded / uploaded.
 */
function allRoutinesForDay(routines: Routine[], day: string): Routine[] {
  return routines.filter((r) => r.scheduledDay === day && r.status !== 'skipped')
}

/**
 * Start-of-day trigger. Called once on app start (after schedule is loaded).
 *
 * Fires iff:
 *   - there's a pending routine whose scheduledDay is today's scheduledDay, AND
 *   - NO routine for that scheduledDay has been recorded yet (status recorded+), AND
 *   - we haven't already auto-dismissed today's start modal.
 *
 * If the operator already recorded even one routine for the day, we assume
 * they saw and handled startup already — don't nag.
 */
export function maybeFireStartOfDay(): void {
  const comp = state.getCompetition()
  if (!comp || comp.routines.length === 0) return

  const date = todayKey()
  const existing = load().days[stateKey(date, 'start')]
  if (existing?.autoDismissed) return
  if (existing?.autoShownAt && Date.now() - existing.autoShownAt < 5 * 60 * 1000) {
    // Already shown in the last 5 minutes — don't re-spam.
    return
  }

  // Find the scheduledDay of the next pending routine — that's "today" for
  // the competition. If there's no pending routine, nothing to check in for.
  const nextPending = comp.routines.find((r) => r.status === 'pending')
  if (!nextPending) return

  const sched = nextPending.scheduledDay
  if (!sched) {
    // No scheduledDay at all — still fire if there's a pending routine, so the
    // operator gets reminded. Use null as scheduledDay in state.
  }

  const dayRoutines = allRoutinesForDay(comp.routines, sched || '')
  const pendingDay = pendingRoutinesForDay(comp.routines, sched || '')
  const alreadyRecorded = dayRoutines.some((r) => {
    const s = r.status
    return (
      s === 'recorded' || s === 'encoding' || s === 'encoded' || s === 'queued' ||
      s === 'uploading' || s === 'uploaded' || s === 'confirmed'
    )
  })

  if (alreadyRecorded) {
    logger.app.info(`dayChecklist: start-of-day suppressed — routine already recorded for ${sched || '(no day)'}`)
    return
  }
  if (pendingDay.length === 0) {
    logger.app.info('dayChecklist: start-of-day suppressed — no pending routines for current day')
    return
  }

  const day = getOrCreateDay(date, 'start', sched || null)
  day.autoShownAt = Date.now()
  save()

  logger.app.info(`dayChecklist: firing start-of-day modal (date=${date}, scheduledDay=${sched || 'n/a'}, pending=${pendingDay.length})`)
  broadcastShow({ kind: 'start', date, scheduledDay: sched || null, source: 'auto' })
}

/**
 * End-of-day trigger. Called after a routine transitions to 'recorded'. If
 * that routine was the LAST routine of its scheduledDay (no more pending,
 * no earlier pending either — skipped don't count), fire the modal.
 */
export function maybeFireEndOfDay(justRecorded: Routine): void {
  const comp = state.getCompetition()
  if (!comp) return
  const sched = justRecorded.scheduledDay
  if (!sched) {
    // Without a scheduledDay we can't know if it was last. Skip silently.
    return
  }
  const date = todayKey()
  const existing = load().days[stateKey(date, 'end')]
  if (existing?.autoDismissed) return
  if (existing?.autoShownAt && Date.now() - existing.autoShownAt < 5 * 60 * 1000) {
    return
  }

  const dayRoutines = allRoutinesForDay(comp.routines, sched)
  const stillPending = dayRoutines.filter((r) => r.status === 'pending' || r.status === 'recording' || r.status === 'recording_interrupted')
  if (stillPending.length > 0) {
    // Not the last — more to record.
    return
  }

  const day = getOrCreateDay(date, 'end', sched)
  day.autoShownAt = Date.now()
  save()

  logger.app.info(`dayChecklist: firing end-of-day modal (date=${date}, scheduledDay=${sched}, day had ${dayRoutines.length} routines)`)
  broadcastShow({ kind: 'end', date, scheduledDay: sched, source: 'auto' })
}

/** Clear cache — used by tests; no-op in prod. */
export function _resetForTests(): void {
  cache = null
}
