import { create } from 'zustand'
import type {
  OBSState,
  Competition,
  Routine,
  AppSettings,
  AudioMeterData,
  AudioLevel,
  FFmpegProgress,
  UploadProgress,
} from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/types'

interface AppStore {
  // OBS
  obsState: OBSState
  audioMeters: AudioMeterData
  obsInputs: string[]

  // Competition
  competition: Competition | null
  currentRoutine: Routine | null
  nextRoutine: Routine | null
  currentIndex: number
  dayFilter: string
  searchQuery: string

  // Settings
  settings: AppSettings | null
  settingsOpen: boolean
  loadCompOpen: boolean

  // Preview
  previewFrame: string | null // base64 data URL from OBS
  previewActive: boolean

  // Status counts
  encodingCount: number
  uploadingCount: number
  completeCount: number
  photosPendingCount: number

  // Actions
  setOBSState: (state: OBSState) => void
  setAudioMeters: (data: AudioMeterData) => void
  setOBSInputs: (inputs: string[]) => void
  setCompetition: (comp: Competition | null) => void
  setCurrentRoutine: (r: Routine | null) => void
  setNextRoutine: (r: Routine | null) => void
  setCurrentIndex: (i: number) => void
  setDayFilter: (day: string) => void
  setSearchQuery: (q: string) => void
  setSettings: (s: AppSettings) => void
  setSettingsOpen: (open: boolean) => void
  setLoadCompOpen: (open: boolean) => void
  setPreviewFrame: (frame: string | null) => void
  setPreviewActive: (active: boolean) => void
  updateRoutine: (routineId: string, update: Partial<Routine>) => void
  updateFFmpegProgress: (progress: FFmpegProgress) => void
  updateUploadProgress: (routineId: string, progress: UploadProgress) => void
  recalculateCounts: () => void
}

