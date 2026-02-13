// ============================================================
// CompSync Media — Shared Types (Main + Renderer)
// ============================================================

// --- Routine & Schedule ---

export type RoutineStatus =
  | 'pending'
  | 'skipped'
  | 'recording'
  | 'recorded'
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
  position: number
  status: RoutineStatus
  recordingStartedAt?: string // ISO timestamp
  recordingStoppedAt?: string // ISO timestamp
  outputPath?: string // path to renamed MKV
  encodedFiles?: EncodedFile[]
  photos?: PhotoMatch[]
  uploadProgress?: UploadProgress
  error?: string
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

// --- Settings ---

export interface AppSettings {
  obs: {
    url: string
    password: string
    recordingFormat: 'mkv' | 'mp4' | 'flv'
  }
  compsync: {
    tenant: string
    pluginApiKey: string
    competition: string
    uploadEndpoint: string
  }
  competition: {
    judgeCount: number // 1-4
    dataSource: 'csv' | 'api'
    csvFilePath: string
    dayFilter: string
    apiRefreshInterval: 'manual' | '5m' | '15m'
  }
  audioTrackMapping: Record<string, string> // "track1" -> "performance" | "judge1" etc
  audioInputMapping: Record<string, string> // "performance" -> "Desktop Audio" etc
  fileNaming: {
    pattern: string
    outputDirectory: string
  }
  ffmpeg: {
    path: string // "(bundled)" or custom path
    processingMode: 'copy' | '720p' | '1080p'
  }
  hotkeys: {
    toggleRecording: string
    nextRoutine: string
    fireLowerThird: string
    saveReplay: string
  }
  lowerThird: {
    mode: 'http' | 'broadcast'
    autoHideSeconds: number // 0 = never
    overlayUrl: string
  }
  behavior: {
    autoRecordOnNext: boolean
    autoUploadAfterEncoding: boolean
    autoEncodeRecordings: boolean
    syncLowerThird: boolean
    confirmBeforeOverwrite: boolean
    alwaysOnTop: boolean
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
  SCHEDULE_GET: 'schedule:get',
  SCHEDULE_BROWSE_FILE: 'schedule:browse-file',

  // State
  STATE_GET: 'state:get',
  STATE_UPDATE: 'state:update',
  STATE_ROUTINE_UPDATE: 'state:routine-update',

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

  // App
  APP_TOGGLE_ALWAYS_ON_TOP: 'app:toggle-always-on-top',
  APP_GET_VERSION: 'app:get-version',
  APP_OPEN_PATH: 'app:open-path',
  APP_CRASH_RECOVERY: 'app:crash-recovery',
  APP_COPY_DIAGNOSTICS: 'app:copy-diagnostics',
  APP_RENDERER_LOG: 'app:renderer-log',
  APP_TOGGLE_DEVTOOLS: 'app:toggle-devtools',
} as const

// --- FFmpeg ---

export interface FFmpegJob {
  routineId: string
  inputPath: string
  outputDir: string
  judgeCount: number
  trackMapping: Record<string, string>
  processingMode: 'copy' | '720p' | '1080p'
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
  visible: boolean
}

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  obs: {
    url: 'ws://localhost:4455',
    password: '',
    recordingFormat: 'mkv',
  },
  compsync: {
    tenant: '',
    pluginApiKey: '',
    competition: '',
    uploadEndpoint: '',
  },
  competition: {
    judgeCount: 3,
    dataSource: 'csv',
    csvFilePath: '',
    dayFilter: '',
    apiRefreshInterval: 'manual',
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
  },
  fileNaming: {
    pattern: '{entry_number}_{routine_title}_{studio_code}',
    outputDirectory: '',
  },
  ffmpeg: {
    path: '(bundled)',
    processingMode: 'copy',
  },
  hotkeys: {
    toggleRecording: 'F5',
    nextRoutine: 'F6',
    fireLowerThird: 'F9',
    saveReplay: 'F10',
  },
  lowerThird: {
    mode: 'http',
    autoHideSeconds: 8,
    overlayUrl: 'http://localhost:9876/overlay',
  },
  behavior: {
    autoRecordOnNext: true,
    autoUploadAfterEncoding: true,
    autoEncodeRecordings: true,
    syncLowerThird: true,
    confirmBeforeOverwrite: true,
    alwaysOnTop: false,
  },
}
