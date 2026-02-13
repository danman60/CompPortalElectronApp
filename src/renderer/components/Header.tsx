import React, { useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'
import LoadCompetition from './LoadCompetition'
import '../styles/header.css'

export default function Header(): React.ReactElement {
  const obsState = useStore((s) => s.obsState)
  const settings = useStore((s) => s.settings)
  const encodingCount = useStore((s) => s.encodingCount)
  const uploadingCount = useStore((s) => s.uploadingCount)
  const loadCompOpen = useStore((s) => s.loadCompOpen)
  const setLoadCompOpen = useStore((s) => s.setLoadCompOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setLoadCompOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [setLoadCompOpen])

  const obsDotClass =
    obsState.connectionStatus === 'connected'
      ? 'dot small connected'
      : obsState.connectionStatus === 'error'
        ? 'dot small error'
        : 'dot small'

  async function handleProcessVideo(): Promise<void> {
    await window.api.ffmpegEncodeAll()
  }

  async function handleImportPhotos(): Promise<void> {
    const folder = await window.api.photosBrowse()
    if (folder) {
      await window.api.photosImport(folder)
    }
  }

  return (
    <div className="app-header">
      <div className="app-logo">
        <span
          className={
            obsState.isRecording ? 'dot recording' : obsState.connectionStatus === 'connected' ? 'dot connected' : 'dot'
          }
        />
        CompSync Media
      </div>
      <div className="header-right">
        <div className="header-status">
          <span className="si">
            <span className={obsDotClass} /> OBS
          </span>
          <span className="si">
            <span className={settings?.compsync.pluginApiKey ? 'dot small connected' : 'dot small'} /> API
          </span>
          {encodingCount > 0 && (
            <span className="si">
              <span className="dot small" style={{ background: 'var(--warning)' }} /> {encodingCount} encoding
            </span>
          )}
          {uploadingCount > 0 && (
            <span className="si">
              <span className="dot small" style={{ background: 'var(--upload-blue)' }} /> {uploadingCount} uploading
            </span>
          )}
        </div>
        <div style={{ position: 'relative' }} ref={popoverRef}>
          <button
            className="load-comp-btn"
            onClick={() => setLoadCompOpen(!loadCompOpen)}
          >
            Load Comp
          </button>
          {loadCompOpen && <LoadCompetition />}
        </div>
        <button className="action-btn primary" onClick={handleProcessVideo}>
          Process Video
        </button>
        <button className="action-btn photos" onClick={handleImportPhotos}>
          Import Photos
        </button>
        <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </div>
    </div>
  )
}
