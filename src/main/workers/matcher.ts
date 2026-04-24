/**
 * Matcher worker (D2).
 *
 * Runs detectClockOffset + per-routine window assignment off the main
 * thread so CPU-bound match math on large batches doesn't stall IPC.
 *
 * Contract:
 *   request  { taskId, photos, windows, seedOffsetMs? }
 *   response { taskId, offset, matches, events }
 *
 * `events` is a small array of structured offsetDetector.decision payloads
 * the main thread should re-emit via events.emit(). Workers can't import
 * events.ts (which uses electron.app), so we pass the decisions back.
 *
 * Numeric shapes (detectedMs, bestScore, zeroScore, totalPhotos,
 * requiredScore, capMs, etc) and outcome strings MUST match the inline
 * path's events exactly — photoValidator + debug dashboards consume them.
 */

import { parentPort } from 'node:worker_threads'

export interface MatcherWorkerPhoto {
  path: string
  /** ISO-8601 string — parsed back to Date inside the worker. */
  captureTimeIso: string
  sourceHash?: string
}

export interface MatcherWorkerWindow {
  routineId: string
  entryNumber: string
  recordingStartedIso: string
  recordingStoppedIso: string
}

export type PhotoMatchConfidence = 'exact' | 'gap' | 'unmatched'

export interface MatcherWorkerMatch {
  filePath: string
  captureTime: string
  confidence: PhotoMatchConfidence
  uploaded: boolean
  matchedRoutineId?: string
}

export interface OffsetDecisionEvent {
  kind: 'offsetDetector.decision'
  payload: Record<string, unknown>
}

export interface MatcherWorkerRequest {
  taskId: string
  photos: MatcherWorkerPhoto[]
  windows: MatcherWorkerWindow[]
  seedOffsetMs?: number
}

export interface MatcherWorkerResponse {
  taskId: string
  offset: {
    offsetMs: number
    bestScore: number
    zeroScore: number
    totalPhotos: number
  }
  matches: MatcherWorkerMatch[]
  /** Ordered list of events the main thread should re-emit. */
  events: OffsetDecisionEvent[]
  /** Ordered log lines — main thread mirrors them to logger.photos so the
   *  shadow vs authoritative output remains traceable. */
  logs: Array<{ level: 'info' | 'warn'; msg: string }>
}

// Constants copied verbatim from photos.ts — keep in sync if that file
// tunes them. Changing them here without changing photos.ts would mean
// the shadow worker and inline path disagree, which is the whole point
// of shadow mode to catch.
const MAX_AUTO_OFFSET_MS = 60_000
const ZERO_PREFERRED_RATIO = 0.80
const NONZERO_REQUIRED_MARGIN = 1.10
const REFERENCE_GAP_LIMIT_MS = 15 * 60_000
const BUFFER_MS = 30_000

interface PhotoMeta {
  path: string
  captureTime: Date
}

interface WindowMeta {
  routineId: string
  entryNumber: string
  recordingStarted: Date
  recordingStopped: Date
}

