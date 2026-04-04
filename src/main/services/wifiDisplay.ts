import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import dgram from 'dgram'
import os from 'os'
import { app, screen } from 'electron'
import { WifiDisplayState, MonitorInfo } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'

let childProc: ChildProcess | null = null
let running = false
let activeMonitorIndex: number | null = null
let resolvedBinaryPath: string | null = null

let discoverySocket: dgram.Socket | null = null
let discoveryInterval: NodeJS.Timeout | null = null
const DISCOVERY_PORT = 5002

function getLocalIp(): string {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '0.0.0.0'
}

function getDiscoveryPayload(): Buffer {
  const settings = getSettings()
  const wd = settings.wifiDisplay
  return Buffer.from(JSON.stringify({
    type: 'compsync-discover',
    host: getLocalIp(),
    videoPort: wd.videoPort,
    touchPort: wd.touchPort,
    wsPort: 9877,
    name: os.hostname(),
  }))
}

function startDiscoveryListener(): void {
  stopDiscoveryListener()

  discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

  discoverySocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString())
      if (data.type === 'compsync-discover-request' && running) {
        const reply = getDiscoveryPayload()
        discoverySocket?.send(reply, 0, reply.length, rinfo.port, rinfo.address)
        logger.app.debug(`Discovery reply sent to ${rinfo.address}:${rinfo.port}`)
      }
    } catch {}
  })

  discoverySocket.bind(DISCOVERY_PORT, () => {
    logger.app.info(`Discovery listener on port ${DISCOVERY_PORT}`)
    // Broadcast once on start so tablets already listening pick it up
    discoverySocket!.setBroadcast(true)
    const payload = getDiscoveryPayload()
    discoverySocket!.send(payload, 0, payload.length, DISCOVERY_PORT, '255.255.255.255')
  })
}

function stopDiscoveryListener(): void {
  if (discoveryInterval) { clearInterval(discoveryInterval); discoveryInterval = null }
  if (discoverySocket) { try { discoverySocket.close() } catch {} discoverySocket = null }
}

const PID_FILE = 'wifi-display.pid'
const BINARY_NAME = 'wifi-display-server.exe'

function getPidFilePath(): string {
  return path.join(app.getPath('userData'), PID_FILE)
}

function getBinaryPath(): string {
  if (resolvedBinaryPath) return resolvedBinaryPath

  // 1. Check resources directory (bundled with app)
  const resourcePath = path.join(process.resourcesPath || '.', BINARY_NAME)
  if (fs.existsSync(resourcePath)) {
    // Copy to userData to avoid EBUSY lock on resources/ directory
    const userDataCopy = path.join(app.getPath('userData'), BINARY_NAME)
    try {
      const srcStat = fs.statSync(resourcePath)
      const dstExists = fs.existsSync(userDataCopy)
      if (!dstExists || fs.statSync(userDataCopy).size !== srcStat.size) {
        fs.copyFileSync(resourcePath, userDataCopy)
        logger.app.info(`Copied ${BINARY_NAME} to userData`)
      }
      resolvedBinaryPath = userDataCopy
      return resolvedBinaryPath
    } catch (err) {
      logger.app.warn(`Failed to copy ${BINARY_NAME} to userData, using resources path: ${err}`)
      resolvedBinaryPath = resourcePath
      return resolvedBinaryPath
    }
  }

  // 2. Check userData directory (manually placed)
  const userDataPath = path.join(app.getPath('userData'), BINARY_NAME)
  if (fs.existsSync(userDataPath)) {
    resolvedBinaryPath = userDataPath
    return resolvedBinaryPath
  }

  throw new Error(
    `${BINARY_NAME} not found. Place it in ${path.dirname(resourcePath)} or ${path.dirname(userDataPath)}`
  )
}

function writePid(pid: number): void {
  try {
    fs.writeFileSync(getPidFilePath(), String(pid))
  } catch {}
}

function clearPid(): void {
  try {
    const pidPath = getPidFilePath()
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath)
  } catch {}
}

export function getMonitors(): MonitorInfo[] {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label || `Display ${d.id}`,
    width: d.size.width,
    height: d.size.height,
    x: d.bounds.x,
    y: d.bounds.y,
  }))
}

export async function start(): Promise<void> {
  if (running && childProc) {
    logger.app.warn('Wifi display already running')
    return
  }

  const settings = getSettings()
  const wd = settings.wifiDisplay
  const binaryPath = getBinaryPath()

  if (wd.monitorIndex === null) {
    throw new Error('No monitor selected for wifi display')
  }

  const args = [
    '--monitor-index', String(wd.monitorIndex),
    '--bitrate', String(wd.bitrate),
    '--fps', String(wd.fps),
    '--video-port', String(wd.videoPort),
    '--touch-port', String(wd.touchPort),
  ]

  if (wd.clientIp) {
    args.push('--client', wd.clientIp)
  }

  logger.app.info(`Starting wifi display: ${binaryPath} ${args.join(' ')}`)

  childProc = spawn(binaryPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  if (childProc.pid) {
    writePid(childProc.pid)
    running = true
    activeMonitorIndex = wd.monitorIndex
    logger.app.info(`Wifi display started (PID ${childProc.pid})`)
    startDiscoveryListener()
  }

  childProc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) {
      logger.app.debug(`[wifi-display] ${line}`)
    }
  })

  childProc.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) {
      logger.app.debug(`[wifi-display] ${line}`)
    }
  })

  childProc.on('exit', (code, signal) => {
    logger.app.info(`Wifi display exited (code=${code}, signal=${signal})`)
    running = false
    activeMonitorIndex = null
    childProc = null
    clearPid()
  })

  childProc.on('error', (err) => {
    logger.app.error(`Wifi display process error: ${err.message}`)
    running = false
    activeMonitorIndex = null
    childProc = null
    clearPid()
  })
}

export async function stop(): Promise<void> {
  if (!childProc || !running) {
    logger.app.warn('Wifi display not running')
    return
  }

  const proc = childProc
  childProc = null

  stopDiscoveryListener()
  logger.app.info('Stopping wifi display...')

  return new Promise<void>((resolve) => {
    let resolved = false

    proc.on('exit', () => {
      if (!resolved) {
        resolved = true
        running = false
        activeMonitorIndex = null
        clearPid()
        resolve()
      }
    })

    try {
      proc.kill('SIGTERM')
    } catch {}

    setTimeout(() => {
      if (!resolved) {
        try {
          proc.kill('SIGKILL')
        } catch {}
        resolved = true
        running = false
        activeMonitorIndex = null
        clearPid()
        resolve()
      }
    }, 5000)
  })
}

export function getStatus(): WifiDisplayState {
  return {
    running,
    monitorIndex: activeMonitorIndex,
  }
}

export function killOrphanedProcess(): void {
  try {
    const pidPath = getPidFilePath()
    if (!fs.existsSync(pidPath)) return
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
    if (isNaN(pid)) { clearPid(); return }
    try {
      process.kill(pid, 'SIGTERM')
      logger.app.warn(`Killed orphaned wifi-display process (PID ${pid})`)
    } catch {
      // Process already dead
    }
    clearPid()
  } catch {}
}

export function cleanup(): void {
  stopDiscoveryListener()
  if (childProc) {
    try {
      childProc.kill('SIGTERM')
    } catch {}
    childProc = null
  }
  running = false
  activeMonitorIndex = null
  clearPid()
}
