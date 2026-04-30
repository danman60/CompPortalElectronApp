import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import type { Competition, Routine } from '../../shared/types'
import { requestReassign } from './ReassignPopover'
import '../styles/controls.css'

// Operator-spec 2026-04-25: Next button on the CSE app should flash when a
// recording goes past 2:00, mirroring the Stream Deck NEXT key flash so the
// operator gets the same visual cue regardless of which surface they're
// glancing at. Trigger + cadence kept identical to the Stream Deck plugin
// (`streamdeck-plugin/src/actions/next-routine.ts:5-6`).
const NEXT_FLASH_TRIGGER_SEC = 120
const NEXT_FLASH_INTERVAL_MS = 250

// A41: NEXT button disabled when next event is an awards block / break, not
// another routine. Detection mirrors RoutineTable's session-divider inference
// (15-min idle-gap threshold, see RoutineTable.tsx:329 SESSION_GAP_MIN).
// Cross-day jumps are always treated as a block.
const AWARDS_BLOCK_GAP_MIN = 15

function isNextEventAwardsBlock(competition: Competition | null, current: Routine | null): boolean {
  if (!competition || !current) return false
  const visible = competition.routines.filter((r) => r.status !== 'scratched' && r.status !== 'skipped')
  const idx = visible.findIndex((r) => r.id === current.id)
  if (idx < 0 || idx >= visible.length - 1) return false
  const next = visible[idx + 1]
  if (current.scheduledDay && next.scheduledDay && current.scheduledDay !== next.scheduledDay) return true
  if (!current.scheduledTime || !next.scheduledTime) return false
  const [ch, cm] = current.scheduledTime.split(':').map(Number)
  const [nh, nm] = next.scheduledTime.split(':').map(Number)
  const currentEndMin = ch * 60 + (cm || 0) + (current.durationMinutes || 3)
  const nextStartMin = nh * 60 + (nm || 0)
  let gap = nextStartMin - currentEndMin
  if (gap < -12 * 60) gap += 24 * 60
  return gap >= AWARDS_BLOCK_GAP_MIN
}

