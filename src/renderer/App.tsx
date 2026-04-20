import React, { useEffect, useRef, useState } from 'react'
import { useStore, initIPCListeners } from './store/useStore'
import { IPC_CHANNELS } from '../shared/types'
import Header from './components/Header'
import LeftPanel from './components/LeftPanel'

import RightPanel from './components/RightPanel'
import DragHandle from './components/DragHandle'
import Settings from './components/Settings'
import PhotoSorter from './components/PhotoSorter'
import RecoveryPanel from './components/RecoveryPanel'
import DriveAlert from './components/DriveAlert'
import FirstRunSetup from './components/FirstRunSetup'
import OrphanReview, { openOrphanReview } from './components/OrphanReview'
import ClockSyncReminder from './components/ClockSyncReminder'
import StartOfDayModal from './components/StartOfDayModal'
import EndOfDayModal from './components/EndOfDayModal'
import './styles/app.css'

function HardeningBanners(): React.ReactElement | null {
  const [devWarn, setDevWarn] = useState<string | null>(null)
  const [recordBlocked, setRecordBlocked] = useState<string | null>(null)
  const [recordMax, setRecordMax] = useState<string | null>(null)
  const [recordAlert, setRecordAlert] = useState<{ level: string; message: string } | null>(null)
  const [diskAlert, setDiskAlert] = useState<{ level: string; freeGB: number } | null>(null)
  const [driveLost, setDriveLost] = useState<string | null>(null)
  const [stateRecovered, setStateRecovered] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api) return
    const offs: Array<() => void> = []
    offs.push(window.api.on(IPC_CHANNELS.DEV_BUILD_WARNING, (data: unknown) => {
      const d = data as { message: string }
      setDevWarn(d.message)
    }))
    offs.push(window.api.on(IPC_CHANNELS.RECORDING_BLOCKED, (data: unknown) => {
      const d = data as { reason: string; detail?: string }
      setRecordBlocked(`Recording blocked: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`)
    }))
    offs.push(window.api.on(IPC_CHANNELS.RECORDING_MAX_WARNING, (data: unknown) => {
      const d = data as { maxMinutes: number; recordTimeSec: number }
      setRecordMax(`Recording has exceeded ${d.maxMinutes}-minute limit — still running. Stop manually when ready.`)
    }))
    offs.push(window.api.on(IPC_CHANNELS.RECORDING_ALERT, (data: unknown) => {
      const d = data as { level: string; message: string }
      setRecordAlert(d)
    }))
    offs.push(window.api.on(IPC_CHANNELS.DISK_SPACE_ALERT, (data: unknown) => {
      const d = data as { level: string; freeGB: number }
      if (d.level === 'ok') setDiskAlert(null)
      else setDiskAlert(d)
    }))
    offs.push(window.api.on(IPC_CHANNELS.DRIVE_LOST, (data: unknown) => {
      const d = data as { path: string }
      setDriveLost(`Output drive lost: ${d.path}. Uploads and encoding paused.`)
    }))
    offs.push(window.api.on(IPC_CHANNELS.DRIVE_RECOVERED, () => {
      setDriveLost(null)
    }))
    offs.push(window.api.on(IPC_CHANNELS.STATE_RECOVERED_FROM_BACKUP, (data: unknown) => {
      const d = data as { backupFile: string; ageMs: number }
      const mins = Math.round(d.ageMs / 60000)
      setStateRecovered(`State recovered from backup (${mins} min old). Verify routine statuses.`)
    }))
    return () => {
      for (const off of offs) {
        try { off() } catch {}
      }
    }
  }, [])

  const banners: Array<{ key: string; bg: string; text: string; onDismiss?: () => void }> = []
  if (devWarn) banners.push({ key: 'dev', bg: '#c17f00', text: devWarn, onDismiss: () => setDevWarn(null) })
  if (driveLost) banners.push({ key: 'drive', bg: '#8b0000', text: driveLost })
  if (recordBlocked) banners.push({ key: 'rblocked', bg: '#8b0000', text: recordBlocked, onDismiss: () => setRecordBlocked(null) })
  if (recordMax) banners.push({ key: 'rmax', bg: '#8b0000', text: recordMax, onDismiss: () => setRecordMax(null) })
  if (recordAlert) banners.push({
    key: 'ralert',
    bg: recordAlert.level === 'error' ? '#8b0000' : '#c17f00',
    text: recordAlert.message,
    onDismiss: () => setRecordAlert(null),
  })
  if (diskAlert) banners.push({
    key: 'disk',
    bg: diskAlert.level === 'critical' ? '#8b0000' : diskAlert.level === 'high' ? '#c17f00' : '#866d00',
    text: `Disk space ${diskAlert.level}: ${diskAlert.freeGB}GB free`,
  })
  if (stateRecovered) banners.push({ key: 'state', bg: '#c17f00', text: stateRecovered, onDismiss: () => setStateRecovered(null) })

  if (banners.length === 0) return null

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999, display: 'flex', flexDirection: 'column' }}>
      {banners.map((b) => (
        <div
          key={b.key}
          style={{
            background: b.bg,
            color: '#fff',
            padding: '6px 12px',
            fontSize: '12px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid rgba(0,0,0,0.3)',
          }}
        >
          <span>{b.text}</span>
          {b.onDismiss && (
            <button
              onClick={b.onDismiss}
              style={{ background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', padding: '2px 8px', cursor: 'pointer', fontSize: '11px' }}
            >
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function RecordingOverrunWarning(): React.ReactElement | null {
  const obsState = useStore((s) => s.obsState)
  if (!obsState.isRecording || obsState.recordTimeSec < 225) return null

  return (
    <div className="overrun-warning" />
  )
}

// T-V7-25: Missing-photo recovery toast. Fired when an inserted SD covers
// zero-photo / below-size-minimum routines AND those photos aren't already
// in R2+DB. Offers scoped "Import Missing Only" (just those files, bypasses
// watermark filter), full import (normal pipeline), or cancel.
interface MissingPhotosEvent {
  drivePath: string
  photoPath: string
  routinesAffected: Array<{
    entryNumber: string
    routineId: string
    sizeCategory?: string
    photoCount: number
    minExpected: number
    missing: string[]
  }>
  totalMissing: number
}

function MissingPhotosToast(): React.ReactElement | null {
  const [event, setEvent] = useState<MissingPhotosEvent | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!window.api) return
    const off = window.api.on(IPC_CHANNELS.DRIVE_MISSING_PHOTOS_DETECTED, (data: unknown) => {
      setEvent(data as MissingPhotosEvent)
    })
    return () => { try { off() } catch {} }
  }, [])

  if (!event) return null

  const nRoutines = event.routinesAffected.length
  const entries = event.routinesAffected.map((r) => r.entryNumber)
  const rangeLabel = entries.length <= 3
    ? entries.map((e) => `R${e}`).join(', ')
    : `R${entries[0]}-R${entries[entries.length - 1]} (${entries.length} routines)`

  async function doImportMissingOnly(): Promise<void> {
    if (!event) return
    setBusy(true)
    try {
      // Flatten the per-routine missing arrays to a single allowlist. The
      // matcher will re-assign each photo to its correct routine by EXIF
      // time; the allowlist just scopes which files are included in the
      // scan. Duplicates collapse naturally (Set semantics in main).
      const all = event.routinesAffected.flatMap((r) => r.missing)
      await (window.api as any).driveImportMissingOnly(event.photoPath, all)
    } catch {
      // Errors surface via normal import progress channel / alert
    } finally {
      setBusy(false)
      setEvent(null)
    }
  }

  function doFullImport(): void {
    if (!event) return
    // Fall through to the standard drive-detected flow — just dismiss this
    // toast. DriveAlert still has the normal Start Import / Watch Live
    // buttons. Operator can also trigger via header Photos button.
    setEvent(null)
  }

  function doCancel(): void {
    setEvent(null)
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 120,
        zIndex: 9999,
        maxWidth: 440,
        background: '#1a2438',
        border: '1px solid #4169e1',
        borderLeft: '4px solid #4169e1',
        borderRadius: 6,
        padding: '12px 14px',
        color: '#fff',
        fontSize: 12,
        lineHeight: 1.5,
        boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        {'\u{1F4BE}'} SD has {event.totalMissing} photo{event.totalMissing === 1 ? '' : 's'} covering {nRoutines} gap routine{nRoutines === 1 ? '' : 's'}
      </div>
      <div style={{ color: '#bdd1f2', marginBottom: 10 }}>
        Affected: {rangeLabel}. These routines are below their expected photo minimum and
        the SD has matching files that aren&apos;t in R2+DB yet. Import them now?
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={doImportMissingOnly}
          disabled={busy}
          style={{
            flex: 1,
            minWidth: 140,
            background: '#2d5da8',
            color: '#fff',
            border: 'none',
            padding: '6px 10px',
            borderRadius: 4,
            cursor: busy ? 'wait' : 'pointer',
            fontWeight: 600,
          }}
        >
          {busy ? 'Importing...' : `Import Missing Only (${event.totalMissing})`}
        </button>
        <button
          onClick={doFullImport}
          disabled={busy}
          style={{
            background: '#433',
            color: '#fff',
            border: '1px solid #666',
            padding: '6px 10px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Full Import
        </button>
        <button
          onClick={doCancel}
          disabled={busy}
          style={{
            background: 'transparent',
            color: '#9db4d8',
            border: '1px solid #4169e1',
            padding: '6px 10px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// Re-record advisory toast: fired when main detects a suspect re-record
// (new take > 90s AND prior routine dir had an encoded output). Purely
// advisory — archive still proceeds as normal. Auto-dismisses after 60s.
interface RerecEvent {
  currentRoutineId: string
  currentEntryNumber: string
  priorMkvName: string | null
  priorEncodedFiles: string[]
  newMkvPath: string
  newDurationSec: number
  detectedAt: string
}

function RerecordToast(): React.ReactElement | null {
  const [events, setEvents] = useState<RerecEvent[]>([])

  useEffect(() => {
    if (!window.api) return
    const off = window.api.on(IPC_CHANNELS.RECORDING_REREC_SUSPECTED, (data: unknown) => {
      const e = data as RerecEvent
      setEvents((prev) => [...prev, e])
      // Auto-dismiss after 60s so it doesn't linger across routines
      setTimeout(() => {
        setEvents((prev) => prev.filter((x) => x.detectedAt !== e.detectedAt))
      }, 60_000)
    })
    return () => { try { off() } catch {} }
  }, [])

  function dismiss(detectedAt: string): void {
    setEvents((prev) => prev.filter((x) => x.detectedAt !== detectedAt))
  }

  if (events.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        top: 80,
        zIndex: 9998,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: 420,
      }}
    >
      {events.map((e) => (
        <div
          key={e.detectedAt}
          style={{
            background: '#2a1e08',
            border: '1px solid #c17f00',
            borderLeft: '4px solid #c17f00',
            borderRadius: 6,
            padding: '10px 12px',
            color: '#fff',
            fontSize: 12,
            lineHeight: 1.4,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ fontSize: 16 }}>{'\u26A0\uFE0F'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>
                Possible missed routine advance — R{e.currentEntryNumber}
              </div>
              <div style={{ color: '#d4c29a' }}>
                Prior take for R{e.currentEntryNumber} already had an encoded output
                ({e.priorEncodedFiles.slice(0, 2).join(', ')}{e.priorEncodedFiles.length > 2 ? ', ...' : ''})
                and the new recording is {e.newDurationSec}s long. If this was actually
                a <strong>new routine</strong> (not a re-record), stop now, advance to the
                next entry, and re-record. The previous take has been archived either way.
              </div>
            </div>
            <button
              onClick={() => dismiss(e.detectedAt)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#d4c29a',
                cursor: 'pointer',
                fontSize: 14,
                padding: '0 4px',
              }}
              title="Dismiss"
            >
              {'\u2715'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// Offset confirmation toast: shown when main detects a camera-clock offset
// greater than the auto-apply threshold (15s). Import pauses until operator
// decides. Yes = apply offset. No = use 0 for this import. Skip = use 0 and
// remember "don't ask again this session" for this camera body.
interface OffsetProposal {
  proposalId: string
  cameraBody: string
  offsetMs: number
  matchesAt: number
  matchesAtZero: number
  totalPhotos: number
}

function OffsetConfirmToast(): React.ReactElement | null {
  const [proposals, setProposals] = useState<OffsetProposal[]>([])

  useEffect(() => {
    if (!window.api) return
    const off = window.api.on(IPC_CHANNELS.PHOTOS_OFFSET_PROPOSAL, (data: unknown) => {
      const p = data as OffsetProposal
      setProposals((prev) => [...prev, p])
    })
    return () => { try { off() } catch {} }
  }, [])

  function decide(proposalId: string, decision: 'yes' | 'no' | 'skip'): void {
    try {
      (window.api as any).photosOffsetDecision(proposalId, decision)
    } catch {
      // ignore
    }
    setProposals((prev) => prev.filter((p) => p.proposalId !== proposalId))
  }

  if (proposals.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: 420,
      }}
    >
      {proposals.map((p) => {
        const pctAt = p.totalPhotos > 0 ? Math.round((p.matchesAt / p.totalPhotos) * 100) : 0
        const pctZero = p.totalPhotos > 0 ? Math.round((p.matchesAtZero / p.totalPhotos) * 100) : 0
        const secs = Math.round(p.offsetMs / 1000)
        const sign = secs > 0 ? '+' : ''
        return (
          <div
            key={p.proposalId}
            style={{
              background: '#1e2a44',
              border: '1px solid #4169e1',
              borderLeft: '4px solid #4169e1',
              borderRadius: 6,
              padding: '12px 14px',
              color: '#fff',
              fontSize: 12,
              lineHeight: 1.5,
              boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Camera {p.cameraBody} offset {sign}{secs}s detected
            </div>
            <div style={{ color: '#bdd1f2', marginBottom: 10 }}>
              {p.matchesAt}/{p.totalPhotos} photos match at this offset ({pctAt}%) vs
              {' '}{p.matchesAtZero}/{p.totalPhotos} at zero ({pctZero}%). Apply for today?
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => decide(p.proposalId, 'yes')}
                style={{
                  flex: 1,
                  background: '#2d7a4f',
                  color: '#fff',
                  border: 'none',
                  padding: '6px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Yes — apply
              </button>
              <button
                onClick={() => decide(p.proposalId, 'no')}
                style={{
                  flex: 1,
                  background: '#433',
                  color: '#fff',
                  border: '1px solid #666',
                  padding: '6px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                No — use 0
              </button>
              <button
                onClick={() => decide(p.proposalId, 'skip')}
                style={{
                  background: 'transparent',
                  color: '#9db4d8',
                  border: '1px solid #4169e1',
                  padding: '6px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
                title="Use 0 and don't ask again this session for this camera"
              >
                Skip
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Import busy banner: pings main every 2s. If RTT > 500ms, shows a sticky banner
// telling the operator that controls may lag. Banner auto-clears when RTT drops
// back under 250ms. Non-blocking; does not prevent any action.
function ImportBusyBanner(): React.ReactElement | null {
  const [busy, setBusy] = useState(false)
  const [lastRttMs, setLastRttMs] = useState<number>(0)

  useEffect(() => {
    if (!window.api) return
    let cancelled = false

    async function tick(): Promise<void> {
      if (cancelled) return
      const start = performance.now()
      try {
        await (window.api as any).appPing()
        const rtt = performance.now() - start
        if (cancelled) return
        setLastRttMs(rtt)
        setBusy((prev) => {
          if (!prev && rtt > 500) return true
          if (prev && rtt < 250) return false
          return prev
        })
      } catch {
        // ignore — main might be starting up
      }
    }

    const id = setInterval(tick, 2000)
    // fire once shortly after mount so we don't wait 2s for first sample
    const warmup = setTimeout(tick, 500)
    return () => {
      cancelled = true
      clearInterval(id)
      clearTimeout(warmup)
    }
  }, [])

  if (!busy) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9997,
        background: '#2a1e08',
        border: '1px solid #c17f00',
        borderLeft: '4px solid #c17f00',
        borderRadius: 6,
        padding: '8px 14px',
        color: '#ffd38a',
        fontSize: 12,
        fontWeight: 600,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      }}
      title={`Main RTT ${Math.round(lastRttMs)}ms`}
    >
      {'\u23F3'} Import busy — controls may lag briefly
    </div>
  )
}

interface ImportSummary {
  runId: string
  routinesUpdated: number
  photosUploaded: number
  thumbsUploaded: number
  orphaned: number
  routinesOverMax?: Array<{ entryNumber: string; count: number; sizeCategory?: string; threshold: number }>
  routinesUnderMin?: Array<{ entryNumber: string; count: number; sizeCategory?: string; threshold: number }>
  cameraOffsets?: Record<string, number>
}

function ImportSummaryToast(): React.ReactElement | null {
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    if (!window.api) return
    const off = window.api.on(IPC_CHANNELS.PHOTOS_IMPORT_COMPLETE_SUMMARY, (data: unknown) => {
      setSummary(data as ImportSummary)
      setFading(false)
    })
    return () => { try { off() } catch {} }
  }, [])

  useEffect(() => {
    if (!summary) return
    const t = setTimeout(() => {
      setFading(true)
      setTimeout(() => setSummary(null), 300)
    }, 15000)
    return () => clearTimeout(t)
  }, [summary])

  if (!summary) return null

  const hasOrphans = summary.orphaned > 0
  const hasDistributionWarn =
    (summary.routinesOverMax?.length ?? 0) > 0 ||
    (summary.routinesUnderMin?.length ?? 0) > 0
  const hasCameraOffset = summary.cameraOffsets && Object.keys(summary.cameraOffsets).length > 0
  const borderColor = hasOrphans || hasDistributionWarn ? 'var(--warning)' : 'var(--success)'

  function onClick(): void {
    if (hasOrphans) {
      openOrphanReview()
    }
    setFading(true)
    setTimeout(() => setSummary(null), 300)
  }

  return (
    <div
      className="startup-toast import-summary-toast"
      style={{
        borderLeftColor: borderColor,
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.3s',
        bottom: '80px',
      }}
      onClick={onClick}
      title={hasOrphans ? 'Click to review orphans' : 'Click to dismiss'}
    >
      <div className="toast-title">Import complete</div>
      <div className="toast-items">
        <span>{summary.routinesUpdated} routine{summary.routinesUpdated === 1 ? '' : 's'} updated</span>
        <span>{summary.photosUploaded} photo{summary.photosUploaded === 1 ? '' : 's'} queued</span>
        <span>{summary.thumbsUploaded} thumb{summary.thumbsUploaded === 1 ? '' : 's'} generated</span>
        {hasOrphans && (
          <span style={{ color: 'var(--warning)' }}>
            {summary.orphaned} orphan{summary.orphaned === 1 ? '' : 's'} — click to review
          </span>
        )}
        {hasCameraOffset && summary.cameraOffsets && (
          <span style={{ color: '#9db4d8' }}>
            Offset applied: {Object.entries(summary.cameraOffsets)
              .map(([body, ms]) => `${body} ${ms > 0 ? '+' : ''}${Math.round(ms / 1000)}s`)
              .join(', ')}
          </span>
        )}
        {summary.routinesOverMax && summary.routinesOverMax.length > 0 && (
          <span style={{ color: 'var(--warning)' }}>
            ⚠ {summary.routinesOverMax.length} routine(s) over max —
            likely mis-match ({summary.routinesOverMax.slice(0, 3).map(x => `R${x.entryNumber}[${x.sizeCategory ?? '?'}]=${x.count}>${x.threshold}`).join(', ')}{summary.routinesOverMax.length > 3 ? '...' : ''})
          </span>
        )}
        {summary.routinesUnderMin && summary.routinesUnderMin.length > 0 && (
          <span style={{ color: 'var(--warning)' }}>
            ⚠ {summary.routinesUnderMin.length} recorded routine(s) under min
            ({summary.routinesUnderMin.slice(0, 3).map(x => `R${x.entryNumber}[${x.sizeCategory ?? '?'}]=${x.count}<${x.threshold}`).join(', ')}{summary.routinesUnderMin.length > 3 ? '...' : ''})
          </span>
        )}
      </div>
    </div>
  )
}

function StartupToast(): React.ReactElement | null {
  const report = useStore((s) => s.startupReport)
  const visible = useStore((s) => s.startupToastVisible)
  const dismiss = useStore((s) => s.dismissStartupToast)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    if (!visible || !report) return
    const timer = setTimeout(() => {
      setFading(true)
      setTimeout(() => dismiss(), 300)
    }, 8000)
    return () => clearTimeout(timer)
  }, [visible, report, dismiss])

  if (!visible || !report) return null

  const hasWarning = !report.ffmpegAvailable || report.diskWarning || report.orphanedFiles > 0
  const borderColor = hasWarning ? 'var(--warning)' : 'var(--success)'

  return (
    <div
      className="startup-toast"
      style={{
        borderLeftColor: borderColor,
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.3s',
      }}
      onClick={() => dismiss()}
    >
      <div className="toast-title">Startup Check</div>
      <div className="toast-items">
        <span style={{ color: report.ffmpegAvailable ? 'var(--success)' : 'var(--danger)' }}>
          FFmpeg {report.ffmpegAvailable ? 'OK' : 'NOT FOUND'}
        </span>
        <span style={{ color: report.diskWarning ? 'var(--warning)' : 'var(--text-muted)' }}>
          Disk {report.diskFreeGB}GB free
        </span>
        {report.resumedJobs > 0 && (
          <span style={{ color: 'var(--accent)' }}>
            {report.resumedJobs} job{report.resumedJobs > 1 ? 's' : ''} resumed
          </span>
        )}
        {report.orphanedFiles > 0 && (
          <span style={{ color: 'var(--warning)' }}>
            {report.orphanedFiles} orphaned file{report.orphanedFiles > 1 ? 's' : ''} cleaned
          </span>
        )}
      </div>
    </div>
  )
}

export default function App(): React.ReactElement {
  const settingsOpen = useStore((s) => s.settingsOpen)
  const photoSorterOpen = useStore((s) => s.photoSorterOpen)
  const recoveryOpen = useStore((s) => s.recoveryOpen)
  const compactMode = useStore((s) => s.compactMode)
  const initialized = useRef(false)

  // Ctrl+scroll zoom
  useEffect(() => {
    function handleWheel(e: WheelEvent): void {
      if (!e.ctrlKey) return
      e.preventDefault()
      if (e.deltaY < 0) {
        window.api?.setZoom('in')
      } else if (e.deltaY > 0) {
        window.api?.setZoom('out')
      }
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [])

  useEffect(() => {
    if (!window.api || initialized.current) return
    initialized.current = true

    // Initialize IPC listeners
    const cleanupIPC = initIPCListeners()

    // Load initial settings and auto-connect OBS
    window.api.settingsGet().then((settings) => {
      useStore.getState().setSettings(settings)
      if (settings.obs.url) {
        window.api.obsConnect(settings.obs.url, settings.obs.password).catch(() => {})
      }
    }).catch(() => {})

    // Load persisted competition
    window.api.scheduleGet().then((comp) => {
      if (comp) {
        useStore.getState().setCompetition(comp)
      }
    }).catch(() => {})

    return cleanupIPC
  }, [])

  return (
    <div className={`app-layout${compactMode ? ' compact' : ''}`}>
      <Header />
      <div className="main-split">
        <LeftPanel />
        <DragHandle target=".left-panel" min={400} max={1400} />
        <RightPanel />
      </div>
      {settingsOpen && <Settings />}
      {photoSorterOpen && <PhotoSorter />}
      {recoveryOpen && <RecoveryPanel />}
      <DriveAlert />
      <OrphanReview />
      <RecordingOverrunWarning />
      <ImportBusyBanner />
      <OffsetConfirmToast />
      <RerecordToast />
      <MissingPhotosToast />
      <StartupToast />
      <ImportSummaryToast />
      <HardeningBanners />
      <FirstRunSetup />
      <ClockSyncReminder />
      <StartOfDayModal />
      <EndOfDayModal />
    </div>
  )
}
