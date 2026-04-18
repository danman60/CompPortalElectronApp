import React from 'react'

interface PanelChromeProps {
  title: string
  children: React.ReactNode
}

/**
 * Shared wrapper for every Overlay Mode panel. Provides the drag region,
 * the Exit Overlay button, and a resize grab corner.
 *
 * Drag behavior: the root container is `-webkit-app-region: drag`, so the
 * operator can grab anywhere that isn't an interactive element (buttons,
 * inputs, scrollable lists) — those individually set `app-region: no-drag`.
 */
export default function PanelChrome({ title, children }: PanelChromeProps): React.ReactElement {
  async function handleExit(): Promise<void> {
    try { await window.api.overlayModeClose() } catch { /* ignore */ }
  }

  return (
    <div className="panel-root">
      <div className="panel-titlebar">
        <span className="panel-title">{title}</span>
        <button
          className="panel-exit-btn"
          onClick={handleExit}
          title="Exit Overlay Mode"
        >
          Exit Overlay
        </button>
      </div>
      <div className="panel-body">
        {children}
      </div>
      <div className="panel-resize-corner" />
    </div>
  )
}
