/**
 * Chat Bridge — Subscribes to Supabase Realtime livestream chat channel,
 * maintains a rolling message buffer, and manages pinned messages for the
 * Starting Soon overlay.
 */
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'
import { ChatMessage, PinnedChatMessage, LivestreamPinnedMessage } from '../../shared/types'
import { getResolvedConnection } from './schedule'
import { logger } from '../logger'
import * as events from './events'

// CompSync Supabase project (public anon key — safe to embed, RLS enforced)
const SUPABASE_URL = 'https://cafugvuaatsgihrsmvvl.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhZnVndnVhYXRzZ2locnNtdnZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkyNTk5MzksImV4cCI6MjA3NDgzNTkzOX0.WqX70GzRkDRhcurYeEnqG8YFniTYFqpjv6u3mPlbdoc'

const MAX_MESSAGES = 50
const MAX_PINNED = 10

let supabase: SupabaseClient | null = null
let channel: RealtimeChannel | null = null
let messages: ChatMessage[] = []
let pinnedMessages: PinnedChatMessage[] = []
let onPinChange: (() => void) | null = null
let onMessagePush: ((msg: ChatMessage) => void) | null = null
let onMessagePinned: ((msg: ChatMessage) => void) | null = null
// build9o (Item #11) — livestream-only pin destination is independent of
// the burn-into-video path (no LT/OBS broadcast, no onMessagePinned fire).
// Same MAX cap so a single operator can't accidentally fill the player.
let livestreamPinnedMessages: LivestreamPinnedMessage[] = []
let onLivestreamPinChange: (() => void) | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let pollTimer: NodeJS.Timeout | null = null
let reconnectDelayMs = 2000  // grows on repeated failures
let consecutiveFailures = 0
let started = false  // user has called startChatBridge — auto-reconnect on failures

export function setOnPinChange(cb: () => void): void {
  onPinChange = cb
}

export function setOnMessagePush(cb: (msg: ChatMessage) => void): void {
  onMessagePush = cb
}

/**
 * Called specifically when a NEW message is pinned (not unpinned).
 * Used to fire the pinned message as an LT-style overlay broadcast.
 */
export function setOnMessagePinned(cb: (msg: ChatMessage) => void): void {
  onMessagePinned = cb
}

function notifyPinChange(): void {
  if (onPinChange) onPinChange()
}

// build9o (Item #11)
export function setOnLivestreamPinChange(cb: () => void): void {
  onLivestreamPinChange = cb
}
function notifyLivestreamPinChange(): void {
  if (onLivestreamPinChange) onLivestreamPinChange()
}

