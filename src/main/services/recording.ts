import fs from 'fs'
import path from 'path'
import * as obs from './obs'
import * as state from './state'
import * as ffmpegService from './ffmpeg'
import * as overlay from './overlay'
// Auto-fire state is persisted via overlay config
import * as wsHub from './wsHub'
import * as uploadService from './upload'
import * as tether from './tether'
// Cyclic import: photos.ts imports `broadcastFullState` from this file.
// Both sides only access the imports inside function bodies (never at
// module-evaluation time), so Vite resolves the cycle correctly via
// getter-based bindings.
import * as photos from './photos'
import * as jobQueue from './jobQueue'
import * as take from './take'
import * as events from './events'
import { getSettings } from './settings'
import * as schedule from './schedule'
import { postNowPlaying } from './compPortal'
import { dialog, BrowserWindow } from 'electron'
import { IPC_CHANNELS, Routine, type ActiveTake, type RoutineStatus } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'

// --- Active recording tracking ---
let activeRecordingRoutineId: string | null = null
let pendingStopProcessing: { promise: Promise<void>; resolve: () => void } | null = null

/**
 * Item 17: external setter so the click-to-reassign IPC handler can move the
 * runtime pointer when the operator retargets mid-record. The take file is
 * the durable counterpart; this exists so handleRecordingStopped (and
 * watchdog telemetry) reflect the new target immediately.
 */
export function setActiveRecordingRoutineId(routineId: string | null): void {
  activeRecordingRoutineId = routineId
}

export function getActiveRecordingRoutineId(): string | null {
  return activeRecordingRoutineId
}

// --- Fix 11: Watchdog tracking ---
let recordStartedAt: number | null = null
let expectedObsOutputDir: string | null = null
let watchdogTimer: NodeJS.Timeout | null = null
let lastDisconnectAlert = 0
let silentStopAlertFired = false
let stuckAlertFired = false

function startRecordingWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer)
  lastDisconnectAlert = 0
  silentStopAlertFired = false
  stuckAlertFired = false
  watchdogTimer = setInterval(() => {
    if (!activeRecordingRoutineId) { stopRecordingWatchdog(); return }
    const s = obs.getState()
    const now = Date.now()
    if (s.connectionStatus !== 'connected') {
      if (now - lastDisconnectAlert > 30000) {
        lastDisconnectAlert = now
        sendToRenderer(IPC_CHANNELS.RECORDING_ALERT, {
          level: 'error',
          message: `OBS disconnected mid-record for routine ${activeRecordingRoutineId}`,
          routineId: activeRecordingRoutineId,
        })
        logger.app.error(`Watchdog: OBS disconnected mid-record for routine ${activeRecordingRoutineId}`)
      }
      return
    }
    if (!s.isRecording && recordStartedAt && now - recordStartedAt > 10000 && !silentStopAlertFired) {
      silentStopAlertFired = true
      sendToRenderer(IPC_CHANNELS.RECORDING_ALERT, {
        level: 'error',
        message: 'OBS stopped recording but routine still marked recording',
        routineId: activeRecordingRoutineId,
      })
      logger.app.error('Watchdog: OBS stopped recording but routine still marked recording')
      reconcileOrphanedRecording().catch((err) => logger.app.warn('Reconcile from watchdog failed:', err))
    }
    const maxMinutes = getSettings().obs.maxRecordMinutes || 0
    if (maxMinutes > 0 && recordStartedAt && !stuckAlertFired) {
      const elapsedMs = now - recordStartedAt
      if (elapsedMs > (maxMinutes + 2) * 60000) {
        stuckAlertFired = true
        sendToRenderer(IPC_CHANNELS.RECORDING_ALERT, {
          level: 'error',
          message: `Recording has been active > ${maxMinutes + 2}min. Check OBS.`,
          routineId: activeRecordingRoutineId,
        })
        logger.app.error(`Watchdog: recording stuck > ${maxMinutes + 2}min for routine ${activeRecordingRoutineId}`)
      }
    }
  }, 5000)
}

function stopRecordingWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
  recordStartedAt = null
  expectedObsOutputDir = null
  lastDisconnectAlert = 0
  silentStopAlertFired = false
  stuckAlertFired = false
}

// --- Re-record hard-gate decision registry (E1) ---
// Phase 2.8 / Take architecture (2026-04-29): three actions instead of two.
// Threshold lowered from 90s → 30s. Sub-30s = silent archive.
//   - 'archive':         new take canonical; prior MKV → _archive/v{N}/.
//                        Prior take's window preserved in state.takes[];
//                        currentRoutineId stays pointing here.
//   - 'specify-routine': new take's currentRoutineId mutates to picked
//                        routine. Prior take stays for original routine.
//                        File moves to picked routine's folder.
//   - 'save-as-extra':   new take's currentRoutineId mutates to a freshly-
//                        created lateInsert row at the typed entry number.
type RerecDecisionKind = 'archive' | 'specify-routine' | 'save-as-extra'
type RerecDecision =
  | { kind: 'archive' }
  | { kind: 'specify-routine'; routineId: string }
  | { kind: 'save-as-extra'; emptyRoutineNumber: string }
const rerecDecisionResolvers = new Map<string, (d: RerecDecision) => void>()
let rerecProposalCounter = 0

export function resolveRerecDecision(proposalId: string, decision: RerecDecision): void {
  const fn = rerecDecisionResolvers.get(proposalId)
  if (!fn) return
  rerecDecisionResolvers.delete(proposalId)
  fn(decision)
}

async function requestRerecDecision(payload: {
  currentRoutineId: string
  currentEntryNumber: string
  nextEntryNumber: string | null
  priorMkvName: string | null
  priorEncodedFiles: string[]
  newMkvPath: string
  newDurationSec: number
}): Promise<RerecDecision> {
  const proposalId = `rerec-${Date.now()}-${++rerecProposalCounter}`
  const detectedAt = new Date().toISOString()
  return new Promise<RerecDecision>((resolve) => {
    // Safety timeout — if the operator never clicks (unattended laptop,
    // renderer crashed mid-show), default to 'archive' (legacy behavior) so
    // we never leave post-stop processing permanently stalled. 2 minutes
    // mirrors the photos-offset-proposal timeout.
    const timeout = setTimeout(() => {
      if (rerecDecisionResolvers.has(proposalId)) {
        rerecDecisionResolvers.delete(proposalId)
        logger.app.warn(`Re-record decision ${proposalId} timed out after 120s — defaulting to 'archive'`)
        resolve({ kind: 'archive' })
      }
    }, 120_000)
    rerecDecisionResolvers.set(proposalId, (d) => {
      clearTimeout(timeout)
      resolve(d)
    })
    sendToRenderer(IPC_CHANNELS.RECORDING_REREC_DECISION_REQUESTED, {
      proposalId,
      detectedAt,
      ...payload,
    })
  })
}

