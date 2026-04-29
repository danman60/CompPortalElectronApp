/**
 * Phase 1.4 / 1.6 — optimistic offline-first sync.
 *
 * Mechanism:
 *   1. On boot (after competition is loaded + connection resolved), call
 *      GET /api/plugin/comp-fingerprint?compId=X on CompPortal.
 *   2. Compare returned hash against the last-known hash cached locally
 *      in `comp-state-fingerprint.json`.
 *   3. Equal → trust local state, resume queue normally. No UI.
 *   4. Different → emit COMP_STATE_DRIFT_DETECTED with the new hash + the
 *      lastDbWriteAt timestamp. Renderer shows banner with [Refresh] / [Skip].
 *      Queue is NOT auto-deferred (queue start is independent); operator's
 *      Refresh path is responsible for re-pulling state + invalidating jobs.
 *   5. On Refresh, renderer fires COMP_STATE_DRIFT_REFRESH_REQUEST → main
 *      re-pulls comp state from CompPortal and bumps the local fingerprint.
 *      Emits COMP_STATE_DRIFT_RESOLVED on success.
 *
 * Server endpoint contract (CompPortal owes — see CompPortal/INBOX.md):
 *   GET /api/plugin/comp-fingerprint?compId=<uuid>
 *   Auth: Bearer <api-key> (same as other plugin endpoints)
 *   Response: { hash: string, lastDbWriteAt: ISO8601 }
 *   `hash` is server-computed from per-routine fields:
 *     (routine_id, status, scratched_at, photo_count, video_uploaded_at,
 *      entry_number) concatenated + SHA-256.
 *
 * Until CompPortal lands the endpoint, the feature is gated behind
 * settings.behavior.compStateDriftCheck (default false). When the endpoint
 * exists, operator flips the toggle and drift detection activates.
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import { getResolvedConnection } from './schedule'
import { getSettings } from './settings'
import * as state from './state'

const FINGERPRINT_FILE = 'comp-state-fingerprint.json'
const FETCH_TIMEOUT_MS = 8000

interface CachedFingerprint {
  competitionId: string
  hash: string
  lastDbWriteAt: string
  cachedAt: string
}

interface ServerFingerprint {
  hash: string
  lastDbWriteAt: string
}

let pendingDrift: { hash: string; lastDbWriteAt: string } | null = null

function fingerprintPath(): string {
  return path.join(app.getPath('userData'), FINGERPRINT_FILE)
}

function loadCached(): CachedFingerprint | null {
  try {
    const fp = fingerprintPath()
    if (!fs.existsSync(fp)) return null
    const raw = fs.readFileSync(fp, 'utf-8')
    return JSON.parse(raw) as CachedFingerprint
  } catch (err) {
    logger.app.warn(`compStateSync: failed to read cached fingerprint: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

function saveCached(competitionId: string, hash: string, lastDbWriteAt: string): void {
  try {
    const cached: CachedFingerprint = {
      competitionId,
      hash,
      lastDbWriteAt,
      cachedAt: new Date().toISOString(),
    }
    fs.writeFileSync(fingerprintPath(), JSON.stringify(cached, null, 2), 'utf-8')
  } catch (err) {
    logger.app.warn(`compStateSync: failed to write fingerprint cache: ${err instanceof Error ? err.message : err}`)
  }
}

async function fetchServerFingerprint(): Promise<ServerFingerprint | null> {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.app.debug('compStateSync: no resolved CompPortal connection — skipping')
    return null
  }
  const url = `${conn.apiBase}/api/plugin/comp-fingerprint?compId=${encodeURIComponent(conn.competitionId)}`
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${conn.apiKey}` },
      signal: abort.signal,
    })
    if (!response.ok) {
      // 404 expected until CompPortal lands the endpoint — log debug, not warn.
      const text = await response.text().catch(() => '')
      if (response.status === 404) {
        logger.app.debug(`compStateSync: ${url} → 404 (endpoint not yet on CompPortal)`)
      } else {
        logger.app.warn(`compStateSync: ${url} → ${response.status}: ${text}`)
      }
      return null
    }
    const data = await response.json() as Record<string, unknown>
    if (typeof data.hash !== 'string' || typeof data.lastDbWriteAt !== 'string') {
      logger.app.warn(`compStateSync: malformed response: ${JSON.stringify(data)}`)
      return null
    }
    return { hash: data.hash, lastDbWriteAt: data.lastDbWriteAt }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.app.warn(`compStateSync: fetch failed: ${msg}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Boot-time drift check. Call after competition is loaded + connection resolved.
 *
 * - Feature-flag gated. If settings.behavior.compStateDriftCheck === false,
 *   this is a no-op.
 * - Network failure / 404 / malformed = silent skip (no banner). Drift detection
 *   is best-effort; never blocks the app.
 * - First-ever check = treat as match (cache the server hash and proceed).
 */
