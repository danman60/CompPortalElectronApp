import React from 'react'
import { useStore } from '../store/useStore'
import '../styles/controls.css'

export default function Controls(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const settings = useStore((s) => s.settings)
  const currentRoutine = useStore((s) => s.currentRoutine)

  const isConnected = obsState.connectionStatus === 'connected'

  async function handlePrev(): Promise<void> {
    try { await window.api.recordingPrev() } catch { /* handled server-side */ }
  }

  async function handleToggleRecord(): Promise<void> {
    if (!isConnected) return
    try {
      if (obsState.isRecording) {
        await window.api.obsStopRecord()
      } else {
        await window.api.obsStartRecord()
      }
    } catch { /* handled server-side */ }
  }

  async function handleNext(): Promise<void> {
    try { await window.api.recordingNext() } catch { /* handled server-side */ }
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

  async function handleSkip(): Promise<void> {
    if (currentRoutine) {
      try { await window.api.recordingSkip(currentRoutine.id) } catch { /* handled server-side */ }
    }
  }

  const hotkeys = settings?.hotkeys

  return (
    <div className="section controls-section">
      <button className="ctrl-btn next-full" onClick={handleNextFull} disabled={!isConnected}>
        NEXT
      </button>
      <div className="control-row">
        <button className="ctrl-btn" onClick={handlePrev}>
          Prev
        </button>
        <button
          className={`ctrl-btn record ${obsState.isRecording ? 'is-recording' : ''}`}
          onClick={handleToggleRecord}
          disabled={!isConnected}
        >
          {obsState.isRecording ? 'Stop Rec' : 'Record'}
          <span className="hotkey-hint">{hotkeys?.toggleRecording || 'F5'}</span>
        </button>
        <button className="ctrl-btn" onClick={handleNext}>
          Next Only
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
        <button className="ctrl-btn" onClick={handleSkip}>
          Skip
        </button>
      </div>
    </div>
  )
}
