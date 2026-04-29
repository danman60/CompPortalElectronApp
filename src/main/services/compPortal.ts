import { getResolvedConnection } from './schedule'
import { logger } from '../logger'
import * as jobQueue from './jobQueue'

const NOW_PLAYING_TIMEOUT_MS = 5000
const ROUTINE_STATUS_TIMEOUT_MS = 10000

/**
 * Fire-and-forget POST /api/plugin/now-playing for the venue TV display.
 * Recording-driven (semantic B): caller invokes this on recording start with
 * the entryId, and on recording stop / interruption / share-code reload with null.
 *
 * Idempotent on the server side. Failures are logged but never thrown — recording
 * path must not be blocked by a transient network or CompPortal hiccup.
 */
export async function postNowPlaying(entryId: string | null): Promise<void> {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.upload.debug(`postNowPlaying skipped: no resolved connection (entryId=${entryId})`)
    return
  }

  const url = `${conn.apiBase}/api/plugin/now-playing`
  const body = JSON.stringify({ competitionId: conn.competitionId, entryId })

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), NOW_PLAYING_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body,
      signal: abort.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.upload.warn(`postNowPlaying ${response.status}: ${text} (entryId=${entryId})`)
      return
    }
    logger.upload.info(`postNowPlaying OK (entryId=${entryId ?? 'null'})`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.upload.warn(`postNowPlaying failed: ${msg} (entryId=${entryId})`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A35: POST a single routine-status update to CompPortal. Used by the
 * scratch-notify job worker. Returns true on 2xx, false on any error so the
 * caller can decide retry semantics.
 *
 * Endpoint expected to exist on CompPortal side per A35 spec — until then
 * this will 404 and the job stays pending in the queue (idempotent retry).
 */
export async function postRoutineStatus(
  competitionId: string,
  entryId: string,
  status: 'scratched' | 'unscratched',
  scratchedAt?: string,
): Promise<boolean> {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.upload.debug(`postRoutineStatus skipped: no resolved connection (entryId=${entryId})`)
    return false
  }
  const url = `${conn.apiBase}/api/plugin/routine-status`
  const body: Record<string, unknown> = { competitionId, entryId, status }
  if (status === 'scratched' && scratchedAt) body.scratchedAt = scratchedAt

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ROUTINE_STATUS_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.upload.warn(
        `postRoutineStatus ${response.status}: ${text} (entryId=${entryId}, status=${status})`,
      )
      return false
    }
    logger.upload.info(`postRoutineStatus OK (entryId=${entryId}, status=${status})`)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.upload.warn(`postRoutineStatus failed: ${msg} (entryId=${entryId})`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A35: POST a bulk scratched-routines snapshot to CompPortal. Idempotent
 * backstop — runs on every share-code-resolve so the portal eventually
 * converges with CSE state even if individual scratch-notify jobs were lost.
 */
export async function postRoutineStatusBulk(
  competitionId: string,
  entries: Array<{ entryId: string; status: 'scratched' | 'unscratched'; scratchedAt?: string }>,
): Promise<boolean> {
  const conn = getResolvedConnection()
  if (!conn) return false
  const url = `${conn.apiBase}/api/plugin/routine-status-bulk`
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ROUTINE_STATUS_TIMEOUT_MS * 2)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body: JSON.stringify({ competitionId, entries }),
      signal: abort.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      logger.upload.warn(
        `postRoutineStatusBulk ${response.status}: ${text} (count=${entries.length})`,
      )
      return false
    }
    logger.upload.info(`postRoutineStatusBulk OK (count=${entries.length})`)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.upload.warn(`postRoutineStatusBulk failed: ${msg}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A35: drain pending scratch-notify jobs. Best-effort — if CompPortal is
 * unreachable, jobs stay in the queue and we'll retry on the next call.
 * Called from state.scratchRoutine / state.unscratchedRoutine after enqueue,
 * and on app boot via a periodic ticker.
 */
let scratchDrainBusy = false
export async function drainScratchNotifyQueue(): Promise<void> {
  if (scratchDrainBusy) return
  scratchDrainBusy = true
  try {
    while (true) {
      const job = jobQueue.getNext('scratch-notify')
      if (!job) break
      const payload = job.payload as {
        competitionId: string
        entryId: string
        status: 'scratched' | 'unscratched'
        scratchedAt?: string
      }
      jobQueue.updateStatus(job.id, 'running')
      const ok = await postRoutineStatus(
        payload.competitionId,
        payload.entryId,
        payload.status,
        payload.scratchedAt,
      )
      if (ok) {
        jobQueue.updateStatus(job.id, 'done')
      } else {
        // Bounce back to pending. Leave in queue for retry.
        jobQueue.updateStatus(job.id, 'pending')
        break // stop draining; next tick or share-resolve will retry
      }
    }
  } finally {
    scratchDrainBusy = false
  }
}
