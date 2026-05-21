import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import type { AppSettings, MonitorInfo } from '../../shared/types'
import BackupMedia from './BackupMedia'
import StreamDeckPluginSection from './StreamDeckPluginSection'
import { LowerThirdAnimConfig } from './OverlayControls'
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

// 2026-05-15: section title → tab. Drives the tab bar; sections are
// show/hidden by an effect reading each .settings-section-title, so the
// 21 existing sections need zero JSX changes.
const SETTINGS_TABS: { id: string; label: string; sections: string[] }[] = [
  { id: 'general', label: 'General', sections: [
    'Competition Setup', 'Day Checklists', 'Behavior', 'Next Sequence', 'Global Hotkeys',
  ] },
  { id: 'recording', label: 'Recording', sections: [
    'OBS Connection', 'File Naming', 'Audio Configuration', 'FFmpeg Processing',
    'Performance (advanced)', 'Tablet Display',
  ] },
  { id: 'overlay', label: 'Overlay', sections: [
    'Lower Third Animation', 'Overlay', 'Branding & Socials',
  ] },
  { id: 'media', label: 'Media', sections: [
    'Upload', 'Upload Recovery', 'Automatic Sync', 'Photo Tether', 'Photo Import',
    'Backup Media',
  ] },
  { id: 'tools', label: 'Tools', sections: ['Tools', 'Stream Deck Plugin'] },
]
function tabForSection(title: string): string {
  for (const t of SETTINGS_TABS) {
    if (t.sections.some((s) => title.startsWith(s) || s.startsWith(title))) return t.id
  }
  return 'general'
}

