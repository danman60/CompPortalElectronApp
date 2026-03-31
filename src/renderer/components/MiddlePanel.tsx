import React from 'react'
import { useStore } from '../store/useStore'
import OverlayControls from './OverlayControls'
import '../styles/middlepanel.css'

export default function MiddlePanel(): React.ReactElement {
  const compactMode = useStore((s) => s.compactMode)
  return (
    <div className={`middle-panel${compactMode ? ' compact' : ''}`}>
      <OverlayControls compact={compactMode} />
    </div>
  )
}
