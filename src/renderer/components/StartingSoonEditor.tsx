import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { StartingSoonConfig, StartingSoonPreset, GradientPreset, GradientConfig, StartingSoonLayout, SSElementPosition, SocialHandle, SocialBarConfig, EventInfoConfig, VideoPlaylistConfig, PhotoSlideshowConfig, SponsorCarouselConfig, VisualizerConfig, UpNextConfig, PinnedChatConfig } from '../../shared/types'
import { useStore } from '../store/useStore'
import '../styles/startingSoonEditor.css'

type SSElementKey = keyof StartingSoonLayout

const FONT_OPTIONS = [
  { value: '', label: 'System Default' },
  { value: 'Inter', label: 'Inter' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Poppins', label: 'Poppins' },
  { value: 'Montserrat', label: 'Montserrat' },
  { value: 'Playfair Display', label: 'Playfair Display (serif)' },
  { value: 'Bebas Neue', label: 'Bebas Neue (display)' },
  { value: 'Oswald', label: 'Oswald (condensed)' },
  { value: 'Lato', label: 'Lato' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Raleway', label: 'Raleway' },
  { value: 'Anton', label: 'Anton (display)' },
  { value: 'Archivo Black', label: 'Archivo Black' },
  { value: 'Space Grotesk', label: 'Space Grotesk' },
  { value: 'DM Sans', label: 'DM Sans' },
]

interface SSDragState {
  element: SSElementKey
  startX: number
  startY: number
  startPos: SSElementPosition
  mode: 'move' | 'resize'
  handle?: string
}

const ELEMENT_LABELS: Record<SSElementKey, string> = {
  logo: 'Logo',
  title: 'Title',
  subtitle: 'Subtitle',
  countdown: 'Countdown',
  timeDate: 'Time / Date',
  videoPlaylist: 'Video Playlist',
  photoSlideshow: 'Photo Slideshow',
  ticker: 'Ticker',
  socialBar: 'Social Bar',
  sponsorCarousel: 'Sponsor Carousel',
  visualizer: 'Visualizer',
  eventCard: 'Event Card',
  upNext: 'Up Next',
  pinnedChat: 'Pinned Chat',
}

const ELEMENT_ORDER: SSElementKey[] = [
  'logo', 'title', 'subtitle', 'countdown', 'timeDate',
  'videoPlaylist', 'photoSlideshow', 'ticker', 'socialBar',
  'sponsorCarousel', 'visualizer', 'eventCard', 'upNext', 'pinnedChat',
]

interface GradientPresetDef {
  id: GradientPreset
  name: string
  colors: string[]
}

const GRADIENT_PRESETS: GradientPresetDef[] = [
  { id: 'midnight-pulse', name: 'Midnight Pulse', colors: ['#0f0c29', '#302b63', '#24243e', '#667eea'] },
  { id: 'sunset-drift', name: 'Sunset Drift', colors: ['#f12711', '#f5af19', '#fc4a1a', '#f7b733'] },
  { id: 'ocean-wave', name: 'Ocean Wave', colors: ['#0077b6', '#00b4d8', '#023e8a', '#48cae4'] },
  { id: 'aurora', name: 'Aurora', colors: ['#11998e', '#38ef7d', '#667eea', '#764ba2'] },
  { id: 'ember-glow', name: 'Ember Glow', colors: ['#1a0000', '#8b0000', '#ff4500', '#1a0000'] },
  { id: 'monochrome-shift', name: 'Monochrome', colors: ['#0a0a0a', '#2d2d2d', '#4a4a4a', '#1a1a1a'] },
  { id: 'neon-cyber', name: 'Neon Cyber', colors: ['#ff006e', '#8338ec', '#3a86ff', '#ffbe0b'] },
  { id: 'forest-mist', name: 'Forest Mist', colors: ['#0b3d0b', '#1a7a1a', '#2d6a4f', '#40916c'] },
]

function getGradientCSS(colors: string[], angle: number): string {
  return `linear-gradient(${angle}deg, ${colors.join(', ')})`
}

const SOCIAL_PLATFORMS: { value: SocialHandle['platform']; label: string }[] = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'twitter', label: 'Twitter / X' },
  { value: 'website', label: 'Website' },
]

function getColorsForPreset(preset: GradientPreset, customColors?: string[]): string[] {
  if (preset === 'custom') {
    return customColors && customColors.length >= 2 ? customColors : ['#667eea', '#764ba2']
  }
  const def = GRADIENT_PRESETS.find(p => p.id === preset)
  return def ? def.colors : ['#667eea', '#764ba2']
}

/** Map speed 1-10 to animation duration: 1=30s, 5=15s, 10=5s */
function speedToDuration(speed: number): number {
  return Math.max(5, 30 - (speed - 1) * (25 / 9))
}

