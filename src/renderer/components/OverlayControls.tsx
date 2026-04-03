import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { VisualEditor } from './VisualEditor'
import type { OverlayAnimation, AnimationEasing } from '../../shared/types'
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

  // Ticker
  const [tickerText, setTickerText] = useState('')
  const [tickerSpeed, setTickerSpeed] = useState(60)
  const [tickerVisible, setTickerVisible] = useState(false)

  // Starting Soon
  const [ssTitle, setSsTitle] = useState('Starting Soon')
  const [ssSubtitle, setSsSubtitle] = useState('')
  const [ssVisible, setSsVisible] = useState(false)
  const [ssCountdown, setSsCountdown] = useState(false)
  const [ssMinutes, setSsMinutes] = useState(10)

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
        if (state.ticker) {
          setTickerText(state.ticker.text ?? '')
          setTickerSpeed(state.ticker.speed ?? 60)
          setTickerVisible(state.ticker.visible ?? false)
        }
        if (state.startingSoon) {
          setSsTitle(state.startingSoon.title ?? 'Starting Soon')
          setSsSubtitle(state.startingSoon.subtitle ?? '')
          setSsVisible(state.startingSoon.visible ?? false)
          setSsCountdown(state.startingSoon.showCountdown ?? false)
        }
        // autoFire is now toggled via right-click on Process — no UI toggle needed
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
    const updates: Record<string, unknown> = { visible: newVisible, title: ssTitle, subtitle: ssSubtitle, showCountdown: ssCountdown }
    if (ssCountdown && newVisible) {
      updates.countdownTarget = new Date(Date.now() + ssMinutes * 60000).toISOString()
    }
    window.api.overlaySetStartingSoon(updates)
  }

  function handleSsPreset(minutes: number): void {
    setSsMinutes(minutes)
    setSsCountdown(true)
    if (ssVisible) {
      window.api.overlaySetStartingSoon({
        showCountdown: true,
        countdownTarget: new Date(Date.now() + minutes * 60000).toISOString(),
      })
    }
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
      {/* === Action Bar (Fire / Hide / Edit Layout) === */}
      <div className="oc-action-bar">
        <button
          className="oc-fire-btn"
          onClick={() => currentRoutine && window.api.overlayFireLT()}
          disabled={!currentRoutine}
          title={!currentRoutine ? 'Select a routine first' : 'Fire lower third'}
        >
          Fire Lower Third
        </button>
        <button className="oc-hide-btn" onClick={() => window.api.overlayHideLT()}>
          Hide
        </button>
        <button
          className="oc-edit-layout-btn"
          onClick={() => setEditorOpen(true)}
          title="Open visual layout editor"
        >
          Edit Layout
        </button>
      </div>

      {/* === Elements === */}
      <div className="oc-section">
        <div className="oc-section-header">Elements</div>
        <div className="oc-toggle-row">
          <button
            className={`oc-toggle${toggles.counter ? ' active' : ''}`}
            onClick={() => handleToggle('counter')}
          >
            Counter
          </button>
          <button
            className={`oc-toggle${toggles.clock ? ' active' : ''}`}
            onClick={() => handleToggle('clock')}
          >
            Clock
          </button>
          <button
            className={`oc-toggle${toggles.logo ? ' active' : ''}`}
            onClick={() => handleToggle('logo')}
          >
            Logo
          </button>
        </div>
      </div>

      {/* === Animation Style === */}
      <div className="oc-section">
        <div className="oc-section-header">Animation Style</div>
        <div className="oc-anim-chips">
          {ALL_ANIMATIONS.map((anim) => (
            <button
              key={anim}
              className={`oc-anim-chip${selectedAnim === anim ? ' selected' : ''}`}
              onClick={() => handleAnimSelect(anim)}
            >
              {anim}
            </button>
          ))}
        </div>
      </div>

      {/* === Animation Timing === */}
      <div className="oc-section">
        <div className="oc-section-header">Animation Timing</div>
        <div className="oc-anim-config">
          <div className="oc-anim-config-item">
            <div className="oc-config-label">Duration ({animDuration}s)</div>
            <input
              type="range"
              className="oc-slider"
              min="0.1"
              max="6.0"
              step="0.1"
              value={animDuration}
              onChange={(e) => handleAnimConfigChange('animationDuration', parseFloat(e.target.value))}
            />
          </div>
          <div className="oc-anim-config-item">
            <div className="oc-config-label">Easing</div>
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
          <div className="oc-anim-config-item narrow">
            <div className="oc-config-label">Auto-hide</div>
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
        </div>
      </div>

      {/* === Ticker === */}
      <div className="oc-module">
        <div className="oc-module-header">
          <span className="oc-module-title">Ticker / Crawl</span>
          <button
            className={`oc-live-badge${tickerVisible ? ' on' : ' off'}`}
            onClick={handleTickerToggle}
          >
            {tickerVisible ? 'ON' : 'OFF'}
          </button>
        </div>
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
      </div>

      {/* === Starting Soon === */}
      <div className="oc-module">
        <div className="oc-module-header">
          <span className="oc-module-title">Starting Soon</span>
          <button
            className={`oc-live-badge${ssVisible ? ' accent-on' : ' off'}`}
            onClick={handleSsToggle}
          >
            {ssVisible ? 'LIVE' : 'OFF'}
          </button>
        </div>
        <div className="oc-module-row">
          <input
            type="text"
            className="oc-input"
            placeholder="Title"
            value={ssTitle}
            onChange={(e) => setSsTitle(e.target.value)}
            onBlur={() => window.api.overlaySetStartingSoon({ title: ssTitle })}
          />
          <input
            type="text"
            className="oc-input"
            placeholder="Subtitle"
            value={ssSubtitle}
            onChange={(e) => setSsSubtitle(e.target.value)}
            onBlur={() => window.api.overlaySetStartingSoon({ subtitle: ssSubtitle })}
          />
        </div>
        <div className="oc-module-row">
          <button
            className={`oc-preset-btn${ssCountdown ? ' active' : ''}`}
            onClick={() => {
              setSsCountdown(!ssCountdown)
              if (ssVisible) {
                const target = !ssCountdown ? new Date(Date.now() + ssMinutes * 60000).toISOString() : ''
                window.api.overlaySetStartingSoon({ showCountdown: !ssCountdown, countdownTarget: target })
              }
            }}
          >
            Timer {ssCountdown ? 'ON' : 'OFF'}
          </button>
          {[5, 10, 15, 30].map((m) => (
            <button
              key={m}
              className={`oc-preset-btn${ssMinutes === m && ssCountdown ? ' active' : ''}`}
              onClick={() => handleSsPreset(m)}
            >
              {m}m
            </button>
          ))}
        </div>
      </div>

      {editorOpen && <VisualEditor onClose={() => setEditorOpen(false)} />}
    </div>
  )
}