export default function Controls(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const settings = useStore((s) => s.settings)
  const currentRoutine = useStore((s) => s.currentRoutine)
  const competition = useStore((s) => s.competition)

  const isConnected = obsState.connectionStatus === 'connected'
  const isRecording = obsState.isRecording

  // Next-button flash state: alternates every NEXT_FLASH_INTERVAL_MS once
  // recording crosses NEXT_FLASH_TRIGGER_SEC, stops when recording ends.
  const recordTimeSec = obsState.recordTimeSec ?? 0
  const shouldFlash = isRecording && recordTimeSec >= NEXT_FLASH_TRIGGER_SEC
  const [flashAltPhase, setFlashAltPhase] = useState(false)
  useEffect(() => {
    if (!shouldFlash) {
      setFlashAltPhase(false)
      return
    }
    const t = setInterval(() => setFlashAltPhase((p) => !p), NEXT_FLASH_INTERVAL_MS)
    return () => clearInterval(t)
  }, [shouldFlash])

  async function handlePrev(): Promise<void> {
    try { await window.api.recordingPrev() } catch { /* handled server-side */ }
  }

  async function handleToggleRecord(): Promise<void> {
    if (!isConnected) return
    try {
      if (isRecording) {
        await window.api.obsStopRecord()
      } else {
        await window.api.obsStartRecord()
      }
    } catch { /* handled server-side */ }
  }

  async function handleNextFull(): Promise<void> {
    try { await window.api.recordingNextFull() } catch { /* handled server-side */ }
  }

  async function handleToggleStream(): Promise<void> {
    if (!isConnected) return
    try {
      if (obsState.isStreaming) {
        await window.api.obsStopStream()
      } else {
        await window.api.obsStartStream()
      }
    } catch { /* handled server-side */ }
  }

  async function handleSaveReplay(): Promise<void> {
    if (!isConnected) return
    try { await window.api.obsSaveReplay() } catch { /* handled server-side */ }
  }

  async function handleScratch(): Promise<void> {
    if (currentRoutine) {
      try {
        if (currentRoutine.status === 'scratched') {
          await window.api.recordingUnscratch(currentRoutine.id)
        } else {
          await window.api.recordingScratch(currentRoutine.id)
        }
      } catch { /* handled server-side */ }
    }
  }

  // Late-insert / off-schedule routine (operator-spec 2026-04-25). Inserts
  // a new ad-hoc routine right after current, then starts OBS recording —
  // captures the off-schedule performance into its own slot instead of
  // contaminating an adjacent scheduled routine. Operator fills title/etc
  // post-show. Per-row scratch button in RoutineTable still handles the
  // scratch case.
  async function handleStartEmpty(): Promise<void> {
    if (!isConnected) return
    // Item 17 / A54: while a recording is active, clicking SAVE AS EMPTY
    // ROUTINE opens a number-input popover to bind the in-flight take to a
    // typed slot (e.g., "226.5" or "355"). Pre-recording behavior unchanged
    // (insertLateRoutine + start record).
    if (isRecording) {
      requestReassign({ kind: 'empty' })
      return
    }
    try { await (window.api as any).recordingStartEmpty?.() } catch { /* handled server-side */ }
  }

  function handleClockSync(): void {
    window.dispatchEvent(new Event('compsync:show-clock-sync'))
  }

  const hotkeys = settings?.hotkeys
  const isAwardsNext = isNextEventAwardsBlock(competition, currentRoutine)

  const primaryBtn = (
    <button
      className={`ctrl-btn record-cta${isConnected ? '' : ' disabled'}${isRecording ? ' is-recording' : ''}`}
      onClick={handleToggleRecord}
      disabled={!isConnected}
    >
      {isRecording ? 'STOP RECORDING' : 'RECORD'}
      <span className="hotkey-hint">{hotkeys?.toggleRecording || 'F5'}</span>
    </button>
  )

  return (
    <div className="section controls-section">
      {primaryBtn}
      <div className="control-row">
        <button className="ctrl-btn" onClick={handlePrev}>
          Prev
        </button>
        <button
          className={`ctrl-btn record ${isRecording ? 'is-recording' : ''}`}
          onClick={handleToggleRecord}
          disabled={!isConnected}
        >
          {isRecording ? 'Stop Rec' : 'Record'}
          <span className="hotkey-hint">{hotkeys?.toggleRecording || 'F5'}</span>
        </button>
        <button
          className={`ctrl-btn${isRecording && !isAwardsNext ? '' : ' disabled-muted'}${shouldFlash && flashAltPhase && !isAwardsNext ? ' next-flash-alert' : ''}${shouldFlash && !isAwardsNext ? ' next-flash-base' : ''}`}
          onClick={isRecording && !isAwardsNext ? handleNextFull : undefined}
          disabled={!isRecording || isAwardsNext}
          title={
            !isRecording ? 'Start recording first' :
            isAwardsNext ? 'Next event is an awards / break block — stop manually, then resume after the break' :
            (shouldFlash ? '2:00+ — time to advance' : 'Stop, advance, record, fire LT')
          }
        >
          Next
        </button>
      </div>
      <div className="control-row">
        <button
          className={`ctrl-btn stream ${obsState.isStreaming ? 'is-live' : ''}`}
          onClick={handleToggleStream}
          disabled={!isConnected}
        >
          {obsState.isStreaming ? (
            <>
              <span className="live-dot" /> LIVE
            </>
          ) : (
            'Start Stream'
          )}
        </button>
        <button
          className="ctrl-btn"
          onClick={handleSaveReplay}
          disabled={!isConnected}
          style={{ color: 'var(--warning)' }}
        >
          Save Replay
        </button>
        <button
          className="ctrl-btn"
          onClick={handleStartEmpty}
          disabled={!isConnected}
          title={
            isRecording
              ? 'Save the active recording into a typed empty-routine slot (e.g., 226.5).'
              : 'Insert an off-schedule routine slot and start recording. Operator fills in title/dancer post-show.'
          }
          style={{
            background: 'rgba(63, 168, 108, 0.18)',
            border: '1px solid rgba(63, 168, 108, 0.7)',
            color: '#9ce5b4',
            fontWeight: 700,
            opacity: !isConnected ? 0.4 : 1,
          }}
        >
          {isRecording ? 'SAVE AS EMPTY ROUTINE' : 'START EMPTY ROUTINE'}</button>
        <button className="ctrl-btn" onClick={handleClockSync}>
          Clock Sync
        </button>
        {/* Old SCRATCH path retained for hotkey + legacy invocations.
            Per-row scratch button in RoutineTable still handles in-table use. */}
        <button className="ctrl-btn" onClick={handleScratch} style={{ display: 'none' }}>
          {currentRoutine?.status === 'scratched' ? 'Unscratch' : 'Scratch'}
        </button>
      </div>
    </div>
  )
}
