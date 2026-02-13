import React from 'react'
import { useStore } from '../store/useStore'
import CurrentRoutine from './CurrentRoutine'
import AudioMeters from './AudioMeters'
import Controls from './Controls'
import LowerThirdControls from './LowerThirdControls'
import '../styles/leftpanel.css'

export default function LeftPanel(): React.ReactElement {
  return (
    <div className="left-panel">
      <CurrentRoutine />
      <AudioMeters />
      <Controls />
      <LowerThirdControls />
    </div>
  )
}
