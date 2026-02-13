import React from 'react'
import { useStore } from '../store/useStore'
import RoutineTable from './RoutineTable'
import '../styles/rightpanel.css'

export default function RightPanel(): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const encodingCount = useStore((s) => s.encodingCount)
  const uploadingCount = useStore((s) => s.uploadingCount)
  const completeCount = useStore((s) => s.completeCount)
  const photosPendingCount = useStore((s) => s.photosPendingCount)

  const total = competition?.routines.length ?? 0
  const recorded = competition?.routines.filter(
    (r) => r.status !== 'pending' && r.status !== 'skipped',
  ).length ?? 0
  const remaining = total - recorded

  async function handleEncodeNow(): Promise<void> {
    await window.api.ffmpegEncodeAll()
  }

  async function handleImportPhotos(): Promise<void> {
    const folder = await window.api.photosBrowse()
    if (folder) {
      await window.api.photosImport(folder)
    }
  }

  return (
    <div className="right-panel">
      <div className="right-header">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Uploads &amp; Schedule
        </div>
        <div className="right-actions">
          <div className="toggle-compact">
            <span>Auto</span>
            <label className="toggle-switch">
              <input type="checkbox" defaultChecked />
              <span className="toggle-slider" />
            </label>
          </div>
          <button className="action-btn primary" onClick={handleEncodeNow}>
            Encode Now
          </button>
          <button className="action-btn photos" onClick={handleImportPhotos}>
            Import Photos
          </button>
        </div>
      </div>

      <RoutineTable />

      <div className="stats-bar">
        {encodingCount > 0 && (
          <div className="stat">
            <span className="stat-num" style={{ color: 'var(--warning)' }}>{encodingCount}</span> Encoding
          </div>
        )}
        {uploadingCount > 0 && (
          <div className="stat">
            <span className="stat-num" style={{ color: 'var(--upload-blue)' }}>{uploadingCount}</span> Uploading
          </div>
        )}
        <div className="stat">
          <span className="stat-num" style={{ color: 'var(--success)' }}>{completeCount}</span> Complete
        </div>
        {photosPendingCount > 0 && (
          <div className="stat">
            <span className="stat-num" style={{ color: '#c084fc' }}>{photosPendingCount}</span> Photos Pending
          </div>
        )}
        <div style={{ flex: 1 }} />
        <div className="stat">
          <span className="stat-num" style={{ color: 'var(--accent)' }}>{total}</span> Total
          &nbsp;&bull;&nbsp;
          <span className="stat-num" style={{ color: 'var(--success)' }}>{recorded}</span> Recorded
          &nbsp;&bull;&nbsp;
          <span className="stat-num" style={{ color: 'var(--warning)' }}>{remaining}</span> Remaining
        </div>
      </div>
    </div>
  )
}
