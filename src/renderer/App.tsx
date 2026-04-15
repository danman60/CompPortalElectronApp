import React, { useEffect, useRef, useState } from 'react'
import { useStore, initIPCListeners } from './store/useStore'
import { IPC_CHANNELS } from '../shared/types'
import Header from './components/Header'
import LeftPanel from './components/LeftPanel'

import RightPanel from './components/RightPanel'
import DragHandle from './components/DragHandle'
import Settings from './components/Settings'
import PhotoSorter from './components/PhotoSorter'
import RecoveryPanel from './components/RecoveryPanel'
import DriveAlert from './components/DriveAlert'
import ChatPanel from './components/ChatPanel'
import './styles/app.css'

function HardeningBanners(): React.ReactElement | null {
  const [devWarn, setDevWarn] = useState<string | null>(null)
  const [recordBlocked, setRecordBlocked] = useState<string | null>(null)
  const [recordMax, setRecordMax] = useState<string | null>(null)
  const [recordAlert, setRecordAlert] = useState<{ level: string; message: string } | null>(null)
  const [diskAlert, setDiskAlert] = useState<{ level: string; freeGB: number } | null>(null)
  const [driveLost, setDriveLost] = useState<string | null>(null)
  const [stateRecovered, setStateRecovered] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api) return
    const offs: Array<() => void> = []
    offs.push(window.api.on(IPC_CHANNELS.DEV_BUILD_WARNING, (data: unknown) => {
      const d = data as { message: string }
      setDevWarn(d.message)
    }))
    offs.push(window.api.on(IPC_CHANNELS.RECORDING_BLOCKED, (data: unknown) => {
      const d = data as { reason: string; detail?: string }
      setRecordBlocked(`Recording blocked: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`)
    }))
    offs.push(window.api.on(IPC_CHANNELS.RECORDING_MAX_WARNING, (data: unknown) => {
      const d = data as { maxMinutes: number; recordTimeSec: number }
      setRecordMax(`Recording has exceeded ${d.maxMinutes}-minute limit — still running. Stop manually when ready.`)
    }))
    offs.push(window.api.on(IPC_CHANNELS.RECORDING_ALERT, (data: unknown) => {
      const d = data as { level: string; message: string }
      setRecordAlert(d)
    }))
    offs.push(window.api.on(IPC_CHANNELS.DISK_SPACE_ALERT, (data: unknown) => {
      const d = data as { level: string; freeGB: number }
      if (d.level === 'ok') setDiskAlert(null)
      else setDiskAlert(d)
    }))
    offs.push(window.api.on(IPC_CHANNELS.DRIVE_LOST, (data: unknown) => {
      const d = data as { path: string }
      setDriveLost(`Output drive lost: ${d.path}. Uploads and encoding paused.`)
    }))
    offs.push(window.api.on(IPC_CHANNELS.DRIVE_RECOVERED, () => {
      setDriveLost(null)
    }))
    offs.push(window.api.on(IPC_CHANNELS.STATE_RECOVERED_FROM_BACKUP, (data: unknown) => {
      const d = data as { backupFile: string; ageMs: number }
      const mins = Math.round(d.ageMs / 60000)
      setStateRecovered(`State recovered from backup (${mins} min old). Verify routine statuses.`)
    }))
    return () => {
      for (const off of offs) {
        try { off() } catch {}
      }
    }
  }, [])

  const banners: Array<{ key: string; bg: string; text: string; onDismiss?: () => void }> = []
  if (devWarn) banners.push({ key: 'dev', bg: '#c17f00', text: devWarn, onDismiss: () => setDevWarn(null) })
  if (driveLost) banners.push({ key: 'drive', bg: '#8b0000', text: driveLost })
  if (recordBlocked) banners.push({ key: 'rblocked', bg: '#8b0000', text: recordBlocked, onDismiss: () => setRecordBlocked(null) })
  if (recordMax) banners.push({ key: 'rmax', bg: '#8b0000', text: recordMax, onDismiss: () => setRecordMax(null) })
  if (recordAlert) banners.push({
    key: 'ralert',
    bg: recordAlert.level === 'error' ? '#8b0000' : '#c17f00',
    text: recordAlert.message,
    onDismiss: () => setRecordAlert(null),
  })
  if (diskAlert) banners.push({
    key: 'disk',
    bg: diskAlert.level === 'critical' ? '#8b0000' : diskAlert.level === 'high' ? '#c17f00' : '#866d00',
    text: `Disk space ${diskAlert.level}: ${diskAlert.freeGB}GB free`,
  })
  if (stateRecovered) banners.push({ key: 'state', bg: '#c17f00', text: stateRecovered, onDismiss: () => setStateRecovered(null) })

  if (banners.length === 0) return null

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999, display: 'flex', flexDirection: 'column' }}>
      {banners.map((b) => (
        <div
          key={b.key}
          style={{
            background: b.bg,
            color: '#fff',
            padding: '6px 12px',
            fontSize: '12px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid rgba(0,0,0,0.3)',
          }}
        >
          <span>{b.text}</span>
          {b.onDismiss && (
            <button
              onClick={b.onDismiss}
              style={{ background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', padding: '2px 8px', cursor: 'pointer', fontSize: '11px' }}
            >
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function RecordingOverrunWarning(): React.ReactElement | null {
  const obsState = useStore((s) => s.obsState)
  if (!obsState.isRecording || obsState.recordTimeSec < 225) return null

  return (
    <div className="overrun-warning" />
  )
}

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
  const photoSorterOpen = useStore((s) => s.photoSorterOpen)
  const recoveryOpen = useStore((s) => s.recoveryOpen)
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
    const cleanupIPC = initIPCListeners()

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

    return cleanupIPC
  }, [])

  return (
    <div className={`app-layout${compactMode ? ' compact' : ''}`}>
      <Header />
      <div className="main-split">
        <LeftPanel />
        <DragHandle target=".left-panel" min={400} max={1400} />
        <RightPanel />
      </div>
      {settingsOpen && <Settings />}
      {photoSorterOpen && <PhotoSorter />}
      {recoveryOpen && <RecoveryPanel />}
      <DriveAlert />
      <RecordingOverrunWarning />
      <StartupToast />
      <HardeningBanners />
      <ChatPanel />
    </div>
  )
}
