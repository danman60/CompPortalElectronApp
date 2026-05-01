import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [popoverRect, setPopoverRect] = useState<{ top: number; right: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

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

  // Click-outside to close. Popover is rendered via portal at document.body
  // so the wrapRef check needs to also consider popover-internal clicks.
  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent): void {
      const target = e.target as Node
      const insideButton = wrapRef.current?.contains(target)
      const insidePopover = (target as Element)?.closest?.('[data-pipe-popover="1"]')
      if (!insideButton && !insidePopover) setOpen(false)
    }
    window.addEventListener('mousedown', onClickOutside)
    return () => window.removeEventListener('mousedown', onClickOutside)
  }, [open])

  // Recompute popover position on open + on window resize/scroll. We use
  // position:fixed coords derived from the button's bounding rect because
  // the chip lives inside a topband stacking context that traps absolute
  // children (Burlington UDC 2026-05-01: operator reported popover wouldn't
  // draw over CurrentRoutine). Portal + fixed-position fully escapes parent
  // overflow:hidden + stacking context.
  useEffect(() => {
    if (!open) return
    function reposition(): void {
      const r = buttonRef.current?.getBoundingClientRect()
      if (!r) return
      // Burlington UDC 2026-05-01 follow-up: prior fix anchored to right edge,
      // which on narrower viewports pushed the popover's LEFT edge past the
      // viewport's left edge (clipping the labels). Clamp so the popover's
      // left edge stays inside the viewport with an 8px margin.
      const POPOVER_W = 296 // minWidth 280 + 16 padding
      const MARGIN = 8
      let rightOffset = window.innerWidth - r.right
      // If anchoring right would push left edge off-screen, anchor with margin
      // from the left of the viewport instead.
      if (window.innerWidth - rightOffset - POPOVER_W < MARGIN) {
        rightOffset = Math.max(MARGIN, window.innerWidth - POPOVER_W - MARGIN)
      }
      setPopoverRect({ top: r.bottom + 4, right: rightOffset })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  if (!snap) return null

  const dot = colorFor(snap.worst)

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={buttonRef}
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
      {open && popoverRect && createPortal(
        <div
          data-pipe-popover="1"
          style={{
            position: 'fixed',
            top: popoverRect.top,
            right: popoverRect.right,
            zIndex: 99999,
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
        </div>,
        document.body
      )}
    </div>
  )
}
