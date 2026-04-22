import React from 'react'
import { useImportMinimizedState, restoreMinimizedImport } from './DriveAlert'

interface PanelChromeProps {
  title: string
  panelId: string
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
  const isComplete = s.stage === 'done' || s.canRemoveCard === true
  const pct = s.total > 0 ? Math.min(100, Math.round((s.current / s.total) * 100)) : 0
  const label = s.total > 0 ? `${s.current}/${s.total} (${pct}%)` : '...'
  return (
    <button
      onClick={() => restoreMinimizedImport()}
      title={isComplete ? 'Import complete — click to expand details' : 'SD import in progress — click to expand (exits overlay mode)'}
      style={{
        background: isComplete ? 'rgba(45, 168, 85, 0.18)' : 'rgba(99, 102, 234, 0.18)',
        border: isComplete ? '1px solid rgba(45, 168, 85, 0.65)' : '1px solid rgba(99, 102, 234, 0.55)',
        color: isComplete ? '#dff7e7' : '#e0e0f0',
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
        animation: isComplete ? 'importCompleteFlash 1s ease-in-out infinite' : undefined,
      }}
    >
      {isComplete ? (
        <>
          <span style={{ flex: '0 0 auto', fontSize: '11px' }}>{'\u23CF'}</span>
          <span style={{ whiteSpace: 'nowrap' }}>Import Complete</span>
        </>
      ) : (
        <>
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: '#2da855',
            boxShadow: '0 0 4px #2da855',
            flex: '0 0 auto',
          }} />
          <span style={{ whiteSpace: 'nowrap' }}>SD {label}</span>
        </>
      )}
      {!isComplete && s.total > 0 && (
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
export default function PanelChrome({ title, panelId, showExit = false, children }: PanelChromeProps): React.ReactElement {
  async function handleExit(): Promise<void> {
    try { await window.api.overlayModeClose() } catch { /* ignore */ }
  }

  async function handleHidePanel(): Promise<void> {
    try { await window.api.overlayModeHidePanel(panelId) } catch { /* ignore */ }
  }

  return (
    <div className="panel-root">
      <div className="panel-titlebar">
        <span className="panel-title">{title}</span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>
          <OverlayImportPill />
          <button
            className="panel-hide-btn"
            onClick={handleHidePanel}
            title="Hide this panel until Overlay Mode is opened again"
          >
            X
          </button>
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
