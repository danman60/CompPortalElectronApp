import React, { useEffect, useRef, useState } from 'react'
import { useStore, initIPCListeners } from './store/useStore'
import { IPC_CHANNELS } from '../shared/types'
import Header from './components/Header'
import RightPanel from './components/RightPanel'
import ShowControlRail from './components/ShowControlRail'
import Settings from './components/Settings'
import PhotoSorter from './components/PhotoSorter'
import RecoveryPanel from './components/RecoveryPanel'
import DriveAlert, { setImportPillActiveFromHeader, useImportMinimizedState } from './components/DriveAlert'
import FirstRunSetup from './components/FirstRunSetup'
import OrphanReview, { openOrphanReview } from './components/OrphanReview'
import ClockSyncReminder from './components/ClockSyncReminder'
import StartOfDayModal from './components/StartOfDayModal'
import EndOfDayModal from './components/EndOfDayModal'
import AudioAuditBanner from './components/AudioAuditBanner'
import ReassignPopover from './components/ReassignPopover'
import './styles/app.css'

function HardeningBanners(): React.ReactElement | null {
  const [devWarn, setDevWarn] = useState<string | null>(null)
  const [recordBlocked, setRecordBlocked] = useState<string | null>(null)
  const [recordMax, setRecordMax] = useState<string | null>(null)
  const [recordAlert, setRecordAlert] = useState<{ level: string; message: string } | null>(null)
  const [diskAlert, setDiskAlert] = useState<{ level: string; freeGB: number } | null>(null)
  const [driveLost, setDriveLost] = useState<string | null>(null)
  const [stateRecovered, setStateRecovered] = useState<string | null>(null)
  const [flatChannels, setFlatChannels] = useState<Set<string>>(new Set())
  const [photoStall, setPhotoStall] = useState<{ ageMin: number } | null>(null)
  const [compDrift, setCompDrift] = useState<{ serverLastDbWriteAt: string } | null>(null)
  const [compDriftBusy, setCompDriftBusy] = useState(false)
  const [unknownBodies, setUnknownBodies] = useState<Map<string, string>>(new Map())

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
    offs.push(window.api.on(IPC_CHANNELS.OBS_AUDIO_FLAT_CHANNEL, (data: unknown) => {
      const d = data as { channel: string; state: 'flat' | 'live' }
      setFlatChannels((prev) => {
        const next = new Set(prev)
        if (d.state === 'flat') next.add(d.channel)
        else next.delete(d.channel)
        return next
      })
    }))
    offs.push(window.api.on(IPC_CHANNELS.PHOTO_IMPORT_STALL, (data: unknown) => {
      const d = data as { ageMin: number; lastActivityMs: number }
      setPhotoStall({ ageMin: d.ageMin })
    }))
    offs.push(window.api.on(IPC_CHANNELS.COMP_STATE_DRIFT_DETECTED, (data: unknown) => {
      const d = data as { serverLastDbWriteAt: string }
      setCompDrift({ serverLastDbWriteAt: d.serverLastDbWriteAt })
    }))
    offs.push(window.api.on(IPC_CHANNELS.COMP_STATE_DRIFT_RESOLVED, () => {
      setCompDrift(null)
      setCompDriftBusy(false)
    }))
    offs.push(window.api.on(IPC_CHANNELS.CAMERA_BODY_UNKNOWN, (data: unknown) => {
      const d = data as { prefix: string; sample: string }
      setUnknownBodies((prev) => {
        if (prev.has(d.prefix)) return prev
        const next = new Map(prev)
        next.set(d.prefix, d.sample)
        return next
      })
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
  if (photoStall) banners.push({
    key: 'photo-stall',
    bg: '#8b0000',
    text: `Photo import stalled — no new photos in ${photoStall.ageMin} min. Check SD card / reconcile via PIPE chip → Kick All Stages.`,
    onDismiss: () => setPhotoStall(null),
  })
  for (const [prefix, sample] of unknownBodies) {
    banners.push({
      key: `unknown-body-${prefix}`,
      bg: '#7a3a00',
      text: `Camera body unknown for filename pattern '${prefix}' (sample: ${sample}) — watermark filter inert for this card. Re-imports rely on DB-dedup only.`,
      onDismiss: () => setUnknownBodies((prev) => {
        const next = new Map(prev)
        next.delete(prefix)
        return next
      }),
    })
  }
  // Phase 1.4 / 1.6: drift banner with two distinct actions (Refresh + Skip).
  // Rendered AFTER the standard banners list so the banners-loop renders the
  // text + dismiss-X consistently; the action buttons are appended in the
  // map() below as a side-rendered button group.
  let compDriftBannerEntry: typeof banners[number] | null = null
  if (compDrift) {
    compDriftBannerEntry = {
      key: 'comp-drift',
      bg: '#7a3a00',
      text: `Server state changed since last close (${new Date(compDrift.serverLastDbWriteAt).toLocaleString()}). Refresh local state to avoid stale-job conflicts.`,
    }
    banners.push(compDriftBannerEntry)
  }
  async function handleDriftRefresh(): Promise<void> {
    if (compDriftBusy) return
    setCompDriftBusy(true)
    try { await (window.api as any).compStateDriftRefresh() } catch {}
    // The COMP_STATE_DRIFT_RESOLVED event will clear state.
  }
  async function handleDriftSkip(): Promise<void> {
    if (compDriftBusy) return
    setCompDriftBusy(true)
    try { await (window.api as any).compStateDriftDismiss() } catch {}
  }
  for (const ch of flatChannels) {
    banners.push({
      key: `flat-${ch}`,
      bg: '#8b0000',
      text: `AUDIO SILENT — ${ch} flat for >5s. Check mic / XLR / gain.`,
      // Dismissible — operator clears it from the channel set so the banner
      // disappears even if the OBS input is still flat. The next live signal
      // for that input naturally re-clears via the IPC live event anyway.
      onDismiss: () => setFlatChannels((prev) => {
        const next = new Set(prev)
        next.delete(ch)
        return next
      }),
    })
  }

  if (banners.length === 0) return null

  // Operator-spec 2026-04-29: when multiple alert banners stack, surface a
  // "Dismiss all" header so the operator can clear in one click. Only
  // dismisses the dismissable ones (drive-lost / disk-alert intentionally
  // sticky until state changes).
  const dismissableCount = banners.filter((b) => b.onDismiss).length
  function dismissAll(): void {
    for (const b of banners) {
      if (b.onDismiss) try { b.onDismiss() } catch {}
    }
  }

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999, display: 'flex', flexDirection: 'column' }}>
      {banners.length > 1 && dismissableCount > 1 && (
        <div
          style={{
            background: '#1a1a25',
            color: '#cfcfdc',
            padding: '4px 12px',
            fontSize: 11,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
          }}
        >
          <span>{banners.length} alert{banners.length === 1 ? '' : 's'} active</span>
          <button
            type="button"
            onClick={dismissAll}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.3)',
              color: '#cfcfdc',
              padding: '2px 10px',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
            }}
          >Dismiss all</button>
        </div>
      )}
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
          <span style={{ display: 'inline-flex', gap: 6 }}>
            {b.key === 'comp-drift' && (
              <>
                <button
                  type="button"
                  onClick={handleDriftRefresh}
                  disabled={compDriftBusy}
                  style={{
                    background: 'rgba(255,255,255,0.15)', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.5)', padding: '2px 10px',
                    cursor: compDriftBusy ? 'wait' : 'pointer', fontSize: '11px',
                    fontWeight: 700, borderRadius: 3,
                  }}
                >Refresh</button>
                <button
                  type="button"
                  onClick={handleDriftSkip}
                  disabled={compDriftBusy}
                  style={{
                    background: 'transparent', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.4)', padding: '2px 10px',
                    cursor: compDriftBusy ? 'wait' : 'pointer', fontSize: '11px',
                    borderRadius: 3,
                  }}
                >Skip</button>
              </>
            )}
            {b.onDismiss && (
              <button
                onClick={b.onDismiss}
                style={{ background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', padding: '2px 8px', cursor: 'pointer', fontSize: '11px' }}
              >
                Dismiss
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

// Item 10: brief toast confirming the new state when right-clicking the
// Nudge button toggles auto-encode / auto-upload + fires queue kick.
function AutoToggleToast(): React.ReactElement | null {
  const [msg, setMsg] = useState<{ label: string; state: string } | null>(null)
  useEffect(() => {
    function onToggle(e: Event): void {
      const ce = e as CustomEvent<{ label: string; state: string }>
      setMsg(ce.detail)
      const t = setTimeout(() => setMsg(null), 2500)
      return (() => clearTimeout(t)) as unknown as void
    }
    window.addEventListener('compsync:auto-toggled', onToggle as EventListener)
    return () => window.removeEventListener('compsync:auto-toggled', onToggle as EventListener)
  }, [])
  if (!msg) return null
  const isOn = msg.state === 'ON'
  const isFail = msg.state === 'FAILED'
  return (
    <div
      style={{
        position: 'fixed',
        top: 70,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9998,
        background: isFail ? '#5c1a1a' : isOn ? '#0d3a22' : '#1f1f2e',
        border: `1px solid ${isFail ? '#ef4444' : isOn ? '#22c55e' : '#9090b0'}`,
        borderRadius: 6,
        padding: '8px 14px',
        color: '#fff',
        fontSize: 13,
        fontWeight: 700,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      }}
    >
      {msg.label}: {msg.state} — queue kicked
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

// T-V7-26: Unified reconciler result toast. Fired when reconcileMedia runs
// non-silent AND queued or errored. Ambient ticks are silent by default; the
// toast surfaces manual button / SD-plugin / explicit runs. Auto-dismiss 10s.
interface ReconcileResultEvent {
  scanned: number
  repaired: number
  queued: number
  errors: string[]
  scope: string
  tookMs: number
  endpointAvailable: boolean
  skippedReason?: string
}

function ReconcileToast(): React.ReactElement | null {
  const [event, setEvent] = useState<ReconcileResultEvent | null>(null)

  useEffect(() => {
    if (!window.api) return
    // Operator-spec 2026-04-25: ReconcileToast is suppressed for clean
    // reconciles (no errors). The import-pill + ImportSummaryToast already
    // surface success info; this just adds noise. Errors STILL show because
    // they're actionable.
    const off = window.api.on(IPC_CHANNELS.MEDIA_RECONCILE_RESULT, (data: unknown) => {
      const e = data as ReconcileResultEvent
      if (!e.errors || e.errors.length === 0) return  // silent on clean reconcile
      setEvent(e)
      setTimeout(() => setEvent((cur) => (cur === e ? null : cur)), 10_000)
    })
    return () => { try { off() } catch {} }
  }, [])

  if (!event) return null

  const hasErrors = event.errors.length > 0
  const bg = hasErrors ? '#2a1e08' : '#0d2a1a'
  const border = hasErrors ? '#c17f00' : '#2d7a4f'
  const msg = hasErrors
    ? `Reconcile encountered ${event.errors.length} error${event.errors.length === 1 ? '' : 's'}. Check logs.`
    : `Found ${event.queued} media item${event.queued === 1 ? '' : 's'} to sync. Uploading now.`

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 240,
        zIndex: 9998,
        maxWidth: 380,
        background: bg,
        border: `1px solid ${border}`,
        borderLeft: `4px solid ${border}`,
        borderRadius: 6,
        padding: '10px 12px',
        color: '#fff',
        fontSize: 12,
        lineHeight: 1.4,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: 16 }}>{hasErrors ? '\u26A0\uFE0F' : '\u{1F501}'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            Media sync — {event.scope}
          </div>
          <div style={{ color: hasErrors ? '#d4c29a' : '#a7e3bc' }}>
            {msg}
          </div>
        </div>
        <button
          onClick={() => setEvent(null)}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9db4d8',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 4px',
          }}
          title="Dismiss"
        >{'\u2715'}</button>
      </div>
    </div>
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
  // Operator request 2026-04-25 mid-show: stop showing the gap-routines toast
  // ("SD has N photos covering K gap routines"). Same rationale as the
  // date-mismatch dialog and camera-clock-mismatch toast already silenced —
  // SDs always carry data the import flow handles via normal matching.
  // Operator can still trigger a manual import via Header → Photos if needed.
  // The IPC event still fires from main for diagnostics; we just don't render.
  return null
}

interface RerecDecisionRequest {
  proposalId: string
  currentRoutineId: string
  currentEntryNumber: string
  nextEntryNumber: string | null
  priorMkvName: string | null
  priorEncodedFiles: string[]
  newMkvPath: string
  newDurationSec: number
  detectedAt: string
}

// Re-record decision modal — Phase 2.8 / Take architecture (2026-04-29).
// Blocks post-stop processing until the operator picks one of three actions:
//   - Archive (default): new take canonical for THIS routine; prior MKV →
//                        _archive/v{N}/, prior take's window preserved.
//   - Specify Routine:   dropdown anchored at the routine the take was
//                        originally bound to. New take's currentRoutineId
//                        mutates to the picked routine; photos follow.
//   - Save as Extra:     text input default {entry}.5; creates lateInsert
//                        row; new take's currentRoutineId points there.
// Visually-only — no audible alerts.
type RerecDecisionPayload =
  | { kind: 'archive' }
  | { kind: 'specify-routine'; routineId: string }
  | { kind: 'save-as-extra'; emptyRoutineNumber: string }

function RerecordDecisionModal(): React.ReactElement | null {
  const competition = useStore((s) => s.competition)
  const [requests, setRequests] = useState<RerecDecisionRequest[]>([])
  const archiveBtnRef = React.useRef<HTMLButtonElement | null>(null)
  const [pickedRoutineId, setPickedRoutineId] = useState<string>('')
  const [extraEntry, setExtraEntry] = useState<string>('')

  useEffect(() => {
    if (!window.api) return
    const off = window.api.on(IPC_CHANNELS.RECORDING_REREC_DECISION_REQUESTED, (data: unknown) => {
      const r = data as RerecDecisionRequest
      setRequests((prev) => [...prev, r])
    })
    return () => { try { off() } catch {} }
  }, [])

  // Autofocus default (Archive) when a new modal appears + reset picker
  // defaults: dropdown anchored at the take's original routine; extra
  // entry default = {currentEntry}.5.
  useEffect(() => {
    if (requests.length > 0) {
      if (archiveBtnRef.current) archiveBtnRef.current.focus()
      const r = requests[0]
      setPickedRoutineId(r.currentRoutineId)
      // Default to {entry}.5 unless the entry already has a decimal.
      const baseNum = parseFloat(r.currentEntryNumber)
      const defaultExtra = isNaN(baseNum) ? `${r.currentEntryNumber}.5` : `${Math.floor(baseNum)}.5`
      setExtraEntry(defaultExtra)
    }
  }, [requests.length])

  function decide(proposalId: string, payload: RerecDecisionPayload): void {
    try {
      (window.api as any).recordingRerecDecision(proposalId, payload)
    } catch {
      // ignore
    }
    setRequests((prev) => prev.filter((r) => r.proposalId !== proposalId))
  }

  if (requests.length === 0) return null

  const r = requests[0]
  const durMin = Math.floor(r.newDurationSec / 60)
  const durSec = r.newDurationSec % 60
  const durStr = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`

  // Build dropdown of routines anchored at the take's original routine —
  // operator usually picks "the slot 1-2 away from where I thought I was."
  const allRoutines = competition?.routines ?? []
  const anchorIdx = allRoutines.findIndex((x) => x.id === r.currentRoutineId)
  // Show ±10 routines around anchor. If anchor isn't visible (scratched
  // mid-show), fall back to all visible routines.
  const dropdownStart = Math.max(0, anchorIdx - 10)
  const dropdownEnd = anchorIdx >= 0 ? Math.min(allRoutines.length, anchorIdx + 11) : allRoutines.length
  const visibleSlice = anchorIdx >= 0 ? allRoutines.slice(dropdownStart, dropdownEnd) : allRoutines

  // 2026-05-01 Burlington UDC: this card is RENDERED BOTTOM-RIGHT and is
  // NON-BLOCKING. Default 'archive' was already applied server-side at
  // recording-stop time (see recording.ts comment "auto-archiving prior").
  // The card surfaces what happened + lets operator OVERRIDE if archive
  // wasn't right. Operator can also dismiss (X) to accept the default and
  // get back to running the show.
  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 10000,
        width: 360,
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
      }}
      role="dialog"
      aria-labelledby="rerec-modal-title"
    >
      <div
        style={{
          background: '#1a1f2e',
          border: '2px solid #c17f00',
          borderRadius: 10,
          padding: 14,
          color: '#fff',
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          fontSize: 12,
          lineHeight: 1.4,
          position: 'relative',
        }}
      >
        <button
          aria-label="Dismiss"
          onClick={() => decide(r.proposalId, { kind: 'archive' })}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            background: 'transparent',
            color: '#d4d4d4',
            border: 'none',
            fontSize: 18,
            cursor: 'pointer',
            padding: '0 6px',
            lineHeight: 1,
          }}
        >×</button>
        <div
          id="rerec-modal-title"
          style={{
            fontSize: 13,
            fontWeight: 700,
            marginBottom: 6,
            color: '#ffca55',
            paddingRight: 24,
          }}
        >
          R{r.currentEntryNumber} re-record — auto-archived prior. Override?
        </div>
        <div style={{ marginBottom: 10, color: '#d4d4d4', fontSize: 11 }}>
          New take ({durStr}) kept as canonical for R<strong>{r.currentEntryNumber}</strong>; prior MKV moved to _archive/v{'{N}'}/. Pick a different action below if needed.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            ref={archiveBtnRef}
            onClick={() => decide(r.proposalId, { kind: 'archive' })}
            style={{
              background: '#2d4f7a',
              color: '#fff',
              border: '2px solid #3f6ca8',
              padding: '14px 16px',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: 14,
              textAlign: 'left',
            }}
          >
            <div style={{ fontSize: 15, marginBottom: 4 }}>
              Archive {'\u2014'} this take is the new R{r.currentEntryNumber}
            </div>
            <div style={{ fontWeight: 400, fontSize: 12, color: '#cfdded' }}>
              Old MKV moves to _archive/v{'{N}'}/. Photos shot during BOTH windows
              still bind to R{r.currentEntryNumber}.
            </div>
          </button>

          <div
            style={{
              background: '#3a2d10',
              border: '1px solid #6a5020',
              padding: '12px 14px',
              borderRadius: 6,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, color: '#ffd28a', marginBottom: 8 }}>
              Specify routine {'\u2014'} pick which routine this take is for
            </div>
            <select
              value={pickedRoutineId}
              onChange={(e) => setPickedRoutineId(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: '#1a1a25',
                color: '#fff',
                border: '1px solid #555',
                borderRadius: 4,
                fontSize: 13,
                marginBottom: 8,
              }}
            >
              {visibleSlice.map((rt) => (
                <option key={rt.id} value={rt.id}>
                  R{rt.entryNumber} {'\u2014'} {rt.routineTitle.slice(0, 60)}
                </option>
              ))}
            </select>
            <button
              onClick={() => decide(r.proposalId, { kind: 'specify-routine', routineId: pickedRoutineId })}
              disabled={!pickedRoutineId || pickedRoutineId === r.currentRoutineId}
              style={{
                background: '#7a5020',
                color: '#fff',
                border: '1px solid #a86c30',
                padding: '8px 14px',
                borderRadius: 4,
                cursor: !pickedRoutineId || pickedRoutineId === r.currentRoutineId ? 'not-allowed' : 'pointer',
                opacity: !pickedRoutineId || pickedRoutineId === r.currentRoutineId ? 0.5 : 1,
                fontWeight: 600,
                fontSize: 13,
              }}
            >
              Use picked routine
            </button>
          </div>

          <div
            style={{
              background: '#2a3a10',
              border: '1px solid #4a6a20',
              padding: '12px 14px',
              borderRadius: 6,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, color: '#cfff8a', marginBottom: 8 }}>
              Save as extra routine {'\u2014'} create a new entry
            </div>
            <input
              type="text"
              value={extraEntry}
              onChange={(e) => setExtraEntry(e.target.value)}
              placeholder={`e.g. ${r.currentEntryNumber}.5`}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: '#1a1a25',
                color: '#fff',
                border: '1px solid #555',
                borderRadius: 4,
                fontSize: 13,
                marginBottom: 8,
              }}
            />
            <button
              onClick={() => decide(r.proposalId, { kind: 'save-as-extra', emptyRoutineNumber: extraEntry.trim() })}
              disabled={!extraEntry.trim()}
              style={{
                background: '#4a7a20',
                color: '#fff',
                border: '1px solid #6caa30',
                padding: '8px 14px',
                borderRadius: 4,
                cursor: !extraEntry.trim() ? 'not-allowed' : 'pointer',
                opacity: !extraEntry.trim() ? 0.5 : 1,
                fontWeight: 600,
                fontSize: 13,
              }}
            >
              Save as R{extraEntry.trim() || '?'}
            </button>
          </div>
        </div>
      </div>
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

// Import busy banner: pings main every 2s. If RTT > 500ms AND an import is
// actively running, shows a sticky banner telling the operator that controls
// may lag. Banner auto-clears when RTT drops back under 250ms or the import
// finishes. Non-blocking; does not prevent any action.
//
// 2026-04-29: gated on `importActive` after operator reported the banner
// firing with no imports running. Main RTT can spike from any blocking work
// (encode worker, ffmpeg init, IPC backlog), so this banner is now scoped
// strictly to the import path.
function ImportBusyBanner(): React.ReactElement | null {
  const [busy, setBusy] = useState(false)
  const [lastRttMs, setLastRttMs] = useState<number>(0)
  const importState = useImportMinimizedState()
  const importActive = importState.active && importState.stage !== 'done'

  useEffect(() => {
    if (!window.api) return
    if (!importActive) {
      // No import running — don't ping, don't show. Reset busy if leaving import.
      setBusy(false)
      return
    }
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
  }, [importActive])

  if (!busy || !importActive) return null

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
      const s = data as ImportSummary
      // Operator-spec 2026-04-25: only surface this toast when there's
      // something actionable. A clean import (no orphans, no over-max,
      // no under-min, no errors) doesn't need a popup — the import pill
      // already showed completion. Reduces SD-insert noise.
      const hasAnythingActionable =
        (s.orphaned ?? 0) > 0 ||
        ((s.routinesOverMax?.length ?? 0) > 0) ||
        ((s.routinesUnderMin?.length ?? 0) > 0) ||
        ((s as unknown as { errors?: unknown[] }).errors?.length ?? 0) > 0
      if (!hasAnythingActionable) return
      setSummary(s)
      setFading(false)
    })
    // Auto-dismiss when the gap-routines toast (MissingPhotosToast) opens —
    // same screen real estate, gap-routines is the more actionable surface.
    const offGap = window.api.on(IPC_CHANNELS.DRIVE_MISSING_PHOTOS_DETECTED, () => {
      setFading(true)
      setTimeout(() => setSummary(null), 300)
    })
    return () => { try { off() } catch {}; try { offGap() } catch {} }
  }, [])

  useEffect(() => {
    if (!summary) return
    const t = setTimeout(() => {
      setFading(true)
      setTimeout(() => setSummary(null), 300)
    }, 8000)  // tightened from 15s → 8s per noise-reduction request
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

    // Load a full authoritative state snapshot so the main renderer boots
    // with the same current routine / next routine / index the panels and
    // WS clients should see.
    window.api.stateGet().then((snapshot) => {
      if (!snapshot || typeof snapshot !== 'object') return
      const s = snapshot as {
        competition: unknown
        currentRoutine: unknown
        nextRoutine: unknown
        currentIndex: unknown
      }
      useStore.setState({
        competition: (s.competition as any) ?? null,
        currentRoutine: (s.currentRoutine as any) ?? null,
        nextRoutine: (s.nextRoutine as any) ?? null,
        currentIndex: typeof s.currentIndex === 'number' ? s.currentIndex : 0,
      })
      useStore.getState().recalcCounts()
    }).catch(() => {})

    return cleanupIPC
  }, [])

  return (
    <div className={`app-layout${compactMode ? ' compact' : ''}`}>
      <Header />
      <div className="workspace">
        <RightPanel />
        {!compactMode && <ShowControlRail />}
      </div>
      {settingsOpen && <Settings />}
      {photoSorterOpen && <PhotoSorter />}
      {recoveryOpen && <RecoveryPanel />}
      <DriveAlert />
      <OrphanReview />
      <RecordingOverrunWarning />
      <AutoToggleToast />
      <ImportBusyBanner />
      <OffsetConfirmToast />
      <RerecordDecisionModal />
      <MissingPhotosToast />
      <ReconcileToast />
      <StartupToast />
      <ImportSummaryToast />
      <HardeningBanners />
      <FirstRunSetup />
      <ClockSyncReminder />
      <StartOfDayModal />
      <EndOfDayModal />
      <AudioAuditBanner />
      <ReassignPopover />
    </div>
  )
}
