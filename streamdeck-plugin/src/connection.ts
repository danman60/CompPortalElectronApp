import WebSocket from 'ws'

export interface AppState {
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
  overlay: {
    counter: { visible: boolean; current: number; total: number; entryNumber: string }
    clock: { visible: boolean }
    logo: { visible: boolean; url: string }
    lowerThird: { visible: boolean }
  }
}

type StateCallback = (state: AppState) => void

const WS_URL = 'ws://localhost:9877'
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
const stateCallbacks: StateCallback[] = []
let currentState: AppState | null = null
let connected = false

export function onState(cb: StateCallback): void {
  stateCallbacks.push(cb)
  if (currentState) cb(currentState)
}

export function isConnected(): boolean {
  return connected
}

export function getState(): AppState | null {
  return currentState
}

export function sendCommand(action: string, element?: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const msg: Record<string, string> = { type: 'command', action }
  if (element) msg.element = element
  ws.send(JSON.stringify(msg))
}

export function connect(): void {
  if (ws) return
  try {
    ws = new WebSocket(WS_URL)
  } catch {
    scheduleReconnect()
    return
  }

  ws.on('open', () => {
    connected = true
    reconnectDelay = 1000
    ws!.send(JSON.stringify({ type: 'identify', client: 'streamdeck' }))
    console.log('[CompSync] Connected to Electron app')
  })

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'state') {
        currentState = msg as AppState
        for (const cb of stateCallbacks) cb(currentState)
      }
    } catch { /* ignore parse errors */ }
  })

  ws.on('close', () => {
    connected = false
    ws = null
    console.log('[CompSync] Disconnected from Electron app')
    scheduleReconnect()
  })

  ws.on('error', () => {
    connected = false
    ws?.close()
    ws = null
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 30000)
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  connected = false
}
