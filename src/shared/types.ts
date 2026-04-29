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
  | 'scratched'
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
  keyframes?: string[]    // local paths to 3 WebP keyframes — videos/keyframes/
  photos?: PhotoMatch[]
  uploadProgress?: UploadProgress
  error?: string
  notes?: string // operator notes (e.g. "wrong music", "re-do requested")
  // Media loss prevention (Phase 4)
  uploadRunId?: string // set when an upload attempt starts; passed to /upload-url and /complete
  // Populated by CompPortal's plugin schedule endpoint. Current Electron
  // reconcile logic only treats 'none' as authoritative for demotion; any
  // other value means "a server package exists".
  mediaPackageStatus?:
    | 'none'
    | 'pending'
    | 'processing'
    | 'ready'
    | 'complete'
    | 'published'
  mediaUpdatedAt?: string // ISO — media_packages.updated_at from server, or null
  // Late-insert / ad-hoc routine (UDC Toronto 2026-04-25 operator request).
  // Set when this row was created by START EMPTY ROUTINE rather than from
  // the schedule CSV/API. Used to flag rows for post-show editing (operator
  // fills in title/dancer/category) and for clear filename identification
  // in the recording output dir.
  lateInsert?: boolean
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
  storagePath?: string
  thumbnailStoragePath?: string // R2 key of uploaded 200×200 WebP thumb (sibling of storagePath)
  sourceHash?: string // sha1 of first 128KB of the source file — used for dedup + safe-delete gating
  sourcePath?: string // original SD path before copy
}

export interface DriveDetectedEvent {
  drivePath: string
  photoPath: string // DCIM path or root
  photoCount: number
  isDcim: boolean
  label: string
}

/**
 * Emitted from main → renderer when a newly-inserted SD card has photos whose
 * EXIF DateTimeOriginal dates don't match today. Triggers the wrong-day modal.
 *
 * `sampledDates` holds the (normalized YYYY-MM-DD) dates we saw across the 5
 * sample photos — repeated dates collapse. `daysOffMax` is the largest absolute
 * delta between today (local) and any sampled date. `dominantDate` is the most
 * common sampled date (ties broken by "furthest from today"), used for the
 * "Camera clock is N days off" phrasing.
 */
export interface CameraClockMismatchEvent {
  drivePath: string
  photoPath: string
  label: string
  sampledDates: string[] // unique ISO dates (YYYY-MM-DD) sorted descending
  dominantDate: string // YYYY-MM-DD
  todayDate: string // YYYY-MM-DD (local)
  daysOffMax: number
  sampleCount: number // how many photos were actually sampled (0-5)
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
  // Operator-manual ordering of routine IDs. When present, the routine table
  // renders in this order and NEXT advances along this order. Persists across
  // schedule re-imports (item 5, 2026-04-25): IDs no longer in `routines`
  // drop out automatically; new IDs append in schedule order.
  displayOrder?: string[]
  // Item 17: 999-decrement overflow counter for takes saved without an
  // explicit slot assignment. Decrements per use (999, 998, 997, ...).
  // Persists across app restarts within a competition.
  nextOverflowNumber?: number
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
  expiredText?: string // shown when countdown hits zero (default: "SOON")
  prefixText?: string  // optional prefix above/before the timer (e.g. "Doors open in")
}

export type LogoAnimation = 'none' | 'pulse' | 'float' | 'spin' | 'fade-in-once' | 'breathing' | 'glow'

export interface LogoConfig {
  source: 'brand' | 'custom' // brand = use settings.branding.brandLogoUrl
  customUrl: string          // file path when source === 'custom'
  fit: 'contain' | 'cover' | 'fill'
  opacity: number            // 0..1
  animation: LogoAnimation
  animationSpeed: number     // 1..10 → keyframe duration scaler
}

