import React, { useEffect, useRef, useState } from 'react'

function useAppVersion(): string {
  const [version, setVersion] = useState('')
  useEffect(() => {
    window.api.getVersion().then((v: string) => setVersion(v))
  }, [])
  return version
}
import { useStore } from '../store/useStore'
import LoadCompetition from './LoadCompetition'
import '../styles/header.css'

function SystemMonitor(): React.ReactElement | null {
  const stats = useStore((s) => s.systemStats)
  if (!stats) return null

  const cpuColor = stats.cpuPercent > 95 ? 'var(--danger)' : stats.cpuPercent > 80 ? 'var(--warning)' : 'var(--text-muted)'
  const diskColor = stats.diskFreeGB >= 0
    ? (stats.diskFreeGB < 2 ? 'var(--danger)' : stats.diskFreeGB < 10 ? 'var(--warning)' : 'var(--text-muted)')
    : 'var(--text-muted)'

  return (
    <div className="header-status" style={{ gap: '6px' }}>
      <span className="si" style={{ color: cpuColor }}>
        CPU {stats.cpuPercent}%
      </span>
      {stats.diskFreeGB >= 0 && (
        <span className="si" style={{ color: diskColor }}>
          Disk {stats.diskFreeGB}GB
        </span>
      )}
    </div>
  )
}

export default function Header(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const competition = useStore((s) => s.competition)
  const loadCompOpen = useStore((s) => s.loadCompOpen)
  const setLoadCompOpen = useStore((s) => s.setLoadCompOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const compactMode = useStore((s) => s.compactMode)
  const setCompactMode = useStore((s) => s.setCompactMode)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setLoadCompOpen(false)
      }
    }
    if (loadCompOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [loadCompOpen, setLoadCompOpen])

  // Ctrl+Shift+C to toggle compact mode
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault()
        setCompactMode(!useStore.getState().compactMode)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [setCompactMode])

  async function handleProcessVideo(): Promise<void> {
    await window.api.ffmpegEncodeAll()
  }

  async function handleImportPhotos(): Promise<void> {
    const folder = await window.api.photosBrowse()
    if (folder) {
      await window.api.photosImport(folder)
    }
  }

  async function handleImportVideo(): Promise<void> {
    const filePath = await window.api.settingsBrowseFile([
      { name: 'Video Files', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'mts'] },
    ])
    if (filePath) {
      await window.api.importFolder(filePath)
    }
  }

  const appVersion = useAppVersion()
  const obsColor =
    obsState.connectionStatus === 'connected'
      ? 'var(--success)'
      : obsState.connectionStatus === 'connecting'
        ? 'var(--warning)'
        : 'var(--text-muted)'

  return (
    <div className="app-header">
      <div className="app-logo">
        {compactMode ? 'CS' : 'CompSync Media'}
        {appVersion && <span style={{ fontSize: '9px', color: 'var(--text-muted)', opacity: 0.5, marginLeft: '6px' }}>v{appVersion}</span>}
      </div>

      <div className="header-status">
        <span className="si" style={{ color: obsColor }}>
          OBS {obsState.connectionStatus === 'connected' ? 'ON' : 'OFF'}
        </span>
        {competition && (
          <span className="si">
            {competition.routines.length} routines
          </span>
        )}
      </div>

      <SystemMonitor />

      <div className="header-right" ref={popoverRef}>
        <div style={{ position: 'relative' }}>
          <button className="load-comp-btn" onClick={() => setLoadCompOpen(!loadCompOpen)}>
            {compactMode ? 'Load' : 'Load Competition'}
          </button>
          {loadCompOpen && <LoadCompetition />}
        </div>
        {!compactMode && (
          <>
            <button className="action-btn primary" onClick={handleProcessVideo}>
              Process Video
            </button>
            <button className="action-btn" style={{ background: 'var(--upload-blue)', borderColor: 'var(--upload-blue)', color: 'white' }} onClick={() => window.api.uploadAll()}>
              Upload All
            </button>
            <button className="action-btn" onClick={handleImportVideo}>
              Import Video
            </button>
            <button className="action-btn photos" onClick={handleImportPhotos}>
              Import Photos
            </button>
          </>
        )}
        <button
          className={`compact-toggle-btn${compactMode ? ' active' : ''}`}
          onClick={() => setCompactMode(!compactMode)}
          title={compactMode ? 'Switch to full mode (Ctrl+Shift+C)' : 'Switch to production mode (Ctrl+Shift+C)'}
        >
          {compactMode ? 'Full' : 'Compact'}
        </button>
        <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </div>
    </div>
  )
}
