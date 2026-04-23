import os from 'os'
import { app } from 'electron'
import * as state from './state'
import * as obs from './obs'
import * as jobQueue from './jobQueue'
import * as events from './events'
import * as upload from './upload'
import * as ffmpeg from './ffmpeg'
import * as wsHub from './wsHub'
import * as chatBridge from './chatBridge'
import * as systemMonitor from './systemMonitor'
import { getResolvedConnection } from './schedule'
import { getSettings } from './settings'
import { logger } from '../logger'
import type { WSCommandMessage } from '../../shared/types'

const HEARTBEAT_INTERVAL_MS = 5000
const COMMAND_POLL_INTERVAL_MS = 3000
const REQUEST_TIMEOUT_MS = 15000
const MAX_EVENTS = 80
const MAX_HEARTBEAT_CHAT_MESSAGES = 20

let heartbeatTimer: NodeJS.Timeout | null = null
let commandPollTimer: NodeJS.Timeout | null = null
let inFlightHeartbeat = false
let inFlightPoll = false
let endpointDisabledUntil = 0
let endpointDisabledLogged = false

function endpointTemporarilyDisabled(): boolean {
  return Date.now() < endpointDisabledUntil
}

function disableEndpointTemporarily(status: number): void {
  endpointDisabledUntil = Date.now() + 5 * 60 * 1000
  if (!endpointDisabledLogged) {
    endpointDisabledLogged = true
    logger.app.warn(`control-room endpoint unavailable (HTTP ${status}); backing off for 5 minutes`)
  }
}

function withTimeout(ms: number): AbortController {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller
}

function mapQueueCounts() {
  const all = jobQueue.getAll()
  const byStatus: Record<string, number> = {}
  const byType: Record<string, number> = {}
  for (const job of all) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1
    byType[job.type] = (byType[job.type] || 0) + 1
  }
  return {
    total: all.length,
    byStatus,
    byType,
    uploadPending: jobQueue.getPending('upload').length,
    uploadRunning: jobQueue.getRunning('upload').length,
    uploadQuarantined: jobQueue.getQuarantined('upload').length,
    encodePending: jobQueue.getPending('encode').length,
    encodeRunning: jobQueue.getRunning('encode').length,
  }
}

function linearToDb(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return -100
  return Math.max(-100, Math.round(20 * Math.log10(peak) * 10) / 10)
}

function mapAudioLevels() {
  const audioRuntime = obs.getAudioRuntimeState()
  const mapping = getSettings().audioInputMapping || {}
  const mapped = Object.entries(mapping)
    .filter(([, inputName]) => Boolean(inputName))
    .map(([role, inputName]) => {
      const src = audioRuntime.levels.find((level) => level.inputName === inputName)
      const peak = src?.levels.length ? Math.max(...src.levels) : 0
      return {
        role,
        inputName,
        peak,
        db: linearToDb(peak),
        silent: peak <= 0.001,
      }
    })
  return {
    mapped,
    silentSince: audioRuntime.silentSince ? new Date(audioRuntime.silentSince).toISOString() : null,
    silenceAlertFired: audioRuntime.silenceAlertFired,
  }
}

function mapRoutines() {
  const comp = state.getCompetition()
  if (!comp) return []
  return comp.routines.map((routine) => {
    const photos = routine.photos || []
    const videos = routine.encodedFiles || []
    return {
      id: routine.id,
      entryNumber: routine.entryNumber,
      title: routine.routineTitle,
      studioName: routine.studioName,
      status: routine.status,
      mediaPackageStatus: routine.mediaPackageStatus || null,
      notes: routine.notes || '',
      photoCount: photos.length,
      uploadedPhotos: photos.filter((photo) => photo.uploaded).length,
      videoCount: videos.length,
      uploadedVideos: videos.filter((video) => video.uploaded).length,
      uploadProgress: routine.uploadProgress || null,
    }
  })
}