function detectClockOffset(
  photos: PhotoMeta[],
  windows: WindowMeta[],
  seedOffsetMs: number,
  events: OffsetDecisionEvent[],
  logs: Array<{ level: 'info' | 'warn'; msg: string }>,
): { offsetMs: number; bestScore: number; zeroScore: number; totalPhotos: number } {
  if (photos.length === 0 || windows.length === 0) {
    return { offsetMs: 0, bestScore: 0, zeroScore: 0, totalPhotos: photos.length }
  }

  const sortedWindows = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )

  function scoreOffset(offsetMs: number): number {
    let score = 0
    for (const photo of photos) {
      const adjusted = photo.captureTime.getTime() + offsetMs
      for (const w of sortedWindows) {
        if (
          adjusted >= w.recordingStarted.getTime() - BUFFER_MS &&
          adjusted <= w.recordingStopped.getTime() + BUFFER_MS
        ) {
          score++
          break
        }
      }
    }
    return score
  }

  const zeroScore = scoreOffset(0)

  if (zeroScore / photos.length >= ZERO_PREFERRED_RATIO) {
    logs.push({
      level: 'info',
      msg: `Clock offset: camera appears synced — ${zeroScore}/${photos.length} photos match at zero offset (≥${Math.round(ZERO_PREFERRED_RATIO * 100)}%), using 0`,
    })
    return { offsetMs: 0, bestScore: zeroScore, zeroScore, totalPhotos: photos.length }
  }

  for (let i = 1; i < sortedWindows.length; i++) {
    const gap =
      sortedWindows[i].recordingStarted.getTime() -
      sortedWindows[i - 1].recordingStopped.getTime()
    if (gap > REFERENCE_GAP_LIMIT_MS) {
      logs.push({
        level: 'warn',
        msg: `Clock offset SKIPPED (reference gap): ${Math.round(gap / 60_000)}min gap between R${sortedWindows[i - 1].entryNumber} (${sortedWindows[i - 1].recordingStopped.toISOString()}) and R${sortedWindows[i].entryNumber} (${sortedWindows[i].recordingStarted.toISOString()}). Reference set likely incomplete — using 0 offset.`,
      })
      events.push({
        kind: 'offsetDetector.decision',
        payload: {
          outcome: 'rejected-reference-gap',
          gapMs: gap,
          fromEntry: sortedWindows[i - 1].entryNumber,
          toEntry: sortedWindows[i].entryNumber,
          fromStopped: sortedWindows[i - 1].recordingStopped.toISOString(),
          toStarted: sortedWindows[i].recordingStarted.toISOString(),
          totalPhotos: photos.length,
          zeroScore,
        },
      })
      return { offsetMs: 0, bestScore: zeroScore, zeroScore, totalPhotos: photos.length }
    }
  }

  const sampleCount = Math.min(10, photos.length)
  const step = Math.max(1, Math.floor(photos.length / sampleCount))
  const samplePhotos: PhotoMeta[] = []
  for (let i = 0; i < photos.length && samplePhotos.length < sampleCount; i += step) {
    samplePhotos.push(photos[i])
  }

  const candidates: number[] = [0]
  if (seedOffsetMs !== 0) candidates.unshift(seedOffsetMs)
  for (const photo of samplePhotos) {
    const distances = sortedWindows.map((w) => ({
      w,
      dist: Math.abs(
        photo.captureTime.getTime() -
          (w.recordingStarted.getTime() + w.recordingStopped.getTime()) / 2,
      ),
    }))
    distances.sort((a, b) => a.dist - b.dist)
    for (const { w } of distances.slice(0, 3)) {
      const mid = (w.recordingStarted.getTime() + w.recordingStopped.getTime()) / 2
      candidates.push(mid - photo.captureTime.getTime())
    }
  }

  let bestOffset = 0
  let bestScore = zeroScore
  const tested = new Set<number>([0])
  for (const candidate of candidates) {
    const rounded = Math.round(candidate / 1000) * 1000
    if (tested.has(rounded)) continue
    tested.add(rounded)
    const score = scoreOffset(rounded)
    if (score > bestScore) {
      bestScore = score
      bestOffset = rounded
    }
  }

  if (bestOffset === 0) {
    logs.push({
      level: 'info',
      msg: `No clock offset needed — ${bestScore}/${photos.length} photos match at zero offset`,
    })
    events.push({
      kind: 'offsetDetector.decision',
      payload: {
        outcome: 'zero',
        bestScore,
        zeroScore,
        totalPhotos: photos.length,
        candidatesTested: tested.size,
      },
    })
    return { offsetMs: 0, bestScore, zeroScore, totalPhotos: photos.length }
  }

  if (Math.abs(bestOffset) > MAX_AUTO_OFFSET_MS) {
    logs.push({
      level: 'warn',
      msg:
        `Clock offset REJECTED (magnitude cap): detected ${Math.round(bestOffset / 1000)}s, cap ±${MAX_AUTO_OFFSET_MS / 1000}s. ` +
        `${bestScore}/${photos.length} matched at shift vs ${zeroScore}/${photos.length} at zero. Using 0 — photos outside windows will be matched by nearest-window fallback.`,
    })
    events.push({
      kind: 'offsetDetector.decision',
      payload: {
        outcome: 'rejected-magnitude',
        detectedMs: bestOffset,
        capMs: MAX_AUTO_OFFSET_MS,
        bestScore,
        zeroScore,
        totalPhotos: photos.length,
      },
    })
    return { offsetMs: 0, bestScore, zeroScore, totalPhotos: photos.length }
  }

  if (bestScore < Math.max(zeroScore * NONZERO_REQUIRED_MARGIN, zeroScore + 10)) {
    logs.push({
      level: 'warn',
      msg: `Clock offset REJECTED (insufficient margin): ${Math.round(bestOffset / 1000)}s scored ${bestScore} vs zero ${zeroScore} — required ≥${Math.round(zeroScore * NONZERO_REQUIRED_MARGIN)}. Using 0.`,
    })
    events.push({
      kind: 'offsetDetector.decision',
      payload: {
        outcome: 'rejected-margin',
        detectedMs: bestOffset,
        bestScore,
        zeroScore,
        requiredScore: Math.round(zeroScore * NONZERO_REQUIRED_MARGIN),
        totalPhotos: photos.length,
      },
    })
    return { offsetMs: 0, bestScore, zeroScore, totalPhotos: photos.length }
  }

  logs.push({
    level: 'info',
    msg: `Clock offset detected: ${Math.round(bestOffset / 1000)}s (camera ${bestOffset > 0 ? 'behind' : 'ahead'}) — matched ${bestScore}/${photos.length} photos (vs ${zeroScore} at zero)`,
  })
  events.push({
    kind: 'offsetDetector.decision',
    payload: {
      outcome: 'applied',
      detectedMs: bestOffset,
      bestScore,
      zeroScore,
      totalPhotos: photos.length,
    },
  })
  return { offsetMs: bestOffset, bestScore, zeroScore, totalPhotos: photos.length }
}

