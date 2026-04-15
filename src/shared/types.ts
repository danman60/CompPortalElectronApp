// ============================================================
// CompSync Media — Shared Types (Main + Renderer)
// ============================================================

// --- Chat (Livestream Pinned Comments) ---

export interface ChatMessage { id: string; name: string; text: string; timestamp: number }
export interface PinnedChatMessage { id: string; name: string; text: string; pinnedAt: number }
export interface PinnedChatConfig { enabled: boolean; maxVisible: number; rotateIntervalSec: number; showTimestamps: boolean }

// --- Routine & Schedule ---

export type RoutineStatus =
  | 'pending'
  | 'skipped'
  | 'recording'
  | 'recording_interrupted'
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
  // Media loss prevention (Phase 4)
  uploadRunId?: string // set when an upload attempt starts; passed to /upload-url and /complete
  mediaPackageStatus?: 'none' | 'complete' // populated by server schedule endpoint; drives reconcile pass
  mediaUpdatedAt?: string // ISO — media_packages.updated_at from server, or null
}

export interface EncodedFile {
  role: 'performance' | 'judge1' | 'judge2' | 'judge3' | 'judge4'
  filePath: string
  uploaded: boolean
  uploadUrl?: string
}

export interface ClipSuggestion {
  routineId: string
  similarity: number
}

export interface PhotoMatch {
  filePath: string
  thumbnailPath?: string
  captureTime: string // ISO
  confidence: 'exact' | 'gap' | 'ambiguous' | 'unmatched'
  uploaded: boolean
  matchedRoutineId?: string // routine this photo was matched to
  clipSuggestion?: ClipSuggestion
  clipVerified?: boolean
}

export interface DriveDetectedEvent {
  drivePath: string
  photoPath: string // DCIM path or root
  photoCount: number
  isDcim: boolean
  label: string
}

export interface UploadProgress {
  state: 'queued' | 'uploading' | 'paused' | 'failed' | 'complete'
  percent: number // 0-100
  currentFile?: string
  filesCompleted: number
  filesTotal: number
  error?: string
}

// --- CLIP Verification ---

export interface ClipSortParams {
  sampleRate: number        // default 5
  threshold: number         // default 0.80
  expectedGroups?: number
}

export interface ClipSortTransition {
  index: number
  similarity: number
  confidence: 'high' | 'medium'
  beforePath: string
  afterPath: string
}

export interface ClipSortResult {
  transitions: ClipSortTransition[]
  groups: [number, number][]
  totalPhotos: number
  photoPaths: string[]
  embeddingsComputed: number
}

export interface ExecuteSortParams {
  destDir: string
  startNum: number
  mode: 'copy' | 'move'
}

export interface VerificationResult {
  verified: number
  reassigned: number
  rescued: number
  stillUnmatched: number
  suggestions: Array<{
    filePath: string
    currentRoutineId?: string
    suggestedRoutineId: string
    similarity: number
  }>
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
  memPercent?: number // 0-100 (added commit 3)
  freeBytes?: number
  totalBytes?: number
  timestamp?: number
}

export interface SystemInfo {
  cpuCount: number
}

export interface ObsStats {
  connected: boolean
  streaming: boolean
  recording: boolean
  fps: number
  targetFps: number
  renderSkippedFrames: number
  outputSkippedFrames: number
  congestion: number
  renderSkippedDelta: number
  outputSkippedDelta: number
  timestamp: number
}

// --- Overlay Animation ---

export type OverlayAnimation = 'random' | 'slide' | 'zoom' | 'fade' | 'rise' | 'sparkle' | 'typewriter' | 'bounce' | 'split' | 'blur'

export type AnimationEasing = 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'linear' | 'bounce' | 'elastic'

export interface TickerState {
  visible: boolean
  text: string
  speed: number // px/s, 20-200
  backgroundColor: string
  textColor: string
}

export interface StartingSoonState {
  visible: boolean
  title: string
  subtitle: string
  showCountdown: boolean
  countdownTarget: string // ISO timestamp
  config?: StartingSoonConfig
}

// ── Starting Soon Scene Editor Types ──