export interface SSTickerConfig {
  enabled: boolean
  text: string
  speed: number      // px/s scrolling speed (20-200, like main overlay)
  color: string
  bgColor: string    // optional rail background color (e.g. rgba)
  fontSize: number
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
  logo: LogoConfig
  ticker: SSTickerConfig
  videoPlaylist: VideoPlaylistConfig
  photoSlideshow: PhotoSlideshowConfig
  socialBar: SocialBarConfig
  sponsorCarousel: SponsorCarouselConfig
  visualizer: VisualizerConfig
  eventInfo: EventInfoConfig
  upNext: UpNextConfig
  pinnedChat: PinnedChatConfig
  tickerEnabled: boolean // legacy — kept for backward compat with old saved configs
}

export interface AnimationConfig {
  animationDuration: number // 0.1-2.0
  animationEasing: AnimationEasing
  autoHideSeconds: number // 0-60, 0 = manual
}

// --- /plugin/complete contract (CompPortal) ---
// This is the payload shape POSTed by the Electron app to
// `/api/plugin/complete` when an upload run finishes for a routine. Both
// CSE and CompPortal must agree on these field names; contract test
// (tests/contract-plugin-complete.spec.ts) round-trips a canned payload
// against a live preview deployment to detect drift.
export interface PluginCompletePayload {
  entryId: string
  competitionId: string
  uploadRunId: string
  video_start_timestamp?: string // ISO
  video_end_timestamp?: string // ISO
  files: {
    performance?: string
    judge1?: string
    judge2?: string
    judge3?: string
    judge4?: string
    // Parallel arrays — all indexed identically when present.
    photos?: string[]
    photo_thumbnails?: string[]
    photo_captured_at?: string[] // CompPortal 2026-04-18 field
    // capture_times is an older alias kept for back-compat (CompPortal c542a945);
    // the contract test should verify both forms land in media_photos.captured_at.
    capture_times?: string[]
    video_keyframes?: string[] // 3 elements: [20%, 50%, 80%]
  }
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
    strategy: 'routine-batch' | 'round-robin' // default 'round-robin' — interleave photos across routines for slideshow breadth
    photoPriority: 'newest-first' | 'oldest-first' // default 'newest-first' — controls which pending photo upload gets picked next
    incrementalPublish: boolean // default true — fire plugin/complete progressively during an upload
    incrementalPublishEvery: number // default 20 — fire every N photos per routine
    autoResumeOnBoot?: boolean // default true — on app boot after share-code resolve, DB cross-check + enqueue only truly-missing photos
    // T-V7-26 — Unified reconciler ambient timer. 0 = disabled. Min 2, max 1440.
    // Fires reconcileMedia({scope:'ambient'}) every N minutes while the share
    // code is resolved. Self-heals state ↔ DB drift without operator clicks.
    reconcileCadenceMinutes?: number
    reconcileSilent?: boolean // default true — ambient ticks log only, no toast
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
    autoImportOnDrive: boolean
    // Phase 1.4 / 1.6: optimistic offline-first sync. On boot, hit
    // /api/plugin/comp-fingerprint on CompPortal. If hash differs from the
    // last-known local hash, defer queue resume + show "Server state changed"
    // banner. Default off until CompPortal endpoint lands.
    compStateDriftCheck: boolean
    // Phase 2.1 (2026-04-29): default-on per-photo strict-today filter.
    // Photos whose EXIF date is not today get silently skipped on every
    // import path (auto + manual). Operator can opt-in to include prior-day
    // photos via this toggle (e.g. for forensic recovery). Default false
    // (= always skip) which matches the operator's stated workflow.
    includePriorDayPhotos: boolean
  }
  nextSequence: {
    stopRecording: boolean
    startRecording: boolean
    fireLowerThird: boolean
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
  // Performance / worker-thread opt-in flags. Default OFF so the hot path
  // keeps running inline until shadow-mode logs confirm parity. Flip via
  // Settings → Performance after a few hours of clean shadow telemetry.
  performance: {
    useExifWorker: boolean    // D1: route EXIF reads through worker_threads pool
    useMatcherWorker: boolean // D2: route detectClockOffset + window assignment through worker
  }
  // A53 / A55: per-routine audio verification toggles + thresholds. Run
  // post-encode against the 4 muxed MP4s (perf + 3 judges). All checks
  // default ON. Each can be disabled independently.
  audioAudit: {
    identityCheckEnabled: boolean       // A53: SHA-256 audio streams, flag any pair match
    silenceCheckEnabled: boolean        // A55: silencedetect filter
    silenceNoiseFloorDb: number         // dB; default -50
    silenceMinDurationSec: number       // sec; default 10
    loudnessCheckEnabled: boolean       // A55: mean RMS via volumedetect
    loudnessFloorDb: number             // dB; default -40
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
  OBS_AUDIO_FLAT_CHANNEL: 'obs:audio-flat-channel',
  OBS_TRANSITION_LIST: 'obs:transition-list',
  OBS_TRANSITION_GET_CURRENT: 'obs:transition-get-current',
  OBS_TRANSITION_SET_CURRENT: 'obs:transition-set-current',
  OBS_TRANSITION_CHANGED: 'obs:transition-changed',

  // Recording pipeline
  RECORDING_NEXT: 'recording:next',
  RECORDING_PREV: 'recording:prev',
  RECORDING_SKIP: 'recording:skip',
  RECORDING_UNSKIP: 'recording:unskip',
  RECORDING_SCRATCH: 'recording:scratch',
  RECORDING_UNSCRATCH: 'recording:unscratch',
  RECORDING_REREC_SUSPECTED: 'recording:rerec-suspected',
  RECORDING_REREC_DECISION_REQUESTED: 'recording:rerec-decision-requested',
  RECORDING_REREC_DECISION: 'recording:rerec-decision',

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
  STATE_EXPORT_VERIFICATION_REPORT: 'state:export-verification-report',
  STATE_LIST_CAMERA_OFFSETS: 'state:list-camera-offsets',
  STATE_CLEAR_CAMERA_OFFSETS: 'state:clear-camera-offsets',
  STATE_SET_DISPLAY_ORDER: 'state:set-display-order',

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
  UPLOAD_RESUME_UNFINISHED: 'upload:resume-unfinished',
  UPLOAD_COUNT_UNFINISHED: 'upload:count-unfinished',
  MEDIA_RECONCILE_RUN: 'media:reconcile-run',
  MEDIA_RECONCILE_RESULT: 'media:reconcile-result',

  // Photos
  PHOTOS_IMPORT: 'photos:import',
  PHOTOS_CANCEL: 'photos:cancel',
  PHOTOS_BROWSE: 'photos:browse',
  PHOTOS_PROGRESS: 'photos:progress',
  PHOTOS_MATCH_RESULT: 'photos:match-result',
  PHOTOS_IMPORT_COMPLETE_SUMMARY: 'photos:import:complete:summary',
  PHOTOS_REASSIGN_ORPHAN: 'photos:reassign-orphan',
  PHOTOS_DISCARD_ORPHAN: 'photos:discard-orphan',
  PHOTOS_MARK_SDS_PROCESSED: 'photos:mark-sds-processed',
  PHOTOS_CLEAR_SD_WATERMARKS: 'photos:clear-sd-watermarks',
  PHOTOS_OFFSET_PROPOSAL: 'photos:offset-proposal',
  PHOTOS_OFFSET_DECISION: 'photos:offset-decision',
  PHOTOS_PREVIEW_IMPORT: 'photos:preview-import',
  PHOTOS_PREVIEW_COMPLETE: 'photos:preview-complete',

  // Drive Monitor
  DRIVE_DETECTED: 'drive:detected',
  DRIVE_DISMISS: 'drive:dismiss',
  DRIVE_CAMERA_CLOCK_MISMATCH: 'drive:camera-clock-mismatch',
  DRIVE_MISSING_PHOTOS_DETECTED: 'drive:missing-photos-detected',
  DRIVE_IMPORT_MISSING_ONLY: 'drive:import-missing-only',

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

  // A53 / A55: post-encode audio audit results
  AUDIO_IDENTICAL_TRACKS_DETECTED: 'audio:identical-tracks-detected',
  AUDIO_SILENCE_DETECTED: 'audio:silence-detected',
  AUDIO_LOW_LOUDNESS_DETECTED: 'audio:low-loudness-detected',
  AUDIO_AUDIT_PASS: 'audio:audit-pass',

  // A56: universal pipeline detector (narrow slice — header chip)
  PIPELINE_HEALTH: 'pipeline:health',
  // Phase 1.1: 60-min photo-import stall banner (visual only, dismissible).
  // Fires once per stall episode; bumpActivity('photoImport') re-arms.
  PHOTO_IMPORT_STALL: 'pipeline:photo-import-stall',
  // Phase 1.4/1.6: server-side state drift detected (CompPortal fingerprint
  // changed since last close). Renderer surfaces banner + Refresh action.
  COMP_STATE_DRIFT_DETECTED: 'comp:state-drift-detected',
  COMP_STATE_DRIFT_REFRESH_REQUEST: 'comp:state-drift-refresh-request',
  COMP_STATE_DRIFT_DISMISS: 'comp:state-drift-dismiss',
  COMP_STATE_DRIFT_RESOLVED: 'comp:state-drift-resolved',
  // Phase 2.2: camera body unknown — filename pattern doesn't match any
  // known camera body regex. Watermark filter is inert for that card.
  CAMERA_BODY_UNKNOWN: 'photos:camera-body-unknown',

  // Item 17 / A54: click-to-reassign + active take broadcast
  RECORDING_REASSIGN_TARGET: 'recording:reassign-target',
  RECORDING_ACTIVE_TAKE: 'recording:active-take',
  RECORDING_STALE_TAKE_DETECTED: 'recording:stale-take-detected',

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
  APP_PING: 'app:ping',

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
  JOB_QUEUE_KICK: 'job:queue-kick',
  JOB_QUEUE_AUTO_TOGGLE: 'job:queue-auto-toggle',

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
  SS_BROWSE_FILE: 'ss:browse-file',
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
  CHAT_FIRE_TEST: 'chat:fire-test',
  CHAT_POST_MESSAGE: 'chat:post-message',

  // Late-insert / empty-routine recording (operator-spec 2026-04-25):
  // creates a new ad-hoc routine row right after the current one, marks it
  // recording, and starts an OBS take. Operator fills in title/dancer post-show.
  RECORDING_START_EMPTY: 'recording:start-empty',

  // Event-day hardening alerts
  RECORDING_MAX_WARNING: 'recording:max-warning',
  RECORDING_BLOCKED: 'recording:blocked',
  RECORDING_ALERT: 'recording:alert',
  DEV_BUILD_WARNING: 'app:dev-build-warning',
  DISK_SPACE_ALERT: 'disk:space-alert',
  DRIVE_LOST: 'drive:lost',
  DRIVE_RECOVERED: 'drive:recovered',
  STATE_RECOVERED_FROM_BACKUP: 'state:recovered-from-backup',

  // Media backup (copy recordings + tether photos to external drive)
  BACKUP_BROWSE_TARGET: 'backup:browse-target',
  BACKUP_START: 'backup:start',
  BACKUP_CANCEL: 'backup:cancel',
  BACKUP_PROGRESS: 'backup:progress',
  BACKUP_DONE: 'backup:done',

  // Stream Deck plugin (bundled, optional install)
  STREAMDECK_GET_STATUS: 'streamdeck:get-status',
  STREAMDECK_INSTALL_PLUGIN: 'streamdeck:install-plugin',

  // Overlay Mode (floating always-on-top panels over OBS)
  OVERLAY_MODE_OPEN: 'overlay-mode:open',
  OVERLAY_MODE_CLOSE: 'overlay-mode:close',
  OVERLAY_MODE_TOGGLE: 'overlay-mode:toggle',
  OVERLAY_MODE_HIDE_PANEL: 'overlay-mode:hide-panel',

  // Day checklist modals (start-of-day / end-of-day)
  DAY_CHECKLIST_GET: 'day-checklist:get',
  DAY_CHECKLIST_SET_ITEM: 'day-checklist:set-item',
  DAY_CHECKLIST_DISMISS: 'day-checklist:dismiss',
  DAY_CHECKLIST_REOPEN: 'day-checklist:reopen',
  DAY_CHECKLIST_SHOW: 'day-checklist:show',
} as const

// --- Day Checklist (Start-of-Day / End-of-Day) ---

export type DayChecklistKind = 'start' | 'end'
export type DayChecklistItemState = 'open' | 'checked' | 'skipped' | 'na'

/** Per-kind, per-item state for a specific day key (local YYYY-MM-DD). */
export interface DayChecklistDayState {
  /** local-date YYYY-MM-DD for the day this state applies to */
  date: string
  /** scheduledDay of the routine(s) that triggered this kind on this date (informational) */
  scheduledDay: string | null
  /** item state keyed by item id — missing items default to 'open' */
  items: Record<string, DayChecklistItemState>
  /** true once operator explicitly dismissed the auto-triggered modal for this day+kind */
  autoDismissed: boolean
  /** ms timestamp when modal was auto-fired for this day+kind (0 = never) */
  autoShownAt: number
  /** ms timestamp of last edit to items */
  lastUpdatedAt: number
}

export interface DayChecklistPersistedState {
  /** Map<"date|kind", DayChecklistDayState> */
  days: Record<string, DayChecklistDayState>
}

export interface DayChecklistShowEvent {
  kind: DayChecklistKind
  date: string
  scheduledDay: string | null
  /** 'auto' = main process fired automatically; 'manual' = operator clicked Re-open */
  source: 'auto' | 'manual'
}

export interface BackupProgress {
  phase: 'scanning' | 'copying'
  bytesDone: number
  filesDone: number
  totalBytes: number
  totalFiles: number
  currentFile: string
  bytesPerSec: number
  etaSec: number
}

export interface BackupFailure {
  path: string
  error: string
}

export interface BackupResult {
  targetDir: string
  succeeded: number
  skipped: number
  failed: BackupFailure[]
  totalBytes: number
  elapsedSec: number
  cancelled: boolean
}

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
  // HH:MM string of the next break / awards timeslot, computed from the
  // schedule (gap >= 15 min between consecutive routines). Falls back to
  // end-of-last-routine for the last session of the day. null = hide label.
  nextAwardsTime?: string | null
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

export type JobType = 'encode' | 'upload' | 'photo-import' | 'scratch-notify'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'quarantined'

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
  quarantinedJobs?: number
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
  transitions?: { current: string | null; list: string[] }
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
    | 'toggleRecord' | 'startRecord' | 'stopRecord'
    | 'toggleStream' | 'saveReplay'
    | 'pauseUploads' | 'resumeUploads' | 'reconcileMedia' | 'nudgeRoutine'
    | 'pinChatMessage' | 'unpinChatMessage'
    | 'setCameraOffset' | 'clearCameraOffsets'
    | 'toggleOverlay' | 'loadShareCode'
    | 'cycleTransition' | 'kickQueue'
  element?: 'counter' | 'clock' | 'logo' | 'lowerThird' | 'startingSoon'
  shareCode?: string
  routineId?: string
  chatMessageId?: string
  cameraBody?: string
  offsetMs?: number
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
    strategy: 'round-robin',
    photoPriority: 'newest-first',
    // Retained for settings-shape backcompat; upload.ts no longer gates on these
    // values (452a6de8 regression removed 2026-04-24).
    incrementalPublish: true,
    incrementalPublishEvery: 1,
    autoResumeOnBoot: true,
    reconcileCadenceMinutes: 15,
    reconcileSilent: true,
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
    autoImportOnDrive: true,
    compStateDriftCheck: false,
    includePriorDayPhotos: false,
  },
  nextSequence: {
    stopRecording: true,
    startRecording: true,
    fireLowerThird: true,
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
    // Operator-spec 2026-04-25: tablet should be on by default. Auto-start
    // when a monitor is configured. (If `monitorIndex` is null, autoStart
    // is a no-op — see main/index.ts.)
    autoStart: true,
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
  performance: {
    // D1/D2 worker-thread cutover — default OFF. Shadow-mode still runs the
    // worker alongside the inline path to log divergences even when these
    // are false. Flip to true after shadow logs show 0 divergences.
    useExifWorker: false,
    useMatcherWorker: false,
  },
  audioAudit: {
    identityCheckEnabled: true,
    silenceCheckEnabled: true,
    silenceNoiseFloorDb: -50,
    silenceMinDurationSec: 10,
    loudnessCheckEnabled: true,
    loudnessFloorDb: -40,
  },
}

