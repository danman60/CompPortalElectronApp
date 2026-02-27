import { WebSocketServer, WebSocket } from 'ws'
import * as obs from './obs'
import * as stateService from './state'
import * as overlay from './overlay'
import * as recording from './recording'
import { WSCommandMessage, WSStateMessage } from '../../shared/types'
import { logger } from '../logger'

const PORT = 9877
let wss: WebSocketServer | null = null

interface TaggedSocket extends WebSocket {
  clientType?: 'overlay' | 'streamdeck'
  isAlive?: boolean
}

const clients = new Set<TaggedSocket>()
let heartbeatInterval: NodeJS.Timeout | null = null

export function start(): void {
  if (wss) return
  wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' })

  wss.on('listening', () => {
    logger.app.info(`WebSocket hub listening on ws://localhost:${PORT}`)
  })

  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.app.warn(`WebSocket hub port ${PORT} already in use`)
    } else {
      logger.app.error(`WebSocket hub error: ${err.message}`)
    }
  })

  wss.on('connection', (ws: TaggedSocket) => {
    ws.isAlive = true
    clients.add(ws)
    logger.app.info(`WebSocket client connected (total: ${clients.size})`)

    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        handleMessage(ws, msg)
      } catch {
        logger.app.warn('Invalid WebSocket message:', raw.toString().slice(0, 200))
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
      logger.app.info(`WebSocket client disconnected (total: ${clients.size})`)
    })

    ws.on('error', (err) => {
      logger.app.warn('WebSocket client error:', err.message)
      clients.delete(ws)
    })
  })

  heartbeatInterval = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) {
        clients.delete(ws)
        continue
      }
      if (!ws.isAlive) {
        ws.terminate()
        clients.delete(ws)
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, 30000)

  overlay.setOnStateChange(() => broadcastState())
}

export function stop(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
  for (const ws of clients) {
    ws.close()
  }
  clients.clear()
  if (wss) {
    wss.close()
    wss = null
    logger.app.info('WebSocket hub stopped')
  }
}

function handleMessage(ws: TaggedSocket, msg: Record<string, unknown>): void {
  if (msg.type === 'identify') {
    ws.clientType = msg.client as 'overlay' | 'streamdeck'
    logger.app.info(`WebSocket client identified as: ${ws.clientType}`)
    const state = buildStateMessage()
    ws.send(JSON.stringify(state))
    return
  }
  if (msg.type === 'command') {
    handleCommand(msg as unknown as WSCommandMessage)
  }
}

async function handleCommand(cmd: WSCommandMessage): Promise<void> {
  try {
    logger.app.info(`WebSocket command: ${cmd.action}${cmd.element ? ' ' + cmd.element : ''}`)
    const obsState = obs.getState()

    switch (cmd.action) {
      case 'nextFull':
        await recording.nextFull()
        break
      case 'nextRoutine':
        await recording.next()
        break
      case 'prev':
        await recording.prev()
        break
      case 'skip': {
        const current = stateService.getCurrentRoutine()
        if (current) {
          if (current.status === 'skipped') stateService.unskipRoutine(current.id)
          else stateService.skipRoutine(current.id)
          recording.broadcastFullState()
        }
        break
      }
      case 'toggleRecord':
        if (obsState.connectionStatus === 'connected') {
          if (obsState.isRecording) await obs.stopRecord()
          else await obs.startRecord()
        }
        break
      case 'toggleStream':
        if (obsState.connectionStatus === 'connected') {
          if (obsState.isStreaming) await obs.stopStream()
          else await obs.startStream()
        }
        break
      case 'saveReplay':
        if (obsState.connectionStatus === 'connected') {
          await obs.saveReplay()
        }
        break
      case 'toggleOverlay':
        if (cmd.element) {
          overlay.toggleElement(cmd.element)
        }
        break
    }
    broadcastState()
  } catch (err) {
    logger.app.error(`WebSocket command ${cmd.action} failed:`, err instanceof Error ? err.message : String(err))
  }
}

function buildStateMessage(): WSStateMessage {
  const comp = stateService.getCompetition()
  const current = stateService.getCurrentRoutine()
  const next = stateService.getNextRoutine()
  const obsState = obs.getState()
  const overlayState = overlay.getOverlayState()
  const skippedCount = comp ? comp.routines.filter(r => r.status === 'skipped').length : 0

  return {
    type: 'state',
    routine: current ? {
      entryNumber: current.entryNumber,
      routineTitle: current.routineTitle,
      dancers: current.dancers,
      studioName: current.studioName,
      category: `${current.ageGroup} ${current.category}`,
    } : null,
    nextRoutine: next ? {
      entryNumber: next.entryNumber,
      routineTitle: next.routineTitle,
    } : null,
    index: stateService.getCurrentRoutineIndex(),
    total: comp ? comp.routines.filter(r => r.status !== 'skipped').length : 0,
    recording: { active: obsState.isRecording, elapsed: obsState.recordTimeSec },
    streaming: obsState.isStreaming,
    skippedCount,
    overlay: overlayState,
  }
}

export function broadcastState(): void {
  if (clients.size === 0) return
  const msg = JSON.stringify(buildStateMessage())
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  }
}
