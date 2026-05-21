import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { ChatMessage, PinnedChatMessage, LivestreamPinnedMessage } from '../../shared/types'

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
  const competition = useStore((s) => s.competition)
  const currentRoutine = useStore((s) => s.currentRoutine)
  const setChatMessages = useStore((s) => s.setChatMessages)
  const setChatPinned = useStore((s) => s.setChatPinned)
  const setChatLivestreamPinned = useStore((s) => s.setChatLivestreamPinned)
  const listRef = useRef<HTMLDivElement | null>(null)
  const seenMessageIdsRef = useRef<Set<string>>(new Set())
  const flashTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const [flashMessageIds, setFlashMessageIds] = useState<Set<string>>(() => new Set())
  const [panelFlash, setPanelFlash] = useState(false)

  useEffect(() => {
    const api = window.api as any
    api?.chatGetMessages?.().then((msgs: ChatMessage[]) => {
      if (Array.isArray(msgs)) setChatMessages(msgs)
    }).catch(() => {})
    api?.chatGetPinned?.().then((pinned: PinnedChatMessage[]) => {
      if (Array.isArray(pinned)) setChatPinned(pinned)
    }).catch(() => {})
    // build9o (Item #11) — backfill the livestream-pinned list at mount
    api?.chatGetLivestreamPinned?.().then((pinned: LivestreamPinnedMessage[]) => {
      if (Array.isArray(pinned)) setChatLivestreamPinned(pinned)
    }).catch(() => {})
  }, [setChatMessages, setChatPinned, setChatLivestreamPinned])

  // Auto-scroll to newest message on update
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.messages.length])

  useEffect(() => {
    const seen = seenMessageIdsRef.current
    const isInitialLoad = seen.size === 0
    const incomingIds = chat.messages
      .map((msg) => msg.id)
      .filter((id) => id && !seen.has(id))
    for (const msg of chat.messages) seen.add(msg.id)
    if (isInitialLoad || incomingIds.length === 0) return

    setFlashMessageIds((prev) => {
      const next = new Set(prev)
      for (const id of incomingIds) next.add(id)
      return next
    })
    setPanelFlash(false)
    requestAnimationFrame(() => setPanelFlash(true))
    const timer = setTimeout(() => {
      setPanelFlash(false)
      setFlashMessageIds((prev) => {
        const next = new Set(prev)
        for (const id of incomingIds) next.delete(id)
        return next
      })
    }, 2600)
    flashTimersRef.current.push(timer)
  }, [chat.messages])

  useEffect(() => () => {
    for (const timer of flashTimersRef.current) clearTimeout(timer)
    flashTimersRef.current = []
  }, [])

  async function handlePin(id: string): Promise<void> {
    try { await (window.api as any)?.chatPin?.(id) } catch { /* ignore */ }
  }
  async function handleUnpin(id: string): Promise<void> {
    const optimistic = chat.pinned.filter((p) => p.id !== id)
    setChatPinned(optimistic)
    try { await (window.api as any)?.chatUnpin?.(id) } catch { /* ignore */ }
  }
  // build9o (Item #11) — livestream-only pin destination
  async function handleLivestreamPin(id: string): Promise<void> {
    try { await (window.api as any)?.chatLivestreamPin?.(id) } catch { /* ignore */ }
  }
  async function handleLivestreamUnpin(id: string): Promise<void> {
    const optimistic = chat.livestreamPinned.filter((p) => p.id !== id)
    setChatLivestreamPinned(optimistic)
    try { await (window.api as any)?.chatLivestreamUnpin?.(id) } catch { /* ignore */ }
  }
  async function handleHide(id: string, name: string): Promise<void> {
    if (!window.confirm(`Hide message from "${name}"? Already-broadcast viewers won't see it removed, but reloads will be clean.`)) return
    try { await (window.api as any)?.chatHideMessage?.(id) } catch { /* ignore */ }
  }
  async function handleBan(name: string, fingerprint: string | undefined): Promise<void> {
    if (!window.confirm(`Ban "${name}"? All future messages from this author will be silently rejected, and existing messages from them will be hidden.`)) return
    try {
      await (window.api as any)?.chatBanAuthor?.({
        authorName: name,
        fingerprint: fingerprint ?? null,
        hideExisting: true,
      })
    } catch { /* ignore */ }
  }

  const pinnedIds = new Set(chat.pinned.map((p) => p.id))
  const livestreamPinnedIds = new Set(chat.livestreamPinned.map((p) => p.id))
  const routineEntryById = useMemo(() => {
    const entries = new Map<string, string>()
    for (const routine of (competition?.routines ?? [])) entries.set(routine.id, routine.entryNumber)
    return entries
  }, [competition])

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
    <div className={`panel-chat${panelFlash ? ' has-new-message' : ''}`}>
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
          const livestreamPinned = livestreamPinnedIds.has(msg.id)
          const anyPinned = pinned || livestreamPinned
          const isCurrentRoutineMessage = !!msg.routineIdAtPost && msg.routineIdAtPost === currentRoutine?.id
          const entryNum = msg.routineIdAtPost ? routineEntryById.get(msg.routineIdAtPost) : null
          const className = [
            'panel-chat-msg',
            anyPinned ? 'pinned' : '',
            isCurrentRoutineMessage ? 'current-routine' : '',
            flashMessageIds.has(msg.id) ? 'new-flash' : '',
          ].filter(Boolean).join(' ')
          return (
            <div key={msg.id} className={className}>
              <div className="panel-chat-avatar">{initial(msg.name)}</div>
              <div className="panel-chat-body">
                <div className="panel-chat-meta">
                  <strong>{msg.name || 'anon'}</strong>
                  <span className="panel-chat-time">{relTime(msg.timestamp)}</span>
                  {entryNum && (
                    <span
                      className={`panel-chat-routine-badge${isCurrentRoutineMessage ? ' current' : ''}`}
                      title="Routine that was active when this message was posted"
                    >
                      R{entryNum}
                    </span>
                  )}
                  {pinned && <span className="panel-chat-pin-badge pin-video" title="Pinned to recording">\ud83d\udcf9</span>}
                  {livestreamPinned && <span className="panel-chat-pin-badge pin-stream" title="Pinned to livestream">\ud83c\udf10</span>}
                </div>
                <div className="panel-chat-text">{msg.text}</div>
              </div>
              <div className="panel-chat-actions">
                <button
                  className={`panel-chat-pin-btn pin-video${pinned ? ' active' : ''}`}
                  onClick={() => (pinned ? handleUnpin(msg.id) : handlePin(msg.id))}
                  title={pinned ? 'Unpin from recording' : 'Pin to recording (burns into video)'}
                >
                  \ud83d\udcf9
                </button>
                <button
                  className={`panel-chat-pin-btn pin-stream${livestreamPinned ? ' active' : ''}`}
                  onClick={() => (livestreamPinned ? handleLivestreamUnpin(msg.id) : handleLivestreamPin(msg.id))}
                  title={livestreamPinned ? 'Unpin from livestream' : 'Pin to livestream only (no video burn)'}
                >
                  \ud83c\udf10
                </button>
                <button
                  className="panel-chat-hide-btn"
                  onClick={() => handleHide(msg.id, msg.name || 'anon')}
                  title="Hide message (soft delete)"
                >
                  {'\u{1F5D1}'}
                </button>
                <button
                  className="panel-chat-ban-btn"
                  onClick={() => handleBan(msg.name || 'anon', (msg as any).fingerprint)}
                  title="Ban author (hide all + block future)"
                >
                  {'\u{1F6AB}'}
                </button>
              </div>
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
