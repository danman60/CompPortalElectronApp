import React from 'react'
import { useStore } from '../store/useStore'
import type { Routine } from '../../shared/types'

const LIMIT = 5

export default function PreviousRoutines(): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const currentIndex = useStore((s) => s.currentIndex)

  const previous: Routine[] = competition
    ? competition.routines.slice(Math.max(0, currentIndex - LIMIT), currentIndex).reverse()
    : []

  if (previous.length === 0) {
    return (
      <div className="panel-mini-list empty">No previous routines</div>
    )
  }

  return (
    <div className="panel-mini-list">
      {previous.map((r) => (
        <div key={r.id} className={`mini-row status-${r.status}`}>
          <span className="mini-num">#{r.entryNumber}</span>
          <span className="mini-title" title={r.routineTitle}>{r.routineTitle}</span>
          <span className="mini-studio" title={r.studioName}>{r.studioCode || r.studioName}</span>
          <span className="mini-status">{statusLabel(r.status)}</span>
        </div>
      ))}
    </div>
  )
}

function statusLabel(status: string): string {
  switch (status) {
    case 'recorded': return 'REC'
    case 'encoded': return 'ENC'
    case 'uploaded': return 'UP'
    case 'confirmed': return 'OK'
    case 'skipped': return 'SKIP'
    case 'failed': return 'FAIL'
    case 'recording_interrupted': return 'INT'
    default: return status.slice(0, 4).toUpperCase()
  }
}
