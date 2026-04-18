import OBSWebSocketDefault, { EventSubscription } from 'obs-websocket-js'
import { OBSState, AudioLevel, IPC_CHANNELS, ObsStats } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as perf from './perfLogger'

// Handle CJS←ESM interop: externalized ESM package wraps default export
const OBSWebSocket = (OBSWebSocketDefault as any).default || OBSWebSocketDefault
const obs = new OBSWebSocket()

// Callbacks for main-process event consumers (wired in index.ts)
type RecordingCallback = (data: { outputPath?: string; timestamp: string }) => void
let onRecordStartedCb: RecordingCallback | null = null
let onRecordStoppedCb: RecordingCallback | null = null

export function onRecordStarted(cb: RecordingCallback): void {
  onRecordStartedCb = cb
}

export function onRecordStopped(cb: RecordingCallback): void {
  onRecordStoppedCb = cb
}

let onAudioLevelsCb: ((levels: AudioLevel[]) => void) | null = null
export function setOnAudioLevels(cb: (levels: AudioLevel[]) => void): void {
  onAudioLevelsCb = cb
}

// Fix 11: reconcile hook invoked after (re)sync so recording.ts can fix up orphan state
type ReconcileCallback = (info: { outputActive: boolean; recordDirectory: string | null }) => void
let onReconcileCb: ReconcileCallback | null = null
export function setOnReconcile(cb: ReconcileCallback): void {
  onReconcileCb = cb
}

let reconnectTimer: NodeJS.Timeout | null = null
let reconnectAttempts = 0
let lastUrl = ''
let lastPassword = ''

let state: OBSState = {
  connectionStatus: 'disconnected',
  isRecording: false,
  isStreaming: false,
  isReplayBufferActive: false,
  recordTimeSec: 0,
}

let recordingTimer: NodeJS.Timeout | null = null
let eventHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = []
let lastMeterSendTime = 0
const METER_THROTTLE_MS = 100 // 10 Hz — still feels live, 33% fewer IPC/store updates vs 15 Hz
let maxLimitWarned = false

// Signal monitors (Fix 14)
let silentSince: number | null = null
let silenceAlertFired = false
let blackFrameTimer: NodeJS.Timeout | null = null
let blackFrameCount = 0
let blackAlertFired = false
let activeAlertRoutineId: string | null = null

// Stats poller (commit 3): periodic GetStats / GetStreamStatus → ObsStats broadcasts
let statsPollerTimer: NodeJS.Timeout | null = null
let lastRenderSkippedFrames = 0
let lastOutputSkippedFrames = 0
let cachedTargetFps = 60

export function setActiveAlertRoutineId(id: string | null): void {
  activeAlertRoutineId = id
}

function emitRecordingAlert(level: 'warning' | 'error', message: string): void {
  sendToRenderer(IPC_CHANNELS.RECORDING_ALERT, { level, message, routineId: activeAlertRoutineId })
  if (level === 'error') logger.obs.error(message)
  else logger.obs.warn(message)
}

function broadcastState(): void {
  sendToRenderer(IPC_CHANNELS.OBS_STATE, state)
}

// --- Stats poller (commit 3): cadence 5s, only while connected ---

function broadcastDisconnectedStats(): void {
  const payload: ObsStats = {
    connected: false,
    streaming: false,
    recording: false,
    fps: 0,
    targetFps: cachedTargetFps,
    renderSkippedFrames: 0,
    outputSkippedFrames: 0,
    congestion: 0,
    renderSkippedDelta: 0,
    outputSkippedDelta: 0,
    timestamp: Date.now(),
  }
  sendToRenderer(IPC_CHANNELS.OBS_STATS, payload)
}

