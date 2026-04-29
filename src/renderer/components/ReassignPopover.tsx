import React, { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/types'
import type { ActiveTake, Routine } from '../../shared/types'
import { useStore } from '../store/useStore'

/**
 * Item 17 / A54 — non-blocking reassign confirmation popover.
 *
 * Listens to RECORDING_ACTIVE_TAKE IPC. When a take is active, exposes a
 * `requestReassign` global so RoutineTable can call it on row-click. The
 * popover renders centered, non-blocking; recording continues uninterrupted.
 *
 *   - Click ✓        → fires recordingReassignTarget IPC, dismisses
 *   - Click outside  → dismiss with no action
 *   - Escape         → dismiss with no action
 *
 * Operator decisions (2026-04-28 spec):
 *   - Centered, NOT in-row (in-row would scroll out of view)
 *   - Non-blocking (RECORD button + recording flow stay live behind it)
 *   - Recording always saves SOMEWHERE — explicit slot, typed number,
 *     or auto-overflow (999, 998, ...) on STOP without confirm.
 */

type ReassignTarget =
  | { kind: 'routine'; routine: Routine }
  | { kind: 'empty' }

let openExternally: ((t: ReassignTarget) => void) | null = null

/** Public API for RoutineTable / Controls — opens the popover. */
export function requestReassign(t: ReassignTarget): void {
  openExternally?.(t)
}

interface RenderAPI {
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
  recordingReassignTarget: (payload: {
    routineId?: string | null
    emptyRoutineNumber?: string
  }) => Promise<{ ok?: boolean; error?: string }>
}

function getApi(): RenderAPI | null {
  const w = window as unknown as { api?: RenderAPI }
  return w.api ?? null
}

export default function ReassignPopover(): React.ReactElement | null {
  const [activeTake, setActiveTake] = useState<ActiveTake | null>(null)
  const [target, setTarget] = useState<ReassignTarget | null>(null)
  const [emptyInput, setEmptyInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const competition = useStore((s) => s.competition)
  const currentRoutine = useStore((s) => s.currentRoutine)

  // Subscribe to active-take broadcasts.
  useEffect(() => {
    const api = getApi()
    if (!api) return
    const off = api.on(IPC_CHANNELS.RECORDING_ACTIVE_TAKE, (data: unknown) => {
      setActiveTake((data as ActiveTake | null) ?? null)
      // If recording stops mid-popover, dismiss.
      if (!data) { setTarget(null); setError(null) }
    })
    return () => { try { off() } catch {} }
  }, [])

  // Register external open handler.
  useEffect(() => {
    openExternally = (t) => {
      // Default the empty-routine input to <currentEntry>.5 placeholder.
      if (t.kind === 'empty' && currentRoutine) {
        setEmptyInput(`${currentRoutine.entryNumber}.5`)
      } else {
        setEmptyInput('')
      }
      setError(null)
      setTarget(t)
    }
    return () => { openExternally = null }
  }, [currentRoutine])

  // Click-outside + Escape dismiss.
  useEffect(() => {
    if (!target) return
    function onMouseDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setTarget(null)
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setTarget(null)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [target])

  // Auto-focus the empty-routine input.
  useEffect(() => {
    if (target?.kind === 'empty') {
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [target])

  if (!activeTake || !target) return null

  async function handleConfirm(): Promise<void> {
    if (busy) return
    const api = getApi()
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      let payload: { routineId?: string | null; emptyRoutineNumber?: string }
      if (target.kind === 'routine') {
        payload = { routineId: target.routine.id }
      } else {
        const trimmed = emptyInput.trim()
        if (!/^\d{1,3}(\.5)?$/.test(trimmed)) {
          setError('Enter a number like 226 or 226.5 (max 3 digits + optional .5)')
          setBusy(false)
          return
        }
        payload = { emptyRoutineNumber: trimmed }
      }
      const result = await api.recordingReassignTarget(payload)
      if (result?.error) {
        setError(result.error)
      } else {
        setTarget(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const targetLabel = target.kind === 'routine'
    ? `R${target.routine.entryNumber} — ${target.routine.routineTitle || 'untitled'}`
    : 'a new empty routine'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // No backdrop fill — non-blocking; clicks fall through outside the box.
        background: 'transparent',
        pointerEvents: 'none',
        zIndex: 9990,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        ref={wrapRef}
        style={{
          pointerEvents: 'auto',
          minWidth: 360,
          maxWidth: 460,
          background: 'var(--bg-secondary, #252536)',
          border: '1px solid var(--border-focus, #667eea)',
          borderRadius: 10,
          padding: '14px 16px',
          color: 'var(--text-primary)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
        role="dialog"
        aria-label="Reassign recording target"
      >
        <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 0.5, marginBottom: 4 }}>
          ACTIVE RECORDING
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
          Save recording as {targetLabel}?
        </div>

        {target.kind === 'empty' && (
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, opacity: 0.7, display: 'block', marginBottom: 4 }}>
              Empty-routine number
            </label>
            <input
              ref={inputRef}
              type="text"
              value={emptyInput}
              onChange={(e) => { setEmptyInput(e.target.value); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleConfirm() }}
              placeholder="e.g., 226.5 or 355"
              style={{
                width: '100%',
                background: 'var(--bg-primary, #161622)',
                border: '1px solid var(--border, #3a3a52)',
                color: 'var(--text-primary)',
                padding: '6px 10px',
                borderRadius: 4,
                fontSize: 13,
              }}
              maxLength={5}
              inputMode="decimal"
            />
            <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>
              Format: 3-digit number, optional .5 suffix. Routine row will be created if missing.
            </div>
          </div>
        )}

        {error && (
          <div style={{ fontSize: 11, color: 'var(--danger, #f87171)', marginBottom: 8 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => setTarget(null)}
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
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={busy}
            style={{
              background: 'var(--accent, #667eea)',
              border: '1px solid var(--accent, #667eea)',
              color: '#fff',
              padding: '6px 16px',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
          >{busy ? 'Saving…' : '✓  Confirm'}</button>
        </div>

        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 10 }}>
          Recording continues. Cancel keeps the current target ({competition?.routines.find((r) => r.id === activeTake.currentTargetRoutineId)?.entryNumber
            ? `R${competition?.routines.find((r) => r.id === activeTake.currentTargetRoutineId)?.entryNumber}`
            : 'unset'}).
          Take ID: {activeTake.takeId.slice(0, 8)}.
        </div>
      </div>
    </div>
  )
}
