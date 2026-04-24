/**
 * EXIF worker pool (D1).
 *
 * Spawns a small fixed set of node:worker_threads workers and round-robins
 * read batches across them. Each batch is a list of absolute JPG paths;
 * the pool returns { path, exifTs, error? } for each.
 *
 * Worker lifecycle:
 *   - Lazy spawn on first readExifBatch() call.
 *   - On 'error'/'exit' we log and restart that slot. Pending tasks for the
 *     dead worker reject so the caller can fall back to the inline path.
 *   - Worker failure must NEVER crash photo import — callers are expected
 *     to catch the reject and fall back.
 */

import os from 'os'
import path from 'path'
import { Worker } from 'node:worker_threads'
import { logger } from '../logger'
import type {
  ExifWorkerRequest,
  ExifWorkerResponse,
  ExifWorkerResultEntry,
} from '../workers/exifReader'

export type { ExifWorkerResultEntry }

const POOL_CAP = 4

// electron-vite emits workers into out/main/workers/<name>.js at build time
// (see electron.vite.config.ts). In dev electron-vite keeps the same layout
// under the dist dir. __dirname at runtime is out/main/ — from there the
// worker lives at ./workers/exifReader.js.
function resolveWorkerPath(): string {
  // __dirname is always the directory of the running bundle (out/main).
  return path.join(__dirname, 'workers', 'exifReader.js')
}

interface Slot {
  id: number
  worker: Worker | null
  pending: Map<string, (r: ExifWorkerResponse) => void>
  rejects: Map<string, (err: Error) => void>
  /** Monotonic counter of batches ever dispatched to this slot — used for round-robin. */
  dispatched: number
}

class ExifWorkerPool {
  private slots: Slot[] = []
  private nextBatchId = 0
  private started = false
  private desired: number

  constructor() {
    const cpus = os.cpus().length || 2
    this.desired = Math.max(1, Math.min(POOL_CAP, Math.floor(cpus / 4) || 2))
  }

  private spawnSlot(slot: Slot): void {
    const workerPath = resolveWorkerPath()
    let worker: Worker
    try {
      worker = new Worker(workerPath)
    } catch (err) {
      logger.app.warn(
        `exifWorkerPool: failed to spawn slot ${slot.id} (${workerPath}): ${err instanceof Error ? err.message : String(err)}`,
      )
      slot.worker = null
      return
    }
    slot.worker = worker
    worker.on('message', (msg: ExifWorkerResponse) => {
      const done = slot.pending.get(msg.batchId)
      if (done) {
        slot.pending.delete(msg.batchId)
        slot.rejects.delete(msg.batchId)
        done(msg)
      }
    })
    worker.on('error', (err) => {
      logger.app.warn(`exifWorkerPool: slot ${slot.id} error: ${err.message}`)
    })
    worker.on('exit', (code) => {
      logger.app.warn(
        `exifWorkerPool: slot ${slot.id} exited (code=${code}); restarting`,
      )
      // Reject every pending batch — caller falls back to inline.
      for (const [batchId, rej] of slot.rejects) {
        rej(new Error(`exif worker slot ${slot.id} died before batch ${batchId} completed`))
      }
      slot.pending.clear()
      slot.rejects.clear()
      slot.worker = null
      // Restart after a short delay to avoid tight crash loops.
      setTimeout(() => {
        if (!slot.worker) this.spawnSlot(slot)
      }, 500)
    })
    logger.app.info(`exifWorkerPool: slot ${slot.id} spawned (${workerPath})`)
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    for (let i = 0; i < this.desired; i++) {
      const slot: Slot = {
        id: i,
        worker: null,
        pending: new Map(),
        rejects: new Map(),
        dispatched: 0,
      }
      this.slots.push(slot)
      this.spawnSlot(slot)
    }
  }

  /** Round-robin pick a live slot. If none are live, return null. */
  private pickSlot(): Slot | null {
    // Prefer the slot with fewest pending tasks.
    let best: Slot | null = null
    for (const s of this.slots) {
      if (!s.worker) continue
      if (!best || s.pending.size < best.pending.size) best = s
    }
    return best
  }

  async readExifBatch(files: string[]): Promise<ExifWorkerResultEntry[]> {
    if (files.length === 0) return []
    this.ensureStarted()
    const slot = this.pickSlot()
    if (!slot || !slot.worker) {
      throw new Error('exifWorkerPool: no live workers available')
    }
    const batchId = `b${++this.nextBatchId}`
    slot.dispatched++
    return new Promise<ExifWorkerResultEntry[]>((resolve, reject) => {
      slot.pending.set(batchId, (resp) => resolve(resp.results))
      slot.rejects.set(batchId, reject)
      try {
        const req: ExifWorkerRequest = { batchId, files }
        slot.worker!.postMessage(req)
      } catch (err) {
        slot.pending.delete(batchId)
        slot.rejects.delete(batchId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Expose for shutdown / test hooks. */
  async terminate(): Promise<void> {
    const promises: Promise<number>[] = []
    for (const slot of this.slots) {
      if (slot.worker) {
        promises.push(slot.worker.terminate())
      }
    }
    this.slots = []
    this.started = false
    await Promise.allSettled(promises)
  }
}

let instance: ExifWorkerPool | null = null

export function getExifWorkerPool(): ExifWorkerPool {
  if (!instance) instance = new ExifWorkerPool()
  return instance
}

export async function readExifBatch(files: string[]): Promise<ExifWorkerResultEntry[]> {
  return getExifWorkerPool().readExifBatch(files)
}

/** Parse ISO → Date, matching the inline path's local-time interpretation. */
export function parseExifTsIso(iso: string | null): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d
}
