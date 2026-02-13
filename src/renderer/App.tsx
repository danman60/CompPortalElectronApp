import React, { useEffect } from 'react'
import { useStore, initIPCListeners } from './store/useStore'
import Header from './components/Header'
import LeftPanel from './components/LeftPanel'
import RightPanel from './components/RightPanel'
import DragHandle from './components/DragHandle'
import Settings from './components/Settings'
import './styles/app.css'

export default function App(): React.ReactElement {
  const settingsOpen = useStore((s) => s.settingsOpen)

  useEffect(() => {
    // Initialize IPC listeners
    initIPCListeners()

    // Load initial settings
    window.api.settingsGet().then((settings) => {
      useStore.getState().setSettings(settings)

      // Auto-connect OBS
      if (settings.obs.url) {
        window.api.obsConnect(settings.obs.url, settings.obs.password)
      }
    })

    // Load persisted competition
    window.api.scheduleGet().then((comp) => {
      if (comp) {
        useStore.getState().setCompetition(comp)
      }
    })
  }, [])

  return (
    <div className="app-layout">
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