function matchPhotosToRoutines(
  photos: PhotoMeta[],
  windows: WindowMeta[],
  clockOffsetMs: number,
): MatcherWorkerMatch[] {
  const sorted = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )
  return photos.map((photo) => {
    const adjustedTime = photo.captureTime.getTime() + clockOffsetMs
    const exactMatch = sorted.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() &&
        adjustedTime <= w.recordingStopped.getTime(),
    )
    if (exactMatch) {
      return {
        filePath: photo.path,
        captureTime: photo.captureTime.toISOString(),
        confidence: 'exact',
        uploaded: false,
        matchedRoutineId: exactMatch.routineId,
      }
    }
    const gapMatch = sorted.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() - BUFFER_MS &&
        adjustedTime <= w.recordingStopped.getTime() + BUFFER_MS,
    )
    if (gapMatch) {
      return {
        filePath: photo.path,
        captureTime: photo.captureTime.toISOString(),
        confidence: 'gap',
        uploaded: false,
        matchedRoutineId: gapMatch.routineId,
      }
    }
    return {
      filePath: photo.path,
      captureTime: photo.captureTime.toISOString(),
      confidence: 'unmatched',
      uploaded: false,
    }
  })
}

function run(req: MatcherWorkerRequest): MatcherWorkerResponse {
  const events: OffsetDecisionEvent[] = []
  const logs: Array<{ level: 'info' | 'warn'; msg: string }> = []
  const photos: PhotoMeta[] = req.photos.map((p) => ({
    path: p.path,
    captureTime: new Date(p.captureTimeIso),
  }))
  const windows: WindowMeta[] = req.windows.map((w) => ({
    routineId: w.routineId,
    entryNumber: w.entryNumber,
    recordingStarted: new Date(w.recordingStartedIso),
    recordingStopped: new Date(w.recordingStoppedIso),
  }))
  const offset = detectClockOffset(
    photos,
    windows,
    req.seedOffsetMs ?? 0,
    events,
    logs,
  )
  const matches = matchPhotosToRoutines(photos, windows, offset.offsetMs)
  return { taskId: req.taskId, offset, matches, events, logs }
}

if (parentPort) {
  parentPort.on('message', (msg: MatcherWorkerRequest) => {
    try {
      const resp = run(msg)
      parentPort?.postMessage(resp)
    } catch (err) {
      const resp: MatcherWorkerResponse = {
        taskId: msg.taskId,
        offset: { offsetMs: 0, bestScore: 0, zeroScore: 0, totalPhotos: msg.photos.length },
        matches: msg.photos.map((p) => ({
          filePath: p.path,
          captureTime: p.captureTimeIso,
          confidence: 'unmatched',
          uploaded: false,
        })),
        events: [],
        logs: [
          {
            level: 'warn',
            msg: `matcher worker failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      }
      parentPort?.postMessage(resp)
    }
  })
}