async function reconcileOrphanedRecording(): Promise<void> {
  if (!activeRecordingRoutineId || !recordStartedAt) return
  const searchDirs: string[] = []
  if (expectedObsOutputDir) searchDirs.push(expectedObsOutputDir)
  const dynamicDir = await obs.getRecordDirectory().catch(() => null)
  if (dynamicDir && !searchDirs.includes(dynamicDir)) searchDirs.push(dynamicDir)

  const windowStart = recordStartedAt - 5000
  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue
      const entries = await fs.promises.readdir(dir)
      const candidates: Array<{ p: string; mtime: number }> = []
      for (const e of entries) {
        if (!/\.(mkv|mp4|flv)$/i.test(e)) continue
        const p = path.join(dir, e)
        try {
          const st = await fs.promises.stat(p)
          if (st.mtimeMs >= windowStart) candidates.push({ p, mtime: st.mtimeMs })
        } catch {}
      }
      candidates.sort((a, b) => b.mtime - a.mtime)
      if (candidates.length > 0) {
        const best = candidates[0]
        logger.app.warn(`Reconcile: salvaging orphaned recording ${best.p}`)
        await handleRecordingStopped(best.p, new Date().toISOString())
        return
      }
    } catch (err) {
      logger.app.warn(`Reconcile: scan failed for ${dir}: ${err instanceof Error ? err.message : err}`)
    }
  }
  const routineId = activeRecordingRoutineId
  logger.app.error(`Reconcile: no orphaned file found for routine ${routineId} — marking interrupted`)
  state.updateRoutineStatus(routineId, 'recording_interrupted', {
    error: 'Recording interrupted (OBS disconnected or stopped silently). No output file recovered.',
  })
  // Venue TV "now playing" sync — clear on interrupt
  postNowPlaying(null).catch(() => {})
  activeRecordingRoutineId = null
  stopRecordingWatchdog()
  obs.setActiveAlertRoutineId(null)
  broadcastFullStateImmediate()
}

export function handleObsReconcile(info: { outputActive: boolean; recordDirectory: string | null }): void {
  if (!activeRecordingRoutineId) {
    if (info.outputActive) {
      logger.app.warn('OBS reports active recording but no activeRecordingRoutineId — ghost recording')
    }
    return
  }
  if (info.outputActive) {
    logger.app.info(`Reconcile: OBS still recording for routine ${activeRecordingRoutineId} — no action`)
    if (info.recordDirectory) expectedObsOutputDir = info.recordDirectory
    return
  }
  logger.app.warn('Reconcile: OBS not recording but routine still marked active — attempting salvage')
  if (info.recordDirectory) expectedObsOutputDir = info.recordDirectory
  reconcileOrphanedRecording().catch((err) => logger.app.warn('Reconcile salvage failed:', err))
}

// --- Navigation busy guard (prevents rapid double-advance) ---
let navBusy = false

// --- Auto-fire lower third (persisted via overlay config) ---
let autoFireTimer: NodeJS.Timeout | null = null

export function setAutoFire(enabled: boolean): void {
  overlay.setAutoFirePersisted(enabled)
  if (!enabled && autoFireTimer) {
    clearTimeout(autoFireTimer)
    autoFireTimer = null
  }
  logger.app.info(`Lower third auto-fire: ${enabled ? 'ON' : 'OFF'}`)
}

export function getAutoFire(): boolean {
  return overlay.getAutoFirePersisted()
}

function scheduleAutoFire(): void {
  if (!getAutoFire()) return
  if (autoFireTimer) clearTimeout(autoFireTimer)
  autoFireTimer = setTimeout(() => {
    overlay.fireLowerThird()
    autoFireTimer = null
    logger.app.info('Overlay lower third auto-fired (3s delay)')
  }, 3000)
}

const MIN_FREE_GB_TO_RECORD = 5

/** Fix 2 + Fix 8: Validate that recording can start. Returns null if OK, or a blocked reason. */
export function canStartRecording(): { blocked: true; reason: 'no-output-dir' | 'dir-not-accessible' | 'disk-space-low' | 'no-routine-selected' | 'routine-scratched'; detail?: string } | null {
  // Block if the operator hasn't explicitly selected a routine. Prior behavior
  // silently bound recordings to whatever getCurrentRoutine returned — if that
  // fell through to the first visible routine (R100), the operator would think
  // they were recording a different routine while bytes were actually going to
  // R100. Force an explicit click.
  const routine = state.getCurrentRoutine()
  if (!routine) {
    logger.app.error('No routine selected — recording blocked')
    sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'no-routine-selected' })
    return { blocked: true, reason: 'no-routine-selected', detail: 'Click a routine row before pressing RECORD.' }
  }
  if (routine.status === 'scratched') {
    logger.app.error(`Routine ${routine.entryNumber} is scratched — recording blocked`)
    sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'routine-scratched', detail: routine.entryNumber })
    return { blocked: true, reason: 'routine-scratched', detail: `Routine #${routine.entryNumber} is marked scratched. Advance first.` }
  }

  const settings = getSettings()
  const outputDir = settings.fileNaming.outputDirectory
  if (!outputDir || outputDir.trim() === '') {
    logger.app.error('No output directory configured — recording blocked')
    sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'no-output-dir' })
    return { blocked: true, reason: 'no-output-dir' }
  }
  if (!fs.existsSync(outputDir)) {
    logger.app.error(`Output directory not found: ${outputDir}`)
    sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'dir-not-accessible', detail: outputDir })
    return { blocked: true, reason: 'dir-not-accessible', detail: outputDir }
  }
  try {
    fs.accessSync(outputDir, fs.constants.W_OK)
  } catch {
    logger.app.error(`Output directory not writable: ${outputDir}`)
    sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'dir-not-accessible', detail: outputDir })
    return { blocked: true, reason: 'dir-not-accessible', detail: outputDir }
  }
  try {
    const drive = outputDir.match(/^[a-zA-Z]:\\/) ? outputDir.slice(0, 3) : outputDir
    const stats = fs.statfsSync(drive)
    const freeGB = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024)
    if (freeGB < MIN_FREE_GB_TO_RECORD) {
      logger.app.error(`Disk space too low to record: ${freeGB.toFixed(1)}GB free`)
      sendToRenderer(IPC_CHANNELS.RECORDING_BLOCKED, { reason: 'disk-space-low', detail: `${freeGB.toFixed(1)}GB free` })
      return { blocked: true, reason: 'disk-space-low', detail: `${freeGB.toFixed(1)}GB free` }
    }
  } catch (err) {
    logger.app.warn(`Could not check disk space for ${outputDir}: ${err instanceof Error ? err.message : err}`)
  }
  return null
}

