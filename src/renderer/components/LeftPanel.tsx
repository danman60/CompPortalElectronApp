import React from 'react'
import { useStore } from '../store/useStore'
import PreviewPanel from './PreviewPanel'
import CurrentRoutine from './CurrentRoutine'
import AudioMeters from './AudioMeters'
import Controls from './Controls'
import '../styles/leftpanel.css'

export default function LeftPanel(): React.ReactElement {
  const compactMode = useStore((s) => s.compactMode)

  return (
    <div className={`left-panel${compactMode ? ' compact' : ''}`}>
      {!compactMode && <PreviewPanel />}
      {!compactMode && <AudioMeters />}
      <CurrentRoutine />
      <Controls />
    </div>
  )
}
