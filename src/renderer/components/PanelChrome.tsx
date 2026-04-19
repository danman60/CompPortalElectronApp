import React from 'react'
import { useImportMinimizedState, restoreMinimizedImport } from './DriveAlert'

interface PanelChromeProps {
  title: string
  showExit?: boolean
  children: React.ReactNode
}

/**
 * Compact import-progress pill for overlay panel titlebars. Subscribes to
 * the same module-level state the Header pill does, so SD import progress
 * is visible no matter which mode the operator is in.
 */
function OverlayImportPill(): React.ReactElement | null {
  const s = useImportMinimizedState()
  if (!s.active) return null
  const pct = s.total > 0 ? Math.min(100, Math.round((s.current / s.total) * 100)) : 0
  const label = s.total > 0 ? `${s.current}/${s.total} (${pct}%)` : '...'
  return (
    <button
      onClick={() => restoreMinimizedImport()}
      title="SD import in progress — click to expand (exits overlay mode)"
      style={{
        background: 'rgba(99, 102, 234, 0.18)',
        border: '1px solid rgba(99, 102, 234, 0.55)',
        color: '#e0e0f0',
        fontSize: '10px',
        padding: '2px 6px',
        borderRadius: '3px',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        marginRight: '6px',
      }}
    >
      <span style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: '#2da855',
        boxShadow: '0 0 4px #2da855',
        flex: '0 0 auto',
      }} />
      <span style={{ whiteSpace: 'nowrap' }}>SD {label}</span>
      {s.total > 0 && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            height: '2px',
            width: `${pct}%`,
            background: '#2da855',
            transition: 'width 0.2s linear',
          }}
        />
      )}
    </button>
  )
}

/**
 * Shared wrapper for every Overlay Mode panel. Provides the drag region,
 * an optional Exit Overlay button (only on the SystemStats panel per spec),
 * a compact SD-import progress pill (visible in all panels while an import
 * runs), and a resize grab corner.
 */
export default function PanelChrome({ title, showExit = false, children }: PanelChromeProps): React.ReactElement {
  async function handleExit(): Promise<void> {
    try { await window.api.overlayModeClose() } catch { /* ignore */ }
  }

  return (
    <div className="panel-root">
      <div className="panel-titlebar">
        <span className="panel-title">{title}</span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>
          <OverlayImportPill />
          {showExit && (
            <button
              className="panel-exit-btn"
              onClick={handleExit}
              title="Exit Overlay Mode"
            >
              Exit Overlay
            </button>
          )}
        </div>
      </div>
      <div className="panel-body">
        {children}
      </div>
      <div className="panel-resize-corner" />
    </div>
  )
}
