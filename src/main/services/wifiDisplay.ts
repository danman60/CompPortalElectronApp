import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { app, screen } from 'electron'
import { WifiDisplayState, MonitorInfo } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'

let childProc: ChildProcess | null = null
let running = false
let activeMonitorIndex: number | null = null

const PID_FILE = 'wifi-display.pid'

function getPidFilePath(): string {
  return path.join(app.getPath('userData'), PID_FILE)
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

  if (!wd.binaryPath) {
    throw new Error('Wifi display binary path not configured')
  }
  if (!fs.existsSync(wd.binaryPath)) {
    throw new Error(`Wifi display binary not found: ${wd.binaryPath}`)
  }
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

  logger.app.info(`Starting wifi display: ${wd.binaryPath} ${args.join(' ')}`)

  childProc = spawn(wd.binaryPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  if (childProc.pid) {
    writePid(childProc.pid)
    running = true
    activeMonitorIndex = wd.monitorIndex
    logger.app.info(`Wifi display started (PID ${childProc.pid})`)
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
