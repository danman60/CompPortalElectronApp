import React, { useEffect, useState } from 'react'

interface StreamDeckStatus {
  streamDeckInstalled: boolean
  pluginsDir: string | null
  pluginInstalled: boolean
  bundledAvailable: boolean
  bundledPluginJsMtime: string | null
  installedPluginJsMtime: string | null
}

declare global {
  interface Window {
    api: {
      streamdeckGetStatus: () => Promise<StreamDeckStatus>
      streamdeckInstallPlugin: () => Promise<{ ok: true; filesCopied: number; target: string } | { error: string }>
      [k: string]: unknown
    }
  }
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch { return iso }
}

export default function StreamDeckPluginSection(): React.ReactElement {
  const [status, setStatus] = useState<StreamDeckStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function refresh(): Promise<void> {
    try {
      const s = await window.api.streamdeckGetStatus()
      setStatus(s)
    } catch {
      setStatus(null)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function install(): Promise<void> {
    setInstalling(true)
    setMsg(null)
    const result = await window.api.streamdeckInstallPlugin()
    if ('error' in result) {
      setMsg({ ok: false, text: result.error })
    } else {
      setMsg({ ok: true, text: `Installed ${result.filesCopied} files. Restart Stream Deck to see the new actions.` })
    }
    setInstalling(false)
    await refresh()
  }

  if (!status) {
    return (
      <div className="settings-section">
        <div className="settings-section-title">Stream Deck Plugin</div>
        <p className="section-desc">Loading...</p>
      </div>
    )
  }

  const bundledNewer = status.bundledPluginJsMtime && status.installedPluginJsMtime &&
    new Date(status.bundledPluginJsMtime).getTime() > new Date(status.installedPluginJsMtime).getTime() + 1000

  let stateLabel = ''
  if (!status.streamDeckInstalled) stateLabel = 'Stream Deck app is not installed'
  else if (!status.pluginInstalled) stateLabel = 'Plugin not installed'
  else if (bundledNewer) stateLabel = 'Plugin update available'
  else stateLabel = 'Plugin installed (up to date)'

  return (
    <div className="settings-section">
      <div className="settings-section-title">Stream Deck Plugin</div>
      <p className="section-desc">
        Bundled with this install. One-click copy into the Stream Deck plugins folder.
        Requires Stream Deck app to be installed. Safe to re-run to update.
      </p>

      <div className="streamdeck-status-grid">
        <div>
          <span className="streamdeck-status-label">Status</span>
          <span className={`streamdeck-status-value ${status.pluginInstalled && !bundledNewer ? 'ok' : 'warn'}`}>
            {stateLabel}
          </span>
        </div>
        <div>
          <span className="streamdeck-status-label">Plugins folder</span>
          <span className="streamdeck-status-value path">{status.pluginsDir || 'N/A (non-Windows)'}</span>
        </div>
        <div>
          <span className="streamdeck-status-label">Bundled version</span>
          <span className="streamdeck-status-value">{fmt(status.bundledPluginJsMtime)}</span>
        </div>
        <div>
          <span className="streamdeck-status-label">Installed version</span>
          <span className="streamdeck-status-value">{fmt(status.installedPluginJsMtime)}</span>
        </div>
      </div>

      {msg && (
        <div className={msg.ok ? 'streamdeck-msg-ok' : 'streamdeck-msg-err'}>
          {msg.text}
        </div>
      )}

      <div className="backup-actions">
        <button
          className="btn-save"
          onClick={install}
          disabled={installing || !status.streamDeckInstalled || !status.bundledAvailable}
        >
          {installing
            ? 'Installing...'
            : status.pluginInstalled
              ? (bundledNewer ? 'Update Plugin' : 'Reinstall Plugin')
              : 'Install Plugin'}
        </button>
      </div>
    </div>
  )
}
