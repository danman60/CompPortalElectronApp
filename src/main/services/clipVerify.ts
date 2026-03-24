import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import ExifReader from 'exifreader'
import {
  PhotoMatch,
  Routine,
  ClipSortParams,
  ClipSortResult,
  ClipSortTransition,
  ExecuteSortParams,
  VerificationResult,
  IPC_CHANNELS,
} from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'

// --- Module state ---
let clipPipeline: ((inputs: unknown, options?: Record<string, unknown>) => Promise<unknown>) | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let cancelled = false
const embeddingCache = new Map<string, Float32Array>()
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

// --- Model lifecycle ---

async function ensureModel(): Promise<void> {
  if (clipPipeline) {
    resetIdleTimer()
    return
  }

  logger.photos.info('Loading CLIP model (Xenova/clip-vit-base-patch32)...')
  sendToRenderer(IPC_CHANNELS.CLIP_MODEL_PROGRESS, { status: 'Loading model...', progress: 0 })

  const { pipeline } = await import('@huggingface/transformers')

  clipPipeline = (await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', {
    progress_callback: (progress: { status: string; progress?: number }) => {
      sendToRenderer(IPC_CHANNELS.CLIP_MODEL_PROGRESS, {
        status: progress.status,
        progress: progress.progress ?? 0,
      })
    },
  })) as (inputs: unknown, options?: Record<string, unknown>) => Promise<unknown>

  logger.photos.info('CLIP model loaded')
  sendToRenderer(IPC_CHANNELS.CLIP_MODEL_PROGRESS, { status: 'ready', progress: 100 })
  resetIdleTimer()
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    logger.photos.info('Unloading CLIP model (idle timeout)')
    clipPipeline = null
    embeddingCache.clear()
    idleTimer = null
  }, IDLE_TIMEOUT_MS)
}

// --- Embedding ---

async function getEmbedding(imagePath: string): Promise<Float32Array> {
  const cached = embeddingCache.get(imagePath)
  if (cached) return cached

  await ensureModel()

  // Resize to 224x224 and get raw RGB pixels
  const { data, info } = await sharp(imagePath)
    .resize(224, 224, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Build a RawImage-compatible object for the pipeline
  // The pipeline expects image input — pass the file path directly
  // Transformers.js pipeline('image-feature-extraction') accepts file paths
  const result = await clipPipeline!(imagePath)

  // Result is a Tensor — extract the embedding
  const embedding = extractEmbedding(result)

  // Normalize
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0))
  const normalized = new Float32Array(embedding.length)
  for (let i = 0; i < embedding.length; i++) {
    normalized[i] = embedding[i] / norm
  }

  embeddingCache.set(imagePath, normalized)
  return normalized

  // Suppress unused variable warning — we needed `data` and `info` for the sharp call
  void data
  void info
}

function extractEmbedding(result: unknown): Float32Array {
  // Pipeline returns a Tensor or nested structure
  if (result && typeof result === 'object') {
    // If it has a .data property (Tensor)
    if ('data' in result && (result as { data: unknown }).data instanceof Float32Array) {
      return (result as { data: Float32Array }).data
    }
    // If it's array-like with nested tensor
    if (Array.isArray(result) && result.length > 0) {
      return extractEmbedding(result[0])
    }
    // If it has .tolist() or similar
    if ('tolist' in result && typeof (result as { tolist: () => unknown }).tolist === 'function') {
      const list = (result as { tolist: () => number[][] }).tolist()
      const flat = Array.isArray(list[0]) ? list[0] : list
      return new Float32Array(flat as number[])
    }
  }
  throw new Error('Could not extract embedding from CLIP pipeline result')
}

// --- Similarity ---

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return dot // Already normalized
}

// --- Group fingerprint (mean embedding) ---

async function groupFingerprint(photoPaths: string[]): Promise<Float32Array> {
  if (photoPaths.length === 0) throw new Error('No photos for fingerprint')

  const embeddings = await Promise.all(photoPaths.map((p) => getEmbedding(p)))
  const dim = embeddings[0].length
  const mean = new Float32Array(dim)

  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      mean[i] += emb[i]
    }
  }

  const norm = Math.sqrt(mean.reduce((sum, v) => sum + v * v, 0))
  for (let i = 0; i < dim; i++) {
    mean[i] /= norm
  }

  return mean
}

