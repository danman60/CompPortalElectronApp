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

export function setOnPinChange(cb: () => void): void {
  onPinChange = cb
}

export function setOnMessagePush(cb: (msg: ChatMessage) => void): void {
  onMessagePush = cb
}

function notifyPinChange(): void {
  if (onPinChange) onPinChange()
}

export function startChatBridge(): void {
  const conn = getResolvedConnection()
  if (!conn) {
    logger.app.info('Chat bridge: no resolved connection, skipping')
    return
  }

  if (channel) {
    logger.app.info('Chat bridge: already running')
    return
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  const channelName = `livestream:${conn.competitionId}`
  logger.app.info(`Chat bridge: subscribing to ${channelName}`)

  channel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
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

  channel.subscribe((status) => {
    logger.app.info(`Chat bridge: channel status = ${status}`)
  })
}

export function stopChatBridge(): void {
  if (channel) {
    channel.unsubscribe()
    channel = null
    logger.app.info('Chat bridge: unsubscribed')
  }
  if (supabase) {
    supabase = null
  }
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
