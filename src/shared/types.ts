// ============================================================
// CompSync Media — Shared Types (Main + Renderer)
// ============================================================

// --- Routine & Schedule ---

export type RoutineStatus =
  | 'pending'
  | 'skipped'
  | 'recording'
  | 'recorded'
  | 'queued'
  | 'encoding'
  | 'encoded'
  | 'uploading'
  | 'uploaded'
  | 'confirmed'
  | 'failed'

export interface Routine {
  id: string // entry_id UUID from CSV/API
  entryNumber: string
  routineTitle: string
  dancers: string
  studioName: string
  studioCode: string
  category: string
  classification: string
  ageGroup: string
  sizeCategory: string
  durationMinutes: number
  scheduledDay: string
  scheduledTime?: string // e.g. "14:30" from schedule — for logging/offset calculation
  position: number
  status: RoutineStatus
  recordingStartedAt?: string // ISO timestamp
  recordingStoppedAt?: string // ISO timestamp
  outputPath?: string // path to renamed MKV
  outputDir?: string // routine folder path
  encodedFiles?: EncodedFile[]
  photos?: PhotoMatch[]
  uploadProgress?: UploadProgress
  error?: string
  notes?: string // operator notes (e.g. "wrong music", "re-do requested")
}

export interface EncodedFile {
  role: 'performance' | 'judge1' | 'judge2' | 'judge3' | 'judge4'
  filePath: string
  uploaded: boolean
  uploadUrl?: string
}

export interface PhotoMatch {
  filePath: string
  thumbnailPath?: string
  captureTime: string // ISO
  confidence: 'exact' | 'gap' | 'ambiguous' | 'unmatched'
  uploaded: boolean
}

export interface UploadProgress {
  state: 'queued' | 'uploading' | 'paused' | 'failed' | 'complete'
  percent: number // 0-100
  currentFile?: string
  filesCompleted: number
  filesTotal: number
  error?: string
}

// --- Competition ---

export interface Competition {
  tenantId: string
  competitionId: string
  name: string
  routines: Routine[]
  days: string[]
  source: 'csv' | 'api'
  loadedAt: string // ISO
}

// --- OBS ---

export type OBSConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface OBSState {
  connectionStatus: OBSConnectionStatus
  isRecording: boolean
  isStreaming: boolean
  isReplayBufferActive: boolean
  recordTimeSec: number
  currentOutputPath?: string
}

export interface AudioLevel {
  inputName: string
  levels: number[] // linear 0.0-1.0 per channel
}

export interface AudioMeterData {
  performance: number // dB
  judges: number[] // dB per judge
}

// --- System Monitor ---

export interface SystemStats {
  cpuPercent: number // 0-100
  diskFreeGB: number // GB free on output drive
  diskTotalGB: number
}

// --- Overlay Animation ---

export type OverlayAnimation = 'random' | 'slide' | 'zoom' | 'fade' | 'rise' | 'sparkle'

// --- Settings ---

export interface AppSettings {
  obs: {
    url: string
    password: string
    recordingFormat: 'mkv' | 'mp4' | 'flv'
  }
  compsync: {
    shareCode: string // replaces tenant/apiKey/competition/uploadEndpoint
  }
  competition: {
    judgeCount: number // 1-4
    dayFilter: string
  }
  audioTrackMapping: Record<string, string> // "track1" -> "performance" | "judge1" etc
  audioInputMapping: Record<string, string> // "performance" -> "Desktop Audio" etc
  fileNaming: {
    pattern: string
    outputDirectory: string
  }
  ffmpeg: {
    path: string // "(bundled)" or custom path
    processingMode: 'copy' | 'smart' | '720p' | '1080p'
    cpuPriority: 'normal' | 'below-normal' | 'idle'
  }
  hotkeys: {
    toggleRecording: string
    nextRoutine: string
    fireLowerThird: string
    saveReplay: string
  }
  overlay: {
    autoHideSeconds: number
    overlayUrl: string
    logoUrl: string
    defaultCounter: boolean
    defaultClock: boolean
    defaultLogo: boolean
    animation: OverlayAnimation
    showEntryNumber: boolean
    showRoutineTitle: boolean
    showDancers: boolean
    showStudioName: boolean
    showCategory: boolean
  }
  behavior: {
    autoRecordOnNext: boolean
    autoUploadAfterEncoding: boolean
    autoEncodeRecordings: boolean
    syncLowerThird: boolean
    confirmBeforeOverwrite: boolean
    alwaysOnTop: boolean
    zoomFactor: number
    compactMode: boolean
  }
}

