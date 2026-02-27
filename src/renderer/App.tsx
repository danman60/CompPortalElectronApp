import React, { useEffect, useRef, useState } from 'react'
import { useStore, initIPCListeners } from './store/useStore'
import Header from './components/Header'
import LeftPanel from './components/LeftPanel'
import RightPanel from './components/RightPanel'
import DragHandle from './components/DragHandle'
import Settings from './components/Settings'
import './styles/app.css'

function StartupToast(): React.ReactElement | null {
  const report = useStore((s) => s.startupReport)
  const visible = useStore((s) => s.startupToastVisible)
  const dismiss = useStore((s) => s.dismissStartupToast)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    if (!visible || !report) return
    const timer = setTimeout(() => {
      setFading(true)
      setTimeout(() => dismiss(), 300)
    }, 8000)
    return () => clearTimeout(timer)
  }, [visible, report, dismiss])

  if (!visible || !report) return null

  const hasWarning = !report.ffmpegAvailable || report.diskWarning || report.orphanedFiles > 0
  const borderColor = hasWarning ? 'var(--warning)' : 'var(--success)'

  return (
    <div
      className="startup-toast"
      style={{
        borderLeftColor: borderColor,
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.3s',
      }}
      onClick={() => dismiss()}
    >
      <div className="toast-title">Startup Check</div>
      <div className="toast-items">
        <span style={{ color: report.ffmpegAvailable ? 'var(--success)' : 'var(--danger)' }}>
          FFmpeg {report.ffmpegAvailable ? 'OK' : 'NOT FOUND'}
        </span>
        <span style={{ color: report.diskWarning ? 'var(--warning)' : 'var(--text-muted)' }}>
          Disk {report.diskFreeGB}GB free
        </span>
        {report.resumedJobs > 0 && (
          <span style={{ color: 'var(--accent)' }}>
            {report.resumedJobs} job{report.resumedJobs > 1 ? 's' : ''} resumed
          </span>
        )}
        {report.orphanedFiles > 0 && (
          <span style={{ color: 'var(--warning)' }}>
            {report.orphanedFiles} orphaned file{report.orphanedFiles > 1 ? 's' : ''} cleaned
          </span>
        )}
      </div>
    </div>
  )
}

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
      <StartupToast />
    </div>
  )
}