/** Check if starting a recording would overwrite an existing one, and ask for confirmation. */
export async function confirmReRecordIfNeeded(): Promise<boolean> {
  const routine = state.getCurrentRoutine()
  if (!routine) return true
  // Only prompt if routine has already been recorded/encoded/uploaded
  if (routine.status === 'pending' || routine.status === 'skipped' || routine.status === 'scratched') return true

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return true

  // Phase 4.1 / Take architecture (2026-04-29): reassuring wording so the
  // operator knows nothing destructive happens. Stays blocking — operator
  // must acknowledge — so accidental RECORD presses can be cancelled before
  // anything changes.
  const result = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Re-record this routine?',
    message: `Routine #${routine.entryNumber} "${routine.routineTitle}" already has a recording (status: ${routine.status}).`,
    detail:
      'Starting a new one keeps the old recording safe in an archive folder — nothing is overwritten or lost. ' +
      'After you stop, you can either keep this slot or move the new take to a different routine.\n\n' +
      'Hit Cancel if you started recording the wrong slot — you can pick the right one then.',
    buttons: ['Cancel', 'Re-record'],
    defaultId: 0,
    cancelId: 0,
  })
  return result.response === 1
}

function createStopProcessingBarrier(): Promise<void> {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  pendingStopProcessing = { promise, resolve }
  return promise
}

async function stopRecordingAndWait(reason: string): Promise<boolean> {
  const obsState = obs.getState()
  if (!(obsState.isRecording && obsState.connectionStatus === 'connected')) {
    return false
  }

  const stopEvent = obs.waitForRecordStop()
  const stopProcessing = createStopProcessingBarrier()

  try {
    const outputPath = await obs.stopRecord()
    await stopEvent

    // Wait until handleRecordingStopped finishes organizing the file before advancing.
    if (outputPath) {
      await Promise.race([stopProcessing, sleep(30000)])
    }
    return true
  } catch (err) {
    logger.app.error(`${reason}: stop recording failed:`, err instanceof Error ? err.message : err)
    if (pendingStopProcessing?.promise === stopProcessing) {
      pendingStopProcessing.resolve()
      pendingStopProcessing = null
    }
    return false
  }
}

/** Calculate human-readable offset between scheduled time (HH:MM) and actual time */
function calcOffset(scheduledTime: string, actual: Date): string {
  const [h, m] = scheduledTime.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return 'invalid schedule time'
  const scheduled = new Date(actual)
  scheduled.setHours(h, m, 0, 0)
  const diffMs = actual.getTime() - scheduled.getTime()
  const absDiffMin = Math.abs(Math.round(diffMs / 60000))
  const sign = diffMs >= 0 ? '+' : '-'
  if (absDiffMin < 1) return 'on time'
  const hours = Math.floor(absDiffMin / 60)
  const mins = absDiffMin % 60
  return hours > 0 ? `${sign}${hours}h ${mins}m` : `${sign}${mins}m`
}

function buildFileName(routine: Routine): string {
  const settings = getSettings()
  const now = new Date()
  let name = settings.fileNaming.pattern
    .replace('{entry_number}', routine.entryNumber)
    .replace('{routine_title}', routine.routineTitle.replace(/\s+/g, '_'))
    .replace('{studio_code}', routine.studioCode)
    .replace('{category}', routine.category.replace(/\s+/g, '_'))
    .replace('{date}', now.toISOString().split('T')[0])
    .replace('{time}', now.toTimeString().split(' ')[0].replace(/:/g, '-'))

  // Sanitize for filesystem
  name = name.replace(/[<>:"/\\|?*]/g, '_')
  return name
}

function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '_').trim()
}

function getRoutineOutputDir(routine: Routine, obsOutputPath?: string): string {
  const settings = getSettings()
  const conn = schedule.getResolvedConnection()

  // Base directory: explicit setting > OBS recording dir
  let baseDir = settings.fileNaming.outputDirectory
  if (!baseDir && obsOutputPath) {
    baseDir = path.dirname(obsOutputPath)
  }
  if (!baseDir) return ''

  // Build subfolder: ShareCode/Entry# when using share code, else pattern-based
  if (conn) {
    const shareCode = sanitize(conn.name)
    const entry = sanitize(routine.entryNumber || buildFileName(routine))
    return path.join(baseDir, shareCode, entry)
  }

  return path.join(baseDir, buildFileName(routine))
}

/** Retry opening a file until the lock is released (OBS finishes writing). */
async function waitForFileLock(filePath: string, maxWaitMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const fh = await fs.promises.open(filePath, 'r+')
      await fh.close()
      return // file is free
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  // File may still be usable — log warning but don't throw
  logger.app.warn(`File may still be locked after ${maxWaitMs / 1000}s: ${filePath}`)
}

/**
 * Re-record archive structure: routineDir has the current take at the top
 * level plus prior takes under `_archive/vN/`. For portal uploads the
 * operator wants the full-length video — not the most recent, which may
 * be an accidental short re-record that overwrote the real take. Scans
 * the routine dir + every `_archive/v*` and returns the MKV with the
 * largest file size (reliable proxy for duration at consistent OBS
 * settings). Returns `defaultPath` if no better candidate is found.
 */
export function pickLongestMkv(routineDir: string, defaultPath: string): string {
  if (!routineDir || !fs.existsSync(routineDir)) return defaultPath
  const candidates: { path: string; size: number }[] = []
  const scanDir = (dir: string): void => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.mkv')) continue
        const full = path.join(dir, f)
        try {
          const st = fs.statSync(full)
          if (st.isFile()) candidates.push({ path: full, size: st.size })
        } catch {}
      }
    } catch {}
  }
  scanDir(routineDir)
  const archiveDir = path.join(routineDir, '_archive')
  if (fs.existsSync(archiveDir)) {
    try {
      for (const v of fs.readdirSync(archiveDir)) {
        const vDir = path.join(archiveDir, v)
        try {
          if (fs.statSync(vDir).isDirectory()) scanDir(vDir)
        } catch {}
      }
    } catch {}
  }
  if (candidates.length === 0) return defaultPath
  candidates.sort((a, b) => b.size - a.size)
  const best = candidates[0].path
  if (best !== defaultPath) {
    const bestMB = (candidates[0].size / (1024 * 1024)).toFixed(1)
    const cur = candidates.find((c) => c.path === defaultPath)
    const curMB = cur ? (cur.size / (1024 * 1024)).toFixed(1) : '?'
    logger.app.warn(
      `pickLongestMkv: uploading ${best} (${bestMB} MB) instead of current ${defaultPath} (${curMB} MB)`,
    )
  }
  return best
}

