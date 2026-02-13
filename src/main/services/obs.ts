import OBSWebSocketDefault, { EventSubscription } from 'obs-websocket-js'
import { BrowserWindow } from 'electron'
import { OBSState, AudioLevel, IPC_CHANNELS } from '../../shared/types'
import { logger } from '../logger'

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

let reconnectTimer: NodeJS.Timeout | null = null
let reconnectAttempts = 0

let state: OBSState = {
  connectionStatus: 'disconnected',
  isRecording: false,
  isStreaming: false,
  isReplayBufferActive: false,
  recordTimeSec: 0,
}

let recordingTimer: NodeJS.Timeout | null = null

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows[0] || null
}

function sendToRenderer(channel: string, data: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

function broadcastState(): void {
  sendToRenderer(IPC_CHANNELS.OBS_STATE, state)
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

    // Sync initial state
    await syncState()
    broadcastState()

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
  reconnectAttempts = 0
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
  try {
    const recordStatus = await obs.call('GetRecordStatus')
    state.isRecording = recordStatus.outputActive
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

function startRecordingTimer(): void {
  if (recordingTimer) clearInterval(recordingTimer)
  state.recordTimeSec = 0
  recordingTimer = setInterval(() => {
    state.recordTimeSec++
    broadcastState()
  }, 1000)
}

function stopRecordingTimer(): void {
  if (recordingTimer) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }
  state.recordTimeSec = 0
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

// Recording state changes
obs.on('RecordStateChanged', (event) => {
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
})

// Stream state changes
obs.on('StreamStateChanged', (event) => {
  logger.obs.info('StreamStateChanged:', event.outputState)
  state.isStreaming =
    event.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED' ||
    event.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTING'
  broadcastState()
})

// Replay buffer saved
obs.on('ReplayBufferSaved', (event) => {
  logger.obs.info('ReplayBufferSaved:', event.savedReplayPath)
  sendToRenderer('obs:replay-saved', { path: event.savedReplayPath })
})

// Audio meters — high frequency, throttled in renderer
obs.on('InputVolumeMeters', (event) => {
  const levels: AudioLevel[] = event.inputs.map((input) => ({
    inputName: input.inputName as string,
    levels: (input.inputLevelsMul as number[][]).map((ch) => ch[0] || 0),
  }))
  sendToRenderer(IPC_CHANNELS.OBS_AUDIO_LEVELS, levels)
})

// Connection closed
obs.on('ConnectionClosed', () => {
  if (state.connectionStatus === 'connected') {
    logger.obs.warn('Connection lost')
  }
  state.connectionStatus = 'disconnected'
  state.isRecording = false
  state.isStreaming = false
  stopRecordingTimer()
  broadcastState()
})

export function getState(): OBSState {
  return { ...state }
}
