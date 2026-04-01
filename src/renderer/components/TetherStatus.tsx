import React from 'react'
import { useStore } from '../store/useStore'
import '../styles/tether-status.css'

export default function TetherStatus(): React.ReactElement | null {
  const tetherState = useStore((s) => s.tetherState)

  if (!tetherState.active) return null

  const offsetSec = (tetherState.cameraClockOffset / 1000).toFixed(1)
  const sign = tetherState.cameraClockOffset >= 0 ? '+' : ''

  let syncLabel: string
  let syncClass: string
  switch (tetherState.clockSyncStatus) {
    case 'ok':
      syncLabel = 'SYNC OK'
      syncClass = 'tether-sync-ok'
      break
    case 'warning':
      syncLabel = `CLOCK ${sign}${offsetSec}s`
      syncClass = 'tether-sync-warning'
      break
    case 'error':
      syncLabel = `CLOCK ${sign}${offsetSec}s`
      syncClass = 'tether-sync-error'
      break
    default:
      syncLabel = 'SYNC ...'
      syncClass = 'tether-sync-unknown'
  }

  function handleStop(): void {
    window.api.tetherStop()
  }

  return (
    <div className="tether-status">
      <span className="tether-icon">{'\u{1F4F7}'}</span>
      <span className="tether-label">
        TETHERED {tetherState.source === 'wpd-mtp' ? 'MTP' : 'USB'}
      </span>
      {tetherState.deviceName && (
        <span className="tether-last" title={tetherState.deviceName}>
          {tetherState.deviceName}
        </span>
      )}
      <span className="tether-count">{tetherState.photosReceived} photos</span>
      <span className={`tether-sync ${syncClass}`}>{syncLabel}</span>
      {tetherState.lastPhotoTime && (
        <span className="tether-last" title={tetherState.lastPhotoTime}>
          Last: {new Date(tetherState.lastPhotoTime).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
          })}
        </span>
      )}
      <button className="tether-stop-btn" onClick={handleStop} title="Stop tethered watching">
        Stop
      </button>
    </div>
  )
}
