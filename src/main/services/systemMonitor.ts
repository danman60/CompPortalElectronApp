import os from 'os'
import fs from 'fs'
import { SystemStats, IPC_CHANNELS } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { getSettings } from './settings'
import { logger } from '../logger'
import * as uploadService from './upload'
import * as ffmpegService from './ffmpeg'
import * as perf from './perfLogger'

let pollTimer: NodeJS.Timeout | null = null
let prevCpuTimes: { idle: number; total: number } | null = null

// Fix 8: disk space alert transitions
type DiskAlertLevel = 'ok' | 'warning' | 'high' | 'critical'
let lastDiskAlertLevel: DiskAlertLevel = 'ok'

// Fix 9: drive lost tracking
let driveLost = false
let lastWatchedPath: string | null = null

function classifyDisk(freeGB: number): DiskAlertLevel {
  if (freeGB < 5) return 'critical'
  if (freeGB < 20) return 'high'
  if (freeGB < 50) return 'warning'
  return 'ok'
}

function getCpuTimes(): { idle: number; total: number } {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
  }
  return { idle, total }
}

function getCpuPercent(): number {
  const current = getCpuTimes()
  if (!prevCpuTimes) {
    prevCpuTimes = current
    return 0
  }
  const idleDelta = current.idle - prevCpuTimes.idle
  const totalDelta = current.total - prevCpuTimes.total
  prevCpuTimes = current
  if (totalDelta === 0) return 0
  return Math.round((1 - idleDelta / totalDelta) * 100)
}

function getDiskStats(dir: string): { freeGB: number; totalGB: number } {
  try {
    // On Windows, statfsSync needs the drive root
    const drive = dir.match(/^[a-zA-Z]:\\/) ? dir.slice(0, 3) : dir
    const stats = fs.statfsSync(drive)
    const blockSize = stats.bsize
    const freeGB = (stats.bavail * blockSize) / (1024 * 1024 * 1024)
    const totalGB = (stats.blocks * blockSize) / (1024 * 1024 * 1024)
    return { freeGB: Math.round(freeGB * 10) / 10, totalGB: Math.round(totalGB * 10) / 10 }
  } catch {
    return { freeGB: -1, totalGB: -1 }
  }
}

function poll(): void {
  const settings = getSettings()
  const configuredDir = settings.fileNaming.outputDirectory
  const outputDir = configuredDir || 'C:\\'

  const cpuPercent = getCpuPercent()
  const disk = getDiskStats(outputDir)

  // Memory stats (commit 3)
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()
  const memPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0

  const stats: SystemStats = {
    cpuPercent,
    diskFreeGB: disk.freeGB,
    diskTotalGB: disk.totalGB,
    memPercent,
    freeBytes,
    totalBytes,
    timestamp: Date.now(),
  }

  sendToRenderer(IPC_CHANNELS.SYSTEM_STATS, stats)
  perf.gauge('sys.cpu_pct', cpuPercent)
  perf.gauge('sys.mem_pct', memPercent)
  if (disk.freeGB >= 0) perf.gauge('sys.disk_free_gb', disk.freeGB)

  // Fix 9: drive lost / recovered detection
  if (configuredDir) {
    const accessible = fs.existsSync(configuredDir) && disk.freeGB >= 0
    if (!accessible) {
      if (!driveLost) {
        driveLost = true
        lastWatchedPath = configuredDir
        logger.app.error(`Drive lost: ${configuredDir}`)
        sendToRenderer(IPC_CHANNELS.DRIVE_LOST, { path: configuredDir })
        try { uploadService.pauseForDriveLoss() } catch {}
        try { ffmpegService.pauseForDriveLoss() } catch {}
      }
      return
    }
    if (driveLost && accessible) {
      driveLost = false
      const path = lastWatchedPath || configuredDir
      logger.app.info(`Drive recovered: ${path}`)
      sendToRenderer(IPC_CHANNELS.DRIVE_RECOVERED, { path })
      try { uploadService.resumeFromDriveLoss() } catch {}
      try { ffmpegService.resumeFromDriveLoss() } catch {}
    }
  }

  // Fix 8: disk space alert transitions with hysteresis
  if (disk.freeGB >= 0) {
    let level: DiskAlertLevel | null = null
    if (lastDiskAlertLevel !== 'ok' && disk.freeGB >= 60) {
      level = 'ok'
    } else if (lastDiskAlertLevel === 'ok') {
      const c = classifyDisk(disk.freeGB)
      if (c !== 'ok') level = c
    } else {
      const c = classifyDisk(disk.freeGB)
      if (c !== lastDiskAlertLevel && c !== 'ok') level = c
    }
    if (level !== null && level !== lastDiskAlertLevel) {
      const prev = lastDiskAlertLevel
      lastDiskAlertLevel = level
      logger.app.warn(`Disk space alert level: ${level} (${disk.freeGB}GB free)`)
      sendToRenderer(IPC_CHANNELS.DISK_SPACE_ALERT, { level, freeGB: disk.freeGB })
      if (level === 'critical') {
        try { uploadService.pauseForDiskSpace() } catch {}
      } else if (level === 'ok' && prev === 'critical') {
        try { uploadService.resumeFromDiskSpace() } catch {}
      }
    }
  }
}

export function startMonitoring(): void {
  if (pollTimer) return
  // Prime the CPU baseline
  prevCpuTimes = getCpuTimes()
  pollTimer = setInterval(poll, 5000)
  logger.app.info('System monitor started (5s interval)')
}

export function stopMonitoring(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
