import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { logger } from '../logger'
import type { WPDDevice, WPDDeviceEvent } from '../../shared/types'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type HelperMessage =
  | { type: 'response'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'device-connected' | 'device-disconnected'; device: WPDDevice }
  | { type: 'photo'; path: string; captureTime?: string; deviceName?: string; metadataPath?: string }
  | { type: 'log'; level?: 'info' | 'warn' | 'error'; message: string }

type HelperHandlers = {
  onPhoto?: (event: { path: string; captureTime?: string; deviceName?: string; metadataPath?: string }) => void
  onDeviceEvent?: (event: WPDDeviceEvent) => void
}

let proc: ChildProcessWithoutNullStreams | null = null
let readerClosed = false
let pending = new Map<string, PendingRequest>()
let handlers: HelperHandlers = {}
let requestCounter = 0
let starting: Promise<boolean> | null = null

function helperPath(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'wpd-helper.exe')]
    : [
        path.join(app.getAppPath(), 'tools', 'wpd-helper', 'bin', 'wpd-helper.exe'),
        path.join(
          app.getAppPath(),
          'tools',
          'wpd-helper',
          'bin',
          'Release',
          'net8.0-windows',
          'win-x64',
          'publish',
          'wpd-helper.exe',
        ),
        path.join(
          app.getAppPath(),
          'tools',
          'wpd-helper',
          'bin',
          'Debug',
          'net8.0-windows',
          'win-x64',
          'publish',
          'wpd-helper.exe',
        ),
      ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return candidates[0]
}

function hasHelperBinary(): boolean {
  return fs.existsSync(helperPath())
}

function nextRequestId(): string {
  requestCounter += 1
  return `wpd-${requestCounter}`
}

function rejectPending(reason: Error): void {
  for (const { reject } of pending.values()) reject(reason)
  pending.clear()
}

function handleMessage(message: HelperMessage): void {
  if (message.type === 'response') {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(message.error || 'Unknown WPD helper error'))
    return
  }

  if (message.type === 'device-connected' || message.type === 'device-disconnected') {
    logger.photos.info(`[WPD] Device ${message.type}: ${message.device.name} (${message.device.id})`)
    handlers.onDeviceEvent?.({
      event: message.type,
      device: message.device,
    })
    return
  }

  if (message.type === 'photo') {
    logger.photos.info(`[WPD] Photo event: ${message.path} (captureTime=${message.captureTime || 'none'}, device=${message.deviceName || 'unknown'})`)
    if (!handlers.onPhoto) {
      logger.photos.warn('[WPD] Photo received but no onPhoto handler registered!')
    }
    handlers.onPhoto?.({
      path: message.path,
      captureTime: message.captureTime,
      deviceName: message.deviceName,
      metadataPath: message.metadataPath,
    })
    return
  }

  const level = message.level || 'info'
  const log = level === 'error' ? logger.photos.error : level === 'warn' ? logger.photos.warn : logger.photos.info
  log(`[WPD] ${message.message}`)
}

function writeCommand(command: Record<string, unknown>): void {
  if (!proc || readerClosed) {
    throw new Error('WPD helper is not running')
  }
  proc.stdin.write(JSON.stringify(command) + '\n')
}

async function ensureStarted(): Promise<boolean> {
  if (proc && !readerClosed) {
    logger.photos.debug('[WPD] ensureStarted: already running')
    return true
  }
  if (starting) {
    logger.photos.debug('[WPD] ensureStarted: start in progress, waiting')
    return starting
  }

  const binPath = helperPath()
  logger.photos.info(`[WPD] ensureStarted: checking binary at ${binPath}`)

  starting = new Promise<boolean>((resolve) => {
    if (!hasHelperBinary()) {
      logger.photos.warn(`[WPD] Binary not found at ${binPath} — WPD/MTP tethering disabled`)
      resolve(false)
      starting = null
      return
    }

    logger.photos.info(`[WPD] Spawning helper: ${binPath}`)
    readerClosed = false
    proc = spawn(binPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      logger.photos.debug(`[WPD] stdout: ${line}`)
      try {
        const parsed = JSON.parse(line) as HelperMessage
        handleMessage(parsed)
      } catch {
        logger.photos.warn(`[WPD] Invalid helper output: ${line}`)
      }
    })

    proc.stderr.on('data', (chunk) => {
      logger.photos.warn(`[WPD] stderr: ${chunk.toString().trim()}`)
    })

    proc.once('spawn', () => {
      logger.photos.info(`[WPD] Helper process spawned successfully (PID: ${proc?.pid})`)
      resolve(true)
      starting = null
    })

    proc.once('error', (err) => {
      logger.photos.error(`[WPD] Helper failed to start: ${err.message}`)
      proc = null
      readerClosed = true
      resolve(false)
      starting = null
    })

    proc.once('exit', (code, signal) => {
      readerClosed = true
      proc = null
      rejectPending(new Error(`WPD helper exited (code=${code}, signal=${signal})`))
      logger.photos.info(`[WPD] Helper exited (code=${code}, signal=${signal})`)
    })

    rl.once('close', () => {
      readerClosed = true
      logger.photos.debug('[WPD] stdout reader closed')
    })
  })

  return starting
}

async function call<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const started = await ensureStarted()
  if (!started) {
    throw new Error('WPD helper is not available')
  }

  return await new Promise<T>((resolve, reject) => {
    const id = nextRequestId()
    logger.photos.debug(`[WPD] Sending command: ${command} (id=${id})`)
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    writeCommand({ id, command, ...payload })
  })
}

export function setHandlers(nextHandlers: HelperHandlers): void {
  handlers = nextHandlers
}

export async function startMonitor(): Promise<void> {
  logger.photos.info('[WPD] startMonitor called')
  const started = await ensureStarted()
  if (!started) {
    logger.photos.warn('[WPD] startMonitor: helper not available, skipping')
    return
  }
  try {
    await call('MONITOR_START')
    logger.photos.info('[WPD] Device monitor started successfully')
  } catch (err) {
    logger.photos.warn(`[WPD] Failed to start monitor: ${err instanceof Error ? err.message : err}`)
  }
}

export async function listDevices(): Promise<WPDDevice[]> {
  logger.photos.info('[WPD] Listing devices...')
  try {
    const devices = await call<WPDDevice[]>('LIST_DEVICES')
    logger.photos.info(`[WPD] Found ${devices.length} device(s): ${devices.map(d => `${d.name} (${d.id})`).join(', ') || 'none'}`)
    return devices
  } catch (err) {
    logger.photos.warn(`[WPD] List devices failed: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

export async function watchDevice(deviceId: string, stagingDir: string): Promise<void> {
  logger.photos.info(`[WPD] Starting watch on device ${deviceId}, staging: ${stagingDir}`)
  await call('WATCH', { deviceId, stagingDir })
  logger.photos.info(`[WPD] Watch started for device ${deviceId}`)
}

export async function stopWatching(): Promise<void> {
  if (!proc || readerClosed) return
  try {
    await call('STOP')
  } catch (err) {
    logger.photos.warn(`WPD stop failed: ${err instanceof Error ? err.message : err}`)
  }
}

export async function stop(): Promise<void> {
  if (!proc || readerClosed) return
  try {
    await call('QUIT')
  } catch {
    proc.kill()
  }
}
