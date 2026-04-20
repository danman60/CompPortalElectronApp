/**
 * Structured event emitter for remote debugging.
 *
 * Every meaningful state transition in the app emits a structured JSON event
 * to `events.log` (newline-delimited JSON, append-only, no rotation). Pairs
 * with the `/debug/*` HTTP endpoints to give Claude (or any operator) a
 * complete forensic timeline after an incident — without needing to parse
 * main.log or guess from side effects.
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

function getPath(): string {
  if (eventsPath) return eventsPath
  eventsPath = path.join(app.getPath('userData'), 'logs', 'events.log')
  return eventsPath
}

/**
 * Ring buffer — most recent N events in memory. Served by /debug/events to
 * avoid having to parse events.log from disk on every request.
 */
const RECENT_RING_SIZE = 2000
const recentEvents: Array<{ t: string; kind: string; data: EventPayload }> = []

export function emit(kind: string, data: EventPayload = {}): void {
  const t = new Date().toISOString()
  const record = { t, kind, data }
  recentEvents.push(record)
  if (recentEvents.length > RECENT_RING_SIZE) recentEvents.shift()

  if (writeFailures >= MAX_WRITE_FAILURES_BEFORE_QUIET) return

  try {
    const line = JSON.stringify(record) + '\n'
    fs.appendFile(getPath(), line, (err) => {
      if (err) {
        writeFailures++
        if (writeFailures === MAX_WRITE_FAILURES_BEFORE_QUIET) {
          logger.app.warn(`events.ts: ${writeFailures} write failures — muting further warnings`)
        }
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
