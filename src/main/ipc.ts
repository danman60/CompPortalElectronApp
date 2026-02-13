import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
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

export function registerAllHandlers(): void {
  // --- OBS ---
  ipcMain.handle(IPC_CHANNELS.OBS_CONNECT, async (_e, url: string, password: string) => {
    logIPC(IPC_CHANNELS.OBS_CONNECT, { url })
    try {
      await obs.connect(url, password)
    } catch {
      // connect() handles logging and reconnect internally
    }
    return obs.getState()
  })

  ipcMain.handle(IPC_CHANNELS.OBS_DISCONNECT, async () => {
    logIPC(IPC_CHANNELS.OBS_DISCONNECT)
    await obs.disconnect()
  })

  ipcMain.handle(IPC_CHANNELS.OBS_START_RECORD, async () => {
    logIPC(IPC_CHANNELS.OBS_START_RECORD)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    await obs.startRecord()
  })

  ipcMain.handle(IPC_CHANNELS.OBS_STOP_RECORD, async () => {
    logIPC(IPC_CHANNELS.OBS_STOP_RECORD)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    return await obs.stopRecord()
  })

  ipcMain.handle(IPC_CHANNELS.OBS_START_STREAM, async () => {
    logIPC(IPC_CHANNELS.OBS_START_STREAM)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    await obs.startStream()
  })

  ipcMain.handle(IPC_CHANNELS.OBS_STOP_STREAM, async () => {
    logIPC(IPC_CHANNELS.OBS_STOP_STREAM)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    await obs.stopStream()
  })

  ipcMain.handle(IPC_CHANNELS.OBS_SAVE_REPLAY, async () => {
    logIPC(IPC_CHANNELS.OBS_SAVE_REPLAY)
    if (obs.getState().connectionStatus !== 'connected') return { error: 'OBS not connected' }
    await obs.saveReplay()
  })

  ipcMain.handle(IPC_CHANNELS.OBS_INPUT_LIST, async () => {
    logIPC(IPC_CHANNELS.OBS_INPUT_LIST)
    return await obs.getInputList()
  })

  // --- Recording Pipeline ---
  ipcMain.handle(IPC_CHANNELS.RECORDING_NEXT, async () => {
    logIPC(IPC_CHANNELS.RECORDING_NEXT)
    try {
      await recording.next()
    } catch (err) {
      logger.app.error('recording:next failed:', err instanceof Error ? err.message : err)
      return { error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_PREV, async () => {
    logIPC(IPC_CHANNELS.RECORDING_PREV)
    try {
      await recording.prev()
    } catch (err) {
      logger.app.error('recording:prev failed:', err instanceof Error ? err.message : err)
      return { error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_SKIP, async (_e, routineId: string) => {
    logIPC(IPC_CHANNELS.RECORDING_SKIP, { routineId })
    stateService.skipRoutine(routineId)
    recording.broadcastFullState()
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_UNSKIP, async (_e, routineId: string) => {
    logIPC(IPC_CHANNELS.RECORDING_UNSKIP, { routineId })
    stateService.unskipRoutine(routineId)
    recording.broadcastFullState()
  })

  // --- FFmpeg ---
  ipcMain.handle(IPC_CHANNELS.FFMPEG_ENCODE, async (_e, routineId: string) => {
    logIPC(IPC_CHANNELS.FFMPEG_ENCODE, { routineId })
    const comp = stateService.getCompetition()
    if (!comp) return
    const routine = comp.routines.find((r) => r.id === routineId)
    if (!routine || !routine.outputPath) return
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

  ipcMain.handle(IPC_CHANNELS.FFMPEG_ENCODE_ALL, async () => {
    logIPC(IPC_CHANNELS.FFMPEG_ENCODE_ALL)
    const comp = stateService.getCompetition()
    if (!comp) return
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
  ipcMain.handle(IPC_CHANNELS.SCHEDULE_LOAD_CSV, async (_e, filePath: string) => {
    logIPC(IPC_CHANNELS.SCHEDULE_LOAD_CSV, { filePath })
    const comp = schedule.loadSchedule(filePath)
    stateService.setCompetition(comp)
    recording.broadcastFullState()
    return comp
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULE_GET, async () => {
    return stateService.getCompetition()
  })

  ipcMain.handle(IPC_CHANNELS.SCHEDULE_BROWSE_FILE, async () => {
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
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    logIPC(IPC_CHANNELS.SETTINGS_GET)
    return settings.getSettings()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_e, partial) => {
    logIPC(IPC_CHANNELS.SETTINGS_SET, Object.keys(partial))
    return settings.setSettings(partial)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_BROWSE_DIR, async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_BROWSE_FILE, async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      filters: filters || [],
      properties: ['openFile'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  // --- Upload ---
  ipcMain.handle(IPC_CHANNELS.UPLOAD_START, () => {
    logIPC(IPC_CHANNELS.UPLOAD_START)
    uploadService.startUploads()
  })

  ipcMain.handle(IPC_CHANNELS.UPLOAD_STOP, () => {
    logIPC(IPC_CHANNELS.UPLOAD_STOP)
    uploadService.stopUploads()
  })

  ipcMain.handle(IPC_CHANNELS.UPLOAD_ROUTINE, (_e, routineId: string) => {
    logIPC(IPC_CHANNELS.UPLOAD_ROUTINE, { routineId })
    const comp = stateService.getCompetition()
    if (!comp) return
    const routine = comp.routines.find((r) => r.id === routineId)
    if (routine) {
      uploadService.enqueueRoutine(routine)
    }
  })

  // --- Photos ---
  ipcMain.handle(IPC_CHANNELS.PHOTOS_BROWSE, async () => {
    logIPC(IPC_CHANNELS.PHOTOS_BROWSE)
    return await photoService.browseForFolder()
  })

  ipcMain.handle(IPC_CHANNELS.PHOTOS_IMPORT, async (_e, folderPath: string) => {
    logIPC(IPC_CHANNELS.PHOTOS_IMPORT, { folderPath })
    const comp = stateService.getCompetition()
    const s = settings.getSettings()
    if (!comp) return null
    return await photoService.importPhotos(folderPath, comp.routines, s.fileNaming.outputDirectory)
  })

  // --- Lower Third ---
  ipcMain.handle(IPC_CHANNELS.LT_FIRE, () => {
    logIPC(IPC_CHANNELS.LT_FIRE)
    const s = settings.getSettings()
    if (s.lowerThird.autoHideSeconds > 0) {
      lowerThird.fireWithAutoHide(s.lowerThird.autoHideSeconds)
    } else {
      lowerThird.fire()
    }
  })

  ipcMain.handle(IPC_CHANNELS.LT_HIDE, () => {
    logIPC(IPC_CHANNELS.LT_HIDE)
    lowerThird.hide()
  })

  // --- App ---
  ipcMain.handle(IPC_CHANNELS.APP_TOGGLE_ALWAYS_ON_TOP, (_e, enabled: boolean) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setAlwaysOnTop(enabled)
  })

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_PATH, async (_e, filePath: string) => {
    await shell.openPath(filePath)
  })

  ipcMain.handle(IPC_CHANNELS.APP_CRASH_RECOVERY, async () => {
    await checkAndRecover()
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, () => {
    const { app } = require('electron')
    return app.getVersion()
  })

  logger.ipc.info('All IPC handlers registered')
}
