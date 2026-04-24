import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import dgram from 'dgram'
import os from 'os'
import { app, screen } from 'electron'
import { WifiDisplayState, MonitorInfo } from '../../shared/types'
import { logger } from '../logger'
import { getSettings, setSettings } from './settings'

let childProc: ChildProcess | null = null
let running = false
let activeMonitorIndex: number | null = null
let resolvedBinaryPath: string | null = null

let discoverySocket: dgram.Socket | null = null
let discoveryInterval: NodeJS.Timeout | null = null
const DISCOVERY_PORT = 5002

let topologyListenersAttached = false
let unexpectedExitAttempts = 0
const MAX_UNEXPECTED_EXIT_RESTARTS = 3
let topologyRestartTimer: NodeJS.Timeout | null = null

/**
 * Pick a safe monitor index from current Electron screen state.
 * - Returns saved if still in range and the display is still present.
 * - Otherwise returns the primary display's position in getAllDisplays().
 * - Returns null only if no displays are connected at all.
 */
function validateMonitorIndex(saved: number | null): number | null {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) return null
  if (saved !== null && saved >= 0 && saved < displays.length) return saved

  const primaryId = screen.getPrimaryDisplay().id
  const primaryIdx = displays.findIndex((d) => d.id === primaryId)
  const fallback = primaryIdx >= 0 ? primaryIdx : 0
  logger.app.warn(
    `wifi display monitorIndex ${saved} invalid for ${displays.length} connected displays — falling back to primary (index ${fallback})`,
  )
  return fallback
}

function scheduleTopologyRestart(reason: string): void {
  if (!running) return
  if (topologyRestartTimer) clearTimeout(topologyRestartTimer)
  // Debounce — display-added/removed often fires multiple times in a burst
  topologyRestartTimer = setTimeout(() => {
    topologyRestartTimer = null
    if (!running) return
    logger.app.info(`Restarting wifi display after ${reason}`)
    stop()
      .then(() => new Promise<void>((r) => setTimeout(r, 500)))
      .then(() => start())
      .catch((err) => logger.app.error(`wifi display restart failed after ${reason}: ${err}`))
  }, 750)
}

function attachTopologyListeners(): void {
  if (topologyListenersAttached) return
  topologyListenersAttached = true
  screen.on('display-added', (_event, display) => {
    logger.app.info(`Display added: id=${display.id} ${display.size.width}x${display.size.height}`)
    scheduleTopologyRestart('display-added')
  })
  screen.on('display-removed', (_event, display) => {
    logger.app.info(`Display removed: id=${display.id}`)
    scheduleTopologyRestart('display-removed')
  })
}