async function pollObsStats(): Promise<void> {
  if (state.connectionStatus !== 'connected') {
    broadcastDisconnectedStats()
    return
  }
  try {
    const stats = await obs.call('GetStats') as Record<string, any>
    const fps = typeof stats.activeFps === 'number' ? stats.activeFps : (typeof stats.fps === 'number' ? stats.fps : 0)
    const renderSkipped = typeof stats.renderSkippedFrames === 'number' ? stats.renderSkippedFrames : 0
    const outputSkipped = typeof stats.outputSkippedFrames === 'number' ? stats.outputSkippedFrames : 0

    let congestion = 0
    if (state.isStreaming) {
      try {
        const ss = await obs.call('GetStreamStatus') as Record<string, any>
        if (typeof ss.outputCongestion === 'number') congestion = ss.outputCongestion
      } catch {
        // ignore
      }
    }

    const renderDelta = Math.max(0, renderSkipped - lastRenderSkippedFrames)
    const outputDelta = Math.max(0, outputSkipped - lastOutputSkippedFrames)
    lastRenderSkippedFrames = renderSkipped
    lastOutputSkippedFrames = outputSkipped

    const payload: ObsStats = {
      connected: true,
      streaming: state.isStreaming,
      recording: state.isRecording,
      fps,
      targetFps: cachedTargetFps,
      renderSkippedFrames: renderSkipped,
      outputSkippedFrames: outputSkipped,
      congestion,
      renderSkippedDelta: renderDelta,
      outputSkippedDelta: outputDelta,
      timestamp: Date.now(),
    }
    sendToRenderer(IPC_CHANNELS.OBS_STATS, payload)
  } catch (err) {
    logger.obs.debug(`Stats poll failed: ${err instanceof Error ? err.message : err}`)
  }
}

function startStatsPoller(): void {
  if (statsPollerTimer) return
  // Prime targetFps from video settings
  obs.call('GetVideoSettings').then((v: any) => {
    if (v && typeof v.fpsNumerator === 'number' && typeof v.fpsDenominator === 'number' && v.fpsDenominator > 0) {
      cachedTargetFps = Math.round(v.fpsNumerator / v.fpsDenominator)
    }
  }).catch(() => { cachedTargetFps = 60 })
  lastRenderSkippedFrames = 0
  lastOutputSkippedFrames = 0
  statsPollerTimer = setInterval(() => { pollObsStats().catch(() => {}) }, 5000)
  // Fire one immediate poll for fast UI priming
  pollObsStats().catch(() => {})
}

function stopStatsPoller(): void {
  if (statsPollerTimer) {
    clearInterval(statsPollerTimer)
    statsPollerTimer = null
  }
  broadcastDisconnectedStats()
}

// --- Connection ---

export async function connect(url: string, password: string): Promise<void> {
  if (state.connectionStatus === 'connected') {
    logger.obs.info('Already connected, disconnecting first')
    await disconnect()
  }

  state.connectionStatus = 'connecting'
  broadcastState()

  try {
    logger.obs.info(`Connecting to ${url} (auth: ${password ? 'yes' : 'no'})`)
    const start = Date.now()

    await obs.connect(url, password, {
      eventSubscriptions:
        EventSubscription.All | EventSubscription.InputVolumeMeters,
    })

    logger.obs.info(`Connected in ${Date.now() - start}ms`)
    state.connectionStatus = 'connected'
    reconnectAttempts = 0
    lastUrl = url
    lastPassword = password

    // Sync initial state
    await syncState()
    broadcastState()
    registerOBSEvents()
    startStatsPoller()

    if (reconnectTimer) {
      clearInterval(reconnectTimer)
      reconnectTimer = null
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (reconnectAttempts === 0) {
      logger.obs.warn(`Connection failed: ${msg}`)
    } else {
      logger.obs.debug(`Reconnect attempt ${reconnectAttempts} failed`)
    }
    state.connectionStatus = 'error'
    broadcastState()
    scheduleReconnect(url, password)
  }
}

export async function disconnect(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  removeOBSEvents()
  reconnectAttempts = 0
  stopStatsPoller()
  if (recordingTimer) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }

  try {
    await obs.disconnect()
  } catch {
    // ignore
  }

  state = {
    connectionStatus: 'disconnected',
    isRecording: false,
    isStreaming: false,
    isReplayBufferActive: false,
    recordTimeSec: 0,
  }
  broadcastState()
  logger.obs.info('Disconnected')
}

function scheduleReconnect(url: string, password: string): void {
  if (reconnectTimer) return
  // Backoff: 5s, 10s, 15s, max 30s
  const delay = Math.min(5000 + reconnectAttempts * 5000, 30000)
  reconnectAttempts++
  if (reconnectAttempts <= 3) {
    logger.obs.info(`Will retry in ${delay / 1000}s (attempt ${reconnectAttempts})`)
  }
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    if (state.connectionStatus === 'connected') return
    try {
      await connect(url, password)
    } catch {
      // connect() handles the error
    }
  }, delay)
}