export async function checkOnBoot(): Promise<void> {
  const settings = getSettings()
  if (!settings?.behavior?.compStateDriftCheck) {
    logger.app.debug('compStateSync: disabled via settings — skipping')
    return
  }
  const comp = state.getCompetition()
  const conn = getResolvedConnection()
  if (!comp || !conn) {
    logger.app.debug('compStateSync: no competition or connection — skipping')
    return
  }
  const server = await fetchServerFingerprint()
  if (!server) return // 404 / network error / disabled — silent

  const cached = loadCached()
  if (!cached || cached.competitionId !== conn.competitionId) {
    // First-ever check OR competition changed — establish baseline silently.
    saveCached(conn.competitionId, server.hash, server.lastDbWriteAt)
    logger.app.info(`compStateSync: baseline fingerprint cached (hash=${server.hash.slice(0, 8)}…)`)
    return
  }
  if (cached.hash === server.hash) {
    logger.app.info('compStateSync: server state unchanged since last close')
    return
  }
  // Drift detected.
  pendingDrift = { hash: server.hash, lastDbWriteAt: server.lastDbWriteAt }
  logger.app.warn(
    `compStateSync: drift detected — local hash=${cached.hash.slice(0, 8)}…, server hash=${server.hash.slice(0, 8)}…, server lastDbWriteAt=${server.lastDbWriteAt}`,
  )
  sendToRenderer(IPC_CHANNELS.COMP_STATE_DRIFT_DETECTED, {
    serverLastDbWriteAt: server.lastDbWriteAt,
    cachedLastDbWriteAt: cached.lastDbWriteAt,
  })
}

/**
 * Operator clicked Refresh in the drift banner. Re-pull the latest comp state
 * from CompPortal (whatever the existing schedule/comp-load path is) and bump
 * the local fingerprint cache to match.
 *
 * Right now the comp-load path is in the renderer (via shareCode resolution).
 * For Phase 1.4 we don't auto-trigger that — instead we tell the renderer to
 * trigger its existing reload flow, then bump the cache when the new state
 * lands. Done as a request/resolve handshake.
 */
export async function applyRefresh(): Promise<void> {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.app.warn('compStateSync.applyRefresh: no resolved connection')
    return
  }
  if (!pendingDrift) {
    logger.app.debug('compStateSync.applyRefresh: no pending drift — nothing to do')
    return
  }
  saveCached(conn.competitionId, pendingDrift.hash, pendingDrift.lastDbWriteAt)
  logger.app.info(
    `compStateSync: fingerprint refreshed (hash=${pendingDrift.hash.slice(0, 8)}…) — operator acknowledged drift`,
  )
  pendingDrift = null
  sendToRenderer(IPC_CHANNELS.COMP_STATE_DRIFT_RESOLVED, { ok: true })
}

/**
 * Operator clicked Skip in the drift banner. Mark the drift as acknowledged
 * for THIS session only — same boot won't re-prompt, but next boot will
 * re-detect. The cached fingerprint is intentionally NOT bumped, so the drift
 * stays detectable across restarts until the operator explicitly refreshes.
 */
export function dismissForSession(): void {
  if (pendingDrift) {
    logger.app.info('compStateSync: drift dismissed for session (next boot will re-prompt)')
  }
  pendingDrift = null
  sendToRenderer(IPC_CHANNELS.COMP_STATE_DRIFT_RESOLVED, { ok: false, dismissed: true })
}
