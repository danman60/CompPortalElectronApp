import React from 'react'
import { useStore } from '../store/useStore'
import '../styles/controls.css'

export default function Controls(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const settings = useStore((s) => s.settings)
  const currentRoutine = useStore((s) => s.currentRoutine)

  async function handlePrev(): Promise<void> {
    await window.api.recordingPrev()
  }

  async function handleToggleRecord(): Promise<void> {
    if (obsState.isRecording) {
      await window.api.obsStopRecord()
    } else {
      await window.api.obsStartRecord()
    }
  }

  async function handleNext(): Promise<void> {
    await window.api.recordingNext()
  }

  async function handleToggleStream(): Promise<void> {
    if (obsState.isStreaming) {
      await window.api.obsStopStream()
    } else {
      await window.api.obsStartStream()
    }
  }

  async function handleSaveReplay(): Promise<void> {
    await window.api.obsSaveReplay()
  }

  async function handleSkip(): Promise<void> {
    if (currentRoutine) {
      await window.api.recordingSkip(currentRoutine.id)
    }
  }

  const hotkeys = settings?.hotkeys

  return (
    <div className="section controls-section">
      <div className="control-row">
        <button className="ctrl-btn" onClick={handlePrev}>
          Prev
        </button>
        <button
          className={`ctrl-btn record ${obsState.isRecording ? 'is-recording' : ''}`}
          onClick={handleToggleRecord}
        >
          {obsState.isRecording ? 'Stop Rec' : 'Record'}
          <span className="hotkey-hint">{hotkeys?.toggleRecording || 'F5'}</span>
        </button>
        <button className="ctrl-btn primary" onClick={handleNext}>
          Next
          <span className="hotkey-hint">{hotkeys?.nextRoutine || 'F6'}</span>
        </button>
      </div>
      <div className="control-row">
        <button
          className={`ctrl-btn stream ${obsState.isStreaming ? 'is-live' : ''}`}
          onClick={handleToggleStream}
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
