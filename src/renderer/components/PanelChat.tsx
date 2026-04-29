import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { ChatMessage, PinnedChatMessage } from '../../shared/types'

const ADMIN_NAME_KEY = 'cse:chatAdminName'

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

  const [adminName, setAdminName] = useState<string>(() => {
    try { return localStorage.getItem(ADMIN_NAME_KEY) || 'Host' } catch { return 'Host' }
  })
  const [draft, setDraft] = useState<string>('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  useEffect(() => {
    try { localStorage.setItem(ADMIN_NAME_KEY, adminName) } catch { /* ignore */ }
  }, [adminName])

  async function handleSend(): Promise<void> {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setSendError(null)
    try {
      const result = await (window.api as any)?.chatPostMessage?.({ text, name: adminName })
      if (result?.ok) {
        setDraft('')
      } else {
        setSendError(result?.error || 'Send failed')
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

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
      <div className="panel-chat-admin">
        <div className="panel-chat-admin-header">CHAT AS ADMIN</div>
        <input
          className="panel-chat-admin-name"
          type="text"
          value={adminName}
          onChange={(e) => setAdminName(e.target.value)}
          placeholder="Display name"
          maxLength={40}
        />
        <textarea
          className="panel-chat-admin-text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSend()
            }
          }}
          placeholder="Reply to chat\u2026 (Enter to send, Shift+Enter for newline)"
          maxLength={300}
          rows={2}
          disabled={sending}
        />
        <div className="panel-chat-admin-row">
          <span className="panel-chat-admin-count">{draft.length}/300</span>
          {sendError && <span className="panel-chat-admin-error">{sendError}</span>}
          <button
            className="panel-chat-admin-send"
            onClick={() => void handleSend()}
            disabled={sending || !draft.trim()}
          >
            {sending ? 'Sending\u2026' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
