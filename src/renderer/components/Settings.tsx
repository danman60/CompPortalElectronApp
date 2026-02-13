import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import type { AppSettings } from '../../shared/types'
import '../styles/settings.css'

export default function Settings(): React.ReactElement {
  const currentSettings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [obsInputs, setObsInputs] = useState<string[]>([])
  const [namingPreview, setNamingPreview] = useState('')

  useEffect(() => {
    if (currentSettings) {
      setDraft({ ...currentSettings })
      updatePreview(currentSettings.fileNaming.pattern)
    }
    window.api.obsGetInputList().then(setObsInputs)
  }, [currentSettings])

  function updatePreview(pattern: string): void {
    const tokens: Record<string, string> = {
      '{entry_number}': '111',
      '{routine_title}': 'Silent_Screams',
      '{studio_code}': 'FVR',
      '{category}': 'Junior_Contemporary',
      '{date}': '2026-03-14',
      '{time}': '14-30-00',
    }
    let preview = pattern
    for (const [token, val] of Object.entries(tokens)) {
      preview = preview.replaceAll(token, val)
    }
    setNamingPreview(preview || '(empty)')
  }

  function update<K extends keyof AppSettings>(section: K, values: Partial<AppSettings[K]>): void {
    if (!draft) return
    setDraft({
      ...draft,
      [section]: { ...draft[section], ...values },
    })
  }

  async function handleSave(): Promise<void> {
    if (!draft) return
    await window.api.settingsSet(draft)
    useStore.getState().setSettings(draft)
    setSettingsOpen(false)
  }

  if (!draft) return <div />

  const judgeCount = draft.competition.judgeCount

  return (
    <div className="settings-overlay">
      <div className="settings-header">
        <button className="back-btn" onClick={() => setSettingsOpen(false)}>
          Back
        </button>
        <h2>Settings</h2>
      </div>

      <div className="settings-body">
        {/* OBS Connection */}
        <div className="settings-section">
          <div className="settings-section-title">OBS Connection</div>
          <div className="settings-grid">
            <div className="field">
              <label>WebSocket URL</label>
              <input
                type="text"
                value={draft.obs.url}
                onChange={(e) => update('obs', { url: e.target.value })}
                placeholder="ws://localhost:4455"
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={draft.obs.password}
                onChange={(e) => update('obs', { password: e.target.value })}
                placeholder="OBS WebSocket password"
              />
              <span className="hint">Set in OBS &gt; Tools &gt; WebSocket Server Settings</span>
            </div>
            <div className="field">
              <label>Recording Format</label>
              <select
                value={draft.obs.recordingFormat}
                onChange={(e) => update('obs', { recordingFormat: e.target.value as 'mkv' | 'mp4' | 'flv' })}
              >
                <option value="mkv">MKV (recommended — crash-safe)</option>
                <option value="mp4">MP4</option>
                <option value="flv">FLV</option>
              </select>
            </div>
          </div>
        </div>

        {/* CompSync Connection */}
        <div className="settings-section">
          <div className="settings-section-title">CompSync Connection</div>
          <div className="settings-grid">
            <div className="field">
              <label>Tenant</label>
              <input
                type="text"
                value={draft.compsync.tenant}
                onChange={(e) => update('compsync', { tenant: e.target.value })}
                placeholder="Tenant name or ID"
              />
            </div>
            <div className="field">
              <label>Plugin API Key</label>
              <input
                type="password"
                value={draft.compsync.pluginApiKey}
                onChange={(e) => update('compsync', { pluginApiKey: e.target.value })}
                placeholder="sk_plugin_..."
              />
              <span className="hint">Generate in CompSync &gt; Settings &gt; Integrations</span>
            </div>
          </div>
        </div>

        {/* Competition Setup */}
        <div className="settings-section">
          <div className="settings-section-title">Competition Setup</div>
          <div className="settings-grid">
            <div className="field">
              <label>Number of Judges</label>
              <select
                value={judgeCount}
                onChange={(e) => update('competition', { judgeCount: parseInt(e.target.value) })}
              >
                <option value="1">1 Judge</option>
                <option value="2">2 Judges</option>
                <option value="3">3 Judges</option>
                <option value="4">4 Judges</option>
              </select>
            </div>
            <div className="field">
              <label>Data Source</label>
              <select
                value={draft.competition.dataSource}
                onChange={(e) => update('competition', { dataSource: e.target.value as 'csv' | 'api' })}
              >
                <option value="csv">CSV File (offline)</option>
                <option value="api">CompSync API (live)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Audio Track Mapping */}
        <div className="settings-section">
          <div className="settings-section-title">Audio Track Mapping</div>
          <p className="section-desc">Maps OBS recording tracks to output files.</p>
          <div className="track-mapping">
            {Array.from({ length: judgeCount + 1 }, (_, i) => {
              const trackKey = `track${i + 1}`
              const roles = ['performance', ...Array.from({ length: judgeCount }, (_, j) => `judge${j + 1}`), 'unused']
              return (
                <React.Fragment key={i}>
                  <span className="track-label">Track {i + 1}</span>
                  <span className="arrow">&rarr;</span>
                  <select
                    value={draft.audioTrackMapping[trackKey] || ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        audioTrackMapping: { ...draft.audioTrackMapping, [trackKey]: e.target.value },
                      })
                    }
                  >
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {r === 'performance' ? 'Performance (main mix)' : r === 'unused' ? 'Unused' : `Judge ${r.replace('judge', '')}`}
                      </option>
                    ))}
                  </select>
                </React.Fragment>
              )
            })}
          </div>
        </div>

        {/* Audio Input Mapping (Meters) */}
        <div className="settings-section">
          <div className="settings-section-title">Audio Input Mapping (Meters)</div>
          <p className="section-desc">Maps OBS audio sources to meter roles.</p>
          <div className="input-mapping">
            {['performance', ...Array.from({ length: judgeCount }, (_, i) => `judge${i + 1}`)].map(
              (role) => (
                <React.Fragment key={role}>
                  <span className="role-label">
                    {role === 'performance' ? 'Performance' : `Judge ${role.replace('judge', '')}`}
                  </span>
                  <select
                    value={draft.audioInputMapping[role] || ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        audioInputMapping: { ...draft.audioInputMapping, [role]: e.target.value },
                      })
                    }
                  >
                    <option value="">Select input...</option>
                    {obsInputs.map((input) => (
                      <option key={input} value={input}>{input}</option>
                    ))}
                  </select>
                </React.Fragment>
              ),
            )}
          </div>
          <p className="section-desc" style={{ marginTop: '6px' }}>
            Input list auto-populated from OBS when connected.
          </p>
        </div>

        {/* File Naming */}
        <div className="settings-section">
          <div className="settings-section-title">File Naming</div>
          <div className="settings-grid single">
            <div className="field">
              <label>Pattern</label>
              <input
                type="text"
                value={draft.fileNaming.pattern}
                onChange={(e) => {
                  update('fileNaming', { pattern: e.target.value })
                  updatePreview(e.target.value)
                }}
              />
              <span className="hint">
                Tokens: {'{entry_number}'} {'{routine_title}'} {'{studio_code}'} {'{category}'} {'{date}'} {'{time}'}
              </span>
            </div>
            <div className="field">
              <label>Preview</label>
              <div className="naming-preview">{namingPreview}</div>
            </div>
            <div className="field">
              <label>Output Directory</label>
              <div className="field-row">
                <input
                  type="text"
                  value={draft.fileNaming.outputDirectory}
                  onChange={(e) => update('fileNaming', { outputDirectory: e.target.value })}
                  placeholder="Select output folder..."
                  style={{ flex: 1 }}
                />
                <button
                  className="back-btn"
                  onClick={async () => {
                    const dir = await window.api.settingsBrowseDir()
                    if (dir) update('fileNaming', { outputDirectory: dir })
                  }}
                >
                  Browse...
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* FFmpeg */}
        <div className="settings-section">
          <div className="settings-section-title">FFmpeg</div>
          <div className="settings-grid">
            <div className="field">
              <label>FFmpeg Path</label>
              <div className="field-row">
                <input
                  type="text"
                  value={draft.ffmpeg.path}
                  onChange={(e) => update('ffmpeg', { path: e.target.value })}
                  style={{ flex: 1 }}
                />
                <button
                  className="back-btn"
                  onClick={async () => {
                    const file = await window.api.settingsBrowseFile()
                    if (file) update('ffmpeg', { path: file })
                  }}
                >
                  Browse...
                </button>
              </div>
              <span className="hint">Uses bundled FFmpeg by default.</span>
            </div>
            <div className="field">
              <label>Processing</label>
              <select
                value={draft.ffmpeg.processingMode}
                onChange={(e) => update('ffmpeg', { processingMode: e.target.value as 'copy' | '720p' | '1080p' })}
              >
                <option value="copy">Stream copy (fast, no re-encode)</option>
                <option value="720p">Re-encode to 720p H.264</option>
                <option value="1080p">Re-encode to 1080p H.264</option>
              </select>
            </div>
          </div>
        </div>

        {/* Global Hotkeys */}
        <div className="settings-section">
          <div className="settings-section-title">Global Hotkeys</div>
          <p className="section-desc">Work even when the app is not focused.</p>
          <div className="settings-grid">
            <div className="field">
              <label>Start / Stop Recording</label>
              <input
                type="text"
                value={draft.hotkeys.toggleRecording}
                onChange={(e) => update('hotkeys', { toggleRecording: e.target.value })}
                style={{ width: '100px' }}
              />
            </div>
            <div className="field">
              <label>Next Routine</label>
              <input
                type="text"
                value={draft.hotkeys.nextRoutine}
                onChange={(e) => update('hotkeys', { nextRoutine: e.target.value })}
                style={{ width: '100px' }}
              />
            </div>
            <div className="field">
              <label>Fire Lower Third</label>
              <input
                type="text"
                value={draft.hotkeys.fireLowerThird}
                onChange={(e) => update('hotkeys', { fireLowerThird: e.target.value })}
                style={{ width: '100px' }}
              />
            </div>
            <div className="field">
              <label>Save Replay</label>
              <input
                type="text"
                value={draft.hotkeys.saveReplay}
                onChange={(e) => update('hotkeys', { saveReplay: e.target.value })}
                style={{ width: '100px' }}
              />
            </div>
          </div>
        </div>

        {/* Lower Third Overlay */}
        <div className="settings-section">
          <div className="settings-section-title">Lower Third Overlay</div>
          <div className="settings-grid">
            <div className="field">
              <label>Communication Mode</label>
              <select
                value={draft.lowerThird.mode}
                onChange={(e) => update('lowerThird', { mode: e.target.value as 'http' | 'broadcast' })}
              >
                <option value="http">Local HTTP server (port 9876)</option>
                <option value="broadcast">BroadcastChannel (same CEF only)</option>
              </select>
            </div>
            <div className="field">
              <label>Auto-hide After</label>
              <select
                value={draft.lowerThird.autoHideSeconds}
                onChange={(e) => update('lowerThird', { autoHideSeconds: parseInt(e.target.value) })}
              >
                <option value="0">Never (manual hide)</option>
                <option value="5">5 seconds</option>
                <option value="8">8 seconds</option>
                <option value="10">10 seconds</option>
                <option value="15">15 seconds</option>
              </select>
            </div>
            <div className="field">
              <label>Overlay URL</label>
              <input type="text" value={draft.lowerThird.overlayUrl} disabled style={{ opacity: 0.6 }} />
              <span className="hint">Add this as a Browser Source in OBS (1920x1080)</span>
            </div>
          </div>
        </div>

        {/* Behavior Toggles */}
        <div className="settings-section">
          <div className="settings-section-title">Behavior</div>
          {[
            { key: 'autoRecordOnNext', label: 'Auto-record on Next', desc: 'Automatically start recording when advancing to next routine' },
            { key: 'autoUploadAfterEncoding', label: 'Auto-upload after processing', desc: 'Queue uploads immediately after FFmpeg completes' },
            { key: 'autoEncodeRecordings', label: 'Auto-process recordings', desc: 'Run FFmpeg track split automatically after each recording' },
            { key: 'syncLowerThird', label: 'Sync lower third overlay', desc: 'Update overlay data when advancing routines' },
            { key: 'confirmBeforeOverwrite', label: 'Confirm before overwrite', desc: 'Ask before re-recording a routine that already has files' },
            { key: 'alwaysOnTop', label: 'Always on top', desc: 'Keep plugin window above other windows' },
          ].map(({ key, label, desc }) => (
            <div className="toggle-row" key={key}>
              <div>
                <div className="toggle-label">{label}</div>
                <div className="toggle-desc">{desc}</div>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={draft.behavior[key as keyof typeof draft.behavior] as boolean}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      behavior: { ...draft.behavior, [key]: e.target.checked },
                    })
                  }
                />
                <span className="toggle-slider" />
              </label>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-footer">
        <button className="btn-cancel" onClick={() => setSettingsOpen(false)}>
          Cancel
        </button>
        <button className="btn-save" onClick={handleSave}>
          Save Settings
        </button>
      </div>
    </div>
  )
}
