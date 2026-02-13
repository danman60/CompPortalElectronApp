import React, { useState } from 'react'
import { useStore } from '../store/useStore'

export default function LowerThirdControls(): React.ReactElement {
  const settings = useStore((s) => s.settings)
  const [autoFire, setAutoFire] = useState(false)

  async function handleToggleAutoFire(): Promise<void> {
    const newState = await window.api.ltAutoFireToggle()
    setAutoFire(newState as boolean)
  }

  return (
    <div className="section">
      <div className="section-title">Lower Third</div>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <button
          style={{
            padding: '5px 10px',
            background: autoFire ? 'rgba(34,197,94,0.15)' : 'var(--bg-secondary)',
            border: `1px solid ${autoFire ? 'var(--success)' : 'var(--border)'}`,
            borderRadius: '4px',
            color: autoFire ? 'var(--success)' : 'var(--text-secondary)',
            fontSize: '10px',
            fontWeight: autoFire ? 600 : 400,
            transition: 'all 0.15s',
          }}
          onClick={handleToggleAutoFire}
        >
          Auto-fire {autoFire ? 'ON' : 'OFF'}
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
          {settings?.hotkeys.fireLowerThird || 'F9'}
        </span>
      </div>
    </div>
  )
}
