import fs from 'fs'
import path from 'path'
import { dialog, BrowserWindow } from 'electron'
import ExifReader from 'exifreader'
import { Routine, PhotoMatch, IPC_CHANNELS } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import * as state from './state'
import { broadcastFullState } from './recording'
import { getSettings } from './settings'
import * as uploadService from './upload'
import * as manifest from './importManifest'
import type { ManifestEntry } from './importManifest'
import * as events from './events'
import {
  readExifBatch as workerReadExifBatch,
  type ExifWorkerResultEntry,
} from './exifWorkerPool'
import {
  runMatch as workerRunMatch,
  type MatcherWorkerMatch,
  type MatcherWorkerPhoto,
  type MatcherWorkerWindow,
} from './matcherWorkerPool'

interface RecordingWindow {
  routineId: string
  entryNumber: string
  recordingStarted: Date
  recordingStopped: Date
}

interface ImportResult {
  totalPhotos: number
  matched: number
  unmatched: number
  clockOffsetMs: number
  matches: PhotoMatch[]
  cancelled?: boolean
}

/**
 * Sanitize a string for use as a single Windows path component. Windows
 * forbids < > : " / \ | ? * anywhere in a filename, and trailing spaces or
 * dots cause "can't create file" errors when the full path is used. We
 * replace each reserved char with _ and trim tail whitespace/dots. This
 * used to be missing from the import folder builder, which meant a routine
 * titled 'CAN YOU DO THIS?' crashed the entire SD import at mkdir.
 */
function sanitizeFsPathComponent(s: string): string {
  return s
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[\s.]+$/g, '')
    .trim() || '_'
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function cancelledResult(): ImportResult {
  return {
    totalPhotos: 0,
    matched: 0,
    unmatched: 0,
    clockOffsetMs: 0,
    matches: [],
    cancelled: true,
  }
}

/** Local YYYY-MM-DD comparison — uses the same interpretation as getPhotoCaptureTime. */
function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function fmtLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Bug F mitigation: sample up to 20 EXIF DateTimeOriginal stamps from the
 * import set, compare to today (local). If majority do NOT match today, ask
 * the operator to confirm/skip/cancel before the matcher pollutes today's
 * routine folders with yesterday's photos. Saturday 2026-04-18 incident:
 * Friday's 21k SD imported on Saturday matched Saturday routines purely by
 * time-of-day overlap.
 *
 * Uses the existing EXIF interpretation — no timezone change.
 */
async function checkSourceDateMatchesToday(
  paths: string[],
): Promise<{ action: 'continue' | 'skip-mismatched' | 'cancel'; todayDate: string; dominantDate: string }> {
  const today = new Date()
  const todayDate = fmtLocalDate(today)

  if (paths.length === 0) {
    return { action: 'continue', todayDate, dominantDate: todayDate }
  }

  // Sample up to 20 photos evenly spaced through the partitionedPaths list.
  const sampleCount = Math.min(20, paths.length)
  const step = Math.max(1, Math.floor(paths.length / sampleCount))
  const samples: string[] = []
  for (let i = 0; i < paths.length && samples.length < sampleCount; i += step) {
    samples.push(paths[i])
  }

  const dateCounts = new Map<string, number>()
  let sampledOk = 0
  let todayCount = 0
  for (const fp of samples) {
    const d = await getPhotoCaptureTime(fp).catch(() => null)
    if (!d) continue
    sampledOk++
    const iso = fmtLocalDate(d)
    dateCounts.set(iso, (dateCounts.get(iso) || 0) + 1)
    if (iso === todayDate) todayCount++
  }

  if (sampledOk === 0) {
    // No EXIF reads succeeded — let the import continue, downstream logic
    // already handles "no captureTime" by dropping the photo.
    return { action: 'continue', todayDate, dominantDate: todayDate }
  }

  // If majority match today, no prompt needed.
  if (todayCount * 2 >= sampledOk) {
    return { action: 'continue', todayDate, dominantDate: todayDate }
  }

  // Pick dominant non-today date for the prompt.
  let dominantDate = todayDate
  let dominantCount = -1
  for (const [iso, count] of dateCounts) {
    if (count > dominantCount) {
      dominantCount = count
      dominantDate = iso
    }
  }

  // Operator request 2026-04-25 mid-show: stop showing the SD-card-date-mismatch
  // blocking dialog. Same reasoning as the camera-clock-mismatch toast silencing
  // (driveMonitor.ts:264) — real SD cards always carry other days (yesterday's
  // session, prior-comp leftovers); the dialog fired on every startup/insert
  // and added no value. Non-today photos already flow through the normal
  // matching logic (nearest-window, orphans bucket). Keeping the warn log
  // for forensics + the dateCounts breakdown for postmortems.
  const summaryDatesLog = [...dateCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([d, c]) => `${d}:${c}`)
    .join(', ')
  logger.photos.warn(
    `Import date mismatch (suppressed UI 2026-04-25 per operator): ` +
    `${sampledOk - todayCount}/${sampledOk} sampled NOT from today. ` +
    `Dominant=${dominantDate}, today=${todayDate}, breakdown=[${summaryDatesLog}].`,
  )
  return { action: 'continue', todayDate, dominantDate }
}

/**
 * Bug E mitigation: pre-flight check before feeding a file to sharp. The
 * libvips backend throws "TypeError: A boolean was expected" on certain
 * malformed/zero-byte/in-progress JPEGs. Validate file size + minimal JPEG
 * magic before calling sharp() so the failure mode is a clean log line
 * instead of a flood of cryptic stack traces.
 */
async function isThumbnailSafe(filePath: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(filePath)
    if (!st.isFile() || st.size < 256) return false
    // JPEG starts with 0xFFD8FFE0/E1/E8 — read first 4 bytes.
    const fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(4)
    await fh.read(buf, 0, 4, 0)
    await fh.close()
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  } catch {
    return false
  }
}

// ── Single-flight import lock + cancel (Saturday 2026-04-18 incident) ──
// The Photos button accepted parallel imports, causing two 21k-photo scans
// to race each other (EBUSY collisions, double thumbnails, runaway state).
// Reject the second invocation with an explicit error and expose a cancel
// IPC so the operator can stop a runaway without killing the app.
type CurrentImport = {
  abortController: AbortController
  folderPath: string
  startedAt: number
}
let currentImport: CurrentImport | null = null

export function isImportRunning(): boolean {
  return currentImport !== null
}

export function getCurrentImportInfo(): { folderPath: string; startedAt: number } | null {
  return currentImport
    ? { folderPath: currentImport.folderPath, startedAt: currentImport.startedAt }
    : null
}

