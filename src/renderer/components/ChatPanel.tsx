import React, { useEffect, useState } from 'react'
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

export default function ChatPanel(): React.ReactElement | null {
  const chat = useStore((s) => s.chat)
  const setChatMessages = useStore((s) => s.setChatMessages)
  const setChatPinned = useStore((s) => s.setChatPinned)
  const setChatVisible = useStore((s) => s.setChatVisible)
  const [collapsed, setCollapsed] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(true)

  useEffect(() => {
    if (!chat.visible) return
    const api = window.api as any
    api?.chatGetMessages?.().then((msgs: ChatMessage[]) => {
      if (Array.isArray(msgs)) setChatMessages(msgs)
    }).catch(() => {})
    api?.chatGetPinned?.().then((pinned: PinnedChatMessage[]) => {
      if (Array.isArray(pinned)) setChatPinned(pinned)
    }).catch(() => {})
  }, [chat.visible, setChatMessages, setChatPinned])

  if (!chat.visible) return null

  async function handlePin(id: string): Promise<void> {
    const api = window.api as any
    try {
      await api?.chatPin?.(id)
      // Main will broadcast CHAT_PINNED_CHANGED; store updates automatically.
    } catch {}
  }
  async function handleUnpin(id: string): Promise<void> {
    const api = window.api as any
    try { await api?.chatUnpin?.(id) } catch {}
  }

  const pinnedIds = new Set(chat.pinned.map((p) => p.id))

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        width: 340,
        maxHeight: collapsed ? 40 : 500,
        background: 'var(--bg-panel, #1f2229)',
        color: 'var(--text, #e5e7eb)',
        border: '1px solid var(--border, #333)',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
        overflow: 'hidden',
        fontSize: 12,
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--border, #333)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(255,255,255,0.04)',
          cursor: 'pointer',
        }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <strong style={{ fontSize: 13 }}>Chat</strong>
        <span style={{ opacity: 0.7 }}>{chat.messages.length} msgs</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c) }}
            style={{ background: 'transparent', color: 'inherit', border: 'none', cursor: 'pointer' }}
            title={collapsed ? 'Expand' : 'Collapse'}
          >{collapsed ? '▲' : '▼'}</button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setChatVisible(false) }}
            style={{ background: 'transparent', color: 'inherit', border: 'none', cursor: 'pointer' }}
            title="Close"
          >×</button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 120, maxHeight: 280 }}>
            {chat.messages.length === 0 && (
              <div style={{ textAlign: 'center', opacity: 0.55, padding: 20 }}>No messages yet.</div>
            )}
            {chat.messages.slice(-50).map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '6px 4px',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  background: pinnedIds.has(msg.id) ? 'rgba(255, 193, 7, 0.1)' : 'transparent',
                  borderLeft: pinnedIds.has(msg.id) ? '2px solid #ffc107' : '2px solid transparent',
                }}
              >
                <div
                  style={{
                    width: 24, height: 24, borderRadius: '50%',
                    background: 'var(--accent, #3b82f6)', color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 600, flexShrink: 0, fontSize: 11,
                  }}
                >{initial(msg.name)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 11 }}>{msg.name || 'anon'}</strong>
                    <span style={{ fontSize: 10, opacity: 0.55 }}>{relTime(msg.timestamp)}</span>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.text}</div>
                </div>
                {!pinnedIds.has(msg.id) && (
                  <button
                    type="button"
                    onClick={() => handlePin(msg.id)}
                    title="Pin"
                    style={{
                      background: 'transparent', color: 'inherit',
                      border: '1px solid var(--border, #333)',
                      borderRadius: 4, cursor: 'pointer',
                      padding: '0 6px', fontSize: 11, flexShrink: 0,
                    }}
                  >★</button>
                )}
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid var(--border, #333)' }}>
            <div
              style={{
                padding: '6px 12px', cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between',
                background: 'rgba(255,255,255,0.03)', fontSize: 11,
              }}
              onClick={() => setPinnedOpen((o) => !o)}
            >
              <strong>Pinned ({chat.pinned.length}/10)</strong>
              <span>{pinnedOpen ? '▼' : '▲'}</span>
            </div>
            {pinnedOpen && (
              <div style={{ maxHeight: 120, overflowY: 'auto', padding: 6 }}>
                {chat.pinned.length === 0 && (
                  <div style={{ textAlign: 'center', opacity: 0.5, fontSize: 11, padding: 8 }}>
                    Click ★ to pin a message.
                  </div>
                )}
                {chat.pinned.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex', gap: 6, padding: '4px 6px',
                      background: 'rgba(255, 193, 7, 0.08)',
                      borderRadius: 4, marginBottom: 4, alignItems: 'flex-start',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ fontSize: 11 }}>{p.name || 'anon'}</strong>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.text}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleUnpin(p.id)}
                      title="Unpin"
                      style={{
                        background: 'transparent', color: 'inherit',
                        border: '1px solid var(--border, #333)',
                        borderRadius: 4, cursor: 'pointer',
                        padding: '0 6px', fontSize: 11, flexShrink: 0,
                      }}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
