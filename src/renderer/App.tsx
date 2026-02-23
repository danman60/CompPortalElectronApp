import React, { useEffect, useRef } from 'react'
import { useStore, initIPCListeners } from './store/useStore'
import Header from './components/Header'
import LeftPanel from './components/LeftPanel'
import RightPanel from './components/RightPanel'
import DragHandle from './components/DragHandle'
import Settings from './components/Settings'
import './styles/app.css'

export default function App(): React.ReactElement {
  const settingsOpen = useStore((s) => s.settingsOpen)
  const compactMode = useStore((s) => s.compactMode)
  const initialized = useRef(false)

  // Ctrl+scroll zoom
  useEffect(() => {
    function handleWheel(e: WheelEvent): void {
      if (!e.ctrlKey) return
      e.preventDefault()
      if (e.deltaY < 0) {
        window.api?.setZoom('in')
      } else if (e.deltaY > 0) {
        window.api?.setZoom('out')
      }
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [])

  useEffect(() => {
    if (!window.api || initialized.current) return
    initialized.current = true

    // Initialize IPC listeners
    initIPCListeners()

    // Load initial settings and auto-connect OBS
    window.api.settingsGet().then((settings) => {
      useStore.getState().setSettings(settings)
      if (settings.obs.url) {
        window.api.obsConnect(settings.obs.url, settings.obs.password).catch(() => {})
      }
    }).catch(() => {})

    // Load persisted competition
    window.api.scheduleGet().then((comp) => {
      if (comp) {
        useStore.getState().setCompetition(comp)
      }
    }).catch(() => {})
  }, [])

  return (
    <div className={`app-layout${compactMode ? ' compact' : ''}`}>
      <Header />
      <div className="main-split">
        <LeftPanel />
        <DragHandle />
        <RightPanel />
      </div>
      {settingsOpen && <Settings />}
    </div>
  )
}
