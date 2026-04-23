import React from 'react'
import { createRoot } from 'react-dom/client'
import PanelApp from './components/PanelApp'
import { initIPCListeners, useStore } from './store/useStore'
import './styles/global.css'
import './styles/panels.css'

const params = new URLSearchParams(window.location.search)
const panelId = params.get('panel') ?? 'currentRoutine'

if (window.api) {
  initIPCListeners()
  window.api.settingsGet().then((settings) => {
    useStore.getState().setSettings(settings)
  }).catch(() => {})
  window.api.stateGet().then((snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return
    const s = snapshot as {
      competition: unknown
      currentRoutine: unknown
      nextRoutine: unknown
      currentIndex: unknown
    }
    useStore.setState({
      competition: (s.competition as any) ?? null,
      currentRoutine: (s.currentRoutine as any) ?? null,
      nextRoutine: (s.nextRoutine as any) ?? null,
      currentIndex: typeof s.currentIndex === 'number' ? s.currentIndex : 0,
    })
    useStore.getState().recalcCounts()
  }).catch(() => {})
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <PanelApp panelId={panelId} />
  </React.StrictMode>,
)
