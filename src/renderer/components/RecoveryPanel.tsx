import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import type { RecoveryState } from '../../shared/types'
import '../styles/recovery.css'

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function ConfidenceBadge({ confidence }: { confidence: number }): React.ReactElement {
  const cls = confidence >= 0.5 ? 'high' : confidence > 0 ? 'low' : 'none'
  const label = confidence > 0 ? `${Math.round(confidence * 100)}%` : 'est.'
  return <span className={`recovery-boundary-conf ${cls}`}>{label}</span>
}

export default function RecoveryPanel(): React.ReactElement {
  const setRecoveryOpen = useStore((s) => s.setRecoveryOpen)
  const recoveryState = useStore((s) => s.recoveryState)
  const competition = useStore((s) => s.competition)
  const settings = useStore((s) => s.settings)

  const [mkvPaths, setMkvPaths] = useState<string[]>([])
  const [outputDir, setOutputDir] = useState(settings?.fileNaming?.outputDirectory || '')
  const [photoFolder, setPhotoFolder] = useState('')

  // Sync output dir with settings changes
  useEffect(() => {
    if (settings?.fileNaming?.outputDirectory && !outputDir) {
      setOutputDir(settings.fileNaming.outputDirectory)
    }
  }, [settings, outputDir])

  async function handleBrowseMkv(): Promise<void> {
    const paths = await window.api.recoveryBrowseMkv()
    if (paths && paths.length > 0) {
      setMkvPaths((prev) => [...prev, ...paths.filter((p: string) => !prev.includes(p))])
    }
  }

  async function handleBrowseOutput(): Promise<void> {
    const dir = await window.api.settingsBrowseDir()
    if (dir) setOutputDir(dir)
  }

  async function handleBrowsePhotos(): Promise<void> {
    const dir = await window.api.settingsBrowseDir()
    if (dir) setPhotoFolder(dir)
  }

  function removeMkv(idx: number): void {
    setMkvPaths((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleStart(): Promise<void> {
    if (mkvPaths.length === 0 || !outputDir || !competition) return
    const result = await window.api.recoveryStart({
      mkvPaths,
      photoFolderPath: photoFolder || undefined,
      outputDir,
    }) as { error?: string; started?: boolean }

    if (result?.error) {
      alert(`Recovery failed to start: ${result.error}`)
    }
  }

  async function handleCancel(): Promise<void> {
    await window.api.recoveryCancel()
  }

  async function handleEncodeAll(): Promise<void> {
    await window.api.ffmpegEncodeAll()
  }

  async function handleUploadAll(): Promise<void> {
    await window.api.uploadAll()
  }

  const isActive = recoveryState.active || recoveryState.phase === 'extracting-audio' ||
    recoveryState.phase === 'transcribing' || recoveryState.phase === 'parsing' ||
    recoveryState.phase === 'splitting' || recoveryState.phase === 'photos'
  const isComplete = recoveryState.phase === 'complete'
  const isError = recoveryState.phase === 'error'
  const canStart = mkvPaths.length > 0 && outputDir && competition && !isActive

  return (
    <div className="recovery-overlay" onClick={(e) => { if (e.target === e.currentTarget && !isActive) setRecoveryOpen(false) }}>
      <div className="recovery-panel">
        {/* Header */}
        <div className="recovery-header">
          <h2>Post-Event Recovery</h2>
          <button
            className="recovery-close"
            onClick={() => { if (!isActive) setRecoveryOpen(false) }}
            disabled={isActive}
          >
            x
          </button>
        </div>

        <div className="recovery-body">
          {/* Description */}
          <p className="recovery-desc">
            Recover from a failed event by processing a full-day OBS recording.
            This will transcribe announcer audio to detect routine boundaries,
            split the video into per-routine clips, and optionally import photos.
          </p>

          {!competition && (
            <p className="recovery-desc" style={{ color: 'var(--warning)' }}>
              Load a competition schedule first before starting recovery.
            </p>
          )}

          {/* MKV File Picker */}
          <div className="recovery-field">
            <label>Full-Day Recording(s)</label>
            <div className="recovery-picker">
              <button onClick={handleBrowseMkv} disabled={isActive}>
                Browse MKV/MP4...
              </button>
            </div>
            {mkvPaths.length > 0 && (
              <div className="recovery-file-list">
                {mkvPaths.map((p, i) => (
                  <div key={i} className="recovery-file-item">
                    <span title={p}>{p.split(/[\\/]/).pop()}</span>
                    {!isActive && (
                      <button onClick={() => removeMkv(i)} title="Remove">x</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Output Directory */}
          <div className="recovery-field">
            <label>Output Directory</label>
            <div className="recovery-picker">
              <input
                type="text"
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                placeholder="Where to save split routines"
                disabled={isActive}
              />
              <button onClick={handleBrowseOutput} disabled={isActive}>
                Browse
              </button>
            </div>
          </div>

          {/* Photo Folder (optional) */}
          <div className="recovery-field">
            <label>Photo Folder (Optional)</label>
            <div className="recovery-picker">
              <input
                type="text"
                value={photoFolder}
                onChange={(e) => setPhotoFolder(e.target.value)}
                placeholder="SD card DCIM folder"
                disabled={isActive}
              />
              <button onClick={handleBrowsePhotos} disabled={isActive}>
                Browse
              </button>
            </div>
          </div>

          {/* Actions */}
          {!isActive && !isComplete && (
            <div className="recovery-actions">
              <button
                className="recovery-start-btn"
                onClick={handleStart}
                disabled={!canStart}
              >
                {!competition
                  ? 'Load Competition First'
                  : mkvPaths.length === 0
                    ? 'Select Recording File(s)'
                    : `Start Recovery (${mkvPaths.length} file${mkvPaths.length > 1 ? 's' : ''})`
                }
              </button>
            </div>
          )}

          {/* Active: Cancel */}
          {isActive && (
            <div className="recovery-actions">
              <button className="recovery-cancel-btn" onClick={handleCancel}>
                Cancel Recovery
              </button>
            </div>
          )}

          {/* Progress */}
          {(isActive || isComplete || isError) && (
            <div className="recovery-progress">
              <div className="recovery-progress-bar">
                <div
                  className={`recovery-progress-fill${isComplete ? ' complete' : ''}${isError ? ' error' : ''}`}
                  style={{ width: `${recoveryState.percent}%` }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className={`recovery-phase${isComplete ? ' complete' : ''}${isError ? ' error' : ''}`}>
                  {recoveryState.phase.replace(/-/g, ' ')}
                </span>
                <span className="recovery-percent">{recoveryState.percent}%</span>
              </div>
              <span className="recovery-detail">{recoveryState.detail}</span>
            </div>
          )}

          {/* Boundary Results */}
          {recoveryState.boundaries && recoveryState.boundaries.length > 0 && (
            <div className="recovery-results">
              <h3>Detected Routines ({recoveryState.boundaries.length})</h3>
              <div className="recovery-boundary-list">
                {recoveryState.boundaries.map((b) => (
                  <div key={b.index} className="recovery-boundary-item">
                    <span className="recovery-boundary-time">
                      {formatTime(b.videoOffsetStartSec)} - {formatTime(b.videoOffsetEndSec)}
                    </span>
                    <span className="recovery-boundary-name" title={b.name}>
                      {b.name}
                    </span>
                    <ConfidenceBadge confidence={b.confidence} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Post-completion actions */}
          {isComplete && (
            <div className="recovery-post-actions">
              <button className="recovery-encode-btn" onClick={handleEncodeAll}>
                Encode All
              </button>
              <button className="recovery-upload-btn" onClick={handleUploadAll}>
                Upload All
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