async function archiveExistingFiles(routineDir: string): Promise<void> {
  if (!fs.existsSync(routineDir)) return

  const archiveDir = path.join(routineDir, '_archive')
  let version = 1
  if (fs.existsSync(archiveDir)) {
    const versions = (await fs.promises.readdir(archiveDir)).filter((d) => d.startsWith('v'))
    const nums = versions.map(v => parseInt(v.slice(1), 10)).filter(n => !isNaN(n))
    version = nums.length > 0 ? Math.max(...nums) + 1 : 1
  }

  const versionDir = path.join(archiveDir, `v${version}`)
  await fs.promises.mkdir(versionDir, { recursive: true })

  const entries = await fs.promises.readdir(routineDir)
  for (const entry of entries) {
    if (entry === '_archive') continue
    const src = path.join(routineDir, entry)
    const dest = path.join(versionDir, entry)
    await fs.promises.rename(src, dest)
    // Phase 2.8: if any prior take's mkvPath pointed at this src, update its
    // archivedPath so post-event recovery + matcher know where the MKV
    // really is now. currentRoutineId stays — operator's intent on archive
    // is "this MKV was wrong for this slot but the photos shot during its
    // window still belong to the slot." See locked spec in CURRENT_WORK.md.
    try {
      const priorTakes = state.getTakes().filter((t) => t.mkvPath === src)
      for (const pt of priorTakes) {
        state.setTakeArchived(pt.takeId, dest)
      }
    } catch (err) {
      logger.app.warn(`archiveExistingFiles: failed to update prior take archivedPath: ${err instanceof Error ? err.message : err}`)
    }
  }

  logger.app.info(`Archived existing files to ${versionDir}`)
}