// --- EXIF timestamp (reused from photos.ts pattern) ---

async function getPhotoCaptureTime(filePath: string): Promise<Date | null> {
  try {
    const EXIF_HEADER_SIZE = 128 * 1024
    const fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(EXIF_HEADER_SIZE)
    const { bytesRead } = await fh.read(buf, 0, EXIF_HEADER_SIZE, 0)
    await fh.close()
    const buffer = buf.subarray(0, bytesRead)
    const tags = ExifReader.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    )
    const dateTime = tags['DateTimeOriginal']?.description
    if (!dateTime) return null
    const [datePart, timePart] = dateTime.split(' ')
    const isoString = datePart.replace(/:/g, '-') + 'T' + timePart
    return new Date(isoString)
  } catch {
    return null
  }
}

// --- Public API ---

export async function verifyImport(
  matches: PhotoMatch[],
  routines: Routine[],
  options?: { skipExact?: boolean },
): Promise<VerificationResult> {
  cancelled = false
  await ensureModel()

  const result: VerificationResult = {
    verified: 0,
    reassigned: 0,
    rescued: 0,
    stillUnmatched: 0,
    suggestions: [],
  }

  // Group photos by routine
  const routineGroups = new Map<string, PhotoMatch[]>()
  const unmatchedPhotos: PhotoMatch[] = []

  for (const match of matches) {
    if (match.confidence === 'unmatched') {
      unmatchedPhotos.push(match)
    } else {
      // Find routine for this photo by checking which routine folder it's in
      for (const routine of routines) {
        if (match.filePath.includes(routine.entryNumber)) {
          const group = routineGroups.get(routine.id) || []
          group.push(match)
          routineGroups.set(routine.id, group)
          break
        }
      }
    }
  }

  // Build fingerprints for each routine group
  const fingerprints = new Map<string, Float32Array>()
  let groupIdx = 0
  for (const [routineId, photos] of routineGroups) {
    if (cancelled) break

    sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
      phase: 'Building routine fingerprints',
      current: groupIdx,
      total: routineGroups.size,
    })

    // Sample first 2 and last 2 photos
    const samplePaths: string[] = []
    if (photos.length <= 4) {
      samplePaths.push(...photos.map((p) => p.filePath))
    } else {
      samplePaths.push(photos[0].filePath, photos[1].filePath)
      samplePaths.push(photos[photos.length - 2].filePath, photos[photos.length - 1].filePath)
    }

    try {
      const fp = await groupFingerprint(samplePaths)
      fingerprints.set(routineId, fp)
    } catch (err) {
      logger.photos.warn(`Failed to fingerprint routine ${routineId}:`, err)
    }
    groupIdx++
  }

  // Verify matched photos (spot-check)
  if (!options?.skipExact) {
    for (const [routineId, photos] of routineGroups) {
      if (cancelled) break
      const fp = fingerprints.get(routineId)
      if (!fp) continue

      for (const photo of photos) {
        try {
          const emb = await getEmbedding(photo.filePath)
          const sim = cosineSim(emb, fp)
          if (sim >= 0.75) {
            result.verified++
            photo.clipVerified = true
          } else {
            // Check other routines
            let bestRoutineId = routineId
            let bestSim = sim
            for (const [otherId, otherFp] of fingerprints) {
              if (otherId === routineId) continue
              const otherSim = cosineSim(emb, otherFp)
              if (otherSim > bestSim) {
                bestSim = otherSim
                bestRoutineId = otherId
              }
            }
            if (bestRoutineId !== routineId && bestSim >= 0.75) {
              result.reassigned++
              photo.clipSuggestion = { routineId: bestRoutineId, similarity: bestSim }
              result.suggestions.push({
                filePath: photo.filePath,
                currentRoutineId: routineId,
                suggestedRoutineId: bestRoutineId,
                similarity: bestSim,
              })
            } else {
              result.verified++ // Low sim but no better match
              photo.clipVerified = true
            }
          }
        } catch {
          // Skip photos that fail embedding
        }
      }
    }
  }

  // Rescue unmatched photos
  for (let i = 0; i < unmatchedPhotos.length; i++) {
    if (cancelled) break
    const photo = unmatchedPhotos[i]

    sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
      phase: 'Rescuing unmatched photos',
      current: i,
      total: unmatchedPhotos.length,
    })

    try {
      const emb = await getEmbedding(photo.filePath)
      let bestRoutineId: string | null = null
      let bestSim = 0

      for (const [routineId, fp] of fingerprints) {
        const sim = cosineSim(emb, fp)
        if (sim > bestSim) {
          bestSim = sim
          bestRoutineId = routineId
        }
      }

      if (bestRoutineId && bestSim >= 0.75) {
        result.rescued++
        photo.clipSuggestion = { routineId: bestRoutineId, similarity: bestSim }
        result.suggestions.push({
          filePath: photo.filePath,
          suggestedRoutineId: bestRoutineId,
          similarity: bestSim,
        })
      } else {
        result.stillUnmatched++
      }
    } catch {
      result.stillUnmatched++
    }
  }

  logger.photos.info(
    `CLIP verification: ${result.verified} verified, ${result.reassigned} reassigned, ${result.rescued} rescued, ${result.stillUnmatched} still unmatched`,
  )

  return result
}

