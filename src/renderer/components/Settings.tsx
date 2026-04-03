import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import type { AppSettings } from '../../shared/types'
import '../styles/settings.css'

// --- Hotkey Capture Component ---
function HotkeyInput({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}): React.ReactElement {
  const [capturing, setCapturing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!capturing) return
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }

      const parts: string[] = []
      // Enforce SHIFT-CONTROL order
      if (e.shiftKey) parts.push('Shift')
      if (e.ctrlKey) parts.push('Control')
      if (e.altKey) parts.push('Alt')

      const key = e.key
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
        if (key.length === 1) {
          parts.push(key.toUpperCase())
        } else {
          parts.push(key)
        }
        const accelerator = parts.join('+')
        onChange(accelerator)
        setCapturing(false)
      }
    },
    [capturing, onChange],
  )

  // Format display to show Shift+Control+Key
  const displayValue = value
    .replace(/Ctrl\+Shift/g, 'Shift+Control')
    .replace(/Control\+Shift/g, 'Shift+Control')

  return (
    <input
      ref={inputRef}
      type="text"
      className={`hotkey-input ${capturing ? 'capturing' : ''}`}
      value={capturing ? 'Press a key...' : displayValue}
      readOnly
      onFocus={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={handleKeyDown}
      style={{ width: '140px', cursor: 'pointer', textAlign: 'center' }}
    />
  )
}

