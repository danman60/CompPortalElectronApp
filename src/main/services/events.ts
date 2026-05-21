/**
 * Structured event emitter for remote debugging.
 *
 * Every meaningful state transition in the app emits a structured JSON event
 * to `events.log` (newline-delimited JSON, append-only with a ~25MB size
 * roll-over to `events.log.1`). Pairs with the `/debug/*` HTTP endpoints to
 * give Claude (or any operator) a complete forensic timeline after an
 * incident — without needing to parse main.log or guess from side effects.
 *
 * Rules:
 * - Events are pure data (no functions, no circular refs). JSON.stringify-safe.
 * - No PII — R2 keys, routine IDs, entry numbers are fine; full file paths OK.
 * - Failures to write an event must NOT throw — event logging is best-effort.
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { logger } from '../logger'

type EventPayload = Record<string, unknown>

let eventsPath: string | null = null
let writeFailures = 0
const MAX_WRITE_FAILURES_BEFORE_QUIET = 5

/**
 * Size-based roll-over. Before 2026-05-15 this log grew unbounded (observed
 * 1.4GB after a long live show, one fs.appendFile per emit). At ~25MB we
 * rename events.log → events.log.1 (replacing any prior .1) and start fresh,
 * so worst-case on-disk footprint is ~50MB and the most recent timeline is
 * always intact. Best-effort: a failed rename just defers a cycle.
 */
const MAX_EVENTS_LOG_BYTES = 25 * 1024 * 1024
let currentLogBytes = -1 // -1 = not yet measured from disk
let rotating = false

function getPath(): string {
  if (eventsPath) return eventsPath
  eventsPath = path.join(app.getPath('userData'), 'logs', 'events.log')
  return eventsPath
}

function ensureLogBytesSeed(p: string): void {
  if (currentLogBytes >= 0) return
  try {
    currentLogBytes = fs.statSync(p).size
  } catch {
    currentLogBytes = 0
  }
}

function rotateIfNeeded(p: string): void {
  if (rotating || currentLogBytes < MAX_EVENTS_LOG_BYTES) return
  rotating = true
  // Optimistically reset the counter so we don't re-trigger a rename on every
  // emit while the async rename is in flight. New appends recreate events.log.
  currentLogBytes = 0
  fs.rename(p, p + '.1', () => {
    rotating = false
  })
}

/**
 * Ring buffer — most recent N events in memory. Served by /debug/events to
 * avoid having to parse events.log from disk on every request.
 */
const RECENT_RING_SIZE = 2000
const recentEvents: Array<{ t: string; kind: string; data: EventPayload }> = []

/**
 * Live emit subscriber — main/index.ts wires this to BrowserWindow fanout so
 * the renderer's EventLogPanel receives events in real-time. Single subscriber
 * (the main app window). Best-effort; never throws back into emit().
 */
type EmitListener = (record: { t: string; kind: string; data: EventPayload }) => void
let emitListener: EmitListener | null = null

export function setOnEmit(cb: EmitListener | null): void {
  emitListener = cb
}

export function emit(kind: string, data: EventPayload = {}): void {
  const t = new Date().toISOString()
  const record = { t, kind, data }
  recentEvents.push(record)
  if (recentEvents.length > RECENT_RING_SIZE) recentEvents.shift()

  if (emitListener) {
    try { emitListener(record) } catch { /* never let UI fanout break the emit */ }
  }

  if (writeFailures >= MAX_WRITE_FAILURES_BEFORE_QUIET) return

  try {
    const line = JSON.stringify(record) + '\n'
    const p = getPath()
    ensureLogBytesSeed(p)
    rotateIfNeeded(p)
    fs.appendFile(p, line, (err) => {
      if (err) {
        writeFailures++
        if (writeFailures === MAX_WRITE_FAILURES_BEFORE_QUIET) {
          logger.app.warn(`events.ts: ${writeFailures} write failures — muting further warnings`)
        }
      } else {
        currentLogBytes += Buffer.byteLength(line)
      }
    })
  } catch (err) {
    writeFailures++
  }
}

export function getRecent(limit = 500, kindFilter?: string): typeof recentEvents {
  const src = kindFilter
    ? recentEvents.filter((e) => e.kind === kindFilter || e.kind.startsWith(kindFilter + '.'))
    : recentEvents
  return src.slice(-limit)
}

/** List all unique event kinds emitted since app started. */
export function getKinds(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of recentEvents) {
    counts[e.kind] = (counts[e.kind] || 0) + 1
  }
  return counts
}
