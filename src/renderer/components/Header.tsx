import React, { useEffect, useRef, useState } from 'react'
import { useImportMinimizedState, restoreMinimizedImport } from './DriveAlert'

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
  const encodingCount = useStore((s) => s.encodingCount)
  const loadCompOpen = useStore((s) => s.loadCompOpen)
  const setLoadCompOpen = useStore((s) => s.setLoadCompOpen)
  const tetherState = useStore((s) => s.tetherState)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadsPaused, setUploadsPaused] = useState(false)
  const [encodingPaused, setEncodingPaused] = useState(false)
  const [wifiDisplayRunning, setWifiDisplayRunning] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  const autoEncode = settings?.behavior?.autoEncodeRecordings ?? false
  const autoUpload = settings?.behavior?.autoUploadAfterEncoding ?? false

  useEffect(() => {
    window.api?.wifiDisplayStatus().then((s: { running?: boolean }) => {
      if (s) setWifiDisplayRunning(!!s.running)
    }).catch(() => {})
  }, [])

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

  async function toggleAutoEncode(e: React.MouseEvent): Promise<void> {
    e.preventDefault()
    if (!settings) return
    const updated = { ...settings, behavior: { ...settings.behavior, autoEncodeRecordings: !autoEncode } }
    await window.api.settingsSet(updated)
    useStore.getState().setSettings(updated)
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

  async function toggleAutoUpload(e: React.MouseEvent): Promise<void> {
    e.preventDefault()
    if (!settings) return
    const updated = { ...settings, behavior: { ...settings.behavior, autoUploadAfterEncoding: !autoUpload } }
    await window.api.settingsSet(updated)
    useStore.getState().setSettings(updated)
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

  async function handleTabletToggle(): Promise<void> {
    const wd = settings?.wifiDisplay
    if (wd?.monitorIndex === null || wd?.monitorIndex === undefined) {
      useStore.getState().setSettingsOpen(true)
      return
    }
    try {
      if (wifiDisplayRunning) {
        const result = await window.api.wifiDisplayStop() as { running?: boolean }
        setWifiDisplayRunning(!!result?.running)
      } else {
        const result = await window.api.wifiDisplayStart() as { running?: boolean }
        setWifiDisplayRunning(!!result?.running)
      }
    } catch {
      // ignore errors
    }
  }

  const autoWatchActive = tetherState?.active && tetherState?.source === 'folder-watch'
  const autoWatchFolder = settings?.tether?.autoWatchFolder || ''

  async function toggleAutoWatchPhotos(e: React.MouseEvent): Promise<void> {
    e.preventDefault()
    if (!settings) return

    if (autoWatchActive) {
      // Stop watching
      await window.api.tetherStop()
      return
    }

    // If we have a saved folder, start watching it
    let folder = autoWatchFolder
    if (!folder) {
      // No folder saved — prompt to pick one
      folder = await window.api.photosBrowse()
      if (!folder) return
      // Save it to settings
      const updated = { ...settings, tether: { ...settings.tether, autoWatchFolder: folder } }
      await window.api.settingsSet(updated)
      useStore.getState().setSettings(updated)
    }
    await window.api.tetherStart(folder)
  }

  async function toggleUploadPause(): Promise<void> {
    if (uploadsPaused) {
      await window.api.uploadStart()
      setUploadsPaused(false)
    } else {
      await window.api.uploadStop()
      setUploadsPaused(true)
    }
  }

  async function toggleEncodePause(): Promise<void> {
    if (encodingPaused) {
      await window.api.ffmpegResume()
      setEncodingPaused(false)
    } else {
      await window.api.ffmpegPause()
      setEncodingPaused(true)
    }
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
        onContextMenu={toggleAutoEncode}
        title={autoEncode ? 'Auto-encode ON (right-click to toggle)' : 'Process all (right-click to toggle auto)'}
      >
        <span className="ab-icon">{'\u2699'}</span>
        <span className="ab-label">Process</span>
        {autoEncode && <span className="ab-auto-badge">AUTO</span>}
      </button>

      {/* Upload All */}
      <button
        className={`ab-btn upload${uploadDisabled ? ' disabled' : ''}`}
        onClick={handleUploadAll}
        onContextMenu={toggleAutoUpload}
        disabled={uploadDisabled}
        title={
          uploadingCount > 0
            ? `Uploading ${uploadingCount} files...`
            : autoUpload
              ? 'Auto-upload ON (right-click to toggle)'
              : 'Upload all (right-click to toggle auto)'
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
        className={`ab-btn import-photo${autoWatchActive ? ' watching' : ''}`}
        onClick={handleImportPhotos}
        onContextMenu={toggleAutoWatchPhotos}
        title={autoWatchActive
          ? `Auto-watch ON: ${tetherState?.watchPath || autoWatchFolder} (right-click to stop)`
          : autoWatchFolder
            ? `Import photos (right-click to auto-watch ${autoWatchFolder})`
            : 'Import photos (right-click to enable auto-watch)'}
      >
        <span className="ab-icon">{'\u{1F4F7}'}</span>
        <span className="ab-label">Photos</span>
        {autoWatchActive && <span className="ab-auto-badge">LIVE</span>}
      </button>

      <div className="ab-divider" />

      {/* Post-Event Recovery */}
      <button
        className="ab-btn recovery"
        onClick={() => useStore.getState().setRecoveryOpen(true)}
        title="Post-event recovery: split full-day MKV into per-routine clips"
      >
        <span className="ab-icon">{'\u{1F6E0}'}</span>
        <span className="ab-label">Recovery</span>
      </button>

      {/* Tablet Display */}
      <button
        className={`ab-btn tablet${wifiDisplayRunning ? ' streaming' : ''}`}
        onClick={handleTabletToggle}
        title={wifiDisplayRunning ? 'Stop tablet display streaming' : 'Start tablet display streaming'}
      >
        <span
          className="ab-status-dot"
          style={{
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: wifiDisplayRunning ? 'var(--success)' : 'var(--text-muted)',
            marginRight: '4px',
          }}
        />
        <span className="ab-label">Tablet</span>
      </button>

      <div className="ab-pause-bar">
        <button
          className={`ab-pause-btn${encodingPaused ? ' paused' : ''}`}
          onClick={toggleEncodePause}
          disabled={encodingCount === 0 && !encodingPaused}
          title={encodingPaused ? 'Resume encoding' : 'Pause encoding (finishes current)'}
        >
          {encodingPaused ? '\u25B6' : '\u23F8'} Encode
          {encodingCount > 0 && <span className="ab-count">{encodingCount}</span>}
        </button>
        <button
          className={`ab-pause-btn${uploadsPaused ? ' paused' : ''}`}
          onClick={toggleUploadPause}
          disabled={uploadingCount === 0 && !uploadsPaused}
          title={uploadsPaused ? 'Resume uploads' : 'Pause uploads (aborts current)'}
        >
          {uploadsPaused ? '\u25B6' : '\u23F8'} Upload
          {uploadingCount > 0 && <span className="ab-count">{uploadingCount}</span>}
        </button>
      </div>
      {/* Helper text moved to button titles — right-click = toggle auto */}
    </div>
  )
}
import { useStore } from '../store/useStore'
import LoadCompetition from './LoadCompetition'
import '../styles/header.css'

function SystemMonitor(): React.ReactElement | null {
  const stats = useStore((s) => s.systemStats)
  const obsStats = useStore((s) => s.obsStats)
  if (!stats && !obsStats) return null

  // CPU: higher is worse (usage), so fill shows utilization
  const cpuPercent = Math.min(100, Math.max(0, stats?.cpuPercent ?? 0))
  const cpuColor = cpuPercent > 85 ? 'var(--danger)' : cpuPercent > 60 ? 'var(--warning)' : 'var(--success)'

  const memPercent = Math.min(100, Math.max(0, stats?.memPercent ?? 0))
  const memColor = memPercent > 85 ? 'var(--danger)' : memPercent > 60 ? 'var(--warning)' : 'var(--success)'

  // Disk: show used percentage (inverse of free)
  const diskUsedPercent = stats && stats.diskTotalGB > 0
    ? Math.min(100, Math.max(0, ((stats.diskTotalGB - stats.diskFreeGB) / stats.diskTotalGB) * 100))
    : 0
  const diskColor = stats && stats.diskFreeGB < 2 ? 'var(--danger)' : stats && stats.diskFreeGB < 10 ? 'var(--warning)' : 'var(--success)'

  // OBS pills
  let obsFpsLabel: string | null = null
  let obsFpsColor = 'var(--text-muted)'
  let dropCount: number | null = null
  let dropColor = 'var(--text-muted)'
  let congLabel: string | null = null
  let congColor = 'var(--warning)'
  if (obsStats) {
    if (!obsStats.connected) {
      obsFpsLabel = 'OFF'
      obsFpsColor = 'var(--text-muted)'
    } else {
      const fps = obsStats.fps || 0
      const tgt = obsStats.targetFps || 60
      obsFpsLabel = `${fps.toFixed(0)}/${tgt}`
      if (fps >= tgt * 0.95) obsFpsColor = 'var(--success)'
      else if (fps >= tgt * 0.85) obsFpsColor = 'var(--warning)'
      else obsFpsColor = 'var(--danger)'
      const drops = (obsStats.outputSkippedDelta || 0) + (obsStats.renderSkippedDelta || 0)
      dropCount = drops
      dropColor = drops > 0 ? 'var(--danger)' : 'var(--text-muted)'
      if (obsStats.streaming && obsStats.congestion > 0) {
        const pct = Math.round(obsStats.congestion * 100)
        congLabel = `${pct}%`
        if (obsStats.congestion > 0.5) congColor = 'var(--danger)'
        else if (obsStats.congestion > 0.3) congColor = 'var(--warning)'
        else congLabel = null
      }
    }
  }

  return (
    <div className="header-status" style={{ gap: '10px' }}>
      {stats && (
        <div className="meter-bar" title={`CPU: ${cpuPercent.toFixed(0)}%`}>
          <span className="meter-label">CPU</span>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${cpuPercent}%`, background: cpuColor }} />
          </div>
          <span className="meter-value">{cpuPercent.toFixed(0)}%</span>
        </div>
      )}
      {stats && stats.memPercent !== undefined && (
        <div className="meter-bar" title={`RAM: ${memPercent}%`}>
          <span className="meter-label">RAM</span>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${memPercent}%`, background: memColor }} />
          </div>
          <span className="meter-value">{memPercent}%</span>
        </div>
      )}
      {stats && stats.diskFreeGB >= 0 && (
        <div className={`meter-bar ${stats.diskFreeGB < 2 ? 'disk-critical' : stats.diskFreeGB < 10 ? 'disk-warning' : ''}`} title={`Disk: ${stats.diskFreeGB.toFixed(1)}GB free`}>
          <span className="meter-label">Disk</span>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${diskUsedPercent}%`, background: diskColor }} />
          </div>
          <span className="meter-value">{stats.diskFreeGB.toFixed(0)}GB</span>
        </div>
      )}
      {obsStats && obsFpsLabel !== null && (
        <span className="si" style={{ color: obsFpsColor }} title={`OBS FPS (commit 3)`}>
          OBS {obsFpsLabel}
        </span>
      )}
      {obsStats && obsStats.connected && dropCount !== null && (
        <span className="si" style={{ color: dropColor }} title={`Dropped frames this tick`}>
          Drop {dropCount}
        </span>
      )}
      {obsStats && obsStats.connected && obsStats.streaming && congLabel && (
        <span className="si" style={{ color: congColor }} title={`Stream output congestion`}>
          Cong {congLabel}
        </span>
      )}
    </div>
  )
}

function ImportPill(): React.ReactElement | null {
  const s = useImportMinimizedState()
  if (!s.active) return null
  const label = s.total > 0 ? `${s.current}/${s.total}` : (s.message || '...')
  return (
    <button
      className="import-pill"
      onClick={() => restoreMinimizedImport()}
      title="Click to re-open import panel"
    >
      <span className="import-pill-dot" />
      <span>Importing {label}</span>
    </button>
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
        <ImportPill />
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