// --- Audio Audit (A53 / A55) ---

export interface AudioIdenticalTracksEvent {
  routineId: string
  entryNumber: string
  /** Pairs of role names whose audio streams hash to the same value. */
  matchedPairs: Array<[string, string]>
  /** Hash → list of roles producing it (for debug/log purposes). */
  byHash: Record<string, string[]>
}

export interface AudioSilenceDetectedEvent {
  routineId: string
  entryNumber: string
  role: string
  silentFraction: number   // 0..1 of total duration flagged silent
  noiseFloorDb: number
  minDurationSec: number
}

export interface AudioLowLoudnessEvent {
  routineId: string
  entryNumber: string
  role: string
  meanRmsDb: number
  thresholdDb: number
}

export interface AudioAuditPassEvent {
  routineId: string
  entryNumber: string
  trackCount: number
}

// --- Take-immutable + click-to-reassign (Item 17 / A54) ---

/**
 * A "take" is a single uninterrupted OBS recording session — from RECORD press
 * to STOP press. It exists independently of routine slots: an operator can
 * start a recording without a target routine, or reassign mid-flow via
 * click-to-reassign / SAVE AS EMPTY ROUTINE. The active take is persisted to
 * `_active_take.json` so a crash mid-record still reveals what was being
 * recorded for which target.
 */
