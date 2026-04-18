import React from 'react'
import PanelChrome from './PanelChrome'
import CurrentRoutine from './CurrentRoutine'
import Controls from './Controls'
import PreviousRoutines from './PreviousRoutines'
import NextRoutines from './NextRoutines'
import SystemStats from './SystemStats'

interface PanelAppProps {
  panelId: string
}

const TITLES: Record<string, string> = {
  currentRoutine: 'Current Routine',
  controls: 'Record Controls',
  previousRoutines: 'Previous Routines',
  nextRoutines: 'Next Routines',
  systemStats: 'System',
}

export default function PanelApp({ panelId }: PanelAppProps): React.ReactElement {
  const title = TITLES[panelId] ?? 'Panel'

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
    default:
      content = <div style={{ padding: 12, color: '#888' }}>Unknown panel: {panelId}</div>
  }

  return <PanelChrome title={title}>{content}</PanelChrome>
}
