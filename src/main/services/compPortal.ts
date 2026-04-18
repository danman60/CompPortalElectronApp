import { getResolvedConnection } from './schedule'
import { logger } from '../logger'

const NOW_PLAYING_TIMEOUT_MS = 5000

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
