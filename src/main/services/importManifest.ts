import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export interface ManifestEntry {
  sourcePath: string
  sourceHash: string
  routineId: string | null
  entryNumber: string | null
  destPath: string
  uploaded: boolean
  storagePath?: string
  importedAt: string
  uploadedAt?: string
}

interface ManifestRun {
  importRunId: string
  sourceFolder: string
  entries: ManifestEntry[]
}

interface Manifest {
  outputDir: string
  runs: ManifestRun[]
}

function manifestDir(outputDir: string): string {
  return path.join(outputDir, '_manifests')
}

function currentManifestPath(outputDir: string): string {
  return path.join(manifestDir(outputDir), 'sd-import.json')
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  const fh = await fs.promises.open(tmp, 'w')
  try {
    await fh.writeFile(content, 'utf-8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.promises.rename(tmp, filePath)
}

export async function loadManifest(outputDir: string): Promise<Manifest> {
  const p = currentManifestPath(outputDir)
  try {
    const raw = await fs.promises.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw) as Manifest
    if (!parsed.runs) parsed.runs = []
    return parsed
  } catch {
    return { outputDir, runs: [] }
  }
}

export async function appendEntries(
  outputDir: string,
  importRunId: string,
  sourceFolder: string,
  entries: ManifestEntry[],
): Promise<void> {
  const manifest = await loadManifest(outputDir)
  let run = manifest.runs.find((r) => r.importRunId === importRunId)
  if (!run) {
    run = { importRunId, sourceFolder, entries: [] }
    manifest.runs.push(run)
  }
  run.entries.push(...entries)
  await writeAtomic(currentManifestPath(outputDir), JSON.stringify(manifest, null, 2))

  const history = path.join(manifestDir(outputDir), `sd-import-${importRunId.replace(/[:.]/g, '-')}.json`)
  try {
    await writeAtomic(history, JSON.stringify({ outputDir, runs: [run] }, null, 2))
  } catch {
    // History snapshot is best-effort; the canonical manifest is what matters.
  }
}

export async function markUploaded(
  outputDir: string,
  sourceHash: string,
  storagePath: string,
): Promise<void> {
  const manifest = await loadManifest(outputDir)
  const uploadedAt = new Date().toISOString()
  let mutated = false
  for (const run of manifest.runs) {
    for (const entry of run.entries) {
      if (entry.sourceHash === sourceHash && !entry.uploaded) {
        entry.uploaded = true
        entry.storagePath = storagePath
        entry.uploadedAt = uploadedAt
        mutated = true
      }
    }
  }
  if (!mutated) return
  await writeAtomic(currentManifestPath(outputDir), JSON.stringify(manifest, null, 2))
}

export async function getUploadedHashes(outputDir: string): Promise<Set<string>> {
  const manifest = await loadManifest(outputDir)
  const hashes = new Set<string>()
  for (const run of manifest.runs) {
    for (const entry of run.entries) {
      if (entry.uploaded && entry.sourceHash) hashes.add(entry.sourceHash)
    }
  }
  return hashes
}

export async function computeSourceHash(filePath: string): Promise<string> {
  const HEADER = 128 * 1024
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(HEADER)
    const { bytesRead } = await fh.read(buf, 0, HEADER, 0)
    const hash = crypto.createHash('sha1')
    hash.update(buf.subarray(0, bytesRead))
    return hash.digest('hex')
  } finally {
    await fh.close()
  }
}