// --- IPC Channels ---

export const IPC_CHANNELS = {
  // OBS
  OBS_CONNECT: 'obs:connect',
  OBS_DISCONNECT: 'obs:disconnect',
  OBS_STATE: 'obs:state',
  OBS_START_RECORD: 'obs:start-record',
  OBS_STOP_RECORD: 'obs:stop-record',
  OBS_START_STREAM: 'obs:start-stream',
  OBS_STOP_STREAM: 'obs:stop-stream',
  OBS_SAVE_REPLAY: 'obs:save-replay',
  OBS_AUDIO_LEVELS: 'obs:audio-levels',
  OBS_INPUT_LIST: 'obs:input-list',

  // Recording pipeline
  RECORDING_NEXT: 'recording:next',
  RECORDING_PREV: 'recording:prev',
  RECORDING_SKIP: 'recording:skip',
  RECORDING_UNSKIP: 'recording:unskip',

  // FFmpeg
  FFMPEG_ENCODE: 'ffmpeg:encode',
  FFMPEG_ENCODE_ALL: 'ffmpeg:encode-all',
  FFMPEG_PROGRESS: 'ffmpeg:progress',

  // Schedule
  SCHEDULE_LOAD_CSV: 'schedule:load-csv',
  SCHEDULE_LOAD_API: 'schedule:load-api',
  SCHEDULE_LOAD_SHARE_CODE: 'schedule:load-share-code',
  SCHEDULE_GET: 'schedule:get',
  SCHEDULE_BROWSE_FILE: 'schedule:browse-file',

  // State
  STATE_GET: 'state:get',
  STATE_UPDATE: 'state:update',
  STATE_ROUTINE_UPDATE: 'state:routine-update',
  STATE_JUMP_TO: 'state:jump-to',
  STATE_SET_NOTE: 'state:set-note',
  STATE_EXPORT_REPORT: 'state:export-report',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_BROWSE_DIR: 'settings:browse-dir',
  SETTINGS_BROWSE_FILE: 'settings:browse-file',

  // Upload
  UPLOAD_START: 'upload:start',
  UPLOAD_STOP: 'upload:stop',
  UPLOAD_PROGRESS: 'upload:progress',
  UPLOAD_ROUTINE: 'upload:routine',

  // Photos
  PHOTOS_IMPORT: 'photos:import',
  PHOTOS_BROWSE: 'photos:browse',
  PHOTOS_PROGRESS: 'photos:progress',
  PHOTOS_MATCH_RESULT: 'photos:match-result',

  // Lower Third
  LT_FIRE: 'lt:fire',
  LT_HIDE: 'lt:hide',
  LT_AUTO_FIRE_TOGGLE: 'lt:auto-fire-toggle',
  LT_AUTO_FIRE_STATE: 'lt:auto-fire-state',

  // Overlay
  OVERLAY_TOGGLE: 'overlay:toggle',
  OVERLAY_FIRE_LT: 'overlay:fire-lt',
  OVERLAY_HIDE_LT: 'overlay:hide-lt',
  OVERLAY_GET_STATE: 'overlay:get-state',
  OVERLAY_AUTO_FIRE_TOGGLE: 'overlay:auto-fire-toggle',

  // Recording
  RECORDING_NEXT_FULL: 'recording:next-full',

  // Upload
  UPLOAD_ALL: 'upload:all',

  // System monitor
  SYSTEM_STATS: 'system:stats',

  // App
  APP_TOGGLE_ALWAYS_ON_TOP: 'app:toggle-always-on-top',
  APP_GET_VERSION: 'app:get-version',
  APP_OPEN_PATH: 'app:open-path',
  APP_CRASH_RECOVERY: 'app:crash-recovery',
  APP_COPY_DIAGNOSTICS: 'app:copy-diagnostics',
  APP_RENDERER_LOG: 'app:renderer-log',
  APP_TOGGLE_DEVTOOLS: 'app:toggle-devtools',
  APP_SET_ZOOM: 'app:set-zoom',
  APP_GET_ZOOM: 'app:get-zoom',

  // Preview
  PREVIEW_START: 'preview:start',
  PREVIEW_STOP: 'preview:stop',
  PREVIEW_FRAME: 'preview:frame',
} as const