export function cancelCurrentImport(): { ok: boolean; cancelled?: string; error?: string } {
  if (!currentImport) return { ok: false, error: 'No import in progress' }
  const folder = currentImport.folderPath
  try {
    currentImport.abortController.abort()
    logger.photos.warn(`Import cancellation requested for ${folder}`)
    return { ok: true, cancelled: folder }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function browseForFolder(): Promise<string | null> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null

  const result = await dialog.showOpenDialog(win, {
    title: 'Select Photo Folder (SD Card / DCIM)',
    defaultPath: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', // This PC CLSID
    properties: ['openDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/**
 * Camera body identifier derived from the filename prefix. Panasonic Lumix
 * (the operator's cameras) names files as `P<3-digit folder><4-digit seq>.JPG`.
 * We use `P<folder>` as the body key. NOT drive letter — SD cards rotate.
 *
 * Operator-confirmed camera body grouping (UDC London 2026-04-17):
 *   Cam 1 "OLD": folders 101-110 (prefixes P10x)
 *   Cam 2 "NEW": folders 166-189 (prefixes P16x/P17x/P18x)
 *
 * So the 4-character prefix (e.g. "P166") is a folder-level key; the first
 * 2 digits give a body-level key when the camera rolls multiple folders.
 * We use the body-level key (P1 + first digit, like "P16") for offset
 * persistence — same camera across folders gets the same offset.
 */
export function getCameraBodyKey(filePath: string): string | null {
  const base = path.basename(filePath)
  const m = base.match(/^(P\d{2})\d{5}\.(?:jpg|jpeg)$/i)
  return m ? m[1].toUpperCase() : null
}

/**
 * DCIM folder name partitioning key. Lumix cameras create `DCIM/NNN_PANA/`
 * subfolders and increment NNN as each fills. Two sequential SDs in the
 * same reader slot can share the same drive letter but have different
 * NNN_PANA folders with different photos under the same filenames — we
 * must partition on folder to prevent filename-collision merge.
 */
function getDcimFolderKey(filePath: string): string {
  const segments = filePath.split(/[\\/]/)
  // Walk back to the DCIM/<folder>/ segment.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/^\d{3}_?/.test(segments[i])) {
      return segments[i].toUpperCase()
    }
  }
  return ''
}

// ──────────────────────────────────────────────────────────────────────────
// D1/D2 shadow-mode helpers
//
// Worker cutover is gated by settings.performance.useExifWorker /
// useMatcherWorker. When OFF (default), we still run the worker alongside
// the inline path and log divergences so the operator can flip the flag
// confidently. When ON, the worker is authoritative; inline path is
// skipped. Worker failure falls back to inline even when the flag is ON.
//
// Divergence log format (searchable in main.log):
//   [App] exifWorker divergence: <batchId> inline=<N> worker=<M> sampleMismatches=<list>
//   [App] matcherWorker divergence: body=<B> offsetMs inline=<I> worker=<W> matches=<I>/<W>
// ──────────────────────────────────────────────────────────────────────────

interface ShadowExifSample {
  path: string
  inlineIso: string | null
}

let shadowExifBatchCounter = 0

/** Fire-and-forget: worker reads the same paths, log any divergence.
 *  Must never throw — the caller is on the hot path. */
function fireExifShadowBatch(samples: ShadowExifSample[]): void {
  if (samples.length === 0) return
  const batchId = `shadow-${++shadowExifBatchCounter}`
  const files = samples.map((s) => s.path)
  // Pre-build inline map once — we compare by path.
  const inlineByPath = new Map<string, string | null>()
  for (const s of samples) inlineByPath.set(s.path, s.inlineIso)
  workerReadExifBatch(files).then(
    (results) => {
      let mismatches = 0
      const sample: Array<{ path: string; inline: string | null; worker: string | null }> = []
      for (const r of results) {
        const inlineIso = inlineByPath.get(r.path) ?? null
        const workerIso = r.exifTs
        // Both null = agreement. Both set + equal = agreement. Anything else = mismatch.
        if (inlineIso !== workerIso) {
          mismatches++
          if (sample.length < 5) {
            sample.push({ path: path.basename(r.path), inline: inlineIso, worker: workerIso })
          }
        }
      }
      if (mismatches > 0) {
        logger.app.warn(
          `exifWorker divergence: ${batchId} total=${results.length} mismatches=${mismatches} samples=${JSON.stringify(sample)}`,
        )
        events.emit('perfWorker.exif.divergence', {
          batchId,
          total: results.length,
          mismatches,
          samples: sample,
        })
      } else {
        logger.app.info(
          `exifWorker shadow parity: ${batchId} total=${results.length} agreement=100%`,
        )
      }
    },
    (err) => {
      logger.app.warn(
        `exifWorker shadow batch ${batchId} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    },
  )
}

async function getPhotoCaptureTime(filePath: string): Promise<Date | null> {
  try {
    // Read only first 128KB — EXIF data is always in the file header
    const EXIF_HEADER_SIZE = 128 * 1024
    const fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(EXIF_HEADER_SIZE)
    const { bytesRead } = await fh.read(buf, 0, EXIF_HEADER_SIZE, 0)
    await fh.close()
    const buffer = buf.subarray(0, bytesRead)
    const tags = ExifReader.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
    const dateTime = tags['DateTimeOriginal']?.description
    if (!dateTime) return null

    // Parse EXIF date format "YYYY:MM:DD HH:MM:SS"
    // EXIF DateTimeOriginal is LOCAL time (no timezone) — cameras don't store UTC.
    // Treat as local by NOT appending 'Z'. new Date("2026-03-24T14:30:00") parses as local.
    const [datePart, timePart] = dateTime.split(' ')
    if (!datePart || !timePart) return null
    const isoString = datePart.replace(/:/g, '-') + 'T' + timePart
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return null
    return d
  } catch (err) {
    logger.photos.warn(`Failed to read EXIF from ${path.basename(filePath)}:`, err)
    return null
  }
}

// Max magnitude (ms) that will be auto-applied without operator confirmation.
// Larger detected offsets almost always indicate aliasing (see UDC London
// 2026-04-19 R530 incident: -201s aliased because a missing routine window
// broke the reference set). A correctly-clocked camera produces offsets <5s.
const MAX_AUTO_OFFSET_MS = 60_000

// If offset=0 matches at least this fraction of photos, prefer zero (camera
// likely synced). Prevents aliased offsets from winning by 1-2 extra matches.
const ZERO_PREFERRED_RATIO = 0.80

// A non-zero detected offset must beat the offset=0 score by at least this
// multiplicative margin before being applied. Guards against aliasing when
// a handful of extra matches accidentally score the shifted candidate higher.
const NONZERO_REQUIRED_MARGIN = 1.10

// If the reference set (recording windows) has a gap larger than this between
// consecutive entries, treat the reference as incomplete and refuse to apply
// any non-zero offset. Typical inter-routine gap is <5min; a gap >15min
// usually means a routine wasn't registered (re-record chaos, missing
// media_packages row, or pending recording). Fail closed: use zero offset
// and let the nearest-window fallback handle orphans at copy time.
const REFERENCE_GAP_LIMIT_MS = 15 * 60_000

// Offsets with magnitude ≤ this auto-apply without operator confirmation.
// Camera clocks drift a few seconds between dailies — prompting at 5s is
// noise. A detected offset >15s is rare enough that a confirm toast is
// worth the interruption.
const OFFSET_REQUIRE_CONFIRM_ABOVE_MS = 15_000

// Proposal bookkeeping. Set of camera bodies the operator has chosen to
// skip-prompt for the rest of the session. Cleared when the main process
// restarts. Populated when the operator clicks "Skip" on a proposal toast.
const offsetProposalResolvers = new Map<string, (d: 'yes' | 'no' | 'skip') => void>()
const offsetPromptSessionSkip = new Set<string>()
let offsetProposalCounter = 0

export function resolveOffsetDecision(proposalId: string, decision: 'yes' | 'no' | 'skip'): void {
  const fn = offsetProposalResolvers.get(proposalId)
  if (!fn) return
  offsetProposalResolvers.delete(proposalId)
  fn(decision)
}

async function proposeOffsetDecision(payload: {
  cameraBody: string
  offsetMs: number
  matchesAt: number
  matchesAtZero: number
  totalPhotos: number
}): Promise<'yes' | 'no' | 'skip'> {
  const proposalId = `offprop-${Date.now()}-${++offsetProposalCounter}`
  return new Promise<'yes' | 'no' | 'skip'>((resolve) => {
    offsetProposalResolvers.set(proposalId, resolve)
    // Safety timeout — default to 'yes' (apply) after 2 minutes so an
    // unattended laptop never leaves an import permanently stalled.
    const timeout = setTimeout(() => {
      if (offsetProposalResolvers.has(proposalId)) {
        offsetProposalResolvers.delete(proposalId)
        logger.photos.warn(`Offset proposal ${proposalId} timed out after 120s — defaulting to 'yes' (apply)`)
        resolve('yes')
      }
    }, 120_000)
    // Release the timeout if decision arrives normally
    const wrap = offsetProposalResolvers.get(proposalId)!
    offsetProposalResolvers.set(proposalId, (d) => {
      clearTimeout(timeout)
      wrap(d)
    })
    sendToRenderer(IPC_CHANNELS.PHOTOS_OFFSET_PROPOSAL, { proposalId, ...payload })
  })
}

interface ClockOffsetResult {
  offsetMs: number
  bestScore: number
  zeroScore: number
  totalPhotos: number
}

function detectClockOffset(
  photos: { path: string; captureTime: Date }[],
  windows: RecordingWindow[],
  seedOffsetMs = 0,
): ClockOffsetResult {
  if (photos.length === 0 || windows.length === 0) {
    return { offsetMs: 0, bestScore: 0, zeroScore: 0, totalPhotos: photos.length }
  }

  const BUFFER = 30_000
  const sortedWindows = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )

  function scoreOffset(offsetMs: number): number {
    let score = 0
    for (const photo of photos) {
      const adjusted = photo.captureTime.getTime() + offsetMs
      for (const w of sortedWindows) {
        if (adjusted >= w.recordingStarted.getTime() - BUFFER &&
            adjusted <= w.recordingStopped.getTime() + BUFFER) {
          score++
          break
        }
      }
    }
    return score
  }

  const zeroScore = scoreOffset(0)

  // Short-circuit: if the camera appears synced (most photos land in windows
  // at offset=0), skip the candidate search entirely. This prevents the class
  // of bug where a missing/mis-labeled window in the reference set causes a
  // sliding offset to score 1-2 matches higher than zero.
  if (zeroScore / photos.length >= ZERO_PREFERRED_RATIO) {
    logger.photos.info(
      `Clock offset: camera appears synced — ${zeroScore}/${photos.length} photos match at zero offset (≥${Math.round(ZERO_PREFERRED_RATIO * 100)}%), using 0`,
    )
    return { offsetMs: 0, bestScore: zeroScore, zeroScore, totalPhotos: photos.length }
  }

  // Reference-set integrity check. If the recording windows have a gap larger
  // than REFERENCE_GAP_LIMIT_MS between consecutive entries, the reference
  // set is likely incomplete — a missing media_packages row, a re-record that
  // never got its own routine, or a pending recording. Shifting the offset
  // against that incomplete set risks aliasing (R530 incident, 2026-04-19 UDC
  // London: no row for R530 + detector picked -201s that mis-assigned ~4,298
  // photos one routine earlier). Fail closed: refuse non-zero here, let the
  // nearest-window fallback route orphans. Operator can re-run after fixing
  // the reference set.
  for (let i = 1; i < sortedWindows.length; i++) {
    const gap =
      sortedWindows[i].recordingStarted.getTime() -
      sortedWindows[i - 1].recordingStopped.getTime()
    if (gap > REFERENCE_GAP_LIMIT_MS) {
      logger.photos.warn(
        `Clock offset SKIPPED (reference gap): ${Math.round(gap / 60_000)}min gap between R${sortedWindows[i - 1].entryNumber} (${sortedWindows[i - 1].recordingStopped.toISOString()}) and R${sortedWindows[i].entryNumber} (${sortedWindows[i].recordingStarted.toISOString()}). Reference set likely incomplete — using 0 offset.`,
      )
      events.emit('offsetDetector.decision', {
        outcome: 'rejected-reference-gap',
        gapMs: gap,
        fromEntry: sortedWindows[i - 1].entryNumber,
        toEntry: sortedWindows[i].entryNumber,
        fromStopped: sortedWindows[i - 1].recordingStopped.toISOString(),
        toStarted: sortedWindows[i].recordingStarted.toISOString(),
        totalPhotos: photos.length,
        zeroScore,
      })
      return { offsetMs: 0, bestScore: zeroScore, zeroScore, totalPhotos: photos.length }
    }
  }

  // Sample up to 10 evenly-spaced photos to generate candidate offsets
  const sampleCount = Math.min(10, photos.length)
  const step = Math.max(1, Math.floor(photos.length / sampleCount))
  const samplePhotos: typeof photos = []
  for (let i = 0; i < photos.length && samplePhotos.length < sampleCount; i += step) {
    samplePhotos.push(photos[i])
  }

  const candidates: number[] = [0]
  if (seedOffsetMs !== 0) candidates.unshift(seedOffsetMs)
  for (const photo of samplePhotos) {
    const distances = sortedWindows.map((w) => ({
      w,
      dist: Math.abs(photo.captureTime.getTime() - (w.recordingStarted.getTime() + w.recordingStopped.getTime()) / 2),
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
    logger.photos.info(`No clock offset needed — ${bestScore}/${photos.length} photos match at zero offset`)
    events.emit('offsetDetector.decision', { outcome: 'zero', bestScore, zeroScore, totalPhotos: photos.length, candidatesTested: tested.size })
    return { offsetMs: 0, bestScore, zeroScore, totalPhotos: photos.length }
  }

  // Magnitude cap — reject large auto-detected offsets. A camera with a true
  // 60s+ drift is rare enough that silent auto-apply is the wrong default.
  if (Math.abs(bestOffset) > MAX_AUTO_OFFSET_MS) {
    logger.photos.warn(
      `Clock offset REJECTED (magnitude cap): detected ${Math.round(bestOffset / 1000)}s, cap ±${MAX_AUTO_OFFSET_MS / 1000}s. ` +
      `${bestScore}/${photos.length} matched at shift vs ${zeroScore}/${photos.length} at zero. Using 0 — photos outside windows will be matched by nearest-window fallback.`,
    )
    events.emit('offsetDetector.decision', { outcome: 'rejected-magnitude', detectedMs: bestOffset, capMs: MAX_AUTO_OFFSET_MS, bestScore, zeroScore, totalPhotos: photos.length })
    return { offsetMs: 0, bestScore, zeroScore, totalPhotos: photos.length }
  }

  // Margin check — a detected offset must decisively beat offset=0 before
  // being applied. Aliased offsets often score 1-5 matches above zero.
  if (bestScore < Math.max(zeroScore * NONZERO_REQUIRED_MARGIN, zeroScore + 10)) {
    logger.photos.warn(
      `Clock offset REJECTED (insufficient margin): ${Math.round(bestOffset / 1000)}s scored ${bestScore} vs zero ${zeroScore} — required ≥${Math.round(zeroScore * NONZERO_REQUIRED_MARGIN)}. Using 0.`,
    )
    events.emit('offsetDetector.decision', { outcome: 'rejected-margin', detectedMs: bestOffset, bestScore, zeroScore, requiredScore: Math.round(zeroScore * NONZERO_REQUIRED_MARGIN), totalPhotos: photos.length })
    return { offsetMs: 0, bestScore, zeroScore, totalPhotos: photos.length }
  }

  logger.photos.info(
    `Clock offset detected: ${Math.round(bestOffset / 1000)}s (camera ${bestOffset > 0 ? 'behind' : 'ahead'}) — matched ${bestScore}/${photos.length} photos (vs ${zeroScore} at zero)`,
  )
  events.emit('offsetDetector.decision', { outcome: 'applied', detectedMs: bestOffset, bestScore, zeroScore, totalPhotos: photos.length })
  return { offsetMs: bestOffset, bestScore, zeroScore, totalPhotos: photos.length }
}

function matchPhotosToRoutines(
  photos: { path: string; captureTime: Date }[],
  windows: RecordingWindow[],
  clockOffsetMs: number,
): PhotoMatch[] {
  const sorted = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )
  const BUFFER_MS = 30_000

  // Log all recording windows for debugging
  for (const w of sorted) {
    logger.photos.info(`  Window: ${w.entryNumber} ${w.routineId.slice(0, 8)} ${w.recordingStarted.toISOString()} → ${w.recordingStopped.toISOString()}`)
  }

  return photos.map((photo) => {
    const adjustedTime = photo.captureTime.getTime() + clockOffsetMs
    const adjustedDate = new Date(adjustedTime)
    const fileName = path.basename(photo.path)

    // Exact match — within recording window
    const exactMatch = sorted.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() &&
        adjustedTime <= w.recordingStopped.getTime(),
    )

    if (exactMatch) {
      logger.photos.info(`  ${fileName}: EXIF=${photo.captureTime.toISOString()} adjusted=${adjustedDate.toISOString()} → EXACT match #${exactMatch.entryNumber}`)
      return {
        filePath: photo.path,
        captureTime: photo.captureTime.toISOString(),
        confidence: 'exact' as const,
        uploaded: false,
        matchedRoutineId: exactMatch.routineId,
      }
    }

    // Gap match — within 30s buffer
    const gapMatch = sorted.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() - BUFFER_MS &&
        adjustedTime <= w.recordingStopped.getTime() + BUFFER_MS,
    )

    if (gapMatch) {
      logger.photos.info(`  ${fileName}: EXIF=${photo.captureTime.toISOString()} adjusted=${adjustedDate.toISOString()} → GAP match #${gapMatch.entryNumber}`)
      return {
        filePath: photo.path,
        captureTime: photo.captureTime.toISOString(),
        confidence: 'gap' as const,
        uploaded: false,
        matchedRoutineId: gapMatch.routineId,
      }
    }

    // Find nearest window for debug
    let nearestDist = Infinity
    let nearestEntry = ''
    for (const w of sorted) {
      const distStart = Math.abs(adjustedTime - w.recordingStarted.getTime())
      const distStop = Math.abs(adjustedTime - w.recordingStopped.getTime())
      const dist = Math.min(distStart, distStop)
      if (dist < nearestDist) { nearestDist = dist; nearestEntry = w.entryNumber }
    }
    logger.photos.info(`  ${fileName}: EXIF=${photo.captureTime.toISOString()} adjusted=${adjustedDate.toISOString()} → UNMATCHED (nearest: #${nearestEntry}, ${Math.round(nearestDist / 1000)}s away)`)

    return {
      filePath: photo.path,
      captureTime: photo.captureTime.toISOString(),
      confidence: 'unmatched' as const,
      uploaded: false,
    }
  })
}

/**
 * D2 shadow/authoritative matcher entry.
 *
 * Split into two stages so the existing operator-prompt override can sit
 * between detect and match (large offsets prompt the operator; if they
 * reject, we match at offset=0 instead of the detected value).
 *
 *   resolveDetectForBody — detector stage. Returns ClockOffsetResult plus
 *     (worker path only) a cached full-match result.
 *   resolveMatchesForBody — match stage. Returns PhotoMatch[] for a body
 *     at the final post-prompt offset.
 *
 * Flag OFF: inline is authoritative; worker fires fire-and-forget shadow.
 * Flag ON: worker is authoritative; any worker failure falls back to inline.
 * Worker failure NEVER crashes photo import (cross-surface contract).
 */

interface WorkerMatchCache {
  offsetMs: number
  matches: PhotoMatch[]
}

async function runFullMatchViaWorker(
  bodyPhotos: { path: string; captureTime: Date; sourceHash: string }[],
  windows: RecordingWindow[],
  seedOffsetMs: number,
  bodyLabel: string,
): Promise<{
  offsetMs: number
  matches: PhotoMatch[]
  detected: ClockOffsetResult
  replayEvents: Array<{ kind: string; payload: Record<string, unknown> }>
  logs: Array<{ level: 'info' | 'warn'; msg: string }>
} | null> {
  try {
    const photosPayload: MatcherWorkerPhoto[] = bodyPhotos.map((p) => ({
      path: p.path,
      captureTimeIso: p.captureTime.toISOString(),
    }))
    const windowsPayload: MatcherWorkerWindow[] = windows.map((w) => ({
      routineId: w.routineId,
      entryNumber: w.entryNumber,
      recordingStartedIso: w.recordingStarted.toISOString(),
      recordingStoppedIso: w.recordingStopped.toISOString(),
    }))
    const resp = await workerRunMatch({
      photos: photosPayload,
      windows: windowsPayload,
      seedOffsetMs,
    })
    const mappedMatches: PhotoMatch[] = resp.matches.map((m: MatcherWorkerMatch) => ({
      filePath: m.filePath,
      captureTime: m.captureTime,
      confidence: m.confidence,
      uploaded: m.uploaded,
      matchedRoutineId: m.matchedRoutineId,
    }))
    return {
      offsetMs: resp.offset.offsetMs,
      matches: mappedMatches,
      detected: {
        offsetMs: resp.offset.offsetMs,
        bestScore: resp.offset.bestScore,
        zeroScore: resp.offset.zeroScore,
        totalPhotos: resp.offset.totalPhotos,
      },
      replayEvents: resp.events.map((e) => ({ kind: e.kind, payload: e.payload })),
      logs: resp.logs,
    }
  } catch (err) {
    logger.app.warn(
      `matcherWorker run failed for body=${bodyLabel}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

async function resolveDetectForBody(
  bodyPhotos: { path: string; captureTime: Date; sourceHash: string }[],
  windows: RecordingWindow[],
  seedOffsetMs: number,
  bodyLabel: string,
): Promise<{ detected: ClockOffsetResult; workerMatchCache: WorkerMatchCache | null }> {
  const settings = getSettings()
  const useWorker = !!settings.performance?.useMatcherWorker

  if (useWorker) {
    const workerOut = await runFullMatchViaWorker(
      bodyPhotos,
      windows,
      seedOffsetMs,
      bodyLabel,
    )
    if (workerOut) {
      // Replay captured logs + events on the main thread so downstream
      // consumers see identical side effects.
      for (const l of workerOut.logs) {
        if (l.level === 'info') logger.photos.info(l.msg)
        else logger.photos.warn(l.msg)
      }
      for (const ev of workerOut.replayEvents) {
        events.emit(ev.kind, ev.payload)
      }
      return {
        detected: workerOut.detected,
        workerMatchCache: { offsetMs: workerOut.offsetMs, matches: workerOut.matches },
      }
    }
    logger.app.warn(`matcherWorker fallback to inline for body=${bodyLabel}`)
  }

  // Inline authoritative.
  const detected = detectClockOffset(
    bodyPhotos.map((p) => ({ path: p.path, captureTime: p.captureTime })),
    windows,
    seedOffsetMs,
  )

  if (!useWorker) {
    // Fire-and-forget shadow.
    runFullMatchViaWorker(bodyPhotos, windows, seedOffsetMs, bodyLabel).then((workerOut) => {
      if (!workerOut) return
      if (workerOut.offsetMs !== detected.offsetMs) {
        logger.app.warn(
          `matcherWorker divergence: body=${bodyLabel} ` +
            `offset inline=${detected.offsetMs} worker=${workerOut.offsetMs} ` +
            `totalPhotos=${bodyPhotos.length}`,
        )
        events.emit('perfWorker.matcher.divergence', {
          body: bodyLabel,
          inlineOffsetMs: detected.offsetMs,
          workerOffsetMs: workerOut.offsetMs,
          totalPhotos: bodyPhotos.length,
          reason: 'offsetMs',
        })
      } else {
        logger.app.info(
          `matcherWorker shadow parity: body=${bodyLabel} offsetMs=${detected.offsetMs} totalPhotos=${bodyPhotos.length}`,
        )
      }
    })
  }
  return { detected, workerMatchCache: null }
}

async function resolveMatchesForBody(
  bodyPhotos: { path: string; captureTime: Date; sourceHash: string }[],
  windows: RecordingWindow[],
  finalOffsetMs: number,
  bodyLabel: string,
  workerMatchCache: WorkerMatchCache | null,
): Promise<PhotoMatch[]> {
  const settings = getSettings()
  const useWorker = !!settings.performance?.useMatcherWorker

  // Worker already computed matches at this exact offset in the detect stage.
  if (workerMatchCache && workerMatchCache.offsetMs === finalOffsetMs) {
    return workerMatchCache.matches
  }

  if (useWorker) {
    // Re-run worker with the overridden offset as seed.
    const workerOut = await runFullMatchViaWorker(bodyPhotos, windows, finalOffsetMs, bodyLabel)
    if (workerOut && workerOut.offsetMs === finalOffsetMs) {
      return workerOut.matches
    }
    // Fall through to inline at finalOffsetMs.
  }

  return matchPhotosToRoutines(
    bodyPhotos.map((p) => ({ path: p.path, captureTime: p.captureTime })),
    windows,
    finalOffsetMs,
  )
}

// FIFO queue for sequential imports — supports multi-SD insertion where the
// operator plugs in 2+ cards at once. Each queued import waits for the
// previous to finish so state.json writes, job queue, and offset detector
// don't race across drives.
const importQueue: Array<() => void> = []

export interface ImportPhotosOptions {
  previewOnly?: boolean // T-F3: dry-run; no copies, no watermarks, no enqueue
  // T-V7-25: scope the import to ONLY these basenames (case-insensitive).
  // Used for "Import Missing Only" from the missing-photos recovery toast.
  // When set, the scan also bypasses the SD watermark filter for included
  // files so a previously-watermarked card can have specific frames
  // backfilled without disturbing the rest of the card.
  filenameAllowlist?: Set<string>
  // Auto-import on SD re-insert: skip any photo whose basename is already in
  // DB for the routine it matches to. Pre-fetches existing filenames from
  // CompPortal at import start and filters in the copy loop. Differs from
  // filenameAllowlist (which is a positive include list) — this is a negative
  // exclude based on DB state. Safe to combine; the exclude wins.
  dedupByDb?: boolean
  // Auto-import safety gate: if camera clock-offset detection finds |offset|
  // > this value (ms), abort before writing anything. Prevents wrong-time
  // imports when auto-triggered by driveMonitor. 0 or unset = no gate.
  autoAbortOffsetMs?: number
}

export async function importPhotos(
  folderPath: string,
  routines: Routine[],
  outputDir: string,
  opts: ImportPhotosOptions = {},
): Promise<ImportResult | { error: string }> {
  // Dedupe: if the SAME folder is already importing OR already queued,
  // reject. Supports multi-SD by allowing DIFFERENT folders to queue up.
  if (currentImport && currentImport.folderPath === folderPath) {
    const elapsedSec = Math.round((Date.now() - currentImport.startedAt) / 1000)
    const msg = `Already importing this folder (${folderPath}, running ${elapsedSec}s).`
    logger.photos.warn(`Rejected duplicate import attempt for ${folderPath}: ${msg}`)
    return { error: msg }
  }

  events.emit('import.requested', { folderPath, queueDepth: importQueue.length, currentRunning: currentImport?.folderPath || null })

  // Wait for previous imports to finish before starting this one.
  if (currentImport) {
    logger.photos.info(
      `Queuing import of ${folderPath} behind ${currentImport.folderPath} (position ${importQueue.length + 1})`,
    )
    sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
      stage: 'queued',
      total: 0,
      current: 0,
      message: `Queued behind ${importQueue.length + 1} import(s)`,
    })
    await new Promise<void>((resolve) => {
      importQueue.push(resolve)
    })
  }

  const abortController = new AbortController()
  const signal = abortController.signal
  currentImport = { abortController, folderPath, startedAt: Date.now() }

  try {
    events.emit('import.started', { folderPath, previewOnly: !!opts.previewOnly })
    const result = await runImport(folderPath, routines, outputDir, signal, opts)
    events.emit('import.finished', {
      folderPath,
      totalPhotos: 'totalPhotos' in result ? result.totalPhotos : 0,
      matched: 'matched' in result ? result.matched : 0,
      unmatched: 'unmatched' in result ? result.unmatched : 0,
      clockOffsetMs: 'clockOffsetMs' in result ? result.clockOffsetMs : 0,
      cancelled: 'cancelled' in result ? result.cancelled : false,
    })
    // A56: bump photo-import activity timestamp.
    void import('./pipelineHealth').then((m) => m.bumpActivity('photoImport')).catch(() => {})
    return result
  } catch (err) {
    events.emit('import.failed', { folderPath, error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    currentImport = null
    // Release the next queued import, if any.
    const next = importQueue.shift()
    if (next) next()
  }
}

async function runImport(
  folderPath: string,
  routines: Routine[],
  outputDir: string,
  signal: AbortSignal,
  opts: ImportPhotosOptions = {},
): Promise<ImportResult> {
  const previewOnly = !!opts.previewOnly
  logger.photos.info(`Importing photos from: ${folderPath}${previewOnly ? ' (PREVIEW ONLY)' : ''}`)

  const importRunId = new Date().toISOString()
  const seenHashes = await manifest.getUploadedHashes(outputDir).catch(() => new Set<string>())

  // Scan recursively in batches so the main event loop stays responsive during large imports.
  async function scanDir(rootDir: string): Promise<string[]> {
    const results: string[] = []
    const pendingDirs: string[] = [rootDir]
    let processedDirs = 0

    while (pendingDirs.length > 0) {
      const dir = pendingDirs.pop()!
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          pendingDirs.push(entryPath)
        } else if (/\.(jpg|jpeg)$/i.test(entry.name)) {
          results.push(entryPath)
        }
      }

      processedDirs++
      if (processedDirs % 25 === 0) {
        await yieldToEventLoop()
      }
    }

    return results
  }
  const filePaths = await scanDir(folderPath)
  logger.photos.info(`Found ${filePaths.length} JPEG files`)

  // Multi-SD / multi-camera namespace awareness (UDC London 2026-04-18):
  // F:\DCIM\166_PANA and H:\DCIM\166_PANA can both exist with DIFFERENT photos
  // that share filenames (P1667001.JPG on each). Partition by drive letter (or
  // top-level mount root on non-Windows) so any downstream ordering honours the
  // drive boundary. Matching/copying key off full paths + sourceHash so a
  // filename collision across drives cannot silently merge them. This is a
  // belt-and-suspenders guard against a future caller passing a union of two
  // roots, or scanDir returning entries from two drives via a symlink.
  // Partition on {driveRoot}::{dcimFolder}. Drive root alone is insufficient
  // because two sequential SDs swapped into the same reader share the same
  // drive letter. DCIM folder alone is insufficient because two SDs mounted
  // simultaneously can both expose 166_PANA. The composite key prevents
  // filename-collision merge across both dimensions (confirmed 2026-04-18
  // UDC London F:\DCIM\166_PANA + H:\DCIM\166_PANA both had P1667001.JPG
  // with different photos).
  const byDrive = new Map<string, string[]>()
  for (const fp of filePaths) {
    // On Windows "F:\foo" → "F:". On POSIX → "" (no drive) — fall back to first
    // path segment so SMB mounts like /mnt/sd1 vs /mnt/sd2 still partition.
    let driveKey = path.parse(fp).root
    if (!driveKey) {
      const first = fp.split(path.sep).filter(Boolean)[0]
      driveKey = first ? path.sep + first : path.sep
    }
    driveKey = driveKey.toUpperCase()
    const dcimKey = getDcimFolderKey(fp)
    const key = dcimKey ? `${driveKey}::${dcimKey}` : driveKey
    let arr = byDrive.get(key)
    if (!arr) { arr = []; byDrive.set(key, arr) }
    arr.push(fp)
  }
  if (byDrive.size > 1) {
    logger.photos.warn(
      `Import spans ${byDrive.size} partitions (${[...byDrive.keys()].join(', ')}) — ` +
      `processing in partition order to prevent filename-collision merge`,
    )
  }

  // Rebuild filePaths in drive-partitioned order: all photos from drive A, then
  // all photos from drive B, etc. Within a drive, preserve scan order so EXIF
  // reads stay sequential for disk locality.
  const partitionedPathsRaw: string[] = []
  for (const arr of byDrive.values()) {
    partitionedPathsRaw.push(...arr)
  }

  // ── Allowlist gate ──
  // Scoped recovery/backfill can restrict the scan to explicit basenames.
  // Watermarking itself is enforced later from EXIF capture times, not
  // filename sequence numbers.
  const partitionedPaths: string[] = []
  let skippedByAllowlist = 0
  const allowlistUpper = opts.filenameAllowlist
    ? new Set(Array.from(opts.filenameAllowlist).map((s) => s.toUpperCase()))
    : null
  for (const fp of partitionedPathsRaw) {
    const bn = path.basename(fp).toUpperCase()
    if (allowlistUpper && !allowlistUpper.has(bn)) {
      skippedByAllowlist++
      continue
    }
    partitionedPaths.push(fp)
  }
  if (skippedByAllowlist > 0) {
    logger.photos.info(
      `Allowlist filter (scoped import): skipped ${skippedByAllowlist}/${partitionedPathsRaw.length} photos not on recovery list; kept ${partitionedPaths.length}`,
    )
  }

  // Filename-based pre-dedup. When dedupByDb is set, skip any SD photo whose
  // basename already appears in any routine's photos[] (regardless of upload
  // status). This avoids reading EXIF and computing source hashes on photos
  // we've already processed once. Operator directive 2026-04-25: cameras
  // produce sequential names that don't realistically collide; SDs retain
  // originals so any rare collision is recoverable. Re-importing previously-
  // imported names is itself the bigger risk (lost photos via re-match).
  // Filename pre-dedup. Always runs (was gated by dedupByDb in v15.7 — the
  // re-import disaster of 2026-04-24 showed every import path needs this).
  // 2026-04-25 directive: a photo on the SD whose camera filename was EVER
  // imported into ANY routine — past or present, dup-suffixed or not —
  // must NEVER be re-imported. Strip `_dupN` from both sides before
  // comparison so a state record of `Q53A0001_dup3.JPG` matches an SD's
  // plain `Q53A0001.JPG`.
  const dupSuffixRe = /_dup[0-9]+/
  const stripDupAndUpper = (name: string): string =>
    path.basename(name).replace(dupSuffixRe, '').toUpperCase()
  let skippedByFilenameDedup = 0
  const seenBasenames = new Set<string>()
  for (const r of routines) {
    const ps = r.photos
    if (!ps) continue
    for (const p of ps) {
      if (p.sourcePath) seenBasenames.add(stripDupAndUpper(p.sourcePath))
      if (p.filePath) seenBasenames.add(stripDupAndUpper(p.filePath))
    }
  }
  if (seenBasenames.size > 0) {
    const filtered: string[] = []
    for (const fp of partitionedPaths) {
      if (seenBasenames.has(stripDupAndUpper(fp))) {
        skippedByFilenameDedup++
        continue
      }
      filtered.push(fp)
    }
    partitionedPaths.length = 0
    partitionedPaths.push(...filtered)
    logger.photos.info(
      `Filename pre-dedup: skipped ${skippedByFilenameDedup} already-imported names (dup-suffix-aware); ${partitionedPaths.length} new files to scan`,
    )
  }

  // A15 / Northstar UX: distinct toast for "all dedup-skipped" case. When
  // pre-dedup leaves zero files to scan AND we DID skip some by filename,
  // operator was previously shown "Import Complete: 0 matched, 0 unmatched"
  // which hid the fact that files were dedup-skipped. Emit a terminal stage
  // with noNewFiles=true so the pill renders "No new photos in folder — N
  // already imported" and short-circuit. Truly empty folder (skipped=0) falls
  // through normally — operator selected a wrong folder, regular flow handles.
  if (partitionedPaths.length === 0 && skippedByFilenameDedup > 0) {
    logger.photos.info(
      `Import skipping all paths — every file (${skippedByFilenameDedup}) was already imported by filename`,
    )
    sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
      stage: 'done',
      total: skippedByFilenameDedup,
      current: skippedByFilenameDedup,
      canRemoveCard: true,
      noNewFiles: true,
      skippedDedup: skippedByFilenameDedup,
      message: `No new photos in folder — ${skippedByFilenameDedup} already imported`,
    })
    return {
      totalPhotos: 0,
      matched: 0,
      unmatched: 0,
      clockOffsetMs: 0,
      matches: [],
    }
  }

  sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
    stage: 'scanning',
    total: filePaths.length,
    current: 0,
  })

  if (signal.aborted) {
    logger.photos.warn(`Import cancelled before EXIF read (${folderPath})`)
    return cancelledResult()
  }

  // ── Bug F: cross-day pollution check (Saturday 2026-04-18 incident) ──
  // Sample 20 photos' EXIF dates against today's local date BEFORE matching.
  // Friday's 21k SD photos were matched to Saturday routines by time-of-day
  // overlap because the matcher ignored the date portion of the EXIF stamp.
  // Surface a confirm dialog so the operator sees the wrong-day SD before
  // the matcher pollutes today's routine folders.
  // Uses the same EXIF interpretation as the rest of the code (no timezone
  // changes — see getPhotoCaptureTime).
  if (signal.aborted) {
    logger.photos.warn('Import cancelled before date-guard prompt')
    return cancelledResult()
  }
  const dateGuard = await checkSourceDateMatchesToday(partitionedPaths)
  // If operator pressed Cancel pill while the date-mismatch dialog was open,
  // the abort signal will have been raised. Honour it BEFORE acting on the
  // dialog response (operator-reported 2026-04-25 — pill was stuck because
  // cancel had no effect when the modal was the in-flight async).
  if (signal.aborted) {
    logger.photos.warn('Import cancelled while date-guard dialog was open')
    return cancelledResult()
  }
  if (dateGuard.action === 'cancel') {
    logger.photos.warn(
      `Import cancelled by operator after wrong-date detection: dominant=${dateGuard.dominantDate}, today=${dateGuard.todayDate}`,
    )
    return cancelledResult()
  }
  const skipMismatchedDates = dateGuard.action === 'skip-mismatched'

  // Read EXIF timestamps + compute source hash per file, drop ones already uploaded.
  // Iterate partitionedPaths so multi-drive scans process drive-by-drive (see above).
  const photos: { path: string; captureTime: Date; sourceHash: string }[] = []
  let skippedDupes = 0
  let skippedWrongDate = 0
  let skippedByWatermark = 0
  let firstCaptureTime: string | null = null
  let lastCaptureTime: string | null = null
  const maxCaptureByBody: Record<string, { lastCaptureTime: string; lastFilename?: string }> = {}

  // D1 worker cutover. When settings.performance.useExifWorker is ON we
  // authoritatively read via the pool and fall back to inline only if the
  // worker rejects. When OFF we keep inline authoritative and periodically
  // fire a shadow batch for divergence telemetry.
  const perfSettings = getSettings().performance
  const useExifWorkerAuthoritative = !!perfSettings?.useExifWorker
  const exifWorkerCache = new Map<string, string | null>()
  async function readExifViaWorkerBatch(paths: string[]): Promise<void> {
    try {
      const results = await workerReadExifBatch(paths)
      for (const r of results) {
        exifWorkerCache.set(r.path, r.exifTs)
      }
    } catch (err) {
      logger.app.warn(
        `exifWorker authoritative batch failed (${paths.length} files) — falling back to inline: ${err instanceof Error ? err.message : String(err)}`,
      )
      // Leave cache empty for these paths; readers below fall through to inline.
    }
  }
  if (useExifWorkerAuthoritative && partitionedPaths.length > 0) {
    const BATCH = 500
    for (let s = 0; s < partitionedPaths.length; s += BATCH) {
      if (signal.aborted) break
      await readExifViaWorkerBatch(partitionedPaths.slice(s, s + BATCH))
      if (s % (BATCH * 4) === 0) await yieldToEventLoop()
    }
  }

  // Shadow-mode accumulator (flag OFF). Buffers up to 500 samples then
  // dispatches asynchronously; divergences logged by fireExifShadowBatch.
  const shadowBuf: ShadowExifSample[] = []
  const SHADOW_BATCH = 500
  function flushShadowBuf(): void {
    if (shadowBuf.length === 0) return
    const samples = shadowBuf.splice(0, shadowBuf.length)
    fireExifShadowBatch(samples)
  }

  for (let i = 0; i < partitionedPaths.length; i++) {
    if (signal.aborted) {
      logger.photos.warn(`Import cancelled during EXIF read at ${i}/${partitionedPaths.length}`)
      return cancelledResult()
    }
    const sourceHash = await manifest.computeSourceHash(partitionedPaths[i]).catch(() => '')
    if (sourceHash && seenHashes.has(sourceHash)) {
      skippedDupes++
      continue
    }
    // Flag ON: use worker cache (if present). On miss (worker batch failed)
    // fall through to inline. Flag OFF: inline authoritative + shadow.
    let captureTime: Date | null = null
    if (useExifWorkerAuthoritative && exifWorkerCache.has(partitionedPaths[i])) {
      const iso = exifWorkerCache.get(partitionedPaths[i]) ?? null
      captureTime = iso ? new Date(iso) : null
      if (captureTime && isNaN(captureTime.getTime())) captureTime = null
    } else {
      captureTime = await getPhotoCaptureTime(partitionedPaths[i])
      if (!useExifWorkerAuthoritative) {
        shadowBuf.push({
          path: partitionedPaths[i],
          inlineIso: captureTime ? captureTime.toISOString() : null,
        })
        if (shadowBuf.length >= SHADOW_BATCH) flushShadowBuf()
      }
    }
    if (captureTime) {
      const captureIsoForRange = captureTime.toISOString()
      if (!firstCaptureTime || captureIsoForRange < firstCaptureTime) firstCaptureTime = captureIsoForRange
      if (!lastCaptureTime || captureIsoForRange > lastCaptureTime) lastCaptureTime = captureIsoForRange
      const bodyKey = getCameraBodyKey(partitionedPaths[i])
      if (bodyKey) {
        const iso = captureTime.toISOString()
        const existingMax = maxCaptureByBody[bodyKey]
        if (!existingMax || iso > existingMax.lastCaptureTime) {
          maxCaptureByBody[bodyKey] = {
            lastCaptureTime: iso,
            lastFilename: path.basename(partitionedPaths[i]).toUpperCase(),
          }
        }
        if (!allowlistUpper) {
          const wm = state.getSdWatermark(bodyKey)
          if (wm && iso <= wm.lastCaptureTime) {
            skippedByWatermark++
            continue
          }
        }
      }
      // Bug F skip-mismatched mode: drop photos whose EXIF date != today.
      if (skipMismatchedDates && !isSameLocalDate(captureTime, new Date())) {
        skippedWrongDate++
      } else {
        photos.push({ path: partitionedPaths[i], captureTime, sourceHash })
      }
    }

    // Yield more frequently for large imports so progress is visible and the
    // UI stays responsive (Bug B2: every-10 was fine for 500-photo imports
    // but causes ~500ms stalls at 21k).
    if (partitionedPaths.length >= 5000 || i % 10 === 0) {
      sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
        stage: 'reading-exif',
        total: partitionedPaths.length,
        current: i,
      })
      if (partitionedPaths.length >= 1000 && i > 0 && i % 1000 === 0) {
        events.emit('import.exif.progress', {
          scanned: i,
          total: partitionedPaths.length,
          accepted: photos.length,
          skippedDupes,
          skippedWrongDate,
          skippedByWatermark,
          firstCaptureTime,
          lastCaptureTime,
        })
      }
      await yieldToEventLoop()
    }
  }
  // Flush any residual shadow samples.
  if (!useExifWorkerAuthoritative) flushShadowBuf()
  if (skippedWrongDate > 0) {
    logger.photos.info(`Skipped ${skippedWrongDate} photos with non-today EXIF dates`)
  }
  if (skippedByWatermark > 0) {
    logger.photos.info(
      `SD watermark filter: skipped ${skippedByWatermark}/${partitionedPaths.length} photos by EXIF capture time (already processed in prior sessions)`,
    )
  }

  logger.photos.info(`${photos.length}/${partitionedPaths.length} photos have EXIF timestamps (skipped ${skippedDupes} already-uploaded)`)
  events.emit('import.exif.summary', {
    folderPath,
    scanned: partitionedPaths.length,
    accepted: photos.length,
    skippedDupes,
    skippedWrongDate,
    skippedByWatermark,
    skippedByAllowlist,
    firstCaptureTime,
    lastCaptureTime,
    maxCaptureByBody,
  })

  // Build recording windows from routines
  const windows: RecordingWindow[] = routines
    .filter((r) => r.status !== 'scratched' && r.recordingStartedAt && r.recordingStoppedAt)
    .map((r) => ({
      routineId: r.id,
      entryNumber: r.entryNumber,
      recordingStarted: new Date(r.recordingStartedAt!),
      recordingStopped: new Date(r.recordingStoppedAt!),
    }))

  // ── Per-camera-body offset detection ────────────────────────────────
  // Group photos by filename-prefix body key ("P16", "P10", etc). Run
  // detection per body so Cam 1 and Cam 2 can have different offsets
  // (confirmed 2026-04-17 UDC London: Cam 2 was +60min before lunch but
  // reset to +0 after lunch, same camera). Seed with persisted offset so
  // a thin second SD from the same body doesn't re-learn from scratch.
  const photosByBody = new Map<string, typeof photos>()
  const photoBodyIndex: (string | null)[] = new Array(photos.length)
  for (let i = 0; i < photos.length; i++) {
    const body = getCameraBodyKey(photos[i].path) ?? '_unknown'
    photoBodyIndex[i] = body
    let arr = photosByBody.get(body)
    if (!arr) { arr = []; photosByBody.set(body, arr) }
    arr.push(photos[i])
  }

  const offsetByBody = new Map<string, number>()
  // D2: when the matcher worker flag is ON, resolveDetectForBody also returns
  // a cached worker match-list we can reuse in the match stage below.
  const workerCacheByBody = new Map<string, WorkerMatchCache | null>()
  for (const [body, bodyPhotos] of photosByBody.entries()) {
    const seed = body !== '_unknown' ? (state.getCameraOffset(body)?.offsetMs ?? 0) : 0
    const { detected, workerMatchCache } = await resolveDetectForBody(
      bodyPhotos,
      windows,
      seed,
      body,
    )
    workerCacheByBody.set(body, workerMatchCache)
    let finalOffset = detected.offsetMs

    // Offset confirmation: large offsets (abs > threshold) prompt the
    // operator before applying. Small offsets auto-apply — camera clocks
    // drift a few seconds routinely. The "Skip" path remembers the body
    // for the rest of the session to avoid nagging on multi-SD imports.
    if (
      finalOffset !== 0 &&
      body !== '_unknown' &&
      !offsetPromptSessionSkip.has(body) &&
      Math.abs(finalOffset) > OFFSET_REQUIRE_CONFIRM_ABOVE_MS
    ) {
      try {
        const decision = await proposeOffsetDecision({
          cameraBody: body,
          offsetMs: finalOffset,
          matchesAt: detected.bestScore,
          matchesAtZero: detected.zeroScore,
          totalPhotos: detected.totalPhotos,
        })
        if (decision === 'no') {
          logger.photos.info(`Operator rejected offset for ${body} — using 0`)
          finalOffset = 0
        } else if (decision === 'skip') {
          logger.photos.info(`Operator skipped offset prompt for ${body} this session — using 0`)
          finalOffset = 0
          offsetPromptSessionSkip.add(body)
        }
        // 'yes' → keep detected offset
      } catch (err) {
        logger.photos.warn(`Offset proposal failed for ${body}: ${err instanceof Error ? err.message : String(err)} — applying detected`)
      }
    }

    offsetByBody.set(body, finalOffset)
    if (body !== '_unknown' && finalOffset !== 0) {
      if (!previewOnly) {
        state.setCameraOffset(body, finalOffset, 'auto')
      }
      sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
        stage: 'matching',
        total: photos.length,
        current: 0,
        message: `Camera ${body}: offset ${Math.round(finalOffset / 1000)}s${previewOnly ? ' (preview)' : ' applied'}`,
      })
    }
  }

  // Fallback for downstream code paths that still reference a single offset
  // (orphan sidecar write, manifest, etc). Pick the offset with the most
  // photos behind it as the "dominant" clockOffsetMs. Unknown-body photos
  // inherit this dominant offset.
  let dominantBody = '_unknown'
  let dominantCount = -1
  for (const [body, arr] of photosByBody.entries()) {
    if (arr.length > dominantCount) {
      dominantCount = arr.length
      dominantBody = body
    }
  }
  const clockOffsetMs = offsetByBody.get(dominantBody) ?? 0

  // Auto-import safety gate: abort before any copy/enqueue when the detected
  // offset exceeds the configured threshold. Catches wrong-day / heavily-
  // drifted cameras that the day-level sampler missed. Manual imports are
  // never gated here (option unset).
  if (opts.autoAbortOffsetMs && Math.abs(clockOffsetMs) > opts.autoAbortOffsetMs) {
    logger.photos.warn(
      `Auto-import aborted: detected clock offset ${Math.round(clockOffsetMs / 1000)}s exceeds ${Math.round(opts.autoAbortOffsetMs / 1000)}s threshold (folder=${folderPath})`,
    )
    return {
      totalPhotos: photos.length,
      matched: 0,
      unmatched: photos.length,
      clockOffsetMs,
      matches: [],
    }
  }

  // Match photos to routines. We run matchPhotosToRoutines (or the worker
  // equivalent) once per body with that body's final offset, then stitch
  // the results back into original input order so callers referencing
  // photos[i] ↔ matches[i] stay valid.
  const matches = new Array<PhotoMatch>(photos.length)
  const matchesByBody = new Map<string, PhotoMatch[]>()
  const bodyIndexCursor = new Map<string, number>()
  for (const [body, bodyPhotos] of photosByBody.entries()) {
    const bodyOffset = offsetByBody.get(body) ?? 0
    const cached = workerCacheByBody.get(body) ?? null
    const bodyMatches = await resolveMatchesForBody(
      bodyPhotos,
      windows,
      bodyOffset,
      body,
      cached,
    )
    matchesByBody.set(body, bodyMatches)
    bodyIndexCursor.set(body, 0)
  }
  for (let i = 0; i < photos.length; i++) {
    const body = photoBodyIndex[i] ?? '_unknown'
    const cursor = bodyIndexCursor.get(body) ?? 0
    const bodyMatches = matchesByBody.get(body)!
    matches[i] = bodyMatches[cursor]
    bodyIndexCursor.set(body, cursor + 1)
  }

  const matchCounts: Record<string, number> = {}
  const routineMatchCounts: Record<string, number> = {}
  const matchSamples: Array<{
    file: string
    captureTime: string
    confidence: string
    routineId?: string
  }> = []
  for (const match of matches) {
    matchCounts[match.confidence] = (matchCounts[match.confidence] || 0) + 1
    if (match.matchedRoutineId) {
      routineMatchCounts[match.matchedRoutineId] = (routineMatchCounts[match.matchedRoutineId] || 0) + 1
    }
    if (matchSamples.length < 20) {
      matchSamples.push({
        file: path.basename(match.filePath),
        captureTime: match.captureTime,
        confidence: match.confidence,
        routineId: match.matchedRoutineId,
      })
    }
  }
  events.emit('import.match.summary', {
    folderPath,
    totalPhotos: photos.length,
    matchCounts,
    routineMatchCounts,
    samples: matchSamples,
  })

  // Attach sourceHash to each match — used downstream for dedup + safe-delete gating.
  for (let i = 0; i < matches.length; i++) {
    const src = photos[i]
    if (!src) continue
    matches[i].sourceHash = src.sourceHash
    matches[i].sourcePath = src.path
  }

  const manifestEntries: ManifestEntry[] = []

  // Track routines that can't be written to so we skip them for the rest of
  // the batch without spamming the log for every photo. Populated on first
  // mkdir / copy failure for a given routine id.
  const failedRoutineIds = new Set<string>()

  // Auto-import dedup: pre-fetch DB filenames per routine so we can skip
  // photos already uploaded (by basename). One HTTP call for all routines
  // with a matched photo. If CompPortal is unreachable we degrade to "import
  // anyway" since upload-side dedup (sourceHash) is the second line of
  // defense.
  let dbExistingByRoutine: Record<string, Set<string>> = {}
  let dedupSkippedCount = 0
  if (opts.dedupByDb && !previewOnly) {
    const matchedRoutineIds = new Set<string>()
    for (const m of matches) {
      if (m.confidence === 'unmatched') continue
      const adjusted = new Date(m.captureTime).getTime() + clockOffsetMs
      const win = windows.find(
        (w) =>
          adjusted >= w.recordingStarted.getTime() - 30000 &&
          adjusted <= w.recordingStopped.getTime() + 30000,
      )
      if (win) matchedRoutineIds.add(win.routineId)
    }
    if (matchedRoutineIds.size > 0) {
      try {
        const { map, endpointAvailable } = await uploadService.fetchExistingFilenames(
          Array.from(matchedRoutineIds),
        )
        if (endpointAvailable) {
          dbExistingByRoutine = map
          const totalExisting = Object.values(map).reduce((n: number, s: Set<string>) => n + s.size, 0)
          logger.photos.info(
            `Auto-import dedup: pre-fetched ${totalExisting} existing filenames across ${matchedRoutineIds.size} routine(s)`,
          )
        } else {
          logger.photos.info(
            `Auto-import dedup: list-photos endpoint unavailable — proceeding without DB filter`,
          )
        }
      } catch (err) {
        logger.photos.warn(
          `Auto-import dedup pre-fetch failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
  }

  // Copy matched photos to routine folders and generate thumbnails
  let copiedCount = 0
  let perRoutineFailures = 0
  let skippedDiskExists = 0
  // A15 stage emit — total reflects matchable matches; copying loop skips
  // unmatched + dedup'd internally so current may not reach total exactly.
  const matchableCount = matches.filter((m) => m.confidence !== 'unmatched').length
  sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
    stage: 'copying',
    total: matchableCount,
    current: 0,
  })
  for (const match of matches) {
    if (signal.aborted) {
      logger.photos.warn(`Import cancelled during copy at ${copiedCount}/${matches.length}`)
      return cancelledResult()
    }
    if (match.confidence === 'unmatched') continue

    // Find which routine this photo matched
    const adjustedTime = new Date(match.captureTime).getTime() + clockOffsetMs
    const matchedWindow = windows.find(
      (w) =>
        adjustedTime >= w.recordingStarted.getTime() - 30000 &&
        adjustedTime <= w.recordingStopped.getTime() + 30000,
    )

    if (!matchedWindow) continue

    const routine = routines.find((r) => r.id === matchedWindow.routineId)
    if (!routine) continue

    if (failedRoutineIds.has(routine.id)) continue

    // Dedup by DB: if the basename is already recorded against this routine
    // in CompPortal, skip the copy + enqueue. Case-sensitive compare mirrors
    // media_photos.filename storage. Unreachable endpoint path leaves
    // dbExistingByRoutine empty, which is a no-op here.
    if (opts.dedupByDb) {
      const existing = dbExistingByRoutine[routine.id]
      if (existing && existing.has(path.basename(match.filePath))) {
        dedupSkippedCount++
        continue
      }
    }

    // Use existing routine output dir if available, otherwise construct from
    // settings. Routine title is sanitized for filesystem — Windows forbids
    // < > : " / \ | ? * in paths, so a routine titled 'CAN YOU DO THIS?'
    // would otherwise kill the entire import at mkdir. We replace reserved
    // chars with _ and trim trailing whitespace/dots (also Windows-illegal).
    const baseDir = routine.outputDir
      ? routine.outputDir
      : path.join(
          outputDir,
          `${routine.entryNumber}_${sanitizeFsPathComponent(routine.routineTitle)}_${sanitizeFsPathComponent(routine.studioCode || '')}`,
        )
    const routineDir = path.join(baseDir, 'photos')

    try {
      if (!fs.existsSync(routineDir)) {
        await fs.promises.mkdir(routineDir, { recursive: true })
      }
    } catch (mkdirErr) {
      perRoutineFailures++
      failedRoutineIds.add(routine.id)
      logger.photos.error(
        `Skipping routine #${routine.entryNumber} "${routine.routineTitle}": mkdir failed for ${routineDir}: ${mkdirErr instanceof Error ? mkdirErr.message : mkdirErr}`,
      )
      continue
    }

    // Preserve original camera filename end-to-end (operator directive
    // 2026-04-19): local disk, R2 object name, media_photos.filename all
    // carry the native camera basename (e.g. P2234563.JPG). Friendly rename
    // — {entry_number}_{routine}_{studio}_{dancer}_{original}.jpg — is
    // applied ONLY at download time in CompPortal. Benefits: grep works,
    // burst-sequence adjacency preserved, duplicate-SD detection trivial
    // (same camera + same filename = already imported), recovery is a LOT
    // easier.
    //
    // 2026-04-25 directive: NEVER create _dupN copies. If a file with the
    // same basename already exists in the routine's photos folder, treat
    // it as already imported and SKIP. The SD card retains the original;
    // duplicate-imports were the root cause of 9k+ wasted upload jobs and
    // 43k+ wasted disk files. Original camera filename + EXIF is the
    // ground truth — anything beyond that is a re-import.
    const sourceForCopy = match.filePath
    const originalBasename = path.basename(sourceForCopy)
    const destFile = path.join(routineDir, originalBasename)
    if (fs.existsSync(destFile)) {
      skippedDiskExists++
      continue
    }
    try {
      if (!previewOnly) {
        await fs.promises.copyFile(sourceForCopy, destFile)
      }
      match.sourcePath = sourceForCopy
      match.filePath = destFile
    } catch (copyErr) {
      perRoutineFailures++
      failedRoutineIds.add(routine.id)
      logger.photos.error(
        `Skipping routine #${routine.entryNumber} "${routine.routineTitle}": copyFile failed ${originalBasename} → ${destFile}: ${copyErr instanceof Error ? copyErr.message : copyErr}`,
      )
      continue
    }

    // Thumbnail generation moved to the upload worker (T-H17, 2026-04-19).
    // Main-thread sharp calls during bulk SD imports used to starve IPC
    // (Lumix H: incident: 1,557 photos, 0 thumbs, main thread pegged for ~2 min).
    // Upload loop generates on demand via ffmpeg after each photo PUT.
    // match.thumbnailPath stays undefined — upload.ts creates a temp file JIT.

    manifestEntries.push({
      sourcePath: match.sourcePath,
      sourceHash: match.sourceHash || '',
      routineId: routine.id,
      entryNumber: routine.entryNumber,
      destPath: destFile,
      uploaded: false,
      importedAt: new Date().toISOString(),
    })

    copiedCount++
    // A15 stage progress emit — every 10 photos to avoid IPC spam during
    // multi-thousand-photo imports.
    if (copiedCount % 10 === 0) {
      sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
        stage: 'copying',
        total: matchableCount,
        current: copiedCount,
      })
    }
    // Aggressive yield — every photo, not every 10. Live-show UX: operator
    // must be able to click overlay/counter buttons WHILE import runs.
    // (2026-04-19 freeze incident during UDC London Sunday: H:\ → F:\
    // transition saturated main thread for ~2 min. Yielding per-photo keeps
    // IPC responses flowing.)
    if (copiedCount % 3 === 0) {
      await yieldToEventLoop()
    }
  }

  // Route unmatched photos into _orphans/<runId>/ with a sidecar describing the nearest window.
  const orphanDir = path.join(outputDir, '_orphans', importRunId.replace(/[:.]/g, '-'))
  let orphanCount = 0
  const sortedWindows = [...windows].sort(
    (a, b) => a.recordingStarted.getTime() - b.recordingStarted.getTime(),
  )
  for (const match of matches) {
    if (signal.aborted) {
      logger.photos.warn(`Import cancelled during orphan handling at ${orphanCount}`)
      return cancelledResult()
    }
    if (match.confidence !== 'unmatched') continue

    const sourceForCopy = match.filePath
    const captureMs = new Date(match.captureTime).getTime() + clockOffsetMs

    let nearestWindow: RecordingWindow | null = null
    let nearestDistMs = Infinity
    for (const w of sortedWindows) {
      const distStart = Math.abs(captureMs - w.recordingStarted.getTime())
      const distStop = Math.abs(captureMs - w.recordingStopped.getTime())
      const d = Math.min(distStart, distStop)
      if (d < nearestDistMs) { nearestDistMs = d; nearestWindow = w }
    }

    if (!previewOnly && !fs.existsSync(orphanDir)) {
      await fs.promises.mkdir(orphanDir, { recursive: true })
    }
    // Preserve original camera filename for orphans too — same rationale
    // as matched photos. 2026-04-25 directive: SKIP if it already exists,
    // never create _dupN copies. The SD retains the original.
    const orphanOriginal = path.basename(sourceForCopy)
    const orphanDest = path.join(orphanDir, orphanOriginal)
    if (fs.existsSync(orphanDest)) {
      skippedDiskExists++
      continue
    }
    if (!previewOnly) {
      await fs.promises.copyFile(sourceForCopy, orphanDest)
    }

    const sidecar = {
      exifTime: match.captureTime,
      // Offset applied during this import's clock-offset detection. Rematch
      // code downstream adds this to `exifTime` before comparing to new
      // recording windows — otherwise an orphan imported under a +15min
      // offset would fail to rematch because its sidecar holds the raw
      // (offset-unaware) EXIF time while new windows are in real time.
      clockOffsetMs,
      nearestWindow: nearestWindow
        ? {
            routineId: nearestWindow.routineId,
            entryNumber: nearestWindow.entryNumber,
            recordingStarted: nearestWindow.recordingStarted.toISOString(),
            recordingStopped: nearestWindow.recordingStopped.toISOString(),
            distanceSec: Math.round(nearestDistMs / 1000),
          }
        : null,
      reason: sortedWindows.length === 0 ? 'no-recordings' : 'outside-all-windows',
    }
    if (!previewOnly) {
      await fs.promises.writeFile(orphanDest + '.json', JSON.stringify(sidecar, null, 2))
    }

    match.sourcePath = sourceForCopy
    match.filePath = orphanDest

    manifestEntries.push({
      sourcePath: sourceForCopy,
      sourceHash: match.sourceHash || '',
      routineId: null,
      entryNumber: null,
      destPath: orphanDest,
      uploaded: false,
      importedAt: new Date().toISOString(),
    })

    orphanCount++
    if (orphanCount % 10 === 0) {
      await yieldToEventLoop()
    }
  }

  if (!previewOnly && manifestEntries.length > 0) {
    try {
      await manifest.appendEntries(outputDir, importRunId, folderPath, manifestEntries)
    } catch (err) {
      logger.photos.warn('Manifest append failed (continuing):', err)
    }
  }

  const result: ImportResult = {
    totalPhotos: photos.length,
    matched: matches.filter((m) => m.confidence !== 'unmatched').length,
    unmatched: matches.filter((m) => m.confidence === 'unmatched').length,
    clockOffsetMs,
    matches,
  }
  const unmatchedRatio = result.totalPhotos > 0 ? result.unmatched / result.totalPhotos : 0
  if (result.totalPhotos >= 25 && unmatchedRatio >= 0.25) {
    const percent = Math.round(unmatchedRatio * 100)
    const message = `SD import warning: ${result.unmatched}/${result.totalPhotos} photos (${percent}%) did not match a recording window. Check camera clock offset.`
    logger.photos.warn(message)
    events.emit('import.match.warning', {
      totalPhotos: result.totalPhotos,
      matched: result.matched,
      unmatched: result.unmatched,
      unmatchedRatio,
      clockOffsetMs,
      message,
    })
  }

  // Update routine state with matched photos (skipped in preview mode —
  // preview only computes projected match counts + offset without touching
  // routine.photos). Still build photosByRoutine because we need the map
  // for the summary payload.
  const photosByRoutine = new Map<string, PhotoMatch[]>()
  for (const match of matches) {
    if (match.confidence === 'unmatched' || !match.matchedRoutineId) continue
    const list = photosByRoutine.get(match.matchedRoutineId) || []
    list.push(match)
    photosByRoutine.set(match.matchedRoutineId, list)
  }
  if (!previewOnly) {
    for (const [routineId, routinePhotos] of photosByRoutine) {
      const routine = routines.find(r => r.id === routineId)
      if (routine) {
        state.updateRoutineStatus(routineId, routine.status, { photos: routinePhotos })
      }
    }
    broadcastFullState()
  }

  // Auto-upload photos if enabled.
  // Yield between routine enqueues — each enqueueRoutine() cascades into
  // many job-queue writes. Without yields the main thread saturates for
  // seconds and IPC from the renderer (overlay/counter clicks) stalls.
  const settings = getSettings()
  if (!previewOnly && settings.behavior.autoUploadAfterEncoding) {
    const strategy = settings.upload?.strategy || 'routine-batch'
    // A15 stage emit — total = routines that need queuing.
    const routinesToQueue = photosByRoutine.size
    sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
      stage: 'queueing',
      total: routinesToQueue,
      current: 0,
    })
    if (strategy === 'round-robin') {
      const routinesWithPhotos: Routine[] = []
      for (const [routineId] of photosByRoutine) {
        const updatedRoutine = state.getCompetition()?.routines.find(r => r.id === routineId)
        if (updatedRoutine) routinesWithPhotos.push(updatedRoutine)
      }
      if (routinesWithPhotos.length > 0) {
        uploadService.enqueueRoundRobin(routinesWithPhotos)
        uploadService.startUploads()
      }
      // Round-robin enqueues all at once — emit final tick for the pill.
      sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
        stage: 'queueing',
        total: routinesToQueue,
        current: routinesToQueue,
      })
    } else {
      let enqueued = 0
      for (const [routineId] of photosByRoutine) {
        const updatedRoutine = state.getCompetition()?.routines.find(r => r.id === routineId)
        if (updatedRoutine) {
          const result = uploadService.enqueueRoutine(updatedRoutine)
          if (result.queuedJobs > 0) {
            uploadService.startUploads()
          }
        }
        enqueued++
        // Yield every 3 routines so renderer IPC gets a breath.
        if (enqueued % 3 === 0) {
          await yieldToEventLoop()
          sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
            stage: 'queueing',
            total: routinesToQueue,
            current: enqueued,
          })
        }
      }
    }
  }

  // A15 / Northstar UX: emit terminal "done" stage AFTER copy + queue both
  // complete. Operator can safely remove card once this fires (uploads run
  // async after; pulling card is OK — local copies + queue are durable).
  sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
    stage: 'done',
    total: copiedCount,
    current: copiedCount,
    canRemoveCard: true,
  })

  logger.photos.info(
    `Import complete: ${result.matched} matched, ${result.unmatched} unmatched, offset: ${Math.round(clockOffsetMs / 1000)}s${dedupSkippedCount > 0 ? `, dedup-skipped: ${dedupSkippedCount}` : ''}${skippedDiskExists > 0 ? `, disk-exists-skipped: ${skippedDiskExists}` : ''}`,
  )

  // Advance SD watermark per camera body to the latest EXIF capture time we
  // saw this import. Subsequent inserts only skip photos at or before that
  // EXIF time — never by filename sequence.
  if (!previewOnly && Object.keys(maxCaptureByBody).length > 0) {
    state.setSdWatermarksBulk(maxCaptureByBody)
  }

  // ── Distribution-sanity validator ──
  // Surface routines with unexpected photo counts so the operator sees silent
  // mis-matches without reading logs. These are soft warnings only — toast,
  // never block.
  //
  // UDC London 2026-04-19 calibration: flat 300 ceiling mis-flagged legitimate
  // Productions (R410 = 970 photos, real 7.7-min Production) AND couldn't
  // distinguish contaminated solos (R117 SOLO = 692 photos, almost certainly
  // mis-matched) from them. Fri+Sat data: every non-Production size category
  // maxes at ≤463 photos; only PRODUCTIONS exceeds that. Two-band model
  // matches operator's actual workflow: Production = extra-length, everything
  // else shoots for similar duration.
  const PRODUCTION_MAX = 1500
  const DEFAULT_MAX = 500
  const MIN_RECORDED = 10
  const routinesOverMax: Array<{ entryNumber: string; count: number; sizeCategory?: string; threshold: number }> = []
  const routinesUnderMin: Array<{ entryNumber: string; count: number; sizeCategory?: string; threshold: number }> = []
  for (const [routineId, list] of photosByRoutine.entries()) {
    const r = routines.find(rr => rr.id === routineId)
    const entryNumber = r?.entryNumber ?? routineId.slice(0, 8)
    const sizeCategory = r?.sizeCategory
    // Case-insensitive prefix match: schedule API returns 'PRODUCTIONS' today
    // but accept 'Production'/'Productions' too for future casing drift.
    const isProduction = (sizeCategory ?? '').toUpperCase().startsWith('PRODUCTION')
    const maxBound = isProduction ? PRODUCTION_MAX : DEFAULT_MAX
    if (list.length > maxBound) {
      routinesOverMax.push({ entryNumber, count: list.length, sizeCategory, threshold: maxBound })
    }
    // Only flag "under min" when the routine has been recorded — pending
    // routines legitimately have zero photos.
    if (list.length > 0 && list.length < MIN_RECORDED && r?.recordingStartedAt) {
      routinesUnderMin.push({ entryNumber, count: list.length, sizeCategory, threshold: MIN_RECORDED })
    }
  }
  if (routinesOverMax.length > 0) {
    logger.photos.warn(`Distribution sanity: ${routinesOverMax.length} routine(s) over max — ` +
      routinesOverMax.slice(0, 5).map(x => `R${x.entryNumber}[${x.sizeCategory ?? '?'}]=${x.count}>${x.threshold}`).join(', '))
  }
  if (routinesUnderMin.length > 0) {
    logger.photos.warn(`Distribution sanity: ${routinesUnderMin.length} recorded routine(s) under min — ` +
      routinesUnderMin.slice(0, 5).map(x => `R${x.entryNumber}[${x.sizeCategory ?? '?'}]=${x.count}<${x.threshold}`).join(', '))
  }

  sendToRenderer(IPC_CHANNELS.PHOTOS_MATCH_RESULT, result)

  // Completion summary — consumed by renderer toast + OrphanReview drawer.
  // Shape is stable (see tests/e2e-sd-import.mjs); extend by adding fields,
  // never rename existing keys. New distribution fields + per-camera offset
  // summary ride alongside existing data — old renderers ignore them.
  try {
    const cameraOffsetSummary: Record<string, number> = {}
    for (const [body, offsetMs] of offsetByBody.entries()) {
      if (body !== '_unknown') cameraOffsetSummary[body] = offsetMs
    }
    const summary = {
      runId: importRunId,
      routinesUpdated: photosByRoutine.size,
      photosUploaded: result.matched, // uploads happen async; this is "photos queued for upload"
      thumbsUploaded: matches.filter(m => m.confidence !== 'unmatched' && m.thumbnailPath).length,
      orphaned: result.unmatched,
      routinesOverMax,
      routinesUnderMin,
      cameraOffsets: cameraOffsetSummary,
    }
    if (previewOnly) {
      // T-F3: write a preview JSON with the per-routine breakdown so the
      // operator can inspect the projected distribution before committing
      // to a real import. Also surface the summary via a dedicated channel.
      const perRoutine: Array<{ entryNumber: string; routineId: string; count: number }> = []
      for (const [routineId, photos] of photosByRoutine.entries()) {
        const r = routines.find((x) => x.id === routineId)
        perRoutine.push({
          entryNumber: r?.entryNumber ?? '?',
          routineId,
          count: photos.length,
        })
      }
      perRoutine.sort((a, b) => a.entryNumber.localeCompare(b.entryNumber, undefined, { numeric: true }))

      let previewJsonPath: string | null = null
      try {
        const importsDir = path.join(outputDir, '_imports')
        await fs.promises.mkdir(importsDir, { recursive: true })
        previewJsonPath = path.join(importsDir, `preview-${importRunId.replace(/[:.]/g, '-')}.json`)
        await fs.promises.writeFile(
          previewJsonPath,
          JSON.stringify({ ...summary, perRoutine, folderPath, windows: windows.length }, null, 2),
        )
      } catch (err) {
        logger.photos.warn('Preview JSON write failed (non-fatal):', err instanceof Error ? err.message : err)
      }

      sendToRenderer(IPC_CHANNELS.PHOTOS_PREVIEW_COMPLETE, {
        ...summary,
        perRoutine,
        folderPath,
        previewJsonPath,
      })
    } else {
      sendToRenderer(IPC_CHANNELS.PHOTOS_IMPORT_COMPLETE_SUMMARY, summary)
    }
  } catch (err) {
    logger.photos.warn('import summary broadcast failed:', err instanceof Error ? err.message : err)
  }

  return result
}

