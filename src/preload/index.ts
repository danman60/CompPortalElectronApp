import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, AppSettings } from '../shared/types'

const api = {
  // OBS
  obsConnect: (url: string, password: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_CONNECT, url, password),
  obsDisconnect: () => ipcRenderer.invoke(IPC_CHANNELS.OBS_DISCONNECT),
  obsStartRecord: () => ipcRenderer.invoke(IPC_CHANNELS.OBS_START_RECORD),
  obsStopRecord: () => ipcRenderer.invoke(IPC_CHANNELS.OBS_STOP_RECORD),
  obsStartStream: () => ipcRenderer.invoke(IPC_CHANNELS.OBS_START_STREAM),
  obsStopStream: () => ipcRenderer.invoke(IPC_CHANNELS.OBS_STOP_STREAM),
  obsSaveReplay: () => ipcRenderer.invoke(IPC_CHANNELS.OBS_SAVE_REPLAY),
  obsGetInputList: () => ipcRenderer.invoke(IPC_CHANNELS.OBS_INPUT_LIST),

  // Recording
  recordingNext: () => ipcRenderer.invoke(IPC_CHANNELS.RECORDING_NEXT),
  recordingPrev: () => ipcRenderer.invoke(IPC_CHANNELS.RECORDING_PREV),
  recordingSkip: (routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_SKIP, routineId),
  recordingUnskip: (routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_UNSKIP, routineId),

  // FFmpeg
  ffmpegEncode: (routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_ENCODE, routineId),
  ffmpegEncodeAll: () => ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_ENCODE_ALL),

  // Schedule
  scheduleLoadCSV: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_LOAD_CSV, filePath),
  scheduleGet: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_GET),
  scheduleBrowseFile: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_BROWSE_FILE),

  // Settings
  settingsGet: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  settingsSet: (partial: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, partial),
  settingsBrowseDir: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_BROWSE_DIR),
  settingsBrowseFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_BROWSE_FILE, filters),

  // Upload
  uploadStart: () => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_START),
  uploadStop: () => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_STOP),
  uploadRoutine: (routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_ROUTINE, routineId),

  // Photos
  photosBrowse: () => ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_BROWSE),
  photosImport: (folderPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_IMPORT, folderPath),

  // Lower Third
  ltFire: () => ipcRenderer.invoke(IPC_CHANNELS.LT_FIRE),
  ltHide: () => ipcRenderer.invoke(IPC_CHANNELS.LT_HIDE),

  // App
  toggleAlwaysOnTop: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_TOGGLE_ALWAYS_ON_TOP, enabled),
  openPath: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_PATH, filePath),
  crashRecovery: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CRASH_RECOVERY),
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),

  // Event listeners (main → renderer)
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },

  once: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.once(channel, (_event, ...args) => callback(...args))
  },
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('api', api)