function buildSnapshot() {
  const comp = state.getCompetition()
  const current = state.getCurrentRoutine()
  const next = state.getNextRoutine()
  const uploadState = upload.getUploadRuntimeState()
  const encodeState = ffmpeg.getEncodingRuntimeState()
  const systemStats = systemMonitor.getLastStats()
  const chatMessages = chatBridge.getChatMessages()
  return {
    machine: {
      hostname: os.hostname(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    system: systemStats ? {
      cpuPercent: systemStats.cpuPercent,
      memPercent: systemStats.memPercent,
      diskFreeGB: systemStats.diskFreeGB,
      diskTotalGB: systemStats.diskTotalGB,
      freeBytes: systemStats.freeBytes,
      totalBytes: systemStats.totalBytes,
      timestamp: systemStats.timestamp,
    } : null,
    competition: comp ? {
      id: comp.competitionId,
      name: comp.name,
      routineCount: comp.routines.length,
      loadedAt: comp.loadedAt,
    } : null,
    currentRoutine: current ? {
      id: current.id,
      entryNumber: current.entryNumber,
      title: current.routineTitle,
      studioName: current.studioName,
      status: current.status,
      uploadProgress: current.uploadProgress || null,
    } : null,
    nextRoutine: next ? {
      id: next.id,
      entryNumber: next.entryNumber,
      title: next.routineTitle,
      studioName: next.studioName,
      status: next.status,
    } : null,
    obs: obs.getState(),
    uploads: uploadState,
    encoding: encodeState,
    queue: mapQueueCounts(),
    audio: mapAudioLevels(),
    routines: mapRoutines(),
    chat: {
      messages: chatMessages.slice(-MAX_HEARTBEAT_CHAT_MESSAGES),
      messageCount: chatMessages.length,
      pinned: chatBridge.getPinnedMessages(),
    },
    routineCounts: {
      active: state.getActiveCount(),
      skipped: state.getSkippedCount(),
    },
    cameraOffsets: state.listCameraOffsets(),
    sdWatermarks: state.listSdWatermarks(),
    recentEvents: events.getRecent(MAX_EVENTS),
  }
}

async function postHeartbeat(): Promise<void> {
  const conn = getResolvedConnection()
  if (!conn || inFlightHeartbeat) return
  if (endpointTemporarilyDisabled()) return
  inFlightHeartbeat = true
  const controller = withTimeout(REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${conn.apiBase}/api/plugin/control-room/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body: JSON.stringify({
        competitionId: conn.competitionId,
        snapshot: buildSnapshot(),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 404 || response.status === 405) {
        disableEndpointTemporarily(response.status)
        return
      }
      const text = await response.text().catch(() => '')
      logger.app.warn(`control-room heartbeat ${response.status}: ${text.slice(0, 160)}`)
    } else {
      endpointDisabledLogged = false
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.app.warn(`control-room heartbeat failed: ${msg}`)
  } finally {
    inFlightHeartbeat = false
  }
}

async function ackCommand(
  commandId: string,
  status: 'completed' | 'failed',
  result?: string,
): Promise<void> {
  const conn = getResolvedConnection()
  if (!conn) return
  const controller = withTimeout(REQUEST_TIMEOUT_MS)
  try {
    await fetch(`${conn.apiBase}/api/plugin/control-room/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body: JSON.stringify({
        competitionId: conn.competitionId,
        commandId,
        status,
        result,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.app.warn(`control-room command ack failed: ${msg}`)
  }
}

async function pollCommands(): Promise<void> {
  const conn = getResolvedConnection()
  if (!conn || inFlightPoll) return
  if (endpointTemporarilyDisabled()) return
  inFlightPoll = true
  const controller = withTimeout(REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${conn.apiBase}/api/plugin/control-room/commands?competitionId=${encodeURIComponent(conn.competitionId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 404 || response.status === 405) {
        disableEndpointTemporarily(response.status)
        return
      }
      const text = await response.text().catch(() => '')
      logger.app.warn(`control-room poll ${response.status}: ${text.slice(0, 160)}`)
      return
    }
    endpointDisabledLogged = false
    const body = await response.json() as {
      commands?: Array<{
        id: string
        action: WSCommandMessage['action']
        issuedBy?: string
        routineId?: string
        chatMessageId?: string
        cameraBody?: string
        offsetMs?: number
      }>
    }
    for (const command of body.commands || []) {
      try {
        await wsHub.executeCommand({
          type: 'command',
          action: command.action,
          routineId: command.routineId,
          chatMessageId: command.chatMessageId,
          cameraBody: command.cameraBody,
          offsetMs: command.offsetMs,
        })
        events.emit('control-room.command.completed', {
          commandId: command.id,
          action: command.action,
          issuedBy: command.issuedBy || null,
        })
        await ackCommand(command.id, 'completed', 'ok')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        events.emit('control-room.command.failed', {
          commandId: command.id,
          action: command.action,
          issuedBy: command.issuedBy || null,
          error: msg,
        })
        await ackCommand(command.id, 'failed', msg)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.app.warn(`control-room command poll failed: ${msg}`)
  } finally {
    inFlightPoll = false
  }
}

export function start(): void {
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      void postHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }
  if (!commandPollTimer) {
    commandPollTimer = setInterval(() => {
      void pollCommands()
    }, COMMAND_POLL_INTERVAL_MS)
  }
  void postHeartbeat()
  void pollCommands()
}

export function stop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (commandPollTimer) {
    clearInterval(commandPollTimer)
    commandPollTimer = null
  }
}
