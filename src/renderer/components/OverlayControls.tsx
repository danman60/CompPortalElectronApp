import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { VisualEditor } from './VisualEditor'
import { StartingSoonEditor } from './StartingSoonEditor'
import { IPC_CHANNELS, type OverlayAnimation, type AnimationEasing, type ChatMessage, type PinnedChatMessage } from '../../shared/types'
import '../styles/overlay-controls.css'

interface OverlayToggles {
  counter: boolean
  clock: boolean
  logo: boolean
  lowerThird: boolean
}

const ALL_ANIMATIONS: OverlayAnimation[] = [
  'random', 'slide', 'zoom', 'fade', 'rise', 'sparkle', 'typewriter', 'bounce', 'split', 'blur',
]

const EASING_OPTIONS: AnimationEasing[] = [
  'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'bounce', 'elastic',
]

export default function OverlayControls({
  compact = false,
  noChat = false,
  hideFeatureCards = false,
  hideAnimConfig = false,
}: {
  compact?: boolean
  noChat?: boolean
  hideFeatureCards?: boolean
  hideAnimConfig?: boolean
}): React.ReactElement {
  const currentRoutine = useStore((s) => s.currentRoutine)
  // Initial defaults are all FALSE so nothing shows as "active/green" until
  // the server state is actually confirmed via overlayGetState. Previous
  // defaults of counter: true, logo: true caused a UI-vs-overlay mismatch
  // after app restart when the true server state was false and the fetch
  // either errored silently or lagged — operator saw green toggles while
  // the overlay itself was off.
  const [toggles, setToggles] = useState<OverlayToggles>({
    counter: false, clock: false, logo: false, lowerThird: false,
  })

  // Animation config
  const [animDuration, setAnimDuration] = useState(0.5)
  const [animEasing, setAnimEasing] = useState<AnimationEasing>('ease')
  const [autoHideSec, setAutoHideSec] = useState(8)
  const [selectedAnim, setSelectedAnim] = useState<OverlayAnimation>('random')

  useEffect(() => {
    function applyState(state: any): void {
      if (!state) return
      setToggles({
        counter: !!state.counter?.visible,
        clock: !!state.clock?.visible,
        logo: !!state.logo?.visible,
        lowerThird: !!state.lowerThird?.visible,
      })
      if (state.animConfig) {
        setAnimDuration(state.animConfig.animationDuration ?? 0.5)
        setAnimEasing(state.animConfig.animationEasing ?? 'ease')
        setAutoHideSec(state.animConfig.autoHideSeconds ?? 8)
      }
      if (state.lowerThird?.animation) {
        setSelectedAnim(state.lowerThird.animation)
      }
    }
    const sync = (): void => {
      window.api.overlayGetState().then(applyState).catch((err: unknown) => {
        console.error('overlayGetState failed:', err)
      })
    }
    sync()
    // build9p (Item #13 fix 2026-05-06) — main pushes OVERLAY_STATE_CHANGED on
    // every overlay notifyChange (SD toggle, auto-hide, in-app toggle, etc.).
    // Push lands within ~10ms vs the 2s setInterval lag that previously caused
    // SD↔app drift. Keep a slow 10s backstop poll in case the push channel
    // ever silently breaks (paranoia, defense-in-depth).
    const offState = window.api.on(IPC_CHANNELS.OVERLAY_STATE_CHANGED, (data: unknown) => {
      applyState(data)
    })
    const poll = setInterval(sync, 10000)
    return () => { clearInterval(poll); offState?.() }
  }, [])

  async function handleToggle(element: keyof OverlayToggles): Promise<void> {
    const result = await window.api.overlayToggle(element) as any
    if (result) {
      setToggles({
        counter: result.counter?.visible ?? toggles.counter,
        clock: result.clock?.visible ?? toggles.clock,
        logo: result.logo?.visible ?? toggles.logo,
        lowerThird: result.lowerThird?.visible ?? toggles.lowerThird,
      })
    }
  }

  function handleAnimSelect(anim: OverlayAnimation): void {
    setSelectedAnim(anim)
    window.api.settingsSet({ overlay: { animation: anim } } as any)
    window.api.overlaySetAnimationConfig({ animation: anim })  // persist to overlay-config.json
  }

  function handleAnimConfigChange(key: string, value: number | string): void {
    if (key === 'animationDuration') {
      setAnimDuration(value as number)
    } else if (key === 'animationEasing') {
      setAnimEasing(value as AnimationEasing)
    } else if (key === 'autoHideSeconds') {
      setAutoHideSec(value as number)
    }
    window.api.overlaySetAnimationConfig({ [key]: value })
  }

  if (compact) {
    return (
      <div className="oc-compact-bar">
        <button
          className="oc-compact-btn fire"
          onClick={() => currentRoutine && window.api.overlayFireLT()}
          disabled={!currentRoutine}
          title={!currentRoutine ? 'Select a routine first' : 'Fire lower third'}
        >
          Fire LT
        </button>
        <button
          className="oc-compact-btn"
          onClick={() => window.api.overlayHideLT()}
        >
          Hide LT
        </button>
      </div>
    )
  }

  return (
    <div className="oc-panel">
      {/* === Row 1: Fire LT + animation options === */}
      <div className="oc-fire-anim-row">
        <button
          className={`oc-fire-btn${toggles.lowerThird ? ' is-live' : ''}`}
          onClick={() => {
            if (toggles.lowerThird) {
              window.api.overlayHideLT()
              setToggles({ ...toggles, lowerThird: false })
            } else if (currentRoutine) {
              window.api.overlayFireLT()
              setToggles({ ...toggles, lowerThird: true })
            }
          }}
          disabled={!toggles.lowerThird && !currentRoutine}
          title={
            toggles.lowerThird
              ? 'Lower third is live — click to hide'
              : !currentRoutine
                ? 'Select a routine first'
                : 'Fire lower third'
          }
        >
          {toggles.lowerThird ? 'Hide LT' : 'Fire LT'}
        </button>
        {!hideAnimConfig && (
          <div className="oc-anim-config oc-anim-inline">
            <div className="oc-anim-config-item">
              <div className="oc-config-label">Anim</div>
              <select
                className="oc-select"
                value={selectedAnim}
                onChange={(e) => handleAnimSelect(e.target.value as OverlayAnimation)}
              >
                {ALL_ANIMATIONS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div className="oc-anim-config-item narrow">
              <div className="oc-config-label">Hide</div>
              <input
                type="number"
                className="oc-input center"
                min="0"
                max="60"
                value={autoHideSec}
                onChange={(e) => handleAnimConfigChange('autoHideSeconds', parseInt(e.target.value) || 0)}
                title="Seconds (0 = manual)"
              />
            </div>
            <div className="oc-anim-config-item narrow">
              <div className="oc-config-label">Dur</div>
              <input
                type="number"
                className="oc-input center"
                min="0.1"
                max="6"
                step="0.1"
                value={animDuration}
                onChange={(e) => handleAnimConfigChange('animationDuration', parseFloat(e.target.value) || 0.5)}
              />
            </div>
            <div className="oc-anim-config-item">
              <div className="oc-config-label">Ease</div>
              <select
                className="oc-select"
                value={animEasing}
                onChange={(e) => handleAnimConfigChange('animationEasing', e.target.value)}
              >
                {EASING_OPTIONS.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* === Graphics — Feature Card (UP NEXT / THAT WAS) === */}
      {!hideFeatureCards && <GraphicsSection currentRoutineExists={!!currentRoutine} />}

      {/* === Inline Chat Strip — latest 3, click-to-pin, scrollable history === */}
      {!noChat && <InlineChatStrip />}
    </div>
  )
}

/**
 * Standalone lower-third animation config bar — extracted from OverlayControls
 * so it can live in the Settings dialog independently of the rail's Fire LT
 * button. State hydrated from overlayGetState + OVERLAY_STATE_CHANGED push,
 * same as the inline version.
 */
export function LowerThirdAnimConfig(): React.ReactElement {
  const [animDuration, setAnimDuration] = useState(0.5)
  const [animEasing, setAnimEasing] = useState<AnimationEasing>('ease')
  const [autoHideSec, setAutoHideSec] = useState(8)
  const [selectedAnim, setSelectedAnim] = useState<OverlayAnimation>('random')

  useEffect(() => {
    function applyState(state: any): void {
      if (!state) return
      if (state.animConfig) {
        setAnimDuration(state.animConfig.animationDuration ?? 0.5)
        setAnimEasing(state.animConfig.animationEasing ?? 'ease')
        setAutoHideSec(state.animConfig.autoHideSeconds ?? 8)
      }
      if (state.lowerThird?.animation) setSelectedAnim(state.lowerThird.animation)
    }
    const sync = (): void => {
      window.api.overlayGetState().then(applyState).catch(() => {})
    }
    sync()
    const offState = window.api.on(IPC_CHANNELS.OVERLAY_STATE_CHANGED, (data: unknown) => applyState(data))
    const poll = setInterval(sync, 10000)
    return () => { clearInterval(poll); offState?.() }
  }, [])

  function handleAnimSelect(anim: OverlayAnimation): void {
    setSelectedAnim(anim)
    window.api.settingsSet({ overlay: { animation: anim } } as any)
    window.api.overlaySetAnimationConfig({ animation: anim })
  }
  function handleAnimConfigChange(key: string, value: number | string): void {
    if (key === 'animationDuration') setAnimDuration(value as number)
    else if (key === 'animationEasing') setAnimEasing(value as AnimationEasing)
    else if (key === 'autoHideSeconds') setAutoHideSec(value as number)
    window.api.overlaySetAnimationConfig({ [key]: value })
  }

  return (
    <div className="oc-anim-config oc-anim-inline">
      <div className="oc-anim-config-item">
        <div className="oc-config-label">Anim</div>
        <select className="oc-select" value={selectedAnim} onChange={(e) => handleAnimSelect(e.target.value as OverlayAnimation)}>
          {ALL_ANIMATIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div className="oc-anim-config-item narrow">
        <div className="oc-config-label">Hide</div>
        <input type="number" className="oc-input center" min="0" max="60" value={autoHideSec}
          onChange={(e) => handleAnimConfigChange('autoHideSeconds', parseInt(e.target.value) || 0)} title="Seconds (0 = manual)" />
      </div>
      <div className="oc-anim-config-item narrow">
        <div className="oc-config-label">Dur</div>
        <input type="number" className="oc-input center" min="0.1" max="6" step="0.1" value={animDuration}
          onChange={(e) => handleAnimConfigChange('animationDuration', parseFloat(e.target.value) || 0.5)} />
      </div>
      <div className="oc-anim-config-item">
        <div className="oc-config-label">Ease</div>
        <select className="oc-select" value={animEasing} onChange={(e) => handleAnimConfigChange('animationEasing', e.target.value)}>
          {EASING_OPTIONS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
    </div>
  )
}

/**
 * GRAPHICS section — Feature Card buttons (UP NEXT / THAT WAS). Cuts to the
 * "FEATURE CARD" OBS scene with a slide-on broadcast graphic, mirroring the
 * Stream Deck buttons. No auto-hide — operator owns timing.
 */
export function GraphicsSection({ currentRoutineExists }: { currentRoutineExists: boolean }): React.ReactElement {
  const [active, setActive] = useState<'upNext' | 'thatWas' | null>(null)
  const fire = useCallback(async (mode: 'upNext' | 'thatWas') => {
    if (active === mode) {
      await window.api.overlayHideFeatureCard()
      setActive(null)
    } else {
      await window.api.overlayFireFeatureCard(mode)
      setActive(mode)
    }
  }, [active])
  return (
    <div className="oc-section oc-graphics-section">
      <div className="oc-section-title">GRAPHICS</div>
      <div className="oc-graphics-row">
        <button
          className={`oc-graphics-btn${active === 'upNext' ? ' is-live' : ''}`}
          disabled={!currentRoutineExists && active !== 'upNext'}
          onClick={() => fire('upNext')}
          title={
            active === 'upNext'
              ? 'Feature Card UP NEXT is live — click to hide'
              : !currentRoutineExists
                ? 'Select a routine first'
                : 'Cut to Feature Card — UP NEXT'
          }
        >
          {active === 'upNext' ? 'Hide UP NEXT' : 'UP NEXT'}
        </button>
        <button
          className={`oc-graphics-btn${active === 'thatWas' ? ' is-live' : ''}`}
          disabled={!currentRoutineExists && active !== 'thatWas'}
          onClick={() => fire('thatWas')}
          title={
            active === 'thatWas'
              ? 'Feature Card THAT WAS is live — click to hide'
              : !currentRoutineExists
                ? 'Select a routine first'
                : 'Cut to Feature Card — THAT WAS'
          }
        >
          {active === 'thatWas' ? 'Hide THAT WAS' : 'THAT WAS'}
        </button>
      </div>
    </div>
  )
}

/**
 * Layer toggles + visual-layout Edit button as its own module-style row.
 * Renders alongside Ticker / Starting Soon so the Edit column lines up
 * across all three rows (shared grid in .oc-module-header).
 */
export function OverlayLayerToggles(): React.ReactElement {
  const [counter, setCounter] = useState(false)
  const [clock, setClock] = useState(false)
  const [logo, setLogo] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function sync(): Promise<void> {
      try {
        const state = await window.api.overlayGetState() as any
        if (cancelled || !state) return
        setCounter(!!state.counter?.visible)
        setClock(!!state.clock?.visible)
        setLogo(!!state.logo?.visible)
      } catch { /* ignore */ }
    }
    sync()
    const poll = setInterval(sync, 2000)
    return () => { cancelled = true; clearInterval(poll) }
  }, [])

  async function toggle(element: 'counter' | 'clock' | 'logo'): Promise<void> {
    const result = await window.api.overlayToggle(element) as any
    if (result) {
      setCounter(!!result.counter?.visible)
      setClock(!!result.clock?.visible)
      setLogo(!!result.logo?.visible)
    }
  }

  async function allOff(): Promise<void> {
    const targets: Array<'counter' | 'clock' | 'logo'> = []
    if (counter) targets.push('counter')
    if (clock) targets.push('clock')
    if (logo) targets.push('logo')
    if (targets.length === 0) return
    let last: any = null
    for (const t of targets) {
      last = await window.api.overlayToggle(t)
    }
    if (last) {
      setCounter(!!last.counter?.visible)
      setClock(!!last.clock?.visible)
      setLogo(!!last.logo?.visible)
    }
  }

  const allInactive = !counter && !clock && !logo

  return (
    <div className="oc-module">
      <div className="oc-module-header">
        <div className="oc-layer-toggles">
          <button
            className={`oc-toggle${counter ? ' active' : ''}`}
            onClick={() => toggle('counter')}
          >Entry Counter</button>
          <button
            className={`oc-toggle${clock ? ' active' : ''}`}
            onClick={() => toggle('clock')}
          >Clock</button>
          <button
            className={`oc-toggle${logo ? ' active' : ''}`}
            onClick={() => toggle('logo')}
          >Logo</button>
        </div>
        <button
          className="oc-edit-layout-btn"
          onClick={() => setEditorOpen(true)}
          title="Open visual layout editor"
        >
          Edit
        </button>
        <button
          className="oc-live-badge off oc-all-off-badge"
          onClick={allOff}
          disabled={allInactive}
          title={allInactive ? 'All layers already off' : 'Turn off Entry Counter, Clock, and Logo'}
        >Off</button>
      </div>
      {editorOpen && <VisualEditor onClose={() => setEditorOpen(false)} />}
    </div>
  )
}

const ADMIN_NAME_KEY = 'cse:chatAdminName'

function chatRelTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 10_000) return 'now'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  return `${Math.floor(delta / 86_400_000)}d`
}

export function InlineChatStrip(): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const currentRoutine = useStore((s) => s.currentRoutine)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pinned, setPinned] = useState<PinnedChatMessage[]>([])
  const [flashMessageIds, setFlashMessageIds] = useState<Set<string>>(() => new Set())
  const [panelFlash, setPanelFlash] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const seenMessageIdsRef = useRef<Set<string>>(new Set())
  const flashTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const historyScrollRef = useRef<HTMLDivElement>(null)
  // Sticky-bottom: only auto-scroll the history to newest when the operator
  // is already parked at the bottom. Once they scroll up to read old
  // comments, leave their position alone — the 5s poll re-renders the list
  // every cycle and the old unconditional scrollTop=scrollHeight yanked them
  // back down within 5s, making old messages unreadable (operator report
  // 2026-05-15 UDC Cobourg).
  const atBottomRef = useRef(true)
  const onHistoryScroll = useCallback(() => {
    const el = historyScrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])
  // 2026-05-15: name is baked as "Admin" — no operator name field (collapses
  // the admin composer from 2 rows to 1).
  const adminName = 'Admin'
  const [draft, setDraft] = useState<string>('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const handleAdminSend = useCallback(async () => {
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
  }, [draft, adminName, sending])

  const fetchData = useCallback(async () => {
    try {
      const [msgs, pins] = await Promise.all([
        window.api.chatGetMessages(),
        window.api.chatGetPinned(),
      ])
      if (Array.isArray(msgs)) {
        const seen = seenMessageIdsRef.current
        const isInitialLoad = seen.size === 0
        const incomingIds = msgs
          .map((msg) => msg.id)
          .filter((id) => id && !seen.has(id))
        for (const msg of msgs) seen.add(msg.id)
        if (!isInitialLoad && incomingIds.length > 0) {
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
        }
        setMessages(msgs)
      }
      if (Array.isArray(pins)) setPinned(pins)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchData()
    // 5s cadence — chat messages also arrive via push (chatBridge → IPC), this poll
    // is a safety net for missed pushes, not the primary delivery path.
    pollRef.current = setInterval(fetchData, 5000)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      for (const timer of flashTimersRef.current) clearTimeout(timer)
      flashTimersRef.current = []
    }
  }, [fetchData])

  // Opening history (or it being open across a re-render) jumps to newest
  // once and re-arms sticky-bottom.
  useEffect(() => {
    if (historyOpen && historyScrollRef.current) {
      atBottomRef.current = true
      historyScrollRef.current.scrollTop = historyScrollRef.current.scrollHeight
    }
  }, [historyOpen])

  // New messages: pin to newest ONLY if the operator is still at the bottom.
  // If they've scrolled up to read old comments, don't move their view.
  useEffect(() => {
    if (historyOpen && historyScrollRef.current && atBottomRef.current) {
      historyScrollRef.current.scrollTop = historyScrollRef.current.scrollHeight
    }
  }, [messages, historyOpen])

  const isPinned = (id: string) => pinned.some((p) => p.id === id)

  async function togglePin(id: string): Promise<void> {
    if (isPinned(id)) {
      await window.api.chatUnpin(id)
    } else {
      await window.api.chatPin(id)
    }
    fetchData()
  }

  async function handleHide(id: string, name: string): Promise<void> {
    if (!window.confirm(`Hide message from "${name}"? Already-broadcast viewers won't see it removed, but reloads will be clean.`)) return
    try { await (window.api as any)?.chatHideMessage?.(id) } catch { /* ignore */ }
    fetchData()
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
    fetchData()
  }

  // Latest 3 messages, newest at bottom (scrolling-feed style)
  const latest3 = messages.slice(-3)

  // Burlington UDC 2026-05-02: routine link map — `routineIdAtPost` (entry uuid)
  // → entry_number for "R{n}" badge per chat row. Falls back to currentRoutine
  // entry# as estimation when message lacks routineIdAtPost (legacy / direct ws).
  const routineEntryById = new Map<string, string>()
  for (const r of (competition?.routines ?? [])) routineEntryById.set(r.id, r.entryNumber)
  const fallbackEntry = currentRoutine?.entryNumber

  function renderMsgRow(msg: ChatMessage): React.ReactElement {
    const pinState = isPinned(msg.id)
    const entryNum = (msg.routineIdAtPost && routineEntryById.get(msg.routineIdAtPost)) || fallbackEntry
    const entryEstimated = !msg.routineIdAtPost
    const isCurrentRoutineMessage = !!msg.routineIdAtPost && msg.routineIdAtPost === currentRoutine?.id
    const className = [
      'ic-strip-msg',
      pinState ? 'pinned' : '',
      flashMessageIds.has(msg.id) ? 'new-flash' : '',
      isCurrentRoutineMessage ? 'current-routine' : '',
    ].filter(Boolean).join(' ')
    return (
      <div
        key={msg.id}
        className={className}
        onClick={() => togglePin(msg.id)}
        title={pinState ? 'Click to unpin' : 'Click to pin (fires on overlay)'}
      >
        <span className="ic-strip-name">{msg.name}:</span>
        <span className="ic-strip-text">{msg.text}</span>
        {entryNum && (
          <span
            className={`ic-strip-entry${entryEstimated ? ' estimated' : ''}${isCurrentRoutineMessage ? ' current' : ''}`}
            title={entryEstimated ? `Estimated — current routine at fetch time` : `During routine R${entryNum}`}
          >
            R{entryNum}{entryEstimated ? '?' : ''}
          </span>
        )}
        <span className="ic-strip-time" title={new Date(msg.timestamp).toLocaleString()}>
          {chatRelTime(msg.timestamp)}
        </span>
        {pinState && <span className="ic-strip-pin-tag">PINNED</span>}
        <button
          className="ic-strip-hide-btn"
          onClick={(e) => { e.stopPropagation(); void handleHide(msg.id, msg.name || 'anon') }}
          title="Hide message (soft delete)"
        >
          {'\u{1F5D1}'}
        </button>
        <button
          className="ic-strip-ban-btn"
          onClick={(e) => { e.stopPropagation(); void handleBan(msg.name || 'anon', (msg as any).fingerprint) }}
          title="Ban author (hide all + block future)"
        >
          {'\u{1F6AB}'}
        </button>
      </div>
    )
  }

  return (
    <div className={`oc-section ic-strip-wrap${panelFlash ? ' has-new-message' : ''}`}>
      <div className="ic-strip-header">
        <span className="ic-strip-title">Live Chat</span>
        <div className="ic-strip-meta">
          {pinned.length > 0 && <span className="ic-strip-pinned-count">{pinned.length} pinned</span>}
          <span className="ic-strip-msg-count">{messages.length} msg</span>
          <button
            className="ic-strip-history-btn"
            onClick={() => setHistoryOpen(!historyOpen)}
            title={historyOpen ? 'Hide history' : 'Show full history'}
          >
            {historyOpen ? '▼' : '▲'}
          </button>
        </div>
      </div>

      <div className="ic-strip-admin">
        <div className="ic-strip-admin-row">
          <span className="ic-strip-admin-label">Admin</span>
          <input
            type="text"
            className="ic-strip-admin-text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleAdminSend()
              }
            }}
            placeholder="Reply... (Enter to send)"
            maxLength={300}
            disabled={sending}
          />
          <button
            type="button"
            className="ic-strip-admin-send"
            onClick={() => void handleAdminSend()}
            disabled={sending || !draft.trim()}
          >{sending ? '...' : 'Send'}</button>
        </div>
        {sendError && <div className="ic-strip-admin-error">{sendError}</div>}
      </div>

      {!historyOpen && (
        <div className="ic-strip-feed">
          {latest3.length === 0 ? (
            <div className="ic-strip-empty">No messages yet</div>
          ) : (
            latest3.map(renderMsgRow)
          )}
        </div>
      )}

      {historyOpen && (
        <div className="ic-strip-history" ref={historyScrollRef} onScroll={onHistoryScroll}>
          {messages.length === 0 ? (
            <div className="ic-strip-empty">No messages yet</div>
          ) : (
            messages.map(renderMsgRow)
          )}
        </div>
      )}
    </div>
  )
}

