import React from 'react'
import { useStore } from '../store/useStore'
import CurrentRoutine from './CurrentRoutine'
import Controls from './Controls'
import OverlayControls, { OverlayModules } from './OverlayControls'
import TetherStatus from './TetherStatus'
import VerticalMeters from './VerticalMeters'
import '../styles/leftpanel.css'

export default function LeftPanel(): React.ReactElement {
  const compactMode = useStore((s) => s.compactMode)
  return (
    <div className={`left-panel${compactMode ? ' compact' : ''}`}>
      {!compactMode && (
        <div className="left-panel-top">
          <div className="left-panel-top-col current-routine-col">
            <CurrentRoutine />
          </div>
          <div className="left-panel-top-col record-col">
            <Controls />
          </div>
          <div className="left-panel-top-meters">
            <VerticalMeters />
          </div>
        </div>
      )}
      {!compactMode && (
        <div className="left-panel-controls">
          <div className="left-panel-col">
            <OverlayModules />
            <div style={{ flex: 1 }} />
            <TetherStatus />
          </div>
          <div className="left-panel-col">
            <OverlayControls />
          </div>
        </div>
      )}
      {compactMode && (
        <>
          <CurrentRoutine />
          <Controls />
        </>
      )}
    </div>
  )
}
