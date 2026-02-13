import React from 'react'
import { useStore } from '../store/useStore'

export default function LowerThirdControls(): React.ReactElement {
  const settings = useStore((s) => s.settings)

  return (
    <div className="section">
      <div className="section-title">Lower Third</div>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <button
          className="lt-btn"
          style={{
            padding: '5px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            color: 'var(--success)',
            fontSize: '10px',
            borderColor: 'var(--success)',
            transition: 'all 0.15s',
          }}
        >
          Auto-fire
        </button>
        <button
          style={{
            padding: '5px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            color: 'var(--text-primary)',
            fontSize: '10px',
            transition: 'all 0.15s',
          }}
          onClick={() => window.api.ltFire()}
        >
          Fire Now
        </button>
        <button
          style={{
            padding: '5px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            color: 'var(--text-primary)',
            fontSize: '10px',
            transition: 'all 0.15s',
          }}
          onClick={() => window.api.ltHide()}
        >
          Hide
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
          Hotkey: {settings?.hotkeys.fireLowerThird || 'F9'}
        </span>
      </div>
    </div>
  )
}
