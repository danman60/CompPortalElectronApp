import React from 'react'
import { useStore } from '../store/useStore'
import OverlayControls, { OverlayModules, OverlayLayerToggles, InlineChatStrip, GraphicsSection } from './OverlayControls'
import VerticalMeters from './VerticalMeters'
import '../styles/show-rail.css'

export default function ShowControlRail(): React.ReactElement {
  const currentRoutine = useStore((s) => s.currentRoutine)
  return (
    <aside className="show-rail">
      <div className="show-rail-scroll">
        <div className="show-rail-section meter-card">
          <VerticalMeters />
        </div>

        <div className="show-rail-section graphics-card">
          <div className="show-rail-title">Graphics</div>

          <div className="graphics-sub graphics-feature-row">
            <GraphicsSection currentRoutineExists={!!currentRoutine} />
            <OverlayControls noChat hideFeatureCards hideAnimConfig />
          </div>

          <div className="graphics-sub">
            <OverlayModules />
            <OverlayLayerToggles />
          </div>
        </div>

        {/* Chat is its OWN section with a hard min-height so it can't be
            crushed by the graphics card above. Operator complaint
            2026-05-15: previous in-card chat got squeezed to a single row
            because flex math gave it leftover space, not reserved. */}
        <div className="show-rail-section chat-card">
          <InlineChatStrip />
        </div>
      </div>
    </aside>
  )
}