function getLocalIp(): string {
  const interfaces = os.networkInterfaces()
  const candidates: { address: string; priority: number }[] = []

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      // Prefer LAN IPs over Tailscale/virtual adapters
      const addr = iface.address
      if (addr.startsWith('192.168.') || addr.startsWith('10.')) {
        candidates.push({ address: addr, priority: 0 })
      } else if (addr.startsWith('172.')) {
        // Could be private (172.16-31) or virtual — lower priority
        candidates.push({ address: addr, priority: 2 })
      } else if (addr.startsWith('100.')) {
        // Tailscale CGNAT range (100.64-127) — lowest priority
        candidates.push({ address: addr, priority: 3 })
      } else {
        candidates.push({ address: addr, priority: 1 })
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority)
  return candidates[0]?.address || '0.0.0.0'
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
    tabletLogPort: 8766,
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

        // Hardener: if the tablet is discovering us again while wifi-display-server
        // is already running, it usually means the tablet's UdpReceiver was
        // silent long enough to trigger its recovery path (15s of no video). If
        // the tablet's source IP differs from wd.clientIp, the server has been
        // streaming to a stale address. Persist the new IP and respawn the
        // server pointed at it so the recovery completes without operator input.
        try {
          const current = getSettings()
          const savedIp = current.wifiDisplay?.clientIp
          if (savedIp && rinfo.address && rinfo.address !== savedIp) {
            logger.app.warn(
              `Tablet IP drift detected: saved=${savedIp} observed=${rinfo.address} — saving + restarting wifi-display`,
            )
            setSettings({
              wifiDisplay: { ...current.wifiDisplay, clientIp: rinfo.address },
            })
            if (running) {
              // Async restart — don't block the UDP handler thread.
              void (async () => {
                try {
                  await stop()
                  await start()
                  logger.app.info(`Wifi display respawned pointed at ${rinfo.address}`)
                } catch (err) {
                  logger.app.warn(
                    `Wifi display auto-respawn failed: ${err instanceof Error ? err.message : err}`,
                  )
                }
              })()
            }
          }
        } catch (err) {
          logger.app.warn(
            `Tablet IP drift handler failed: ${err instanceof Error ? err.message : err}`,
          )
        }
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

/**
 * Fire a broadcast prompting any listening tablets to re-announce. Used by
 * the "Tablet" button recovery path so operators can force the tablet's
 * UdpReceiver back into a known-good state without restarting the app.
 */
export function pingTabletForDiscovery(): void {
  try {
    if (!discoverySocket) return
    const payload = Buffer.from(JSON.stringify({ type: 'compsync-discover-request' }))
    discoverySocket.send(payload, 0, payload.length, DISCOVERY_PORT, '255.255.255.255')
    logger.app.info('Broadcast discover-request to prompt tablet re-announce')
  } catch (err) {
    logger.app.warn(
      `pingTabletForDiscovery failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

function stopDiscoveryListener(): void {
  if (discoveryInterval) { clearInterval(discoveryInterval); discoveryInterval = null }
  if (discoverySocket) { try { discoverySocket.close() } catch {} discoverySocket = null }
}

const PID_FILE = 'wifi-display.pid'
const BINARY_NAME = 'wifi-display-server.exe'
// mingw runtime DLLs shipped alongside the cross-compiled Rust binary. They
// live in extraResources and must sit next to the exe at spawn time, so we
// copy them into userData together with the exe.
const RUNTIME_DLLS = ['libstdc++-6.dll', 'libgcc_s_seh-1.dll', 'libwinpthread-1.dll']

function getPidFilePath(): string {
  return path.join(app.getPath('userData'), PID_FILE)
}

function copyRuntimeDllsIfNeeded(srcDir: string, destDir: string): void {
  for (const dllName of RUNTIME_DLLS) {
    const src = path.join(srcDir, dllName)
    const dst = path.join(destDir, dllName)
    if (!fs.existsSync(src)) continue
    try {
      const srcStat = fs.statSync(src)
      const dstExists = fs.existsSync(dst)
      if (!dstExists || fs.statSync(dst).size !== srcStat.size) {
        fs.copyFileSync(src, dst)
        logger.app.info(`Copied ${dllName} to userData`)
      }
    } catch (err) {
      logger.app.warn(`Failed to copy ${dllName} to userData: ${err}`)
    }
  }
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
      copyRuntimeDllsIfNeeded(path.dirname(resourcePath), path.dirname(userDataCopy))
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

  attachTopologyListeners()

  const effectiveIndex = validateMonitorIndex(wd.monitorIndex)
  if (effectiveIndex === null) {
    throw new Error('No displays connected — cannot start wifi display')
  }
  if (effectiveIndex !== wd.monitorIndex) {
    logger.app.info(`wifi display using healed monitor index ${effectiveIndex} (saved was ${wd.monitorIndex})`)
  }

  const args = [
    '--monitor-index', String(effectiveIndex),
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
    activeMonitorIndex = effectiveIndex
    unexpectedExitAttempts = 0
    logger.app.info(`Wifi display started (PID ${childProc.pid}, monitor index ${effectiveIndex})`)
    startDiscoveryListener()
    // Prompt any listening tablets to re-announce their current IP within a
    // second of start — closes the "Tablet button doesn't fix it" loop when
    // the tablet's IP drifted since the last start.
    setTimeout(() => { pingTabletForDiscovery() }, 500)
    setTimeout(() => { pingTabletForDiscovery() }, 2000)
  }

  childProc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) {
      // Bumped to warn so binary stderr (usually errors / notable events) is
      // visible in main.log without requiring a log-level change. One-line per
      // write so grep for `[wifi-display]` catches everything.
      logger.app.warn(`[wifi-display] ${line}`)
    }
  })

  childProc.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) {
      // Bumped to info so binary stdout (startup banners, "touch listener on
      // port N", frame stats) lands in main.log by default.
      logger.app.info(`[wifi-display] ${line}`)
    }
  })

  childProc.on('exit', (code, signal) => {
    logger.app.info(`Wifi display exited (code=${code}, signal=${signal})`)
    const wasRunning = running
    running = false
    activeMonitorIndex = null
    childProc = null
    clearPid()

    // Auto-restart on unexpected exit — covers cases where the chosen monitor
    // becomes uncapturable (DXGI failure, DWM glitch, display hot-unplug race).
    // SIGTERM/SIGKILL means stop() asked — don't restart.
    const wasIntentional = signal === 'SIGTERM' || signal === 'SIGKILL'
    if (wasRunning && !wasIntentional && unexpectedExitAttempts < MAX_UNEXPECTED_EXIT_RESTARTS) {
      unexpectedExitAttempts++
      logger.app.warn(
        `Unexpected wifi display exit (code=${code}) — restart attempt ${unexpectedExitAttempts}/${MAX_UNEXPECTED_EXIT_RESTARTS} in 2s`,
      )
      setTimeout(() => {
        start().catch((err) => logger.app.error(`Auto-restart failed: ${err}`))
      }, 2000)
    } else if (wasRunning && !wasIntentional) {
      logger.app.error(
        `Wifi display exceeded ${MAX_UNEXPECTED_EXIT_RESTARTS} restart attempts — giving up until user re-enables in Settings`,
      )
    }
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

  if (topologyRestartTimer) {
    clearTimeout(topologyRestartTimer)
    topologyRestartTimer = null
  }
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
  if (topologyRestartTimer) {
    clearTimeout(topologyRestartTimer)
    topologyRestartTimer = null
  }
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
