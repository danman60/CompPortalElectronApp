import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { PassThrough } from 'stream'
import type { BackupMode, BackupProgress, BackupResult, BackupFailure, BackupStartOptions } from '../../shared/types'
import { getSettings } from './settings'
import { getCompetition } from './state'
import { logger } from '../logger'

interface FileEntry { src: string; rel: string; size: number; mtimeMs: number }
interface SourceRoot { path: string; label: string }

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

async function walk(root: string, out: FileEntry[], rootLabel: string, baseRoot = root, skipDirs = new Set<string>()): Promise<void> {
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
      if (root === baseRoot && skipDirs.has(e.name)) continue
      await walk(abs, out, rootLabel, baseRoot, skipDirs)
    } else if (e.isFile()) {
      try {
        const st = await fs.promises.stat(abs)
        const relPath = path.relative(baseRoot, abs)
        out.push({
          src: abs,
          rel: rootLabel ? path.join(rootLabel, relPath) : relPath,
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

function timestampForFile(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${y}${m}${day}-${h}${min}${s}`
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

export async function startBackup(targetRoot: string, options: BackupStartOptions = {}): Promise<BackupResult> {
  if (running) throw new Error('Backup already running')
  running = true
  cancelFlag = false
  const startTime = Date.now()
  const mode: BackupMode = options.mode === 'all' ? 'all' : 'competition'

  const result: BackupResult = {
    targetDir: '',
    mode,
    succeeded: 0,
    skipped: 0,
    failed: [],
    totalBytes: 0,
    elapsedSec: 0,
    cancelled: false,
    verification: {
      verified: false,
      countsAndBytesMatch: false,
      sourceFiles: 0,
      sourceBytes: 0,
      destinationFiles: 0,
      destinationBytes: 0,
      missing: [],
      sizeMismatched: [],
      extraFiles: [],
    },
  }

  try {
    const settings = getSettings()
    const comp = getCompetition()
    const compName = sanitizeFolderName(comp?.name || 'CompSync')
    const srcRoots = resolveSourceRoots(mode, settings.fileNaming?.outputDirectory || '', settings.tether?.autoWatchFolder || '', compName)
    if (srcRoots.length === 0) throw new Error('No source folders configured (recording output + tether)')
    const targetDir = mode === 'competition'
      ? path.join(targetRoot, compName)
      : path.join(targetRoot, `CompSync-Backup-${compName}-${todayStamp()}`)
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
    if (totalFiles === 0) throw new Error('No files found in selected backup source folders')

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
    if (!result.cancelled) {
      emitProgress({
        phase: 'verifying',
        bytesDone: totalBytes,
        filesDone,
        totalBytes,
        totalFiles,
        currentFile: '',
        bytesPerSec: Math.round(bytesPerSec),
        etaSec: 0,
      }, true)
      result.verification = await verifyBackup(allFiles, targetDir)
      result.verification.manifestPath = await writeManifest(targetDir, {
        mode,
        targetDir,
        sourceRoots: srcRoots,
        result,
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
      })
    }
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

function resolveSourceRoots(mode: BackupMode, outputDirectory: string, tetherFolder: string, compName: string): SourceRoot[] {
  if (mode === 'competition') {
    if (!outputDirectory) return []
    return [{ path: path.join(outputDirectory, compName), label: '' }]
  }

  const srcRoots: SourceRoot[] = []
  if (outputDirectory) srcRoots.push({ path: outputDirectory, label: 'recordings' })
  if (tetherFolder) srcRoots.push({ path: tetherFolder, label: 'photos' })
  return srcRoots
}

async function verifyBackup(sourceFiles: FileEntry[], targetDir: string): Promise<BackupResult['verification']> {
  const destinationFiles: FileEntry[] = []
  if (fs.existsSync(targetDir)) {
    await walk(targetDir, destinationFiles, '', targetDir, new Set(['.compsync-backup']))
  }
  const destinationByRel = new Map(destinationFiles.map((f) => [f.rel, f]))
  const sourceByRel = new Map(sourceFiles.map((f) => [f.rel, f]))
  const missing: BackupFailure[] = []
  const sizeMismatched: BackupFailure[] = []

  for (const f of sourceFiles) {
    const dest = destinationByRel.get(f.rel)
    if (!dest) {
      missing.push({ path: f.rel, error: 'missing from destination' })
    } else if (dest.size !== f.size) {
      sizeMismatched.push({ path: f.rel, error: `source=${f.size} destination=${dest.size}` })
    }
  }

  const extraFiles = destinationFiles
    .filter((f) => !sourceByRel.has(f.rel))
    .map((f) => f.rel)
    .slice(0, 50)
  const sourceBytes = sourceFiles.reduce((sum, f) => sum + f.size, 0)
  const destinationBytes = destinationFiles.reduce((sum, f) => sum + f.size, 0)
  const countsAndBytesMatch = sourceFiles.length === destinationFiles.length && sourceBytes === destinationBytes

  return {
    verified: missing.length === 0 && sizeMismatched.length === 0,
    countsAndBytesMatch,
    sourceFiles: sourceFiles.length,
    sourceBytes,
    destinationFiles: destinationFiles.length,
    destinationBytes,
    missing,
    sizeMismatched,
    extraFiles,
  }
}

async function writeManifest(targetDir: string, payload: unknown): Promise<string> {
  const manifestDir = path.join(targetDir, '.compsync-backup')
  await fs.promises.mkdir(manifestDir, { recursive: true })
  const manifestPath = path.join(manifestDir, `backup-summary-${timestampForFile()}.json`)
  await fs.promises.writeFile(manifestPath, JSON.stringify(payload, null, 2), 'utf-8')
  return manifestPath
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