export default function Settings(): React.ReactElement {
  const currentSettings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [activeTab, setActiveTab] = useState<string>('general')
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [obsInputs, setObsInputs] = useState<string[]>([])
  const [namingPreview, setNamingPreview] = useState('')
  const [diagCopied, setDiagCopied] = useState(false)
  const [overlayCopied, setOverlayCopied] = useState(false)
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const [cpuCount, setCpuCount] = useState<number>(8)
  const [watermarkStatus, setWatermarkStatus] = useState<string>('')
  const [watermarkBusy, setWatermarkBusy] = useState<boolean>(false)
  const [resumeBusy, setResumeBusy] = useState<boolean>(false)
  const [resumeStatus, setResumeStatus] = useState<string>('')
  const [resumeUnfinishedCount, setResumeUnfinishedCount] = useState<number>(0)

  useEffect(() => {
    if (currentSettings) {
      setDraft({ ...currentSettings })
      updatePreview(currentSettings.fileNaming.pattern)
    }
    window.api?.obsGetInputList().then(setObsInputs).catch(() => {})
    window.api?.wifiDisplayGetMonitors().then((m: MonitorInfo[]) => setMonitors(m || [])).catch(() => {})
    ;(window.api as any)?.getSystemInfo?.().then((info: { cpuCount: number } | undefined) => {
      if (info?.cpuCount && info.cpuCount > 0) setCpuCount(info.cpuCount)
    }).catch(() => {})
    // Poll the unfinished-routine count so the button label stays accurate.
    ;(window.api as any)?.uploadCountUnfinished?.().then((r: { count: number } | undefined) => {
      if (r && typeof r.count === 'number') setResumeUnfinishedCount(r.count)
    }).catch(() => {})
  }, [currentSettings])

  // 2026-05-15: tabbed Settings. Show/hide each .settings-section by reading
  // its title text and matching to the active tab. Re-runs whenever the tab
  // or draft changes (draft change can add/remove conditional sections).
  useEffect(() => {
    const root = document.querySelector('.settings-body')
    if (!root) return
    const sections = root.querySelectorAll<HTMLElement>('.settings-section')
    sections.forEach((sec) => {
      const titleEl = sec.querySelector('.settings-section-title')
      const title = (titleEl?.textContent || '').trim()
      const tab = tabForSection(title)
      sec.style.display = tab === activeTab ? '' : 'none'
    })
  }, [activeTab, draft])

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

      <div className="settings-tabbar">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            className={`settings-tab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-body" data-active-tab={activeTab}>
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

        {/* Day Checklists — re-open buttons */}
        <div className="settings-section">
          <div className="settings-section-title">Day Checklists</div>
          <p className="section-desc">
            Re-open the start- or end-of-day checklist. Item states persist per day — re-opening shows your saved progress.
          </p>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              className="back-btn"
              onClick={() => {
                (window.api as unknown as { dayChecklistReopen?: (kind: 'start' | 'end') => Promise<unknown> })
                  .dayChecklistReopen?.('start')
                  .catch(() => {})
              }}
            >
              Show Start-of-Day Checklist
            </button>
            <button
              className="back-btn"
              onClick={() => {
                (window.api as unknown as { dayChecklistReopen?: (kind: 'start' | 'end') => Promise<unknown> })
                  .dayChecklistReopen?.('end')
                  .catch(() => {})
              }}
            >
              Show End-of-Day Checklist
            </button>
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
              <label>Encode Intensity</label>
              <select
                value={draft.ffmpeg.encodeIntensity ?? 'balanced'}
                onChange={(e) => update('ffmpeg', { encodeIntensity: e.target.value as 'aggressive' | 'balanced' | 'quiet' | 'custom' })}
              >
                <option value="aggressive">Aggressive — fastest encode, may hit OBS/wifi-display</option>
                <option value="balanced">Balanced — recommended (70% cores, below-normal priority)</option>
                <option value="quiet">Quiet — slow but lets OBS/wifi-display breathe (30% cores, idle priority)</option>
                <option value="custom">Custom — use raw fields below</option>
              </select>
              <span className="hint">Burlington UDC 2026-05-01: single slider replaces fiddly thread+priority knobs. Switch to "Quiet" if tablet/preview gets choppy during encode bursts.</span>
            </div>
            <div className="field">
              <label>FFmpeg thread count (advanced)</label>
              <input
                type="range"
                min={0}
                max={cpuCount}
                step={1}
                value={draft.ffmpeg.threadCount ?? 0}
                onChange={(e) => update('ffmpeg', { threadCount: parseInt(e.target.value, 10) || 0 })}
                style={{ width: '100%' }}
                disabled={(draft.ffmpeg.encodeIntensity ?? 'balanced') !== 'custom'}
              />
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                {(draft.ffmpeg.threadCount ?? 0) === 0
                  ? 'Auto (driven by Encode Intensity)'
                  : `${draft.ffmpeg.threadCount} ${draft.ffmpeg.threadCount === 1 ? 'core' : 'cores'} of ${cpuCount}`}
              </div>
              <span className="hint">Only applies when Encode Intensity is "Custom". Otherwise driven by the preset.</span>
            </div>
            <div className="field">
              <label>CPU Priority (advanced)</label>
              <select
                value={draft.ffmpeg.cpuPriority}
                onChange={(e) => update('ffmpeg', { cpuPriority: e.target.value as 'normal' | 'below-normal' | 'idle' })}
                disabled={(draft.ffmpeg.encodeIntensity ?? 'balanced') !== 'custom'}
              >
                <option value="normal">Normal (full speed)</option>
                <option value="below-normal">Below Normal</option>
                <option value="idle">Idle (slowest)</option>
              </select>
              <span className="hint">Only applies when Encode Intensity is "Custom".</span>
            </div>
          </div>
        </div>

        {/* Performance — worker thread cutover (D1/D2) */}
        <div className="settings-section">
          <div className="settings-section-title">Performance (advanced)</div>
          <p className="section-desc">
            Move EXIF reading and photo-to-routine matching into worker threads so the main process stays responsive during large imports. Leave OFF until shadow-mode logs show clean parity for a few hours.
          </p>
          <div className="settings-grid single">
            <div className="field">
              <label>EXIF reader worker</label>
              <div className="toggle-row">
                <div className="toggle-label">Use worker_threads pool for SD-card EXIF reads</div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={draft.performance?.useExifWorker ?? false}
                    onChange={(e) => update('performance', { useExifWorker: e.target.checked })}
                  />
                  <span className="slider" />
                </label>
              </div>
              <span className="hint">When OFF, a shadow worker still runs in parallel and logs divergences as <code>exifWorker divergence</code> / <code>exifWorker shadow parity</code> in main.log.</span>
            </div>
            <div className="field">
              <label>Matcher worker</label>
              <div className="toggle-row">
                <div className="toggle-label">Use worker for clock-offset detection + routine matching</div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={draft.performance?.useMatcherWorker ?? false}
                    onChange={(e) => update('performance', { useMatcherWorker: e.target.checked })}
                  />
                  <span className="slider" />
                </label>
              </div>
              <span className="hint">When OFF, shadow worker logs <code>matcherWorker divergence</code> / <code>matcherWorker shadow parity</code>. Worker failure always falls back to inline.</span>
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
              <span className="hint">Warning fires after N minutes (0 = no warning). Recording continues until manual stop.</span>
            </div>
            <div className="field">
              <label>Transition Cycle Order</label>
              <input
                type="text"
                value={draft.obs.transitionCycleOrder ?? ''}
                onChange={(e) => update('obs', { transitionCycleOrder: e.target.value })}
                placeholder="Cut, Fade, Luma Wipe, UDC Stinger"
              />
              <span className="hint">Comma-separated transition names — controls Stream Deck cycle button order. Empty = OBS API order. Names not in OBS are ignored; any extra OBS transitions appear after the listed ones.</span>
            </div>
          </div>
        </div>

        {/* Upload */}
        <div className="settings-section">
          <div className="settings-section-title">Upload</div>
          <div className="settings-grid single">
            <div className="field">
              <label>Upload bandwidth cap</label>
              <select
                value={draft.upload?.bandwidthCapBytesPerSec ?? 0}
                onChange={(e) => update('upload', { bandwidthCapBytesPerSec: parseInt(e.target.value, 10) || 0 })}
              >
                <option value={0}>Unlimited (default)</option>
                <option value={512000}>500 KB/s (~4 Mbps)</option>
                <option value={1048576}>1 MB/s (~8 Mbps)</option>
                <option value={2621440}>2.5 MB/s (~20 Mbps)</option>
                <option value={5242880}>5 MB/s (~40 Mbps)</option>
                <option value={10485760}>10 MB/s (~80 Mbps)</option>
                <option value={26214400}>25 MB/s (~200 Mbps)</option>
              </select>
              <span className="hint">Limit upload speed to leave headroom for livestream. Applies to next file upload.</span>
            </div>
            <div className="field">
              <label>Upload strategy</label>
              <select
                value={draft.upload?.uploadStrategy ?? 'main-process'}
                onChange={(e) => update('upload', {
                  uploadStrategy: e.target.value as 'main-process' | 'child-process',
                })}
              >
                <option value="main-process">Main process (default, proven)</option>
                <option value="child-process">Child process (lower CPU contention)</option>
              </select>
              <span className="hint">
                Child process runs each PUT in its own OS process at below-normal priority,
                so TLS encryption + file I/O can't compete with wifi-display or OBS. Flip
                back to main-process anytime if uploads start misbehaving — applies to next
                file upload, no restart needed.
              </span>
            </div>
            <div className="field">
              <label>Photo upload priority</label>
              <select
                value={draft.upload?.photoPriority ?? 'newest-first'}
                onChange={(e) => update('upload', {
                  photoPriority: e.target.value as AppSettings['upload']['photoPriority'],
                })}
              >
                <option value="newest-first">Newest photos first</option>
                <option value="oldest-first">Oldest photos first</option>
              </select>
              <span className="hint">
                Controls which pending photo gets picked next when uploads are active. Use newest-first on event day so the latest imported photos surface fastest.
              </span>
            </div>
          </div>
        </div>

        {/* Lower-third animation config — moved from rail 2026-05-15 */}
        <div className="settings-section">
          <div className="settings-section-title">Lower Third Animation</div>
          <div className="settings-grid single">
            <div className="field">
              <label>Animation, auto-hide seconds, duration, easing</label>
              <LowerThirdAnimConfig />
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
            <div className="field">
              <label>Logo Image</label>
              <div className="field-row">
                <input
                  type="text"
                  value={draft.overlay?.logoUrl || ''}
                  readOnly
                  style={{ flex: 1, opacity: 0.85 }}
                  placeholder="No logo selected"
                />
                <button
                  className="back-btn"
                  onClick={async () => {
                    const url = await (window as any).api.overlaySetLogo()
                    if (url) {
                      update('overlay', { logoUrl: url })
                    }
                  }}
                >
                  Browse
                </button>
              </div>
              <span className="hint">PNG or SVG logo shown in overlay. Persists across restarts.</span>
            </div>
          </div>
        </div>

        {/* Branding / Socials */}
        <div className="settings-section">
          <div className="settings-section-title">Branding &amp; Socials</div>
          <p className="section-desc">
            Organization info and social handles. Used in overlay Starting Soon scene and lower thirds.
          </p>
          <div className="settings-grid">
            <div className="field">
              <label>Organization Name</label>
              <input
                type="text"
                value={draft.branding?.organizationName || ''}
                onChange={(e) => update('branding', { organizationName: e.target.value })}
                placeholder="e.g., Dance Competition Inc."
              />
            </div>
            <div className="field">
              <label>Website</label>
              <div className="field-row">
                <input
                  type="text"
                  value={draft.branding?.website || ''}
                  onChange={(e) => update('branding', { website: e.target.value })}
                  placeholder="e.g., www.example.com"
                  style={{ flex: 1 }}
                />
                <button
                  className="back-btn"
                  onClick={async () => {
                    const url = draft.branding?.website
                    if (!url) return
                    try {
                      const kit = await (window as any).api.brandScrape(url)
                      update('branding', {
                        brandColors: kit.colors || [],
                        brandFont: kit.fonts?.[0] || '',
                        brandLogoUrl: kit.logoUrl || '',
                      })
                    } catch (err) {
                      console.error('Brand scrape failed:', err)
                    }
                  }}
                  title="Scrape colors, fonts, and logo from website"
                >
                  Clone Brand
                </button>
              </div>
              <span className="hint">Enter URL then click Clone Brand to extract colors, fonts, and logo</span>
            </div>
            {(draft.branding?.brandColors?.length ?? 0) > 0 && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Brand Colors ({draft.branding?.brandColors?.length || 0})</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                  {(draft.branding?.brandColors || []).map((color, i) => (
                    <div
                      key={i}
                      style={{
                        width: '32px',
                        height: '32px',
                        background: color,
                        borderRadius: '4px',
                        border: '1px solid var(--border)',
                      }}
                      title={color}
                    />
                  ))}
                  <button
                    className="back-btn"
                    style={{ height: '32px', padding: '0 8px', fontSize: '10px' }}
                    onClick={() => update('branding', { brandColors: [], brandFont: '', brandLogoUrl: '' })}
                  >
                    Clear
                  </button>
                </div>
                {draft.branding?.brandFont && (
                  <span className="hint" style={{ marginTop: '6px', display: 'block' }}>
                    Font: <strong>{draft.branding.brandFont}</strong>
                  </span>
                )}
              </div>
            )}
            <div className="field">
              <label>Instagram</label>
              <input
                type="text"
                value={draft.branding?.instagram || ''}
                onChange={(e) => update('branding', { instagram: e.target.value })}
                placeholder="@handle"
              />
            </div>
            <div className="field">
              <label>Facebook</label>
              <input
                type="text"
                value={draft.branding?.facebook || ''}
                onChange={(e) => update('branding', { facebook: e.target.value })}
                placeholder="@handle or page name"
              />
            </div>
            <div className="field">
              <label>TikTok</label>
              <input
                type="text"
                value={draft.branding?.tiktok || ''}
                onChange={(e) => update('branding', { tiktok: e.target.value })}
                placeholder="@handle"
              />
            </div>
            <div className="field">
              <label>YouTube</label>
              <input
                type="text"
                value={draft.branding?.youtube || ''}
                onChange={(e) => update('branding', { youtube: e.target.value })}
                placeholder="@channel"
              />
            </div>
            <div className="field">
              <label>Twitter / X</label>
              <input
                type="text"
                value={draft.branding?.twitter || ''}
                onChange={(e) => update('branding', { twitter: e.target.value })}
                placeholder="@handle"
              />
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
            <div className="field">
              <label>Match Buffer (ms)</label>
              <input
                type="number"
                value={draft.tether?.matchBufferMs ?? 1000}
                onChange={(e) => update('tether', { matchBufferMs: parseInt(e.target.value) || 1000 })}
                min={0}
                max={10000}
                step={100}
                style={{ width: '100px' }}
              />
              <span className="hint">
                How far outside a recording window (ms) a photo can still match. Lower = more precise, higher = more forgiving of clock drift.
              </span>
            </div>
          </div>
        </div>

        {/* Photo Import — Watermarks + Date Filter */}
        <div className="settings-section">
          <div className="settings-section-title">Photo Import</div>
          <p className="section-desc">
            Auto-import only adds photos newer than the per-camera watermark. Cards with photos
            from prior days/events get the old photos automatically skipped — only today&apos;s
            photos import. Use the controls below for forensic recovery (re-importing prior days
            from a card) or after manual DB cleanup.
          </p>
          <div className="settings-grid single">
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={!!draft.behavior?.includePriorDayPhotos}
                  onChange={(e) => update('behavior', { includePriorDayPhotos: e.target.checked })}
                />
                {' '}Include photos from prior days (forensic recovery)
              </label>
              <span className="hint">
                Off (default): photos with EXIF dates other than today are silently skipped on
                every import path. On: prior-day photos are processed too — useful for re-importing
                a card after manual DB cleanup, dangerous during a live event because old
                contamination on the card will get pulled in.
              </span>
            </div>
            <div className="field">
              <div className="field-row" style={{ gap: 8 }}>
                <button
                  className="back-btn"
                  disabled={watermarkBusy}
                  onClick={async () => {
                    const attached = await Promise.resolve().then(() => {
                      return confirm('Mark all currently-attached SDs as already processed?\n\nAuto-import will skip photos already on the cards at this moment. New photos taken after this will still import normally.')
                    })
                    if (!attached) return
                    setWatermarkBusy(true)
                    setWatermarkStatus('Scanning SDs...')
                    try {
                      const res = await (window.api as any).photosMarkSdsProcessed() as { scannedDrives: number; watermarksSet: Record<string, string>; error?: string }
                      if (res?.error) {
                        setWatermarkStatus(`Error: ${res.error}`)
                      } else {
                        const bodies = res.watermarksSet ? Object.keys(res.watermarksSet).length : 0
                        setWatermarkStatus(
                          res.scannedDrives === 0
                            ? 'No camera SDs attached.'
                            : `Watermarked ${bodies} camera body${bodies === 1 ? '' : 'ies'} across ${res.scannedDrives} drive${res.scannedDrives === 1 ? '' : 's'}.`,
                        )
                      }
                    } catch (err) {
                      setWatermarkStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
                    } finally {
                      setWatermarkBusy(false)
                    }
                  }}
                >
                  Mark Current SDs as Processed
                </button>
                <button
                  className="back-btn"
                  disabled={watermarkBusy}
                  onClick={async () => {
                    if (!confirm('Clear all photo-import watermarks?\n\nThis resets the per-camera "last imported" markers. Next auto-import will re-evaluate every photo on attached cards (subject to today-date filter and DB-dedup).\n\nUse this if you need to re-import an entire card from scratch — e.g. after manual DB cleanup.')) return
                    setWatermarkBusy(true)
                    setWatermarkStatus('Clearing...')
                    try {
                      await (window.api as any).photosClearSdWatermarks()
                      setWatermarkStatus('Cleared all photo-import watermarks.')
                    } catch (err) {
                      setWatermarkStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
                    } finally {
                      setWatermarkBusy(false)
                    }
                  }}
                  title="Reset per-camera 'last imported' markers. Use after manual DB cleanup or to re-import a full card."
                >
                  Clear Photo-Import Watermarks
                </button>
              </div>
              {watermarkStatus && (
                <span className="hint" style={{ marginTop: 6 }}>{watermarkStatus}</span>
              )}
            </div>
          </div>
        </div>

        {/* Tools — moved here from header ActionBar 2026-04-30 to free top-strip width */}
        <div className="settings-section">
          <div className="settings-section-title">Tools</div>
          <p className="section-desc">
            Manual import + recovery utilities. Moved here from the header
            action bar to free up top-strip space for live operator status.
          </p>
          <div className="settings-grid single">
            <div className="field">
              <button
                type="button"
                className="settings-btn"
                style={{ padding: '8px 14px', fontSize: '12px' }}
                onClick={async () => {
                  const folderPath = await window.api.settingsBrowseDir()
                  if (folderPath) {
                    await window.api.importFolder(folderPath)
                  }
                }}
              >
                Import Video Folder…
              </button>
              <span className="hint">
                Bulk-import existing video files from a folder. Use after a
                day of recording on a different machine to ingest the MP4s.
              </span>
            </div>
            <div className="field">
              <button
                type="button"
                className="settings-btn"
                style={{ padding: '8px 14px', fontSize: '12px' }}
                onClick={() => useStore.getState().setRecoveryOpen(true)}
              >
                Open Recovery Panel…
              </button>
              <span className="hint">
                Post-event recovery: split a full-day MKV into per-routine
                clips when the recorder didn&apos;t auto-segment.
              </span>
            </div>
          </div>
        </div>

        {/* Upload Recovery — T-V7-22 */}
        <div className="settings-section">
          <div className="settings-section-title">Upload Recovery</div>
          <p className="section-desc">
            Re-scan all routines with pending photos or video files and queue only what&apos;s
            truly missing from R2+DB. Safe to re-click — the DB cross-check prevents double-uploads.
            Use this when the status column looks wrong or an earlier import didn&apos;t fully land.
          </p>
          <div className="settings-grid single">
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={draft.upload?.autoResumeOnBoot !== false}
                  onChange={(e) => update('upload', { autoResumeOnBoot: e.target.checked } as Partial<AppSettings['upload']>)}
                />
                {' '}Auto-resume unfinished uploads on app boot
              </label>
              <span className="hint">
                When enabled (default), the app DB-cross-checks every pending routine after the
                share code resolves and queues only the truly-missing delta. Disable if you want
                to trigger resume manually only.
              </span>
            </div>
            <div className="field">
              <div className="field-row" style={{ gap: 8 }}>
                <button
                  className="back-btn"
                  disabled={resumeBusy}
                  onClick={async () => {
                    setResumeBusy(true)
                    setResumeStatus('Scanning routines + cross-checking DB...')
                    try {
                      const res = await (window.api as any).uploadResumeUnfinished() as {
                        routinesScanned: number
                        photosRepaired: number
                        photosQueued: number
                        jobsQueued: number
                        endpointAvailable: boolean
                        error?: string
                      }
                      if (res?.error) {
                        setResumeStatus(`Error: ${res.error}`)
                      } else if (!res.endpointAvailable) {
                        setResumeStatus(
                          `Endpoint unavailable — queued based on local state only: ${res.jobsQueued} jobs across ${res.routinesScanned} routines.`,
                        )
                      } else if (res.routinesScanned === 0) {
                        setResumeStatus('Everything up to date.')
                      } else {
                        setResumeStatus(
                          `Resumed ${res.routinesScanned} routine${res.routinesScanned === 1 ? '' : 's'}, ` +
                          `${res.photosRepaired} photo${res.photosRepaired === 1 ? '' : 's'} repaired (already in DB), ` +
                          `${res.jobsQueued} job${res.jobsQueued === 1 ? '' : 's'} queued.`,
                        )
                      }
                      // Refresh count after action
                      ;(window.api as any)?.uploadCountUnfinished?.().then((r: { count: number }) => {
                        if (r && typeof r.count === 'number') setResumeUnfinishedCount(r.count)
                      }).catch(() => {})
                    } catch (err) {
                      setResumeStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
                    } finally {
                      setResumeBusy(false)
                    }
                  }}
                >
                  {resumeBusy
                    ? 'Resuming...'
                    : resumeUnfinishedCount > 0
                      ? `Resume Unfinished Uploads (${resumeUnfinishedCount})`
                      : 'Resume Unfinished Uploads'}
                </button>
              </div>
              {resumeStatus && (
                <span className="hint" style={{ marginTop: 6 }}>{resumeStatus}</span>
              )}
            </div>
          </div>
        </div>

        {/* Automatic Sync — T-V7-26 ambient reconciler */}
        <div className="settings-section">
          <div className="settings-section-title">Automatic Sync</div>
          <p className="section-desc">
            Continuously heal drift between local state and CompPortal while
            the app runs. Every N minutes the app quietly DB-cross-checks its
            pending uploads and enqueues anything missing. No operator clicks
            needed. This only runs when Auto-upload after processing is on.
          </p>
          <div className="settings-grid single">
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={(draft.upload?.reconcileCadenceMinutes ?? 15) > 0}
                  onChange={(e) => update('upload', {
                    reconcileCadenceMinutes: e.target.checked ? 15 : 0,
                  } as Partial<AppSettings['upload']>)}
                />
                {' '}Continuously check for missing uploads while app is open
              </label>
              <span className="hint">
                When off, only explicit actions (boot, SD plug-in, manual Resume
                button) trigger reconcile. When on, drift is healed on a timer.
                Auto-upload after processing is the master switch for background
                reconcile/upload work.
              </span>
            </div>
            <div className="field">
              <label>Check every</label>
              <div className="field-row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={draft.upload?.reconcileCadenceMinutes ?? 15}
                  onChange={(e) => update('upload', {
                    reconcileCadenceMinutes: Math.max(0, Math.min(1440, parseInt(e.target.value || '0', 10))),
                  } as Partial<AppSettings['upload']>)}
                  min={0}
                  max={1440}
                  step={1}
                  style={{ width: 90 }}
                  disabled={(draft.upload?.reconcileCadenceMinutes ?? 15) === 0}
                />
                <span className="hint">minutes (2-1440; 0 disables)</span>
              </div>
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={draft.upload?.reconcileSilent === false}
                  onChange={(e) => update('upload', {
                    reconcileSilent: !e.target.checked,
                  } as Partial<AppSettings['upload']>)}
                />
                {' '}Notify me when drift is found
              </label>
              <span className="hint">
                Off by default — ambient ticks log only. Turn on to see a toast
                whenever a cycle queues new uploads or hits errors.
              </span>
            </div>
          </div>
        </div>

        {/* Tablet Display */}
        <div className="settings-section">
          <div className="settings-section-title">Tablet Display</div>
          <p className="section-desc">
            Stream a monitor to a wireless tablet using wifi-display-server. Touch input from the tablet controls the PC.
          </p>
          <div className="settings-grid single">
            <div className="field">
              <label>Monitor</label>
              <select
                value={draft.wifiDisplay?.monitorIndex ?? ''}
                onChange={(e) => update('wifiDisplay', { monitorIndex: e.target.value === '' ? null : parseInt(e.target.value) })}
              >
                <option value="">Select monitor...</option>
                {monitors.map((m, i) => (
                  <option key={m.id} value={i}>
                    {m.label || `Display ${i + 1}`} ({m.width}x{m.height})
                  </option>
                ))}
              </select>
              <span className="hint">The monitor/display to stream to the tablet.</span>
            </div>
          </div>
          <div className="settings-grid">
            <div className="field">
              <label>Bitrate (kbps)</label>
              <input
                type="number"
                min={1000}
                max={10000}
                step={500}
                value={draft.wifiDisplay?.bitrate ?? 3000}
                onChange={(e) => update('wifiDisplay', { bitrate: parseInt(e.target.value) || 3000 })}
              />
              <span className="hint">Video bitrate. Higher = better quality, more bandwidth.</span>
            </div>
            <div className="field">
              <label>FPS</label>
              <select
                value={draft.wifiDisplay?.fps ?? 30}
                onChange={(e) => update('wifiDisplay', { fps: parseInt(e.target.value) })}
              >
                <option value="15">15</option>
                <option value="24">24</option>
                <option value="30">30</option>
                <option value="60">60</option>
              </select>
            </div>
            <div className="field">
              <label>Encoder</label>
              <select
                value={draft.wifiDisplay?.encoder ?? 'openh264'}
                onChange={(e) => update('wifiDisplay', { encoder: e.target.value as 'openh264' | 'hevc-nvenc' })}
              >
                <option value="openh264">H.264 (OpenH264)</option>
                <option value="hevc-nvenc">H.265/HEVC (NVENC)</option>
              </select>
              <span className="hint">Match this to the tablet codec selection.</span>
            </div>
            <div className="field">
              <label>Client IP</label>
              <input
                type="text"
                value={draft.wifiDisplay?.clientIp || ''}
                onChange={(e) => update('wifiDisplay', { clientIp: e.target.value || null })}
                placeholder="broadcast (leave empty)"
              />
              <span className="hint">Leave empty to broadcast. Set to tablet IP for unicast.</span>
            </div>
            <div className="field">
              <label>Video Port</label>
              <input
                type="number"
                min={1024}
                max={65535}
                value={draft.wifiDisplay?.videoPort ?? 5000}
                onChange={(e) => update('wifiDisplay', { videoPort: parseInt(e.target.value) || 5000 })}
              />
            </div>
            <div className="field">
              <label>Touch Port</label>
              <input
                type="number"
                min={1024}
                max={65535}
                value={draft.wifiDisplay?.touchPort ?? 5001}
                onChange={(e) => update('wifiDisplay', { touchPort: parseInt(e.target.value) || 5001 })}
              />
            </div>
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Auto-start on launch</div>
              <div className="toggle-desc">Automatically start streaming when CompSync opens</div>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={draft.wifiDisplay?.autoStart ?? false}
                onChange={(e) => update('wifiDisplay', { autoStart: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="settings-grid single">
            <div className="field">
              <label>Connection Info</label>
              <div className="naming-preview">
                Connect tablet to port {draft.wifiDisplay?.videoPort ?? 5000} (video) / {draft.wifiDisplay?.touchPort ?? 5001} (touch)
              </div>
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

        <BackupMedia />
        <StreamDeckPluginSection />
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