export default function Settings(): React.ReactElement {
  const currentSettings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [obsInputs, setObsInputs] = useState<string[]>([])
  const [namingPreview, setNamingPreview] = useState('')
  const [diagCopied, setDiagCopied] = useState(false)
  const [overlayCopied, setOverlayCopied] = useState(false)

  useEffect(() => {
    if (currentSettings) {
      setDraft({ ...currentSettings })
      updatePreview(currentSettings.fileNaming.pattern)
    }
    window.api?.obsGetInputList().then(setObsInputs).catch(() => {})
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

    if (currentSettings && draft.behavior.alwaysOnTop !== currentSettings.behavior.alwaysOnTop) {
      await window.api.toggleAlwaysOnTop(draft.behavior.alwaysOnTop)
    }

    setSettingsOpen(false)
  }

  function getRoleToTrack(): Record<string, string> {
    if (!draft) return {}
    const result: Record<string, string> = {}
    for (const [track, role] of Object.entries(draft.audioTrackMapping)) {
      if (role && role !== 'unused') {
        result[role] = track
      }
    }
    return result
  }

  function setRoleTrack(role: string, track: string): void {
    if (!draft) return
    const newMapping = { ...draft.audioTrackMapping }
    for (const [k, v] of Object.entries(newMapping)) {
      if (v === role) newMapping[k] = 'unused'
    }
    if (track) newMapping[track] = role
    setDraft({ ...draft, audioTrackMapping: newMapping })
  }

  if (!draft) return <div />

  const judgeCount = draft.competition.judgeCount
  const roles = ['performance', ...Array.from({ length: judgeCount }, (_, i) => `judge${i + 1}`)]
  const roleToTrack = getRoleToTrack()
  const trackOptions = Array.from({ length: 6 }, (_, i) => `track${i + 1}`)

  return (
    <div className="settings-overlay">
      <div className="settings-header">
        <button className="back-btn" onClick={() => setSettingsOpen(false)}>
          Back
        </button>
        <h2>Settings</h2>
      </div>

      <div className="settings-body">
        {/* Competition Setup - FIRST */}
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
              <span className="hint">Controls audio tracks, meters, and FFmpeg outputs</span>
            </div>
          </div>
        </div>

        {/* Audio Configuration - SECOND */}
        <div className="settings-section">
          <div className="settings-section-title">Audio Configuration</div>
          <p className="section-desc">
            For each role, assign the OBS audio source (for live meters) and the recording track number (for FFmpeg splitting).
          </p>
          <div className="audio-config-grid">
            <span className="audio-config-header">Role</span>
            <span className="audio-config-header">OBS Source (meters)</span>
            <span className="audio-config-header">Recording Track (FFmpeg)</span>
            {roles.map((role) => (
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
                <select
                  value={roleToTrack[role] || ''}
                  onChange={(e) => setRoleTrack(role, e.target.value)}
                >
                  <option value="">None</option>
                  {trackOptions.map((t) => (
                    <option key={t} value={t}>Track {t.replace('track', '')}</option>
                  ))}
                </select>
              </React.Fragment>
            ))}
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

        {/* FFmpeg - without path option */}
        <div className="settings-section">
          <div className="settings-section-title">FFmpeg Processing</div>
          <div className="settings-grid">
            <div className="field">
              <label>Processing Mode</label>
              <select
                value={draft.ffmpeg.processingMode}
                onChange={(e) => update('ffmpeg', { processingMode: e.target.value as 'copy' | 'smart' | '720p' | '1080p' })}
              >
                <option value="copy">Stream copy (fast, large files)</option>
                <option value="smart">Smart encode (recommended — smaller files)</option>
                <option value="720p">Re-encode to 720p (smallest, slow)</option>
                <option value="1080p">Re-encode to 1080p (small, slow)</option>
              </select>
            </div>
            <div className="field">
              <label>Judge Video Resolution</label>
              <select
                value={draft.ffmpeg.judgeResolution || 'same'}
                onChange={(e) => update('ffmpeg', { judgeResolution: e.target.value as 'same' | '720p' | '480p' })}
              >
                <option value="same">Same as performance</option>
                <option value="720p">720p (smaller files, faster upload)</option>
                <option value="480p">480p (smallest — audio is what matters)</option>
              </select>
              <span className="hint">Lower resolution judge tracks upload faster. Audio quality is unchanged.</span>
            </div>
            <div className="field">
              <label>Hardware Encoding (NVENC)</label>
              <div className="toggle-row" style={{ padding: 0, border: 'none' }}>
                <div>
                  <div className="toggle-label">Use NVIDIA GPU for encoding</div>
                  <div className="toggle-desc">Much faster encoding with minimal CPU load. Requires NVIDIA GPU.</div>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={draft.ffmpeg.useHardwareEncoding ?? false}
                    onChange={(e) => update('ffmpeg', { useHardwareEncoding: e.target.checked })}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
            <div className="field">
              <label>CPU Priority</label>
              <select
                value={draft.ffmpeg.cpuPriority}
                onChange={(e) => update('ffmpeg', { cpuPriority: e.target.value as 'normal' | 'below-normal' | 'idle' })}
              >
                <option value="normal">Normal (full speed)</option>
                <option value="below-normal">Below Normal (recommended — OBS gets priority)</option>
                <option value="idle">Idle (slowest — minimal impact on OBS)</option>
              </select>
              <span className="hint">Lower priority prevents FFmpeg from affecting OBS/streaming performance.</span>
            </div>
          </div>
        </div>

        {/* OBS Connection - LOWER in menu */}
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
              <span className="hint">Applied to OBS on save (Simple output mode)</span>
            </div>
            <div className="field">
              <label>Max Recording Minutes</label>
              <input
                type="number"
                min={0}
                max={180}
                value={draft.obs.maxRecordMinutes}
                onChange={(e) => update('obs', { maxRecordMinutes: parseInt(e.target.value) || 0 })}
              />
              <span className="hint">Auto-stop after N minutes (0 = no limit). Increase for awards/long sets.</span>
            </div>
          </div>
        </div>

        {/* Overlay Browser Source */}
        <div className="settings-section">
          <div className="settings-section-title">Overlay</div>
          <div className="settings-grid single">
            <div className="field">
              <label>Browser Source URL</label>
              <div className="field-row">
                <input
                  type="text"
                  value="http://localhost:9876/overlay"
                  readOnly
                  style={{ flex: 1, opacity: 0.85 }}
                />
                <button
                  className="back-btn"
                  onClick={() => {
                    navigator.clipboard.writeText('http://localhost:9876/overlay')
                    setOverlayCopied(true)
                    setTimeout(() => setOverlayCopied(false), 2000)
                  }}
                >
                  {overlayCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <span className="hint">Add this as a Browser Source in OBS (1920×1080). Controls lower third, counter, clock, and logo.</span>
            </div>
          </div>
        </div>

        {/* Global Hotkeys */}
        <div className="settings-section">
          <div className="settings-section-title">Global Hotkeys</div>
          <p className="section-desc">Click a field and press Shift+Control+[key]. Works even when the app is not focused.</p>
          <div className="settings-grid">
            <div className="field">
              <label>Start / Stop Recording</label>
              <HotkeyInput
                value={draft.hotkeys.toggleRecording}
                onChange={(v) => update('hotkeys', { toggleRecording: v })}
              />
            </div>
            <div className="field">
              <label>Next Routine</label>
              <HotkeyInput
                value={draft.hotkeys.nextRoutine}
                onChange={(v) => update('hotkeys', { nextRoutine: v })}
              />
            </div>
            <div className="field">
              <label>Fire Lower Third</label>
              <HotkeyInput
                value={draft.hotkeys.fireLowerThird}
                onChange={(v) => update('hotkeys', { fireLowerThird: v })}
              />
            </div>
            <div className="field">
              <label>Save Replay</label>
              <HotkeyInput
                value={draft.hotkeys.saveReplay}
                onChange={(v) => update('hotkeys', { saveReplay: v })}
              />
            </div>
          </div>
        </div>

        {/* Next Sequence */}
        <div className="settings-section">
          <div className="settings-section-title">Next Sequence</div>
          <p className="section-desc">Configure what happens when you press the NEXT button during a show.</p>
          {[
            { key: 'stopRecording', label: 'Stop current recording', desc: 'Stop OBS recording before advancing to next routine' },
            { key: 'startRecording', label: 'Start recording', desc: 'Automatically start recording on the new routine' },
            { key: 'fireLowerThird', label: 'Fire lower third', desc: 'Show the lower third overlay after advancing' },
          ].map(({ key, label, desc }) => (
            <div className="toggle-row" key={key}>
              <div>
                <div className="toggle-label">{label}</div>
                <div className="toggle-desc">{desc}</div>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={draft.nextSequence[key as keyof typeof draft.nextSequence] as boolean}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      nextSequence: { ...draft.nextSequence, [key]: e.target.checked },
                    })
                  }
                />
                <span className="toggle-slider" />
              </label>
            </div>
          ))}
          <div className="settings-grid">
            <div className="field">
              <label>Pause after stop (seconds)</label>
              <input
                type="number"
                min={0}
                max={10}
                step={0.5}
                value={(draft.nextSequence.pauseAfterStopMs / 1000)}
                onChange={(e) => update('nextSequence', { pauseAfterStopMs: Math.round(parseFloat(e.target.value || '0') * 1000) })}
              />
              <span className="hint">Wait time after stopping the current recording before advancing</span>
            </div>
            <div className="field">
              <label>Pause before record (seconds)</label>
              <input
                type="number"
                min={0}
                max={10}
                step={0.5}
                value={(draft.nextSequence.pauseBeforeRecordMs / 1000)}
                onChange={(e) => update('nextSequence', { pauseBeforeRecordMs: Math.round(parseFloat(e.target.value || '0') * 1000) })}
              />
              <span className="hint">Wait time after advancing before starting the new recording</span>
            </div>
            <div className="field">
              <label>Pause before lower third (seconds)</label>
              <input
                type="number"
                min={0}
                max={10}
                step={0.5}
                value={(draft.nextSequence.pauseBeforeLowerThirdMs / 1000)}
                onChange={(e) => update('nextSequence', { pauseBeforeLowerThirdMs: Math.round(parseFloat(e.target.value || '0') * 1000) })}
              />
              <span className="hint">Wait time before firing the lower third</span>
            </div>
          </div>
        </div>

        {/* Photo Tether */}
        <div className="settings-section">
          <div className="settings-section-title">Photo Tether</div>
          <p className="section-desc">
            Watch a folder for new photos (e.g., Lumix Tether output). Photos are matched to routines by capture time and auto-uploaded.
          </p>
          <div className="settings-grid single">
            <div className="field">
              <label>Auto-Watch Folder</label>
              <div className="field-row">
                <input
                  type="text"
                  value={draft.tether?.autoWatchFolder || ''}
                  onChange={(e) => update('tether', { autoWatchFolder: e.target.value })}
                  placeholder="e.g., C:\Users\User\Pictures\Lumix Tether"
                  style={{ flex: 1 }}
                />
                <button
                  className="back-btn"
                  onClick={async () => {
                    const dir = await window.api.settingsBrowseDir()
                    if (dir) update('tether', { autoWatchFolder: dir })
                  }}
                >
                  Browse...
                </button>
              </div>
              <span className="hint">
                Set this to your tethering software's output folder. The app will automatically watch for new photos on startup.
                Leave empty to disable auto-watch.
              </span>
            </div>
          </div>
        </div>

        {/* Behavior Toggles */}
        <div className="settings-section">
          <div className="settings-section-title">Behavior</div>
          {[
            { key: 'autoUploadAfterEncoding', label: 'Auto-upload after processing', desc: 'Queue uploads immediately after FFmpeg completes' },
            { key: 'autoEncodeRecordings', label: 'Auto-process recordings', desc: 'Run FFmpeg track split automatically after each recording' },
            { key: 'syncLowerThird', label: 'Sync lower third overlay', desc: 'Update overlay data when advancing routines' },
            { key: 'confirmBeforeOverwrite', label: 'Archive before re-record', desc: 'Move existing files to _archive folder when re-recording a routine' },
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
        <button
          className="back-btn"
          onClick={async () => {
            await window.api?.copyDiagnostics()
            setDiagCopied(true)
            setTimeout(() => setDiagCopied(false), 3000)
          }}
          style={{ marginRight: 'auto' }}
        >
          {diagCopied ? 'Copied to clipboard!' : 'Copy Diagnostics'}
        </button>
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
