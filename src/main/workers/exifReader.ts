/**
 * EXIF reader worker (D1).
 *
 * Runs inside a node:worker_threads Worker so the main event loop doesn't
 * stall while reading EXIF headers for a 10k+ photo SD card. The main
 * thread posts { batchId, files: string[] }. We respond with
 * { batchId, results: Array<{ path, exifTs, error? }> }.
 *
 * Reads only the first 128 KB of each file because EXIF is always in the
 * header — same as the inline path in photos.ts:getPhotoCaptureTime().
 *
 * Per-file errors are captured and returned in the result entry; they do
 * NOT crash the worker. Worker death is handled by exifWorkerPool.ts.
 */

import fs from 'fs'
import { parentPort } from 'node:worker_threads'
import ExifReader from 'exifreader'

export interface ExifWorkerRequest {
  batchId: string
  files: string[]
}

export interface ExifWorkerResultEntry {
  path: string
  /** ISO-8601 string (local-interpreted; see photos.ts rationale). Null when no EXIF DateTimeOriginal. */
  exifTs: string | null
  error?: string
}

export interface ExifWorkerResponse {
  batchId: string
  results: ExifWorkerResultEntry[]
}

const EXIF_HEADER_SIZE = 128 * 1024

async function readOne(filePath: string): Promise<ExifWorkerResultEntry> {
  let fh: fs.promises.FileHandle | null = null
  try {
    fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(EXIF_HEADER_SIZE)
    const { bytesRead } = await fh.read(buf, 0, EXIF_HEADER_SIZE, 0)
    await fh.close()
    fh = null
    const buffer = buf.subarray(0, bytesRead)
    const tags = ExifReader.load(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer,
    )
    const dateTime = tags['DateTimeOriginal']?.description
    if (!dateTime || typeof dateTime !== 'string') {
      return { path: filePath, exifTs: null }
    }
    const [datePart, timePart] = dateTime.split(' ')
    if (!datePart || !timePart) {
      return { path: filePath, exifTs: null }
    }
    const isoString = datePart.replace(/:/g, '-') + 'T' + timePart
    const d = new Date(isoString)
    if (isNaN(d.getTime())) {
      return { path: filePath, exifTs: null }
    }
    return { path: filePath, exifTs: d.toISOString() }
  } catch (err) {
    if (fh) {
      try {
        await fh.close()
      } catch {
        /* swallow */
      }
    }
    return {
      path: filePath,
      exifTs: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function handleBatch(req: ExifWorkerRequest): Promise<void> {
  const results: ExifWorkerResultEntry[] = new Array(req.files.length)
  // Sequential per-file read — the worker itself is the parallelism unit.
  // Running N file reads in parallel inside one worker would just contend
  // on the same CPU + disk as the main thread.
  for (let i = 0; i < req.files.length; i++) {
    results[i] = await readOne(req.files[i])
  }
  const resp: ExifWorkerResponse = { batchId: req.batchId, results }
  parentPort?.postMessage(resp)
}

if (parentPort) {
  parentPort.on('message', (msg: ExifWorkerRequest) => {
    // Don't await — let handleBatch run; errors surface per-file.
    handleBatch(msg).catch((err) => {
      // Last-resort: report batch-level failure without crashing the worker.
      parentPort?.postMessage({
        batchId: msg.batchId,
        results: msg.files.map((f) => ({
          path: f,
          exifTs: null,
          error: err instanceof Error ? err.message : String(err),
        })),
      } satisfies ExifWorkerResponse)
    })
  })
}
