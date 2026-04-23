import React from 'react'
import PanelChrome from './PanelChrome'
import ErrorBoundary from './ErrorBoundary'
import CurrentRoutine from './CurrentRoutine'
import Controls from './Controls'
import PreviousRoutines from './PreviousRoutines'
import NextRoutines from './NextRoutines'
import SystemStats from './SystemStats'
import OverlayControls from './OverlayControls'
import PanelChat from './PanelChat'

interface PanelAppProps {
  panelId: string
}

const TITLES: Record<string, string> = {
  currentRoutine: 'Current Routine',
  controls: 'Record Controls',
  previousRoutines: 'Previous Routines',
  nextRoutines: 'Next Routines',
  systemStats: 'System',
  overlays: 'Overlays & Lower Third',
  chat: 'Chat',
}

export default function PanelApp({ panelId }: PanelAppProps): React.ReactElement {
  const title = TITLES[panelId] ?? 'Panel'

  // Per spec: only SystemStats panel carries the Exit Overlay button.
  const showExit = panelId === 'systemStats'

  let content: React.ReactElement
  switch (panelId) {
    case 'currentRoutine':
      content = <CurrentRoutine />
      break
    case 'controls':
      content = <Controls />
      break
    case 'previousRoutines':
      content = <PreviousRoutines />
      break
    case 'nextRoutines':
      content = <NextRoutines />
      break
    case 'systemStats':
      content = <SystemStats />
      break
    case 'overlays':
      content = <OverlayControls compact={true} />
      break
    case 'chat':
      content = <PanelChat />
      break
    default:
      content = <div style={{ padding: 12, color: '#888' }}>Unknown panel: {panelId}</div>
  }

  const closeOverlay = (): void => {
    try { void window.api.overlayModeClose() } catch {}
  }

  return (
    <PanelChrome title={title} panelId={panelId} showExit={showExit}>
      <ErrorBoundary compact onClose={closeOverlay}>
        {content}
      </ErrorBoundary>
    </PanelChrome>
  )
}
