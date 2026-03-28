import React, { useEffect, useRef, useState } from 'react'

function useAppVersion(): string {
  const [version, setVersion] = useState('')
  useEffect(() => {
    window.api.getVersion().then((v: string) => setVersion(v))
  }, [])
  return version
}

// ── Unified Action Bar ─────────────────────────────────────────────
// Consolidates: Load Competition, Process Video, Upload All, Import Video, Import Photos
// Each button shows an "AUTO" badge when auto mode is enabled for that function

function ActionBar(): React.ReactElement {
  const settings = useStore((s) => s.settings)
  const competition = useStore((s) => s.competition)
  const uploadingCount = useStore((s) => s.uploadingCount)
  const loadCompOpen = useStore((s) => s.loadCompOpen)
  const setLoadCompOpen = useStore((s) => s.setLoadCompOpen)
  const [isUploading, setIsUploading] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  const autoEncode = settings?.behavior?.autoEncodeRecordings ?? false
  const autoUpload = settings?.behavior?.autoUploadAfterEncoding ?? false

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

  async function handleProcessVideo(): Promise<void> {
    await window.api.ffmpegEncodeAll()
  }

  async function handleUploadAll(): Promise<void> {
    if (isUploading || uploadingCount > 0) return
    setIsUploading(true)
    try {
      await window.api.uploadAll()
    } finally {
      setIsUploading(false)
    }
  }

  async function handleImportVideo(): Promise<void> {
    const folderPath = await window.api.settingsBrowseDir()
    if (folderPath) {
      await window.api.importFolder(folderPath)
    }
  }

  async function handleImportPhotos(): Promise<void> {
    const folder = await window.api.photosBrowse()
    if (!folder) return
    const result = await window.api.photosImport(folder) as { matched?: number; unmatched?: number; total?: number; clockOffsetMs?: number; error?: string } | undefined
    if (!result) return
    if (result.error) {
      alert(`Photo import error: ${result.error}`)
      return
    }
    const total = (result.matched ?? 0) + (result.unmatched ?? 0)
    if (total === 0) {
      alert(`No JPEG photos found in the selected folder or its subfolders.`)
      return
    }
    const offset = result.clockOffsetMs ? ` (clock offset: ${Math.round(result.clockOffsetMs / 1000)}s)` : ''
    alert(`Photo import complete:\n\n${result.matched ?? 0} matched to routines\n${result.unmatched ?? 0} unmatched${offset}`)
  }

  const uploadDisabled = isUploading || uploadingCount > 0

  return (
    <div className="action-bar">
      {/* Load Competition */}
      <div className="action-bar-item" ref={popoverRef} style={{ position: 'relative' }}>
        <button
          className={`ab-btn load${competition ? ' has-data' : ''}`}
          onClick={() => setLoadCompOpen(!loadCompOpen)}
          title={competition ? `${competition.name} — ${competition.routines.length} routines` : 'Load competition schedule'}
        >
          <span className="ab-icon">{competition ? '\u2713' : '\u25B6'}</span>
          <span className="ab-label">Load</span>
        </button>
        {loadCompOpen && <LoadCompetition />}
      </div>

      <div className="ab-divider" />

      {/* Process Video (FFmpeg encode) */}
      <button
        className="ab-btn encode"
        onClick={handleProcessVideo}
        title={autoEncode ? 'Auto-encode is ON — recordings encode automatically' : 'Manually encode all recorded videos'}
      >
        <span className="ab-icon">{'\u2699'}</span>
        <span className="ab-label">Process</span>
        {autoEncode && <span className="ab-auto-badge">AUTO</span>}
      </button>

      {/* Upload All */}
      <button
        className={`ab-btn upload${uploadDisabled ? ' disabled' : ''}`}
        onClick={handleUploadAll}
        disabled={uploadDisabled}
        title={
          uploadingCount > 0
            ? `Uploading ${uploadingCount} files...`
            : autoUpload
              ? 'Auto-upload is ON — files upload after encoding'
              : 'Upload all encoded videos and photos'
        }
      >
        <span className="ab-icon">{uploadingCount > 0 ? '\u21BB' : '\u2191'}</span>
        <span className="ab-label">{uploadingCount > 0 ? `Up ${uploadingCount}` : 'Upload'}</span>
        {autoUpload && <span className="ab-auto-badge">AUTO</span>}
      </button>

      <div className="ab-divider" />

      {/* Import Video */}
      <button
        className="ab-btn import-vid"
        onClick={handleImportVideo}
        title="Import video files from a folder"
      >
        <span className="ab-icon">{'\u{1F3AC}'}</span>
        <span className="ab-label">Video</span>
      </button>

      {/* Import Photos */}
      <button
        className="ab-btn import-photo"
        onClick={handleImportPhotos}
        title="Import photos from camera/SD card"
      >
        <span className="ab-icon">{'\u{1F4F7}'}</span>
        <span className="ab-label">Photos</span>
      </button>
    </div>
  )
}
import { useStore } from '../store/useStore'
import LoadCompetition from './LoadCompetition'
import '../styles/header.css'

function SystemMonitor(): React.ReactElement | null {
  const stats = useStore((s) => s.systemStats)
  if (!stats) return null

  // CPU: higher is worse (usage), so fill shows utilization
  const cpuPercent = Math.min(100, Math.max(0, stats.cpuPercent))
  const cpuColor = cpuPercent > 95 ? 'var(--danger)' : cpuPercent > 80 ? 'var(--warning)' : 'var(--success)'

  // Disk: show used percentage (inverse of free)
  // Assuming typical competition drive is 500GB-2TB, show relative fill
  const diskUsedPercent = stats.diskTotalGB > 0
    ? Math.min(100, Math.max(0, ((stats.diskTotalGB - stats.diskFreeGB) / stats.diskTotalGB) * 100))
    : 0
  const diskColor = stats.diskFreeGB < 2 ? 'var(--danger)' : stats.diskFreeGB < 10 ? 'var(--warning)' : 'var(--success)'

  return (
    <div className="header-status" style={{ gap: '10px' }}>
      <div className="meter-bar" title={`CPU: ${cpuPercent.toFixed(0)}%`}>
        <span className="meter-label">CPU</span>
        <div className="meter-track">
          <div
            className="meter-fill"
            style={{
              width: `${cpuPercent}%`,
              background: cpuColor,
            }}
          />
        </div>
        <span className="meter-value">{cpuPercent.toFixed(0)}%</span>
      </div>
      {stats.diskFreeGB >= 0 && (
        <div className="meter-bar" title={`Disk: ${stats.diskFreeGB.toFixed(1)}GB free`}>
          <span className="meter-label">Disk</span>
          <div className="meter-track">
            <div
              className="meter-fill"
              style={{
                width: `${diskUsedPercent}%`,
                background: diskColor,
              }}
            />
          </div>
          <span className="meter-value">{stats.diskFreeGB.toFixed(0)}GB</span>
        </div>
      )}
    </div>
  )
}

export default function Header(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const competition = useStore((s) => s.competition)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const compactMode = useStore((s) => s.compactMode)
  const setCompactMode = useStore((s) => s.setCompactMode)

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

      {!compactMode && <ActionBar />}

      <div className="header-right">
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
