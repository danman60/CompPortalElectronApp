import React from 'react'
import { useStore } from '../store/useStore'
import '../styles/routine.css'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function CurrentRoutine(): React.ReactElement {
  const current = useStore((s) => s.currentRoutine)
  const next = useStore((s) => s.nextRoutine)
  const obsState = useStore((s) => s.obsState)

  if (!current) {
    return (
      <div className="section">
        <div className="section-title">Current Routine</div>
        <div className="routine-card">
          <div style={{ color: 'var(--text-muted)', fontSize: '11px', textAlign: 'center', padding: '20px' }}>
            No competition loaded. Click "Load Competition" to begin.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="section">
      <div className="section-title">Current Routine</div>
      <div className={`routine-card ${obsState.isRecording ? 'is-recording' : ''}`}>
        <div className="routine-top">
          <div className="routine-number">{current.entryNumber}</div>
          <div className="routine-details">
            <div className="routine-title">{current.routineTitle}</div>
            <div className="routine-dancers">{current.dancers}</div>
            <div className="routine-meta">
              <span>{current.ageGroup} {current.category}</span>
              <span>{current.sizeCategory}</span>
              <span>{current.classification}</span>
            </div>
          </div>
        </div>
        <div className="routine-studio">
          {current.studioName} &bull; {current.studioCode}
        </div>
        {obsState.isRecording && (
          <div className="recording-timer">
            <span className="rec-dot" />
            <span>{formatTime(obsState.recordTimeSec)}</span>
            <span style={{ opacity: 0.5, fontSize: '10px' }}>
              / ~{current.durationMinutes}:00
            </span>
          </div>
        )}
      </div>

      {next && (
        <div className="next-up">
          <div className="next-up-label">Up Next</div>
          <div className="next-up-title">
            #{next.entryNumber} — {next.routineTitle}
          </div>
          <div className="next-up-detail">
            {next.dancers} &bull; {next.ageGroup} {next.category} {next.sizeCategory}
          </div>
        </div>
      )}
    </div>
  )
}
