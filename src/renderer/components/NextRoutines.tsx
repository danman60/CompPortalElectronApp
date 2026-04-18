import React from 'react'
import { useStore } from '../store/useStore'
import type { Routine } from '../../shared/types'

const LIMIT = 5

export default function NextRoutines(): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const currentIndex = useStore((s) => s.currentIndex)

  const upcoming: Routine[] = competition
    ? competition.routines.slice(currentIndex + 1, currentIndex + 1 + LIMIT)
    : []

  if (upcoming.length === 0) {
    return (
      <div className="panel-mini-list empty">No upcoming routines</div>
    )
  }

  async function handleJump(routineId: string): Promise<void> {
    try { await window.api.jumpToRoutine(routineId) } catch { /* ignore */ }
  }

  return (
    <div className="panel-mini-list">
      {upcoming.map((r) => (
        <div
          key={r.id}
          className={`mini-row clickable status-${r.status}`}
          onClick={() => handleJump(r.id)}
          title="Click to jump to this routine"
        >
          <span className="mini-num">#{r.entryNumber}</span>
          <span className="mini-title" title={r.routineTitle}>{r.routineTitle}</span>
          <span className="mini-studio" title={r.studioName}>{r.studioCode || r.studioName}</span>
        </div>
      ))}
    </div>
  )
}
