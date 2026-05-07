/**
 * Upload worker (build9r, Item #11 child-process upload strategy).
 *
 * Spawned by upload.ts when `settings.upload.uploadStrategy === 'child-process'`
 * to take TLS encryption + file-read I/O off the CSE main process. Each PUT
 * runs in its own OS process so:
 *   - wmic can target it for `setpriority belownormal`
 *   - libuv worker pool work doesn't compete with CSE main / wifi-display
 *   - main thread stays responsive during upload bursts
 *
 * Pattern mirrors the existing ffmpeg child-process priority model.
 *
 * Communication:
 *   - Args via stdin (single JSON line on stdin, parent closes stdin to signal
 *     "go"). Avoids argv/env escaping of long signed URLs.
 *   - Progress + completion via stdout (newline-delimited JSON):
 *       {"type":"progress","percent":25}
 *       {"type":"done"}
 *       {"type":"error","message":"..."}
 *   - Exit code: 0 on success, 1 on any error.
 *   - Abort: parent sends SIGTERM → cleanup + exit 1.
 *
 * Stdlib-only (http/https/fs/url) so the worker has no project-code coupling.
 */

import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import { URL } from 'url'

interface WorkerInput {
  signedUrl: string
  filePath: string
  contentType: string
  timeoutMs: number
  bandwidthCapBytesPerSec?: number
}

function emit(line: object): void {
  process.stdout.write(JSON.stringify(line) + '\n')
}

function fail(message: string): void {
  emit({ type: 'error', message })
  process.exit(1)
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', reject)
  })
}

/**
 * Simple bandwidth throttle — duplex stream that delays write callbacks so
 * downstream sees at most `bytesPerSec` bytes/second. Mirrors the existing
 * ThrottleStream in upload.ts but stdlib-only.
 */
class ThrottleStream extends require('stream').Transform {
  private bytesPerSec: number
  private windowStart = Date.now()
  private bytesInWindow = 0
  constructor(bytesPerSec: number) {
    super()
    this.bytesPerSec = bytesPerSec
  }
  _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    const now = Date.now()
    const elapsed = now - this.windowStart
    if (elapsed >= 1000) {
      this.windowStart = now
      this.bytesInWindow = 0
    }
    this.bytesInWindow += chunk.length
    this.push(chunk)
    if (this.bytesInWindow >= this.bytesPerSec) {
      const wait = 1000 - (now - this.windowStart)
      if (wait > 0) {
        setTimeout(() => cb(), wait)
        return
      }
    }
    cb()
  }
}

async function main(): Promise<void> {
  const inputRaw = await readStdin()
  let input: WorkerInput
  try {
    input = JSON.parse(inputRaw) as WorkerInput
  } catch {
    fail('Invalid JSON on stdin')
    return
  }
  const { signedUrl, filePath, contentType, timeoutMs, bandwidthCapBytesPerSec } = input

  let fileSize: number
  try {
    fileSize = fs.statSync(filePath).size
  } catch (err) {
    fail(`Cannot read file: ${filePath} (${err instanceof Error ? err.message : err})`)
    return
  }

  const url = new URL(signedUrl)
  const httpModule = url.protocol === 'https:' ? https : http
  const fileStream = fs.createReadStream(filePath)
  let bytesUploaded = 0
  let lastEmittedMilestone = 0
  let timer: NodeJS.Timeout | null = null
  let aborted = false

  function cleanup(): void {
    if (!fileStream.destroyed) fileStream.destroy()
    if (timer) { clearTimeout(timer); timer = null }
  }

  process.on('SIGTERM', () => {
    aborted = true
    cleanup()
    fail('Upload aborted (SIGTERM)')
  })

  const req = httpModule.request(
    signedUrl,
    {
      method: 'PUT',
      headers: {
        'Content-Length': fileSize,
        'Content-Type': contentType,
      },
    },
    (res) => {
      if (timer) { clearTimeout(timer); timer = null }
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        // Drain the body so the socket can close cleanly.
        res.on('data', () => {})
        res.on('end', () => {
          if (!aborted) {
            emit({ type: 'done' })
            process.exit(0)
          }
        })
      } else {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          fail(`Upload failed: HTTP ${res.statusCode}${body ? ` ${body.slice(0, 200)}` : ''}`)
        })
      }
    },
  )

  timer = setTimeout(() => {
    cleanup()
    req.destroy()
    fail(`Upload timed out after ${timeoutMs / 1000}s`)
  }, timeoutMs)

  req.on('error', (err) => {
    cleanup()
    fail(`Upload request error: ${err.message}`)
  })

  fileStream.on('data', (chunk: Buffer) => {
    bytesUploaded += chunk.length
    const percent = Math.round((bytesUploaded / fileSize) * 100)
    const milestone = Math.floor(percent / 5) * 5  // emit every 5%
    if (milestone > lastEmittedMilestone) {
      lastEmittedMilestone = milestone
      emit({ type: 'progress', percent })
    }
  })

  if (bandwidthCapBytesPerSec && bandwidthCapBytesPerSec > 0) {
    const throttle = new ThrottleStream(bandwidthCapBytesPerSec)
    throttle.on('error', (err: Error) => {
      cleanup()
      fail(`Throttle stream error: ${err.message}`)
    })
    fileStream.pipe(throttle).pipe(req)
  } else {
    fileStream.pipe(req)
  }
}

main().catch((err) => {
  fail(`Worker crashed: ${err instanceof Error ? err.message : err}`)
})