export function StartingSoonEditor({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const brandColors = settings?.branding?.brandColors || []
  const brandFont = settings?.branding?.brandFont || ''
  const [config, setConfig] = useState<StartingSoonConfig | null>(null)
  const initialConfig = useRef<StartingSoonConfig | null>(null)
  const [selected, setSelected] = useState<SSElementKey | 'background' | null>('background')
  const canvasRef = useRef<HTMLDivElement>(null)
  const [iframeScale, setIframeScale] = useState(0.5)
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [presets, setPresets] = useState<StartingSoonPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')
  const [drag, setDrag] = useState<SSDragState | null>(null)

  // Load config and presets on mount
  useEffect(() => {
    window.api.ssGetConfig().then((cfg: StartingSoonConfig) => {
      setConfig(cfg)
      initialConfig.current = JSON.parse(JSON.stringify(cfg))
    })
    window.api.ssGetPresets().then((p: StartingSoonPreset[]) => {
      setPresets(p)
    })
  }, [])

  // Scale iframe to fit canvas
  useEffect(() => {
    function updateScale(): void {
      const canvas = canvasRef.current
      if (!canvas) return
      setIframeScale(canvas.clientWidth / 1920)
    }
    updateScale()
    const obs = new ResizeObserver(updateScale)
    if (canvasRef.current) obs.observe(canvasRef.current)
    return () => obs.disconnect()
  }, [])

  // Debounced push to backend
  const pushConfig = useMemo(() => (cfg: StartingSoonConfig) => {
    if (pushTimer.current) clearTimeout(pushTimer.current)
    pushTimer.current = setTimeout(() => {
      window.api.ssSetConfig(cfg)
    }, 200)
  }, [])

  useEffect(() => {
    return () => { if (pushTimer.current) clearTimeout(pushTimer.current) }
  }, [])

  // Update config helper
  const updateConfig = useCallback((updates: Partial<StartingSoonConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, ...updates }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const updateGradient = useCallback((updates: Partial<GradientConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, gradient: { ...prev.gradient, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const toggleElement = useCallback((element: SSElementKey) => {
    setConfig(prev => {
      if (!prev) return prev
      const newLayout = {
        ...prev.layout,
        [element]: { ...prev.layout[element], visible: !prev.layout[element].visible },
      }
      const next = { ...prev, layout: newLayout }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const updateLayoutPosition = useCallback((element: SSElementKey, pos: Partial<SSElementPosition>) => {
    setConfig(prev => {
      if (!prev) return prev
      const newLayout = {
        ...prev.layout,
        [element]: { ...prev.layout[element], ...pos },
      }
      const next = { ...prev, layout: newLayout }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const toCanvasPercent = useCallback(
    (clientX: number, clientY: number): { px: number; py: number } => {
      const canvas = canvasRef.current
      if (!canvas) return { px: 0, py: 0 }
      const rect = canvas.getBoundingClientRect()
      return {
        px: ((clientX - rect.left) / rect.width) * 100,
        py: ((clientY - rect.top) / rect.height) * 100,
      }
    },
    [],
  )

  const handleMouseDown = useCallback((e: React.MouseEvent, element: SSElementKey) => {
    if (!config) return
    e.stopPropagation()
    e.preventDefault()
    setSelected(element)
    const { px, py } = toCanvasPercent(e.clientX, e.clientY)
    setDrag({
      element,
      startX: px,
      startY: py,
      startPos: { ...config.layout[element] },
      mode: 'move',
    })
  }, [config, toCanvasPercent])

  const handleResizeDown = useCallback((e: React.MouseEvent, element: SSElementKey, handle: string) => {
    if (!config) return
    e.stopPropagation()
    e.preventDefault()
    setSelected(element)
    const { px, py } = toCanvasPercent(e.clientX, e.clientY)
    setDrag({
      element,
      startX: px,
      startY: py,
      startPos: { ...config.layout[element] },
      mode: 'resize',
      handle,
    })
  }, [config, toCanvasPercent])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag || !config) return
    const { px, py } = toCanvasPercent(e.clientX, e.clientY)
    const dx = px - drag.startX
    const dy = py - drag.startY

    if (drag.mode === 'resize') {
      const handle = drag.handle || ''
      const updates: Partial<SSElementPosition> = {}
      if (handle.includes('right')) {
        const newW = Math.max(5, Math.min(100 - drag.startPos.x, (drag.startPos.width || 10) + dx))
        updates.width = newW
      }
      if (handle.includes('bottom')) {
        const newH = Math.max(3, Math.min(100 - drag.startPos.y, (drag.startPos.height || 10) + dy))
        updates.height = newH
      }
      if (Object.keys(updates).length > 0) {
        updateLayoutPosition(drag.element, updates)
      }
      return
    }

    const elW = drag.startPos.width || 10
    const elH = drag.startPos.height || 10
    const newX = Math.max(0, Math.min(100 - elW, drag.startPos.x + dx))
    const newY = Math.max(0, Math.min(100 - elH, drag.startPos.y + dy))
    updateLayoutPosition(drag.element, { x: newX, y: newY })
  }, [drag, config, toCanvasPercent, updateLayoutPosition])

  const renderResizeHandles = useCallback((element: SSElementKey) => {
    if (selected !== element) return null
    return (
      <>
        <div
          className="sse-resize-handle sse-handle-right"
          onMouseDown={(e) => handleResizeDown(e, element, 'right')}
        />
        <div
          className="sse-resize-handle sse-handle-bottom"
          onMouseDown={(e) => handleResizeDown(e, element, 'bottom')}
        />
        <div
          className="sse-resize-handle sse-handle-bottom-right"
          onMouseDown={(e) => handleResizeDown(e, element, 'bottom-right')}
        />
      </>
    )
  }, [selected, handleResizeDown])

  const handleMouseUp = useCallback(() => {
    setDrag(null)
  }, [])

  const updateSocialBar = useCallback((updates: Partial<SocialBarConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, socialBar: { ...prev.socialBar, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const updateEventInfo = useCallback((updates: Partial<EventInfoConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, eventInfo: { ...prev.eventInfo, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const updateVideoPlaylist = useCallback((updates: Partial<VideoPlaylistConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, videoPlaylist: { ...prev.videoPlaylist, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const updatePhotoSlideshow = useCallback((updates: Partial<PhotoSlideshowConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, photoSlideshow: { ...prev.photoSlideshow, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const browseVideoFolder = useCallback(async () => {
    const folderPath = await window.api.ssBrowseFolder('video')
    if (!folderPath) return
    const files = await window.api.ssScanFolder(folderPath, 'video') as string[]
    updateVideoPlaylist({ folderPath, fileList: files })
  }, [updateVideoPlaylist])

  const browsePhotoFolder = useCallback(async () => {
    const folderPath = await window.api.ssBrowseFolder('image')
    if (!folderPath) return
    const files = await window.api.ssScanFolder(folderPath, 'image') as string[]
    updatePhotoSlideshow({ folderPath, fileList: files })
  }, [updatePhotoSlideshow])

  const updateSponsorCarousel = useCallback((updates: Partial<SponsorCarouselConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, sponsorCarousel: { ...prev.sponsorCarousel, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const updateVisualizer = useCallback((updates: Partial<VisualizerConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, visualizer: { ...prev.visualizer, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const updateUpNext = useCallback((updates: Partial<UpNextConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, upNext: { ...prev.upNext, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const updatePinnedChat = useCallback((updates: Partial<PinnedChatConfig>) => {
    setConfig(prev => {
      if (!prev) return prev
      const next = { ...prev, pinnedChat: { ...prev.pinnedChat, ...updates } }
      pushConfig(next)
      return next
    })
  }, [pushConfig])

  const browseSponsorFolder = useCallback(async () => {
    const folderPath = await window.api.ssBrowseFolder('sponsor')
    if (!folderPath) return
    const files = await window.api.ssScanFolder(folderPath, 'sponsor') as string[]
    updateSponsorCarousel({ folderPath, logoFiles: files })
  }, [updateSponsorCarousel])

  const handleSavePreset = useCallback(async () => {
    if (!config) return
    const name = window.prompt('Preset name:')
    if (!name || !name.trim()) return
    const preset: StartingSoonPreset = {
      id: Date.now().toString(),
      name: name.trim(),
      createdAt: new Date().toISOString(),
      config: JSON.parse(JSON.stringify(config)),
    }
    const updated = await window.api.ssSavePreset(preset) as StartingSoonPreset[]
    setPresets(updated)
    setSelectedPresetId(preset.id)
  }, [config])

  const handleDeletePreset = useCallback(async () => {
    if (!selectedPresetId) return
    const updated = await window.api.ssDeletePreset(selectedPresetId) as StartingSoonPreset[]
    setPresets(updated)
    setSelectedPresetId('')
  }, [selectedPresetId])

  const handleLoadPreset = useCallback(async (id: string) => {
    setSelectedPresetId(id)
    if (!id) return
    const cfg = await window.api.ssLoadPreset(id) as StartingSoonConfig | null
    if (cfg) {
      setConfig(cfg)
    }
  }, [])

  function handleDone(): void {
    // Config already pushed live — just close
    if (pushTimer.current) {
      clearTimeout(pushTimer.current)
      if (config) window.api.ssSetConfig(config)
    }
    onClose()
  }

  function handleCancel(): void {
    // Restore original config
    if (initialConfig.current) {
      window.api.ssSetConfig(initialConfig.current)
    }
    onClose()
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      handleCancel()
    }
  }

  if (!config) {
    return (
      <div className="sse-overlay">
        <div className="sse-header">
          <span className="sse-title">Loading...</span>
        </div>
      </div>
    )
  }

  const gradientColors = getColorsForPreset(config.gradient.preset, config.gradient.customColors)

  return (
    <div
      className="sse-overlay"
      onKeyDown={handleKeyDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      tabIndex={0}
      ref={(el) => el?.focus()}
    >
      <div className="sse-header">
        <span className="sse-title">Starting Soon Scene Editor</span>
        <div className="sse-preset-bar">
          <select
            value={selectedPresetId}
            onChange={(e) => handleLoadPreset(e.target.value)}
            className="sse-preset-select"
          >
            <option value="">— Presets —</option>
            {presets.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button className="sse-preset-btn" onClick={handleSavePreset}>Save</button>
          <button
            className="sse-preset-btn sse-preset-delete"
            onClick={handleDeletePreset}
            disabled={!selectedPresetId}
          >Delete</button>
        </div>
        <div className="sse-actions">
          <button onClick={handleCancel}>Cancel</button>
          <button className="sse-btn-done" onClick={handleDone}>Done</button>
        </div>
      </div>

      <div className="sse-body">
        {/* Left panel — element list */}
        <div className="sse-left">
          <div className="sse-left-title">Elements</div>
          {/* Background item */}
          <div
            className={`sse-element-item background-item${selected === 'background' ? ' selected' : ''}`}
            onClick={() => setSelected('background')}
          >
            <span className="sse-element-label" style={{ fontWeight: 600 }}>Background</span>
          </div>
          {/* Element toggles */}
          {ELEMENT_ORDER.map(el => (
            <div
              key={el}
              className={`sse-element-item${selected === el ? ' selected' : ''}${!config.layout[el].visible ? ' disabled' : ''}`}
              onClick={() => setSelected(el)}
            >
              <input
                type="checkbox"
                className="sse-element-checkbox"
                checked={config.layout[el].visible}
                onChange={(e) => { e.stopPropagation(); toggleElement(el) }}
              />
              <span className="sse-element-label">{ELEMENT_LABELS[el]}</span>
            </div>
          ))}
        </div>

        {/* Center — iframe preview */}
        <div className="sse-center">
          <div className="sse-canvas" ref={canvasRef}>
            <iframe
              className="sse-preview-iframe"
              src="http://localhost:9876/overlay?scene=startingsoon&preview=1"
              style={{ transform: `scale(${iframeScale})` }}
              title="Starting Soon Preview"
            />
            {/* Draggable hit targets — transparent overlays on top of iframe */}
            {ELEMENT_ORDER.filter(el => config.layout[el].visible).map((element) => (
              <div
                key={element}
                className={`sse-handle-target ${selected === element ? 'selected' : ''}`}
                style={{
                  position: 'absolute',
                  left: `${config.layout[element].x}%`,
                  top: `${config.layout[element].y}%`,
                  width: `${config.layout[element].width}%`,
                  height: `${config.layout[element].height}%`,
                  cursor: drag?.mode === 'resize' ? undefined : (drag ? 'grabbing' : 'grab'),
                }}
                onMouseDown={(e) => handleMouseDown(e, element)}
              >
                <span className="sse-handle-label">{ELEMENT_LABELS[element]}</span>
                {renderResizeHandles(element)}
              </div>
            ))}
          </div>
        </div>

        {/* Right panel — properties */}
        <div className="sse-right">
          {(selected === 'background' || selected === null) && (
            <>
              <div className="sse-props-title">Gradient Background</div>
              <div className="sse-props-section">
                <div className="sse-section-label">Presets</div>
                <div className="sse-gradient-grid">
                  {brandColors.length >= 2 && (
                    <div
                      className={`sse-gradient-thumb${config.gradient.preset === 'brand' ? ' selected' : ''}`}
                      style={{
                        background: getGradientCSS(brandColors.slice(0, 4), config.gradient.angle),
                        backgroundSize: '400% 400%',
                        animationDuration: `${speedToDuration(config.gradient.speed)}s`,
                        outline: '2px solid var(--accent)',
                      }}
                      onClick={() => updateGradient({ preset: 'brand' as GradientPreset })}
                      title="Brand colors from your website"
                    >
                      <span className="sse-gradient-name">★ Brand</span>
                    </div>
                  )}
                  {GRADIENT_PRESETS.map(preset => (
                    <div
                      key={preset.id}
                      className={`sse-gradient-thumb${config.gradient.preset === preset.id ? ' selected' : ''}`}
                      style={{
                        background: getGradientCSS(preset.colors, config.gradient.angle),
                        backgroundSize: '400% 400%',
                        animationDuration: `${speedToDuration(config.gradient.speed)}s`,
                      }}
                      onClick={() => updateGradient({ preset: preset.id })}
                      title={preset.name}
                    >
                      <span className="sse-gradient-name">{preset.name}</span>
                    </div>
                  ))}
                </div>

                {/* Custom option */}
                <div
                  className={`sse-gradient-thumb${config.gradient.preset === 'custom' ? ' selected' : ''}`}
                  style={{
                    background: config.gradient.preset === 'custom'
                      ? getGradientCSS(gradientColors, config.gradient.angle)
                      : 'linear-gradient(135deg, #333, #666, #333)',
                    backgroundSize: '400% 400%',
                    width: '100%',
                    height: 32,
                  }}
                  onClick={() => updateGradient({
                    preset: 'custom',
                    customColors: config.gradient.customColors && config.gradient.customColors.length >= 2
                      ? config.gradient.customColors
                      : ['#667eea', '#764ba2'],
                  })}
                  title="Custom colors"
                >
                  <span className="sse-gradient-name">Custom</span>
                </div>

                {/* Custom color inputs */}
                {config.gradient.preset === 'custom' && (
                  <div className="sse-custom-colors">
                    {(config.gradient.customColors || ['#667eea', '#764ba2']).map((color, i) => (
                      <div key={i} className="sse-color-row">
                        <input
                          type="color"
                          className="sse-color-input"
                          value={color}
                          onChange={(e) => {
                            const newColors = [...(config.gradient.customColors || ['#667eea', '#764ba2'])]
                            newColors[i] = e.target.value
                            updateGradient({ customColors: newColors })
                          }}
                        />
                        <input
                          type="text"
                          className="sse-color-hex"
                          value={color}
                          onChange={(e) => {
                            const val = e.target.value
                            if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                              const newColors = [...(config.gradient.customColors || ['#667eea', '#764ba2'])]
                              newColors[i] = val
                              updateGradient({ customColors: newColors })
                            }
                          }}
                        />
                        {(config.gradient.customColors || []).length > 2 && (
                          <button
                            className="sse-remove-color-btn"
                            onClick={() => {
                              const newColors = [...(config.gradient.customColors || [])]
                              newColors.splice(i, 1)
                              updateGradient({ customColors: newColors })
                            }}
                          >x</button>
                        )}
                      </div>
                    ))}
                    {(config.gradient.customColors || []).length < 4 && (
                      <button
                        className="sse-add-color-btn"
                        onClick={() => {
                          const newColors = [...(config.gradient.customColors || ['#667eea', '#764ba2']), '#444444']
                          updateGradient({ customColors: newColors })
                        }}
                      >+ Add Color</button>
                    )}
                  </div>
                )}
              </div>

              {/* Speed slider */}
              <div className="sse-props-section">
                <div className="sse-section-label">Animation</div>
                <div className="sse-field">
                  <label>Speed</label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={config.gradient.speed}
                    onChange={(e) => updateGradient({ speed: parseInt(e.target.value) })}
                  />
                  <span>{config.gradient.speed}</span>
                </div>
                <div className="sse-field">
                  <label>Angle</label>
                  <input
                    type="number"
                    min="0"
                    max="360"
                    value={config.gradient.angle}
                    onChange={(e) => updateGradient({ angle: parseInt(e.target.value) || 0 })}
                  />
                  <span>deg</span>
                </div>
              </div>

              <p className="sse-props-hint">
                Select a gradient preset or create custom colors. Speed controls animation rate.
              </p>
            </>
          )}

          {/* Ticker properties */}
          {selected === 'ticker' && (
            <>
              <div className="sse-props-title">Ticker</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.tickerEnabled}
                      onChange={() => updateConfig({ tickerEnabled: !config.tickerEnabled })}
                    />
                    Show ticker on Starting Soon
                  </label>
                </div>
                <p className="sse-props-hint">
                  Ticker text and speed are configured in the main Overlay Controls panel.
                  This toggle only controls whether the ticker appears during the Starting Soon scene.
                </p>
              </div>
            </>
          )}

          {/* Social Bar properties */}
          {selected === 'socialBar' && (
            <>
              <div className="sse-props-title">Social Media Bar</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.socialBar.enabled}
                      onChange={() => updateSocialBar({ enabled: !config.socialBar.enabled })}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Position</div>
                <div className="sse-field">
                  <select
                    value={config.socialBar.position}
                    onChange={(e) => updateSocialBar({ position: e.target.value as SocialBarConfig['position'] })}
                  >
                    <option value="bottom">Bottom</option>
                    <option value="top">Top</option>
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                  </select>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Display Style</div>
                <div className="sse-field">
                  <select
                    value={config.socialBar.style}
                    onChange={(e) => updateSocialBar({ style: e.target.value as SocialBarConfig['style'] })}
                  >
                    <option value="icons-and-text">Icons + Text</option>
                    <option value="icons-only">Icons Only</option>
                    <option value="text-only">Text Only</option>
                  </select>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Handles</div>
                {config.socialBar.handles.map((handle, i) => (
                  <div key={i} className="sse-social-row">
                    <select
                      value={handle.platform}
                      onChange={(e) => {
                        const newHandles = [...config.socialBar.handles]
                        newHandles[i] = { ...newHandles[i], platform: e.target.value as SocialHandle['platform'] }
                        updateSocialBar({ handles: newHandles })
                      }}
                    >
                      {SOCIAL_PLATFORMS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="@handle"
                      value={handle.handle}
                      onChange={(e) => {
                        const newHandles = [...config.socialBar.handles]
                        newHandles[i] = { ...newHandles[i], handle: e.target.value }
                        updateSocialBar({ handles: newHandles })
                      }}
                    />
                    <button
                      className="sse-remove-color-btn"
                      onClick={() => {
                        const newHandles = config.socialBar.handles.filter((_, idx) => idx !== i)
                        updateSocialBar({ handles: newHandles })
                      }}
                    >x</button>
                  </div>
                ))}
                <button
                  className="sse-add-color-btn"
                  onClick={() => {
                    const newHandles = [...config.socialBar.handles, { platform: 'instagram' as const, handle: '' }]
                    updateSocialBar({ handles: newHandles })
                  }}
                >+ Add Handle</button>
              </div>
            </>
          )}

          {/* Event Card properties */}
          {selected === 'eventCard' && (
            <>
              <div className="sse-props-title">Event Info Card</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.eventInfo.enabled}
                      onChange={() => updateEventInfo({ enabled: !config.eventInfo.enabled })}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Show Fields</div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.eventInfo.showCompetitionName}
                      onChange={() => updateEventInfo({ showCompetitionName: !config.eventInfo.showCompetitionName })}
                    />
                    Competition Name
                  </label>
                </div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.eventInfo.showVenue}
                      onChange={() => updateEventInfo({ showVenue: !config.eventInfo.showVenue })}
                    />
                    Venue
                  </label>
                </div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.eventInfo.showDate}
                      onChange={() => updateEventInfo({ showDate: !config.eventInfo.showDate })}
                    />
                    Date
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Custom Fields</div>
                {config.eventInfo.customFields.map((field, i) => (
                  <div key={i} className="sse-social-row">
                    <input
                      type="text"
                      placeholder="Label"
                      value={field.label}
                      onChange={(e) => {
                        const newFields = [...config.eventInfo.customFields]
                        newFields[i] = { ...newFields[i], label: e.target.value }
                        updateEventInfo({ customFields: newFields })
                      }}
                    />
                    <input
                      type="text"
                      placeholder="Value"
                      value={field.value}
                      onChange={(e) => {
                        const newFields = [...config.eventInfo.customFields]
                        newFields[i] = { ...newFields[i], value: e.target.value }
                        updateEventInfo({ customFields: newFields })
                      }}
                    />
                    <button
                      className="sse-remove-color-btn"
                      onClick={() => {
                        const newFields = config.eventInfo.customFields.filter((_, idx) => idx !== i)
                        updateEventInfo({ customFields: newFields })
                      }}
                    >x</button>
                  </div>
                ))}
                <button
                  className="sse-add-color-btn"
                  onClick={() => {
                    const newFields = [...config.eventInfo.customFields, { label: '', value: '' }]
                    updateEventInfo({ customFields: newFields })
                  }}
                >+ Add Field</button>
              </div>
            </>
          )}

          {/* Video Playlist properties */}
          {selected === 'videoPlaylist' && (
            <>
              <div className="sse-props-title">Video Playlist</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.videoPlaylist.enabled}
                      onChange={() => updateVideoPlaylist({ enabled: !config.videoPlaylist.enabled })}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Video Folder</div>
                <div className="sse-field sse-folder-field">
                  <input
                    type="text"
                    readOnly
                    value={config.videoPlaylist.folderPath || ''}
                    placeholder="No folder selected"
                    className="sse-folder-input"
                  />
                  <button className="sse-browse-btn" onClick={browseVideoFolder}>Browse</button>
                </div>
              </div>

              {config.videoPlaylist.fileList && config.videoPlaylist.fileList.length > 0 && (
                <div className="sse-props-section">
                  <div className="sse-section-label">Files ({config.videoPlaylist.fileList.length})</div>
                  <div className="sse-file-list">
                    {config.videoPlaylist.fileList.map((f, i) => (
                      <div key={i} className="sse-file-item">{f}</div>
                    ))}
                  </div>
                </div>
              )}

              <div className="sse-props-section">
                <div className="sse-section-label">Playback</div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.videoPlaylist.loop}
                      onChange={() => updateVideoPlaylist({ loop: !config.videoPlaylist.loop })}
                    />
                    Loop
                  </label>
                </div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.videoPlaylist.shuffled}
                      onChange={() => updateVideoPlaylist({ shuffled: !config.videoPlaylist.shuffled })}
                    />
                    Shuffle
                  </label>
                </div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.videoPlaylist.muted}
                      onChange={() => updateVideoPlaylist({ muted: !config.videoPlaylist.muted })}
                    />
                    Muted
                  </label>
                </div>
              </div>
            </>
          )}

          {/* Photo Slideshow properties */}
          {selected === 'photoSlideshow' && (
            <>
              <div className="sse-props-title">Photo Slideshow</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.photoSlideshow.enabled}
                      onChange={() => updatePhotoSlideshow({ enabled: !config.photoSlideshow.enabled })}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Photo Folder</div>
                <div className="sse-field sse-folder-field">
                  <input
                    type="text"
                    readOnly
                    value={config.photoSlideshow.folderPath || ''}
                    placeholder="No folder selected"
                    className="sse-folder-input"
                  />
                  <button className="sse-browse-btn" onClick={browsePhotoFolder}>Browse</button>
                </div>
              </div>

              {config.photoSlideshow.fileList && config.photoSlideshow.fileList.length > 0 && (
                <div className="sse-props-section">
                  <div className="sse-section-label">Files ({config.photoSlideshow.fileList.length})</div>
                  <div className="sse-file-list">
                    {config.photoSlideshow.fileList.map((f, i) => (
                      <div key={i} className="sse-file-item">{f}</div>
                    ))}
                  </div>
                </div>
              )}

              <div className="sse-props-section">
                <div className="sse-section-label">Transition</div>
                <div className="sse-field">
                  <label>Interval (sec)</label>
                  <input
                    type="range"
                    min="3"
                    max="30"
                    value={config.photoSlideshow.intervalSeconds}
                    onChange={(e) => updatePhotoSlideshow({ intervalSeconds: parseInt(e.target.value) })}
                  />
                  <span>{config.photoSlideshow.intervalSeconds}s</span>
                </div>
                <div className="sse-field">
                  <label>Type</label>
                  <select
                    value={config.photoSlideshow.transitionType}
                    onChange={(e) => updatePhotoSlideshow({ transitionType: e.target.value as PhotoSlideshowConfig['transitionType'] })}
                  >
                    <option value="crossfade">Crossfade</option>
                    <option value="none">None (instant)</option>
                  </select>
                </div>
                <div className="sse-field">
                  <label>Duration (sec)</label>
                  <input
                    type="range"
                    min="0.5"
                    max="3.0"
                    step="0.1"
                    value={config.photoSlideshow.transitionDuration}
                    onChange={(e) => updatePhotoSlideshow({ transitionDuration: parseFloat(e.target.value) })}
                  />
                  <span>{config.photoSlideshow.transitionDuration}s</span>
                </div>
              </div>
            </>
          )}

          {/* Sponsor Carousel properties */}
          {selected === 'sponsorCarousel' && (
            <>
              <div className="sse-props-title">Sponsor Logo Carousel</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.sponsorCarousel.enabled}
                      onChange={() => updateSponsorCarousel({ enabled: !config.sponsorCarousel.enabled })}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Sponsor Logos Folder</div>
                <div className="sse-field sse-folder-field">
                  <input
                    type="text"
                    readOnly
                    value={config.sponsorCarousel.folderPath || ''}
                    placeholder="No folder selected"
                    className="sse-folder-input"
                  />
                  <button className="sse-browse-btn" onClick={browseSponsorFolder}>Browse</button>
                </div>
              </div>

              {config.sponsorCarousel.logoFiles && config.sponsorCarousel.logoFiles.length > 0 && (
                <div className="sse-props-section">
                  <div className="sse-section-label">Files ({config.sponsorCarousel.logoFiles.length})</div>
                  <div className="sse-file-list">
                    {config.sponsorCarousel.logoFiles.map((f, i) => (
                      <div key={i} className="sse-file-item">{f}</div>
                    ))}
                  </div>
                </div>
              )}

              <div className="sse-props-section">
                <div className="sse-section-label">Cycling</div>
                <div className="sse-field">
                  <label>Interval (sec)</label>
                  <input
                    type="range"
                    min="3"
                    max="15"
                    value={config.sponsorCarousel.intervalSeconds}
                    onChange={(e) => updateSponsorCarousel({ intervalSeconds: parseInt(e.target.value) })}
                  />
                  <span>{config.sponsorCarousel.intervalSeconds}s</span>
                </div>
                <div className="sse-field">
                  <label>Transition</label>
                  <select
                    value={config.sponsorCarousel.transitionType}
                    onChange={(e) => updateSponsorCarousel({ transitionType: e.target.value as SponsorCarouselConfig['transitionType'] })}
                  >
                    <option value="fade">Fade</option>
                    <option value="slide">Slide</option>
                  </select>
                </div>
              </div>
            </>
          )}

          {/* Visualizer properties */}
          {selected === 'visualizer' && (
            <>
              <div className="sse-props-title">Music Visualizer</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.visualizer.enabled}
                      onChange={() => updateVisualizer({ enabled: !config.visualizer.enabled })}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Bars</div>
                <div className="sse-field">
                  <label>Bar Count</label>
                  <input
                    type="range"
                    min="8"
                    max="32"
                    value={config.visualizer.barCount}
                    onChange={(e) => updateVisualizer({ barCount: parseInt(e.target.value) })}
                  />
                  <span>{config.visualizer.barCount}</span>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Colors</div>
                <div className="sse-field">
                  <label>Start</label>
                  <input
                    type="color"
                    className="sse-color-input"
                    value={config.visualizer.colorStart}
                    onChange={(e) => updateVisualizer({ colorStart: e.target.value })}
                  />
                </div>
                <div className="sse-field">
                  <label>End</label>
                  <input
                    type="color"
                    className="sse-color-input"
                    value={config.visualizer.colorEnd}
                    onChange={(e) => updateVisualizer({ colorEnd: e.target.value })}
                  />
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Style</div>
                <div className="sse-field">
                  <select
                    value={config.visualizer.style}
                    onChange={(e) => updateVisualizer({ style: e.target.value as VisualizerConfig['style'] })}
                  >
                    <option value="bars">Bars</option>
                    <option value="wave">Wave</option>
                    <option value="circle">Circle</option>
                  </select>
                </div>
              </div>

              <p className="sse-props-hint">
                Visualizer bars react to live audio levels from OBS. When no audio is detected, a gentle idle animation plays.
              </p>
            </>
          )}

          {/* Up Next properties */}
          {selected === 'upNext' && (
            <>
              <div className="sse-props-title">Up Next Preview</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.upNext.enabled}
                      onChange={() => updateUpNext({ enabled: !config.upNext.enabled })}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Display</div>
                <div className="sse-field">
                  <label>Routine Count</label>
                  <input
                    type="range"
                    min="3"
                    max="7"
                    value={config.upNext.count}
                    onChange={(e) => updateUpNext({ count: parseInt(e.target.value) })}
                  />
                  <span>{config.upNext.count}</span>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Show Fields</div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.upNext.showDancers}
                      onChange={() => updateUpNext({ showDancers: !config.upNext.showDancers })}
                    />
                    Dancers
                  </label>
                </div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.upNext.showStudio}
                      onChange={() => updateUpNext({ showStudio: !config.upNext.showStudio })}
                    />
                    Studio
                  </label>
                </div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.upNext.showCategory}
                      onChange={() => updateUpNext({ showCategory: !config.upNext.showCategory })}
                    />
                    Category
                  </label>
                </div>
              </div>

              <p className="sse-props-hint">
                Shows upcoming routines from the competition schedule on the Starting Soon scene.
                Requires a competition to be loaded via share code.
              </p>
            </>
          )}

          {/* Pinned Chat properties */}
          {selected === 'pinnedChat' && (
            <>
              <div className="sse-props-title">Pinned Chat</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.pinnedChat.enabled}
                      onChange={() => updatePinnedChat({ enabled: !config.pinnedChat.enabled })}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className="sse-props-section">
                <div className="sse-section-label">Display</div>
                <div className="sse-field">
                  <label>Max Visible</label>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    value={config.pinnedChat.maxVisible}
                    onChange={(e) => updatePinnedChat({ maxVisible: parseInt(e.target.value) })}
                  />
                  <span>{config.pinnedChat.maxVisible}</span>
                </div>
                <div className="sse-field">
                  <label>Rotate Interval (sec)</label>
                  <input
                    type="range"
                    min="5"
                    max="15"
                    value={config.pinnedChat.rotateIntervalSec}
                    onChange={(e) => updatePinnedChat({ rotateIntervalSec: parseInt(e.target.value) })}
                  />
                  <span>{config.pinnedChat.rotateIntervalSec}s</span>
                </div>
                <div className="sse-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.pinnedChat.showTimestamps}
                      onChange={() => updatePinnedChat({ showTimestamps: !config.pinnedChat.showTimestamps })}
                    />
                    Show Timestamps
                  </label>
                </div>
              </div>

              <p className="sse-props-hint">
                Pin live chat messages from the audience to display on the break screen.
                Messages are received via the livestream chat channel.
              </p>
            </>
          )}

          {/* Title properties */}
          {selected === 'title' && (
            <>
              <div className="sse-props-title">Title</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>Text</label>
                  <input
                    type="text"
                    value={config.title}
                    onChange={(e) => updateConfig({ title: e.target.value })}
                  />
                </div>
                <div className="sse-field">
                  <label>Font Size</label>
                  <input
                    type="range"
                    min="24"
                    max="200"
                    value={config.titleFontSize}
                    onChange={(e) => updateConfig({ titleFontSize: parseInt(e.target.value) })}
                  />
                  <span>{config.titleFontSize}px</span>
                </div>
                <div className="sse-field">
                  <label>Color</label>
                  <input
                    type="color"
                    className="sse-color-input"
                    value={config.titleColor}
                    onChange={(e) => updateConfig({ titleColor: e.target.value })}
                  />
                </div>
                <div className="sse-field">
                  <label>Font</label>
                  <select
                    value={config.titleFont || ''}
                    onChange={(e) => updateConfig({ titleFont: e.target.value })}
                  >
                    {brandFont && (
                      <option value="">★ Brand ({brandFont})</option>
                    )}
                    {!brandFont && (
                      <option value="">System Default</option>
                    )}
                    {FONT_OPTIONS.filter(f => f.value !== '').map(f => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="sse-props-hint">
                Drag on the preview to reposition the title. Font defaults to your brand font if configured.
              </p>
            </>
          )}

          {/* Subtitle properties */}
          {selected === 'subtitle' && (
            <>
              <div className="sse-props-title">Subtitle</div>
              <div className="sse-props-section">
                <div className="sse-field">
                  <label>Text</label>
                  <input
                    type="text"
                    value={config.subtitle}
                    onChange={(e) => updateConfig({ subtitle: e.target.value })}
                  />
                </div>
                <div className="sse-field">
                  <label>Font Size</label>
                  <input
                    type="range"
                    min="24"
                    max="200"
                    value={config.subtitleFontSize}
                    onChange={(e) => updateConfig({ subtitleFontSize: parseInt(e.target.value) })}
                  />
                  <span>{config.subtitleFontSize}px</span>
                </div>
                <div className="sse-field">
                  <label>Color</label>
                  <input
                    type="color"
                    className="sse-color-input"
                    value={config.subtitleColor}
                    onChange={(e) => updateConfig({ subtitleColor: e.target.value })}
                  />
                </div>
                <div className="sse-field">
                  <label>Font</label>
                  <select
                    value={config.subtitleFont || ''}
                    onChange={(e) => updateConfig({ subtitleFont: e.target.value })}
                  >
                    {brandFont && (
                      <option value="">★ Brand ({brandFont})</option>
                    )}
                    {!brandFont && (
                      <option value="">System Default</option>
                    )}
                    {FONT_OPTIONS.filter(f => f.value !== '').map(f => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="sse-props-hint">
                Drag on the preview to reposition the subtitle. Font defaults to your brand font if configured.
              </p>
            </>
          )}

          {/* Generic fallback for elements without custom panels */}
          {selected && selected !== 'background' && selected !== 'title' && selected !== 'subtitle' && selected !== 'ticker' && selected !== 'socialBar' && selected !== 'eventCard' && selected !== 'videoPlaylist' && selected !== 'photoSlideshow' && selected !== 'sponsorCarousel' && selected !== 'visualizer' && selected !== 'upNext' && selected !== 'pinnedChat' && (
            <>
              <div className="sse-props-title">{ELEMENT_LABELS[selected]}</div>
              <p className="sse-props-hint">
                Element properties will be available in a future update. Toggle visibility using the checkbox in the left panel.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
