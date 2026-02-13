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
import * as lowerThird from './services/lowerThird'
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

  // --- Settings ---
  safeHandle(IPC_CHANNELS.SETTINGS_GET, () => {
    logIPC(IPC_CHANNELS.SETTINGS_GET)
    return settings.getSettings()
  })

  safeHandle(IPC_CHANNELS.SETTINGS_SET, (partial: unknown) => {
    logIPC(IPC_CHANNELS.SETTINGS_SET, Object.keys(partial as object))
    return settings.setSettings(partial as Partial<Record<string, unknown>>)
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

  // --- Lower Third ---
  safeHandle(IPC_CHANNELS.LT_FIRE, () => {
    logIPC(IPC_CHANNELS.LT_FIRE)
    const s = settings.getSettings()
    if (s.lowerThird.autoHideSeconds > 0) {
      lowerThird.fireWithAutoHide(s.lowerThird.autoHideSeconds)
    } else {
      lowerThird.fire()
    }
  })

  safeHandle(IPC_CHANNELS.LT_HIDE, () => {
    logIPC(IPC_CHANNELS.LT_HIDE)
    lowerThird.hide()
  })

  // --- App ---
  safeHandle(IPC_CHANNELS.APP_TOGGLE_ALWAYS_ON_TOP, (_e: unknown, enabled: unknown) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setAlwaysOnTop(enabled as boolean)
  })

  safeHandle(IPC_CHANNELS.APP_OPEN_PATH, async (filePath: unknown) => {
    await shell.openPath(filePath as string)
  })

  safeHandle(IPC_CHANNELS.APP_CRASH_RECOVERY, async () => {
    await checkAndRecover()
  })

  safeHandle(IPC_CHANNELS.APP_GET_VERSION, () => {
    const { app } = require('electron')
    return app.getVersion()
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

    // Read last 150 lines of log
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

  logger.ipc.info('All IPC handlers registered')
}