export function OverlayModules({ includeFeatureCards = false }: { includeFeatureCards?: boolean } = {}): React.ReactElement {
  const currentRoutine = useStore((s) => s.currentRoutine)
  const [tickerText, setTickerText] = useState('')
  const [tickerSpeed, setTickerSpeed] = useState(60)
  const [tickerVisible, setTickerVisible] = useState(false)
  const [tickerExpanded, setTickerExpanded] = useState(false)

  const [ssVisible, setSsVisible] = useState(false)
  const [ssEditorOpen, setSsEditorOpen] = useState(false)

  // build9p (Item #13 fix 2026-05-06) — push-based sync via OVERLAY_STATE_CHANGED.
  // Was a 2s setInterval poll that caused SD-button-toggles-ticker → app UI lags
  // up to 2s, plus race conditions if operator clicked the app toggle in that
  // window (the operator's "drifts out of on/off state sync" complaint, fix-list
  // item #13). Push lands within ~10ms. Slow 10s poll retained as defense-in-depth
  // backstop.
  useEffect(() => {
    function applyVisibility(state: any): void {
      if (!state) return
      if (state.ticker) {
        // Don't overwrite text/speed while operator is typing in the expanded
        // editor — visibility only from external sources. Text/speed flow
        // renderer→main on blur/Enter.
        setTickerVisible(state.ticker.visible ?? false)
      }
      if (state.startingSoon) {
        setSsVisible(state.startingSoon.visible ?? false)
      }
    }
    // Initial fetch also pulls text + speed (only the initial sync should set
    // these so the editor opens with current persisted values).
    window.api.overlayGetState().then((state: any) => {
      if (!state) return
      if (state.ticker) {
        setTickerText(state.ticker.text ?? '')
        setTickerSpeed(state.ticker.speed ?? 60)
        setTickerVisible(state.ticker.visible ?? false)
      }
      if (state.startingSoon) {
        setSsVisible(state.startingSoon.visible ?? false)
      }
    })
    const offState = window.api.on(IPC_CHANNELS.OVERLAY_STATE_CHANGED, (data: unknown) => {
      applyVisibility(data)
    })
    const poll = setInterval(() => {
      window.api.overlayGetState().then(applyVisibility).catch(() => {})
    }, 10000)
    return () => { clearInterval(poll); offState?.() }
  }, [])

  function handleTickerToggle(): void {
    const newVisible = !tickerVisible
    setTickerVisible(newVisible)
    window.api.overlaySetTicker({ visible: newVisible, text: tickerText, speed: tickerSpeed })
  }

  function handleTickerUpdate(): void {
    window.api.overlaySetTicker({ text: tickerText, speed: tickerSpeed })
  }

  function handleSsToggle(): void {
    const newVisible = !ssVisible
    setSsVisible(newVisible)
    window.api.overlaySetStartingSoon({ visible: newVisible })
  }

  return (
    <>
      {/* === Ticker — collapsible === */}
      <div className="oc-module">
        <div className="oc-module-header" style={{ marginBottom: tickerExpanded ? 6 : 0 }}>
          <span className="oc-module-title">Ticker</span>
          <button
            className="oc-edit-layout-btn"
            onClick={() => setTickerExpanded(!tickerExpanded)}
            title="Edit ticker text and speed"
          >
            Edit
          </button>
          <button
            className={`oc-live-badge${tickerVisible ? ' on' : ' off'}`}
            onClick={handleTickerToggle}
          >
            {tickerVisible ? 'ON' : 'OFF'}
          </button>
        </div>
        {tickerExpanded && (
          <div className="oc-module-row">
            <input
              type="text"
              className="oc-input"
              placeholder="Ticker text..."
              value={tickerText}
              onChange={(e) => setTickerText(e.target.value)}
              onBlur={handleTickerUpdate}
              onKeyDown={(e) => { if (e.key === 'Enter') handleTickerUpdate() }}
            />
            <div className="oc-module-slider-wrap">
              <input
                type="range"
                className="oc-slider"
                min="20"
                max="200"
                value={tickerSpeed}
                onChange={(e) => {
                  setTickerSpeed(parseInt(e.target.value))
                }}
                onMouseUp={handleTickerUpdate}
                title={`Speed: ${tickerSpeed}px/s`}
              />
            </div>
          </div>
        )}
      </div>

      {/* === Starting Soon === */}
      <div className="oc-module">
        <div className="oc-module-header">
          <span className="oc-module-title">Starting Soon</span>
          <button
            className="oc-edit-layout-btn"
            onClick={() => setSsEditorOpen(true)}
            title="Open scene editor"
          >
            Edit
          </button>
          <button
            className={`oc-live-badge${ssVisible ? ' accent-on' : ' off'}`}
            onClick={handleSsToggle}
          >
            {ssVisible ? 'LIVE' : 'OFF'}
          </button>
        </div>
      </div>

      {includeFeatureCards && (
        <div className="oc-module oc-feature-card-module">
          <div className="oc-module-header oc-feature-card-header">
            <span className="oc-module-title">Feature Card</span>
            <GraphicsSection currentRoutineExists={!!currentRoutine} />
          </div>
        </div>
      )}

      {ssEditorOpen && <StartingSoonEditor onClose={() => setSsEditorOpen(false)} />}
    </>
  )
}
