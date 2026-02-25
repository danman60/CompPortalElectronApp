import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import type { Routine, RoutineStatus } from '../../shared/types'
import '../styles/table.css'

function statusToLabel(status: RoutineStatus): { text: string; className: string } {
  switch (status) {
    case 'pending':
      return { text: 'Not recorded', className: 'waiting' }
    case 'skipped':
      return { text: 'Skipped', className: 'waiting' }
    case 'recording':
      return { text: 'LIVE', className: 'recording' }
    case 'recorded':
      return { text: 'Recorded', className: 'processing' }
    case 'queued':
      return { text: 'Queued', className: 'waiting' }
    case 'encoding':
      return { text: 'Encoding', className: 'processing' }
    case 'encoded':
      return { text: 'Encoded', className: 'complete' }
    case 'uploading':
      return { text: 'Uploading', className: 'uploading' }
    case 'uploaded':
      return { text: 'Uploaded', className: 'complete' }
    case 'confirmed':
      return { text: 'Confirmed', className: 'complete' }
    case 'failed':
      return { text: 'Failed', className: 'failed' }
    default:
      return { text: status, className: 'waiting' }
  }
}

function getProgressPercent(routine: Routine): number {
  switch (routine.status) {
    case 'pending':
    case 'skipped':
      return 0
    case 'recording':
      return 10
    case 'recorded':
      return 20
    case 'encoding':
      return 50
    case 'encoded':
      return 70
    case 'uploading':
      return routine.uploadProgress?.percent
        ? 70 + (routine.uploadProgress.percent * 0.3)
        : 75
    case 'uploaded':
    case 'confirmed':
      return 100
    case 'failed':
      return 0
    default:
      return 0
  }
}

function getBarClass(status: RoutineStatus): string {
  switch (status) {
    case 'encoding':
    case 'recorded':
      return 'processing'
    case 'uploading':
      return 'uploading'
    case 'uploaded':
    case 'confirmed':
    case 'encoded':
      return 'complete'
    default:
      return ''
  }
}

function getVideoInfo(routine: Routine, judgeCount: number): { text: string; color: string } {
  const total = judgeCount + 1
  if (routine.status === 'pending' || routine.status === 'skipped') {
    return { text: '\u2014', color: 'var(--text-muted)' }
  }
  if (routine.status === 'recording' || routine.status === 'recorded' || routine.status === 'queued') {
    return { text: `0/${total}`, color: 'var(--text-muted)' }
  }
  if (!routine.encodedFiles || routine.encodedFiles.length === 0) {
    return { text: `0/${total}`, color: 'var(--text-muted)' }
  }
  const uploaded = routine.encodedFiles.filter((f) => f.uploaded).length
  const encoded = routine.encodedFiles.length
  if (uploaded === total) {
    return { text: `${uploaded}/${total}`, color: 'var(--success)' }
  }
  if (uploaded > 0) {
    return { text: `${uploaded}/${total}`, color: 'var(--upload-blue)' }
  }
  return { text: `${encoded}/${total}`, color: 'var(--warning)' }
}

