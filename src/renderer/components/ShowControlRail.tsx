import React from 'react'
import { useStore } from '../store/useStore'
import OverlayControls, { OverlayModules } from './OverlayControls'
import TetherStatus from './TetherStatus'
import { JobQueuePanel } from './RightPanel'
import '../styles/show-rail.css'

export default function ShowControlRail(): React.ReactElement {
  const tetherActive = useStore((s) => s.tetherState.active)

  return (
    <aside className="show-rail">
      <div className="show-rail-scroll">
        <div className="show-rail-section">
          <div className="show-rail-title">Overlay & Lower Third</div>
          <OverlayControls />
        </div>

        <div className="show-rail-section">
          <div className="show-rail-title">Show Modules</div>
          <OverlayModules />
        </div>

        {tetherActive && (
          <div className="show-rail-section">
            <div className="show-rail-title">Tether</div>
            <TetherStatus />
          </div>
        )}

        <div className="show-rail-section">
          <div className="show-rail-title">Job Queue</div>
          <JobQueuePanel />
        </div>
      </div>
    </aside>
  )
}