function scheduleReconnect(): void {
  if (!started) return
  if (reconnectTimer) clearTimeout(reconnectTimer)
  consecutiveFailures++
  // Exponential backoff capped at 30s. Reset on successful SUBSCRIBED.
  reconnectDelayMs = Math.min(2000 * 2 ** Math.min(consecutiveFailures - 1, 4), 30000)
  logger.app.info(`Chat bridge: reconnecting in ${reconnectDelayMs}ms (attempt ${consecutiveFailures})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    teardownChannel()
    connectChannel()
  }, reconnectDelayMs)
}

function teardownChannel(): void {
  if (channel) {
    try {
      void channel.unsubscribe().catch((err) => {
        logger.app.warn('Chat bridge: unsubscribe error:', err instanceof Error ? err.message : err)
      })
    } catch (err) {
      logger.app.warn('Chat bridge: unsubscribe error:', err instanceof Error ? err.message : err)
    }
    channel = null
  }
  supabase = null
}

function mergeMessage(msg: ChatMessage, notify = true): boolean {
  if (!msg || !msg.id) return false
  if (messages.some((existing) => existing.id === msg.id)) return false
  messages.push(msg)
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES)
  }
  events.emit('chat.message.received', {
    id: msg.id,
    name: msg.name,
    ageMs: Date.now() - (msg.timestamp || Date.now()),
  })
  if (notify) {
    try { onMessagePush?.(msg) } catch {}
  }
  return true
}

async function backfillChatMessages(): Promise<void> {
  const conn = getResolvedConnection()
  if (!conn) return
  try {
    const response = await fetch(
      `${conn.apiBase}/api/livestream/chat?competitionId=${encodeURIComponent(conn.competitionId)}&limit=${MAX_MESSAGES}`,
    )
    if (!response.ok) {
      logger.app.warn(`Chat bridge: backfill HTTP ${response.status}`)
      return
    }
    const body = await response.json() as { messages?: ChatMessage[] }
    let merged = 0
    for (const msg of body.messages || []) {
      if (mergeMessage(msg)) merged++
    }
    events.emit('chat.backfill.ok', { merged, total: messages.length })
  } catch (err) {
    logger.app.warn('Chat bridge: backfill failed:', err instanceof Error ? err.message : err)
  }
}

function startBackfillPoller(): void {
  if (pollTimer) return
  void backfillChatMessages()
  pollTimer = setInterval(() => {
    void backfillChatMessages()
  }, 5000)
}

function stopBackfillPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function connectChannel(): void {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.app.info('Chat bridge: no resolved connection, will retry')
    scheduleReconnect()
    return
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: {
      params: {
        apikey: SUPABASE_ANON_KEY,
        eventsPerSecond: 10,
      },
    },
  })

  // Set auth so Realtime accepts the connection (anon JWT). Some Supabase
  // projects require this even for public broadcast channels.
  try { supabase.realtime.setAuth(SUPABASE_ANON_KEY) } catch (err) {
    logger.app.warn('Chat bridge: setAuth failed:', err instanceof Error ? err.message : err)
  }

  const channelName = `livestream:${conn.competitionId}`
  logger.app.info(`Chat bridge: subscribing to ${channelName}`)

  channel = supabase.channel(channelName, {
    config: { broadcast: { self: false, ack: false } },
  })

  channel.on('broadcast', { event: 'chat' }, ({ payload }) => {
    const msg = payload as ChatMessage
    mergeMessage(msg)
  })

  channel.subscribe((status, err) => {
    logger.app.info(`Chat bridge: channel status = ${status}${err ? ` err=${err.message}` : ''}`)
    if (status === 'SUBSCRIBED') {
      consecutiveFailures = 0
      reconnectDelayMs = 2000
      startBackfillPoller()
    } else if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR' || status === 'CLOSED') {
      scheduleReconnect()
    }
  })
  startBackfillPoller()
}

export function startChatBridge(): void {
  if (started && channel) {
    logger.app.info('Chat bridge: already running')
    return
  }
  started = true
  consecutiveFailures = 0
  reconnectDelayMs = 2000
  connectChannel()
}

export function stopChatBridge(): void {
  started = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopBackfillPoller()
  teardownChannel()
  logger.app.info('Chat bridge: stopped')
  messages = []
  pinnedMessages = []
  livestreamPinnedMessages = []
}

export function getChatMessages(): ChatMessage[] {
  return messages.slice()
}

export function getPinnedMessages(): PinnedChatMessage[] {
  return pinnedMessages.slice()
}

export function pinMessage(id: string): boolean {
  // Already pinned?
  if (pinnedMessages.find((p) => p.id === id)) return false

  const msg = messages.find((m) => m.id === id)
  if (!msg) return false

  if (pinnedMessages.length >= MAX_PINNED) {
    // Remove oldest pin to make room
    pinnedMessages.shift()
  }

  pinnedMessages.push({
    id: msg.id,
    name: msg.name,
    text: msg.text,
    pinnedAt: Date.now(),
  })

  // Fire the LT-style overlay broadcast BEFORE notifying pin change
  try { onMessagePinned?.(msg) } catch {}

  notifyPinChange()
  return true
}

export function unpinMessage(id: string): boolean {
  const idx = pinnedMessages.findIndex((p) => p.id === id)
  if (idx === -1) return false
  pinnedMessages.splice(idx, 1)
  notifyPinChange()
  return true
}

export function clearPinned(): void {
  if (pinnedMessages.length === 0) return
  pinnedMessages = []
  notifyPinChange()
}

// ── build9o (Item #11) — livestream-only pin path ──
//
// Posts to a CompPortal plugin endpoint that the livestream player subscribes
// to client-side; the player overlays the message on the video stream in the
// browser, never burning into the recorded archive video. Two-button operator
// UI (📹 video / 🌐 livestream) toggles each destination independently.
//
// Local state advances on operator click; the POST is best-effort. CompPortal
// realtime UPDATE will eventually be the authoritative source, but until that
// channel ships in CompPortal-2 we keep CSE responsive immediately and rely on
// 5s backfill / next session's startup for cross-CSE convergence.

export function getLivestreamPinned(): LivestreamPinnedMessage[] {
  return livestreamPinnedMessages.slice()
}

export async function livestreamPinMessage(id: string): Promise<boolean> {
  if (livestreamPinnedMessages.find((p) => p.id === id)) return false
  const msg = messages.find((m) => m.id === id)
  if (!msg) return false
  if (livestreamPinnedMessages.length >= MAX_PINNED) {
    livestreamPinnedMessages.shift()
  }
  livestreamPinnedMessages.push({
    id: msg.id,
    name: msg.name,
    text: msg.text,
    pinnedAt: Date.now(),
  })
  notifyLivestreamPinChange()
  // Best-effort POST to CompPortal. Failures don't roll back local state —
  // the next backfill / page load will reconcile if CompPortal lost it.
  const conn = getResolvedConnection()
  if (!conn) {
    logger.app.warn(`Chat livestream-pin: no resolved connection (id=${id}); local-only`)
    return true
  }
  try {
    const response = await fetch(
      `${conn.apiBase}/api/plugin/chat/${encodeURIComponent(id)}/livestream-pin`,
      { method: 'POST', headers: { Authorization: `Bearer ${conn.apiKey}` } },
    )
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.app.warn(
        `Chat livestream-pin: HTTP ${response.status}${body ? ` ${body.slice(0, 160)}` : ''} (id=${id})`,
      )
    } else {
      events.emit('chat.livestream.pinned', { id, name: msg.name })
    }
  } catch (err) {
    logger.app.warn(
      `Chat livestream-pin: post failed (id=${id}): ${err instanceof Error ? err.message : err}`,
    )
  }
  return true
}

export async function livestreamUnpinMessage(id: string): Promise<boolean> {
  const idx = livestreamPinnedMessages.findIndex((p) => p.id === id)
  if (idx === -1) return false
  livestreamPinnedMessages.splice(idx, 1)
  notifyLivestreamPinChange()
  const conn = getResolvedConnection()
  if (!conn) {
    logger.app.warn(`Chat livestream-unpin: no resolved connection (id=${id}); local-only`)
    return true
  }
  try {
    const response = await fetch(
      `${conn.apiBase}/api/plugin/chat/${encodeURIComponent(id)}/livestream-pin`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${conn.apiKey}` } },
    )
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.app.warn(
        `Chat livestream-unpin: HTTP ${response.status}${body ? ` ${body.slice(0, 160)}` : ''} (id=${id})`,
      )
    } else {
      events.emit('chat.livestream.unpinned', { id })
    }
  } catch (err) {
    logger.app.warn(
      `Chat livestream-unpin: delete failed (id=${id}): ${err instanceof Error ? err.message : err}`,
    )
  }
  return true
}

