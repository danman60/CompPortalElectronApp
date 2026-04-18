import React from 'react'
import { createRoot } from 'react-dom/client'
import ErrorBoundary from './components/ErrorBoundary'
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
  window.api.scheduleGet().then((comp) => {
    if (comp) useStore.getState().setCompetition(comp)
  }).catch(() => {})
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <PanelApp panelId={panelId} />
    </ErrorBoundary>
  </React.StrictMode>,
)