async function syncState(): Promise<void> {
  let outputActive = false
  try {
    const recordStatus = await obs.call('GetRecordStatus')
    outputActive = recordStatus.outputActive
    state.isRecording = outputActive
    if (state.isRecording) {
      startRecordingTimer()
    }
  } catch {
    // OBS may not be recording
  }

  try {
    const streamStatus = await obs.call('GetStreamStatus')
    state.isStreaming = streamStatus.outputActive
  } catch {
    // ignore
  }

  try {
    const replayStatus = await obs.call('GetReplayBufferStatus')
    state.isReplayBufferActive = replayStatus.outputActive
  } catch {
    // Replay buffer may not be configured
  }

  // Fix 11: reconcile hook — lets recording.ts cleanup orphan active-record state
  const recordDirectory = await getRecordDirectory()
  try {
    onReconcileCb?.({ outputActive, recordDirectory })
  } catch (err) {
    logger.obs.warn(`Reconcile callback threw: ${err instanceof Error ? err.message : err}`)
  }
}

// --- Recording ---

export async function startRecord(): Promise<void> {
  logger.obs.info('StartRecord')
  const start = Date.now()
  await obs.call('StartRecord')
  logger.obs.info(`StartRecord completed in ${Date.now() - start}ms`)
}

export async function stopRecord(): Promise<string | undefined> {
  logger.obs.info('StopRecord')
  const start = Date.now()
  const result = await obs.call('StopRecord')
  logger.obs.info(`StopRecord completed in ${Date.now() - start}ms, path: ${result.outputPath}`)
  return result.outputPath
}

/** Returns a promise that resolves when OBS fires RecordStateChanged → STOPPED, with a max timeout. */
export function waitForRecordStop(timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false
    const handler = (event: any): void => {
      if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
        if (!resolved) {
          resolved = true
          obs.off('RecordStateChanged' as any, handler)
          clearTimeout(timer)
          resolve()
        }
      }
    }
    obs.on('RecordStateChanged' as any, handler)
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        obs.off('RecordStateChanged' as any, handler)
        logger.obs.warn(`waitForRecordStop: timed out after ${timeoutMs / 1000}s, proceeding`)
        resolve()
      }
    }, timeoutMs)
  })
}

let recordingStartMs = 0

function startRecordingTimer(): void {
  if (recordingTimer) clearInterval(recordingTimer)
  state.recordTimeSec = 0
  maxLimitWarned = false
  recordingStartMs = Date.now()
  startBlackFrameMonitor()
  recordingTimer = setInterval(() => {
    // Anchor to wall clock — setInterval drifts under CPU load, which was
    // causing clients (Stream Deck / tablet) to fall behind real time and
    // the max-record warning to never fire on genuinely long recordings.
    state.recordTimeSec = Math.floor((Date.now() - recordingStartMs) / 1000)
    const maxMinutes = getSettings().obs.maxRecordMinutes || 0
    if (maxMinutes > 0 && state.recordTimeSec >= maxMinutes * 60 && state.isRecording && !maxLimitWarned) {
      maxLimitWarned = true
      const msg = `Recording has exceeded ${maxMinutes}min limit — still running`
      logger.obs.warn(msg)
      sendToRenderer(IPC_CHANNELS.RECORDING_MAX_WARNING, { maxMinutes, recordTimeSec: state.recordTimeSec })
    }
    broadcastState()
  }, 1000)
}

function stopRecordingTimer(): void {
  if (recordingTimer) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }
  state.recordTimeSec = 0
  maxLimitWarned = false
  stopSignalMonitors()
}

function stopSignalMonitors(): void {
  if (blackFrameTimer) {
    clearInterval(blackFrameTimer)
    blackFrameTimer = null
  }
  silentSince = null
  silenceAlertFired = false
  blackFrameCount = 0
  blackAlertFired = false
}

