import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

declare global {
  interface Window {
    api: {
      settingsBrowseDir: () => Promise<string | null>
      overlaySetLogo: () => Promise<string | null>
      settingsSet: (patch: unknown) => Promise<unknown>
      settingsGet: () => Promise<unknown>
      [k: string]: unknown
    }
  }
}

export default function FirstRunSetup(): React.ReactElement | null {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const [outputDir, setOutputDir] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [tetherDir, setTetherDir] = useState('')
  const [saving, setSaving] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!settings) return
    setOutputDir(settings.fileNaming?.outputDirectory || '')
    setLogoUrl(settings.overlay?.logoUrl || '')
    setTetherDir(settings.tether?.autoWatchFolder || '')
  }, [settings])

  if (!settings) return null
  if (dismissed) return null

  const missingRequired = !settings.fileNaming?.outputDirectory
  if (!missingRequired) return null

  async function browseOutput(): Promise<void> {
    const dir = await window.api.settingsBrowseDir()
    if (dir) setOutputDir(dir)
  }
  async function browseLogo(): Promise<void> {
    const url = await window.api.overlaySetLogo()
    if (url) setLogoUrl(url)
  }
  async function browseTether(): Promise<void> {
    const dir = await window.api.settingsBrowseDir()
    if (dir) setTetherDir(dir)
  }

  async function save(): Promise<void> {
    if (!outputDir) return
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {
        fileNaming: { ...(settings.fileNaming || {}), outputDirectory: outputDir },
      }
      if (logoUrl) patch.overlay = { ...(settings.overlay || {}), logoUrl }
      if (tetherDir) patch.tether = { ...(settings.tether || {}), autoWatchFolder: tetherDir }
      await window.api.settingsSet(patch)
      const fresh = await window.api.settingsGet()
      setSettings(fresh as typeof settings)
      setDismissed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="first-run-overlay">
      <div className="first-run-modal">
        <h2 className="first-run-title">Welcome to CompSync Media</h2>
        <p className="first-run-desc">
          A few paths need to point at folders on <strong>this machine</strong> before the app can record, show the overlay logo, or auto-import tether photos. You can change these later in Settings.
        </p>

        <div className="first-run-field">
          <label>Recording Output Folder <span className="first-run-required">(required)</span></label>
          <div className="first-run-row">
            <input
              type="text"
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
              placeholder="C:\Recordings or D:\ShowOutput"
            />
            <button onClick={browseOutput}>Browse...</button>
          </div>
          <div className="first-run-hint">Where OBS-generated recordings land before encoding. Must exist + be writable.</div>
        </div>

        <div className="first-run-field">
          <label>Overlay Logo Image <span className="first-run-optional">(optional)</span></label>
          <div className="first-run-row">
            <input
              type="text"
              value={logoUrl}
              readOnly
              placeholder="PNG or SVG — skip to add later"
            />
            <button onClick={browseLogo}>Browse...</button>
          </div>
          <div className="first-run-hint">Organization logo shown in the live overlay and Starting Soon scene.</div>
        </div>

        <div className="first-run-field">
          <label>Tether Photo Auto-Watch Folder <span className="first-run-optional">(optional)</span></label>
          <div className="first-run-row">
            <input
              type="text"
              value={tetherDir}
              onChange={(e) => setTetherDir(e.target.value)}
              placeholder="Folder where your camera drops photos — skip if not using tether"
            />
            <button onClick={browseTether}>Browse...</button>
          </div>
          <div className="first-run-hint">Photos dropped into this folder auto-match to the currently-recording entry.</div>
        </div>

        <div className="first-run-actions">
          <button
            className="first-run-primary"
            onClick={save}
            disabled={!outputDir || saving}
          >
            {saving ? 'Saving...' : 'Save & Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
