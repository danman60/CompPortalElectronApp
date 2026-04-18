import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { VisualEditor } from './VisualEditor'
import { StartingSoonEditor } from './StartingSoonEditor'
import type { OverlayAnimation, AnimationEasing, ChatMessage, PinnedChatMessage } from '../../shared/types'
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

export default function OverlayControls({ compact = false }: { compact?: boolean }): React.ReactElement {
  const currentRoutine = useStore((s) => s.currentRoutine)
  const [editorOpen, setEditorOpen] = useState(false)
  const [toggles, setToggles] = useState<OverlayToggles>({
    counter: true, clock: false, logo: true, lowerThird: false,
  })

  // Animation config
  const [animDuration, setAnimDuration] = useState(0.5)
  const [animEasing, setAnimEasing] = useState<AnimationEasing>('ease')
  const [autoHideSec, setAutoHideSec] = useState(8)
  const [selectedAnim, setSelectedAnim] = useState<OverlayAnimation>('random')

  useEffect(() => {
    window.api.overlayGetState().then((state: any) => {
      if (state) {
        setToggles({
          counter: state.counter?.visible ?? true,
          clock: state.clock?.visible ?? false,
          logo: state.logo?.visible ?? true,
          lowerThird: state.lowerThird?.visible ?? false,
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
    })
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
      {/* === Action Bar === */}
      <div className="oc-action-bar">
        <button
          className="oc-fire-btn"
          onClick={() => currentRoutine && window.api.overlayFireLT()}
          disabled={!currentRoutine}
          title={!currentRoutine ? 'Select a routine first' : 'Fire lower third'}
        >
          Fire LT
        </button>
        <button className="oc-hide-btn" onClick={() => window.api.overlayHideLT()}>
          Hide
        </button>
        <button
          className={`oc-toggle${toggles.counter ? ' active' : ''}`}
          onClick={() => handleToggle('counter')}
        >Cnt</button>
        <button
          className={`oc-toggle${toggles.clock ? ' active' : ''}`}
          onClick={() => handleToggle('clock')}
        >Clk</button>
        <button
          className={`oc-toggle${toggles.logo ? ' active' : ''}`}
          onClick={() => handleToggle('logo')}
        >Logo</button>
        <button
          className="oc-edit-layout-btn"
          onClick={() => setEditorOpen(true)}
          title="Open visual layout editor"
        >
          Edit
        </button>
      </div>

      {/* === Animation — compact single row === */}
      <div className="oc-section" style={{ padding: '4px 8px' }}>
        <div className="oc-anim-config" style={{ marginTop: 0 }}>
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
      </div>

      {/* === Inline Chat Strip — latest 3, click-to-pin, scrollable history === */}
      <InlineChatStrip />

      {editorOpen && <VisualEditor onClose={() => setEditorOpen(false)} />}
    </div>
  )
}

function InlineChatStrip(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pinned, setPinned] = useState<PinnedChatMessage[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const historyScrollRef = useRef<HTMLDivElement>(null)

  const fetchData = useCallback(async () => {
    try {
      const [msgs, pins] = await Promise.all([
        window.api.chatGetMessages(),
        window.api.chatGetPinned(),
      ])
      if (Array.isArray(msgs)) setMessages(msgs)
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
    }
  }, [fetchData])

  useEffect(() => {
    if (historyOpen && historyScrollRef.current) {
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

  // Latest 3 messages, newest at bottom (scrolling-feed style)
  const latest3 = messages.slice(-3)

  return (
    <div className="oc-section ic-strip-wrap">
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

      {!historyOpen && (
        <div className="ic-strip-feed">
          {latest3.length === 0 ? (
            <div className="ic-strip-empty">No messages yet</div>
          ) : (
            latest3.map((msg) => {
              const pinState = isPinned(msg.id)
              return (
                <div
                  key={msg.id}
                  className={`ic-strip-msg${pinState ? ' pinned' : ''}`}
                  onClick={() => togglePin(msg.id)}
                  title={pinState ? 'Click to unpin' : 'Click to pin (fires on overlay)'}
                >
                  <span className="ic-strip-name">{msg.name}:</span>
                  <span className="ic-strip-text">{msg.text}</span>
                  {pinState && <span className="ic-strip-pin-tag">PINNED</span>}
                </div>
              )
            })
          )}
        </div>
      )}

      {historyOpen && (
        <div className="ic-strip-history" ref={historyScrollRef}>
          {messages.length === 0 ? (
            <div className="ic-strip-empty">No messages yet</div>
          ) : (
            messages.map((msg) => {
              const pinState = isPinned(msg.id)
              return (
                <div
                  key={msg.id}
                  className={`ic-strip-msg${pinState ? ' pinned' : ''}`}
                  onClick={() => togglePin(msg.id)}
                  title={pinState ? 'Click to unpin' : 'Click to pin (fires on overlay)'}
                >
                  <span className="ic-strip-name">{msg.name}:</span>
                  <span className="ic-strip-text">{msg.text}</span>
                  {pinState && <span className="ic-strip-pin-tag">PINNED</span>}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

export function OverlayModules(): React.ReactElement {
  const [tickerText, setTickerText] = useState('')
  const [tickerSpeed, setTickerSpeed] = useState(60)
  const [tickerVisible, setTickerVisible] = useState(false)
  const [tickerExpanded, setTickerExpanded] = useState(false)

  const [ssVisible, setSsVisible] = useState(false)
  const [ssEditorOpen, setSsEditorOpen] = useState(false)

  useEffect(() => {
    window.api.overlayGetState().then((state: any) => {
      if (state) {
        if (state.ticker) {
          setTickerText(state.ticker.text ?? '')
          setTickerSpeed(state.ticker.speed ?? 60)
          setTickerVisible(state.ticker.visible ?? false)
        }
        if (state.startingSoon) {
          setSsVisible(state.startingSoon.visible ?? false)
        }
      }
    })
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
        <div className="oc-module-header" onClick={() => setTickerExpanded(!tickerExpanded)} style={{ cursor: 'pointer', marginBottom: tickerExpanded ? 6 : 0 }}>
          <span className="oc-module-title">Ticker</span>
          <button
            className={`oc-live-badge${tickerVisible ? ' on' : ' off'}`}
            onClick={(e) => { e.stopPropagation(); handleTickerToggle() }}
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
            style={{ marginRight: 4 }}
          >
            Edit Scene
          </button>
          <button
            className={`oc-live-badge${ssVisible ? ' accent-on' : ' off'}`}
            onClick={handleSsToggle}
          >
            {ssVisible ? 'LIVE' : 'OFF'}
          </button>
        </div>
      </div>

      {ssEditorOpen && <StartingSoonEditor onClose={() => setSsEditorOpen(false)} />}
    </>
  )
}
