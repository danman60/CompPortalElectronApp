import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Routine } from '../../shared/types'
import { useStore } from '../store/useStore'

/**
 * Build #9 item #3 — "Move after routine X" popover.
 *
 * Drag-and-drop row reorder is fine for nudges of 2-3 rows but awkward for
 * jumping a routine across hundreds of slots. This popover gives a button-
 * driven path: click the row's Move button, type-to-filter, pick a target,
 * and the source routine splices to the position immediately after that
 * target via the existing stateSetDisplayOrder IPC.
 */

let openExternally: ((source: Routine) => void) | null = null

export function requestMoveAfter(source: Routine): void {
  openExternally?.(source)
}

interface RenderAPI {
  stateSetDisplayOrder: (routineIds: string[]) => Promise<unknown>
}

function getApi(): RenderAPI | null {
  const w = window as unknown as { api?: RenderAPI }
  return w.api ?? null
}

export default function MoveAfterPopover(): React.ReactElement | null {
  const competition = useStore((s) => s.competition)
  const [source, setSource] = useState<Routine | null>(null)
  const [query, setQuery] = useState('')
  const [hoverIdx, setHoverIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    openExternally = (s) => {
      setSource(s)
      setQuery('')
      setHoverIdx(0)
      setError(null)
    }
    return () => { openExternally = null }
  }, [])

  useEffect(() => {
    if (source) {
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [source])

  useEffect(() => {
    if (!source) return
    function onMouseDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setSource(null)
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setSource(null)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [source])

  const candidates = useMemo<Routine[]>(() => {
    if (!source || !competition) return []
    const all = competition.routines.filter((r) => r.id !== source.id)
    const order = competition.displayOrder && competition.displayOrder.length > 0
      ? competition.displayOrder
      : null
    const sorted = order
      ? [...all].sort((a, b) => {
          const ai = order.indexOf(a.id)
          const bi = order.indexOf(b.id)
          if (ai === -1 && bi === -1) return 0
          if (ai === -1) return 1
          if (bi === -1) return -1
          return ai - bi
        })
      : all
    if (!query.trim()) return sorted
    const q = query.toLowerCase()
    return sorted.filter((r) =>
      r.entryNumber.toLowerCase().includes(q) ||
      r.routineTitle.toLowerCase().includes(q) ||
      r.studioName.toLowerCase().includes(q) ||
      (r.dancers || '').toLowerCase().includes(q),
    )
  }, [source, competition, query])

  useEffect(() => {
    if (hoverIdx >= candidates.length) setHoverIdx(Math.max(0, candidates.length - 1))
  }, [candidates.length, hoverIdx])

  // Keep the highlighted row scrolled into view as the operator arrow-keys.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const row = list.querySelector<HTMLDivElement>(`[data-idx="${hoverIdx}"]`)
    if (row) row.scrollIntoView({ block: 'nearest' })
  }, [hoverIdx])

  if (!source) return null

  async function commit(target: Routine): Promise<void> {
    if (!competition || !source || busy) return
    const api = getApi()
    if (!api) {
      setError('IPC bridge unavailable')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const allIds = competition.routines.map((r) => r.id)
      const baseOrder =
        (competition.displayOrder && competition.displayOrder.length > 0)
          ? competition.displayOrder.filter((id) => allIds.includes(id))
          : allIds.slice()
      for (const id of allIds) if (!baseOrder.includes(id)) baseOrder.push(id)
      const fromIdx = baseOrder.indexOf(source.id)
      if (fromIdx >= 0) baseOrder.splice(fromIdx, 1)
      const targetIdx = baseOrder.indexOf(target.id)
      if (targetIdx < 0) {
        setError('Target routine not found in current order')
        setBusy(false)
        return
      }
      baseOrder.splice(targetIdx + 1, 0, source.id)
      await api.stateSetDisplayOrder(baseOrder)
      setSource(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHoverIdx((i) => Math.min(candidates.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHoverIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = candidates[hoverIdx]
      if (target) void commit(target)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        zIndex: 9990,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        ref={wrapRef}
        style={{
          width: 480,
          maxHeight: '70vh',
          background: 'var(--bg-secondary, #252536)',
          border: '1px solid var(--border-focus, #667eea)',
          borderRadius: 10,
          padding: '14px 16px',
          color: 'var(--text-primary)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
        role="dialog"
        aria-label="Move routine after"
      >
        <div>
          <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 0.5, marginBottom: 4 }}>
            MOVE ROUTINE
          </div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            Move R{source.entryNumber} — {source.routineTitle || 'untitled'}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
            after which routine?
          </div>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHoverIdx(0) }}
          onKeyDown={onKeyDown}
          placeholder="Type # / name / studio / dancers..."
          style={{
            background: 'var(--bg-primary, #161622)',
            border: '1px solid var(--border, #3a3a52)',
            color: 'var(--text-primary)',
            padding: '8px 10px',
            borderRadius: 4,
            fontSize: 13,
          }}
        />

        <div
          ref={listRef}
          style={{
            flex: 1,
            minHeight: 200,
            maxHeight: '50vh',
            overflowY: 'auto',
            border: '1px solid var(--border, #3a3a52)',
            borderRadius: 4,
            background: 'var(--bg-primary, #161622)',
          }}
        >
          {candidates.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, opacity: 0.6, textAlign: 'center' }}>
              No matching routines.
            </div>
          ) : (
            candidates.map((r, idx) => {
              const isHover = idx === hoverIdx
              return (
                <div
                  key={r.id}
                  data-idx={idx}
                  onMouseEnter={() => setHoverIdx(idx)}
                  onClick={() => void commit(r)}
                  style={{
                    padding: '6px 10px',
                    cursor: 'pointer',
                    background: isHover ? 'rgba(99,102,241,0.18)' : 'transparent',
                    borderLeft: isHover ? '3px solid var(--accent, #667eea)' : '3px solid transparent',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                  }}
                >
                  <span style={{ fontWeight: 700, minWidth: 44, opacity: 0.9 }}>R{r.entryNumber}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.routineTitle || 'untitled'}
                  </span>
                  <span style={{ fontSize: 10, opacity: 0.6, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.studioName}
                  </span>
                </div>
              )
            })
          )}
        </div>

        {error && (
          <div style={{ fontSize: 11, color: 'var(--danger, #f87171)' }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 10, opacity: 0.5 }}>
            ↑/↓ navigate · Enter commits · Esc cancels
          </div>
          <button
            type="button"
            onClick={() => setSource(null)}
            disabled={busy}
            style={{
              background: 'transparent',
              border: '1px solid var(--border, #3a3a52)',
              color: 'var(--text-secondary)',
              padding: '6px 12px',
              borderRadius: 4,
              fontSize: 12,
              cursor: 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
          >Cancel</button>
        </div>
      </div>
    </div>
  )
}