export const useStore = create<AppStore>((set, get) => ({
  obsState: {
    connectionStatus: 'disconnected',
    isRecording: false,
    isStreaming: false,
    isReplayBufferActive: false,
    recordTimeSec: 0,
  },
  audioMeters: { performance: -Infinity, judges: [-Infinity, -Infinity, -Infinity, -Infinity] },
  obsInputs: [],

  competition: null,
  currentRoutine: null,
  nextRoutine: null,
  currentIndex: 0,
  dayFilter: '',
  searchQuery: '',

  settings: null,
  settingsOpen: false,
  loadCompOpen: false,

  previewFrame: null,
  previewActive: false,

  encodingCount: 0,
  uploadingCount: 0,
  completeCount: 0,
  photosPendingCount: 0,

  setOBSState: (obsState) => set({ obsState }),
  setAudioMeters: (audioMeters) => set({ audioMeters }),
  setOBSInputs: (obsInputs) => set({ obsInputs }),
  setCompetition: (competition) => {
    set({ competition })
    get().recalculateCounts()
  },
  setCurrentRoutine: (currentRoutine) => set({ currentRoutine }),
  setNextRoutine: (nextRoutine) => set({ nextRoutine }),
  setCurrentIndex: (currentIndex) => set({ currentIndex }),
  setDayFilter: (dayFilter) => set({ dayFilter }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSettings: (settings) => set({ settings }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setLoadCompOpen: (loadCompOpen) => set({ loadCompOpen }),
  setPreviewFrame: (previewFrame) => set({ previewFrame }),
  setPreviewActive: (previewActive) => set({ previewActive }),

  updateRoutine: (routineId, update) => {
    const comp = get().competition
    if (!comp) return
    const routines = comp.routines.map((r) =>
      r.id === routineId ? { ...r, ...update } : r,
    )
    set({ competition: { ...comp, routines } })
    get().recalculateCounts()
  },

  updateFFmpegProgress: (progress) => {
    const comp = get().competition
    if (!comp) return
    const routines = comp.routines.map((r) => {
      if (r.id !== progress.routineId) return r
      if (progress.state === 'done') return { ...r, status: 'encoded' as const }
      if (progress.state === 'encoding') return { ...r, status: 'encoding' as const }
      if (progress.state === 'error') return { ...r, status: 'failed' as const, error: progress.error }
      return r
    })
    set({ competition: { ...comp, routines } })
    get().recalculateCounts()
  },

  updateUploadProgress: (routineId, progress) => {
    const comp = get().competition
    if (!comp) return
    const routines = comp.routines.map((r) => {
      if (r.id !== routineId) return r
      const newStatus = progress.state === 'complete' ? 'uploaded' as const : 'uploading' as const
      return { ...r, status: newStatus, uploadProgress: progress }
    })
    set({ competition: { ...comp, routines } })
    get().recalculateCounts()
  },

  recalculateCounts: () => {
    const comp = get().competition
    if (!comp) {
      set({ encodingCount: 0, uploadingCount: 0, completeCount: 0, photosPendingCount: 0 })
      return
    }
    set({
      encodingCount: comp.routines.filter((r) => r.status === 'encoding').length,
      uploadingCount: comp.routines.filter((r) => r.status === 'uploading').length,
      completeCount: comp.routines.filter((r) => r.status === 'uploaded' || r.status === 'confirmed').length,
      photosPendingCount: comp.routines.filter(
        (r) => (r.status === 'uploaded' || r.status === 'encoded') && (!r.photos || r.photos.length === 0),
      ).length,
    })
  },
}))

// --- IPC Event Subscriptions ---
export function initIPCListeners(): void {
  if (!window.api) return
  const api = window.api

  // OBS state updates
  api.on(IPC_CHANNELS.OBS_STATE, (data: unknown) => {
    useStore.getState().setOBSState(data as OBSState)
  })

  // Audio levels — throttle to rAF
  let pendingLevels: AudioLevel[] | null = null
  api.on(IPC_CHANNELS.OBS_AUDIO_LEVELS, (data: unknown) => {
    pendingLevels = data as AudioLevel[]
    if (!pendingLevels) return
  })

  // Process audio levels at animation frame rate (with threshold to avoid unnecessary re-renders)
  let lastMeterData: AudioMeterData | null = null
  const DB_THRESHOLD = 0.5 // Only update if any channel changed by more than 0.5 dB

  function processAudioLevels(): void {
    if (pendingLevels) {
      const settings = useStore.getState().settings
      if (settings) {
        const mapping = settings.audioInputMapping
        const meterData: AudioMeterData = {
          performance: -Infinity,
          judges: [-Infinity, -Infinity, -Infinity, -Infinity],
        }

        for (const level of pendingLevels) {
          // Convert linear to dB
          const maxLevel = Math.max(...level.levels, 0.00001)
          const dB = 20 * Math.log10(maxLevel)

          if (mapping.performance === level.inputName) {
            meterData.performance = dB
          }
          for (let i = 0; i < 4; i++) {
            if (mapping[`judge${i + 1}`] === level.inputName) {
              meterData.judges[i] = dB
            }
          }
        }

        // Only update store if levels changed meaningfully
        let changed = !lastMeterData
        if (lastMeterData) {
          if (Math.abs(meterData.performance - lastMeterData.performance) > DB_THRESHOLD) changed = true
          for (let i = 0; i < 4; i++) {
            if (Math.abs(meterData.judges[i] - lastMeterData.judges[i]) > DB_THRESHOLD) changed = true
          }
        }

        if (changed) {
          lastMeterData = meterData
          useStore.getState().setAudioMeters(meterData)
        }
      }
      pendingLevels = null
    }
    requestAnimationFrame(processAudioLevels)
  }
  requestAnimationFrame(processAudioLevels)

  // Full state updates
  api.on(IPC_CHANNELS.STATE_UPDATE, (data: unknown) => {
    const { competition, currentRoutine, nextRoutine, currentIndex } = data as {
      competition: Competition
      currentRoutine: Routine | null
      nextRoutine: Routine | null
      currentIndex: number
    }
    const store = useStore.getState()
    store.setCompetition(competition)
    store.setCurrentRoutine(currentRoutine)
    store.setNextRoutine(nextRoutine)
    store.setCurrentIndex(currentIndex)
  })

  // FFmpeg progress
  api.on(IPC_CHANNELS.FFMPEG_PROGRESS, (data: unknown) => {
    useStore.getState().updateFFmpegProgress(data as FFmpegProgress)
  })

  // Preview frames
  api.on(IPC_CHANNELS.PREVIEW_FRAME, (data: unknown) => {
    useStore.getState().setPreviewFrame(data as string)
  })

  // Upload progress
  api.on(IPC_CHANNELS.UPLOAD_PROGRESS, (data: unknown) => {
    const { routineId, progress } = data as { routineId: string; progress: UploadProgress }
    useStore.getState().updateUploadProgress(routineId, progress)
  })
}
