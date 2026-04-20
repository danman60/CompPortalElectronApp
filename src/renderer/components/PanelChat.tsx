import React, { useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import type { ChatMessage, PinnedChatMessage } from '../../shared/types'

function initial(name: string): string {
  if (!name) return '?'
  const ch = name.trim().charAt(0)
  return ch ? ch.toUpperCase() : '?'
}

function relTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 10_000) return 'now'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  return `${Math.floor(delta / 86_400_000)}d`
}

/**
 * Inline chat view used only in the Overlay Mode Chat panel. Replicates the
 * floating ChatPanel's message list but without the fixed-position wrapper,
 * so it fills its host panel window. Subscribes to the same chat store that
 * the main chat bridge populates.
 */
export default function PanelChat(): React.ReactElement {
  const chat = useStore((s) => s.chat)
  const setChatMessages = useStore((s) => s.setChatMessages)
  const setChatPinned = useStore((s) => s.setChatPinned)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const api = window.api as any
    api?.chatGetMessages?.().then((msgs: ChatMessage[]) => {
      if (Array.isArray(msgs)) setChatMessages(msgs)
    }).catch(() => {})
    api?.chatGetPinned?.().then((pinned: PinnedChatMessage[]) => {
      if (Array.isArray(pinned)) setChatPinned(pinned)
    }).catch(() => {})
  }, [setChatMessages, setChatPinned])

  // Auto-scroll to newest message on update
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.messages.length])

  async function handlePin(id: string): Promise<void> {
    try { await (window.api as any)?.chatPin?.(id) } catch { /* ignore */ }
  }
  async function handleUnpin(id: string): Promise<void> {
    try { await (window.api as any)?.chatUnpin?.(id) } catch { /* ignore */ }
  }

  const pinnedIds = new Set(chat.pinned.map((p) => p.id))

  return (
    <div className="panel-chat">
      <div className="panel-chat-header">
        <span>Messages</span>
        <span className="panel-chat-count">{chat.messages.length}</span>
      </div>
      <div className="panel-chat-messages" ref={listRef}>
        {chat.messages.length === 0 && (
          <div className="panel-chat-empty">No messages yet.</div>
        )}
        {chat.messages.slice(-100).map((msg) => {
          const pinned = pinnedIds.has(msg.id)
          return (
            <div key={msg.id} className={`panel-chat-msg${pinned ? ' pinned' : ''}`}>
              <div className="panel-chat-avatar">{initial(msg.name)}</div>
              <div className="panel-chat-body">
                <div className="panel-chat-meta">
                  <strong>{msg.name || 'anon'}</strong>
                  <span className="panel-chat-time">{relTime(msg.timestamp)}</span>
                </div>
                <div className="panel-chat-text">{msg.text}</div>
              </div>
              <button
                className="panel-chat-pin-btn"
                onClick={() => (pinned ? handleUnpin(msg.id) : handlePin(msg.id))}
                title={pinned ? 'Unpin' : 'Pin'}
              >
                {pinned ? '\u2605' : '\u2606'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