function NoteEditor({ routine }: { routine: Routine }): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(routine.notes || '')

  function handleSave(): void {
    window.api.setRoutineNote(routine.id, text.trim())
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="note-editor" onClick={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSave()
            }
            if (e.key === 'Escape') {
              setText(routine.notes || '')
              setEditing(false)
            }
          }}
          placeholder="Add note..."
          rows={2}
        />
      </div>
    )
  }

  return (
    <button
      className={`note-btn${routine.notes ? ' has-note' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      title={routine.notes || 'Add note'}
    >
      {routine.notes ? '\u270E' : '\u270E'}
    </button>
  )
}

export default function RoutineTable(): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const currentRoutine = useStore((s) => s.currentRoutine)
  const settings = useStore((s) => s.settings)
  const dayFilter = useStore((s) => s.dayFilter)
  const searchQuery = useStore((s) => s.searchQuery)
  const compactMode = useStore((s) => s.compactMode)
  const obsState = useStore((s) => s.obsState)
  const judgeCount = settings?.competition.judgeCount ?? 3

  let routines = competition?.routines ?? []

  if (dayFilter) {
    routines = routines.filter((r) => r.scheduledDay === dayFilter)
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase()
    routines = routines.filter(
      (r) =>
        r.routineTitle.toLowerCase().includes(q) ||
        r.entryNumber.includes(q) ||
        r.studioName.toLowerCase().includes(q) ||
        r.dancers.toLowerCase().includes(q),
    )
  }

  async function handleJumpTo(routine: Routine): Promise<void> {
    if (obsState.isRecording) return
    await window.api.jumpToRoutine(routine.id)
  }

  async function handleViewMedia(routine: Routine): Promise<void> {
    const dir = routine.outputDir || (routine.outputPath ? routine.outputPath.replace(/[/\\][^/\\]+$/, '') : null)
    if (dir) {
      await window.api.openPath(dir)
    }
  }

  return (
    <div className="table-scroll">
      <table className="upload-table">
        <thead>
          <tr>
            <th style={{ paddingLeft: '10px' }}>#</th>
            <th>Routine</th>
            {!compactMode && <th>Videos</th>}
            {!compactMode && <th>Photos</th>}
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {routines.map((routine) => {
            const isLive = routine.status === 'recording'
            const isNotRecorded = routine.status === 'pending' || routine.status === 'skipped'
            const isCurrent = currentRoutine?.id === routine.id
            const statusInfo = statusToLabel(routine.status)
            const progress = getProgressPercent(routine)
            const barClass = getBarClass(routine.status)

            return (
              <tr
                key={routine.id}
                className={isCurrent ? 'current-row' : ''}
                onClick={() => handleJumpTo(routine)}
                style={{
                  cursor: obsState.isRecording ? 'not-allowed' : 'pointer',
                  ...(isLive
                    ? { background: 'rgba(239,68,68,0.06)', borderLeft: '3px solid var(--recording)' }
                    : {}),
                  ...(isCurrent && !isLive
                    ? { background: 'rgba(99,102,241,0.08)', borderLeft: '3px solid var(--accent)' }
                    : {}),
                  ...(isNotRecorded && !isCurrent ? { opacity: 0.35 } : {}),
                }}
              >
                <td style={{ paddingLeft: isLive || isCurrent ? '7px' : '10px' }}>
                  <span
                    className="entry-num"
                    style={isLive ? { color: 'var(--recording)' } : undefined}
                  >
                    {routine.entryNumber}
                  </span>
                </td>
                <td>
                  <div className="r-name" style={isLive ? { display: 'flex', alignItems: 'center', gap: '5px' } : undefined}>
                    {isLive && <span className="live-indicator" />}
                    {routine.routineTitle}
                    {isLive && <span className="live-badge">LIVE</span>}
                  </div>
                  <div className="r-sub">
                    {routine.studioCode} &bull; {routine.ageGroup} {routine.category}
                  </div>
                </td>
                {!compactMode && (
                  <td>
                    {(() => {
                      const info = getVideoInfo(routine, judgeCount)
                      return <span style={{ color: info.color }}>{info.text}</span>
                    })()}
                  </td>
                )}
                {!compactMode && (
                  <td style={{ color: routine.photos?.length ? 'var(--success)' : 'var(--text-muted)' }}>
                    {routine.photos?.length || '\u2014'}
                  </td>
                )}
                <td>
                  {isNotRecorded ? (
                    <span className={`status-label ${statusInfo.className}`}>{statusInfo.text}</span>
                  ) : (
                    <div className="status-progress">
                      <div className="bar-track">
                        <div
                          className={`bar-fill ${barClass}`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className={`status-label ${statusInfo.className}`}>
                        {statusInfo.text}
                        {routine.uploadProgress?.percent
                          ? ` \u2014 ${routine.uploadProgress.percent}%`
                          : ''}
                      </span>
                    </div>
                  )}
                </td>
                <td style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                  <NoteEditor routine={routine} />
                  {!isNotRecorded && (
                    <button
                      className="view-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleViewMedia(routine)
                      }}
                    >
                      View
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
