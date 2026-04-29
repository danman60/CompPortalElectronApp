import fs from 'fs'
import path from 'path'
import ExifReader from 'exifreader'
import { IPC_CHANNELS, CameraClockMismatchEvent } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import * as events from './events'
import * as state from './state'
import { getCameraBodyKey, importPhotos } from './photos'
import * as upload from './upload'
import { getSettings } from './settings'
import { parseExifLocalDate } from './exifTz'

/**
 * Drive Monitor — detects when removable storage (SD cards, USB drives) is plugged in.
 * Windows-only: polls drive letters for new mounts with DCIM folders (camera storage).
 */

const POLL_INTERVAL_MS = 3000
let pollTimer: NodeJS.Timeout | null = null
let knownDrives = new Set<string>()
let dismissed = new Set<string>() // drives user has dismissed this session

/** Get list of currently mounted drive letters on Windows */
function getWindowsDrives(): string[] {
  if (process.platform !== 'win32') return []
  const drives: string[] = []
  // Check drive letters D: through Z: (skip A:, B: floppy, C: system)
  for (let code = 68; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    const drivePath = `${letter}:\\`
    try {
      fs.accessSync(drivePath)
      drives.push(drivePath)
    } catch {
      // Drive not mounted
    }
  }
  return drives
}

/** Check if a drive looks like a camera SD card (has DCIM folder or JPEGs at root) */
function isCameraDrive(drivePath: string): { isDcim: boolean; photoPath: string; photoCount: number } {
  // Check for DCIM (standard camera folder structure)
  const dcimPath = path.join(drivePath, 'DCIM')
  try {
    if (fs.existsSync(dcimPath) && fs.statSync(dcimPath).isDirectory()) {
      const count = countJpegsRecursive(dcimPath, 2) // 2 levels deep
      return { isDcim: true, photoPath: dcimPath, photoCount: count }
    }
  } catch {}

  // Some cameras dump photos at root or in a folder
  try {
    const rootFiles = fs.readdirSync(drivePath)
    const jpegs = rootFiles.filter(f => /\.(jpg|jpeg)$/i.test(f))
    if (jpegs.length >= 3) {
      return { isDcim: false, photoPath: drivePath, photoCount: jpegs.length }
    }
  } catch {}

  return { isDcim: false, photoPath: '', photoCount: 0 }
}

/** Count JPEGs up to N directory levels deep */
function countJpegsRecursive(dir: string, maxDepth: number): number {
  if (maxDepth < 0) return 0
  let count = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && /\.(jpg|jpeg)$/i.test(entry.name)) {
        count++
      } else if (entry.isDirectory() && maxDepth > 0) {
        count += countJpegsRecursive(path.join(dir, entry.name), maxDepth - 1)
      }
      if (count > 999) return count // stop counting after 999
    }
  } catch {}
  return count
}

/**
 * Collect up to N JPEG paths for EXIF sampling — the N MOST-RECENTLY-MODIFIED
 * files across the whole card.
 *
 * A1 fix 2026-04-28 (root cause from Sunday 2026-04-26 machine_logs): the
 * prior implementation walked the SD breadth-first in `readdirSync` order and
 * bailed after `max * 200` files. On a card with both prior-day subfolders
 * (e.g., `100EOSR6`) and today's subfolder (e.g., `124NZ6_2`), the BFS
 * frequently hit the cap inside the older subfolders and never reached
 * today's. The "highest basename = most recent" assumption only holds within
 * a single subfolder, so basename-sort then picked yesterday's tail rather
 * than today's photos. Result: 3 samples from yesterday → "<2/3 are today" →
 * auto-import skipped during a live event (10:35, 12:18, 14:01 EDT).
 *
 * Now reuses `enumerateSdSamples` (full walk, mtime per file, 50k safety
 * cap), sorts by mtimeMs descending, returns the top N. Identifies today's
 * actual newest shutter actions regardless of which subfolder.
 */
async function collectJpegSamples(dir: string, max: number, maxDepth = 4): Promise<string[]> {
  const samples = await enumerateSdSamples(dir, maxDepth)
  samples.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return samples.slice(0, max).map((s) => s.fullPath)
}