export async function analyzeFolder(
  folderPath: string,
  params: ClipSortParams,
): Promise<ClipSortResult> {
  cancelled = false
  await ensureModel()

  const { sampleRate = 5, threshold = 0.8, expectedGroups } = params

  // Collect image files
  const imageExts = /\.(jpg|jpeg|png)$/i
  const allFiles = fs.readdirSync(folderPath).filter((f) => imageExts.test(f))

  if (allFiles.length === 0) {
    throw new Error('No image files found in folder')
  }

  // Sort by EXIF timestamp, then filename
  sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
    phase: 'Reading timestamps',
    current: 0,
    total: allFiles.length,
  })

  const fileTimestamps: { file: string; time: Date | null }[] = []
  for (let i = 0; i < allFiles.length; i++) {
    if (cancelled) throw new Error('Cancelled')
    const filePath = path.join(folderPath, allFiles[i])
    const time = await getPhotoCaptureTime(filePath)
    fileTimestamps.push({ file: allFiles[i], time })

    if (i % 20 === 0) {
      sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
        phase: 'Reading timestamps',
        current: i,
        total: allFiles.length,
      })
    }
  }

  // Sort: by timestamp if available, then filename
  fileTimestamps.sort((a, b) => {
    if (a.time && b.time) return a.time.getTime() - b.time.getTime()
    if (a.time) return -1
    if (b.time) return 1
    return a.file.localeCompare(b.file, undefined, { numeric: true })
  })

  const photoPaths = fileTimestamps.map((f) => path.join(folderPath, f.file))
  const totalPhotos = photoPaths.length

  // Coarse scan: embed every Nth photo
  const sampleIndices: number[] = []
  for (let i = 0; i < totalPhotos; i += sampleRate) {
    sampleIndices.push(i)
  }
  // Always include last photo
  if (sampleIndices[sampleIndices.length - 1] !== totalPhotos - 1) {
    sampleIndices.push(totalPhotos - 1)
  }

  sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
    phase: 'Computing embeddings',
    current: 0,
    total: sampleIndices.length,
  })

  const sampleEmbeddings: { index: number; embedding: Float32Array }[] = []
  for (let i = 0; i < sampleIndices.length; i++) {
    if (cancelled) throw new Error('Cancelled')

    const idx = sampleIndices[i]
    const emb = await getEmbedding(photoPaths[idx])
    sampleEmbeddings.push({ index: idx, embedding: emb })

    sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
      phase: 'Computing embeddings',
      current: i + 1,
      total: sampleIndices.length,
    })
  }

  // Find similarity drops
  const drops: { betweenIdx: number; similarity: number; leftSampleIdx: number; rightSampleIdx: number }[] = []
  for (let i = 0; i < sampleEmbeddings.length - 1; i++) {
    const sim = cosineSim(sampleEmbeddings[i].embedding, sampleEmbeddings[i + 1].embedding)
    if (sim < threshold) {
      drops.push({
        betweenIdx: i,
        similarity: sim,
        leftSampleIdx: sampleEmbeddings[i].index,
        rightSampleIdx: sampleEmbeddings[i + 1].index,
      })
    }
  }

  // If expectedGroups set and count doesn't match, pick top N-1 largest drops
  let selectedDrops = drops
  if (expectedGroups && drops.length !== expectedGroups - 1) {
    // Sort by similarity (ascending = biggest drops first)
    const allDrops: { betweenIdx: number; similarity: number; leftSampleIdx: number; rightSampleIdx: number }[] = []
    for (let i = 0; i < sampleEmbeddings.length - 1; i++) {
      const sim = cosineSim(sampleEmbeddings[i].embedding, sampleEmbeddings[i + 1].embedding)
      allDrops.push({
        betweenIdx: i,
        similarity: sim,
        leftSampleIdx: sampleEmbeddings[i].index,
        rightSampleIdx: sampleEmbeddings[i + 1].index,
      })
    }
    allDrops.sort((a, b) => a.similarity - b.similarity)
    selectedDrops = allDrops.slice(0, expectedGroups - 1)
    // Re-sort by position
    selectedDrops.sort((a, b) => a.betweenIdx - b.betweenIdx)
  }

  // Binary refine each transition
  sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
    phase: 'Refining transitions',
    current: 0,
    total: selectedDrops.length,
  })

  const transitions: ClipSortTransition[] = []
  let embeddingsComputed = sampleEmbeddings.length

  for (let t = 0; t < selectedDrops.length; t++) {
    if (cancelled) throw new Error('Cancelled')

    const drop = selectedDrops[t]
    let lo = drop.leftSampleIdx
    let hi = drop.rightSampleIdx

    // Binary search for exact transition frame
    while (hi - lo > 1) {
      if (cancelled) throw new Error('Cancelled')
      const mid = Math.floor((lo + hi) / 2)
      const embLo = await getEmbedding(photoPaths[lo])
      const embMid = await getEmbedding(photoPaths[mid])
      embeddingsComputed++

      const sim = cosineSim(embLo, embMid)
      if (sim < threshold) {
        hi = mid
      } else {
        lo = mid
      }
    }

    transitions.push({
      index: hi,
      similarity: drop.similarity,
      confidence: drop.similarity < threshold * 0.9 ? 'high' : 'medium',
      beforePath: photoPaths[hi - 1],
      afterPath: photoPaths[hi],
    })

    sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
      phase: 'Refining transitions',
      current: t + 1,
      total: selectedDrops.length,
    })
  }

  // Build groups from transitions
  const groups: [number, number][] = []
  let start = 0
  for (const tr of transitions) {
    groups.push([start, tr.index - 1])
    start = tr.index
  }
  groups.push([start, totalPhotos - 1])

  const result: ClipSortResult = {
    transitions,
    groups,
    totalPhotos,
    photoPaths,
    embeddingsComputed,
  }

  logger.photos.info(
    `CLIP analysis: ${transitions.length} transitions, ${groups.length} groups, ${totalPhotos} photos, ${embeddingsComputed} embeddings`,
  )

  return result
}