export async function handleRecordingStopped(
  outputPath: string,
  timestamp: string,
): Promise<void> {
  let stoppedRoutineId: string | null = null
  try {
    let routineId = activeRecordingRoutineId
    stoppedRoutineId = routineId
    activeRecordingRoutineId = null
    stopRecordingWatchdog()
    obs.setActiveAlertRoutineId(null)

    // Item 17: read the take file so we use its `startedAt` (which survives
    // reassigns) and `currentTargetRoutineId` (which may differ from the
    // initial activeRecordingRoutineId after click-to-reassign).
    const activeTake = take.readActiveTake()
    if (activeTake?.currentTargetRoutineId) {
      routineId = activeTake.currentTargetRoutineId
    }

    // Item 17: 999-decrement overflow when the operator never bound the take
    // to an explicit slot (no reassign, no SAVE AS EMPTY). Mint a lateInsert
    // routine with entryNumber = competition.nextOverflowNumber and decrement.
    if (!routineId) {
      const overflow = state.assignOverflowRoutineForTake(activeTake?.emptyRoutineNumber ?? null)
      if (overflow) {
        routineId = overflow.id
        logger.app.info(
          `handleRecordingStopped: take had no target — assigned overflow R${overflow.entryNumber} (id ${routineId})`,
        )
      }
    }

    if (!routineId) {
      logger.app.error(`Recording stopped but no activeRecordingRoutineId — raw file preserved at: ${outputPath}`)
      take.clearActiveTake()
      return
    }

    const comp = state.getCompetition()
    // `routine` / `routineDir` / `fileName` may be retargeted mid-flow when
    // the operator chooses "Advance" in the re-record decision modal (E1).
    let routine = comp?.routines.find((r) => r.id === routineId) ?? null

    if (!routine) {
      logger.app.warn(`Recording stopped for unknown routine ${routineId} — raw file preserved at: ${outputPath}`)
      return
    }

    // Phase 4.2 (2026-04-29): sub-5s silent auto-discard. If the take is
    // shorter than the configured threshold (default 5s), it's almost
    // certainly an accidental tap-stop or false-start. Move the raw mkv to
    // a per-comp discard folder, leave the prior take untouched, and skip
    // ALL post-stop processing (no modal, no encoding, no upload, no
    // pipeline activity). The Take entity stays in state.takes[] with
    // archivedPath set + currentRoutineId cleared so photos shot during
    // its (very short) window don't bind to anything.
    const takeStartedAtForDiscard = activeTake?.startedAt
      ? new Date(activeTake.startedAt)
      : routine.recordingStartedAt ? new Date(routine.recordingStartedAt) : null
    const stopTimeForDiscard = new Date(timestamp)
    const earlyDurationSec = takeStartedAtForDiscard
      ? Math.round((stopTimeForDiscard.getTime() - takeStartedAtForDiscard.getTime()) / 1000)
      : Infinity
    const SUB_DISCARD_THRESHOLD_SEC = 10
    // 2026-05-01 Burlington UDC: operator-locked rule — "10s or under is not
    // a real routine, silently archive." Comparison is <= (was <) so a take
    // of EXACTLY 10s also auto-discards.
    if (earlyDurationSec <= SUB_DISCARD_THRESHOLD_SEC) {
      try {
        const outputDirRoot = settings.fileNaming?.outputDirectory
        if (outputDirRoot) {
          const discardDir = path.join(outputDirRoot, '_discard')
          if (!fs.existsSync(discardDir)) {
            await fs.promises.mkdir(discardDir, { recursive: true })
          }
          const ts = new Date().toISOString().replace(/[:.]/g, '-')
          const discardName = `${ts}_${earlyDurationSec}s_${path.basename(outputPath)}`
          const discardPath = path.join(discardDir, discardName)
          await waitForFileLock(outputPath)
          try {
            await fs.promises.rename(outputPath, discardPath)
          } catch (renameErr: unknown) {
            const code = (renameErr as NodeJS.ErrnoException).code
            if (code === 'EXDEV') {
              await fs.promises.copyFile(outputPath, discardPath)
              await fs.promises.unlink(outputPath)
            } else {
              throw renameErr
            }
          }
          logger.app.info(`Phase 4.2 sub-5s discard: ${earlyDurationSec}s take → ${discardPath}`)
          if (activeTake?.takeId) {
            state.setTakeStopped(activeTake.takeId, timestamp, null)
            state.setTakeArchived(activeTake.takeId, discardPath)
            state.setTakeRoutine(activeTake.takeId, null, undefined)
          }
        } else {
          logger.app.warn(`Phase 4.2 sub-5s discard: no outputDirectory configured — leaving raw at ${outputPath}`)
        }
      } catch (err) {
        logger.app.warn(`Phase 4.2 sub-5s discard failed (raw preserved): ${err instanceof Error ? err.message : err}`)
      }
      // Restore prior routine state — sub-5s never advances the slot.
      // handleRecordingStarted set the routine to 'recording' with the new
      // startedAt; we revert to the prior status. If a prior take had
      // finalized (recordingStoppedAt set on the routine), restore to
      // 'recorded'; otherwise back to 'pending'.
      try {
        const priorStatus: RoutineStatus = routine.recordingStoppedAt ? 'recorded' : 'pending'
        const revertPatch: Partial<Routine> = priorStatus === 'pending'
          ? { recordingStartedAt: undefined, recordingStoppedAt: undefined }
          : {}
        state.updateRoutineStatus(routine.id, priorStatus, revertPatch)
      } catch (err) {
        logger.app.warn(`Phase 4.2 sub-5s revert routine status failed: ${err instanceof Error ? err.message : err}`)
      }
      take.clearActiveTake()
      broadcastFullState()
      return
    }

    // Update routine state. Item 17: use the take's startedAt so reassign-
    // or empty-routine flows land the right value on the new target routine.
    const takeStartedAt = activeTake?.startedAt ?? routine.recordingStartedAt
    state.updateRoutineStatus(routine.id, 'recorded', {
      recordingStartedAt: takeStartedAt,
      recordingStoppedAt: timestamp,
      outputPath,
    })

    {
      const startMs = takeStartedAt ? Date.parse(takeStartedAt) : NaN
      const stopMs = Date.parse(timestamp)
      const durationSec = Number.isFinite(startMs) && Number.isFinite(stopMs)
        ? Math.max(0, Math.round((stopMs - startMs) / 1000))
        : null
      events.emit('recording.stopped', {
        routineId: routine.id,
        entryNumber: routine.entryNumber,
        durationSec,
      })
    }

    // Phase 2.8: finalize the Take entity. mkvPath gets corrected to the
    // post-rename location later in this function (after the file move into
    // routineDir). Sync the routineId in case it diverged from the active
    // take's currentTargetRoutineId via reassign/overflow.
    if (activeTake?.takeId) {
      state.setTakeStopped(activeTake.takeId, timestamp, outputPath)
      if (state.getTake(activeTake.takeId)?.currentRoutineId !== routineId) {
        state.setTakeRoutine(activeTake.takeId, routineId, activeTake.emptyRoutineNumber)
      }
    }

    // Venue TV "now playing" sync — clear on stop
    postNowPlaying(null).catch(() => {})

    const stopTime = new Date(timestamp)
    const stopStr = stopTime.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const startTime = routine.recordingStartedAt ? new Date(routine.recordingStartedAt) : null
    const durationSec = startTime ? Math.round((stopTime.getTime() - startTime.getTime()) / 1000) : 0
    const durationStr = durationSec > 0 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : '?'

    logger.app.info([
      `──── RECORDING STOPPED ────`,
      `  Entry #${routine.entryNumber} — "${routine.routineTitle}"`,
      `  Studio: ${routine.studioName} (${routine.studioCode})`,
      `  Category: ${routine.ageGroup} ${routine.category} ${routine.sizeCategory}`,
      `  Scheduled: Day ${routine.scheduledDay || '?'}, Position ${routine.position}${routine.scheduledTime ? `, Time ${routine.scheduledTime}` : ''}`,
      startTime ? `  Recording started: ${startTime.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '',
      `  Recording stopped: ${stopStr} (${timestamp})`,
      `  Actual duration: ${durationStr} (expected ${routine.durationMinutes} min)`,
      routine.scheduledTime ? `  Offset from schedule: ${calcOffset(routine.scheduledTime, startTime || stopTime)}` : '',
      `  Raw file: ${outputPath}`,
      `────────────────────────────`,
    ].filter(Boolean).join('\n'))

    const settings = getSettings()

    let routineDir = getRoutineOutputDir(routine, outputPath)
    if (!routineDir) {
      logger.app.warn('No output directory available — skipping file organization')
      broadcastFullState()
      return
    }
    let fileName = buildFileName(routine)

    logger.app.info(`Routine dir: ${routineDir}`)

    // Check if we need to archive existing files (re-recording)
    if (fs.existsSync(routineDir) && settings.behavior.confirmBeforeOverwrite) {
      // Capture pre-archive state for forensic visibility (UDC London 2026-04-19:
      // R483 / R529 / R530 re-record incidents made this logging critical)
      let preArchiveSize = 0
      try {
        const preStat = fs.statSync(routineDir)
        preArchiveSize = preStat.size
      } catch {}
      const preArchiveFiles: Array<{ name: string; sizeBytes: number; mtime: string }> = []
      try {
        for (const name of fs.readdirSync(routineDir)) {
          if (name === '_archive') continue
          try {
            const s = fs.statSync(path.join(routineDir, name))
            if (s.isFile()) preArchiveFiles.push({ name, sizeBytes: s.size, mtime: s.mtime.toISOString() })
          } catch {}
        }
      } catch {}

      // Phase 2.8 (2026-04-29): 30s threshold (was 90s). Modal fires when new
      // take ≥ 30s AND prior take exists in the slot. Three actions:
      //   - 'archive':         new take canonical for THIS routine. Prior MKV
      //                        moves to _archive/v{N}/. Prior take's window
      //                        preserved in state.takes[]; currentRoutineId
      //                        keeps pointing here. Photos shot in BOTH
      //                        windows still bind to this routine.
      //   - 'specify-routine': new take's currentRoutineId mutates to the
      //                        operator-picked routine. Prior take stays for
      //                        original routine. File moves to picked dir.
      //   - 'save-as-extra':   creates a lateInsert row at typed entry
      //                        number; new take's currentRoutineId points
      //                        at it. Prior take stays for original routine.
      let rerecDecision: RerecDecision = { kind: 'archive' }
      let rerecAdvancedToRoutine: Routine | null = null
      try {
        const NEW_DURATION_THRESHOLD_SEC = 30
        if (durationSec >= NEW_DURATION_THRESHOLD_SEC) {
          const priorEncoded = preArchiveFiles.some((f) => /\.(mp4|webm|mov)$/i.test(f.name))
          if (priorEncoded) {
            const priorMkv = preArchiveFiles.find((f) => /\.mkv$/i.test(f.name))
            // Burlington UDC 2026-05-01 critical incident: the previous flow
            // AWAITED a center-screen modal for the operator's decision. That
            // modal BLOCKED next-routine start — operator missed the start of
            // R138 and accidentally clicked save-as-extra (137.5) trying to
            // dismiss it.
            //
            // New rule: NEVER block mid-routine with a modal. Apply default
            // 'archive' (legacy behavior) IMMEDIATELY so post-stop processing
            // continues with no operator gating. Send the same picker IPC
            // so the renderer can render a small bottom-right NON-BLOCKING
            // toast showing what was auto-archived + buttons to override
            // (override path is post-hoc reassign — not yet wired; operator
            // can use existing manual reassign tools for the override case).
            logger.app.warn(
              `Re-record SUSPECT: routine ${routine.entryNumber} had encoded output AND new take is ${durationSec}s. ` +
              `Auto-archiving prior (non-blocking; operator review via bottom-right toast).`,
            )
            rerecDecision = { kind: 'archive' }
            try {
              const proposalId = `rerec-${Date.now()}-${++rerecProposalCounter}`
              sendToRenderer(IPC_CHANNELS.RECORDING_REREC_DECISION_REQUESTED, {
                proposalId,
                detectedAt: new Date().toISOString(),
                currentRoutineId: routine.id,
                currentEntryNumber: routine.entryNumber,
                nextEntryNumber: state.getNextRoutine()?.entryNumber ?? null,
                priorMkvName: priorMkv?.name ?? null,
                priorEncodedFiles: preArchiveFiles
                  .filter((f) => /\.(mp4|webm|mov)$/i.test(f.name))
                  .map((f) => f.name),
                newMkvPath: outputPath,
                newDurationSec: durationSec,
                autoArchived: true,
              })
            } catch {}
          }
        }
      } catch (err) {
        logger.app.warn(`Re-record heuristic failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
      }

      if (rerecDecision.kind === 'specify-routine') {
        // Operator picked a different routine for this new take. Move file
        // into that routine's folder; prior take stays where it was.
        const target = state.getCompetition()?.routines.find((r) => r.id === rerecDecision.routineId) ?? null
        if (!target) {
          logger.app.error(
            `specify-routine decision: routine ${rerecDecision.routineId} not found — falling back to archive`,
          )
          rerecDecision = { kind: 'archive' }
        } else {
          rerecAdvancedToRoutine = target
          logger.app.info(
            `Specify-Routine: new take retargeted to R${target.entryNumber} (${target.id.slice(0, 8)}). ` +
            `Prior take for R${routine.entryNumber} stays intact.`,
          )
        }
      } else if (rerecDecision.kind === 'save-as-extra') {
        // Operator wants the new take saved as an extra — typically {entry}.5
        // — alongside the existing routine. Mint a lateInsert row at the
        // typed number; new take's mkv goes to its folder.
        const overflowRow = state.assignOverflowRoutineForTake(rerecDecision.emptyRoutineNumber)
        if (!overflowRow) {
          logger.app.error(
            `save-as-extra decision: assignOverflowRoutineForTake('${rerecDecision.emptyRoutineNumber}') failed — falling back to archive`,
          )
          rerecDecision = { kind: 'archive' }
        } else {
          rerecAdvancedToRoutine = overflowRow
          logger.app.info(
            `Save-as-Extra: created lateInsert R${overflowRow.entryNumber} for new take. ` +
            `Prior take for R${routine.entryNumber} stays intact.`,
          )
        }
      }

      if (rerecDecision.kind === 'archive') {
        await archiveExistingFiles(routineDir)

        // Clear stale upload jobs and photo state from previous recording
        const oldJobs = jobQueue.getByRoutine(routine.id).filter(j => j.type === 'upload')
        for (const job of oldJobs) {
          jobQueue.updateStatus(job.id, 'cancelled')
        }
        state.updateRoutineStatus(routine.id, routine.status, {
          photos: undefined,
          encodedFiles: undefined,
          uploadProgress: undefined,
          error: undefined,
        })
        logger.app.info(`Archived existing files to ${routineDir}/_archive — cleared ${oldJobs.length} old upload jobs`)
        try {
          const events = require('./events') as typeof import('./events')
          events.emit('recording.archived', {
            routineId: routine.id,
            entryNumber: routine.entryNumber,
            routineDir,
            archivedFiles: preArchiveFiles,
            cancelledUploadJobs: oldJobs.length,
          })
        } catch {}
      }

      // If operator chose specify-routine OR save-as-extra, retarget the
      // remainder of post-stop processing at the NEW routine. Rebind
      // `routine` and `routineDir` so the file move, state updates, and
      // auto-encode all run against the picked routine. Prior routine keeps
      // its existing canonical encoded output untouched.
      const isRetarget = rerecDecision.kind === 'specify-routine' || rerecDecision.kind === 'save-as-extra'
      if (isRetarget && rerecAdvancedToRoutine) {
        // Undo the early "recorded" update we applied to the PRIOR routine
        // before we knew the decision. Its canonical encodedFiles are
        // already present and its status should reflect whatever it was
        // (likely 'uploaded' or 'encoded'). Clearing the raw outputPath
        // prevents downstream reconcilers from picking up a path that is
        // about to be renamed into a different routine's dir.
        const priorRoutine = routine
        try {
          state.updateRoutineStatus(priorRoutine.id, priorRoutine.status, {
            outputPath: priorRoutine.outputPath,
            recordingStoppedAt: priorRoutine.recordingStoppedAt,
          })
        } catch (err) {
          logger.app.warn(`Failed to revert prior-routine state for ${priorRoutine.entryNumber}: ${err instanceof Error ? err.message : err}`)
        }
        routine = rerecAdvancedToRoutine
        // Ensure the picked/created routine is marked recorded with the
        // fresh stop timestamp. outputPath is overwritten below once the
        // MKV is moved into the new routine dir.
        state.updateRoutineStatus(routine.id, 'recorded', {
          recordingStoppedAt: timestamp,
          outputPath,
        })
        // Phase 2.8: mutate the active take's currentRoutineId so photos
        // bound to the take's window follow it to the picked routine.
        if (activeTake?.takeId) {
          const empty = rerecDecision.kind === 'save-as-extra' ? rerecDecision.emptyRoutineNumber : undefined
          state.setTakeRoutine(activeTake.takeId, routine.id, empty)
        }
        const newDir = getRoutineOutputDir(routine, outputPath)
        if (!newDir) {
          logger.app.warn(`Retarget (${rerecDecision.kind}): no output directory for new routine — aborting move`)
          broadcastFullState()
          return
        }
        routineDir = newDir
        fileName = buildFileName(routine)
        logger.app.info(`Retarget (${rerecDecision.kind}): routine dir now ${routineDir}, fileName ${fileName}`)
      }
    }

    // Create routine directory
    if (!fs.existsSync(routineDir)) {
      await fs.promises.mkdir(routineDir, { recursive: true })
      logger.app.info(`Created routine directory: ${routineDir}`)
    }

    // Rename the MKV file
    const ext = path.extname(outputPath)
    const newPath = path.join(routineDir, `${fileName}${ext}`)

    // Wait for file lock release (OBS may still be writing) — retry loop instead of fixed 2s wait
    await waitForFileLock(outputPath)

    // Try rename first (fast, same-drive). Fall back to copy+delete for cross-drive (EXDEV).
    try {
      await fs.promises.rename(outputPath, newPath)
    } catch (renameErr: unknown) {
      const code = (renameErr as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        logger.app.info(`Cross-drive detected, copying: ${outputPath} → ${newPath}`)
        await fs.promises.copyFile(outputPath, newPath)
        await fs.promises.unlink(outputPath)
      } else {
        throw renameErr
      }
    }

    const stat = await fs.promises.stat(newPath)
    const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(1)
    logger.app.info(`Moved: ${outputPath} → ${newPath} (${fileSizeMB} MB)`)

    state.updateRoutineStatus(routine.id, 'recorded', { outputPath: newPath, outputDir: routineDir })

    // Phase 2.8: update Take.mkvPath to the post-rename location so post-event
    // recovery + the matcher can find the actual file.
    if (activeTake?.takeId) {
      state.setTakeMkvPath(activeTake.takeId, newPath)
    }

    // Auto-encode if enabled.
    // Operator rule: a short accidental re-record must NEVER overwrite a
    // longer prior upload to the portal. If the current take is not the
    // longest across {current, _archive/vN}, we skip the auto-encode
    // pipeline entirely — the prior upload stays intact on CompPortal,
    // the short take remains on disk for audit, and the operator can
    // manually trigger an encode if they really want to replace it.
    if (settings.behavior.autoEncodeRecordings) {
      const encodeInput = pickLongestMkv(routineDir, newPath)
      if (encodeInput !== newPath) {
        logger.app.warn(
          `Skipping auto-encode for routine ${routine.entryNumber} — current take is not the longest. ` +
          `Preserving prior upload. current=${newPath}, longer=${encodeInput}`,
        )
        // Surface to the UI so the operator gets a visible signal instead
        // of a routine sitting at "Recorded — awaiting encode" forever.
        // Renderer reads encodeSkipReason from the routine row.
        state.updateRoutineStatus(routine.id, 'recorded', { encodeSkipReason: 'shorter-than-archived' })
        // Leave status at 'recorded'. Next app restart's reconcile pass
        // will pull CompPortal's authoritative state back into local (so
        // status flips back to 'uploaded' if the portal still has the
        // media_package from the earlier longer run).
        broadcastFullState()
      } else {
        const queueBusy = ffmpegService.getQueueLength() > 0
        // Clear any prior shorter-than-archived skip reason — we're encoding
        // now, so the surface should disappear.
        state.updateRoutineStatus(routine.id, queueBusy ? 'queued' : 'encoding', { encodeSkipReason: undefined })
        broadcastFullState()
        ffmpegService.enqueueJob({
          routineId: routine.id,
          inputPath: encodeInput,
          outputDir: routineDir,
          judgeCount: settings.competition.judgeCount,
          trackMapping: settings.audioTrackMapping,
          processingMode: settings.ffmpeg.processingMode,
          filePrefix: schedule.buildFilePrefix(routine.entryNumber),
        })
      }
    }

    // Rescan watch folder — retry unmatched photos + pick up new files
    tether.rescanPhotos().catch((err) => {
      logger.app.warn(`Photo rescan after recording stop failed: ${err.message}`)
    })

    // Re-scan existing orphan drawer for photos whose EXIF falls inside this
    // routine's new recording window. Makes the "drop SD mid-session, later
    // recordings auto-pick-up their photos" flow work without operator
    // intervention. Fire-and-forget; errors are logged and skipped.
    if (routine.recordingStartedAt && timestamp) {
      const startedAt = new Date(routine.recordingStartedAt)
      const stoppedAt = new Date(timestamp)
      if (Number.isFinite(startedAt.getTime()) && Number.isFinite(stoppedAt.getTime())) {
        photos.rematchOrphansForWindow(routine.id, startedAt, stoppedAt).then((n) => {
          if (n > 0) {
            broadcastFullState()
          }
        }).catch((err: unknown) => {
          logger.app.warn(`rematchOrphansForWindow failed: ${err instanceof Error ? err.message : err}`)
        })
      }
    }

    // If this was a late-insert routine, snap the cursor back to where the
    // operator was before pressing START EMPTY ROUTINE. Late-insert row stays
    // in the schedule (operator fills in metadata post-show); only the
    // "current" pointer moves back so the table view returns to context.
    if (routine.lateInsert) {
      try {
        state.returnFromLateInsert()
        broadcastFullStateImmediate()
      } catch (err) {
        logger.app.warn(`returnFromLateInsert failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  } catch (err) {
    logger.app.error('File move failed:', err)
    if (stoppedRoutineId) {
      state.updateRoutineStatus(stoppedRoutineId, 'recorded', { outputPath, error: String(err) })
    }
  } finally {
    // Item 17: take is now finalized to a routine — clear persistent take.
    // Done in finally so even mid-flow exceptions don't strand a stale file.
    take.clearActiveTake()
    sendToRenderer(IPC_CHANNELS.RECORDING_ACTIVE_TAKE, null)
    pendingStopProcessing?.resolve()
    pendingStopProcessing = null
    broadcastFullStateImmediate()
  }
}

export async function handleRecordingStarted(timestamp: string): Promise<void> {
  const routine = state.getCurrentRoutine()
  if (!routine) return

  activeRecordingRoutineId = routine.id
  recordStartedAt = Date.parse(timestamp) || Date.now()
  expectedObsOutputDir = await obs.getRecordDirectory().catch(() => null)
  obs.setActiveAlertRoutineId(routine.id)
  startRecordingWatchdog()

  // Item 17: persist a take record so reassign-while-recording (A54) can
  // retarget without losing the actual start time. The take file survives
  // crashes for surface-as-stale-take recovery.
  //
  // Phase 2.8 (2026-04-29): also write a first-class Take entity to
  // state.takes[]. The _active_take.json file persists in parallel for
  // back-compat during the transition; eventually it becomes purely a
  // crash-recovery artifact while state.takes[] is the canonical source.
  const newTakeId = take.newTakeId()
  const newTake: ActiveTake = {
    takeId: newTakeId,
    startedAt: timestamp,
    currentTargetRoutineId: routine.id,
  }
  take.writeActiveTake(newTake)
  sendToRenderer(IPC_CHANNELS.RECORDING_ACTIVE_TAKE, newTake)
  state.addTake({
    takeId: newTakeId,
    startedAt: timestamp,
    currentRoutineId: routine.id,
  })

  state.updateRoutineStatus(routine.id, 'recording', {
    recordingStartedAt: timestamp,
  })

  events.emit('recording.started', {
    routineId: routine.id,
    entryNumber: routine.entryNumber,
    title: routine.routineTitle,
    studio: routine.studioName,
  })

  // Venue TV "now playing" sync (fire-and-forget, semantic B / recording-driven)
  postNowPlaying(routine.id).catch(() => {})

  const now = new Date(timestamp)
  const timeStr = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  logger.app.info([
    `──── RECORDING STARTED ────`,
    `  Entry #${routine.entryNumber} — "${routine.routineTitle}"`,
    `  Studio: ${routine.studioName} (${routine.studioCode})`,
    `  Category: ${routine.ageGroup} ${routine.category} ${routine.sizeCategory}`,
    `  Scheduled: Day ${routine.scheduledDay || '?'}, Position ${routine.position}${routine.scheduledTime ? `, Time ${routine.scheduledTime}` : ''}`,
    `  Recording started: ${timeStr} (${timestamp})`,
    routine.scheduledTime ? `  Offset from schedule: ${calcOffset(routine.scheduledTime, now)}` : '',
    `  Duration expected: ${routine.durationMinutes} min`,
    `───────────────────────────`,
  ].filter(Boolean).join('\n'))

  broadcastFullStateImmediate()
}

export async function next(): Promise<void> {
  if (navBusy) { logger.app.debug('next() blocked — already in progress'); return }
  navBusy = true
  try {
    const settings = getSettings()
    const obsState = obs.getState()

    // If recording, stop first
    if (obsState.isRecording && obsState.connectionStatus === 'connected') {
      await stopRecordingAndWait('next')
    }

    // Advance to next routine
    const nextRoutine = state.advanceToNext()
    if (!nextRoutine) {
      logger.app.info('No more routines')
      return
    }

    // Update overlay data
    if (settings.behavior.syncLowerThird) {
      const comp = state.getCompetition()
      const visibleCount = comp ? comp.routines.filter(r => r.status !== 'skipped' && r.status !== 'scratched').length : 0
      overlay.updateRoutineData({
        entryNumber: nextRoutine.entryNumber,
        routineTitle: nextRoutine.routineTitle,
        dancers: nextRoutine.dancers,
        studioName: nextRoutine.studioName,
        category: `${nextRoutine.ageGroup} ${nextRoutine.category}`,
        current: state.getCurrentRoutineIndex() + 1,
        total: visibleCount,
        nextAwardsTime: state.getNextAwardsTime(),
      })
    }

    // Auto-fire: schedule 3s delay. Manual fire still works independently.
    if (getAutoFire()) {
      scheduleAutoFire()
    }

    // Auto-record if enabled
    if (settings.behavior.autoRecordOnNext && obsState.connectionStatus === 'connected') {
      const blocked = canStartRecording()
      if (blocked) {
        logger.app.error(`Auto-record blocked: ${blocked.reason}${blocked.detail ? ` (${blocked.detail})` : ''}`)
      } else {
        try {
          await obs.startRecord()
        } catch (err) {
          logger.app.error('Auto-record failed:', err instanceof Error ? err.message : err)
        }
      }
    }

    broadcastFullStateImmediate()
  } finally {
    navBusy = false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function nextFull(): Promise<void> {
  if (navBusy) { logger.app.info('nextFull() blocked — already in progress'); return }
  navBusy = true
  logger.app.info('nextFull: starting sequence')
  try {
    const obsState = obs.getState()
    const connected = obsState.connectionStatus === 'connected'
    const settings = getSettings()
    const seq = settings.nextSequence
    logger.app.info(`nextFull: OBS connected=${connected}, isRecording=${obsState.isRecording}, seq=${JSON.stringify(seq)}`)

    // 1. Stop recording if active
    if (seq.stopRecording && connected && obsState.isRecording) {
      logger.app.info('nextFull: stopping current recording...')
      await stopRecordingAndWait('nextFull')
      logger.app.info('nextFull: recording stopped')
    }

    // 2. Advance to next routine
    const nextRoutine = state.advanceToNext()
    if (!nextRoutine) {
      logger.app.info('nextFull: no more routines')
      return
    }

    broadcastFullStateImmediate()
    logger.app.info(`nextFull: advanced to #${nextRoutine.entryNumber} "${nextRoutine.routineTitle}"`)

    // 3. Start recording
    if (seq.startRecording && connected) {
      const blocked = canStartRecording()
      if (blocked) {
        logger.app.error(`nextFull: auto-record blocked: ${blocked.reason}${blocked.detail ? ` (${blocked.detail})` : ''}`)
      } else {
        logger.app.info('nextFull: starting recording...')
        try {
          await obs.startRecord()
          logger.app.info('nextFull: recording started')
        } catch (err) {
          logger.app.error('nextFull: auto-record failed:', err instanceof Error ? err.message : err)
        }
      }
    } else {
      logger.app.info(`nextFull: skipping auto-record (seq.startRecording=${seq.startRecording}, connected=${connected})`)
    }

    // 4. Fire lower third
    if (seq.fireLowerThird) {
      if (seq.pauseBeforeLowerThirdMs > 0) await sleep(seq.pauseBeforeLowerThirdMs)
      overlay.fireLowerThird()
      logger.app.info('nextFull: lower third fired — sequence complete')
    } else {
      logger.app.info('nextFull: lower third skipped — sequence complete')
    }
  } finally {
    navBusy = false
  }
}

export async function prev(): Promise<void> {
  const prevRoutine = state.goToPrev()
  if (!prevRoutine) {
    logger.app.info('Already at first routine')
    return
  }
  broadcastFullStateImmediate()
}

function syncOverlayFromCurrent(): void {
  const current = state.getCurrentRoutine()
  if (!current) return
  const comp = state.getCompetition()
  const visibleCount = comp ? comp.routines.filter(r => r.status !== 'skipped' && r.status !== 'scratched').length : 0
  overlay.updateRoutineData({
    entryNumber: current.entryNumber,
    routineTitle: current.routineTitle,
    dancers: current.dancers,
    studioName: current.studioName,
    category: `${current.ageGroup} ${current.category}`,
    current: state.getCurrentRoutineIndex() + 1,
    total: visibleCount,
    nextAwardsTime: state.getNextAwardsTime(),
  })
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null
const BROADCAST_DEBOUNCE_MS = 150

function broadcastFullState(): void {
  if (broadcastTimer) return // already scheduled
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    const competition = state.getCompetition()
    const current = state.getCurrentRoutine()
    const nextR = state.getNextRoutine()

    sendToRenderer(IPC_CHANNELS.STATE_UPDATE, {
      competition,
      currentRoutine: current,
      nextRoutine: nextR,
      currentIndex: state.getCurrentRoutineIndex(),
    })

    wsHub.broadcastState()
  }, BROADCAST_DEBOUNCE_MS)
}

/** Bypass debounce for critical moments (recording start/stop, navigation) */
function broadcastFullStateImmediate(): void {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
  }
  const competition = state.getCompetition()
  const current = state.getCurrentRoutine()
  const nextR = state.getNextRoutine()

  syncOverlayFromCurrent() // Only sync overlay on immediate (navigation/recording), not debounced

  sendToRenderer(IPC_CHANNELS.STATE_UPDATE, {
    competition,
    currentRoutine: current,
    nextRoutine: nextR,
    currentIndex: state.getCurrentRoutineIndex(),
  })

  wsHub.broadcastState()
}

export function broadcastRoutineUpdate(routineId: string): void {
  const competition = state.getCompetition()
  if (!competition) return
  const routine = competition.routines.find(r => r.id === routineId)
  if (!routine) return

  sendToRenderer(IPC_CHANNELS.STATE_ROUTINE_UPDATE, { routineId, routine })
  wsHub.broadcastState()
}

export { broadcastFullState, broadcastFullStateImmediate }
