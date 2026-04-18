// Lightweight perf telemetry — aggregates counters/timings/sizes across a
// rolling window and writes one JSONL row per minute to logs/perf.log. Add
// hooks via counter/timing/size/gauge from hot paths; cost per call is a
// couple of object-property writes (no allocation in the steady state).
//
// Read back with: `jq . logs/perf.log` or pipe to a TSV for graphing.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { app } from 'electron'
import { logger } from '../logger'

const FLUSH_INTERVAL_MS = 60_000
const MAX_FILE_BYTES = 20 * 1024 * 1024 // 20MB — rotate once per show is fine
const FILE_NAME = 'perf.log'

type TimingAgg = { count: number; totalMs: number; maxMs: number }
type SizeAgg = { count: number; totalBytes: number; maxBytes: number }

const counters: Record<string, number> = {}
const timings: Record<string, TimingAgg> = {}
const sizes: Record<string, SizeAgg> = {}
const gauges: Record<string, { last: number; min: number; max: number; sum: number; count: number }> = {}

let flushTimer: NodeJS.Timeout | null = null
let windowStart = Date.now()
let logPath = ''

export function counter(name: string, delta = 1): void {
  counters[name] = (counters[name] || 0) + delta
}

export function timing(name: string, ms: number): void {
  const t = timings[name] || (timings[name] = { count: 0, totalMs: 0, maxMs: 0 })
  t.count++
  t.totalMs += ms
  if (ms > t.maxMs) t.maxMs = ms
}

export function size(name: string, bytes: number): void {
  const s = sizes[name] || (sizes[name] = { count: 0, totalBytes: 0, maxBytes: 0 })
  s.count++
  s.totalBytes += bytes
  if (bytes > s.maxBytes) s.maxBytes = bytes
}

export function gauge(name: string, value: number): void {
  const g = gauges[name] || (gauges[name] = { last: value, min: value, max: value, sum: 0, count: 0 })
  g.last = value
  if (value < g.min) g.min = value
  if (value > g.max) g.max = value
  g.sum += value
  g.count++
}

// Convenience: wrap an async function to record its duration.
export async function time<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  try {
    return await fn()
  } finally {
    timing(name, Date.now() - start)
  }
}

function snapshotAndReset(): Record<string, unknown> {
  const now = Date.now()
  const windowMs = now - windowStart
  const row: Record<string, unknown> = {
    t: new Date(now).toISOString(),
    win_s: Math.round(windowMs / 1000),
    host: os.hostname(),
    pid: process.pid,
  }

  // Memory snapshot (cheap)
  const mem = process.memoryUsage()
  row.heap_mb = Math.round(mem.heapUsed / (1024 * 1024))
  row.rss_mb = Math.round(mem.rss / (1024 * 1024))
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()
  row.sys_mem_pct = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0

  if (Object.keys(counters).length) {
    row.counters = { ...counters }
    for (const k of Object.keys(counters)) delete counters[k]
  }

  if (Object.keys(timings).length) {
    const out: Record<string, { n: number; avg_ms: number; max_ms: number }> = {}
    for (const [k, v] of Object.entries(timings)) {
      out[k] = { n: v.count, avg_ms: v.count ? Math.round(v.totalMs / v.count) : 0, max_ms: v.maxMs }
      delete timings[k]
    }
    row.timings = out
  }

  if (Object.keys(sizes).length) {
    const out: Record<string, { n: number; avg_b: number; max_b: number; total_b: number }> = {}
    for (const [k, v] of Object.entries(sizes)) {
      out[k] = { n: v.count, avg_b: v.count ? Math.round(v.totalBytes / v.count) : 0, max_b: v.maxBytes, total_b: v.totalBytes }
      delete sizes[k]
    }
    row.sizes = out
  }

  if (Object.keys(gauges).length) {
    const out: Record<string, { last: number; avg: number; min: number; max: number }> = {}
    for (const [k, v] of Object.entries(gauges)) {
      out[k] = { last: v.last, avg: v.count ? Math.round(v.sum / v.count) : v.last, min: v.min, max: v.max }
      delete gauges[k]
    }
    row.gauges = out
  }

  windowStart = now
  return row
}

function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(logPath)
    if (st.size < MAX_FILE_BYTES) return
    const rotated = `${logPath}.1`
    try { fs.unlinkSync(rotated) } catch {}
    fs.renameSync(logPath, rotated)
  } catch {
    // File may not exist yet — that's fine
  }
}

function flush(): void {
  const row = snapshotAndReset()
  try {
    rotateIfNeeded()
    fs.appendFileSync(logPath, JSON.stringify(row) + '\n', 'utf8')
  } catch (err) {
    logger.app.warn(`perfLogger flush failed: ${err instanceof Error ? err.message : err}`)
  }
}

export function start(): void {
  if (flushTimer) return
  const dir = path.join(app.getPath('userData'), 'logs')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  logPath = path.join(dir, FILE_NAME)
  windowStart = Date.now()
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
  logger.app.info(`perfLogger started → ${logPath} (60s windows)`)
}

export function stop(): void {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  // Flush final window on shutdown so we don't lose the last minute.
  if (logPath) flush()
}

export function getLogPath(): string {
  return logPath
}
