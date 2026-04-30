import React from 'react'
import OverlayControls, { OverlayModules, OverlayLayerToggles, InlineChatStrip } from './OverlayControls'
import '../styles/show-rail.css'

export default function ShowControlRail(): React.ReactElement {
  return (
    <aside className="show-rail">
      <div className="show-rail-scroll">
        <div className="show-rail-section graphics-card">
          <div className="show-rail-title graphics-card-title">Graphics</div>

          <div className="graphics-sub">
            <OverlayModules />
            <OverlayLayerToggles />
          </div>

          <div className="graphics-sub">
            <div className="graphics-sub-title">Overlay &amp; Lower Third</div>
            <OverlayControls noChat />
          </div>

          <div className="graphics-sub graphics-sub-chat">
            <InlineChatStrip />
          </div>
        </div>
      </div>
    </aside>
  )
}
