import { create } from 'zustand'
import {
  IPC_CHANNELS,
  type Competition,
  type Routine,
  type OBSState,
  type AppSettings,
  type FFmpegProgress,
  type UploadProgress,
  type SystemStats,
  type ObsStats,
  type ChatMessage,
  type PinnedChatMessage,
  type AudioMeterData,
  type AudioLevel,
  type JobRecord,
  type StartupReport,
  type ClipSortResult,
  type RecoveryState,
  type TetherState,
  type WifiDisplayState,
} from '../../shared/types'

interface FFmpegProgressMap {
  [routineId: string]: FFmpegProgress
}

interface AppStore {
  // Data
  competition: Competition | null
  currentRoutine: Routine | null
  nextRoutine: Routine | null
  currentIndex: number
  settings: AppSettings | null
  obsState: OBSState
  ffmpegProgress: FFmpegProgressMap

  // UI state
  settingsOpen: boolean
  loadCompOpen: boolean
  dayFilter: string
  searchQuery: string
  previewFrame: string | null // base64 data URL from OBS
  previewActive: boolean

  // UI modes
  compactMode: boolean

  // Audio meters
  audioMeters: AudioMeterData

  // System stats
  systemStats: SystemStats | null
  obsStats: ObsStats | null

  // Chat (commit 4)
  chat: {
    messages: ChatMessage[]
    pinned: PinnedChatMessage[]
    visible: boolean
  }

  // Job queue
  jobQueue: JobRecord[]
  jobQueuePanelOpen: boolean

  // Startup report
  startupReport: StartupReport | null
  startupToastVisible: boolean

  // Photo Sorter
  photoSort: {
    status: 'idle' | 'analyzing' | 'review' | 'executing' | 'done' | 'error'
    progress: { phase: string; current: number; total: number } | null
    result: ClipSortResult | null
    error: string | null
  }
  photoSorterOpen: boolean

  // Visual Editor
  showVisualEditor: boolean

  // Recovery
  recoveryOpen: boolean
  recoveryState: RecoveryState

  // Tether
  tetherState: TetherState

  // Wifi Display
  wifiDisplayState: WifiDisplayState

  // Status counts
  encodingCount: number
  uploadingCount: number
  completeCount: number
  photosPendingCount: number

  // Actions
  setCompetition: (comp: Competition) => void
  setCurrentRoutine: (routine: Routine | null) => void
  setNextRoutine: (routine: Routine | null) => void
  setCurrentIndex: (index: number) => void
  setSettings: (settings: AppSettings) => void
  setOBSState: (state: Partial<OBSState>) => void
  setSettingsOpen: (open: boolean) => void
  setLoadCompOpen: (open: boolean) => void
  setPreviewFrame: (frame: string | null) => void
  setPreviewActive: (active: boolean) => void
  setCompactMode: (compact: boolean) => void
  setDayFilter: (filter: string) => void
  setSearchQuery: (query: string) => void
  setSystemStats: (stats: SystemStats) => void
  setObsStats: (stats: ObsStats | null) => void
  setChatMessages: (messages: ChatMessage[]) => void
  addChatMessage: (msg: ChatMessage) => void
  setChatPinned: (pinned: PinnedChatMessage[]) => void
  setChatVisible: (visible: boolean) => void
  updateRoutine: (routineId: string, update: Partial<Routine>) => void
  updateFFmpegProgress: (progress: FFmpegProgress) => void
  updateUploadProgress: (routineId: string, progress: UploadProgress) => void
  setJobQueue: (jobs: JobRecord[]) => void
  setJobQueuePanelOpen: (open: boolean) => void
  setStartupReport: (report: StartupReport) => void
  dismissStartupToast: () => void
  setPhotoSorterOpen: (open: boolean) => void
  setPhotoSortStatus: (status: 'idle' | 'analyzing' | 'review' | 'executing' | 'done' | 'error') => void
  setPhotoSortProgress: (progress: { phase: string; current: number; total: number } | null) => void
  setPhotoSortResult: (result: ClipSortResult | null) => void
  setPhotoSortError: (error: string | null) => void
  resetPhotoSort: () => void
  setShowVisualEditor: (show: boolean) => void
  setRecoveryOpen: (open: boolean) => void
  setRecoveryState: (state: RecoveryState) => void
  setTetherState: (state: TetherState) => void
  setWifiDisplayState: (state: WifiDisplayState) => void
  recalcCounts: () => void
}

