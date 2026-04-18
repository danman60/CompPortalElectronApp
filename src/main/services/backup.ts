import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { PassThrough } from 'stream'
import type { BackupProgress, BackupResult, BackupFailure } from '../../shared/types'
import { getSettings } from './settings'
import { getCompetition } from './state'
import { logger } from '../logger'

interface FileEntry { src: string; rel: string; size: number; mtimeMs: number }

let running = false
let cancelFlag = false
let onProgress: ((p: BackupProgress) => void) | null = null

const PROGRESS_INTERVAL_MS = 250

export function isBackupRunning(): boolean {
  return running
}

export function cancelBackup(): void {
  if (!running) return
  cancelFlag = true
  logger.app.info('Backup cancel requested')
}

export function setProgressListener(cb: (p: BackupProgress) => void): void {
  onProgress = cb
}

async function walk(root: string, out: FileEntry[], rootLabel: string): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (err) {
    logger.app.warn(`Backup walk: cannot read ${root}: ${err instanceof Error ? err.message : err}`)
    return
  }
  for (const e of entries) {
    const abs = path.join(root, e.name)
    if (e.isDirectory()) {
      await walk(abs, out, rootLabel)
    } else if (e.isFile()) {
      try {
        const st = await fs.promises.stat(abs)
        out.push({
          src: abs,
          rel: path.join(rootLabel, path.relative(root, abs)),
          size: st.size,
          mtimeMs: st.mtimeMs,
        })
      } catch {}
    }
  }
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'CompSync'
}

function todayStamp(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function getFreeBytes(dir: string): Promise<number> {
  try {
    const probe = process.platform === 'win32' && /^[A-Za-z]:/.test(dir) ? dir.slice(0, 3) : dir
    const s = fs.statfsSync(probe)
    return s.bavail * s.bsize
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export async function startBackup(targetRoot: string): Promise<BackupResult> {
  if (running) throw new Error('Backup already running')
  running = true
  cancelFlag = false
  const startTime = Date.now()

  const result: BackupResult = {
    targetDir: '',
    succeeded: 0,
    skipped: 0,
    failed: [],
    totalBytes: 0,
    elapsedSec: 0,
    cancelled: false,
  }

  try {
    const settings = getSettings()
    const srcRoots: Array<{ path: string; label: string }> = []
    if (settings.fileNaming?.outputDirectory) {
      srcRoots.push({ path: settings.fileNaming.outputDirectory, label: 'recordings' })
    }
    if (settings.tether?.autoWatchFolder) {
      srcRoots.push({ path: settings.tether.autoWatchFolder, label: 'photos' })
    }
    if (srcRoots.length === 0) throw new Error('No source folders configured (recording output + tether)')

    const comp = getCompetition()
    const compName = sanitizeFolderName(comp?.name || 'CompSync')
    const targetDir = path.join(targetRoot, `CompSync-Backup-${compName}-${todayStamp()}`)
    result.targetDir = targetDir

    // --- Scan phase ---
    emitProgress({
      phase: 'scanning', bytesDone: 0, filesDone: 0, totalBytes: 0, totalFiles: 0,
      currentFile: '', bytesPerSec: 0, etaSec: 0,
    }, true)

    const allFiles: FileEntry[] = []
    for (const r of srcRoots) {
      if (!fs.existsSync(r.path)) {
        logger.app.warn(`Backup: source root missing, skipping: ${r.path}`)
        continue
      }
      await walk(r.path, allFiles, r.label)
      if (cancelFlag) break
    }

    const totalBytes = allFiles.reduce((s, f) => s + f.size, 0)
    const totalFiles = allFiles.length

    if (cancelFlag) {
      result.cancelled = true
      return result
    }

    // --- Free space check ---
    const free = await getFreeBytes(targetRoot)
    if (free < totalBytes * 1.05) {
      throw new Error(`Target has ${formatGB(free)} free but backup needs ${formatGB(totalBytes * 1.05)}`)
    }

    await fs.promises.mkdir(targetDir, { recursive: true })

    // --- Copy phase ---
    let bytesDone = 0
    let filesDone = 0
    let lastEmit = 0
    let lastBytesSnap = 0
    let lastTimeSnap = Date.now()
    let bytesPerSec = 0

    for (const f of allFiles) {
      if (cancelFlag) { result.cancelled = true; break }
      const destAbs = path.join(targetDir, f.rel)
      try {
        await fs.promises.mkdir(path.dirname(destAbs), { recursive: true })
      } catch (err) {
        result.failed.push({ path: f.src, error: `mkdir: ${err instanceof Error ? err.message : err}` })
        continue
      }

      // Skip if target exists with matching size + mtime (resume)
      let skip = false
      try {
        const tst = await fs.promises.stat(destAbs)
        if (tst.size === f.size && Math.abs(tst.mtimeMs - f.mtimeMs) < 2000) {
          skip = true
        }
      } catch {}

      if (skip) {
        result.skipped++
        filesDone++
        bytesDone += f.size
        maybeEmit()
        continue
      }

      // Stream copy with byte counter
      try {
        await streamCopy(f.src, destAbs, (chunkBytes) => {
          bytesDone += chunkBytes
          maybeEmit()
        })
        try { await fs.promises.utimes(destAbs, new Date(), new Date(f.mtimeMs)) } catch {}
        result.succeeded++
      } catch (err) {
        result.failed.push({ path: f.src, error: err instanceof Error ? err.message : String(err) })
        try { await fs.promises.unlink(destAbs) } catch {}
      }
      filesDone++
      maybeEmit(true, f.rel)
    }

    result.totalBytes = totalBytes
    result.elapsedSec = (Date.now() - startTime) / 1000
    return result

    function maybeEmit(force = false, current?: string): void {
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
      const dt = (now - lastTimeSnap) / 1000
      if (dt >= 0.5) {
        bytesPerSec = (bytesDone - lastBytesSnap) / dt
        lastBytesSnap = bytesDone
        lastTimeSnap = now
      }
      const remaining = totalBytes - bytesDone
      const etaSec = bytesPerSec > 0 ? Math.round(remaining / bytesPerSec) : 0
      emitProgress({
        phase: 'copying',
        bytesDone,
        filesDone,
        totalBytes,
        totalFiles,
        currentFile: current || '',
        bytesPerSec: Math.round(bytesPerSec),
        etaSec,
      })
      lastEmit = now
    }
  } finally {
    running = false
    cancelFlag = false
  }
}

function emitProgress(p: BackupProgress, force = false): void {
  if (!onProgress) return
  try { onProgress(p) } catch (err) {
    if (force) logger.app.warn(`Backup progress emit failed: ${err instanceof Error ? err.message : err}`)
  }
}

async function streamCopy(src: string, dest: string, onBytes: (n: number) => void): Promise<void> {
  const rs = fs.createReadStream(src, { highWaterMark: 1024 * 1024 })
  const ws = fs.createWriteStream(dest)
  const counter = new PassThrough()
  counter.on('data', (chunk: Buffer) => onBytes(chunk.length))
  if (cancelFlag) {
    rs.destroy()
    throw new Error('Cancelled')
  }
  const cancelInterval = setInterval(() => {
    if (cancelFlag) rs.destroy(new Error('Cancelled'))
  }, 200)
  try {
    await pipeline(rs, counter, ws)
  } finally {
    clearInterval(cancelInterval)
  }
}

function formatGB(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`
}

export { BackupResult, BackupFailure }
