import React, { useEffect, useRef, useState } from 'react'
import { useImportMinimizedState, restoreMinimizedImport, setImportPillActiveFromHeader } from './DriveAlert'
import { useStore } from '../store/useStore'
import CurrentRoutine from './CurrentRoutine'
import Controls from './Controls'
import LoadCompetition from './LoadCompetition'
import { HealthStrip } from './RightPanel'
import VerticalMeters from './VerticalMeters'
import PipelineHealthChip from './PipelineHealthChip'
import '../styles/header.css'

function useAppVersion(): string {
  const [version, setVersion] = useState('')
  useEffect(() => {
    window.api.getVersion().then((v: string) => setVersion(v))
  }, [])
  return version
}

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
    setImportPillActiveFromHeader(folder)
    try {
      const result = await window.api.photosImport(folder) as {
        matched?: number
        unmatched?: number
        total?: number
        clockOffsetMs?: number
        error?: string
        cancelled?: boolean
      } | undefined
      if (!result) return
      if (result.cancelled) {
        alert('Photo import cancelled.')
        return
      }
      if (result.error) {
        alert(`Photo import error: ${result.error}`)
        return
      }
      const total = (result.matched ?? 0) + (result.unmatched ?? 0)
      if (total === 0) {
        alert('No JPEG photos found in the selected folder or its subfolders.')
        return
      }
      const offset = result.clockOffsetMs ? ` (clock offset: ${Math.round(result.clockOffsetMs / 1000)}s)` : ''
      alert(`Photo import complete:\n\n${result.matched ?? 0} matched to routines\n${result.unmatched ?? 0} unmatched${offset}`)
    } finally {
      setImportPillActiveFromHeader(null)
    }
  }

  // Operator-spec 2026-04-25: tablet button is always-on by default; click
  // restarts the wifi-display server (stop → start) instead of toggling.
  // Use case: capture pipeline gets a "connection reset" loop and operator
  // wants a single-press recovery without going to settings.
  async function handleTabletRestart(): Promise<void> {
    const wd = settings?.wifiDisplay
    if (wd?.monitorIndex === null || wd?.monitorIndex === undefined) {
      useStore.getState().setSettingsOpen(true)
      return
    }
    try {
      // Stop, ignore errors (server may already be stopped).
      try { await window.api.wifiDisplayStop() } catch {}
      const result = await window.api.wifiDisplayStart() as { running?: boolean }
      setWifiDisplayRunning(!!result?.running)
    } catch {
      // ignore
    }
  }

  const autoWatchActive = tetherState?.active && tetherState?.source === 'folder-watch'
  const autoWatchFolder = settings?.tether?.autoWatchFolder || ''

  async function toggleAutoWatchPhotos(e: React.MouseEvent): Promise<void> {
    e.preventDefault()
    if (!settings) return

    if (autoWatchActive) {
      await window.api.tetherStop()
      return
    }

    let folder = autoWatchFolder
    if (!folder) {
      folder = await window.api.photosBrowse()
      if (!folder) return
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

      <button
        className="ab-btn import-vid"
        onClick={handleImportVideo}
        title="Import video files from a folder"
      >
        <span className="ab-icon">{'\u{1F3AC}'}</span>
        <span className="ab-label">Video</span>
      </button>

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

      <button
        className="ab-btn recovery"
        onClick={() => useStore.getState().setRecoveryOpen(true)}
        title="Post-event recovery: split full-day MKV into per-routine clips"
      >
        <span className="ab-icon">{'\u{1F6E0}'}</span>
        <span className="ab-label">Recovery</span>
      </button>

      <button
        className="ab-btn tablet streaming"
        onClick={handleTabletRestart}
        title="Click to restart tablet display server (always-on by default)"
      >
        <span
          className="ab-status-dot"
          style={{
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            // Always show running unless explicitly known to be stopped (e.g.,
            // mid-restart). Status reflects intent: "tablet is supposed to be
            // up". The boot-time auto-start handles the actual server lifecycle.
            background: wifiDisplayRunning ? 'var(--success)' : 'var(--warning)',
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
    </div>
  )
}

function SystemMonitor(): React.ReactElement | null {
  const stats = useStore((s) => s.systemStats)
  const obsStats = useStore((s) => s.obsStats)
  if (!stats && !obsStats) return null

  const cpuPercent = Math.min(100, Math.max(0, stats?.cpuPercent ?? 0))
  const cpuColor = cpuPercent > 85 ? 'var(--danger)' : cpuPercent > 60 ? 'var(--warning)' : 'var(--success)'
  const memPercent = Math.min(100, Math.max(0, stats?.memPercent ?? 0))
  const memColor = memPercent > 85 ? 'var(--danger)' : memPercent > 60 ? 'var(--warning)' : 'var(--success)'
  const diskUsedPercent = stats && stats.diskTotalGB > 0
    ? Math.min(100, Math.max(0, ((stats.diskTotalGB - stats.diskFreeGB) / stats.diskTotalGB) * 100))
    : 0
  const diskColor = stats && stats.diskFreeGB < 2 ? 'var(--danger)' : stats && stats.diskFreeGB < 10 ? 'var(--warning)' : 'var(--success)'

  let obsFpsLabel: string | null = null
  let obsFpsColor = 'var(--text-muted)'
  let dropCount: number | null = null
  let dropColor = 'var(--text-muted)'
  let congLabel: string | null = null
  let congColor = 'var(--warning)'
  if (obsStats) {
    if (!obsStats.connected) {
      obsFpsLabel = 'OFF'
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
    <div className="header-status topband-system">
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
          <span className="si" style={{ color: obsFpsColor }}>OBS {obsFpsLabel}</span>
        )}
        {obsStats && obsStats.connected && dropCount !== null && (
          <span className="si" style={{ color: dropColor }}>Drop {dropCount}</span>
        )}
        {obsStats && obsStats.connected && obsStats.streaming && congLabel && (
          <span className="si" style={{ color: congColor }}>Cong {congLabel}</span>
        )}
    </div>
  )
}

// Separate pill for upload backlog — distinct concern from import (SD-side
// scan/match/copy). Operator-spec 2026-04-25: import-done means "SD safe to
// remove"; uploads run independently against local files. This pill shows
// uploads still in flight regardless of whether an import is active. Stays
// visible until both routines-uploading and photos-pending hit zero.
function UploadBacklogPill(): React.ReactElement | null {
  const uploadingCount = useStore((st) => st.uploadingCount)
  const photosPendingCount = useStore((st) => st.photosPendingCount)
  const encodingCount = useStore((st) => st.encodingCount)
  if (uploadingCount === 0 && photosPendingCount === 0 && encodingCount === 0) return null
  const parts: string[] = []
  if (encodingCount > 0) parts.push(`${encodingCount} enc`)
  if (uploadingCount > 0) parts.push(`${uploadingCount} up`)
  if (photosPendingCount > 0) parts.push(`${photosPendingCount} photo${photosPendingCount === 1 ? '' : 's'}`)
  return (
    <span
      className="si"
      title="Encoding / uploading backlog (separate from SD import). Pill clears when all routines + photos finish uploading."
      style={{
        background: 'rgba(13, 70, 130, 0.5)',
        border: '1px solid rgba(75, 130, 200, 0.7)',
        borderRadius: 4,
        padding: '2px 8px',
        color: '#cfe5ff',
        fontWeight: 600,
        fontSize: 11,
        whiteSpace: 'nowrap',
      }}
    >
      {'↑'} {parts.join(' · ')}
    </span>
  )
}

function ImportPill(): React.ReactElement | null {
  const s = useImportMinimizedState()
  if (!s.active) return null
  const isComplete = s.stage === 'done' || s.canRemoveCard === true
  const label = s.total > 0 ? `${s.current}/${s.total}` : (s.message || '...')
  const pct = s.total > 0 ? Math.min(100, Math.round((s.current / s.total) * 100)) : 0
  // Stage-aware verb so the pill reflects what the pipeline is actually doing.
  // "Importing" was misleading during the EXIF/match phase where no DB writes
  // happen yet (operator-reported 2026-04-25).
  const stageVerb =
    s.stage === 'scanning' || s.stage === 'reading-exif' ? 'Scanning'
      : s.stage === 'matching' ? 'Matching'
      : s.stage === 'copying' ? 'Copying'
      : s.stage === 'queueing' ? 'Queueing'
      : s.stage === 'uploading' ? 'Uploading'
      : 'Importing'

  // NORTH STAR §3.2: watermark-resume label. When this card has been seen
  // before and we're in the early scan/EXIF stage, surface the resume point
  // so the operator sees "Resuming from 14:32 (NAP_5074) — N to scan" instead
  // of the generic "Scanning N/N". Falls back to the generic verb path for
  // copying/queueing/uploading stages where the resume info is no longer the
  // load-bearing detail.
  let resumeLabel: string | null = null
  if (
    s.watermarkResume &&
    s.watermarkLastCaptureTime &&
    (s.stage === 'scanning' || s.stage === 'reading-exif')
  ) {
    try {
      const dt = new Date(s.watermarkLastCaptureTime)
      const hh = String(dt.getHours()).padStart(2, '0')
      const mm = String(dt.getMinutes()).padStart(2, '0')
      const fname = s.watermarkLastFilename ? ` (${s.watermarkLastFilename})` : ''
      const count = s.total > 0 ? ` — ${s.total} to scan` : ''
      resumeLabel = `Resuming from ${hh}:${mm}${fname}${count}`
    } catch {
      resumeLabel = null
    }
  }

  async function handleCancel(e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    if (!confirm(`Cancel photo import?\n\n${label}`)) return
    // Clear the pill immediately. If the import is blocked on a native dialog
    // the cancel signal won't unblock it, but the visual state shouldn't be
    // hostage to that. Once the import does honour the abort, it'll fall
    // through to the import-complete IPC and stay clean.
    try { setImportPillActiveFromHeader(null) } catch {}
    try {
      await window.api.photosCancel()
    } catch (err) {
      console.error('photos:cancel failed', err)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <button
        className={`import-pill${isComplete ? ' complete' : ''}`}
        onClick={() => restoreMinimizedImport()}
        title="Click to re-open import panel"
        style={{ position: 'relative' }}
      >
        {isComplete ? (
          <>
            <span className="import-pill-remove-icon" aria-hidden>{'\u23CF'}</span>
            <span>
              {s.noNewFiles
                ? `No new photos in folder${s.skippedDedup ? ` — ${s.skippedDedup} already imported` : ''}`
                : 'Safe to remove'}
            </span>
          </>
        ) : (
          <>
            <span className="import-pill-dot" />
            <span>{resumeLabel ?? `${stageVerb} ${label}${s.total > 0 ? ` (${pct}%)` : ''}`}</span>
          </>
        )}
        {!isComplete && s.total > 0 && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              bottom: 0,
              height: '2px',
              width: `${pct}%`,
              background: 'var(--success, #2da855)',
              transition: 'width 0.2s linear',
            }}
          />
        )}
        {/* Manual dismiss for "Import Complete — Remove SD Card" pill.
            Operator-spec 2026-04-25: pill was sticky and stacked under the
            gap-routines modal. X here clears it without waiting for SD removal. */}
        {isComplete && (
          <span
            role="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation()
              try { setImportPillActiveFromHeader(null) } catch {}
            }}
            title="Dismiss this banner"
            style={{
              marginLeft: 8,
              padding: '0 6px',
              borderRadius: 3,
              background: 'rgba(0,0,0,0.25)',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              lineHeight: '16px',
              display: 'inline-block',
            }}
          >×</span>
        )}
      </button>
      {!isComplete && (
        <button
          onClick={handleCancel}
          title="Cancel running import"
          style={{
            background: 'transparent',
            border: '1px solid var(--text-muted, #888)',
            color: 'var(--text-muted, #888)',
            borderRadius: '4px',
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: '11px',
            lineHeight: 1.4,
          }}
        >
          Cancel
        </button>
      )}
    </span>
  )
}

