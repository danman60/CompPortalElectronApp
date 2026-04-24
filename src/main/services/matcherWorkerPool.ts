/**
 * Matcher worker pool (D2).
 *
 * Single persistent worker — matching is serial per body anyway, and a
 * 10k-photo match runs in sub-second when isolated from the main loop.
 * A pool of 1 is enough to keep the main thread unblocked; we keep the
 * class symmetric with exifWorkerPool so lifecycle handling is identical
 * if we want to grow it later.
 */

import path from 'path'
import { Worker } from 'node:worker_threads'
import { logger } from '../logger'
import type {
  MatcherWorkerRequest,
  MatcherWorkerResponse,
} from '../workers/matcher'

export type {
  MatcherWorkerPhoto,
  MatcherWorkerWindow,
  MatcherWorkerMatch,
  MatcherWorkerRequest,
  MatcherWorkerResponse,
  OffsetDecisionEvent,
} from '../workers/matcher'

function resolveWorkerPath(): string {
  return path.join(__dirname, 'workers', 'matcher.js')
}

class MatcherWorkerPool {
  private worker: Worker | null = null
  private pending = new Map<string, (r: MatcherWorkerResponse) => void>()
  private rejects = new Map<string, (err: Error) => void>()
  private nextTaskId = 0
  private started = false

  private spawn(): void {
    const workerPath = resolveWorkerPath()
    try {
      this.worker = new Worker(workerPath)
    } catch (err) {
      logger.app.warn(
        `matcherWorkerPool: failed to spawn (${workerPath}): ${err instanceof Error ? err.message : String(err)}`,
      )
      this.worker = null
      return
    }
    this.worker.on('message', (msg: MatcherWorkerResponse) => {
      const done = this.pending.get(msg.taskId)
      if (done) {
        this.pending.delete(msg.taskId)
        this.rejects.delete(msg.taskId)
        done(msg)
      }
    })
    this.worker.on('error', (err) => {
      logger.app.warn(`matcherWorkerPool: error: ${err.message}`)
    })
    this.worker.on('exit', (code) => {
      logger.app.warn(`matcherWorkerPool: exited (code=${code}); restarting`)
      for (const [taskId, rej] of this.rejects) {
        rej(new Error(`matcher worker died before task ${taskId} completed`))
      }
      this.pending.clear()
      this.rejects.clear()
      this.worker = null
      setTimeout(() => {
        if (!this.worker) this.spawn()
      }, 500)
    })
    logger.app.info(`matcherWorkerPool: spawned (${workerPath})`)
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    this.spawn()
  }

  async runMatch(
    req: Omit<MatcherWorkerRequest, 'taskId'>,
  ): Promise<MatcherWorkerResponse> {
    this.ensureStarted()
    if (!this.worker) throw new Error('matcherWorkerPool: no live worker')
    const taskId = `m${++this.nextTaskId}`
    const fullReq: MatcherWorkerRequest = { ...req, taskId }
    return new Promise<MatcherWorkerResponse>((resolve, reject) => {
      this.pending.set(taskId, resolve)
      this.rejects.set(taskId, reject)
      try {
        this.worker!.postMessage(fullReq)
      } catch (err) {
        this.pending.delete(taskId)
        this.rejects.delete(taskId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      const w = this.worker
      this.worker = null
      this.started = false
      await w.terminate()
    }
  }
}

let instance: MatcherWorkerPool | null = null

export function getMatcherWorkerPool(): MatcherWorkerPool {
  if (!instance) instance = new MatcherWorkerPool()
  return instance
}

export async function runMatch(
  req: Omit<MatcherWorkerRequest, 'taskId'>,
): Promise<MatcherWorkerResponse> {
  return getMatcherWorkerPool().runMatch(req)
}
