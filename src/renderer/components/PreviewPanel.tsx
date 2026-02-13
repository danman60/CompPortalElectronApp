import React, { useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import '../styles/preview.css'

export default function PreviewPanel(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const previewFrame = useStore((s) => s.previewFrame)
  const previewActive = useStore((s) => s.previewActive)
  const setPreviewActive = useStore((s) => s.setPreviewActive)
  const imgRef = useRef<HTMLImageElement>(null)

  const isConnected = obsState.connectionStatus === 'connected'

  useEffect(() => {
    // Auto-start preview when OBS connects, stop when disconnects
    if (isConnected && !previewActive) {
      window.api?.previewStart(5)
      setPreviewActive(true)
    } else if (!isConnected && previewActive) {
      window.api?.previewStop()
      setPreviewActive(false)
    }
  }, [isConnected, previewActive, setPreviewActive])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (useStore.getState().previewActive) {
        window.api?.previewStop()
      }
    }
  }, [])

  function handleTogglePreview(): void {
    if (previewActive) {
      window.api?.previewStop()
      setPreviewActive(false)
    } else if (isConnected) {
      window.api?.previewStart(5)
      setPreviewActive(true)
    }
  }

  return (
    <div className="section preview-section">
      <div className="preview-header">
        <span className="section-title" style={{ marginBottom: 0 }}>
          Live Preview
        </span>
        <button
          className="preview-toggle"
          onClick={handleTogglePreview}
          disabled={!isConnected}
        >
          {previewActive ? 'Pause' : 'Resume'}
        </button>
      </div>
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
            {previewActive ? 'Waiting for frame...' : 'Preview paused'}
          </div>
        )}
        {obsState.isRecording && (
          <div className="preview-rec-badge">REC</div>
        )}
      </div>
    </div>
  )
}
