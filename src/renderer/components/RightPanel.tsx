import React from 'react'
import { useStore } from '../store/useStore'
import RoutineTable from './RoutineTable'
import '../styles/rightpanel.css'

export default function RightPanel(): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const settings = useStore((s) => s.settings)
  const encodingCount = useStore((s) => s.encodingCount)
  const uploadingCount = useStore((s) => s.uploadingCount)
  const completeCount = useStore((s) => s.completeCount)
  const photosPendingCount = useStore((s) => s.photosPendingCount)
  const searchQuery = useStore((s) => s.searchQuery)
  const setSearchQuery = useStore.getState().setSearchQuery

  const total = competition?.routines.length ?? 0
  const recorded = competition?.routines.filter(
    (r) => r.status !== 'pending' && r.status !== 'skipped',
  ).length ?? 0
  const remaining = total - recorded
  const outputDir = settings?.fileNaming.outputDirectory || ''

  async function handleOpenOutputDir(): Promise<void> {
    if (outputDir) {
      await window.api.openPath(outputDir)
    }
  }

  async function handleChangeOutputDir(): Promise<void> {
    const dir = await window.api.settingsBrowseDir()
    if (dir && settings) {
      await window.api.settingsSet({
        ...settings,
        fileNaming: { ...settings.fileNaming, outputDirectory: dir },
      })
      useStore.getState().setSettings({
        ...settings,
        fileNaming: { ...settings.fileNaming, outputDirectory: dir },
      })
    }
  }

  async function handleExportReport(): Promise<void> {
    await window.api.exportReport()
  }

  return (
    <div className="right-panel">
      <div className="right-header">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Schedule
        </div>
        <input
          type="text"
          className="search-input"
          placeholder="Search # / name / studio..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            flex: 1,
            maxWidth: '200px',
            padding: '3px 8px',
            fontSize: '10px',
            border: '1px solid var(--border)',
            borderRadius: '3px',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
          }}
        />
      </div>

      <RoutineTable />

      <div className="stats-bar">
        {outputDir ? (
          <div className="stat output-dir-stat">
            <span
              className="output-dir-path"
              title={outputDir}
              onClick={handleOpenOutputDir}
            >
              {outputDir.length > 40 ? '...' + outputDir.slice(-37) : outputDir}
            </span>
            <button className="output-dir-change" onClick={handleChangeOutputDir}>
              Change
            </button>
          </div>
        ) : (
          <div className="stat">
            <button className="output-dir-change" onClick={handleChangeOutputDir}>
              Set Output Dir
            </button>
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="output-dir-change"
          onClick={handleExportReport}
          title="Export session report (CSV)"
          style={{ fontSize: '9px' }}
        >
          Export
        </button>
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
            <span className="stat-num" style={{ color: '#c084fc' }}>{photosPendingCount}</span> Photos
          </div>
        )}
        <div className="stat">
          <span className="stat-num" style={{ color: 'var(--accent)' }}>{total}</span> Total
          &nbsp;&bull;&nbsp;
          <span className="stat-num" style={{ color: 'var(--success)' }}>{recorded}</span> Rec
          &nbsp;&bull;&nbsp;
          <span className="stat-num" style={{ color: 'var(--warning)' }}>{remaining}</span> Left
        </div>
      </div>
    </div>
  )
}
