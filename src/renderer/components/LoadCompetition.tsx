import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import '../styles/loadcomp.css'

export default function LoadCompetition(): React.ReactElement {
  const [tab, setTab] = useState<'offline' | 'live'>('offline')
  const competition = useStore((s) => s.competition)
  const setLoadCompOpen = useStore((s) => s.setLoadCompOpen)
  const [dayFilter, setDayFilter] = useState('')

  async function handleBrowse(): Promise<void> {
    const filePath = await window.api.scheduleBrowseFile()
    if (filePath) {
      await window.api.scheduleLoadCSV(filePath)
      setLoadCompOpen(false)
    }
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file && /\.(csv|xls|xlsx)$/i.test(file.name)) {
      await window.api.scheduleLoadCSV(file.path)
      setLoadCompOpen(false)
    }
  }

  return (
    <div className="load-popover">
      <div className="popover-tabs">
        <button
          className={`popover-tab ${tab === 'offline' ? 'active' : ''}`}
          onClick={() => setTab('offline')}
        >
          Offline (File)
        </button>
        <button
          className={`popover-tab ${tab === 'live' ? 'active' : ''}`}
          onClick={() => setTab('live')}
        >
          Live (CompSync)
        </button>
      </div>

      {tab === 'offline' && (
        <div className="popover-panel">
          {competition && (
            <div className="comp-loaded">
              {competition.name} — {competition.routines.length} routines loaded
            </div>
          )}
          <div
            className="file-drop"
            onClick={handleBrowse}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            <div className="file-icon">Drop CSV or XLS file here</div>
            <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
              or click to browse
            </span>
          </div>
          {competition && competition.days.length > 0 && (
            <div className="field">
              <label>Day Filter</label>
              <select
                value={dayFilter}
                onChange={(e) => {
                  setDayFilter(e.target.value)
                  useStore.getState().setDayFilter(e.target.value)
                }}
              >
                <option value="">All Days</option>
                {competition.days.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {tab === 'live' && (
        <div className="popover-panel">
          <div className="field">
            <label>Tenant</label>
            <select>
              <option value="">Select tenant...</option>
            </select>
            <div className="hint">Requires API key configured in Settings</div>
          </div>
          <div className="field">
            <label>Competition</label>
            <select>
              <option value="">Select competition...</option>
            </select>
          </div>
          <div className="field">
            <label>Day</label>
            <select>
              <option>All Days</option>
            </select>
          </div>
          <button className="popover-action">Connect &amp; Load</button>
        </div>
      )}
    </div>
  )
}
