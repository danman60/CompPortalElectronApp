/**
 * Chat Bridge — Subscribes to Supabase Realtime livestream chat channel,
 * maintains a rolling message buffer, and manages pinned messages for the
 * Starting Soon overlay.
 */
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'
import { ChatMessage, PinnedChatMessage } from '../../shared/types'
import { getResolvedConnection } from './schedule'
import { logger } from '../logger'

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
let reconnectTimer: NodeJS.Timeout | null = null
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
    try { channel.unsubscribe() } catch (err) {
      logger.app.warn('Chat bridge: unsubscribe error:', err instanceof Error ? err.message : err)
    }
    channel = null
  }
  if (supabase) {
    try { supabase.removeAllChannels() } catch {}
    supabase = null
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
    if (!msg || !msg.id) return
    messages.push(msg)
    if (messages.length > MAX_MESSAGES) {
      messages = messages.slice(-MAX_MESSAGES)
    }
    try { onMessagePush?.(msg) } catch {}
  })

  channel.subscribe((status, err) => {
    logger.app.info(`Chat bridge: channel status = ${status}${err ? ` err=${err.message}` : ''}`)
    if (status === 'SUBSCRIBED') {
      consecutiveFailures = 0
      reconnectDelayMs = 2000
    } else if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR' || status === 'CLOSED') {
      scheduleReconnect()
    }
  })
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
  teardownChannel()
  logger.app.info('Chat bridge: stopped')
  messages = []
  pinnedMessages = []
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