export type GradientPreset =
  | 'midnight-pulse' | 'sunset-drift' | 'ocean-wave' | 'aurora'
  | 'ember-glow' | 'monochrome-shift' | 'neon-cyber' | 'forest-mist' | 'custom' | 'brand'

export interface GradientConfig {
  preset: GradientPreset
  customColors?: string[]
  speed: number
  angle: number
}

export interface SSElementPosition {
  x: number; y: number; width: number; height: number; visible: boolean
}

export interface StartingSoonLayout {
  logo: SSElementPosition
  title: SSElementPosition
  subtitle: SSElementPosition
  countdown: SSElementPosition
  timeDate: SSElementPosition
  videoPlaylist: SSElementPosition
  photoSlideshow: SSElementPosition
  ticker: SSElementPosition
  socialBar: SSElementPosition
  sponsorCarousel: SSElementPosition
  visualizer: SSElementPosition
  eventCard: SSElementPosition
  upNext: SSElementPosition
  pinnedChat: SSElementPosition
}

export interface VideoPlaylistConfig {
  enabled: boolean; folderPath: string; fileList: string[]
  loop: boolean; muted: boolean; shuffled: boolean
}

export interface PhotoSlideshowConfig {
  enabled: boolean; folderPath: string; fileList: string[]
  intervalSeconds: number; transitionType: 'crossfade' | 'slide' | 'zoom' | 'none'
  transitionDuration: number
}

export interface SocialHandle {
  platform: 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'twitter' | 'website'
  handle: string
}

export interface SocialBarConfig {
  enabled: boolean; handles: SocialHandle[]
  position: 'bottom' | 'top' | 'left' | 'right'
  style: 'icons-and-text' | 'icons-only' | 'text-only'
}

export interface SponsorCarouselConfig {
  enabled: boolean; folderPath: string; logoFiles: string[]
  intervalSeconds: number; transitionType: 'fade' | 'slide'
}

export interface VisualizerConfig {
  enabled: boolean; barCount: number
  colorStart: string; colorEnd: string
  style: 'bars' | 'wave' | 'circle'
}

export interface TimeDateConfig {
  enabled: boolean; format: '12h' | '24h'
  showDate: boolean; showSeconds: boolean
  fontSize: number; color: string
}

export interface CountdownStyleConfig {
  fontSize: number; color: string; fontWeight: number; showLabels: boolean
}

export interface EventInfoConfig {
  enabled: boolean; showCompetitionName: boolean
  showVenue: boolean; showDate: boolean
  customFields: { label: string; value: string }[]
}

export interface UpNextConfig {
  enabled: boolean
  count: number
  showDancers: boolean
  showStudio: boolean
  showCategory: boolean
}

export interface StartingSoonPreset {
  id: string; name: string; createdAt: string; config: StartingSoonConfig
}

export interface StartingSoonConfig {
  gradient: GradientConfig
  layout: StartingSoonLayout
  title: string; titleFontSize: number; titleColor: string; titleFont: string
  subtitle: string; subtitleFontSize: number; subtitleColor: string; subtitleFont: string
  showCountdown: boolean; countdownTarget: string
  countdownStyle: CountdownStyleConfig
  timeDate: TimeDateConfig
  videoPlaylist: VideoPlaylistConfig
  photoSlideshow: PhotoSlideshowConfig
  socialBar: SocialBarConfig
  sponsorCarousel: SponsorCarouselConfig
  visualizer: VisualizerConfig
  eventInfo: EventInfoConfig
  upNext: UpNextConfig
  pinnedChat: PinnedChatConfig
  tickerEnabled: boolean
}

export interface AnimationConfig {
  animationDuration: number // 0.1-2.0
  animationEasing: AnimationEasing
  autoHideSeconds: number // 0-60, 0 = manual
}

// --- Settings ---

