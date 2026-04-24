import os from 'os'
import log, { logger } from '../logger'
import * as state from './state'
import { getResolvedConnection } from './schedule'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type LogSource = 'main' | 'wifi-display' | 'tether' | 'tablet' | string

export interface LogEvent {
  ts: string
  level: LogLevel
  source: LogSource
  message: string
}

const BUFFER_CAP = 1000
const POST_INTERVAL_MS = 3000
const BATCH_MAX = 200
const BACKOFF_BASE_MS = 6000
const BACKOFF_MAX_MS = 60000
const REQUEST_TIMEOUT_MS = 15000

const buffer: LogEvent[] = []
let postTimer: NodeJS.Timeout | null = null
let inFlight = false
let inHook = false
let consecutiveFailures = 0
let nextAllowedPostAt = 0
let failureLoggedForSeries = false
let started = false

function normalizeLevel(raw: string): LogLevel {
  const s = (raw || '').toLowerCase()
  if (s === 'error' || s === 'err') return 'error'
  if (s === 'warn' || s === 'warning') return 'warn'
  if (s === 'debug') return 'debug'
  if (s === 'fatal') return 'fatal'
  if (s === 'verbose' || s === 'silly') return 'debug'
  return 'info'
}

function classifySource(message: string): LogSource {
  if (message.startsWith('[wifi-display]')) return 'wifi-display'
  if (message.startsWith('[tablet:') || message.startsWith('[tablet]')) return 'tablet'
  if (message.startsWith('[tether]')) return 'tether'
  return 'main'
}

export function recordLogEvent(entry: LogEvent): void {
  try {
    if (!entry || typeof entry.message !== 'string') return
    buffer.push(entry)
    while (buffer.length > BUFFER_CAP) {
      buffer.shift()
    }
  } catch {
  }
}

export function drainForPost(max: number = BATCH_MAX): LogEvent[] {
  const count = Math.min(max, buffer.length)
  if (count <= 0) return []
  return buffer.splice(0, count)
}

export function restoreAfterFailure(events: LogEvent[]): void {
  if (!Array.isArray(events) || events.length === 0) return
  const merged = events.concat(buffer)
  const overflow = merged.length - BUFFER_CAP
  const trimmed = overflow > 0 ? merged.slice(overflow) : merged
  buffer.length = 0
  for (const e of trimmed) buffer.push(e)
}

function withTimeout(ms: number): AbortController {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller
}

function applyBackoff(): void {
  consecutiveFailures++
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1), BACKOFF_MAX_MS)
  nextAllowedPostAt = Date.now() + delay
}

function clearBackoff(): void {
  consecutiveFailures = 0
  nextAllowedPostAt = 0
  failureLoggedForSeries = false
}

async function postBatch(): Promise<void> {
  if (inFlight) return
  if (Date.now() < nextAllowedPostAt) return
  const conn = getResolvedConnection()
  if (!conn) return
  if (buffer.length === 0) return
  const events = drainForPost(BATCH_MAX)
  if (events.length === 0) return
  inFlight = true
  const controller = withTimeout(REQUEST_TIMEOUT_MS)
  try {
    const comp = state.getCompetition()
    const response = await fetch(`${conn.apiBase}/api/plugin/control-room/logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body: JSON.stringify({
        hostId: os.hostname(),
        competitionId: comp?.competitionId || null,
        events,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      restoreAfterFailure(events)
      if (!failureLoggedForSeries) {
        failureLoggedForSeries = true
        inHook = true
        try {
          logger.app.warn(`log streamer POST ${response.status}: backing off`)
        } finally {
          inHook = false
        }
      }
      applyBackoff()
      return
    }
    clearBackoff()
  } catch (err) {
    restoreAfterFailure(events)
    if (!failureLoggedForSeries) {
      failureLoggedForSeries = true
      const msg = err instanceof Error ? err.message : String(err)
      inHook = true
      try {
        logger.app.warn(`log streamer POST failed: ${msg}`)
      } finally {
        inHook = false
      }
    }
    applyBackoff()
  } finally {
    inFlight = false
  }
}

function installLogHook(): void {
  const transport = (message: { date: Date; level: string; scope?: string; data: any[] }) => {
    if (inHook) return
    inHook = true
    try {
      const parts: string[] = []
      for (const item of message.data || []) {
        if (item instanceof Error) {
          parts.push(item.stack || item.message)
        } else if (typeof item === 'string') {
          parts.push(item)
        } else {
          try { parts.push(JSON.stringify(item)) } catch { parts.push(String(item)) }
        }
      }
      const text = parts.join(' ')
      recordLogEvent({
        ts: (message.date instanceof Date ? message.date : new Date()).toISOString(),
        level: normalizeLevel(message.level),
        source: classifySource(text),
        message: message.scope ? `[${message.scope}] ${text}` : text,
      })
    } catch {
    } finally {
      inHook = false
    }
  }
  ;(transport as any).level = 'debug'
  ;(transport as any).transforms = []
  ;(log.transports as Record<string, unknown>).streamer = transport
}

function recordFatalFromHandler(prefix: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err)
    recordLogEvent({
      ts: new Date().toISOString(),
      level: 'fatal',
      source: 'main',
      message: `${prefix} ${msg}`,
    })
  } catch {
  }
}

export function startLogStreamer(): void {
  if (started) return
  started = true
  installLogHook()
  process.on('uncaughtException', (err) => {
    recordFatalFromHandler('uncaughtException:', err)
  })
  process.on('unhandledRejection', (reason) => {
    recordFatalFromHandler('unhandledRejection:', reason)
  })
  postTimer = setInterval(() => {
    void postBatch()
  }, POST_INTERVAL_MS)
}

export function stopLogStreamer(): void {
  if (postTimer) {
    clearInterval(postTimer)
    postTimer = null
  }
  started = false
}
