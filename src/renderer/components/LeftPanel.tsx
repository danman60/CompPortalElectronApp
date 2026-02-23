import React from 'react'
import { useStore } from '../store/useStore'
import PreviewPanel from './PreviewPanel'
import CurrentRoutine from './CurrentRoutine'
import AudioMeters from './AudioMeters'
import Controls from './Controls'
import OverlayControls from './OverlayControls'
import '../styles/leftpanel.css'

export default function LeftPanel(): React.ReactElement {
  return (
    <div className="left-panel">
      <PreviewPanel />
      <CurrentRoutine />
      <AudioMeters />
      <Controls />
      <OverlayControls />
    </div>
  )
}