function startBlackFrameMonitor(): void {
  if (blackFrameTimer) clearInterval(blackFrameTimer)
  blackFrameCount = 0
  blackAlertFired = false
  blackFrameTimer = setInterval(async () => {
    if (!state.isRecording || state.connectionStatus !== 'connected') return
    // Skip screenshot probe while streaming — OBS is CPU-bound on the encoder,
    // stealing a GetSourceScreenshot every 10s can push it into frame drops.
    if (state.isStreaming) { perf.counter('obs.blackframe.skip_streaming'); return }
    const t0 = Date.now()
    try {
      const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene')
      const res = await obs.call('GetSourceScreenshot', {
        sourceName: currentProgramSceneName,
        imageFormat: 'jpg',
        imageCompressionQuality: 10,
        imageWidth: 64,
        imageHeight: 36,
      })
      const imageData = res.imageData as string
      const base64 = imageData.includes(',') ? imageData.split(',', 2)[1] : imageData
      const buf = Buffer.from(base64, 'base64')
      // Lazy-require sharp to avoid hard dependency at module load
      const sharp = require('sharp') as typeof import('sharp')
      const raw = await sharp(buf).raw().toBuffer()
      let sum = 0
      for (let i = 0; i < raw.length; i++) sum += raw[i]
      const mean = raw.length > 0 ? sum / raw.length : 0
      if (mean < 5) {
        blackFrameCount++
        if (blackFrameCount >= 2 && !blackAlertFired) {
          blackAlertFired = true
          emitRecordingAlert('warning', `Black frames detected (${blackFrameCount} consecutive). Check camera / scene.`)
        }
      } else {
        blackFrameCount = 0
        blackAlertFired = false
      }
      perf.timing('obs.blackframe.tick_ms', Date.now() - t0)
    } catch {
      perf.counter('obs.blackframe.err')
    }
  }, 10000)
}

// --- Streaming ---

export async function startStream(): Promise<void> {
  logger.obs.info('StartStream')
  await obs.call('StartStream')
}

export async function stopStream(): Promise<void> {
  logger.obs.info('StopStream')
  await obs.call('StopStream')
}

// --- Replay ---

export async function saveReplay(): Promise<void> {
  logger.obs.info('SaveReplayBuffer')
  await obs.call('SaveReplayBuffer')
}

// --- Recording format ---

export async function setRecordingFormat(format: string): Promise<void> {
  try {
    // Simple output mode — most common OBS config
    await obs.call('SetProfileParameter', {
      parameterCategory: 'SimpleOutput',
      parameterName: 'RecFormat2',
      parameterValue: format,
    })
    logger.obs.info(`Recording format set to ${format}`)
  } catch (err) {
    // May fail if OBS is in Advanced mode
    logger.obs.warn(`Failed to set recording format (Advanced mode?): ${err instanceof Error ? err.message : err}`)
  }
}

// --- Record directory (used by recovery reconciliation) ---

export async function getRecordDirectory(): Promise<string | null> {
  try {
    const result = await obs.call('GetRecordDirectory')
    return (result as any).recordDirectory ?? null
  } catch {
    return null
  }
}

// --- Input list for meter mapping ---

export async function getInputList(): Promise<string[]> {
  try {
    const result = await obs.call('GetInputList')
    return result.inputs.map((i) => i.inputName as string)
  } catch (err) {
    logger.obs.error('Failed to get input list:', err)
    return []
  }
}

// --- Events ---