export const useStore = create<AppStore>((set, get) => ({
  competition: null,
  currentRoutine: null,
  nextRoutine: null,
  currentIndex: 0,
  settings: null,
  obsState: {
    connectionStatus: 'disconnected',
    isRecording: false,
    isStreaming: false,
    isReplayBufferActive: false,
    recordTimeSec: 0,
  },
  ffmpegProgress: {},

  settingsOpen: false,
  loadCompOpen: false,
  dayFilter: '',
  searchQuery: '',
  previewFrame: null,
  previewActive: false,

  compactMode: false,

  audioMeters: { performance: -Infinity, judges: [] },

  systemStats: null,
  obsStats: null,
  chat: { messages: [], pinned: [], visible: false },

  photoSort: {
    status: 'idle',
    progress: null,
    result: null,
    error: null,
  },
  photoSorterOpen: false,

  showVisualEditor: false,

  recoveryOpen: false,
  recoveryState: {
    active: false,
    phase: 'idle',
    percent: 0,
    detail: '',
  },

  tetherState: {
    active: false,
    watchPath: null,
    source: 'folder-watch',
    sourceLabel: undefined,
    deviceId: null,
    deviceName: null,
    stagingDir: null,
    photosReceived: 0,
    lastPhotoTime: null,
    cameraClockOffset: 0,
    clockSyncStatus: 'unknown' as const,
  },

  wifiDisplayState: { running: false, monitorIndex: null },

  jobQueue: [],
  jobQueuePanelOpen: false,

  startupReport: null,
  startupToastVisible: false,

  encodingCount: 0,
  uploadingCount: 0,
  completeCount: 0,
  photosPendingCount: 0,

  setCompetition: (competition) => {
    set({ competition })
    get().recalcCounts()
  },
  setCurrentRoutine: (currentRoutine) => set({ currentRoutine }),
  setNextRoutine: (nextRoutine) => set({ nextRoutine }),
  setCurrentIndex: (currentIndex) => set({ currentIndex }),
  setSettings: (settings) => {
    set({ settings, compactMode: settings.behavior?.compactMode ?? false })
  },
  setOBSState: (partial) =>
    set((s) => ({ obsState: { ...s.obsState, ...partial } })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setLoadCompOpen: (loadCompOpen) => set({ loadCompOpen }),
  setPreviewFrame: (previewFrame) => set({ previewFrame }),
  setPreviewActive: (previewActive) => set({ previewActive }),
  setCompactMode: (compactMode) => {
    set({ compactMode })
    // Persist to settings
    window.api?.settingsSet({ behavior: { ...get().settings!.behavior, compactMode } }).catch(() => {})
  },
  setDayFilter: (dayFilter) => set({ dayFilter }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSystemStats: (systemStats) => set({ systemStats }),
  setObsStats: (obsStats) => set({ obsStats }),
  setChatMessages: (messages) => set((s) => ({ chat: { ...s.chat, messages } })),
  addChatMessage: (msg) => set((s) => {
    const next = [...s.chat.messages, msg]
    return { chat: { ...s.chat, messages: next.length > 50 ? next.slice(-50) : next } }
  }),
  setChatPinned: (pinned) => set((s) => ({ chat: { ...s.chat, pinned } })),
  setChatVisible: (visible) => set((s) => ({ chat: { ...s.chat, visible } })),

  updateRoutine: (routineId, update) => {
    const comp = get().competition
    if (!comp) return
    const routines = comp.routines.map((r) =>
      r.id === routineId ? { ...r, ...update } : r,
    )
    set({ competition: { ...comp, routines } })
    get().recalcCounts()
  },

  updateFFmpegProgress: (progress) => {
    set((s) => ({
      ffmpegProgress: { ...s.ffmpegProgress, [progress.routineId]: progress },
    }))
  },

  updateUploadProgress: (routineId, progress) => {
    get().updateRoutine(routineId, { uploadProgress: progress })
  },

  setJobQueue: (jobQueue) => set({ jobQueue }),
  setJobQueuePanelOpen: (jobQueuePanelOpen) => set({ jobQueuePanelOpen }),
  setStartupReport: (startupReport) => set({ startupReport, startupToastVisible: true }),
  dismissStartupToast: () => set({ startupToastVisible: false }),

  setPhotoSorterOpen: (photoSorterOpen) => set({ photoSorterOpen }),
  setPhotoSortStatus: (status) => set((s) => ({ photoSort: { ...s.photoSort, status } })),
  setPhotoSortProgress: (progress) => set((s) => ({ photoSort: { ...s.photoSort, progress } })),
  setPhotoSortResult: (result) => set((s) => ({ photoSort: { ...s.photoSort, result, status: 'review' as const } })),
  setPhotoSortError: (error) => set((s) => ({ photoSort: { ...s.photoSort, error, status: 'error' as const } })),
  resetPhotoSort: () => set({ photoSort: { status: 'idle', progress: null, result: null, error: null } }),
  setShowVisualEditor: (showVisualEditor) => set({ showVisualEditor }),
  setRecoveryOpen: (recoveryOpen) => set({ recoveryOpen }),
  setRecoveryState: (recoveryState) => set({ recoveryState }),
  setTetherState: (tetherState) => set({ tetherState }),
  setWifiDisplayState: (wifiDisplayState) => set({ wifiDisplayState }),

  recalcCounts: () => {
    const comp = get().competition
    if (!comp) {
      set({ encodingCount: 0, uploadingCount: 0, completeCount: 0, photosPendingCount: 0 })
      return
    }
    let encoding = 0,
      uploading = 0,
      complete = 0,
      photos = 0
    for (const r of comp.routines) {
      if (r.status === 'encoding') encoding++
      if (r.status === 'uploading') uploading++
      if (r.status === 'uploaded' || r.status === 'confirmed') complete++
      if (r.photos && r.photos.length > 0) photos += r.photos.length
    }
    // Fix 5: Only set if values actually changed to avoid unnecessary renders
    const s = get()
    if (s.encodingCount !== encoding || s.uploadingCount !== uploading ||
        s.completeCount !== complete || s.photosPendingCount !== photos) {
      set({
        encodingCount: encoding,
        uploadingCount: uploading,
        completeCount: complete,
        photosPendingCount: photos,
      })
    }
  },
}))

// Initialize IPC listeners
export function initIPCListeners(): () => void {
  const store = useStore.getState

  // State updates from main
  window.api.on(IPC_CHANNELS.STATE_UPDATE, (data: unknown) => {
    const d = data as {
      competition: Competition
      currentRoutine: Routine | null
      nextRoutine: Routine | null
      currentIndex: number
    }
    useStore.setState({
      competition: d.competition,
      currentRoutine: d.currentRoutine,
      nextRoutine: d.nextRoutine,
      currentIndex: d.currentIndex,
    })
    store().recalcCounts()
  })

  // Delta routine update from main (single routine changed)
  window.api.on(IPC_CHANNELS.STATE_ROUTINE_UPDATE, (data: unknown) => {
    const d = data as { routineId: string; routine: Routine }
    const comp = useStore.getState().competition
    if (!comp) return
    const routines = comp.routines.map(r =>
      r.id === d.routineId ? d.routine : r,
    )
    useStore.setState({ competition: { ...comp, routines } })
    store().recalcCounts()
  })

  // OBS state
  window.api.on(IPC_CHANNELS.OBS_STATE, (data: unknown) => {
    useStore.setState({ obsState: data as OBSState })
  })

  // FFmpeg progress
  window.api.on(IPC_CHANNELS.FFMPEG_PROGRESS, (data: unknown) => {
    store().updateFFmpegProgress(data as FFmpegProgress)
  })

  // Upload progress
  window.api.on(IPC_CHANNELS.UPLOAD_PROGRESS, (data: unknown) => {
    const d = data as { routineId: string; progress: UploadProgress }
    store().updateUploadProgress(d.routineId, d.progress)
  })

  // Preview frame
  window.api.on(IPC_CHANNELS.PREVIEW_FRAME, (data: unknown) => {
    useStore.setState({ previewFrame: data as string })
  })

  // System stats
  window.api.on(IPC_CHANNELS.SYSTEM_STATS, (data: unknown) => {
    useStore.setState({ systemStats: data as SystemStats })
  })

  // OBS stats (commit 3)
  window.api.on(IPC_CHANNELS.OBS_STATS, (data: unknown) => {
    useStore.setState({ obsStats: data as ObsStats })
  })

  // Chat push events (commit 4)
  window.api.on(IPC_CHANNELS.CHAT_MESSAGE_NEW, (data: unknown) => {
    store().addChatMessage(data as ChatMessage)
  })
  window.api.on(IPC_CHANNELS.CHAT_PINNED_CHANGED, (data: unknown) => {
    store().setChatPinned(data as PinnedChatMessage[])
  })

  // Audio levels → AudioMeterData
  window.api.on(IPC_CHANNELS.OBS_AUDIO_LEVELS, (data: unknown) => {
    const levels = data as AudioLevel[]
    const settings = store().settings
    const mapping = settings?.audioInputMapping
    if (!mapping) return

    const findDB = (role: string): number => {
      const inputName = mapping[role]
      if (!inputName) return -Infinity
      const src = levels.find((l) => l.inputName === inputName)
      if (!src || !src.levels.length) return -Infinity
      const peak = Math.max(...src.levels)
      return peak > 0 ? 20 * Math.log10(peak) : -Infinity
    }

    const judgeCount = settings?.competition.judgeCount ?? 3
    useStore.setState({
      audioMeters: {
        performance: findDB('performance'),
        judges: Array.from({ length: judgeCount }, (_, i) => findDB(`judge${i + 1}`)),
      },
    })
  })

  // Job queue progress
  window.api.on(IPC_CHANNELS.JOB_QUEUE_PROGRESS, (data: unknown) => {
    useStore.setState({ jobQueue: data as JobRecord[] })
  })

  // Startup report
  window.api.on(IPC_CHANNELS.APP_STARTUP_REPORT, (data: unknown) => {
    store().setStartupReport(data as StartupReport)
  })

  // Recovery progress
  window.api.on(IPC_CHANNELS.RECOVERY_PROGRESS, (data: unknown) => {
    store().setRecoveryState(data as RecoveryState)
  })

  // Tether progress
  window.api.on(IPC_CHANNELS.TETHER_PROGRESS, (data: unknown) => {
    store().setTetherState(data as TetherState)
  })

  // Fetch initial tether state (watcher may have auto-started before renderer loaded)
  window.api.tetherGetState().then((data: unknown) => {
    if (data) store().setTetherState(data as TetherState)
  }).catch(() => {})

  // Return cleanup function
  return () => {
    window.api.removeAllListeners(IPC_CHANNELS.STATE_UPDATE)
    window.api.removeAllListeners(IPC_CHANNELS.STATE_ROUTINE_UPDATE)
    window.api.removeAllListeners(IPC_CHANNELS.OBS_STATE)
    window.api.removeAllListeners(IPC_CHANNELS.FFMPEG_PROGRESS)
    window.api.removeAllListeners(IPC_CHANNELS.UPLOAD_PROGRESS)
    window.api.removeAllListeners(IPC_CHANNELS.PREVIEW_FRAME)
    window.api.removeAllListeners(IPC_CHANNELS.SYSTEM_STATS)
    window.api.removeAllListeners(IPC_CHANNELS.OBS_AUDIO_LEVELS)
    window.api.removeAllListeners(IPC_CHANNELS.JOB_QUEUE_PROGRESS)
    window.api.removeAllListeners(IPC_CHANNELS.APP_STARTUP_REPORT)
    window.api.removeAllListeners(IPC_CHANNELS.RECOVERY_PROGRESS)
    window.api.removeAllListeners(IPC_CHANNELS.TETHER_PROGRESS)
  }
}
