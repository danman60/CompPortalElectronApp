import { ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as obs from './services/obs'
import * as settings from './services/settings'
import * as schedule from './services/schedule'
import * as stateService from './services/state'
import * as recording from './services/recording'
import * as take from './services/take'
import * as ffmpegService from './services/ffmpeg'
import * as uploadService from './services/upload'
import * as photoService from './services/photos'
import * as overlay from './services/overlay'
import * as wsHub from './services/wsHub'
import * as systemMonitor from './services/systemMonitor'
import * as jobQueue from './services/jobQueue'
import * as clipVerify from './services/clipVerify'
import * as driveMonitor from './services/driveMonitor'
import * as tether from './services/tether'
import * as wifiDisplay from './services/wifiDisplay'
import * as chatBridge from './services/chatBridge'
import * as brandScraper from './services/brandScraper'
import * as dayChecklist from './services/dayChecklist'
import { checkAndRecover } from './services/crashRecovery'
import * as recovery from './services/recovery'
import * as backup from './services/backup'
import * as streamDeckPlugin from './services/streamDeckPlugin'
import * as overlayPanels from './services/overlayPanels'
import * as mediaReconciler from './services/mediaReconciler'
import { sendToRenderer } from './ipcUtil'
import { logger } from './logger'

backup.setProgressListener((p) => {
  sendToRenderer(IPC_CHANNELS.BACKUP_PROGRESS, p)
})

function logIPC(channel: string, args?: unknown): void {
  logger.ipc.debug(`${channel}`, args ? JSON.stringify(args).slice(0, 200) : '')
}

/** Wraps an IPC handler with try/catch and consistent error logging/returns */
function safeHandle(
  channel: string,
  handler: (...args: unknown[]) => unknown | Promise<unknown>,
): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await handler(...args)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.ipc.error(`${channel} failed: ${msg}`)
      return { error: msg }
    }
  })
}

