import { ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import fs from 'fs'
import path from 'path'
import * as obs from './services/obs'
import * as settings from './services/settings'
import * as schedule from './services/schedule'
import * as stateService from './services/state'
import * as recording from './services/recording'
import * as ffmpegService from './services/ffmpeg'
import * as uploadService from './services/upload'
import * as photoService from './services/photos'
import * as overlay from './services/overlay'
import * as wsHub from './services/wsHub'
import * as systemMonitor from './services/systemMonitor'
import * as jobQueue from './services/jobQueue'
import { checkAndRecover } from './services/crashRecovery'
import { logger } from './logger'

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

  safeHandle(IPC_CHANNELS.RECORDING_NEXT_FULL, async () => {
    logIPC(IPC_CHANNELS.RECORDING_NEXT_FULL)
    await recording.nextFull()
  })

  // --- FFmpeg ---
  safeHandle(IPC_CHANNELS.FFMPEG_ENCODE, async (routineId: unknown) => {
    logIPC(IPC_CHANNELS.FFMPEG_ENCODE, { routineId })
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    const routine = comp.routines.find((r) => r.id === routineId)
    if (!routine || !routine.outputPath) return { error: 'Routine not found or not recorded' }
    const s = settings.getSettings()
    const dir = routine.outputPath.replace(/\.[^.]+$/, '')
    ffmpegService.enqueueJob({
      routineId: routine.id,
      inputPath: routine.outputPath,
      outputDir: dir,
      judgeCount: s.competition.judgeCount,
      trackMapping: s.audioTrackMapping,
      processingMode: s.ffmpeg.processingMode,
      filePrefix: schedule.buildFilePrefix(routine.entryNumber),
    })
  })

  safeHandle(IPC_CHANNELS.FFMPEG_ENCODE_ALL, async () => {
    logIPC(IPC_CHANNELS.FFMPEG_ENCODE_ALL)
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    const s = settings.getSettings()
    for (const routine of comp.routines) {
      if (routine.status === 'recorded' && routine.outputPath) {
        const dir = routine.outputPath.replace(/\.[^.]+$/, '')
        ffmpegService.enqueueJob({
          routineId: routine.id,
          inputPath: routine.outputPath,
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

  // --- Upload ---
  safeHandle(IPC_CHANNELS.UPLOAD_START, () => {
    logIPC(IPC_CHANNELS.UPLOAD_START)
    uploadService.startUploads()
  })

  safeHandle(IPC_CHANNELS.UPLOAD_STOP, () => {
    logIPC(IPC_CHANNELS.UPLOAD_STOP)
    uploadService.stopUploads()
  })

  safeHandle(IPC_CHANNELS.UPLOAD_ALL, () => {
    logIPC(IPC_CHANNELS.UPLOAD_ALL)
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    let queued = 0
    for (const routine of comp.routines) {
      if (routine.encodedFiles && routine.status !== 'uploaded' && routine.status !== 'confirmed' && routine.status !== 'uploading') {
        uploadService.enqueueRoutine(routine)
        queued++
      }
    }
    if (queued > 0) uploadService.startUploads()
    logger.ipc.info(`Upload all: queued ${queued} routines`)
    return { queued }
  })

  safeHandle(IPC_CHANNELS.UPLOAD_ROUTINE, (routineId: unknown) => {
    logIPC(IPC_CHANNELS.UPLOAD_ROUTINE, { routineId })
    const comp = stateService.getCompetition()
    if (!comp) return { error: 'No competition loaded' }
    const routine = comp.routines.find((r) => r.id === routineId)
    if (routine) {
      uploadService.enqueueRoutine(routine)
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
    return overlay.getOverlayState()
  })

  safeHandle(IPC_CHANNELS.OVERLAY_AUTO_FIRE_TOGGLE, () => {
    const newState = !recording.getAutoFire()
    recording.setAutoFire(newState)
    return newState
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
    obs.startPreview((fps as number) || 5)
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

  // Start system monitor
  systemMonitor.startMonitoring()

  logger.ipc.info('All IPC handlers registered')
}