export function clearLivestreamPinned(): void {
  if (livestreamPinnedMessages.length === 0) return
  livestreamPinnedMessages = []
  notifyLivestreamPinChange()
}

/**
 * Post a chat message to CompPortal as the operator/admin. The new message
 * comes back via the realtime channel and 5s backfill anyway, but we also
 * merge it locally so the UI is instant.
 */
export async function postChatMessage(
  text: string,
  name: string,
): Promise<{ ok: true; message: ChatMessage } | { ok: false; error: string }> {
  const conn = getResolvedConnection()
  if (!conn) return { ok: false, error: 'No resolved connection' }
  const trimmedText = text.trim().slice(0, 300)
  if (!trimmedText) return { ok: false, error: 'Empty message' }
  const trimmedName = (name || '').trim().slice(0, 40) || 'Host'
  const id = (globalThis.crypto?.randomUUID?.() as string | undefined)
    ?? require('crypto').randomUUID()
  try {
    const response = await fetch(`${conn.apiBase}/api/livestream/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        competitionId: conn.competitionId,
        text: trimmedText,
        name: trimmedName,
        id,
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { ok: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}` }
    }
    const persisted = await response.json() as ChatMessage
    mergeMessage(persisted)
    return { ok: true, message: persisted }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Burlington UDC 2026-05-01: hide a chat message via plugin-token-authed
 * CompPortal endpoint. CompPortal flips is_hidden=true, persisted across
 * backfill. Already-broadcast messages on viewers' screens stay (can't
 * unsend); future page loads + late joiners get the cleaned set.
 */
export async function hideChatMessage(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const conn = getResolvedConnection()
  if (!conn) return { ok: false, error: 'No resolved connection' }
  try {
    const response = await fetch(`${conn.apiBase}/api/plugin/chat/${encodeURIComponent(id)}/hide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.apiKey}` },
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { ok: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}` }
    }
    // Mirror locally so the renderer drops the message immediately.
    messages = messages.filter((m) => m.id !== id)
    pinnedMessages = pinnedMessages.filter((m) => m.id !== id)
    if (onPinChange) onPinChange()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Ban a chat author via plugin-token-authed CompPortal endpoint. Future
 * messages from matching fingerprint and/or author_name are silently
 * rejected. If hideExisting is true, prior matching messages also get
 * hidden in the same call.
 */
export async function banChatAuthor(payload: {
  fingerprint?: string | null
  authorName?: string | null
  reason?: string
  hideExisting?: boolean
}): Promise<{ ok: true; hiddenCount: number } | { ok: false; error: string }> {
  const conn = getResolvedConnection()
  if (!conn) return { ok: false, error: 'No resolved connection' }
  if (!payload.fingerprint && !payload.authorName) {
    return { ok: false, error: 'fingerprint or authorName required' }
  }
  try {
    const response = await fetch(`${conn.apiBase}/api/plugin/chat/ban`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body: JSON.stringify({
        competitionId: conn.competitionId,
        fingerprint: payload.fingerprint ?? undefined,
        authorName: payload.authorName ?? undefined,
        reason: payload.reason,
        hideExisting: payload.hideExisting ?? true,
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { ok: false, error: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}` }
    }
    const result = await response.json() as { hiddenCount?: number }
    // Local mirror: drop matching messages so renderer reflects ban immediately.
    const matchedIds = new Set<string>()
    messages = messages.filter((m) => {
      const fpMatch = payload.fingerprint && m.fingerprint === payload.fingerprint
      const nameMatch = payload.authorName && m.name === payload.authorName
      if (fpMatch || nameMatch) {
        matchedIds.add(m.id)
        return false
      }
      return true
    })
    pinnedMessages = pinnedMessages.filter((p) => !matchedIds.has(p.id))
    if (onPinChange) onPinChange()
    return { ok: true, hiddenCount: result.hiddenCount ?? 0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
