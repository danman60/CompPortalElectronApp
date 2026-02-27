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
  scheduleLoadShareCode: (shareCode: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_LOAD_SHARE_CODE, shareCode),
  scheduleGet: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_GET),
  scheduleBrowseFile: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULE_BROWSE_FILE),

  // State
  jumpToRoutine: (routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.STATE_JUMP_TO, routineId),
  setRoutineNote: (routineId: string, note: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.STATE_SET_NOTE, routineId, note),
  exportReport: () => ipcRenderer.invoke(IPC_CHANNELS.STATE_EXPORT_REPORT),

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
  uploadAll: () => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_ALL),
  uploadRoutine: (routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_ROUTINE, routineId),

  // Photos
  photosBrowse: () => ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_BROWSE),
  photosImport: (folderPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PHOTOS_IMPORT, folderPath),

  // Lower Third
  ltFire: () => ipcRenderer.invoke(IPC_CHANNELS.LT_FIRE),
  ltHide: () => ipcRenderer.invoke(IPC_CHANNELS.LT_HIDE),
  ltAutoFireToggle: () => ipcRenderer.invoke(IPC_CHANNELS.LT_AUTO_FIRE_TOGGLE),

  // Overlay
  overlayToggle: (element: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_TOGGLE, element),
  overlayFireLT: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_FIRE_LT),
  overlayHideLT: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_HIDE_LT),
  overlayGetState: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_GET_STATE),
  overlayAutoFireToggle: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_AUTO_FIRE_TOGGLE),

  // Next Full
  recordingNextFull: () => ipcRenderer.invoke(IPC_CHANNELS.RECORDING_NEXT_FULL),

  // App
  toggleAlwaysOnTop: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_TOGGLE_ALWAYS_ON_TOP, enabled),
  openPath: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_PATH, filePath),
  crashRecovery: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CRASH_RECOVERY),
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  toggleDevTools: () => ipcRenderer.invoke(IPC_CHANNELS.APP_TOGGLE_DEVTOOLS),
  setZoom: (direction: string) => ipcRenderer.invoke(IPC_CHANNELS.APP_SET_ZOOM, direction),
  getZoom: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_ZOOM),

  // Import
  importFile: (routineId: string, filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_IMPORT_FILE, routineId, filePath),
  importFolder: (folderPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_IMPORT_FOLDER, folderPath),
  importConfirm: (matches: { file: string; routineId: string }[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_IMPORT_CONFIRM, matches),

  // Job Queue
  jobQueueGet: () => ipcRenderer.invoke(IPC_CHANNELS.JOB_QUEUE_GET),
  jobQueueRetry: (jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.JOB_QUEUE_RETRY, jobId),
  jobQueueCancel: (jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.JOB_QUEUE_CANCEL, jobId),

  // Preview
  previewStart: (fps?: number) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_START, fps),
  previewStop: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_STOP),
  copyDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.APP_COPY_DIAGNOSTICS),
  rendererLog: (level: string, ...args: unknown[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_RENDERER_LOG, level, ...args),

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

  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel)
  },
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('api', api)