export default function Header(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const competition = useStore((s) => s.competition)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  async function handleOverlayMode(): Promise<void> {
    try { await window.api.overlayModeOpen() } catch { /* handled server-side */ }
  }

  const appVersion = useAppVersion()
  const obsColor =
    obsState.connectionStatus === 'connected'
      ? 'var(--success)'
      : obsState.connectionStatus === 'connecting'
        ? 'var(--warning)'
        : 'var(--text-muted)'

  return (
    <header className="topband">
      <div className="topband-row topband-meta">
        <div className="topband-brand">
          <div className="app-logo">
            CompSync Media
            {appVersion && <span className="topband-version">v{appVersion}</span>}
          </div>
          <div className="header-status">
            <span className="si" style={{ color: obsColor }}>
              OBS {obsState.connectionStatus === 'connected' ? 'ON' : 'OFF'}
            </span>
            {competition && <span className="si">{competition.routines.length} routines</span>}
            <ImportPill />
            <UploadBacklogPill />
            <PipelineHealthChip />
          </div>
        </div>

        <SystemMonitor />

        <div className="header-right topband-actions">
          <ActionBar />
          {/* Kick Queue moved into PIPE chip popover (2026-04-29) — operator
              wanted unified entry-point for stalled-pipe nudge. Now also
              kicks photo-import in addition to encode + upload. */}
          <button
            className="compact-toggle-btn"
            onClick={handleOverlayMode}
            title="Hide main window and show floating always-on-top panels over OBS"
          >
            Overlay
          </button>
          <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </div>

      <div className="topband-row topband-live">
        <div className="topband-stats">
          <div className="section topband-stats-card">
            <div className="section-title">Stats</div>
            <HealthStrip />
          </div>
        </div>
        <div className="topband-current">
          <CurrentRoutine />
        </div>
        <div className="topband-meters">
          <div className="section topband-meters-card">
            <div className="section-title">Audio</div>
            <VerticalMeters />
          </div>
        </div>
        <div className="topband-controls">
          <Controls />
        </div>
      </div>
    </header>
  )
}