function registerOBSEvents(): void {
  removeOBSEvents() // Clear any previous listeners

  const handlers: Array<[string, (...args: any[]) => void]> = [
    ['RecordStateChanged', (event: any) => {
      logger.obs.info('RecordStateChanged:', event.outputState, event.outputPath)
      if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
        state.isRecording = true
        startRecordingTimer()
        onRecordStartedCb?.({ timestamp: new Date().toISOString() })
      } else if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
        state.isRecording = false
        stopRecordingTimer()
        state.currentOutputPath = event.outputPath
        onRecordStoppedCb?.({ outputPath: event.outputPath, timestamp: new Date().toISOString() })
      }
      broadcastState()
    }],
    ['StreamStateChanged', (event: any) => {
      logger.obs.info('StreamStateChanged:', event.outputState)
      if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
        state.isStreaming = true
      } else if (
        event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED' ||
        event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING'
      ) {
        state.isStreaming = false
      }
      // STARTING state: don't change — wait for STARTED confirmation
      broadcastState()
    }],
    ['ReplayBufferSaved', (event: any) => {
      logger.obs.info('ReplayBufferSaved:', event.savedReplayPath)
      sendToRenderer('obs:replay-saved', { path: event.savedReplayPath })
    }],
    ['InputVolumeMeters', (event: any) => {
      perf.counter('obs.meters.event')
      const now = Date.now()
      if (now - lastMeterSendTime < METER_THROTTLE_MS) return
      lastMeterSendTime = now
      perf.counter('obs.meters.emit')
      const levels: AudioLevel[] = event.inputs.map((input: any) => ({
        inputName: input.inputName as string,
        // inputLevelsMul[channel] = [pre-fader, post-fader, post-fader-peak].
        // We want post-fader peak (index 2) so operator gain adjustments
        // in OBS actually move the meters. Index 0 was pre-fader, which is
        // why cranking judge gains had no effect on the meters.
        levels: (input.inputLevelsMul as number[][]).map((ch) => ch[2] || ch[1] || ch[0] || 0),
      }))
      sendToRenderer(IPC_CHANNELS.OBS_AUDIO_LEVELS, levels)
      onAudioLevelsCb?.(levels)

      // Fix 14: silent-audio detection during recording
      if (state.isRecording) {
        const SILENCE_THRESHOLD = 0.001
        let anySignal = false
        for (const lvl of levels) {
          for (const ch of lvl.levels) {
            if (ch > SILENCE_THRESHOLD) { anySignal = true; break }
          }
          if (anySignal) break
        }
        if (!anySignal) {
          if (silentSince === null) silentSince = now
          else if (!silenceAlertFired && now - silentSince > 5000) {
            silenceAlertFired = true
            emitRecordingAlert('warning', 'Audio signal flat-line for >5s. Check mics.')
          }
        } else {
          silentSince = null
          silenceAlertFired = false
        }
      }
    }],
    ['ConnectionClosed', () => {
      if (state.connectionStatus === 'connected') {
        logger.obs.warn('Connection lost — will auto-reconnect')
      }
      state.connectionStatus = 'disconnected'
      state.isRecording = false
      state.isStreaming = false
      stopRecordingTimer()
      stopStatsPoller()
      broadcastState()
      // Auto-reconnect with saved credentials
      if (lastUrl) {
        scheduleReconnect(lastUrl, lastPassword)
      }
    }],
  ]

  for (const [event, handler] of handlers) {
    obs.on(event as any, handler as any)
    eventHandlers.push({ event, handler })
  }
}

function removeOBSEvents(): void {
  for (const { event, handler } of eventHandlers) {
    obs.off(event as any, handler as any)
  }
  eventHandlers = []
}

export function getState(): OBSState {
  return { ...state }
}

// --- Preview Polling ---

let previewTimer: NodeJS.Timeout | null = null

let previewPaused = false

export function setPreviewPaused(paused: boolean): void {
  if (previewPaused === paused) return
  previewPaused = paused
  logger.obs.info(`Preview ${paused ? 'paused (window hidden)' : 'resumed'}`)
}

export function startPreview(fps = 2): void {
  stopPreview()
  if (state.connectionStatus !== 'connected') return

  const interval = Math.round(1000 / fps)
  previewTimer = setInterval(async () => {
    if (state.connectionStatus !== 'connected') {
      stopPreview()
      return
    }
    if (previewPaused) { perf.counter('obs.preview.paused'); return }
    const t0 = Date.now()
    try {
      // Get current program scene name
      const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene')
      const { imageData } = await obs.call('GetSourceScreenshot', {
        sourceName: currentProgramSceneName,
        imageFormat: 'jpg',
        imageCompressionQuality: 30,
        imageWidth: 480,
        imageHeight: 270,
      })
      sendToRenderer(IPC_CHANNELS.PREVIEW_FRAME, imageData)
      perf.timing('obs.preview.tick_ms', Date.now() - t0)
      perf.size('obs.preview.frame_b64', typeof imageData === 'string' ? imageData.length : 0)
    } catch {
      perf.counter('obs.preview.err')
    }
  }, interval)
  logger.obs.info(`Preview polling started at ${fps} FPS`)
}

export function stopPreview(): void {
  if (previewTimer) {
    clearInterval(previewTimer)
    previewTimer = null
    logger.obs.info('Preview polling stopped')
  }
}