/** Read EXIF DateTimeOriginal → local Date. No mtime/DateTime/DateTimeDigitized fallback. */
async function readExifDateTimeOriginal(filePath: string): Promise<Date | null> {
  try {
    const EXIF_HEADER_SIZE = 128 * 1024
    const fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(EXIF_HEADER_SIZE)
    const { bytesRead } = await fh.read(buf, 0, EXIF_HEADER_SIZE, 0)
    await fh.close()
    const buffer = buf.subarray(0, bytesRead)
    const tags = ExifReader.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    )
    const dateTime = tags['DateTimeOriginal']?.description
    if (!dateTime) return null
    // Phase 2.6: shared TZ contract — operator-machine local, never UTC.
    return parseExifLocalDate(dateTime)
  } catch {
    return null
  }
}

function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Sample up to 5 photos' EXIF DateTimeOriginal and compare to today's local date.
 * If any sampled photo has a non-today date, emit DRIVE_CAMERA_CLOCK_MISMATCH
 * so the renderer can surface a "camera clock is N days off" modal.
 *
 * Runs in the background after DRIVE_DETECTED so the existing import flow isn't
 * blocked — the operator sees both alerts and chooses how to proceed.
 */
async function sampleAndReportCameraClock(
  drivePath: string,
  photoPath: string,
  label: string,
): Promise<{ daysOffMax: number; sampledCount: number }> {
  try {
    // Collect a wider pool, then filter out photos already past the per-body
    // SD watermark by EXIF capture time. Without this filter, a
    // partially-imported SD re-inserted produced false "N days off" popups
    // because the sampler hit leftover old photos even though today's shots
    // were there too. Over-collect 5× to survive filtering.
    const rawSamples = await collectJpegSamples(photoPath, 5 * 5)
    const watermarks = state.listSdWatermarks()
    const samples: string[] = []
    let watermarkFiltered = 0
    for (const s of rawSamples) {
      const body = getCameraBodyKey(s)
      const wm = body ? watermarks[body] : null
      if (wm) {
        const exif = await readExifDateTimeOriginal(s)
        if (exif && exif.toISOString() <= wm.lastCaptureTime) {
          watermarkFiltered++
          continue
        }
      }
      samples.push(s)
      if (samples.length >= 5) break
    }
    if (watermarkFiltered > 0) {
      logger.photos.info(
        `Clock sampler: filtered ${watermarkFiltered} already-watermarked photos, kept ${samples.length} fresh sample(s)`,
      )
    }
    if (samples.length === 0) {
      logger.photos.info(
        `Drive ${drivePath}: all JPEG samples are below the SD watermark (already processed) — skipping clock check`,
      )
      // No fresh samples to verify against; treat as clock-unknown but not
      // day-mismatched. Auto-import gate uses daysOffMax>0 as the abort
      // signal, so 0 here leaves the gate open (correct for re-inserts of
      // cards already fully processed).
      return { daysOffMax: 0, sampledCount: 0 }
    }

    const today = new Date()
    const todayDate = toLocalIsoDate(today)
    const dateCounts = new Map<string, number>()
    let sampledCount = 0
    let daysOffMax = 0

    for (const filePath of samples) {
      const dt = await readExifDateTimeOriginal(filePath)
      if (!dt) continue
      sampledCount++
      const isoDate = toLocalIsoDate(dt)
      dateCounts.set(isoDate, (dateCounts.get(isoDate) || 0) + 1)

      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      const shotMidnight = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
      const diffDays = Math.abs(Math.round(
        (shotMidnight.getTime() - todayMidnight.getTime()) / (24 * 60 * 60 * 1000),
      ))
      if (diffDays > daysOffMax) daysOffMax = diffDays
    }

    if (sampledCount === 0) {
      logger.photos.info(`Drive ${drivePath}: no EXIF timestamps in samples — skipping clock check`)
      return { daysOffMax: 0, sampledCount: 0 }
    }
    if (daysOffMax === 0) {
      logger.photos.info(`Drive ${drivePath}: camera clock matches today (${sampledCount} samples OK)`)
      return { daysOffMax: 0, sampledCount }
    }

    // Pick dominant date: highest count, tiebreaker = furthest from today.
    let dominantDate = todayDate
    let dominantCount = -1
    let dominantDiff = -1
    for (const [iso, count] of dateCounts) {
      const d = new Date(iso + 'T00:00:00')
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      const diffDays = Math.abs(Math.round(
        (d.getTime() - todayMidnight.getTime()) / (24 * 60 * 60 * 1000),
      ))
      if (count > dominantCount || (count === dominantCount && diffDays > dominantDiff)) {
        dominantCount = count
        dominantDiff = diffDays
        dominantDate = iso
      }
    }

    const sortedDates = [...dateCounts.keys()].sort().reverse()
    const payload: CameraClockMismatchEvent = {
      drivePath,
      photoPath,
      label,
      sampledDates: sortedDates,
      dominantDate,
      todayDate,
      daysOffMax,
      sampleCount: sampledCount,
    }
    logger.photos.warn(
      `CAMERA_CLOCK_MISMATCH (suppressed UI 2026-04-25 per operator): ${drivePath} (${label}) — ` +
      `dominant=${dominantDate}, today=${todayDate}, daysOff=${daysOffMax}, samples=${sampledCount}`,
    )
    // Operator request 2026-04-25 mid-show: stop showing the camera-clock-off
    // modal. Real SD cards always have other days on them (yesterday's
    // session, prior comp leftovers, etc.); the modal fires constantly and
    // adds no value — non-today photos already fall back to nearest-window
    // matching or the orphans bucket per existing import logic. Keeping the
    // structured event for diagnostics + the warn log for forensics.
    // sendToRenderer(IPC_CHANNELS.DRIVE_CAMERA_CLOCK_MISMATCH, payload)  // disabled
    events.emit('drive.clockMismatch', { drivePath, label, dominantDate, todayDate, daysOffMax, sampleCount: sampledCount, sampledDates: sortedDates })
    return { daysOffMax, sampledCount }
  } catch (err) {
    logger.photos.warn(
      `sampleAndReportCameraClock failed for ${drivePath}:`,
      err instanceof Error ? err.message : err,
    )
    return { daysOffMax: 0, sampledCount: 0 }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// T-V7-25 — Missing-photo detection on SD plug-in
// ─────────────────────────────────────────────────────────────────────────
//
// App-integrated version of scripts/upload-sat-evening-gap.py. On drive-detect:
// enumerate SD JPEGs by body prefix, bracket each body's shot-time range via
// mtime (EXIF fallback when mtime-ambiguous, see gotcha list), cross-reference
// against competition routines that are zero-photo or below size-category
// minimum AND whose recording window falls inside any body's shot-time range.
// If a gap is found, DB cross-check and emit DRIVE_MISSING_PHOTOS_DETECTED with
// the delta. Renderer offers "Import Missing Only" / "Full Import" / "Cancel".
//
// Gotchas (from 2026-04-19 retrospective — encoded in the pure function):
//   1. Body rollover is real (P22→P23 at Sat 21:02 EDT). Walk ALL prefixes.
//   2. Watermarks for retired bodies are harmless — do NOT use body presence
//      in watermarks as a signal.
//   3. EXIF read is slow (~10ms/photo) — use mtime for routine mapping; fall
//      back to EXIF only when mtime-match is ambiguous (not implemented in
//      this first pass; mtime-only is the documented baseline).

// Keep in sync with photos.ts distribution-sanity thresholds.
const SIZE_BOUNDS_PRODUCTION_MIN = 100
const SIZE_BOUNDS_DEFAULT_MIN = 10

export interface SdPhotoSample {
  filename: string
  fullPath: string
  body: string | null
  mtimeMs: number
}

export interface RoutineSurveyRow {
  routineId: string
  entryNumber: string
  sizeCategory?: string
  videoStartMs: number | null
  videoEndMs: number | null
  photoCount: number
}

export interface RecoveryPlanRoutine {
  routineId: string
  entryNumber: string
  sizeCategory?: string
  photoCount: number
  minExpected: number
  missing: string[] // filenames on SD within window, NOT yet in DB
}

export interface RecoveryPlan {
  routines: RecoveryPlanRoutine[]
  totalMissing: number
}

/**
 * Pure: given the SD's JPEG inventory (filename + mtime + body), the routine
 * survey (windows + current photo counts), and the per-routine DB filename
 * sets, produce a recovery plan listing ONLY truly-missing photos per routine.
 *
 * This is the unit-testable core. The live driver (surveyAndReportMissingPhotos)
 * handles filesystem/EXIF/DB I/O and calls this.
 */
export function computeMissingPhotosPlan(
  samples: SdPhotoSample[],
  routines: RoutineSurveyRow[],
  dbFilenamesByRoutine: Record<string, Set<string>>,
  opts: { nowMs?: number; bufferMs?: number } = {},
): RecoveryPlan {
  const bufferMs = opts.bufferMs ?? 30_000 // mirror the photos.ts window buffer

  const plan: RecoveryPlanRoutine[] = []
  let totalMissing = 0

  for (const r of routines) {
    if (r.videoStartMs == null || r.videoEndMs == null) continue

    const isProd = (r.sizeCategory ?? '').toUpperCase().startsWith('PRODUCTION')
    const minExpected = isProd ? SIZE_BOUNDS_PRODUCTION_MIN : SIZE_BOUNDS_DEFAULT_MIN

    // Only surface routines that are zero OR below expected minimum.
    if (r.photoCount >= minExpected) continue

    const windowStart = r.videoStartMs - bufferMs
    const windowEnd = r.videoEndMs + bufferMs

    const sdInWindow = samples.filter(
      (s) => s.mtimeMs >= windowStart && s.mtimeMs <= windowEnd,
    )
    if (sdInWindow.length === 0) continue

    const dbSet = dbFilenamesByRoutine[r.routineId] ?? new Set<string>()
    const missing = sdInWindow
      .map((s) => s.filename)
      .filter((f) => !dbSet.has(f))

    if (missing.length === 0) continue

    plan.push({
      routineId: r.routineId,
      entryNumber: r.entryNumber,
      sizeCategory: r.sizeCategory,
      photoCount: r.photoCount,
      minExpected,
      missing,
    })
    totalMissing += missing.length
  }

  return { routines: plan, totalMissing }
}

/** Walk SD tree (bounded depth) collecting ALL JPEGs with mtime + body prefix. */
async function enumerateSdSamples(photoPath: string, maxDepth = 4): Promise<SdPhotoSample[]> {
  const out: SdPhotoSample[] = []
  const pending: Array<{ dir: string; depth: number }> = [{ dir: photoPath, depth: 0 }]
  while (pending.length > 0) {
    const cur = pending.shift()!
    if (cur.depth > maxDepth) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur.dir, e.name)
      if (e.isDirectory()) {
        pending.push({ dir: full, depth: cur.depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      if (!/\.(jpg|jpeg)$/i.test(e.name)) continue
      try {
        const st = fs.statSync(full)
        out.push({
          filename: e.name,
          fullPath: full,
          body: getCameraBodyKey(full) ?? null,
          mtimeMs: st.mtimeMs,
        })
      } catch {
        // skip unreadable files
      }
    }
    // Yield roughly every 200 JPEGs accumulated to keep the main thread responsive
    // on 10k+ card scans.
    if (out.length % 200 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    // Safety cap so a pathological SD can't block main thread.
    if (out.length > 50000) break
  }
  return out
}

/**
 * Fire the missing-photos survey for a newly-detected SD. Fire-and-forget;
 * errors are logged, never thrown. Only fires when:
 *   - competition is loaded
 *   - CompPortal /api/plugin/list-photos reachable (else skip — no point
 *     raising recovery UI we can't stand behind)
 * Runs in parallel with the existing clock-mismatch sampler; the two are
 * independent signals.
 */
async function surveyAndReportMissingPhotos(
  drivePath: string,
  photoPath: string,
): Promise<void> {
  try {
    const comp = state.getCompetition()
    if (!comp) return

    const samples = await enumerateSdSamples(photoPath)
    if (samples.length === 0) return

    // Build routine survey — only routines with a recording window + a
    // photo count (zero or below size-bound min).
    const survey: RoutineSurveyRow[] = []
    const candidateIds: string[] = []
    for (const r of comp.routines) {
      const startIso = r.recordingStartedAt
      const stopIso = r.recordingStoppedAt
      if (!startIso || !stopIso) continue
      const startMs = new Date(startIso).getTime()
      const stopMs = new Date(stopIso).getTime()
      if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) continue

      const isProd = (r.sizeCategory ?? '').toUpperCase().startsWith('PRODUCTION')
      const minExpected = isProd ? SIZE_BOUNDS_PRODUCTION_MIN : SIZE_BOUNDS_DEFAULT_MIN
      const photoCount = (r.photos || []).length
      if (photoCount >= minExpected) continue

      survey.push({
        routineId: r.id,
        entryNumber: r.entryNumber,
        sizeCategory: r.sizeCategory,
        videoStartMs: startMs,
        videoEndMs: stopMs,
        photoCount,
      })
      candidateIds.push(r.id)
    }
    if (survey.length === 0) {
      logger.photos.info(
        `Missing-photo survey (${drivePath}): no routines below size-bounds minimum — skipping`,
      )
      return
    }

    // DB cross-check via upload.fetchExistingFilenames.
    const { map: dbFilenamesByRoutine, endpointAvailable } =
      await upload.fetchExistingFilenames(candidateIds)
    if (!endpointAvailable) {
      logger.photos.info(
        `Missing-photo survey (${drivePath}): list-photos endpoint unavailable — skipping recovery toast (degrade to normal import flow)`,
      )
      return
    }

    const plan = computeMissingPhotosPlan(samples, survey, dbFilenamesByRoutine)
    if (plan.totalMissing === 0) {
      logger.photos.info(
        `Missing-photo survey (${drivePath}): ${survey.length} candidate routines, 0 missing photos — no recovery needed`,
      )
      return
    }

    logger.photos.warn(
      `MISSING_PHOTOS_DETECTED: ${drivePath} covers ${plan.routines.length} below-min routine(s), ${plan.totalMissing} missing photos`,
    )
    sendToRenderer(IPC_CHANNELS.DRIVE_MISSING_PHOTOS_DETECTED, {
      drivePath,
      photoPath,
      routinesAffected: plan.routines.map((r) => ({
        entryNumber: r.entryNumber,
        routineId: r.routineId,
        sizeCategory: r.sizeCategory,
        photoCount: r.photoCount,
        minExpected: r.minExpected,
        missing: r.missing,
      })),
      totalMissing: plan.totalMissing,
    })
    events.emit('drive.missingPhotos', {
      drivePath,
      totalMissing: plan.totalMissing,
      routinesAffected: plan.routines.length,
    })
    // T-V7-26: also run a scoped reconcile through the unified engine for
    // just the affected routines. Silent=false so the ReconcileToast can
    // surface the queued count. The MissingPhotosToast (from batch 2) still
    // drives the operator-facing recovery action; this runs in parallel to
    // heal any drift the reconciler can catch without an import (stale
    // uploaded:false flags for photos already in DB, etc).
    try {
      const routineIds = plan.routines.map((r) => r.routineId)
      void import('./mediaReconciler').then((reconciler) =>
        reconciler.reconcileMedia({
          scope: 'sd-plugin',
          routineIds,
          silent: false,
        }).catch(() => {}),
      ).catch(() => {})
    } catch {}
  } catch (err) {
    logger.photos.warn(
      `surveyAndReportMissingPhotos failed for ${drivePath}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/** Get drive label via Windows vol command */
function getDriveLabel(drivePath: string): string {
  try {
    const { execSync } = require('child_process')
    const letter = drivePath.charAt(0)
    const output = execSync(`vol ${letter}:`, { timeout: 3000, windowsHide: true, encoding: 'utf-8' })
    // Output: " Volume in drive E is CANON_EOS\n Volume Serial Number is XXXX-XXXX"
    const match = output.match(/Volume in drive [A-Z] is (.+)/i)
    if (match) return match[1].trim()
  } catch {}
  return drivePath
}

function poll(): void {
  const currentDrives = getWindowsDrives()
  const currentSet = new Set(currentDrives)

  // Detect newly appeared drives
  for (const drive of currentDrives) {
    if (!knownDrives.has(drive) && !dismissed.has(drive)) {
      // New drive detected — check if it's a camera
      const camera = isCameraDrive(drive)
      if (camera.photoCount > 0) {
        const label = getDriveLabel(drive)
        logger.photos.info(
          `Camera drive detected: ${drive} (${label}) — ${camera.photoCount} photos in ${camera.isDcim ? 'DCIM' : 'root'}`,
        )

        // v15.2: Fire the main-process auto-import FIRST so importPhotos
        // claims the import lock BEFORE the renderer's DriveAlert auto-fires
        // its own PHOTOS_IMPORT IPC on DRIVE_DETECTED. Previously the
        // renderer won the race (~9s head start) and the main-process call
        // was rejected with "Already importing this folder", so the
        // dedup-by-DB + offset-gate path never ran.
        //
        // Phase 2.1 (2026-04-29): the legacy `<2/3 today` pre-check was
        // REMOVED. It misfired on multi-day cards (Day N where the card has
        // photos from Day 1..N → <2/3 are today → false skip), which is
        // exactly the operator's normal workflow. Watermark filter (per
        // body, EXIF time-based) handles the "already imported" case.
        // Per-photo strict-today filter (always-on unless operator opts in
        // to "include photos from prior days") handles the cross-body
        // contamination case. The full clock sampler + survey still run
        // fire-and-forget AFTER auto-import for their popups.
        void (async () => {
          try {
            const comp = state.getCompetition()
            if (!comp) {
              logger.photos.info(`Auto-import skipped for ${drive}: no competition loaded`)
              return
            }
            const outputDir = getSettings().fileNaming?.outputDirectory
            if (!outputDir) {
              logger.photos.info(`Auto-import skipped for ${drive}: outputDirectory not configured`)
              return
            }

            logger.photos.info(
              `Auto-import: ${drive} (pre-check OK) — full scan with DB dedup + 5min offset gate`,
            )
            const result = await importPhotos(
              camera.photoPath,
              comp.routines,
              outputDir,
              {
                dedupByDb: true,
                autoAbortOffsetMs: 5 * 60 * 1000,
              },
            )
            if ('error' in result) {
              logger.photos.warn(`Auto-import rejected for ${drive}: ${result.error}`)
            }
          } catch (err) {
            logger.photos.warn(
              `Auto-import orchestration failed for ${drive}: ${err instanceof Error ? err.message : err}`,
            )
          }
        })()

        // v15.2: DRIVE_DETECTED + full clock sampler + missing-photo survey
        // run AFTER the auto-import is fired. The sampler still surfaces the
        // "N days off" popup when warranted and the survey's reconcile is
        // still useful. Both stay fire-and-forget so they don't block.
        sendToRenderer(IPC_CHANNELS.DRIVE_DETECTED, {
          drivePath: drive,
          photoPath: camera.photoPath,
          photoCount: camera.photoCount,
          isDcim: camera.isDcim,
          label,
        })
        events.emit('drive.detected', { drive, label, photoCount: camera.photoCount, isDcim: camera.isDcim })
        sampleAndReportCameraClock(drive, camera.photoPath, label).catch(() => {})
        surveyAndReportMissingPhotos(drive, camera.photoPath).catch(() => {})
      }
    }
  }

  // Detect removed drives — clean up dismissed set
  for (const drive of dismissed) {
    if (!currentSet.has(drive)) {
      dismissed.delete(drive)
    }
  }

  knownDrives = currentSet
}

export function dismissDrive(drivePath: string): void {
  dismissed.add(drivePath)
  logger.photos.info(`Drive dismissed: ${drivePath}`)
}

/**
 * Kick photo-import: re-fire auto-import for any currently-mounted camera
 * drive. Used when the operator sees a card sitting and wants to nudge a
 * stalled import without ejecting + re-inserting the SD.
 *
 * Safe to call even mid-import: the importLock + dedupByDb gate skip work
 * already in progress or already imported.
 */
export async function kickPhotoImports(): Promise<{ kicked: number; reasons: string[] }> {
  if (process.platform !== 'win32') {
    return { kicked: 0, reasons: ['not-windows'] }
  }
  const drives = getWindowsDrives()
  const reasons: string[] = []
  let kicked = 0
  for (const drive of drives) {
    try {
      const camera = isCameraDrive(drive)
      if (camera.photoCount <= 0) continue
      const comp = state.getCompetition()
      if (!comp) {
        reasons.push(`${drive}: no competition loaded`)
        continue
      }
      const outputDir = getSettings().fileNaming?.outputDirectory
      if (!outputDir) {
        reasons.push(`${drive}: outputDirectory not configured`)
        continue
      }
      logger.photos.info(`kickPhotoImports: re-firing auto-import for ${drive}`)
      kicked++
      void importPhotos(camera.photoPath, comp.routines, outputDir, {
        dedupByDb: true,
        autoAbortOffsetMs: 5 * 60 * 1000,
      }).catch((err) => {
        logger.photos.warn(`kickPhotoImports: ${drive} failed: ${err instanceof Error ? err.message : err}`)
      })
    } catch (err) {
      reasons.push(`${drive}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { kicked, reasons }
}

export function startMonitoring(): void {
  if (pollTimer) return
  if (process.platform !== 'win32') {
    logger.photos.info('Drive monitor skipped (not Windows)')
    return
  }

  // Reversed 2026-04-25: previously knownDrives was primed with all
  // currently-mounted drives at boot so only FRESH (eject + re-insert)
  // insertions fired DRIVE_DETECTED. That meant if the operator left SDs
  // plugged in overnight (or the app crashed and was relaunched) the
  // already-mounted SDs were silent and required physical re-seating to
  // trigger import.
  //
  // Operator directive 2026-04-25: treat already-mounted SDs at boot the
  // same as fresh insertions. Two existing safeguards prevent bad imports:
  //   (1) pre-check in poll() — rejects when <2/3 sampled EXIF dates are
  //       today (yesterday's SD or archive USB will fail the gate).
  //   (2) dedupByDb in importPhotos — already-uploaded photos are skipped.
  // knownDrives is left empty so the first poll() tick fires DRIVE_DETECTED
  // for every mounted camera drive.
  const initialDrives = getWindowsDrives()
  const startupCameraDrives: string[] = []
  for (const drive of initialDrives) {
    try {
      const camera = isCameraDrive(drive)
      if (camera.photoCount > 0) {
        startupCameraDrives.push(drive)
      }
    } catch {
      // fall through
    }
  }
  knownDrives = new Set<string>()
  logger.photos.info(
    `Drive monitor started — ${initialDrives.length} mounted drive(s), ${startupCameraDrives.length} camera-looking; ` +
    `boot-mounted SDs will fire DRIVE_DETECTED on first poll (per-photo today-filter + watermark + dedup-by-DB gate re-imports)`,
  )
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
}

export function stopMonitoring(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * Enumerate currently-mounted drives that look like cameras (DCIM with
 * JPEGs). Used by the "mark current SDs as processed" operator action so
 * the watermark setter knows which drives to scan. Safe to call at any
 * time — does not fire DRIVE_DETECTED, does not mutate any state.
 */
export function scanCurrentCameraDrives(): Array<{
  drivePath: string
  photoPath: string
  photoCount: number
  isDcim: boolean
  label: string
}> {
  if (process.platform !== 'win32') return []
  const drives = getWindowsDrives()
  const out: Array<{
    drivePath: string
    photoPath: string
    photoCount: number
    isDcim: boolean
    label: string
  }> = []
  for (const drive of drives) {
    try {
      const cam = isCameraDrive(drive)
      if (cam.photoCount > 0) {
        out.push({
          drivePath: drive,
          photoPath: cam.photoPath,
          photoCount: cam.photoCount,
          isDcim: cam.isDcim,
          label: getDriveLabel(drive),
        })
      }
    } catch {}
  }
  return out
}
