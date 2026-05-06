import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useStore } from '../store/useStore'
import type { OverlayLayout, ElementPosition } from '../../shared/types'
import { DEFAULT_LAYOUT } from '../../shared/types'
import '../styles/visualEditor.css'

type ElementKey = keyof OverlayLayout

interface DragState {
  element: ElementKey
  startX: number
  startY: number
  startPos: ElementPosition
  mode: 'move' | 'resize'
  handle?: string
}

interface SnapLine {
  axis: 'x' | 'y'
  position: number
}

const SNAP_THRESHOLD = 1.5
const SNAP_TARGETS = [0, 5, 10, 25, 50, 75, 90, 95, 100]

function findSnap(value: number, targets: number[]): number | null {
  for (const t of targets) {
    if (Math.abs(value - t) < SNAP_THRESHOLD) return t
  }
  return null
}

const ELEMENT_LABELS: Record<ElementKey, string> = {
  counter: 'Counter',
  clock: 'Clock',
  logo: 'Logo',
  lowerThird: 'Lower Third',
}

export function VisualEditor({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [iframeScale, setIframeScale] = useState(0.5)
  const [selected, setSelected] = useState<ElementKey | null>(null)
  // Non-layout elements (no X/Y/W/H — full-bleed or rail-bound). When set,
  // the props panel renders SelectedElementProperties only. Mutually
  // exclusive with `selected` so only one panel is open.
  const [stylePick, setStylePick] = useState<'ticker' | 'startingSoon' | 'featureCard' | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [layout, setLayout] = useState<OverlayLayout>({ ...DEFAULT_LAYOUT })
  const [showGrid, setShowGrid] = useState(false)
  const [snapLines, setSnapLines] = useState<SnapLine[]>([])
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [previewToggles, setPreviewToggles] = useState<Record<ElementKey, boolean>>({
    counter: true,
    clock: true,
    logo: true,
    lowerThird: true,
  })

  // Scale iframe to fit canvas
  useEffect(() => {
    function updateIframeScale(): void {
      const canvas = canvasRef.current
      if (!canvas) return
      setIframeScale(canvas.clientWidth / 1920)
    }
    updateIframeScale()
    const obs = new ResizeObserver(updateIframeScale)
    if (canvasRef.current) obs.observe(canvasRef.current)
    return () => obs.disconnect()
  }, [])

  // Load saved layout from overlay state on mount
  useEffect(() => {
    window.api.overlayGetState().then((state: any) => {
      if (state?.layout) {
        setLayout({ ...DEFAULT_LAYOUT, ...state.layout })
      }
    })
  }, [])

  // Live-push layout to overlay on every change (debounced 50ms)
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushLayout = useMemo(() => (l: OverlayLayout) => {
    if (pushTimer.current) clearTimeout(pushTimer.current)
    pushTimer.current = setTimeout(() => {
      window.api.overlayUpdateLayout(l)
    }, 50)
  }, [])

  useEffect(() => {
    pushLayout(layout)
  }, [layout, pushLayout])

  useEffect(() => {
    return () => { if (pushTimer.current) clearTimeout(pushTimer.current) }
  }, [])

  const toCanvasPercent = useCallback(
    (clientX: number, clientY: number): { px: number; py: number } => {
      const canvas = canvasRef.current
      if (!canvas) return { px: 0, py: 0 }
      const rect = canvas.getBoundingClientRect()
      // rect already accounts for CSS transform scale
      return {
        px: ((clientX - rect.left) / rect.width) * 100,
        py: ((clientY - rect.top) / rect.height) * 100,
      }
    },
    [],
  )

  function handleMouseDown(e: React.MouseEvent, element: ElementKey) {
    e.stopPropagation()
    e.preventDefault()
    setSelected(element)
    const { px, py } = toCanvasPercent(e.clientX, e.clientY)
    setDrag({
      element,
      startX: px,
      startY: py,
      startPos: { ...layout[element] },
      mode: 'move',
    })
  }

  function handleResizeDown(e: React.MouseEvent, element: ElementKey, handle: string) {
    e.stopPropagation()
    e.preventDefault()
    const { px, py } = toCanvasPercent(e.clientX, e.clientY)
    setDrag({
      element,
      startX: px,
      startY: py,
      startPos: { ...layout[element] },
      mode: 'resize',
      handle,
    })
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!drag) return
    const { px, py } = toCanvasPercent(e.clientX, e.clientY)
    const dx = px - drag.startX
    const dy = py - drag.startY

    if (drag.mode === 'resize') {
      setLayout((prev) => {
        const pos = { ...prev[drag.element] }
        const handle = drag.handle || ''
        if (handle.includes('right')) {
          pos.width = Math.max(5, Math.min(100 - pos.x, (drag.startPos.width || 20) + dx))
        }
        if (handle.includes('bottom')) {
          pos.height = Math.max(3, Math.min(100 - pos.y, (drag.startPos.height || 10) + dy))
        }
        return { ...prev, [drag.element]: pos }
      })
      return
    }

    // Move with snapping
    let newX = Math.max(0, Math.min(95, drag.startPos.x + dx))
    let newY = Math.max(0, Math.min(98, drag.startPos.y + dy))

    const activeSnaps: SnapLine[] = []
    const snapX = findSnap(newX, SNAP_TARGETS)
    const snapY = findSnap(newY, SNAP_TARGETS)

    if (snapX !== null) {
      newX = snapX
      activeSnaps.push({ axis: 'x', position: snapX })
    }
    if (snapY !== null) {
      newY = snapY
      activeSnaps.push({ axis: 'y', position: snapY })
    }

    // Snap to center
    const elW = layout[drag.element].width || 10
    const centerX = newX + elW / 2
    const snapCenterX = findSnap(centerX, [50])
    if (snapCenterX !== null) {
      newX = 50 - elW / 2
      activeSnaps.push({ axis: 'x', position: 50 })
    }

    setSnapLines(activeSnaps)
    setLayout((prev) => ({
      ...prev,
      [drag.element]: { ...prev[drag.element], x: newX, y: newY },
    }))
  }

  function handleMouseUp() {
    setDrag(null)
    setSnapLines([])
  }

  function handleCanvasClick(e: React.MouseEvent) {
    if (e.target === canvasRef.current) {
      setSelected(null)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
      setShowGrid((v) => !v)
      return
    }
    if (!selected) return
    const step = e.shiftKey ? 2 : 0.5
    setLayout((prev) => {
      const pos = { ...prev[selected] }
      switch (e.key) {
        case 'ArrowLeft':
          pos.x = Math.max(0, pos.x - step)
          break
        case 'ArrowRight':
          pos.x = Math.min(95, pos.x + step)
          break
        case 'ArrowUp':
          pos.y = Math.max(0, pos.y - step)
          break
        case 'ArrowDown':
          pos.y = Math.min(98, pos.y + step)
          break
        default:
          return prev
      }
      e.preventDefault()
      return { ...prev, [selected]: pos }
    })
  }

  // Store initial layout for cancel/restore
  const initialLayout = useRef<OverlayLayout>(layout)
  useEffect(() => {
    window.api.overlayGetState().then((state: any) => {
      if (state?.layout) {
        initialLayout.current = { ...DEFAULT_LAYOUT, ...state.layout }
      }
    })
  }, [])

  function handleSave() {
    // Layout already pushed live — just close
    onClose()
  }

  function handleCancel() {
    // Restore original layout
    window.api.overlayUpdateLayout(initialLayout.current)
    onClose()
  }

  function handleReset() {
    setLayout({ ...DEFAULT_LAYOUT })
  }

  function handlePreviewToggle(element: ElementKey) {
    const newVisible = !previewToggles[element]
    setPreviewToggles((prev) => ({ ...prev, [element]: newVisible }))
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'preview-toggle', element, visible: newVisible },
      '*',
    )
  }

  const resizeHandles = (element: ElementKey) => {
    if (selected !== element) return null
    return (
      <>
        <div
          className="ve-resize-handle ve-handle-right"
          onMouseDown={(e) => handleResizeDown(e, element, 'right')}
        />
        <div
          className="ve-resize-handle ve-handle-bottom"
          onMouseDown={(e) => handleResizeDown(e, element, 'bottom')}
        />
        <div
          className="ve-resize-handle ve-handle-bottom-right"
          onMouseDown={(e) => handleResizeDown(e, element, 'bottom-right')}
        />
      </>
    )
  }

  return (
    <div
      className="ve-overlay"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      ref={(el) => el?.focus()}
    >
      <div className="ve-header">
        <span className="ve-title">Visual Overlay Editor</span>
        <div className="ve-actions">
          <button
            className={showGrid ? 'active' : undefined}
            onClick={() => setShowGrid((v) => !v)}
            title="Toggle grid (G)"
          >
            Grid
          </button>
          <span className="ve-toggle-group">
            {(['counter', 'clock', 'logo', 'lowerThird'] as ElementKey[]).map((el) => (
              <button
                key={el}
                className={`ve-preview-toggle ${previewToggles[el] ? 'active' : ''}`}
                onClick={() => handlePreviewToggle(el)}
                title={`Toggle ${ELEMENT_LABELS[el]} preview visibility`}
              >
                {el === 'lowerThird' ? 'LT' : ELEMENT_LABELS[el]}
              </button>
            ))}
            <button
              className="ve-preview-toggle"
              onClick={() => { try { (window.api as any)?.chatFireTest?.() } catch {} }}
              title="Fire a synthetic chat-pin overlay to test the pinned-chat broadcast path"
              style={{ borderColor: 'rgba(255, 193, 7, 0.6)', color: '#ffca55' }}
            >
              Test Chat Fire
            </button>
          </span>
          <span className="ve-toggle-group" style={{ marginLeft: 8 }}>
            {(['ticker', 'startingSoon', 'featureCard'] as const).map((k) => (
              <button
                key={k}
                className={`ve-preview-toggle ${stylePick === k ? 'active' : ''}`}
                onClick={() => {
                  setSelected(null)
                  setStylePick((prev) => (prev === k ? null : k))
                }}
                title={`Edit ${k === 'startingSoon' ? 'Starting Soon' : k === 'featureCard' ? 'Feature Card' : 'Ticker'} style + presets`}
              >
                {k === 'startingSoon' ? 'SS' : k === 'featureCard' ? 'FC' : 'Ticker'}
              </button>
            ))}
          </span>
          <button onClick={handleReset}>Reset</button>
          <button onClick={handleCancel}>Cancel</button>
          <button className="ve-btn-done" onClick={handleSave}>Done</button>
        </div>
      </div>

      <div className="ve-body">
        <div className="ve-canvas-wrapper">
          <div
            className="ve-canvas"
            ref={canvasRef}
            onClick={handleCanvasClick}
          >
            {/* Live overlay iframe — pixel-perfect 1:1 preview */}
            <iframe
              ref={iframeRef}
              className="ve-overlay-iframe"
              src="http://localhost:9876/overlay?preview=1"
              style={{ transform: `scale(${iframeScale})` }}
              title="Overlay Preview"
            />

            {/* Safe zone guide */}
            <div className="ve-safe-zone" />

            {/* Grid overlay */}
            {showGrid && (
              <div className="ve-grid">
                {[10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90].map((p) => (
                  <div key={`gx-${p}`} className="ve-grid-line ve-grid-v" style={{ left: `${p}%` }} />
                ))}
                {[10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90].map((p) => (
                  <div key={`gy-${p}`} className="ve-grid-line ve-grid-h" style={{ top: `${p}%` }} />
                ))}
              </div>
            )}

            {/* Snap guides */}
            {snapLines.map((sl, i) =>
              sl.axis === 'x' ? (
                <div key={`snap-${i}`} className="ve-snap-line ve-snap-v" style={{ left: `${sl.position}%` }} />
              ) : (
                <div key={`snap-${i}`} className="ve-snap-line ve-snap-h" style={{ top: `${sl.position}%` }} />
              ),
            )}

            {/* Draggable hit targets — transparent overlays on top of iframe */}
            {(['counter', 'clock', 'logo', 'lowerThird'] as ElementKey[]).map((element) => (
              <div
                key={element}
                className={`ve-element ve-handle-target ${selected === element ? 'selected' : ''}`}
                style={{
                  left: `${layout[element].x}%`,
                  top: `${layout[element].y}%`,
                  width: layout[element].width ? `${layout[element].width}%` : element === 'lowerThird' ? '30%' : '8%',
                  height: layout[element].height ? `${layout[element].height}%` : element === 'lowerThird' ? '12%' : '8%',
                }}
                onMouseDown={(e) => handleMouseDown(e, element)}
              >
                <span className="ve-label">{ELEMENT_LABELS[element]}</span>
                {resizeHandles(element)}
              </div>
            ))}
          </div>
        </div>

        {/* Properties panel */}
        {selected && (
          <div className="ve-props">
            <div className="ve-props-title">{ELEMENT_LABELS[selected]}</div>
            <div className="ve-props-field">
              <label>X</label>
              <input
                type="number"
                step={0.1}
                value={Number(layout[selected].x.toFixed(1))}
                onChange={(e) =>
                  setLayout((prev) => ({
                    ...prev,
                    [selected]: { ...prev[selected], x: Number(e.target.value) },
                  }))
                }
              />
              <span>%</span>
            </div>
            <div className="ve-props-field">
              <label>Y</label>
              <input
                type="number"
                step={0.1}
                value={Number(layout[selected].y.toFixed(1))}
                onChange={(e) =>
                  setLayout((prev) => ({
                    ...prev,
                    [selected]: { ...prev[selected], y: Number(e.target.value) },
                  }))
                }
              />
              <span>%</span>
            </div>
            {layout[selected].width !== undefined && (
              <div className="ve-props-field">
                <label>W</label>
                <input
                  type="number"
                  step={0.1}
                  value={Number((layout[selected].width || 0).toFixed(1))}
                  onChange={(e) =>
                    setLayout((prev) => ({
                      ...prev,
                      [selected]: { ...prev[selected], width: Number(e.target.value) },
                    }))
                  }
                />
                <span>%</span>
              </div>
            )}
            {layout[selected].height !== undefined && (
              <div className="ve-props-field">
                <label>H</label>
                <input
                  type="number"
                  step={0.1}
                  value={Number((layout[selected].height || 0).toFixed(1))}
                  onChange={(e) =>
                    setLayout((prev) => ({
                      ...prev,
                      [selected]: { ...prev[selected], height: Number(e.target.value) },
                    }))
                  }
                />
                <span>%</span>
              </div>
            )}
            <p className="ve-props-hint">
              Arrows nudge. Shift+arrow = 2%. G = grid.
            </p>
            <SelectedElementProperties elementKey={selected} />
          </div>
        )}
        {!selected && stylePick && (
          <div className="ve-props">
            <div className="ve-props-title">
              {stylePick === 'startingSoon' ? 'Starting Soon' : stylePick === 'featureCard' ? 'Feature Card' : 'Ticker'}
            </div>
            <p className="ve-props-hint">
              Card style, sub-elements, asset & presets. Layout/position is fixed for this element.
            </p>
            <SelectedElementProperties elementKey={stylePick} />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 2026-05-04 — generic per-element properties panel. Renders three sections:
 *   1) Card BG / blur / padding / border (uniform across every element)
 *   2) Sub-elements — per-element list of (font-size, color, weight, order,
 *      show) inputs. The set of sub-elements is element-specific and lives in
 *      state.<element>.subElements.
 *   3) Asset URL override (logo, lowerThird brand glyph, startingSoon SS logo).
 *      mp4/webm/mov/m4v get rendered as <video>; other extensions = <img>.
 *   4) Presets — list, save-as-name, load, delete. Per-element namespace.
 *
 * Default values are no-op (fontSize=0, color='', borderWidth=-1) so this
 * panel is a pure progressive enhancement — empty + reset = no operator-
 * visible regression.
 */