export interface ActiveTake {
  takeId: string                          // uuid
  startedAt: string                       // ISO timestamp from OBS RecordingStarted
  currentTargetRoutineId: string | null   // updated on click-to-reassign / SAVE AS EMPTY
  /** Optional descriptor for empty-routine flows: "226.5", "355", etc. */
  emptyRoutineNumber?: string
}

export interface RecordingReassignTargetPayload {
  /** Existing routineId, or null to indicate "save as 999-decrement overflow." */
  routineId: string | null
  /** Optional explicit entry number (e.g., "226.5"); when provided, may create a new lateInsert row. */
  emptyRoutineNumber?: string
}

// --- Pipeline Health (A56) ---

export type PipelineStageId = 'recording' | 'photoImport' | 'photoUpload' | 'videoUpload'

export interface PipelineStageState {
  id: PipelineStageId
  /** Last activity timestamp in ms-since-epoch. 0 means never activated this session. */
  lastActivityMs: number
  /** Pending work count (jobs queued, photos not yet matched, etc.) */
  pendingCount: number
  /** Health classification computed by the evaluator. */
  health: 'green' | 'yellow' | 'red' | 'unknown'
  /** Optional human-readable reason for the current health (e.g. "no upload activity for 12m"). */
  reason?: string
}

export interface PipelineHealthSnapshot {
  worst: 'green' | 'yellow' | 'red' | 'unknown'
  evaluatedAtMs: number
  stages: PipelineStageState[]
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
