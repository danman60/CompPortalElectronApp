import React from 'react'
import OverlayControls, { OverlayModules } from './OverlayControls'
import '../styles/show-rail.css'

export default function ShowControlRail(): React.ReactElement {
  return (
    <aside className="show-rail">
      <div className="show-rail-scroll">
        <div className="show-rail-section">
          <div className="show-rail-title">Show Modules</div>
          <OverlayModules />
        </div>

        <div className="show-rail-section">
          <div className="show-rail-title">Overlay & Lower Third</div>
          <OverlayControls />
        </div>
      </div>
    </aside>
  )
}
