import { create } from 'zustand'
import type {
  Competition,
  Routine,
  OBSState,
  AppSettings,
  FFmpegProgress,
  UploadProgress,
  SystemStats,
  IPC_CHANNELS,
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

  // System stats
  systemStats: SystemStats | null

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
  updateRoutine: (routineId: string, update: Partial<Routine>) => void
  updateFFmpegProgress: (progress: FFmpegProgress) => void
  updateUploadProgress: (routineId: string, progress: UploadProgress) => void
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

  systemStats: null,

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
    set({
      encodingCount: encoding,
      uploadingCount: uploading,
      completeCount: complete,
      photosPendingCount: photos,
    })
  },
}))

// Initialize IPC listeners
export function initIPCListeners(): void {
  const { IPC_CHANNELS } = require('../../shared/types')
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
}
