import React from 'react'
import { useStore } from '../store/useStore'
import PreviewPanel from './PreviewPanel'
import CurrentRoutine from './CurrentRoutine'
import AudioMeters from './AudioMeters'
import Controls from './Controls'
import OverlayControls from './OverlayControls'
import '../styles/leftpanel.css'

export default function LeftPanel(): React.ReactElement {
  const compactMode = useStore((s) => s.compactMode)
  const setPhotoSorterOpen = useStore((s) => s.setPhotoSorterOpen)

  return (
    <div className={`left-panel${compactMode ? ' compact' : ''}`}>
      {!compactMode && <PreviewPanel />}
      <CurrentRoutine />
      {!compactMode && <AudioMeters />}
      <Controls />
      <OverlayControls compact={compactMode} />
      <div className="section">
        <button
          className="ps-open-btn"
          onClick={() => setPhotoSorterOpen(true)}
        >
          Sort Photos by Subject
        </button>
      </div>
    </div>
  )
}
