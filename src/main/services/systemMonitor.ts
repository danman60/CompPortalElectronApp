import os from 'os'
import fs from 'fs'
import { SystemStats, IPC_CHANNELS } from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { getSettings } from './settings'
import { logger } from '../logger'

let pollTimer: NodeJS.Timeout | null = null
let prevCpuTimes: { idle: number; total: number } | null = null

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
  const outputDir = settings.fileNaming.outputDirectory || 'C:\\'

  const cpuPercent = getCpuPercent()
  const disk = getDiskStats(outputDir)

  const stats: SystemStats = {
    cpuPercent,
    diskFreeGB: disk.freeGB,
    diskTotalGB: disk.totalGB,
  }

  sendToRenderer(IPC_CHANNELS.SYSTEM_STATS, stats)
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