// --- FFmpeg ---

export interface FFmpegJob {
  routineId: string
  inputPath: string
  outputDir: string
  judgeCount: number
  trackMapping: Record<string, string>
  processingMode: 'copy' | 'smart' | '720p' | '1080p'
  filePrefix: string
}

export interface FFmpegProgress {
  routineId: string
  state: 'queued' | 'encoding' | 'done' | 'error'
  tracksCompleted: number
  tracksTotal: number
  error?: string
}

// --- Lower Third ---

export interface LowerThirdData {
  entryNumber: string
  routineName: string
  dancers: string[]
  studioName: string
  category: string
  logoUrl: string
  visible: boolean
}

// --- Overlay ---

export interface OverlayElementState {
  visible: boolean
}

export interface OverlayCounterState extends OverlayElementState {
  current: number
  total: number
  entryNumber: string
}

export interface OverlayLogoState extends OverlayElementState {
  url: string
}

export interface OverlayLowerThirdState extends OverlayElementState {
  entryNumber: string
  routineTitle: string
  dancers: string
  studioName: string
  category: string
  autoHideSeconds: number
  animation: OverlayAnimation
  showEntryNumber: boolean
  showRoutineTitle: boolean
  showDancers: boolean
  showStudioName: boolean
  showCategory: boolean
}

export interface OverlayState {
  counter: OverlayCounterState
  clock: OverlayElementState
  logo: OverlayLogoState
  lowerThird: OverlayLowerThirdState
}

// --- WebSocket Hub ---

export interface WSStateMessage {
  type: 'state'
  routine: {
    entryNumber: string
    routineTitle: string
    dancers: string
    studioName: string
    category: string
  } | null
  nextRoutine: {
    entryNumber: string
    routineTitle: string
  } | null
  index: number
  total: number
  recording: { active: boolean; elapsed: number }
  streaming: boolean
  skippedCount: number
  overlay: OverlayState
}

export interface WSCommandMessage {
  type: 'command'
  action: 'nextFull' | 'nextRoutine' | 'prev' | 'skip'
    | 'toggleRecord' | 'toggleStream' | 'saveReplay'
    | 'toggleOverlay'
  element?: 'counter' | 'clock' | 'logo' | 'lowerThird'
}

export interface WSIdentifyMessage {
  type: 'identify'
  client: 'overlay' | 'streamdeck'
}

export type WSMessage = WSStateMessage | WSCommandMessage | WSIdentifyMessage

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  obs: {
    url: 'ws://localhost:4455',
    password: '',
    recordingFormat: 'mkv',
  },
  compsync: {
    shareCode: '',
  },
  competition: {
    judgeCount: 3,
    dayFilter: '',
  },
  audioTrackMapping: {
    track1: 'performance',
    track2: 'judge1',
    track3: 'judge2',
    track4: 'judge3',
  },
  audioInputMapping: {
    performance: '',
    judge1: '',
    judge2: '',
    judge3: '',
    judge4: '',
  },
  fileNaming: {
    pattern: '{entry_number}_{routine_title}_{studio_code}',
    outputDirectory: '',
  },
  ffmpeg: {
    path: '(bundled)',
    processingMode: 'smart',
    cpuPriority: 'below-normal',
  },
  hotkeys: {
    toggleRecording: 'F5',
    nextRoutine: 'F6',
    fireLowerThird: 'F9',
    saveReplay: 'F10',
  },
  overlay: {
    autoHideSeconds: 8,
    overlayUrl: 'http://localhost:9876/overlay',
    logoUrl: '',
    defaultCounter: true,
    defaultClock: false,
    defaultLogo: true,
    animation: 'random',
    showEntryNumber: true,
    showRoutineTitle: true,
    showDancers: true,
    showStudioName: true,
    showCategory: true,
  },
  behavior: {
    autoRecordOnNext: true,
    autoUploadAfterEncoding: true,
    autoEncodeRecordings: true,
    syncLowerThird: true,
    confirmBeforeOverwrite: true,
    alwaysOnTop: false,
    zoomFactor: 1.25,
    compactMode: false,
  },
}