export async function executeSort(
  result: ClipSortResult,
  params: ExecuteSortParams,
): Promise<void> {
  cancelled = false
  const { destDir, startNum, mode } = params

  let totalFiles = 0
  for (const [s, e] of result.groups) {
    totalFiles += e - s + 1
  }

  let processed = 0
  for (let g = 0; g < result.groups.length; g++) {
    if (cancelled) throw new Error('Cancelled')

    const [startIdx, endIdx] = result.groups[g]
    const groupNum = startNum + g
    const groupDir = path.join(destDir, String(groupNum))

    if (!fs.existsSync(groupDir)) {
      fs.mkdirSync(groupDir, { recursive: true })
    }

    for (let i = startIdx; i <= endIdx; i++) {
      if (cancelled) throw new Error('Cancelled')

      const srcPath = result.photoPaths[i]
      const destPath = path.join(groupDir, path.basename(srcPath))

      if (mode === 'copy') {
        fs.copyFileSync(srcPath, destPath)
      } else {
        fs.renameSync(srcPath, destPath)
      }

      processed++
      sendToRenderer(IPC_CHANNELS.CLIP_PROGRESS, {
        phase: `${mode === 'copy' ? 'Copying' : 'Moving'} files`,
        current: processed,
        total: totalFiles,
      })
    }
  }

  logger.photos.info(`CLIP sort executed: ${processed} files ${mode}d to ${result.groups.length} groups in ${destDir}`)
}

export function cancel(): void {
  cancelled = true
  logger.photos.info('CLIP operation cancelled')
}