type AnyElementKey = 'counter' | 'clock' | 'logo' | 'lowerThird' | 'ticker' | 'startingSoon' | 'featureCard'

interface SubStyle { fontSize: number; color: string; fontWeight: number; order: number; show: boolean }
interface CardStyle {
  backgroundColor: string; backgroundOpacity: number; backdropBlur: number
  paddingX: number; paddingY: number; innerGap: number
  borderRadius: number; borderColor: string; borderWidth: number
}
interface ElementSnapshot {
  card: CardStyle
  subElements: Record<string, SubStyle>
  presets: Record<string, unknown>
  activePreset: string | null
  assetUrl: string                  // logo / startingSoon
  brandGlyphUrl?: string            // lowerThird
  showBrandGlyph?: boolean
  showEntryNumber?: boolean
  showRoutineTitle?: boolean
  showDancers?: boolean
  showStudioName?: boolean
  showCategory?: boolean
}

const ASSET_KEYS: AnyElementKey[] = ['logo', 'lowerThird', 'startingSoon', 'featureCard']

const SUB_LABELS: Partial<Record<string, string>> = {
  number: 'Number', label: 'Label',
  time: 'Time', date: 'Date',
  image: 'Image',
  brandGlyph: 'Brand glyph', entryNumber: 'Entry #',
  routineTitle: 'Routine title', dancers: 'Dancers',
  studioName: 'Studio', category: 'Category',
  text: 'Text',
  logo: 'Logo', title: 'Title', accent: 'Accent line',
  subtitle: 'Subtitle', countdown: 'Countdown',
  // Feature Card sub-element labels (2026-05-04)
  header: 'Header label', studioLogo: 'Studio logo',
  nextHeader: 'Next-strip header', nextEntryNumber: 'Next entry #',
  nextRoutineTitle: 'Next title', nextStudioName: 'Next studio',
}

