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
  ffmpegPause: () => ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_PAUSE),
  ffmpegResume: () => ipcRenderer.invoke(IPC_CHANNELS.FFMPEG_RESUME),

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
  uploadCancelRoutine: (routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_CANCEL_ROUTINE, routineId),

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
  overlayUpdateLayout: (layout: any) => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_UPDATE_LAYOUT, layout),
  overlaySetTicker: (updates: any) => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_TICKER, updates),
  overlaySetStartingSoon: (updates: any) => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_STARTING_SOON, updates),
  overlaySetAnimationConfig: (updates: any) => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_ANIMATION_CONFIG, updates),
  overlaySetLogo: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_LOGO),

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

  // CLIP Verification
  clipVerifyImport: (matches: unknown, routines: unknown, opts?: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIP_VERIFY_IMPORT, matches, routines, opts),
  clipAnalyzeFolder: (folderPath: string, params: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIP_ANALYZE_FOLDER, folderPath, params),
  clipExecuteSort: (result: unknown, params: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIP_EXECUTE_SORT, result, params),
  clipCancel: () => ipcRenderer.invoke(IPC_CHANNELS.CLIP_CANCEL),

  // Drive Monitor
  driveDismiss: (drivePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DRIVE_DISMISS, drivePath),

  // Tether
  tetherStart: (dcimPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TETHER_START, dcimPath),
  tetherStartWPD: (deviceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TETHER_START_WPD, deviceId),
  tetherStop: () => ipcRenderer.invoke(IPC_CHANNELS.TETHER_STOP),
  tetherGetState: () => ipcRenderer.invoke(IPC_CHANNELS.TETHER_GET_STATE),
  tetherListWPDDevices: () => ipcRenderer.invoke(IPC_CHANNELS.TETHER_LIST_WPD_DEVICES),

  // Wifi Display
  wifiDisplayGetMonitors: () => ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_GET_MONITORS),
  wifiDisplayStart: () => ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_START),
  wifiDisplayStop: () => ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_STOP),
  wifiDisplayStatus: () => ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_STATUS),
  wifiDisplaySetMonitor: (monitorIndex: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_SET_MONITOR, monitorIndex),

  // Brand Scraper
  brandScrape: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.BRAND_SCRAPE, url),

  // Starting Soon Scene Editor
  ssGetConfig: () => ipcRenderer.invoke(IPC_CHANNELS.SS_GET_CONFIG),
  ssSetConfig: (updates: any) => ipcRenderer.invoke(IPC_CHANNELS.SS_SET_CONFIG, updates),
  ssBrowseFolder: (type: string) => ipcRenderer.invoke(IPC_CHANNELS.SS_BROWSE_FOLDER, type),
  ssScanFolder: (path: string, type: string) => ipcRenderer.invoke(IPC_CHANNELS.SS_SCAN_FOLDER, path, type),
  ssGetPresets: () => ipcRenderer.invoke(IPC_CHANNELS.SS_GET_PRESETS),
  ssSavePreset: (preset: any) => ipcRenderer.invoke(IPC_CHANNELS.SS_SAVE_PRESET, preset),
  ssDeletePreset: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SS_DELETE_PRESET, id),
  ssLoadPreset: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SS_LOAD_PRESET, id),

  // Chat (Livestream Pinned Comments)
  chatGetMessages: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_MESSAGES),
  chatGetPinned: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_PINNED),
  chatPin: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_PIN, id),
  chatUnpin: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_UNPIN, id),
  chatClearPinned: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR_PINNED),

  // Recovery
  recoveryBrowseMkv: () => ipcRenderer.invoke(IPC_CHANNELS.RECOVERY_BROWSE_MKV),
  recoveryStart: (config: { mkvPaths: string[]; photoFolderPath?: string; outputDir: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECOVERY_START, config),
  recoveryCancel: () => ipcRenderer.invoke(IPC_CHANNELS.RECOVERY_CANCEL),
  recoveryGetState: () => ipcRenderer.invoke(IPC_CHANNELS.RECOVERY_GET_STATE),

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
