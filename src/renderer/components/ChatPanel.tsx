import React, { useEffect, useState } from 'react'
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

export default function ChatPanel(): React.ReactElement | null {
  const chat = useStore((s) => s.chat)
  const competition = useStore((s) => s.competition)
  const currentRoutine = useStore((s) => s.currentRoutine)
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
    // Burlington UDC 2026-05-01: optimistic update — remove from local pinned
    // list IMMEDIATELY so the UI reflects the unpin without waiting for the
    // IPC roundtrip + CHAT_PINNED_CHANGED broadcast (operator complained the
    // unpin felt laggy). Server-side broadcast still fires; the next state
    // sync converges.
    const optimistic = chat.pinned.filter((p) => p.id !== id)
    setChatPinned(optimistic)
    const api = window.api as any
    try { await api?.chatUnpin?.(id) } catch {}
  }
  async function handleHide(id: string, name: string): Promise<void> {
    if (!window.confirm(`Hide message from "${name}"? Already-broadcast viewers won't see it removed, but reloads will be clean.`)) return
    const api = window.api as any
    try { await api?.chatHideMessage?.(id) } catch {}
  }
  async function handleBan(name: string, fingerprint: string | undefined): Promise<void> {
    if (!window.confirm(`Ban "${name}"? All future messages from this author will be silently rejected, and existing messages from them will be hidden.`)) return
    const api = window.api as any
    try {
      await api?.chatBanAuthor?.({
        authorName: name,
        fingerprint: fingerprint ?? null,
        hideExisting: true,
      })
    } catch {}
  }

  // Burlington UDC 2026-05-01: routine link map — `routineIdAtPost` (entry
  // uuid) → entry_number for display as `R{n}` badge per chat row.
  const routineEntryById = new Map<string, string>()
  for (const r of (competition?.routines ?? [])) routineEntryById.set(r.id, r.entryNumber)

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

  async function handleAdminSend(): Promise<void> {
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
                  background: msg.routineIdAtPost && msg.routineIdAtPost === currentRoutine?.id
                    ? 'linear-gradient(90deg, rgba(251, 191, 36, 0.22), rgba(251, 191, 36, 0.06) 52%, rgba(59, 130, 246, 0.08))'
                    : pinnedIds.has(msg.id) ? 'rgba(168, 85, 247, 0.12)' : 'transparent',
                  borderLeft: msg.routineIdAtPost && msg.routineIdAtPost === currentRoutine?.id
                    ? '2px solid #fbbf24'
                    : pinnedIds.has(msg.id) ? '2px solid var(--stream-purple)' : '2px solid transparent',
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
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 11 }}>{msg.name || 'anon'}</strong>
                    <span style={{ fontSize: 10, opacity: 0.55 }}>{relTime(msg.timestamp)}</span>
                    {msg.routineIdAtPost && routineEntryById.has(msg.routineIdAtPost) && (
                      <span
                        title="Routine that was active when this message was posted"
                        style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                          background: 'rgba(99, 102, 241, 0.18)', color: 'var(--accent, #a5b4fc)',
                          letterSpacing: 0.4,
                        }}
                      >R{routineEntryById.get(msg.routineIdAtPost)}</span>
                    )}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.text}</div>
                </div>
                {/* Action buttons — stopPropagation to avoid triggering row click-to-pin */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                  {!pinnedIds.has(msg.id) && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handlePin(msg.id) }}
                      title="Pin"
                      style={{
                        background: 'transparent', color: 'inherit',
                        border: '1px solid var(--border, #333)',
                        borderRadius: 4, cursor: 'pointer',
                        padding: '0 6px', fontSize: 11,
                      }}
                    >★</button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleHide(msg.id, msg.name || 'anon') }}
                    title="Hide message (soft delete)"
                    style={{
                      background: 'transparent', color: '#f87171',
                      border: '1px solid rgba(248, 113, 113, 0.4)',
                      borderRadius: 4, cursor: 'pointer',
                      padding: '0 6px', fontSize: 11,
                    }}
                  >🗑</button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleBan(msg.name || 'anon', msg.fingerprint) }}
                    title="Ban author (hide all + block future)"
                    style={{
                      background: 'transparent', color: '#ef4444',
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      borderRadius: 4, cursor: 'pointer',
                      padding: '0 6px', fontSize: 11,
                    }}
                  >🚫</button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid var(--border, #333)', padding: '6px 8px', background: 'rgba(255,255,255,0.02)' }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--accent, #4b7bff)', marginBottom: 4, textTransform: 'uppercase' }}>
              CHAT AS ADMIN
            </div>
            <input
              type="text"
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              placeholder="Display name"
              maxLength={40}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'rgba(0,0,0,0.3)', color: 'inherit',
                border: '1px solid var(--border, #333)', borderRadius: 3,
                padding: '4px 6px', fontSize: 11, marginBottom: 4, outline: 'none',
              }}
            />
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleAdminSend()
                }
              }}
              placeholder="Reply… (Enter to send, Shift+Enter newline)"
              maxLength={300}
              rows={2}
              disabled={sending}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'none',
                background: 'rgba(0,0,0,0.3)', color: 'inherit',
                border: '1px solid var(--border, #333)', borderRadius: 3,
                padding: '4px 6px', fontSize: 11, fontFamily: 'inherit', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, marginTop: 4 }}>
              <span style={{ opacity: 0.55 }}>{draft.length}/300</span>
              {sendError && (
                <span style={{ color: '#ef4444', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sendError}
                </span>
              )}
              <button
                type="button"
                onClick={() => void handleAdminSend()}
                disabled={sending || !draft.trim()}
                style={{
                  marginLeft: 'auto',
                  background: 'var(--accent, #4b7bff)', color: '#fff',
                  border: 'none', borderRadius: 3,
                  padding: '3px 12px', fontSize: 11, fontWeight: 600,
                  cursor: sending || !draft.trim() ? 'not-allowed' : 'pointer',
                  opacity: sending || !draft.trim() ? 0.45 : 1,
                }}
              >{sending ? 'Sending…' : 'Send'}</button>
            </div>
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
                      background: 'rgba(168, 85, 247, 0.10)',
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
