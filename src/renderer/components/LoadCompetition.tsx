import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import '../styles/loadcomp.css'

export default function LoadCompetition(): React.ReactElement {
  const [tab, setTab] = useState<'offline' | 'live'>('live')
  const competition = useStore((s) => s.competition)
  const settings = useStore((s) => s.settings)
  const setLoadCompOpen = useStore((s) => s.setLoadCompOpen)
  const [dayFilter, setDayFilter] = useState('')
  const [shareCode, setShareCode] = useState(settings?.compsync.shareCode || '')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleBrowse(): Promise<void> {
    setError('')
    const filePath = await window.api.scheduleBrowseFile()
    if (!filePath) return
    setLoading(true)
    try {
      await window.api.scheduleLoadCSV(filePath)
      setLoadCompOpen(false)
    } catch (err) {
      setError(`Failed to load file: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setError('')
    const file = e.dataTransfer.files[0]
    if (!file || !/\.(csv|xls|xlsx)$/i.test(file.name)) {
      setError('Please drop a CSV or XLS file')
      return
    }
    setLoading(true)
    try {
      await window.api.scheduleLoadCSV(file.path)
      setLoadCompOpen(false)
    } catch (err) {
      setError(`Failed to load file: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }

  async function handleLoadShareCode(): Promise<void> {
    const code = shareCode.trim()
    if (!code) {
      setError('Enter a share code')
      return
    }
    setError('')
    setLoading(true)
    try {
      await window.api.scheduleLoadShareCode(code)
      // Persist share code to settings
      await window.api.settingsSet({ compsync: { shareCode: code } })
      if (settings) {
        useStore.getState().setSettings({ ...settings, compsync: { shareCode: code } })
      }
      setLoadCompOpen(false)
    } catch (err) {
      setError(`Share code failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="load-popover">
      <div className="popover-tabs">
        <button
          className={`popover-tab ${tab === 'live' ? 'active' : ''}`}
          onClick={() => setTab('live')}
        >
          Live (Share Code)
        </button>
        <button
          className={`popover-tab ${tab === 'offline' ? 'active' : ''}`}
          onClick={() => setTab('offline')}
        >
          Offline (File)
        </button>
      </div>

      {tab === 'live' && (
        <div className="popover-panel">
          <div className="field">
            <label>Share Code</label>
            <input
              type="text"
              placeholder="e.g. EMPWR-SPRING-26"
              value={shareCode}
              onChange={(e) => setShareCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleLoadShareCode()
              }}
              style={{
                width: '100%',
                padding: '6px 8px',
                fontSize: '12px',
                fontWeight: 600,
                letterSpacing: '1px',
                border: '1px solid var(--border)',
                borderRadius: '3px',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                textAlign: 'center',
              }}
            />
            <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '3px', display: 'block' }}>
              Get this from your competition director
            </span>
          </div>
          {competition && competition.source === 'api' && (
            <div className="comp-loaded">
              {competition.name} — {competition.routines.length} routines loaded
            </div>
          )}
          {error && <div style={{ color: 'var(--danger)', fontSize: '10px', marginTop: '6px' }}>{error}</div>}
          <button
            className="popover-action"
            onClick={handleLoadShareCode}
            disabled={loading || !shareCode.trim()}
            style={loading ? { opacity: 0.5 } : undefined}
          >
            {loading ? 'Loading...' : 'Load Schedule'}
          </button>
        </div>
      )}

      {tab === 'offline' && (
        <div className="popover-panel">
          {competition && competition.source === 'csv' && (
            <div className="comp-loaded">
              {competition.name} — {competition.routines.length} routines loaded
            </div>
          )}
          <div
            className="file-drop"
            onClick={loading ? undefined : handleBrowse}
            onDragOver={(e) => e.preventDefault()}
            onDrop={loading ? undefined : handleDrop}
            style={loading ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
          >
            <div className="file-icon">{loading ? 'Loading...' : 'Drop CSV or XLS file here'}</div>
            <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
              or click to browse
            </span>
          </div>
          {error && <div style={{ color: 'var(--danger)', fontSize: '10px', marginTop: '6px' }}>{error}</div>}
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
    </div>
  )
}
