import React, { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/types'
import type { PipelineHealthSnapshot } from '../../shared/types'

/**
 * A56 — pipeline-health header chip (narrow slice).
 *
 * Subscribes to PIPELINE_HEALTH IPC. Renders a single colored dot that
 * reflects worst stage health. Click → expand inline panel with each
 * stage's last-activity timestamp + pending count + reason.
 *
 * Encode + thumb + keyframe stages deferred (not in tonight's slice).
 */

const STAGE_LABELS: Record<string, string> = {
  recording:    'Recording',
  photoImport:  'Photo Import',
  photoUpload:  'Photo Upload',
  videoUpload:  'Video Upload',
}

function colorFor(health: 'green' | 'yellow' | 'red' | 'unknown'): string {
  switch (health) {
    case 'red':     return '#ef4444'
    case 'yellow':  return '#fbbf24'
    case 'green':   return '#4ade80'
    default:        return '#606080'
  }
}

function formatAge(lastMs: number): string {
  if (lastMs === 0) return '—'
  const ageSec = Math.max(0, Math.round((Date.now() - lastMs) / 1000))
  if (ageSec < 60) return `${ageSec}s`
  const mins = Math.floor(ageSec / 60)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  return `${h}h${mins % 60}m`
}

export default function PipelineHealthChip(): React.ReactElement | null {
  const [snap, setSnap] = useState<PipelineHealthSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [kicking, setKicking] = useState(false)
  const [kickedAt, setKickedAt] = useState<number>(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  async function handleKick(): Promise<void> {
    if (kicking) return
    setKicking(true)
    try {
      await (window.api as any).jobQueueKick()
      setKickedAt(Date.now())
    } catch {
      // logged server-side
    } finally {
      setKicking(false)
    }
  }

  useEffect(() => {
    if (!window.api) return
    const off = window.api.on(IPC_CHANNELS.PIPELINE_HEALTH, (data: unknown) => {
      setSnap(data as PipelineHealthSnapshot)
    })
    return () => { try { off() } catch {} }
  }, [])

  // Click-outside to close.
  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClickOutside)
    return () => window.removeEventListener('mousedown', onClickOutside)
  }, [open])

  if (!snap) return null

  const dot = colorFor(snap.worst)

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        title={`Pipeline health: ${snap.worst}`}
        aria-label="Pipeline health"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'transparent',
          border: '1px solid var(--border, #3a3a52)',
          borderRadius: 12,
          padding: '2px 8px',
          color: 'var(--text-primary)',
          fontSize: 11,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: dot,
            boxShadow: `0 0 6px ${dot}`,
          }}
        />
        <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>PIPE</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '110%',
            right: 0,
            zIndex: 9999,
            minWidth: 280,
            background: 'var(--bg-secondary, #252536)',
            border: '1px solid var(--border, #3a3a52)',
            borderRadius: 6,
            padding: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            color: 'var(--text-primary)',
            fontSize: 11,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 11, letterSpacing: 0.5, opacity: 0.8 }}>
            PIPELINE HEALTH
          </div>
          {snap.stages.map((s) => (
            <div
              key={s.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '12px 1fr auto',
                gap: 8,
                alignItems: 'center',
                padding: '4px 0',
                borderBottom: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: colorFor(s.health),
                }}
              />
              <div>
                <div style={{ fontWeight: 600 }}>{STAGE_LABELS[s.id] ?? s.id}</div>
                {s.reason && (
                  <div style={{ opacity: 0.7, fontSize: 10, marginTop: 1 }}>{s.reason}</div>
                )}
              </div>
              <div style={{ textAlign: 'right', opacity: 0.7, fontSize: 10 }}>
                {s.pendingCount > 0 && <div>{s.pendingCount} pending</div>}
                <div>last {formatAge(s.lastActivityMs)} ago</div>
              </div>
            </div>
          ))}
          <div
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={handleKick}
              disabled={kicking}
              title="Re-fire encode + upload + photo-import schedulers. Use when any stage looks stuck."
              style={{
                background: 'transparent',
                border: '1px solid var(--accent, #6366f1)',
                borderRadius: 4,
                padding: '4px 10px',
                color: 'var(--accent, #a5b4fc)',
                fontSize: 11,
                fontWeight: 600,
                cursor: kicking ? 'wait' : 'pointer',
                opacity: kicking ? 0.6 : 1,
              }}
            >
              {kicking ? 'Kicking…' : 'Kick All Stages'}
            </button>
            {kickedAt > 0 && (
              <span style={{ opacity: 0.6, fontSize: 10 }}>
                kicked {formatAge(kickedAt)} ago
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
