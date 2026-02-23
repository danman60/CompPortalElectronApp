import React, { useState, useEffect } from 'react'

interface OverlayToggles {
  counter: boolean
  clock: boolean
  logo: boolean
  lowerThird: boolean
}

export default function OverlayControls(): React.ReactElement {
  const [autoFire, setAutoFire] = useState(false)
  const [toggles, setToggles] = useState<OverlayToggles>({
    counter: true, clock: false, logo: true, lowerThird: false,
  })

  useEffect(() => {
    window.api.overlayGetState().then((state: any) => {
      if (state) {
        setToggles({
          counter: state.counter?.visible ?? true,
          clock: state.clock?.visible ?? false,
          logo: state.logo?.visible ?? true,
          lowerThird: state.lowerThird?.visible ?? false,
        })
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

  async function handleAutoFireToggle(): Promise<void> {
    const newState = await window.api.overlayAutoFireToggle()
    setAutoFire(newState as boolean)
  }

  const toggleBtn = (label: string, element: keyof OverlayToggles) => (
    <button
      key={element}
      style={{
        padding: '4px 8px',
        background: toggles[element] ? 'rgba(34,197,94,0.15)' : 'var(--bg-secondary)',
        border: `1px solid ${toggles[element] ? 'var(--success)' : 'var(--border)'}`,
        borderRadius: '4px',
        color: toggles[element] ? 'var(--success)' : 'var(--text-secondary)',
        fontSize: '9px',
        fontWeight: toggles[element] ? 600 : 400,
        transition: 'all 0.15s',
      }}
      onClick={() => handleToggle(element)}
    >
      {label}
    </button>
  )

  return (
    <div className="section">
      <div className="section-title">Overlay</div>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
        {toggleBtn('Counter', 'counter')}
        {toggleBtn('Clock', 'clock')}
        {toggleBtn('Logo', 'logo')}
        <span style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 2px' }} />
        <button
          style={{
            padding: '4px 8px',
            background: autoFire ? 'rgba(34,197,94,0.15)' : 'var(--bg-secondary)',
            border: `1px solid ${autoFire ? 'var(--success)' : 'var(--border)'}`,
            borderRadius: '4px',
            color: autoFire ? 'var(--success)' : 'var(--text-secondary)',
            fontSize: '9px', fontWeight: autoFire ? 600 : 400,
            transition: 'all 0.15s',
          }}
          onClick={handleAutoFireToggle}
        >
          Auto {autoFire ? 'ON' : 'OFF'}
        </button>
        <button
          style={{
            padding: '4px 8px', background: 'var(--bg-secondary)',
            border: '1px solid var(--border)', borderRadius: '4px',
            color: 'var(--text-primary)', fontSize: '9px', transition: 'all 0.15s',
          }}
          onClick={() => window.api.overlayFireLT()}
        >
          Fire LT
        </button>
        <button
          style={{
            padding: '4px 8px', background: 'var(--bg-secondary)',
            border: '1px solid var(--border)', borderRadius: '4px',
            color: 'var(--text-primary)', fontSize: '9px', transition: 'all 0.15s',
          }}
          onClick={() => window.api.overlayHideLT()}
        >
          Hide LT
        </button>
      </div>
    </div>
  )
}
