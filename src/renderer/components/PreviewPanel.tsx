import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import '../styles/preview.css'

export default function PreviewPanel(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const previewFrame = useStore((s) => s.previewFrame)
  const previewActive = useStore((s) => s.previewActive)
  const setPreviewActive = useStore((s) => s.setPreviewActive)
  const [visible, setVisible] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  const isConnected = obsState.connectionStatus === 'connected'

  useEffect(() => {
    if (visible && isConnected && !previewActive) {
      window.api?.previewStart(5)
      setPreviewActive(true)
    } else if ((!visible || !isConnected) && previewActive) {
      window.api?.previewStop()
      setPreviewActive(false)
    }
  }, [isConnected, visible, previewActive, setPreviewActive])

  useEffect(() => {
    return () => {
      if (useStore.getState().previewActive) {
        window.api?.previewStop()
      }
    }
  }, [])

  function handleToggle(): void {
    setVisible((v) => !v)
  }

  return (
    <div className="section preview-section">
      <div className="preview-header">
        <span className="section-title" style={{ marginBottom: 0 }}>
          Live Preview
        </span>
        <button
          className="preview-toggle"
          onClick={handleToggle}
          disabled={!isConnected}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      {visible && (
        <div className="preview-container">
          {!isConnected ? (
            <div className="preview-placeholder">
              OBS not connected
            </div>
          ) : previewFrame ? (
            <img
              ref={imgRef}
              className="preview-image"
              src={previewFrame}
              alt="OBS Preview"
            />
          ) : (
            <div className="preview-placeholder">
              Waiting for frame...
            </div>
          )}
          {obsState.isRecording && (
            <div className="preview-rec-badge">REC</div>
          )}
        </div>
      )}
    </div>
  )
}