function SelectedElementProperties({ elementKey }: { elementKey: AnyElementKey }): React.ReactElement | null {
  const [snap, setSnap] = useState<ElementSnapshot | null>(null)
  const [presetName, setPresetName] = useState('')

  // Sync snapshot from main on mount + every 2s — picks up external edits
  // (Stream Deck, other windows) without a manual refresh.
  useEffect(() => {
    let cancelled = false
    const sync = (): void => {
      ;(window.api as any).overlayGetState().then((state: any) => {
        if (cancelled) return
        const el = state?.[elementKey]
        if (!el) return
        setSnap({
          card: el.card || {} as CardStyle,
          subElements: el.subElements || {},
          presets: el.presets || {},
          activePreset: el.activePreset ?? null,
          assetUrl: el.assetUrl || el.brandGlyphUrl || '',
          brandGlyphUrl: el.brandGlyphUrl || '',
          showBrandGlyph: el.showBrandGlyph,
          showEntryNumber: el.showEntryNumber,
          showRoutineTitle: el.showRoutineTitle,
          showDancers: el.showDancers,
          showStudioName: el.showStudioName,
          showCategory: el.showCategory,
        })
      }).catch(() => {})
    }
    sync()
    const poll = setInterval(sync, 2000)
    return () => { cancelled = true; clearInterval(poll) }
  }, [elementKey])

  function pushCard(partial: Partial<CardStyle>): void {
    if (!snap) return
    setSnap({ ...snap, card: { ...snap.card, ...partial } })
    ;(window.api as any).overlaySetElementStyle?.(elementKey, { card: partial })
  }
  function pushSub(subKey: string, partial: Partial<SubStyle>): void {
    if (!snap) return
    setSnap({
      ...snap,
      subElements: { ...snap.subElements, [subKey]: { ...snap.subElements[subKey], ...partial } as SubStyle },
    })
    ;(window.api as any).overlaySetElementStyle?.(elementKey, { subElements: { [subKey]: partial } })
  }
  function pushAsset(url: string): void {
    if (!snap) return
    setSnap({ ...snap, assetUrl: url, brandGlyphUrl: url })
    ;(window.api as any).overlaySetElementStyle?.(elementKey, { assetUrl: url })
  }
  function pushLTFlag(key: keyof ElementSnapshot, value: boolean): void {
    if (!snap) return
    setSnap({ ...snap, [key]: value } as ElementSnapshot)
    ;(window.api as any).overlaySetLowerThird?.({ [key]: value })
  }

  async function browseAsset(): Promise<void> {
    const result = await (window.api as any).settingsBrowseFile?.([
      { name: 'Image / Video', extensions: ['png','jpg','jpeg','svg','webp','gif','apng','avif','mp4','webm','mov','m4v'] },
    ])
    if (!result || !result.length) return
    const filePath = String(result[0])
    pushAsset(filePath)
  }

  function savePreset(): void {
    const trimmed = presetName.trim()
    if (!trimmed) return
    ;(window.api as any).overlaySavePreset?.(elementKey, trimmed)
    setPresetName('')
  }
  function loadPreset(name: string): void {
    ;(window.api as any).overlayLoadPreset?.(elementKey, name)
  }
  function deletePreset(name: string): void {
    if (!confirm(`Delete preset "${name}"?`)) return
    ;(window.api as any).overlayDeletePreset?.(elementKey, name)
  }

  if (!snap) return null
  const subKeys = Object.keys(snap.subElements)
  const presetNames = Object.keys(snap.presets || {})
  const supportsAsset = ASSET_KEYS.includes(elementKey)

  return (
    <>
      {/* ── LT-only legacy show flags ── */}
      {elementKey === 'lowerThird' && (
        <>
          <div className="ve-props-section-divider" />
          <div className="ve-props-section-title">Show in LT</div>
          {([
            ['showBrandGlyph', 'Brand logo'],
            ['showEntryNumber', 'Entry #'],
            ['showRoutineTitle', 'Routine title'],
            ['showDancers', 'Dancers'],
            ['showStudioName', 'Studio name'],
            ['showCategory', 'Category'],
          ] as Array<[keyof ElementSnapshot, string]>).map(([k, label]) => (
            <label key={String(k)} className="ve-props-checkbox">
              <input
                type="checkbox"
                checked={snap[k] !== false}
                onChange={(e) => pushLTFlag(k, e.target.checked)}
              />
              <span>{label}</span>
            </label>
          ))}
        </>
      )}

      {/* ── Card ── */}
      <div className="ve-props-section-divider" />
      <div className="ve-props-section-title">Card</div>
      <div className="ve-props-row2">
        <label className="ve-props-color-row">
          <span>BG</span>
          <input
            type="color"
            className="ve-props-color"
            value={snap.card.backgroundColor || '#1e1e2e'}
            onChange={(e) => pushCard({ backgroundColor: e.target.value })}
          />
          <button className="ve-props-clear-btn" onClick={() => pushCard({ backgroundColor: '' })} title="Clear background override">×</button>
        </label>
      </div>
      <div className="ve-props-field">
        <label>Op</label>
        <input type="number" step={0.05} min={0} max={1} className="ve-props-number"
          value={Number(snap.card.backgroundOpacity ?? 1)}
          onChange={(e) => pushCard({ backgroundOpacity: Number(e.target.value) })}
        />
      </div>
      <div className="ve-props-field">
        <label>Blur</label>
        <input type="number" step={1} min={0} max={50} className="ve-props-number"
          value={Number(snap.card.backdropBlur ?? 0)}
          onChange={(e) => pushCard({ backdropBlur: Number(e.target.value) })}
        />
        <span>px</span>
      </div>
      <div className="ve-props-field">
        <label>Pad-X</label>
        <input type="number" step={1} min={0} className="ve-props-number"
          value={Number(snap.card.paddingX ?? 0)}
          onChange={(e) => pushCard({ paddingX: Number(e.target.value) })}
        />
      </div>
      <div className="ve-props-field">
        <label>Pad-Y</label>
        <input type="number" step={1} min={0} className="ve-props-number"
          value={Number(snap.card.paddingY ?? 0)}
          onChange={(e) => pushCard({ paddingY: Number(e.target.value) })}
        />
      </div>
      <div className="ve-props-field">
        <label>Gap</label>
        <input type="number" step={1} min={0} className="ve-props-number"
          value={Number(snap.card.innerGap ?? 0)}
          onChange={(e) => pushCard({ innerGap: Number(e.target.value) })}
        />
      </div>
      <div className="ve-props-field">
        <label>Radius</label>
        <input type="number" step={1} min={0} className="ve-props-number"
          value={Number(snap.card.borderRadius ?? 0)}
          onChange={(e) => pushCard({ borderRadius: Number(e.target.value) })}
        />
      </div>
      <div className="ve-props-field">
        <label>Border</label>
        <input type="number" step={1} min={-1} className="ve-props-number"
          value={Number(snap.card.borderWidth ?? -1)}
          onChange={(e) => pushCard({ borderWidth: Number(e.target.value) })}
        />
        <input type="color" className="ve-props-color"
          value={snap.card.borderColor || '#667eea'}
          onChange={(e) => pushCard({ borderColor: e.target.value })}
        />
      </div>

      {/* ── Sub-elements ── */}
      {subKeys.length > 0 && (
        <>
          <div className="ve-props-section-divider" />
          <div className="ve-props-section-title">Sub-elements</div>
          {subKeys.map((sk) => {
            const s = snap.subElements[sk] || { fontSize: 0, color: '', fontWeight: 0, order: 0, show: true }
            return (
              <div key={sk} className="ve-props-sub">
                <div className="ve-props-sub-title">{SUB_LABELS[sk] || sk}</div>
                <label className="ve-props-checkbox">
                  <input type="checkbox" checked={s.show !== false}
                    onChange={(e) => pushSub(sk, { show: e.target.checked })}
                  />
                  <span>Show</span>
                </label>
                <div className="ve-props-field">
                  <label>Size</label>
                  <input type="number" step={1} min={0} className="ve-props-number"
                    value={Number(s.fontSize ?? 0)}
                    onChange={(e) => pushSub(sk, { fontSize: Number(e.target.value) })}
                  />
                </div>
                <div className="ve-props-field">
                  <label>Wgt</label>
                  <input type="number" step={100} min={0} max={900} className="ve-props-number"
                    value={Number(s.fontWeight ?? 0)}
                    onChange={(e) => pushSub(sk, { fontWeight: Number(e.target.value) })}
                  />
                </div>
                <div className="ve-props-field">
                  <label>Ord</label>
                  <input type="number" step={1} className="ve-props-number"
                    value={Number(s.order ?? 0)}
                    onChange={(e) => pushSub(sk, { order: Number(e.target.value) })}
                  />
                </div>
                <label className="ve-props-color-row">
                  <span>Color</span>
                  <input type="color" className="ve-props-color"
                    value={s.color || '#ffffff'}
                    onChange={(e) => pushSub(sk, { color: e.target.value })}
                  />
                  <button className="ve-props-clear-btn" onClick={() => pushSub(sk, { color: '' })} title="Clear color override">×</button>
                </label>
              </div>
            )
          })}
        </>
      )}

      {/* ── Asset override ── */}
      {supportsAsset && (
        <>
          <div className="ve-props-section-divider" />
          <div className="ve-props-section-title">Asset override</div>
          <div className="ve-props-asset">
            <input
              type="text"
              className="ve-props-asset-url"
              placeholder="(default brand logo)"
              value={snap.assetUrl || ''}
              onChange={(e) => pushAsset(e.target.value)}
            />
            <button className="ve-props-asset-browse" onClick={browseAsset}>Browse…</button>
            {snap.assetUrl && (
              <button className="ve-props-clear-btn" onClick={() => pushAsset('')} title="Clear asset override">×</button>
            )}
          </div>
          <p className="ve-props-hint">.mp4/.webm/.mov = video; png/jpg/svg/webp/gif = image.</p>
        </>
      )}

      {/* ── Presets ── */}
      <div className="ve-props-section-divider" />
      <div className="ve-props-section-title">Presets</div>
      <div className="ve-props-presets">
        {presetNames.length === 0 && <div className="ve-props-hint">No saved presets.</div>}
        {presetNames.map((name) => (
          <div key={name} className="ve-props-preset-row">
            <button
              className={`ve-props-preset-load ${snap.activePreset === name ? 'active' : ''}`}
              onClick={() => loadPreset(name)}
              title="Load this preset"
            >
              {name}
            </button>
            <button className="ve-props-clear-btn" onClick={() => deletePreset(name)} title="Delete preset">×</button>
          </div>
        ))}
        <div className="ve-props-preset-save">
          <input
            type="text"
            className="ve-props-asset-url"
            placeholder="Save as…"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') savePreset() }}
          />
          <button className="ve-props-asset-browse" onClick={savePreset} disabled={!presetName.trim()}>Save</button>
        </div>
      </div>
    </>
  )
}
