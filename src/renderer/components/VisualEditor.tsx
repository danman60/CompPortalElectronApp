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
          </div>
        )}
      </div>
    </div>
  )
}
