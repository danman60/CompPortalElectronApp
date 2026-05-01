import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { logger } from '../logger'
import { getResolvedConnection } from './schedule'

/**
 * Config-driven Start-of-Day / End-of-Day checklist items.
 *
 * Items live in CompPortal so the operator (or admin) can edit them per
 * competition without an asar swap. The Electron app polls the endpoint every
 * 60s and caches the result to userData/compsync-day-checklist-items.json.
 *
 * Fallback chain on first load:
 *   1. CompPortal fetch (preferred)
 *   2. local cache file (last successful fetch)
 *   3. HARDCODED defaults (must match the lists that shipped in commit 581980b)
 *
 * Endpoint: GET <apiBase>/api/plugin/day-checklist-items?competition_id=<id>
 *   Auth: Bearer <conn.apiKey>
 *   Response: { start: ChecklistItem[], end: ChecklistItem[] }
 *   ChecklistItem = { id: string, label: string, detail?: string }
 */

export interface ChecklistItem {
  id: string
  label: string
  detail?: string
}

export interface ChecklistItems {
  start: ChecklistItem[]
  end: ChecklistItem[]
}

const FILE_NAME = 'compsync-day-checklist-items.json'
const REFRESH_INTERVAL_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000

/**
 * Hardcoded defaults. MUST match the ITEMS arrays from
 * src/renderer/components/StartOfDayModal.tsx and EndOfDayModal.tsx as of
 * commit 581980b (the modal-copy rewrite). Update both sides if these change.
 */
const DEFAULTS: ChecklistItems = {
  start: [
    { id: 'stream-live', label: 'Start the live stream (OBS) ~half hour to show' },
    { id: 'tvs-on', label: 'TVs on → app bookmark 5 (stream must be live first)' },
    { id: 'cameras', label: 'Set up cameras' },
    { id: 'streamdeck', label: 'Stream Deck app running' },
    { id: 'judge-backup', label: 'Judge backup audio recording' },
  ],
  end: [
    { id: 'awards-done', label: 'Wait for awards to finish' },
    { id: 'stream-off', label: 'Turn off stream' },
    { id: 'cameras-off', label: 'Turn off cameras' },
    { id: 'mevos-charging', label: 'Charge Mevos & power banks', detail: 'Verify blinking lights on BOTH power banks and Mevos' },
    { id: 'mevos-off', label: 'Turn off Mevos', detail: 'Press and hold back button until you hear the power-off sound' },
  ],
}

let cache: ChecklistItems | null = null
let pollTimer: NodeJS.Timeout | null = null

function getFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function loadFromDisk(): ChecklistItems | null {
  const p = getFilePath()
  try {
    if (!fs.existsSync(p)) return null
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as ChecklistItems
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.start) &&
      Array.isArray(parsed.end)
    ) {
      return parsed
    }
    return null
  } catch (err) {
    logger.app.warn(`dayChecklistItems: failed to read ${p}: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

function saveToDisk(items: ChecklistItems): void {
  const p = getFilePath()
  try {
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2))
    fs.renameSync(tmp, p)
  } catch (err) {
    logger.app.warn(`dayChecklistItems: failed to save ${p}: ${err instanceof Error ? err.message : err}`)
  }
}

function validateResponse(data: unknown): ChecklistItems | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  if (!Array.isArray(obj.start) || !Array.isArray(obj.end)) return null
  const validate = (arr: unknown[]): ChecklistItem[] | null => {
    const out: ChecklistItem[] = []
    for (const it of arr) {
      if (!it || typeof it !== 'object') return null
      const item = it as Record<string, unknown>
      if (typeof item.id !== 'string' || typeof item.label !== 'string') return null
      const ci: ChecklistItem = { id: item.id, label: item.label }
      if (typeof item.detail === 'string') ci.detail = item.detail
      out.push(ci)
    }
    return out
  }
  const start = validate(obj.start as unknown[])
  const end = validate(obj.end as unknown[])
  if (!start || !end) return null
  return { start, end }
}

/**
 * Fetch the latest items from CompPortal. Returns the parsed items on success,
 * null on any failure (network error, non-2xx, malformed body). Failures are
 * logged but never thrown.
 */
async function fetchFromPortal(): Promise<ChecklistItems | null> {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.app.debug('dayChecklistItems: no resolved connection, skipping fetch')
    return null
  }
  const url = `${conn.apiBase}/api/plugin/day-checklist-items?competition_id=${encodeURIComponent(conn.competitionId)}`
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
      },
      signal: abort.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.app.warn(`dayChecklistItems: fetch ${response.status}: ${text}`)
      return null
    }
    const data = await response.json()
    const validated = validateResponse(data)
    if (!validated) {
      logger.app.warn('dayChecklistItems: response failed validation, ignoring')
      return null
    }
    return validated
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.app.warn(`dayChecklistItems: fetch failed: ${msg}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Synchronous accessor — returns the current cached items, hydrating from disk
 * or defaults if the in-memory cache hasn't been populated yet. Never blocks.
 */
export function getItems(): ChecklistItems {
  if (cache) return cache
  const fromDisk = loadFromDisk()
  if (fromDisk) {
    cache = fromDisk
    return cache
  }
  cache = DEFAULTS
  return cache
}

/**
 * Refresh from CompPortal. On success: updates in-memory cache and persists to
 * disk. On failure: leaves existing cache intact (or hydrates from disk /
 * defaults if cache was empty).
 */
export async function refresh(): Promise<ChecklistItems> {
  const fresh = await fetchFromPortal()
  if (fresh) {
    cache = fresh
    saveToDisk(fresh)
    logger.app.info(`dayChecklistItems: refreshed from CompPortal (start=${fresh.start.length}, end=${fresh.end.length})`)
    return fresh
  }
  // Fetch failed — make sure we have *something* loaded.
  return getItems()
}

/**
 * Boot the background poller. Idempotent — safe to call multiple times.
 * First refresh runs immediately (best-effort), subsequent polls every 60s.
 */
export function startPolling(): void {
  if (pollTimer) return
  // Fire-and-forget initial refresh.
  refresh().catch(() => { /* logged in refresh */ })
  pollTimer = setInterval(() => {
    refresh().catch(() => { /* logged in refresh */ })
  }, REFRESH_INTERVAL_MS)
  // Don't keep the process alive solely for this timer.
  if (pollTimer.unref) pollTimer.unref()
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** Test-only reset. */
export function _resetForTests(): void {
  cache = null
  stopPolling()
}