export function registerAllHandlers(): void {
  // --- OBS ---
  safeHandle(IPC_CHANNELS.OBS_CONNECT, async (url: unknown, password: unknown) => {
    logIPC(IPC_CHANNELS.OBS_CONNECT, { url })
    await obs.connect(url as string, password as string)
    return obs.getState()
  })

  safeHandle(IPC_CHANNELS.OBS_DISCONNECT, async () => {
    logIPC(IPC_CHANNELS.OBS_DISCONNECT)
    await obs.disconnect()
  })

  safeHandle(IPC_CHANNELS.OBS_START_RECORD, async () => {
    logIPC(IPC_CHANNELS.OBS_START_RECORD)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    const blocked = recording.canStartRecording()
    if (blocked) return { error: `Recording blocked: ${blocked.reason}` }
    const confirmed = await recording.confirmReRecordIfNeeded()
    if (!confirmed) return { cancelled: true }
    await obs.startRecord()
  })

  safeHandle(IPC_CHANNELS.OBS_STOP_RECORD, async () => {
    logIPC(IPC_CHANNELS.OBS_STOP_RECORD)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    return await obs.stopRecord()
  })

  safeHandle(IPC_CHANNELS.OBS_START_STREAM, async () => {
    logIPC(IPC_CHANNELS.OBS_START_STREAM)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    await obs.startStream()
  })

  safeHandle(IPC_CHANNELS.OBS_STOP_STREAM, async () => {
    logIPC(IPC_CHANNELS.OBS_STOP_STREAM)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    await obs.stopStream()
  })

  safeHandle(IPC_CHANNELS.OBS_SAVE_REPLAY, async () => {
    logIPC(IPC_CHANNELS.OBS_SAVE_REPLAY)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    await obs.saveReplay()
  })

  safeHandle(IPC_CHANNELS.OBS_INPUT_LIST, async () => {
    logIPC(IPC_CHANNELS.OBS_INPUT_LIST)
    return await obs.getInputList()
  })

  // --- Recording Pipeline ---
  safeHandle(IPC_CHANNELS.RECORDING_NEXT, async () => {
    logIPC(IPC_CHANNELS.RECORDING_NEXT)
    await recording.next()
  })

  safeHandle(IPC_CHANNELS.RECORDING_PREV, async () => {
    logIPC(IPC_CHANNELS.RECORDING_PREV)
    await recording.prev()
  })

  safeHandle(IPC_CHANNELS.RECORDING_SKIP, async (routineId: unknown) => {
    logIPC(IPC_CHANNELS.RECORDING_SKIP, { routineId })
    stateService.skipRoutine(routineId as string)
    recording.broadcastFullState()
  })

  safeHandle(IPC_CHANNELS.RECORDING_UNSKIP, async (routineId: unknown) => {
    logIPC(IPC_CHANNELS.RECORDING_UNSKIP, { routineId })
    stateService.unskipRoutine(routineId as string)
    recording.broadcastFullState()
  })

  safeHandle(IPC_CHANNELS.RECORDING_SCRATCH, async (routineId: unknown) => {
    logIPC(IPC_CHANNELS.RECORDING_SCRATCH, { routineId })
    stateService.scratchRoutine(routineId as string)
    recording.broadcastFullState()
  })

  safeHandle(IPC_CHANNELS.RECORDING_UNSCRATCH, async (routineId: unknown) => {
    logIPC(IPC_CHANNELS.RECORDING_UNSCRATCH, { routineId })
    stateService.unscratchedRoutine(routineId as string)
    recording.broadcastFullState()
  })

  safeHandle(IPC_CHANNELS.RECORDING_NEXT_FULL, async () => {
    logIPC(IPC_CHANNELS.RECORDING_NEXT_FULL)
    await recording.nextFull()
  })

  // Item 17 / A54: click-to-reassign mid-recording. Renderer surfaces a
  // non-blocking confirmation popover; on confirm, fires this IPC with the
  // target routine id (or null+emptyRoutineNumber for empty-routine flow).
  // Recording continues uninterrupted; only the bound target changes.
  safeHandle(IPC_CHANNELS.RECORDING_REASSIGN_TARGET, async (payloadUnknown: unknown) => {
    logIPC(IPC_CHANNELS.RECORDING_REASSIGN_TARGET, payloadUnknown)
    const payload = (payloadUnknown ?? {}) as {
      routineId?: string | null
      emptyRoutineNumber?: string
    }
    const cur = take.readActiveTake()
    if (!cur) return { error: 'No active take' }
    const oldId = cur.currentTargetRoutineId
    let newRoutineId: string | null = payload.routineId ?? null
    let emptyNumber = payload.emptyRoutineNumber ?? cur.emptyRoutineNumber
    if (!newRoutineId && emptyNumber) {
      const newRoutine = stateService.assignOverflowRoutineForTake(emptyNumber)
      if (newRoutine) newRoutineId = newRoutine.id
    }
    if (!newRoutineId) return { error: 'No target supplied' }
    const result = stateService.reassignActiveTake(oldId, newRoutineId, cur.startedAt)
    if (!result) return { error: 'Reassign failed' }
    recording.setActiveRecordingRoutineId(result.id)
    const updated = take.patchActiveTake({
      currentTargetRoutineId: result.id,
      emptyRoutineNumber: emptyNumber,
    })
    if (updated) sendToRenderer(IPC_CHANNELS.RECORDING_ACTIVE_TAKE, updated)
    recording.broadcastFullState()
    return { ok: true, routineId: result.id, entryNumber: result.entryNumber }
  })

  // Late-insert / empty-routine recording (UDC Toronto 2026-04-25 operator
  // request). Inserts a new ad-hoc routine right after the current one,
  // marks it current, then starts an OBS recording. Operator fills in
  // routine title/dancer/etc post-show.
  safeHandle(IPC_CHANNELS.RECORDING_START_EMPTY, async () => {
    logIPC(IPC_CHANNELS.RECORDING_START_EMPTY)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    if (obs.getState().isRecording) return { error: 'Already recording — stop first' }
    const newRoutine = stateService.insertLateRoutine()
    if (!newRoutine) return { error: 'No competition loaded' }
    const blocked = recording.canStartRecording()
    if (blocked) return { error: `Recording blocked: ${blocked.reason}`, routineId: newRoutine.id }
    await obs.startRecord()
    return { ok: true, routineId: newRoutine.id, entryNumber: newRoutine.entryNumber }
  })

  // --- FFmpeg ---
  safeHandle(IPC_CHANNELS.FFMPEG_ENCODE, async (routineId: unknown) => {
    logIPC(IPC_CHANNELS.FFMPEG_ENCODE, { routineId })
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    const routine = comp.routines.find((r) => r.id === routineId)
    if (!routine || !routine.outputPath) return { error: 'Routine not found or not recorded' }
    const s = settings.getSettings()
    const dir = routine.outputDir || path.dirname(routine.outputPath)
    // Upload the longest take across current + _archive/vN.
    const encodeInput = recording.pickLongestMkv(dir, routine.outputPath)
    ffmpegService.enqueueJob({
      routineId: routine.id,
      inputPath: encodeInput,
      outputDir: dir,
      judgeCount: s.competition.judgeCount,
      trackMapping: s.audioTrackMapping,
      processingMode: s.ffmpeg.processingMode,
      filePrefix: schedule.buildFilePrefix(routine.entryNumber),
    })
  })

  safeHandle(IPC_CHANNELS.FFMPEG_PAUSE, () => {
    logIPC(IPC_CHANNELS.FFMPEG_PAUSE)
    ffmpegService.pauseEncoding()
  })

  safeHandle(IPC_CHANNELS.FFMPEG_RESUME, () => {
    logIPC(IPC_CHANNELS.FFMPEG_RESUME)
    ffmpegService.resumeEncoding()
  })

  safeHandle(IPC_CHANNELS.FFMPEG_ENCODE_ALL, async () => {
    logIPC(IPC_CHANNELS.FFMPEG_ENCODE_ALL)
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    const s = settings.getSettings()
    for (const routine of comp.routines) {
      if (routine.status === 'recorded' && routine.outputPath) {
        const dir = routine.outputDir || path.dirname(routine.outputPath)
        // Upload the longest take across current + _archive/vN.
        const encodeInput = recording.pickLongestMkv(dir, routine.outputPath)
        ffmpegService.enqueueJob({
          routineId: routine.id,
          inputPath: encodeInput,
          outputDir: dir,
          judgeCount: s.competition.judgeCount,
          trackMapping: s.audioTrackMapping,
          processingMode: s.ffmpeg.processingMode,
          filePrefix: schedule.buildFilePrefix(routine.entryNumber),
        })
      }
    }
  })

  // --- Schedule ---
  safeHandle(IPC_CHANNELS.SCHEDULE_LOAD_CSV, async (filePath: unknown) => {
    logIPC(IPC_CHANNELS.SCHEDULE_LOAD_CSV, { filePath })
    const comp = schedule.loadSchedule(filePath as string)
    stateService.setCompetition(comp)
    recording.broadcastFullState()
    return comp
  })

  safeHandle(IPC_CHANNELS.SCHEDULE_LOAD_SHARE_CODE, async (shareCode: unknown) => {
    logIPC(IPC_CHANNELS.SCHEDULE_LOAD_SHARE_CODE, { shareCode })
    const comp = await schedule.loadFromShareCode(shareCode as string)
    stateService.setCompetition(comp)
    recording.broadcastFullState()
    // Start chat bridge now that share code is resolved (competitionId available)
    chatBridge.stopChatBridge()
    chatBridge.startChatBridge()
    return comp
  })

  safeHandle(IPC_CHANNELS.SCHEDULE_GET, async () => {
    return stateService.getCompetition()
  })

  safeHandle(IPC_CHANNELS.SCHEDULE_BROWSE_FILE, async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Schedule File',
      filters: [
        { name: 'Schedule Files', extensions: ['csv', 'xls', 'xlsx'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  // --- State ---
  safeHandle(IPC_CHANNELS.STATE_GET, async () => {
    logIPC(IPC_CHANNELS.STATE_GET)
    return {
      competition: stateService.getCompetition(),
      currentRoutine: stateService.getCurrentRoutine(),
      nextRoutine: stateService.getNextRoutine(),
      currentIndex: stateService.getCurrentRoutineIndex(),
    }
  })

  safeHandle(IPC_CHANNELS.STATE_JUMP_TO, async (routineId: unknown) => {
    logIPC(IPC_CHANNELS.STATE_JUMP_TO, { routineId })
    const routine = stateService.jumpToRoutine(routineId as string)
    if (routine) {
      recording.broadcastFullState()
    }
    return routine
  })

  safeHandle(IPC_CHANNELS.STATE_SET_NOTE, async (routineId: unknown, note: unknown) => {
    logIPC(IPC_CHANNELS.STATE_SET_NOTE, { routineId })
    stateService.setRoutineNote(routineId as string, note as string)
    recording.broadcastFullState()
  })

  safeHandle(IPC_CHANNELS.STATE_EXPORT_REPORT, async () => {
    logIPC(IPC_CHANNELS.STATE_EXPORT_REPORT)
    const report = stateService.exportReport()
    if (!report) return { error: 'No competition loaded' }

    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { error: 'No window' }

    const result = await dialog.showSaveDialog(win, {
      title: 'Export Session Report',
      defaultPath: `compsync-report-${new Date().toISOString().split('T')[0]}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })

    if (result.canceled || !result.filePath) return { cancelled: true }

    fs.writeFileSync(result.filePath, report, 'utf-8')
    logger.app.info(`Report exported to ${result.filePath}`)
    return { path: result.filePath }
  })

  safeHandle(IPC_CHANNELS.STATE_EXPORT_VERIFICATION_REPORT, async () => {
    logIPC(IPC_CHANNELS.STATE_EXPORT_VERIFICATION_REPORT)
    const report = stateService.exportVerificationReport()
    if (!report) return { error: 'No competition loaded' }

    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { error: 'No window' }

    const result = await dialog.showSaveDialog(win, {
      title: 'Export Verification Report',
      defaultPath: `compsync-verification-${new Date().toISOString().split('T')[0]}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })

    if (result.canceled || !result.filePath) return { cancelled: true }

    fs.writeFileSync(result.filePath, report, 'utf-8')
    logger.app.info(`Verification report exported to ${result.filePath}`)
    return { path: result.filePath }
  })

  safeHandle(IPC_CHANNELS.STATE_LIST_CAMERA_OFFSETS, async () => {
    logIPC(IPC_CHANNELS.STATE_LIST_CAMERA_OFFSETS)
    return stateService.listCameraOffsets()
  })

  safeHandle(IPC_CHANNELS.STATE_CLEAR_CAMERA_OFFSETS, async () => {
    logIPC(IPC_CHANNELS.STATE_CLEAR_CAMERA_OFFSETS)
    stateService.clearCameraOffsets()
    return { ok: true }
  })

  safeHandle(IPC_CHANNELS.STATE_SET_DISPLAY_ORDER, async (ids: unknown) => {
    logIPC(IPC_CHANNELS.STATE_SET_DISPLAY_ORDER)
    if (!Array.isArray(ids)) throw new Error('routine id list required')
    stateService.setDisplayOrder(ids as string[])
    // Push refreshed competition to the renderer so the table re-renders in
    // the new order. Without this the operator drags but sees nothing change
    // until something else triggers a STATE_UPDATE (operator-reported
    // 2026-04-25). Also broadcast to WS clients (tablet / overlay).
    try {
      const recordingMod = await import('./services/recording')
      recordingMod.broadcastFullState()
    } catch {}
    try {
      const wsHubMod = await import('./services/wsHub')
      wsHubMod.broadcastState()
    } catch {}
    return { ok: true }
  })

  // --- Settings ---
  safeHandle(IPC_CHANNELS.SETTINGS_GET, () => {
    logIPC(IPC_CHANNELS.SETTINGS_GET)
    return settings.getSettings()
  })

  safeHandle(IPC_CHANNELS.SETTINGS_SET, async (partial: unknown) => {
    logIPC(IPC_CHANNELS.SETTINGS_SET, Object.keys(partial as object))
    const result = settings.setSettings(partial as Partial<Record<string, unknown>>)

    // Apply recording format to OBS if connected and format changed
    const p = partial as Record<string, unknown>
    if (p.obs && (p.obs as Record<string, unknown>).recordingFormat) {
      if (obs.getState().connectionStatus === 'connected') {
        obs.setRecordingFormat((p.obs as Record<string, unknown>).recordingFormat as string).catch(() => {})
      }
    }

    // T-V7-26: re-apply ambient reconciler cadence when upload settings change.
    if (p.upload || p.behavior) {
      const u = p.upload as Record<string, unknown> | undefined
      const b = p.behavior as Record<string, unknown> | undefined
      if (
        (u && ('reconcileCadenceMinutes' in u || 'reconcileSilent' in u)) ||
        (b && 'autoUploadAfterEncoding' in b)
      ) {
        try {
          mediaReconciler.restartAmbientReconciler()
        } catch {}
      }
    }

    return result
  })

  safeHandle(IPC_CHANNELS.SETTINGS_BROWSE_DIR, async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  safeHandle(IPC_CHANNELS.SETTINGS_BROWSE_FILE, async (filters: unknown) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      filters: (filters as { name: string; extensions: string[] }[]) || [],
      properties: ['openFile'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  // --- Media backup ---
  safeHandle(IPC_CHANNELS.BACKUP_BROWSE_TARGET, async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select external backup destination',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  safeHandle(IPC_CHANNELS.BACKUP_START, async (targetRoot: unknown) => {
    logIPC(IPC_CHANNELS.BACKUP_START, String(targetRoot))
    if (typeof targetRoot !== 'string' || !targetRoot) return { error: 'No target folder' }
    if (obs.getState().isRecording) return { error: 'Recording is active — stop recording first' }
    if (backup.isBackupRunning()) return { error: 'Backup already running' }
    const result = await backup.startBackup(targetRoot)
    sendToRenderer(IPC_CHANNELS.BACKUP_DONE, result)
    return result
  })

  safeHandle(IPC_CHANNELS.BACKUP_CANCEL, async () => {
    logIPC(IPC_CHANNELS.BACKUP_CANCEL)
    backup.cancelBackup()
    return { ok: true }
  })

  // --- Stream Deck plugin (bundled) ---
  safeHandle(IPC_CHANNELS.STREAMDECK_GET_STATUS, async () => {
    return streamDeckPlugin.getStatus()
  })

  safeHandle(IPC_CHANNELS.STREAMDECK_INSTALL_PLUGIN, async () => {
    logIPC(IPC_CHANNELS.STREAMDECK_INSTALL_PLUGIN)
    return await streamDeckPlugin.installPlugin()
  })

  // --- Overlay Mode (floating panels over OBS) ---
  // Click-only: no auto-restore on startup, no keyboard shortcut. Uses
  // ipcMain.handle directly because we need event.sender to find the main
  // window (the caller) on open.
  ipcMain.handle(IPC_CHANNELS.OVERLAY_MODE_OPEN, (event) => {
    logIPC(IPC_CHANNELS.OVERLAY_MODE_OPEN)
    const caller = BrowserWindow.fromWebContents(event.sender)
    if (!caller) return { error: 'No caller window' }
    try {
      overlayPanels.openAll(caller)
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.ipc.error(`overlay-mode:open failed: ${msg}`)
      return { error: msg }
    }
  })

  ipcMain.handle(IPC_CHANNELS.OVERLAY_MODE_CLOSE, () => {
    logIPC(IPC_CHANNELS.OVERLAY_MODE_CLOSE)
    try {
      overlayPanels.closeAll()
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.ipc.error(`overlay-mode:close failed: ${msg}`)
      return { error: msg }
    }
  })

  ipcMain.handle(IPC_CHANNELS.OVERLAY_MODE_TOGGLE, (event) => {
    logIPC(IPC_CHANNELS.OVERLAY_MODE_TOGGLE)
    try {
      if (overlayPanels.isOpen()) {
        overlayPanels.closeAll()
      } else {
        const caller = BrowserWindow.fromWebContents(event.sender)
        if (!caller) return { error: 'No caller window' }
        overlayPanels.openAll(caller)
      }
      return { ok: true, open: overlayPanels.isOpen() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.ipc.error(`overlay-mode:toggle failed: ${msg}`)
      return { error: msg }
    }
  })

  ipcMain.handle(IPC_CHANNELS.OVERLAY_MODE_HIDE_PANEL, (_event, panelId: unknown) => {
    logIPC(IPC_CHANNELS.OVERLAY_MODE_HIDE_PANEL, { panelId })
    try {
      if (typeof panelId !== 'string') return { error: 'Invalid panel id' }
      overlayPanels.hidePanel(panelId as Parameters<typeof overlayPanels.hidePanel>[0])
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.ipc.error(`overlay-mode:hide-panel failed: ${msg}`)
      return { error: msg }
    }
  })

  // --- Upload ---
  safeHandle(IPC_CHANNELS.UPLOAD_START, () => {
    logIPC(IPC_CHANNELS.UPLOAD_START)
    uploadService.startUploads()
  })

  safeHandle(IPC_CHANNELS.UPLOAD_STOP, () => {
    logIPC(IPC_CHANNELS.UPLOAD_STOP)
    uploadService.stopUploads()
  })

  safeHandle(IPC_CHANNELS.UPLOAD_CANCEL_ROUTINE, (routineId: unknown) => {
    logIPC(IPC_CHANNELS.UPLOAD_CANCEL_ROUTINE, { routineId })
    uploadService.cancelRoutineUpload(routineId as string)
  })

  // T-V7-22: manual "Resume Unfinished Uploads" — ignores routine.status
  // filter and runs the DB-cross-checked resume path. Idempotent — re-clicks
  // never double-enqueue (enqueueRoutine de-dupes by objectName).
  // T-V7-26: now routes through the unified reconciler (scope:'manual').
  safeHandle(IPC_CHANNELS.UPLOAD_RESUME_UNFINISHED, async () => {
    logIPC(IPC_CHANNELS.UPLOAD_RESUME_UNFINISHED)
    const r = await mediaReconciler.reconcileMedia({ scope: 'manual' })
    // Return the legacy ResumeUnfinishedReport shape so the Settings.tsx
    // button UI (which expects it) keeps working unchanged.
    return {
      routinesScanned: r.scanned,
      photosRepaired: r.repaired,
      photosQueued: 0,
      jobsQueued: r.queued,
      endpointAvailable: r.endpointAvailable,
      error: r.skippedReason,
    }
  })

  // T-V7-22: count routines with pending photos/encodedFiles (for the button
  // label "Resume Unfinished Uploads (N)"). Purely a read; no enqueue.
  safeHandle(IPC_CHANNELS.UPLOAD_COUNT_UNFINISHED, async () => {
    const comp = stateService.getCompetition()
    if (!comp) return { count: 0 }
    let count = 0
    for (const r of comp.routines) {
      const pendingPhotos = (r.photos || []).some((p) => !p.uploaded)
      const pendingVideos = (r.encodedFiles || []).some((f) => !f.uploaded)
      if (pendingPhotos || pendingVideos) count++
    }
    return { count }
  })

  safeHandle(IPC_CHANNELS.UPLOAD_ALL, () => {
    logIPC(IPC_CHANNELS.UPLOAD_ALL)
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    if (!uploadService.hasResolvedUploadConnection()) {
      return { error: 'No upload connection. Resolve a share code first.' }
    }
    // Enqueue when there's ANY unfinished work for the routine:
    //   - videos/keyframes encoded but not yet uploaded (legacy gate), OR
    //   - photos[] has entries with `uploaded: false` that weren't picked up
    //     by an active queue (e.g. late SD-import arrival after the routine
    //     was already marked `uploaded/confirmed` from the video flow, or
    //     the in-memory job queue was lost across an app restart — the
    //     2026-04-19 UDC London incident: 33 routines with 1,384+ pending
    //     photos sat idle after a 18:35 EDT restart because the outer
    //     filter skipped anything with status `uploaded/confirmed`).
    // `enqueueRoutine` already skips individual photos with `uploaded:true`,
    // so enqueueing a mostly-uploaded routine only picks up its stragglers.
    let queued = 0
    for (const routine of comp.routines) {
      if (routine.status === 'uploading') continue
      const hasEncodedWork = Boolean(routine.encodedFiles)
      const hasUnuploadedPhotos = (routine.photos || []).some((p) => !p.uploaded)
      const videoNotYetLanded = hasEncodedWork && routine.status !== 'uploaded' && routine.status !== 'confirmed'
      if (!videoNotYetLanded && !hasUnuploadedPhotos) continue
      const result = uploadService.enqueueRoutine(routine)
      if (result.queuedJobs > 0) queued++
    }
    if (queued > 0) uploadService.startUploads()
    logger.ipc.info(`Upload all: queued ${queued} routines`)
    return { queued }
  })

  // T-V7-26: direct handle on the unified reconciler — callable from renderer
  // if ever needed (e.g. debug button). Ambient timer + batch-2 surface
  // already invoke internally.
  safeHandle(IPC_CHANNELS.MEDIA_RECONCILE_RUN, async (scope: unknown) => {
    logIPC(IPC_CHANNELS.MEDIA_RECONCILE_RUN, { scope })
    const scopeStr = typeof scope === 'string' ? scope : 'manual'
    return await mediaReconciler.reconcileMedia({
      scope: (scopeStr === 'boot' || scopeStr === 'ambient' || scopeStr === 'post-record' ||
              scopeStr === 'sd-plugin' || scopeStr === 'tether-error') ? scopeStr : 'manual',
    })
  })

  safeHandle(IPC_CHANNELS.UPLOAD_ROUTINE, (routineId: unknown, force: unknown) => {
    logIPC(IPC_CHANNELS.UPLOAD_ROUTINE, { routineId, force })
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    if (!uploadService.hasResolvedUploadConnection()) {
      return { error: 'No upload connection. Resolve a share code first.' }
    }
    const routine = comp.routines.find((r) => r.id === routineId)
    if (routine) {
      const result = uploadService.enqueueRoutine(routine, !!force)
      if (result.queuedJobs > 0) {
        uploadService.startUploads()
      }
      return result
    }
  })

  // --- Photos ---
  safeHandle(IPC_CHANNELS.PHOTOS_BROWSE, async () => {
    logIPC(IPC_CHANNELS.PHOTOS_BROWSE)
    return await photoService.browseForFolder()
  })

  safeHandle(IPC_CHANNELS.PHOTOS_IMPORT, async (folderPath: unknown) => {
    logIPC(IPC_CHANNELS.PHOTOS_IMPORT, { folderPath })
    const comp = stateService.getCompetition()
    const s = settings.getSettings()
    if (!comp) return { error: 'No competition loaded' }
    return await photoService.importPhotos(folderPath as string, comp.routines, s.fileNaming.outputDirectory)
  })

  // T-V7-25: scoped recovery import — given a drive path + allowlist of
  // basenames, run the normal pipeline but filter the scan to those files
  // and bypass the watermark filter for them. Used by the missing-photos
  // recovery toast's "Import Missing Only" action.
  safeHandle(IPC_CHANNELS.DRIVE_IMPORT_MISSING_ONLY, async (folderPath: unknown, filenames: unknown) => {
    logIPC(IPC_CHANNELS.DRIVE_IMPORT_MISSING_ONLY, { folderPath, count: Array.isArray(filenames) ? (filenames as unknown[]).length : 0 })
    const comp = stateService.getCompetition()
    const s = settings.getSettings()
    if (!comp) return { error: 'No competition loaded' }
    if (!Array.isArray(filenames) || (filenames as unknown[]).length === 0) {
      return { error: 'No filenames provided' }
    }
    const allowlist = new Set((filenames as unknown[]).filter((x): x is string => typeof x === 'string'))
    return await photoService.importPhotos(
      folderPath as string,
      comp.routines,
      s.fileNaming.outputDirectory,
      { filenameAllowlist: allowlist },
    )
  })

  safeHandle(IPC_CHANNELS.PHOTOS_PREVIEW_IMPORT, async (folderPath: unknown) => {
    logIPC(IPC_CHANNELS.PHOTOS_PREVIEW_IMPORT, { folderPath })
    const comp = stateService.getCompetition()
    const s = settings.getSettings()
    if (!comp) return { error: 'No competition loaded' }
    return await photoService.importPhotos(
      folderPath as string,
      comp.routines,
      s.fileNaming.outputDirectory,
      { previewOnly: true },
    )
  })

  // Bug C: cancel an in-flight import. Aborts mid-loop so the runaway 21k-
  // photo scan from Saturday 2026-04-18 doesn't repeat.
  safeHandle(IPC_CHANNELS.PHOTOS_CANCEL, async () => {
    logIPC(IPC_CHANNELS.PHOTOS_CANCEL)
    return photoService.cancelCurrentImport()
  })

  safeHandle(IPC_CHANNELS.PHOTOS_REASSIGN_ORPHAN, async (orphanPath: unknown, routineId: unknown) => {
    logIPC(IPC_CHANNELS.PHOTOS_REASSIGN_ORPHAN, { orphanPath, routineId })
    return await photoService.reassignOrphan(orphanPath as string, routineId as string)
  })

  safeHandle(IPC_CHANNELS.PHOTOS_DISCARD_ORPHAN, async (orphanPath: unknown) => {
    logIPC(IPC_CHANNELS.PHOTOS_DISCARD_ORPHAN, { orphanPath })
    return await photoService.discardOrphan(orphanPath as string)
  })

  safeHandle(IPC_CHANNELS.PHOTOS_MARK_SDS_PROCESSED, async () => {
    logIPC(IPC_CHANNELS.PHOTOS_MARK_SDS_PROCESSED)
    return await photoService.markCurrentSdsAsProcessed()
  })

  safeHandle(IPC_CHANNELS.PHOTOS_OFFSET_DECISION, async (proposalId: unknown, decision: unknown) => {
    logIPC(IPC_CHANNELS.PHOTOS_OFFSET_DECISION, { proposalId, decision })
    const d = decision === 'yes' || decision === 'no' || decision === 'skip' ? decision : 'yes'
    photoService.resolveOffsetDecision(proposalId as string, d)
    return { ok: true }
  })

  // E1: re-record hard-gate decision — operator chose 'advance' (this take
  // belongs to next routine) or 'archive' (legacy re-record overwrite).
  safeHandle(IPC_CHANNELS.RECORDING_REREC_DECISION, async (proposalId: unknown, decision: unknown) => {
    logIPC(IPC_CHANNELS.RECORDING_REREC_DECISION, { proposalId, decision })
    const d = decision === 'advance' || decision === 'archive' ? decision : 'archive'
    recording.resolveRerecDecision(proposalId as string, d)
    return { ok: true }
  })

  safeHandle(IPC_CHANNELS.PHOTOS_CLEAR_SD_WATERMARKS, async () => {
    logIPC(IPC_CHANNELS.PHOTOS_CLEAR_SD_WATERMARKS)
    stateService.clearSdWatermarks()
    return { ok: true }
  })

  // --- Drive Monitor ---
  safeHandle(IPC_CHANNELS.DRIVE_DISMISS, async (drivePath: unknown) => {
    logIPC(IPC_CHANNELS.DRIVE_DISMISS, { drivePath })
    driveMonitor.dismissDrive(drivePath as string)
  })

  // --- CLIP Verification ---
  safeHandle(IPC_CHANNELS.CLIP_VERIFY_IMPORT, async (matches: unknown, routines: unknown, opts: unknown) =>
    clipVerify.verifyImport(
      matches as import('../shared/types').PhotoMatch[],
      routines as import('../shared/types').Routine[],
      opts as { skipExact?: boolean } | undefined,
    ))

  safeHandle(IPC_CHANNELS.CLIP_ANALYZE_FOLDER, async (folderPath: unknown, params: unknown) =>
    clipVerify.analyzeFolder(
      folderPath as string,
      params as import('../shared/types').ClipSortParams,
    ))

  safeHandle(IPC_CHANNELS.CLIP_EXECUTE_SORT, async (result: unknown, params: unknown) =>
    clipVerify.executeSort(
      result as import('../shared/types').ClipSortResult,
      params as import('../shared/types').ExecuteSortParams,
    ))

  safeHandle(IPC_CHANNELS.CLIP_CANCEL, () => clipVerify.cancel())

  // --- Overlay ---
  safeHandle(IPC_CHANNELS.OVERLAY_TOGGLE, (element: unknown) => {
    logIPC(IPC_CHANNELS.OVERLAY_TOGGLE, { element })
    return overlay.toggleElement(element as 'counter' | 'clock' | 'logo' | 'lowerThird')
  })

  safeHandle(IPC_CHANNELS.OVERLAY_FIRE_LT, () => {
    logIPC(IPC_CHANNELS.OVERLAY_FIRE_LT)
    overlay.fireLowerThird()
  })

  safeHandle(IPC_CHANNELS.OVERLAY_HIDE_LT, () => {
    logIPC(IPC_CHANNELS.OVERLAY_HIDE_LT)
    overlay.hideLowerThird()
  })

  safeHandle(IPC_CHANNELS.OVERLAY_GET_STATE, () => {
    return { ...overlay.getOverlayState(), layout: overlay.getLayout(), autoFireEnabled: overlay.getAutoFirePersisted() }
  })

  safeHandle(IPC_CHANNELS.OVERLAY_UPDATE_LAYOUT, (layout: unknown) => {
    logIPC(IPC_CHANNELS.OVERLAY_UPDATE_LAYOUT)
    overlay.updateLayout(layout as import('../shared/types').OverlayLayout)
  })

  safeHandle(IPC_CHANNELS.OVERLAY_AUTO_FIRE_TOGGLE, () => {
    const newState = !recording.getAutoFire()
    recording.setAutoFire(newState)
    return newState
  })

  safeHandle(IPC_CHANNELS.OVERLAY_SET_TICKER, (updates: unknown) => {
    logIPC(IPC_CHANNELS.OVERLAY_SET_TICKER)
    overlay.setTicker(updates as Partial<import('../shared/types').TickerState>)
    return overlay.getOverlayState().ticker
  })

  safeHandle(IPC_CHANNELS.OVERLAY_SET_STARTING_SOON, (updates: unknown) => {
    logIPC(IPC_CHANNELS.OVERLAY_SET_STARTING_SOON)
    overlay.setStartingSoon(updates as Partial<import('../shared/types').StartingSoonState>)
    return overlay.getOverlayState().startingSoon
  })

  safeHandle(IPC_CHANNELS.OVERLAY_SET_ANIMATION_CONFIG, (updates: unknown) => {
    logIPC(IPC_CHANNELS.OVERLAY_SET_ANIMATION_CONFIG)
    overlay.setAnimationConfig(updates as Partial<import('../shared/types').AnimationConfig>)
    return overlay.getOverlayState().animConfig
  })

  safeHandle(IPC_CHANNELS.OVERLAY_SET_LOGO, async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Logo Image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null

    overlay.setLogoUrl(result.filePaths[0])
    return overlay.getOverlayState().logo.url
  })

  // --- Brand Scraper ---

  safeHandle(IPC_CHANNELS.BRAND_SCRAPE, async (url: unknown) => {
    logIPC(IPC_CHANNELS.BRAND_SCRAPE, url)
    return await brandScraper.scrapeWebsite(url as string)
  })

  // --- Starting Soon Scene Editor ---

  safeHandle(IPC_CHANNELS.SS_GET_CONFIG, () => {
    logIPC(IPC_CHANNELS.SS_GET_CONFIG)
    return overlay.getSSConfig()
  })

  safeHandle(IPC_CHANNELS.SS_SET_CONFIG, (updates: unknown) => {
    logIPC(IPC_CHANNELS.SS_SET_CONFIG, updates)
    return overlay.setSSConfig(updates as Partial<import('../shared/types').StartingSoonConfig>)
  })

  safeHandle(IPC_CHANNELS.SS_BROWSE_FOLDER, async (type: unknown) => {
    logIPC(IPC_CHANNELS.SS_BROWSE_FOLDER, { type })
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: type === 'video' ? 'Select Video Folder' : type === 'image' ? 'Select Image Folder' : type === 'sponsor' ? 'Select Sponsor Logos Folder' : 'Select Folder',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  safeHandle(IPC_CHANNELS.SS_BROWSE_FILE, async (type: unknown) => {
    logIPC(IPC_CHANNELS.SS_BROWSE_FILE, { type })
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const exts = type === 'image'
      ? ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif']
      : type === 'video'
        ? ['mp4', 'webm', 'mov', 'avi', 'mkv']
        : ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif']
    const result = await dialog.showOpenDialog(win, {
      title: type === 'image' ? 'Select Image File' : type === 'video' ? 'Select Video File' : 'Select File',
      filters: [{ name: 'Files', extensions: exts }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  safeHandle(IPC_CHANNELS.SS_SCAN_FOLDER, async (folderPath: unknown, type: unknown) => {
    logIPC(IPC_CHANNELS.SS_SCAN_FOLDER, { folderPath, type })
    const pathStr = folderPath as string
    const fileType = type as string
    if (!pathStr || !fs.existsSync(pathStr)) return []
    
    try {
      const files = fs.readdirSync(pathStr)
      let extensions: string[]
      
      if (fileType === 'video') {
        extensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv']
      } else if (fileType === 'image') {
        extensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
      } else if (fileType === 'sponsor') {
        extensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']
      } else {
        extensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov', '.avi', '.mkv']
      }
      
      const filtered = files
        .filter(f => extensions.some(ext => f.toLowerCase().endsWith(ext)))
        .sort()
      
      return filtered
    } catch (_err) {
      return []
    }
  })

  safeHandle(IPC_CHANNELS.SS_GET_PRESETS, () => {
    logIPC(IPC_CHANNELS.SS_GET_PRESETS)
    return overlay.getSSPresets()
  })

  safeHandle(IPC_CHANNELS.SS_SAVE_PRESET, (preset: unknown) => {
    logIPC(IPC_CHANNELS.SS_SAVE_PRESET, { name: (preset as any)?.name })
    return overlay.saveSSPreset(preset as import('../shared/types').StartingSoonPreset)
  })

  safeHandle(IPC_CHANNELS.SS_DELETE_PRESET, (id: unknown) => {
    logIPC(IPC_CHANNELS.SS_DELETE_PRESET, { id })
    return overlay.deleteSSPreset(id as string)
  })

  safeHandle(IPC_CHANNELS.SS_LOAD_PRESET, (id: unknown) => {
    logIPC(IPC_CHANNELS.SS_LOAD_PRESET, { id })
    const result = overlay.loadSSPreset(id as string)
    return result !== null ? result : { error: 'Preset not found' }
  })

  // --- Chat (Livestream Pinned Comments) ---
  safeHandle(IPC_CHANNELS.CHAT_GET_MESSAGES, () => {
    return chatBridge.getChatMessages()
  })

  safeHandle(IPC_CHANNELS.CHAT_GET_PINNED, () => {
    return chatBridge.getPinnedMessages()
  })

  safeHandle(IPC_CHANNELS.CHAT_PIN, (id: unknown) => {
    logIPC(IPC_CHANNELS.CHAT_PIN, { id })
    return chatBridge.pinMessage(id as string)
  })

  safeHandle(IPC_CHANNELS.CHAT_UNPIN, (id: unknown) => {
    logIPC(IPC_CHANNELS.CHAT_UNPIN, { id })
    return chatBridge.unpinMessage(id as string)
  })

  safeHandle(IPC_CHANNELS.CHAT_CLEAR_PINNED, () => {
    logIPC(IPC_CHANNELS.CHAT_CLEAR_PINNED)
    chatBridge.clearPinned()
  })

  safeHandle(IPC_CHANNELS.CHAT_POST_MESSAGE, async (payload: unknown) => {
    const p = (payload && typeof payload === 'object' ? payload : {}) as { text?: unknown; name?: unknown }
    const text = typeof p.text === 'string' ? p.text : ''
    const name = typeof p.name === 'string' ? p.name : ''
    logIPC(IPC_CHANNELS.CHAT_POST_MESSAGE, { name, len: text.length })
    return chatBridge.postChatMessage(text, name)
  })

  // Synthetic chat-fire trigger — used by the Visual Editor to test the
  // pinned-chat overlay path without needing a real pinned message.
  safeHandle(IPC_CHANNELS.CHAT_FIRE_TEST, () => {
    logIPC(IPC_CHANNELS.CHAT_FIRE_TEST)
    overlay.fireChatMessage({
      id: 'test-' + Date.now(),
      name: 'TestUser',
      text: 'Test pin from Visual Editor — ' + new Date().toLocaleTimeString(),
      timestamp: Date.now(),
    })
  })

  // Legacy LT compat
  safeHandle(IPC_CHANNELS.LT_FIRE, () => {
    overlay.fireLowerThird()
  })

  safeHandle(IPC_CHANNELS.LT_HIDE, () => {
    overlay.hideLowerThird()
  })

  safeHandle(IPC_CHANNELS.LT_AUTO_FIRE_TOGGLE, () => {
    const newState = !recording.getAutoFire()
    recording.setAutoFire(newState)
    return newState
  })

  // --- App ---
  safeHandle(IPC_CHANNELS.APP_TOGGLE_ALWAYS_ON_TOP, (enabled: unknown) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setAlwaysOnTop(enabled as boolean)
    logger.ipc.info(`Always on top: ${enabled}`)
  })

  safeHandle(IPC_CHANNELS.APP_OPEN_PATH, async (filePath: unknown) => {
    const p = filePath as string
    const fsStat = await import('fs').then((m) => m.promises.stat(p).catch(() => null))
    if (fsStat) {
      if (fsStat.isFile()) {
        shell.showItemInFolder(p)
      } else {
        await shell.openPath(p)
      }
    } else {
      const dir = require('path').dirname(p)
      const dirStat = await import('fs').then((m) => m.promises.stat(dir).catch(() => null))
      if (dirStat) {
        await shell.openPath(dir)
      } else {
        logger.ipc.warn(`Path does not exist: ${p}`)
        return { error: `Path not found: ${p}` }
      }
    }
  })

  safeHandle(IPC_CHANNELS.APP_CRASH_RECOVERY, async () => {
    await checkAndRecover()
  })

  safeHandle(IPC_CHANNELS.APP_GET_VERSION, () => {
    const { app } = require('electron')
    return app.getVersion()
  })

  safeHandle(IPC_CHANNELS.APP_PING, () => {
    return { ts: Date.now() }
  })

  // Zoom
  let zoomSaveTimer: NodeJS.Timeout | null = null
  safeHandle(IPC_CHANNELS.APP_SET_ZOOM, (direction: unknown) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    const current = win.webContents.getZoomFactor()
    const step = 0.1
    let newZoom: number
    if (direction === 'in') {
      newZoom = Math.min(current + step, 3.0)
    } else if (direction === 'out') {
      newZoom = Math.max(current - step, 0.5)
    } else if (direction === 'reset') {
      newZoom = 1.0
    } else {
      newZoom = current
    }
    win.webContents.setZoomFactor(newZoom)
    if (zoomSaveTimer) clearTimeout(zoomSaveTimer)
    zoomSaveTimer = setTimeout(() => {
      settings.setSettings({ behavior: { ...settings.getSettings().behavior, zoomFactor: newZoom } })
      zoomSaveTimer = null
    }, 1000)
    return newZoom
  })

  safeHandle(IPC_CHANNELS.APP_GET_ZOOM, () => {
    const win = BrowserWindow.getAllWindows()[0]
    return win ? win.webContents.getZoomFactor() : 1.0
  })

  // Preview
  safeHandle(IPC_CHANNELS.PREVIEW_START, (fps: unknown) => {
    obs.startPreview((fps as number) || 2)
  })

  safeHandle(IPC_CHANNELS.PREVIEW_STOP, () => {
    obs.stopPreview()
  })

  // Toggle DevTools (F12)
  safeHandle(IPC_CHANNELS.APP_TOGGLE_DEVTOOLS, () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.toggleDevTools()
  })

  // Renderer → main log forwarding
  safeHandle(IPC_CHANNELS.APP_RENDERER_LOG, (level: unknown, ...args: unknown[]) => {
    const lvl = level as string
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    if (lvl === 'error') logger.app.error('[Renderer]', msg)
    else if (lvl === 'warn') logger.app.warn('[Renderer]', msg)
    else logger.app.info('[Renderer]', msg)
  })

  // Copy diagnostics to clipboard
  safeHandle(IPC_CHANNELS.APP_COPY_DIAGNOSTICS, async () => {
    const { app } = require('electron')
    const logPath = path.join(app.getPath('userData'), 'logs', 'main.log')
    const obsState = obs.getState()
    const comp = stateService.getCompetition()

    let logTail = '(no log file found)'
    try {
      const content = fs.readFileSync(logPath, 'utf-8')
      const lines = content.split('\n')
      logTail = lines.slice(-150).join('\n')
    } catch {
      // file may not exist yet
    }

    const diagnostics = [
      `=== CompSync Media Diagnostics ===`,
      `Version: ${app.getVersion()}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Electron: ${process.versions.electron}`,
      `Node: ${process.versions.node}`,
      `Time: ${new Date().toISOString()}`,
      `User Data: ${app.getPath('userData')}`,
      ``,
      `--- OBS State ---`,
      `Connection: ${obsState.connectionStatus}`,
      `Recording: ${obsState.isRecording}`,
      `Streaming: ${obsState.isStreaming}`,
      `Record Time: ${obsState.recordTimeSec}s`,
      ``,
      `--- Competition ---`,
      comp ? `Name: ${comp.name}` : '(none loaded)',
      comp ? `Routines: ${comp.routines.length}` : '',
      comp ? `Source: ${comp.source}` : '',
      ``,
      `--- Recent Logs (last 150 lines) ---`,
      logTail,
    ].join('\n')

    clipboard.writeText(diagnostics)
    logger.app.info('Diagnostics copied to clipboard')
    return { copied: true, length: diagnostics.length }
  })

  // --- Import ---
  safeHandle(IPC_CHANNELS.RECORDING_IMPORT_FILE, async (routineId: unknown, filePath: unknown) => {
    logIPC(IPC_CHANNELS.RECORDING_IMPORT_FILE, { routineId, filePath })
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    const routine = comp.routines.find(r => r.id === routineId)
    if (!routine) return { error: 'Routine not found' }

    const s = settings.getSettings()
    const outputDir = s.fileNaming.outputDirectory
    if (!outputDir) return { error: 'No output directory configured' }

    const ext = path.extname(filePath as string)
    const routineDir = path.join(outputDir, routine.entryNumber)
    await fs.promises.mkdir(routineDir, { recursive: true })

    const destPath = path.join(routineDir, `${routine.entryNumber}_${routine.routineTitle.replace(/[<>:"/\\|?*\s]+/g, '_')}${ext}`)
    await fs.promises.copyFile(filePath as string, destPath)

    stateService.updateRoutineStatus(routine.id, 'recorded', {
      outputPath: destPath,
      outputDir: routineDir,
    })

    // Auto-encode if enabled
    if (s.behavior.autoEncodeRecordings) {
      ffmpegService.enqueueJob({
        routineId: routine.id,
        inputPath: destPath,
        outputDir: routineDir,
        judgeCount: s.competition.judgeCount,
        trackMapping: s.audioTrackMapping,
        processingMode: s.ffmpeg.processingMode,
        filePrefix: schedule.buildFilePrefix(routine.entryNumber),
      })
    }

    recording.broadcastFullState()
    return { success: true, path: destPath }
  })

  safeHandle(IPC_CHANNELS.RECORDING_IMPORT_FOLDER, async (folderPath: unknown) => {
    logIPC(IPC_CHANNELS.RECORDING_IMPORT_FOLDER, { folderPath })
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }

    const videoExts = ['.mkv', '.mp4', '.flv', '.avi', '.mov']
    const files = (await fs.promises.readdir(folderPath as string))
      .filter(f => videoExts.includes(path.extname(f).toLowerCase()))

    const matches: { file: string; routineId: string; confidence: string }[] = []
    const unmatched: string[] = []

    for (const file of files) {
      const baseName = path.basename(file, path.extname(file)).toLowerCase()
      // Try to match by entry number in filename
      let matched = false
      for (const routine of comp.routines) {
        if (baseName.includes(routine.entryNumber.toLowerCase())) {
          matches.push({ file, routineId: routine.id, confidence: 'exact' })
          matched = true
          break
        }
      }
      if (!matched) {
        unmatched.push(file)
      }
    }

    return { matches, unmatched, folderPath }
  })

  // --- Job Queue ---
  safeHandle(IPC_CHANNELS.JOB_QUEUE_GET, () => {
    return jobQueue.getAll()
  })

  safeHandle(IPC_CHANNELS.JOB_QUEUE_RETRY, (jobId: unknown) => {
    logIPC(IPC_CHANNELS.JOB_QUEUE_RETRY, { jobId })
    return jobQueue.retry(jobId as string)
  })

  safeHandle(IPC_CHANNELS.JOB_QUEUE_CANCEL, (jobId: unknown) => {
    logIPC(IPC_CHANNELS.JOB_QUEUE_CANCEL, { jobId })
    return jobQueue.remove(jobId as string)
  })

  // KICK QUEUE: re-fire all schedulers regardless of internal idle/sleep
  // state. Used when the operator can see things sitting (jobs queued but
  // nothing running) and wants to nudge it without restarting the app.
  //
  // 2026-04-29: extended to cover photo-import in addition to encode + upload.
  // Operator wanted "kick any stalled phase" — previously only ffmpeg + upload
  // queues were kicked. Now also re-fires auto-import for any mounted camera
  // drive (idempotent via dedupByDb + importLock).
  safeHandle(IPC_CHANNELS.JOB_QUEUE_KICK, async () => {
    logIPC(IPC_CHANNELS.JOB_QUEUE_KICK)
    let importKicked = 0
    try {
      const ffmpegMod = await import('./services/ffmpeg')
      ffmpegMod.resumeRecordedRoutines()
      ffmpegMod.resumeEncoding()
    } catch (err) {
      logger.app.warn(`kick: ffmpeg resume failed: ${err instanceof Error ? err.message : err}`)
    }
    try {
      const upload = await import('./services/upload')
      upload.startUploads()
    } catch (err) {
      logger.app.warn(`kick: startUploads failed: ${err instanceof Error ? err.message : err}`)
    }
    try {
      const driveMonitor = await import('./services/driveMonitor')
      const result = await driveMonitor.kickPhotoImports()
      importKicked = result.kicked
      if (result.reasons.length > 0) {
        logger.app.info(`kick: photo-import skip reasons: ${result.reasons.join('; ')}`)
      }
    } catch (err) {
      logger.app.warn(`kick: photo-import resume failed: ${err instanceof Error ? err.message : err}`)
    }
    return { ok: true, importKicked }
  })

  // Phase 1.4 / 1.6: drift refresh + dismiss handlers.
  safeHandle(IPC_CHANNELS.COMP_STATE_DRIFT_REFRESH_REQUEST, async () => {
    logIPC(IPC_CHANNELS.COMP_STATE_DRIFT_REFRESH_REQUEST)
    const driftMod = await import('./services/compStateSync')
    await driftMod.applyRefresh()
    return { ok: true }
  })
  safeHandle(IPC_CHANNELS.COMP_STATE_DRIFT_DISMISS, async () => {
    logIPC(IPC_CHANNELS.COMP_STATE_DRIFT_DISMISS)
    const driftMod = await import('./services/compStateSync')
    driftMod.dismissForSession()
    return { ok: true }
  })

  // AUTO TOGGLE: flip the global autoEncode/autoUpload setting and fire a
  // kick as a side effect. Operator UI right-clicks UPLOAD or PROCESS button
  // (Nudge in current implementation) → toggle relevant flag → kick.
  safeHandle(IPC_CHANNELS.JOB_QUEUE_AUTO_TOGGLE, async (kind: unknown) => {
    logIPC(IPC_CHANNELS.JOB_QUEUE_AUTO_TOGGLE, { kind })
    try {
      const settingsMod = await import('./services/settings')
      const cur = settingsMod.getSettings()
      const next = JSON.parse(JSON.stringify(cur))
      if (kind === 'encode') next.behavior.autoEncodeRecordings = !cur.behavior.autoEncodeRecordings
      else if (kind === 'upload') next.behavior.autoUploadAfterEncoding = !cur.behavior.autoUploadAfterEncoding
      else throw new Error(`Unknown auto-toggle kind: ${String(kind)}`)
      await settingsMod.setSettings(next)
      // Fire kick after toggle.
      try {
        const ffmpegMod = await import('./services/ffmpeg')
        ffmpegMod.resumeRecordedRoutines()
        ffmpegMod.resumeEncoding()
      } catch {}
      try {
        const upload = await import('./services/upload')
        upload.startUploads()
      } catch {}
      return {
        ok: true,
        autoEncode: next.behavior.autoEncodeRecordings,
        autoUpload: next.behavior.autoUploadAfterEncoding,
      }
    } catch (err) {
      logger.app.error(`auto-toggle failed: ${err instanceof Error ? err.message : err}`)
      throw err
    }
  })

  // OBS transitions
  safeHandle(IPC_CHANNELS.OBS_TRANSITION_LIST, async () => {
    return await obs.getTransitionList()
  })
  safeHandle(IPC_CHANNELS.OBS_TRANSITION_GET_CURRENT, async () => {
    return await obs.getCurrentTransitionName()
  })
  safeHandle(IPC_CHANNELS.OBS_TRANSITION_SET_CURRENT, async (name: unknown) => {
    if (typeof name !== 'string') throw new Error('transition name required')
    await obs.setCurrentTransitionByName(name)
    return { ok: true }
  })

  // --- Recovery ---
  safeHandle(IPC_CHANNELS.RECOVERY_BROWSE_MKV, async () => {
    logIPC(IPC_CHANNELS.RECOVERY_BROWSE_MKV)
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Full-Day Recording(s)',
      filters: [
        { name: 'Video Files', extensions: ['mkv', 'mp4', 'avi', 'mov', 'flv'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return null
    return result.filePaths
  })

  safeHandle(IPC_CHANNELS.RECOVERY_START, async (config: unknown) => {
    logIPC(IPC_CHANNELS.RECOVERY_START)
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    const c = config as { mkvPaths: string[]; photoFolderPath?: string; outputDir: string }
    // Run async — don't await (long-running)
    recovery.startRecovery(c, comp).catch((err) => {
      logger.ipc.error('Recovery failed:', err)
    })
    return { started: true }
  })

  safeHandle(IPC_CHANNELS.RECOVERY_CANCEL, () => {
    logIPC(IPC_CHANNELS.RECOVERY_CANCEL)
    recovery.cancelRecovery()
  })

  safeHandle(IPC_CHANNELS.RECOVERY_GET_STATE, () => {
    return recovery.getRecoveryState()
  })

  // --- Tether ---
  safeHandle(IPC_CHANNELS.TETHER_START, async (dcimPath: unknown) => {
    logIPC(IPC_CHANNELS.TETHER_START, { dcimPath })
    await tether.startWatching(dcimPath as string)
  })

  safeHandle(IPC_CHANNELS.TETHER_START_WPD, async (deviceId: unknown) => {
    logIPC(IPC_CHANNELS.TETHER_START_WPD, { deviceId })
    await tether.startWatchingWPD(deviceId as string)
  })

  safeHandle(IPC_CHANNELS.TETHER_STOP, async () => {
    logIPC(IPC_CHANNELS.TETHER_STOP)
    await tether.stopWatching()
  })

  safeHandle(IPC_CHANNELS.TETHER_GET_STATE, () => {
    return tether.getTetherState()
  })

  safeHandle(IPC_CHANNELS.TETHER_LIST_WPD_DEVICES, async () => {
    return await tether.listWPDDevices()
  })

  // --- Wifi Display ---
  safeHandle(IPC_CHANNELS.WIFI_DISPLAY_GET_MONITORS, () => {
    return wifiDisplay.getMonitors()
  })

  safeHandle(IPC_CHANNELS.WIFI_DISPLAY_START, async () => {
    await wifiDisplay.start()
    return wifiDisplay.getStatus()
  })

  safeHandle(IPC_CHANNELS.WIFI_DISPLAY_STOP, async () => {
    await wifiDisplay.stop()
    return wifiDisplay.getStatus()
  })

  safeHandle(IPC_CHANNELS.WIFI_DISPLAY_STATUS, () => {
    return wifiDisplay.getStatus()
  })

  safeHandle(IPC_CHANNELS.WIFI_DISPLAY_SET_MONITOR, (monitorIndex: unknown) => {
    const s = settings.getSettings()
    settings.setSettings({ wifiDisplay: { ...s.wifiDisplay, monitorIndex: monitorIndex as number } })
    return { ok: true }
  })

  // --- System info ---
  safeHandle(IPC_CHANNELS.SYSTEM_GET_INFO, () => {
    return { cpuCount: os.cpus().length }
  })

  // --- Overlay: fire a chat message as LT-style broadcast ---
  safeHandle(IPC_CHANNELS.OVERLAY_FIRE_CHAT_MESSAGE, (msg: unknown) => {
    logIPC(IPC_CHANNELS.OVERLAY_FIRE_CHAT_MESSAGE)
    if (msg && typeof msg === 'object') {
      overlay.fireChatMessage(msg as any)
    }
    return { ok: true }
  })

  // --- Day Checklist (Start-of-Day / End-of-Day modals) ---
  safeHandle(IPC_CHANNELS.DAY_CHECKLIST_GET, (date: unknown, kind: unknown) => {
    return dayChecklist.getDayState(date as string, kind as 'start' | 'end')
  })

  safeHandle(IPC_CHANNELS.DAY_CHECKLIST_SET_ITEM, (
    date: unknown,
    kind: unknown,
    itemId: unknown,
    value: unknown,
  ) => {
    return dayChecklist.setItemState(
      date as string,
      kind as 'start' | 'end',
      itemId as string,
      value as 'open' | 'checked' | 'skipped' | 'na',
    )
  })

  safeHandle(IPC_CHANNELS.DAY_CHECKLIST_DISMISS, (date: unknown, kind: unknown) => {
    return dayChecklist.markDismissed(date as string, kind as 'start' | 'end')
  })

  safeHandle(IPC_CHANNELS.DAY_CHECKLIST_REOPEN, (kind: unknown) => {
    return dayChecklist.manualReopen(kind as 'start' | 'end')
  })

  // Start system monitor
  systemMonitor.startMonitoring()

  logger.ipc.info('All IPC handlers registered')
}