export interface AppSettings {
  obs: {
    url: string
    password: string
    recordingFormat: 'mkv' | 'mp4' | 'flv'
    maxRecordMinutes: number    // 0 = no limit
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
    judgeResolution: 'same' | '720p' | '480p'
    useHardwareEncoding: boolean // NVENC (NVIDIA GPU)
    cpuPriority: 'normal' | 'below-normal' | 'idle'
    threadCount: number // 0 = auto; otherwise injected as -threads N on encode spawn
  }
  upload: {
    bandwidthCapBytesPerSec: number // 0 = unlimited
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
    allowNonElevated: boolean
  }
  nextSequence: {
    stopRecording: boolean
    startRecording: boolean
    fireLowerThird: boolean
    pauseAfterStopMs: number
    pauseBeforeRecordMs: number
    pauseBeforeLowerThirdMs: number
  }
  tether: {
    autoWatchFolder: string
    matchBufferMs: number
  }
  wifiDisplay: {
    monitorIndex: number | null
    bitrate: number
    fps: number
    clientIp: string | null
    videoPort: number
    touchPort: number
    autoStart: boolean
  }
  branding: {
    organizationName: string
    website: string
    instagram: string
    facebook: string
    tiktok: string
    youtube: string
    twitter: string
    brandColors: string[]
    brandFont: string
    brandLogoUrl: string
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
  FFMPEG_PAUSE: 'ffmpeg:pause',
  FFMPEG_RESUME: 'ffmpeg:resume',

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

  // Drive Monitor
  DRIVE_DETECTED: 'drive:detected',
  DRIVE_DISMISS: 'drive:dismiss',

  // CLIP Verification
  CLIP_VERIFY_IMPORT: 'clip:verify-import',
  CLIP_ANALYZE_FOLDER: 'clip:analyze-folder',
  CLIP_EXECUTE_SORT: 'clip:execute-sort',
  CLIP_CANCEL: 'clip:cancel',
  CLIP_PROGRESS: 'clip:progress',
  CLIP_MODEL_PROGRESS: 'clip:model-progress',

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
  OVERLAY_UPDATE_LAYOUT: 'overlay:update-layout',
  OVERLAY_SET_TICKER: 'overlay:set-ticker',
  OVERLAY_SET_STARTING_SOON: 'overlay:set-starting-soon',
  OVERLAY_SET_ANIMATION_CONFIG: 'overlay:set-animation-config',
  OVERLAY_SET_LOGO: 'overlay:set-logo',

  // Recording
  RECORDING_NEXT_FULL: 'recording:next-full',

  // Upload
  UPLOAD_ALL: 'upload:all',
  UPLOAD_CANCEL_ROUTINE: 'upload:cancel-routine',

  // System monitor
  SYSTEM_STATS: 'system:stats',
  SYSTEM_GET_INFO: 'system:get-info',

  // OBS stats
  OBS_STATS: 'obs:stats',

  // Chat push broadcasts (separate from REST chat:* queries)
  CHAT_MESSAGE_NEW: 'chat:message-new',
  CHAT_PINNED_CHANGED: 'chat:pinned-changed',

  // Overlay chat fire (pinning a chat message broadcasts it LT-style)
  OVERLAY_FIRE_CHAT_MESSAGE: 'overlay:fire-chat-message',

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

  // Import
  RECORDING_IMPORT_FILE: 'recording:import-file',
  RECORDING_IMPORT_FOLDER: 'recording:import-folder',

  // Job Queue
  JOB_QUEUE_GET: 'job:queue-get',
  JOB_QUEUE_RETRY: 'job:queue-retry',
  JOB_QUEUE_CANCEL: 'job:queue-cancel',
  JOB_QUEUE_PROGRESS: 'job:queue-progress',

  // Startup
  APP_STARTUP_REPORT: 'app:startup-report',

  // Recovery
  RECOVERY_START: 'recovery:start',
  RECOVERY_BROWSE_MKV: 'recovery:browse-mkv',
  RECOVERY_PROGRESS: 'recovery:progress',
  RECOVERY_CANCEL: 'recovery:cancel',
  RECOVERY_GET_STATE: 'recovery:get-state',

  // Tether (live camera watch)
  TETHER_START: 'tether:start',
  TETHER_START_WPD: 'tether:start-wpd',
  TETHER_STOP: 'tether:stop',
  TETHER_GET_STATE: 'tether:get-state',
  TETHER_LIST_WPD_DEVICES: 'tether:list-wpd-devices',
  TETHER_PROGRESS: 'tether:progress',
  TETHER_WPD_DEVICE_EVENT: 'tether:wpd-device-event',

  // Wifi Display
  WIFI_DISPLAY_GET_MONITORS: 'wifi-display:get-monitors',
  WIFI_DISPLAY_START: 'wifi-display:start',
  WIFI_DISPLAY_STOP: 'wifi-display:stop',
  WIFI_DISPLAY_STATUS: 'wifi-display:status',
  WIFI_DISPLAY_SET_MONITOR: 'wifi-display:set-monitor',

  // Starting Soon Scene Editor
  SS_GET_CONFIG: 'ss:get-config',
  SS_SET_CONFIG: 'ss:set-config',
  SS_BROWSE_FOLDER: 'ss:browse-folder',
  SS_SCAN_FOLDER: 'ss:scan-folder',
  SS_GET_PRESETS: 'ss:get-presets',
  SS_SAVE_PRESET: 'ss:save-preset',
  SS_DELETE_PRESET: 'ss:delete-preset',
  SS_LOAD_PRESET: 'ss:load-preset',

  // Brand Scraper
  BRAND_SCRAPE: 'brand:scrape',

  // Chat (Livestream Pinned Comments)
  CHAT_GET_MESSAGES: 'chat:get-messages',
  CHAT_GET_PINNED: 'chat:get-pinned',
  CHAT_PIN: 'chat:pin',
  CHAT_UNPIN: 'chat:unpin',
  CHAT_CLEAR_PINNED: 'chat:clear-pinned',

  // Event-day hardening alerts
  RECORDING_MAX_WARNING: 'recording:max-warning',
  RECORDING_BLOCKED: 'recording:blocked',
  RECORDING_ALERT: 'recording:alert',
  DEV_BUILD_WARNING: 'app:dev-build-warning',
  DISK_SPACE_ALERT: 'disk:space-alert',
  DRIVE_LOST: 'drive:lost',
  DRIVE_RECOVERED: 'drive:recovered',
  STATE_RECOVERED_FROM_BACKUP: 'state:recovered-from-backup',
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

export interface OverlayChatFireState {
  visible: boolean
  messageId: string | null
  username: string
  message: string
  animation: OverlayAnimation
  autoHideSeconds: number
  firedAt: number
}

export interface OverlayState {
  counter: OverlayCounterState
  clock: OverlayElementState
  logo: OverlayLogoState
  lowerThird: OverlayLowerThirdState
  ticker: TickerState
  startingSoon: StartingSoonState
  chatFire?: OverlayChatFireState
  animConfig: AnimationConfig
}

// --- Job Queue ---

export type JobType = 'encode' | 'upload' | 'photo-import'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface JobRecord {
  id: string
  type: JobType
  routineId: string
  status: JobStatus
  attempts: number
  maxAttempts: number
  payload: Record<string, unknown>
  createdAt: string   // ISO
  updatedAt: string   // ISO
  error?: string
  progress?: number   // 0-100
}

export interface ImportMatch {
  file: string
  routineId: string
  confidence: 'exact' | 'probable' | 'timestamp' | 'unmatched'
}

export interface StartupReport {
  ffmpegAvailable: boolean
  diskFreeGB: number
  diskWarning: boolean
  resumedJobs: number
  orphanedFiles: number
  warnings: string[]
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
  ssConfig?: StartingSoonConfig
  upcomingRoutines?: { entryNumber: string; routineTitle: string; dancers: string; studioName: string; category: string }[]
  pinnedChat?: PinnedChatMessage[]
  branding?: {
    organizationName: string
    website: string
    instagram: string
    facebook: string
    tiktok: string
    youtube: string
    twitter: string
    brandColors: string[]
    brandFont: string
    brandLogoUrl: string
  }
}

export interface WSCommandMessage {
  type: 'command'
  action: 'nextFull' | 'nextRoutine' | 'prev' | 'skip'
    | 'toggleRecord' | 'toggleStream' | 'saveReplay'
    | 'toggleOverlay' | 'loadShareCode'
  element?: 'counter' | 'clock' | 'logo' | 'lowerThird'
  shareCode?: string
}

export interface WSIdentifyMessage {
  type: 'identify'
  client: 'overlay' | 'streamdeck' | 'tablet'
}

export type WSMessage = WSStateMessage | WSCommandMessage | WSIdentifyMessage

// --- Visual Overlay Editor ---

export interface ElementPosition {
  x: number  // % from left
  y: number  // % from top
  width?: number
  height?: number
}

export interface OverlayLayout {
  counter: ElementPosition
  clock: ElementPosition
  logo: ElementPosition
  lowerThird: ElementPosition
}

// Default positions matching the hardcoded overlay.ts values
// Canvas is 1920x1080. counter/clock: right:40px = (1920-40)/1920 ≈ 97.9% left edge minus element width
export const DEFAULT_LAYOUT: OverlayLayout = {
  counter: { x: 85, y: 1.6, width: 13, height: 9 },
  clock: { x: 85, y: 12, width: 13, height: 5 },
  logo: { x: 2, y: 2.8, width: 10, height: 8 },
  lowerThird: { x: 2, y: 82, width: 35, height: 14 },
}

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  obs: {
    url: 'ws://localhost:4455',
    password: '',
    recordingFormat: 'mkv',
    maxRecordMinutes: 15,
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
    judgeResolution: 'same',
    useHardwareEncoding: false,
    cpuPriority: 'below-normal',
    threadCount: 0,
  },
  upload: {
    bandwidthCapBytesPerSec: 0,
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
    allowNonElevated: false,
  },
  nextSequence: {
    stopRecording: true,
    startRecording: true,
    fireLowerThird: true,
    pauseAfterStopMs: 2000,
    pauseBeforeRecordMs: 2000,
    pauseBeforeLowerThirdMs: 2000,
  },
  tether: {
    autoWatchFolder: '',
    matchBufferMs: 1000,
  },
  wifiDisplay: {
    monitorIndex: null,
    bitrate: 3000,
    fps: 30,
    clientIp: null,
    videoPort: 5000,
    touchPort: 5001,
    autoStart: false,
  },
  branding: {
    organizationName: '',
    website: '',
    instagram: '',
    facebook: '',
    tiktok: '',
    youtube: '',
    twitter: '',
    brandColors: [],
    brandFont: '',
    brandLogoUrl: '',
  },
}

// --- Audio Transcription ---

export interface TranscriptSegment {
  start: number       // seconds from audio start
  end: number
  text: string
  confidence?: number
}

export interface RoutineBoundary {
  index: number
  name: string
  routineId?: string           // matched CompSync routine ID
  sourceFileIndex?: number     // index into mkvPaths[] for multi-file recovery
  timestampStart: string       // ISO
  timestampEnd: string
  videoOffsetStartSec: number
  videoOffsetEndSec: number
  description: string
  confidence: number           // 0-1
}

// --- Post-Event Recovery ---

// --- Tether (Live Camera Watch) ---

export interface WPDDevice {
  id: string
  name: string
  manufacturer?: string
}

export interface WPDDeviceEvent {
  event: 'device-connected' | 'device-disconnected'
  device: WPDDevice
}

export interface TetherState {
  active: boolean
  watchPath: string | null
  source: 'folder-watch' | 'wpd-mtp'
  sourceLabel?: string
  deviceId?: string | null
  deviceName?: string | null
  stagingDir?: string | null
  photosReceived: number
  lastPhotoTime: string | null
  cameraClockOffset: number
  clockSyncStatus: 'unknown' | 'ok' | 'warning' | 'error'
}

export interface RecoveryState {
  active: boolean
  phase: 'idle' | 'extracting-audio' | 'transcribing' | 'parsing' | 'splitting' | 'photos' | 'complete' | 'error'
  percent: number
  detail: string
  boundaries?: RoutineBoundary[]
  mkvPaths?: string[]
  error?: string
  currentRoutine?: string
  routinesFound?: number
  routinesTotal?: number
}

// --- Wifi Display ---

export interface WifiDisplayState {
  running: boolean
  monitorIndex: number | null
}

export interface MonitorInfo {
  id: number
  label: string
  width: number
  height: number
  x: number
  y: number
}
