import { BrowserWindow } from 'electron'

/**
 * Channels whose events get coalesced to at most 10 Hz (100ms between emits)
 * per logical stream. A logical stream is channel + routineId (when present
 * in the payload) so per-routine progress bars don't starve each other.
 *
 * Audio levels are explicitly NOT in the allowlist — the VU meters need
 * every frame. Match progress, upload progress, photos progress, and ffmpeg
 * progress are fine to coalesce because the UI renders a percentage/message
 * that doesn't need 60fps updates.
 */
const COALESCED_CHANNELS = new Set<string>([
  'photos:progress',
  'upload:progress',
  'ffmpeg:progress',
])
const COALESCE_MIN_INTERVAL_MS = 100 // 10 Hz upper bound per stream

interface CoalesceSlot {
  lastSendAt: number
  pending: unknown | null
  timer: NodeJS.Timeout | null
}
const coalesceMap = new Map<string, CoalesceSlot>()

function payloadRoutineKey(data: unknown): string {
  if (data && typeof data === 'object' && 'routineId' in data) {
    const r = (data as { routineId?: unknown }).routineId
    if (typeof r === 'string' && r) return r
  }
  return '_global'
}

function rawBroadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}

/**
 * Broadcast a message to EVERY renderer window. Overlay Mode spawns extra
 * BrowserWindows (panels) that need the same state updates as the main window,
 * so a single-window send would starve them. Main-window-only callers still
 * work because the main window is always in the returned list.
 *
 * For high-frequency progress channels (see COALESCED_CHANNELS) emits are
 * rate-limited to ~10 Hz per channel+routine with leading+trailing edge
 * delivery so the renderer never misses the final payload.
 */
export function sendToRenderer(channel: string, data: unknown): void {
  if (!COALESCED_CHANNELS.has(channel)) {
    rawBroadcast(channel, data)
    return
  }

  const key = `${channel}::${payloadRoutineKey(data)}`
  const now = Date.now()
  const slot = coalesceMap.get(key)

  if (!slot) {
    coalesceMap.set(key, { lastSendAt: now, pending: null, timer: null })
    rawBroadcast(channel, data)
    return
  }

  const sinceLast = now - slot.lastSendAt
  if (sinceLast >= COALESCE_MIN_INTERVAL_MS) {
    // Window expired — send now (leading edge for the next throttle cycle).
    slot.lastSendAt = now
    slot.pending = null
    if (slot.timer) {
      clearTimeout(slot.timer)
      slot.timer = null
    }
    rawBroadcast(channel, data)
    return
  }

  // Within throttle window — stash as latest, schedule trailing flush.
  slot.pending = data
  if (slot.timer) return
  const delay = COALESCE_MIN_INTERVAL_MS - sinceLast
  slot.timer = setTimeout(() => {
    const s = coalesceMap.get(key)
    if (!s) return
    s.timer = null
    if (s.pending !== null) {
      const payload = s.pending
      s.pending = null
      s.lastSendAt = Date.now()
      rawBroadcast(channel, payload)
    }
  }, Math.max(1, delay))
}