/**
 * Reassign an orphaned photo to a routine. Moves the file from `_orphans/{runId}/`
 * into the target routine's photos folder, deletes the sidecar, and adds the
 * photo to the routine's state. Re-uses the existing auto-upload pipeline.
 *
 * Best-effort — if the routine lacks an outputDir or settings haven't loaded, we
 * log and no-op.
 */
export async function reassignOrphan(orphanPath: string, routineId: string): Promise<{ ok: boolean; error?: string; newPath?: string }> {
  try {
    const comp = state.getCompetition()
    if (!comp) return { ok: false, error: 'no-competition' }
    const routine = comp.routines.find(r => r.id === routineId)
    if (!routine) return { ok: false, error: 'routine-not-found' }
    const outputDir = getSettings().fileNaming.outputDirectory
    const baseDir = routine.outputDir
      ? routine.outputDir
      : path.join(outputDir, `${routine.entryNumber}_${sanitizeFsPathComponent(routine.routineTitle)}_${sanitizeFsPathComponent(routine.studioCode || '')}`)
    const photoDir = path.join(baseDir, 'photos')
    if (!fs.existsSync(photoDir)) await fs.promises.mkdir(photoDir, { recursive: true })

    const existing = routine.photos || []
    // Preserve original camera filename on reassign (same rationale as
    // main import loop). `orphanPath` already carries the native camera
    // basename under `_orphans/<runId>/`; promote it verbatim into the
    // routine's photos dir. 2026-04-25 directive: if a file with the same
    // basename already exists in the routine's photos folder, treat it as
    // already-reassigned and skip; the orphan stays where it is rather
    // than spawning a _dupN copy.
    const originalBasename = path.basename(orphanPath)
    const destFile = path.join(photoDir, originalBasename)
    if (fs.existsSync(destFile)) {
      logger.photos.info(
        `Reassign skipped: ${originalBasename} already exists in routine ${routineId} photos dir`,
      )
      return { ok: false, error: 'already-exists' }
    }
    await fs.promises.rename(orphanPath, destFile).catch(async () => {
      // Cross-device fallback: copy + unlink.
      await fs.promises.copyFile(orphanPath, destFile)
      await fs.promises.unlink(orphanPath)
    })
    // Remove sidecar (best-effort)
    await fs.promises.unlink(orphanPath + '.json').catch(() => {})

    // Thumbnail generation moved to upload worker (T-H17). Leave undefined
    // so upload.ts creates one JIT via ffmpeg after the original PUT lands.
    const newPhoto: PhotoMatch = {
      filePath: destFile,
      thumbnailPath: undefined,
      captureTime: new Date().toISOString(),
      confidence: 'gap',
      uploaded: false,
      matchedRoutineId: routineId,
    }
    const nextPhotos = [...existing, newPhoto]
    state.updateRoutineStatus(routineId, routine.status, { photos: nextPhotos })
    broadcastFullState()

    // Queue for upload if auto-upload is on.
    if (getSettings().behavior.autoUploadAfterEncoding) {
      const fresh = state.getCompetition()?.routines.find(r => r.id === routineId)
      if (fresh) {
        const r = uploadService.enqueueRoutine(fresh)
        if (r.queuedJobs > 0) uploadService.startUploads()
      }
    }
    return { ok: true, newPath: destFile }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.photos.error(`reassignOrphan failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * Scan existing `_orphans/<runId>/` directories and reassign any orphans
 * whose EXIF DateTimeOriginal falls inside a newly-recorded routine's
 * window (with a small buffer). Called from handleRecordingStopped so
 * the "drop SD mid-session, later recordings auto-pick-up" flow works.
 *
 * Best-effort: errors on individual orphans are logged and skipped; the
 * function always resolves. Returns the count of photos successfully
 * reassigned.
 */
export async function rematchOrphansForWindow(
  routineId: string,
  startedAt: Date,
  stoppedAt: Date,
): Promise<number> {
  try {
    const outputDir = getSettings().fileNaming.outputDirectory
    if (!outputDir) return 0
    const orphanRoot = path.join(outputDir, '_orphans')
    if (!fs.existsSync(orphanRoot)) return 0

    // 30s buffer on each side so photos taken right at the boundary count.
    const BUFFER_MS = 30_000
    const winStart = startedAt.getTime() - BUFFER_MS
    const winStop = stoppedAt.getTime() + BUFFER_MS

    const runDirs = await fs.promises.readdir(orphanRoot)
    let reassigned = 0
    for (const runDir of runDirs) {
      const fullRunDir = path.join(orphanRoot, runDir)
      let files: string[]
      try {
        const s = await fs.promises.stat(fullRunDir)
        if (!s.isDirectory()) continue
        files = await fs.promises.readdir(fullRunDir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        const sidecarPath = path.join(fullRunDir, f)
        const jpgPath = sidecarPath.replace(/\.json$/, '')
        try {
          if (!fs.existsSync(jpgPath)) continue
          const raw = await fs.promises.readFile(sidecarPath, 'utf-8')
          const parsed = JSON.parse(raw) as { exifTime?: string; clockOffsetMs?: number }
          if (!parsed.exifTime) continue
          const exifMs = Date.parse(parsed.exifTime)
          if (!Number.isFinite(exifMs)) continue
          // Apply the offset that was detected during the original import.
          // Missing in old orphans (pre-fix) — treat as 0 for back-compat.
          const offset = Number.isFinite(parsed.clockOffsetMs) ? (parsed.clockOffsetMs as number) : 0
          const adjustedMs = exifMs + offset
          if (adjustedMs < winStart || adjustedMs > winStop) continue
          // Match. Reassign.
          const res = await reassignOrphan(jpgPath, routineId)
          if (res.ok) {
            reassigned++
            logger.photos.info(`rematchOrphans: moved ${jpgPath} -> routine ${routineId}`)
          } else {
            logger.photos.warn(`rematchOrphans: reassign failed for ${jpgPath}: ${res.error}`)
          }
        } catch (err) {
          logger.photos.warn(`rematchOrphans: skip ${sidecarPath}: ${err instanceof Error ? err.message : err}`)
        }
      }
    }
    if (reassigned > 0) {
      logger.photos.info(`rematchOrphans: reassigned ${reassigned} photo(s) to routine ${routineId}`)
    }
    return reassigned
  } catch (err) {
    logger.photos.warn(`rematchOrphans failed: ${err instanceof Error ? err.message : err}`)
    return 0
  }
}

/**
 * Scan all currently-mounted camera drives and advance SD watermarks to
 * the latest EXIF capture time on each. Operator's "mark SDs as processed"
 * button fires this — after invocation, subsequent imports only pick up
 * photos with an EXIF capture time later than what's on the SD right now.
 *
 * Side-effect: does NOT import any photos, does NOT modify state.routines.
 * Only writes to state.sdWatermarks.
 *
 * Returns a summary of what was marked, for operator confirmation toast.
 */
export async function markCurrentSdsAsProcessed(): Promise<{
  scannedDrives: number
  watermarksSet: Record<string, string>
  error?: string
}> {
  try {
    // Lazy require to avoid any main-bundle cycle concerns.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const driveMonitor = require('./driveMonitor') as typeof import('./driveMonitor')
    const drives = driveMonitor.scanCurrentCameraDrives()
    if (drives.length === 0) {
      return { scannedDrives: 0, watermarksSet: {} }
    }
    const maxByBody: Record<string, { lastCaptureTime: string; lastFilename?: string }> = {}
    for (const d of drives) {
      // Recursively scan this drive's photo folder for JPEGs and set the
      // watermark from the latest EXIF capture time we find.
      const files = await collectJpegFilenames(d.photoPath)
      for (const full of files) {
        const body = getCameraBodyKey(full)
        if (!body) continue
        const captureTime = await getPhotoCaptureTime(full)
        if (!captureTime) continue
        const iso = captureTime.toISOString()
        const current = maxByBody[body]
        if (!current || iso > current.lastCaptureTime) {
          maxByBody[body] = {
            lastCaptureTime: iso,
            lastFilename: path.basename(full).toUpperCase(),
          }
        }
      }
    }
    state.setSdWatermarksBulk(maxByBody)
    return {
      scannedDrives: drives.length,
      watermarksSet: Object.fromEntries(
        Object.entries(maxByBody).map(([body, entry]) => [body, entry.lastCaptureTime]),
      ),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.photos.error(`markCurrentSdsAsProcessed failed: ${msg}`)
    return { scannedDrives: 0, watermarksSet: {}, error: msg }
  }
}

async function collectJpegFilenames(root: string): Promise<string[]> {
  const out: string[] = []
  const pending: string[] = [root]
  while (pending.length > 0) {
    const dir = pending.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) pending.push(full)
      else if (/\.(jpg|jpeg)$/i.test(e.name)) out.push(full)
    }
  }
  return out
}

/** Delete an orphan photo and its sidecar. */
export async function discardOrphan(orphanPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fs.promises.unlink(orphanPath).catch(() => {})
    await fs.promises.unlink(orphanPath + '.json').catch(() => {})
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}
