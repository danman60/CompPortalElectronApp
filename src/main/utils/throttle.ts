import { Transform, TransformCallback } from 'stream'

/**
 * Token-bucket throttle Transform for stream body rate limiting.
 * Preserves total byte count — only affects timing.
 * 250ms burst tolerance, 64 KB minimum bucket floor.
 */
export class ThrottleStream extends Transform {
  private bucket: number
  private lastRefillMs: number
  private readonly rate: number
  private readonly burstSize: number

  constructor(bytesPerSec: number) {
    super()
    this.rate = Math.max(1, bytesPerSec)
    this.burstSize = Math.max(Math.floor(bytesPerSec / 4), 65536)
    this.bucket = this.burstSize
    this.lastRefillMs = Date.now()
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.release(chunk, cb)
  }

  private release(chunk: Buffer, cb: TransformCallback): void {
    this.refill()
    if (chunk.length <= this.bucket) {
      this.bucket -= chunk.length
      cb(null, chunk)
      return
    }
    const deficit = chunk.length - this.bucket
    const waitMs = Math.max(1, Math.ceil((deficit / this.rate) * 1000))
    setTimeout(() => this.release(chunk, cb), waitMs)
  }

  private refill(): void {
    const now = Date.now()
    const elapsedSec = (now - this.lastRefillMs) / 1000
    if (elapsedSec <= 0) return
    this.bucket = Math.min(this.burstSize, this.bucket + elapsedSec * this.rate)
    this.lastRefillMs = now
  }
}
