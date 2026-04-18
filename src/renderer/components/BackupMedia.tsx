import React, { useEffect, useState } from 'react'
import { IPC_CHANNELS, BackupProgress, BackupResult } from '../../shared/types'

declare global {
  interface Window {
    api: {
      backupBrowseTarget: () => Promise<string | null>
      backupStart: (targetRoot: string) => Promise<BackupResult | { error: string }>
      backupCancel: () => Promise<unknown>
      on: (channel: string, handler: (data: unknown) => void) => () => void
      [k: string]: unknown
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function formatEta(sec: number): string {
  if (!sec || sec < 1) return '—'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export default function BackupMedia(): React.ReactElement {
  const [target, setTarget] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [result, setResult] = useState<BackupResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api?.on) return
    const offP = window.api.on(IPC_CHANNELS.BACKUP_PROGRESS, (p: unknown) => {
      setProgress(p as BackupProgress)
    })
    const offD = window.api.on(IPC_CHANNELS.BACKUP_DONE, (r: unknown) => {
      setResult(r as BackupResult)
      setRunning(false)
      setProgress(null)
    })
    return () => { offP(); offD() }
  }, [])

  async function pickTarget(): Promise<void> {
    const dir = await window.api.backupBrowseTarget()
    if (dir) setTarget(dir)
  }

  async function start(): Promise<void> {
    if (!target) return
    setError(null)
    setResult(null)
    setProgress(null)
    setRunning(true)
    const res = await window.api.backupStart(target)
    if (res && 'error' in res) {
      setError((res as { error: string }).error)
      setRunning(false)
    }
    // BACKUP_DONE event arrives separately; no-op here
  }

  async function cancel(): Promise<void> {
    await window.api.backupCancel()
  }

  const pct = progress && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.bytesDone / progress.totalBytes) * 100))
    : 0

  return (
    <div className="settings-section">
      <div className="settings-section-title">Backup Media</div>
      <p className="section-desc">
        Copy everything under the recording output folder and tether photo folder to an external drive.
        Skip identical files (size + mtime match) so you can resume after a cancel. Blocked during active recording.
      </p>

      <div className="field">
        <label>Destination</label>
        <div className="field-row">
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Pick an external drive or folder..."
            style={{ flex: 1 }}
            disabled={running}
          />
          <button className="back-btn" onClick={pickTarget} disabled={running}>
            Browse...
          </button>
        </div>
        <span className="hint">
          A dated subfolder will be created: <code>&lt;destination&gt;/CompSync-Backup-&lt;competition&gt;-&lt;YYYY-MM-DD&gt;/</code>
        </span>
      </div>

      {error && (
        <div className="backup-error">Error: {error}</div>
      )}

      {progress && (
        <div className="backup-progress">
          <div className="backup-bar-track">
            <div className="backup-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="backup-progress-meta">
            <span>{pct}%</span>
            <span>{formatBytes(progress.bytesDone)} / {formatBytes(progress.totalBytes)}</span>
            <span>{progress.filesDone} / {progress.totalFiles} files</span>
            <span>{formatBytes(progress.bytesPerSec)}/s</span>
            <span>ETA {formatEta(progress.etaSec)}</span>
          </div>
          {progress.currentFile && (
            <div className="backup-current">{progress.currentFile}</div>
          )}
          {progress.phase === 'scanning' && (
            <div className="backup-current">Scanning source folders...</div>
          )}
        </div>
      )}

      {result && !running && (
        <div className="backup-result">
          <div className="backup-result-header">
            {result.cancelled
              ? 'Cancelled'
              : result.failed.length > 0
                ? 'Completed with errors'
                : 'Backup complete'}
          </div>
          <div className="backup-result-meta">
            {result.succeeded} copied · {result.skipped} skipped · {result.failed.length} failed ·{' '}
            {formatBytes(result.totalBytes)} · {Math.round(result.elapsedSec)}s
          </div>
          <div className="backup-result-path">{result.targetDir}</div>
          {result.failed.length > 0 && (
            <details className="backup-failed">
              <summary>Failed files ({result.failed.length})</summary>
              <ul>
                {result.failed.slice(0, 50).map((f, i) => (
                  <li key={i}>
                    <span className="backup-failed-path">{f.path}</span>
                    <span className="backup-failed-err">{f.error}</span>
                  </li>
                ))}
                {result.failed.length > 50 && <li>… and {result.failed.length - 50} more</li>}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="backup-actions">
        {!running && (
          <button
            className="btn-save"
            onClick={start}
            disabled={!target}
          >
            Start Backup
          </button>
        )}
        {running && (
          <button className="btn-cancel" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
