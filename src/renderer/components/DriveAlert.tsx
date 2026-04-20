import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { DriveDetectedEvent, WPDDevice, WPDDeviceEvent, PhotoMatch, CameraClockMismatchEvent } from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/types'
import { setOrphansFromResult, openOrphanReview } from './OrphanReview'
import '../styles/drive-alert.css'

// Module-level progress bridge: DriveAlert stays mounted but the modal can be
// minimized while import continues. The Header pill subscribes to the same
// progress IPC events and reads this snapshot to render "Importing 45/2000".
// Exported so Header.tsx can wire the re-open click without a parent prop chain.
type MinimizedImportState = {
  active: boolean
  stage: string
  current: number
  total: number
  message: string
  driveKey: string | null
}
let minimizedState: MinimizedImportState = {
  active: false, stage: 'idle', current: 0, total: 0, message: '', driveKey: null,
}
const minimizedListeners = new Set<(s: MinimizedImportState) => void>()
function setMinimized(next: Partial<MinimizedImportState>): void {
  minimizedState = { ...minimizedState, ...next }
  for (const fn of minimizedListeners) {
    try { fn(minimizedState) } catch {}
  }
}
export function useImportMinimizedState(): MinimizedImportState {
  const [s, setS] = useState<MinimizedImportState>(minimizedState)
  useEffect(() => {
    const fn = (x: MinimizedImportState): void => setS(x)
    minimizedListeners.add(fn)
    return () => { minimizedListeners.delete(fn) }
  }, [])
  return s
}
export function restoreMinimizedImport(): void {
  setMinimized({ active: false }) // triggers DriveAlert to re-expand via useEffect below
  // Broadcast a local DOM event so the DriveAlert instance knows to un-minimize
  // without needing a store round-trip.
  window.dispatchEvent(new CustomEvent('drive-alert:restore'))
}

// Bug B fix: called from Header when the manual Photos button is used.
// Activates the import pill without a drive-detect event so the operator
// sees scan/EXIF progress immediately. Without this, large imports (20k+
// photos) used to run silently and look frozen.
export function setImportPillActiveFromHeader(folder: string | null): void {
  if (folder) {
    setMinimized({
      active: true,
      stage: 'scanning',
      current: 0,
      total: 0,
      message: 'Scanning...',
      driveKey: `header:${folder}`,
    })
  } else {
    setMinimized({ active: false })
  }
}

interface ImportProgress {
  stage: 'idle' | 'scanning' | 'reading-exif' | 'matching' | 'copying' | 'uploading' | 'done' | 'error'
  message: string
  current: number
  total: number
  matched: number
  unmatched: number
  copied: number
  uploadQueued: number
}

interface PreviewSummary {
  runId: string
  routinesUpdated: number
  photosUploaded: number
  orphaned: number
  cameraOffsets?: Record<string, number>
  routinesOverMax?: Array<{ entryNumber: string; count: number; sizeCategory?: string; threshold: number }>
  routinesUnderMin?: Array<{ entryNumber: string; count: number; sizeCategory?: string; threshold: number }>
  perRoutine?: Array<{ entryNumber: string; routineId: string; count: number }>
  folderPath?: string
  previewJsonPath?: string | null
}

export default function DriveAlert(): React.ReactElement | null {
  const [detected, setDetected] = useState<DriveDetectedEvent | null>(null)
  const [wpdDevice, setWpdDevice] = useState<WPDDevice | null>(null)
  const [clockMismatch, setClockMismatch] = useState<CameraClockMismatchEvent | null>(null)
  const [progress, setProgress] = useState<ImportProgress>({
    stage: 'idle', message: '', current: 0, total: 0, matched: 0, unmatched: 0, copied: 0, uploadQueued: 0,
  })
  const [showResults, setShowResults] = useState(false)
  const [minimized, setMinimizedLocal] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewSummary, setPreviewSummary] = useState<PreviewSummary | null>(null)
  const competition = useStore((s) => s.competition)
  const settings = useStore((s) => s.settings)
  const autoUpload = settings?.behavior?.autoUploadAfterEncoding ?? false
  const autoImportOnDrive = settings?.behavior?.autoImportOnDrive ?? true
  const autoImportFiredRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // WPD/MTP disabled — using folder-watch mode instead
    // window.api.tetherListWPDDevices().then((devices) => {
    //   if (Array.isArray(devices) && devices.length > 0) {
    //     setWpdDevice(devices[0] as WPDDevice)
    //     setDetected(null)
    //   }
    // }).catch(() => {})

    const unsubDrive = window.api.on('drive:detected', (data: unknown) => {
      setDetected(data as DriveDetectedEvent)
      setWpdDevice(null)
      setProgress({ stage: 'idle', message: '', current: 0, total: 0, matched: 0, unmatched: 0, copied: 0, uploadQueued: 0 })
      setShowResults(false)
    })

    // WPD/MTP disabled — using folder-watch mode
    const unsubWPD = (): void => {}

    const unsubProgress = window.api.on('photos:progress', (data: unknown) => {
      const p = data as { stage: string; total: number; current: number }
      setProgress((prev) => ({
        ...prev,
        stage: p.stage as ImportProgress['stage'],
        current: p.current,
        total: p.total,
        message: p.stage === 'scanning'
          ? `Scanning ${p.total} photos...`
          : p.stage === 'reading-exif'
            ? `Reading EXIF ${p.current}/${p.total}...`
            : prev.message,
      }))
      // Mirror progress into the module-level snapshot so the Header pill
      // can render independently of whether the modal is open or minimized.
      setMinimized({
        stage: p.stage,
        current: p.current,
        total: p.total,
        message: p.stage === 'scanning'
          ? `Scanning ${p.total}...`
          : `${p.current}/${p.total}`,
      })
    })

    const onRestore = (): void => setMinimizedLocal(false)
    window.addEventListener('drive-alert:restore', onRestore)

    const unsubClockMismatch = window.api.on('drive:camera-clock-mismatch', (data: unknown) => {
      setClockMismatch(data as CameraClockMismatchEvent)
    })

    const unsubPreview = window.api.on(IPC_CHANNELS.PHOTOS_PREVIEW_COMPLETE, (data: unknown) => {
      setPreviewSummary(data as PreviewSummary)
      setPreviewBusy(false)
    })

    const unsubResult = window.api.on('photos:match-result', (data: unknown) => {
      const result = data as { totalPhotos: number; matched: number; unmatched: number; clockOffsetMs: number }
      setProgress((prev) => ({
        ...prev,
        stage: 'done',
        matched: result.matched,
        unmatched: result.unmatched,
        total: result.totalPhotos,
        message: `${result.matched} matched, ${result.unmatched} unmatched` +
          (result.clockOffsetMs !== 0 ? ` (clock offset: ${Math.round(result.clockOffsetMs / 1000)}s)` : ''),
      }))
      setShowResults(true)
      // Bug B: header-triggered imports own the pill via Header's finally{}.
      // Drive-detect imports own it via handleDismiss. For both, clear it
      // here once the match-result lands so the pill doesn't get stuck on
      // "999/1000" after the final yield.
      if (minimizedState.driveKey?.startsWith('header:')) {
        setMinimized({ active: false })
      }
    })

    return () => {
      unsubDrive(); unsubWPD(); unsubProgress(); unsubResult(); unsubClockMismatch(); unsubPreview()
      window.removeEventListener('drive-alert:restore', onRestore)
    }
  }, [])

  function runPreview(photoPath: string): void {
    setPreviewBusy(true)
    setPreviewSummary(null)
    ;(window.api as any).photosPreviewImport(photoPath).then((res: unknown) => {
      if (res && typeof res === 'object' && 'error' in res) {
        setPreviewBusy(false)
        alert(`Preview failed: ${(res as { error: string }).error}`)
      }
      // Otherwise the PHOTOS_PREVIEW_COMPLETE event populates previewSummary.
    }).catch((err: unknown) => {
      setPreviewBusy(false)
      alert(`Preview error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  function runImport(photoPath: string): void {
    if (!competition) return
    setProgress((prev) => ({ ...prev, stage: 'scanning', message: `Scanning ${photoPath}...` }))
    // Import started — enable Header pill until handleDismiss or completion clears it.
    setMinimized({
      active: true,
      stage: 'scanning',
      current: 0,
      total: 0,
      message: `Scanning...`,
      driveKey: detected ? detected.drivePath : (wpdDevice?.id ?? null),
    })

    window.api.photosImport(photoPath).then((result) => {
      if (result && typeof result === 'object' && 'error' in result) {
        setProgress((prev) => ({
          ...prev,
          stage: 'error',
          message: (result as { error: string }).error,
        }))
        return
      }

      if (result && typeof result === 'object' && 'matches' in result) {
        const matches = (result as { matches: PhotoMatch[] }).matches
        const routines = competition.routines
        // Stash orphans for the drawer.
        setOrphansFromResult(matches)
        try {
          // Fire-and-forget CLIP verification — don't block UI.
          window.api.clipVerifyImport(matches, routines, { skipExact: true })
        } catch {
          // ignore
        }
      }

      if (autoUpload) {
        window.api.uploadAll()
      }
    }).catch((err) => {
      setProgress((prev) => ({
        ...prev,
        stage: 'error',
        message: err instanceof Error ? err.message : String(err),
      }))
    })
  }

  // Guard helper — true if we've already kicked off import for this drive
  // OR an import is in flight. Used by both manual and auto paths to prevent
  // double-fire (e.g. operator clicks "Start Import" during the single-frame
  // flash before the auto-minimize effect runs).
  function fireImportOnce(): void {
    if (!detected || !competition) return
    if (progress.stage !== 'idle') return
    const key = `${detected.drivePath}::${detected.photoCount}`
    if (autoImportFiredRef.current.has(key)) return
    autoImportFiredRef.current.add(key)
    runImport(detected.photoPath)
  }

  function handleStartImport(): void {
    fireImportOnce()
  }

  // Auto-minimize as soon as a drive is detected when auto-import is on, so
  // the full-screen overlay never flashes over the show UI. Runs in a
  // dedicated effect on `detected` change — scheduling this in the same
  // effect as the import-fire below caused a one-frame flash because React
  // renders `detected=true, minimized=false` before the effect body runs.
  useEffect(() => {
    if (!autoImportOnDrive) return
    if (!detected) return
    setMinimizedLocal(true)
  }, [detected, autoImportOnDrive])

  useEffect(() => {
    if (!autoImportOnDrive) return
    if (!detected || !competition) return
    if (progress.stage !== 'idle') return
    const key = `${detected.drivePath}::${detected.photoCount}`
    if (autoImportFiredRef.current.has(key)) return
    autoImportFiredRef.current.add(key)
    // Initialize the Header progress pill AND overlay-mode pill (same
    // module state backs both). The operator sees a soft pill no matter
    // which window mode they're in.
    setMinimized({
      active: true,
      stage: 'scanning',
      current: 0,
      total: detected.photoCount ?? 0,
      message: `SD matched: ${detected.photoCount ?? 0} photos — importing`,
      driveKey: `${detected.drivePath}::${detected.photoCount}`,
    })
    runImport(detected.photoPath)
    // runImport identity changes every render; intentional single-fire guard via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected, competition, autoImportOnDrive, progress.stage])

  function handleStartTether(): void {
    if (!detected) return
    window.api.tetherStart(detected.photoPath)
    setDetected(null)
    setWpdDevice(null)
    setShowResults(false)
  }

  function handleStartWPDTether(): void {
    if (!wpdDevice) return
    window.api.tetherStartWPD(wpdDevice.id)
    setDetected(null)
    setWpdDevice(null)
    setShowResults(false)
  }

  function handleDismiss(): void {
    if (detected) {
      window.api.driveDismiss(detected.drivePath)
    }
    setDetected(null)
    setWpdDevice(null)
    setShowResults(false)
    setMinimizedLocal(false)
    setMinimized({ active: false })
  }

  function handleMinimize(): void {
    // Close the modal UI but leave the import running. Record active state so
    // Header can show the re-open pill. Dismissing (handleDismiss) clears it.
    setMinimizedLocal(true)
    setMinimized({
      active: true,
      driveKey: detected ? detected.drivePath : (wpdDevice?.id ?? null),
    })
  }

  if (!detected && !wpdDevice && !clockMismatch) return null

  const isWorking = ['scanning', 'reading-exif', 'matching', 'copying', 'uploading'].includes(progress.stage)
  const hasCompetition = !!competition
  const recordedCount = competition?.routines?.filter(
    (r) => r.recordingStartedAt && r.recordingStoppedAt,
  ).length ?? 0

  const showPrimaryAlert = (detected || wpdDevice) && !minimized
  const sourceLabel = wpdDevice ? 'MTP/PTP Camera Detected' : 'SD Card Detected'
  const sourceSubtitle = wpdDevice
    ? `${wpdDevice.name}${wpdDevice.manufacturer ? ` — ${wpdDevice.manufacturer}` : ''}`
    : detected
      ? `${detected.label} (${detected.drivePath}) — ${detected.photoCount} photos${detected.isDcim ? ' in DCIM' : ''}`
      : ''

  // Wrong-day camera toast. Previously a blocking modal — converted to a
  // corner toast per operator request (2026-04-19): never block the show UI,
  // always readable at a glance. Auto-dismisses after 20s but click-to-close
  // available. The offset detector runs on import regardless, so this is
  // purely informational.
  const clockMismatchToast = clockMismatch ? (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 60,
        zIndex: 9998,
        maxWidth: 380,
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
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            Camera clock {clockMismatch.daysOffMax} day{clockMismatch.daysOffMax === 1 ? '' : 's'} off
          </div>
          <div style={{ color: '#d4c29a' }}>
            Photos dated {clockMismatch.dominantDate} · today {clockMismatch.todayDate}.
            Import will still run. Large offsets (&gt;60s) are rejected; photos
            outside every recording window fall back to nearest-window matching.
          </div>
        </div>
        <button
          onClick={() => setClockMismatch(null)}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#d4c29a',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 4px',
          }}
          title="Dismiss"
        >{'\u2715'}</button>
      </div>
    </div>
  ) : null

  if (!showPrimaryAlert) {
    return clockMismatchToast
  }

  return (
    <>
      {clockMismatchToast}
      <div className="drive-alert-overlay">
      <div className="drive-alert">
        <div className="da-header">
          <span className="da-icon">{'\u{1F4F7}'}</span>
          <div>
            <div className="da-title">{sourceLabel}</div>
            <div className="da-subtitle">{sourceSubtitle}</div>
          </div>
          <div className="da-header-actions">
            <button
              className="da-close"
              onClick={handleMinimize}
              title="Minimize — import continues in background"
            >
              {'\u2013'}
            </button>
            <button className="da-close" onClick={handleDismiss} title="Dismiss">{'\u2715'}</button>
          </div>
        </div>

        {!hasCompetition && (
          <div className="da-warning">
            Load a competition first to match photos to routines.
          </div>
        )}

        {hasCompetition && recordedCount === 0 && (
          <div className="da-warning">
            No recordings found. Record some routines first so photos can be time-matched.
          </div>
        )}

        {/* Progress display */}
        {isWorking && (
          <div className="da-progress">
            <div className="da-progress-bar">
              <div
                className="da-progress-fill"
                style={{ width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%' }}
              />
            </div>
            <div className="da-progress-text">{progress.message}</div>
          </div>
        )}

        {/* Results */}
        {showResults && progress.stage === 'done' && (
          <div className="da-results">
            <div className="da-result-row">
              <span className="da-result-label">Matched</span>
              <span className="da-result-value success">{progress.matched}</span>
            </div>
            <div className="da-result-row">
              <span className="da-result-label">Unmatched</span>
              <span className="da-result-value muted">{progress.unmatched}</span>
            </div>
            <div className="da-result-row">
              <span className="da-result-label">Total</span>
              <span className="da-result-value">{progress.total}</span>
            </div>
            {autoUpload && (
              <div className="da-auto-note">Auto-upload triggered for matched photos</div>
            )}
            <div className="da-progress-text">{progress.message}</div>
          </div>
        )}

        {progress.stage === 'error' && (
          <div className="da-error">{progress.message}</div>
        )}

        {/* Actions */}
        <div className="da-actions">
          {detected && progress.stage === 'idle' && hasCompetition && recordedCount > 0 && (
            <button className="da-btn primary" onClick={handleStartImport}>
              Match {detected.photoCount} Photos to {recordedCount} Routines
            </button>
          )}
          {detected && progress.stage === 'idle' && hasCompetition && recordedCount > 0 && (
            <button
              className="da-btn"
              disabled={previewBusy}
              onClick={() => runPreview(detected.photoPath)}
              title="Dry-run match without copying files or queueing uploads"
            >
              {previewBusy ? 'Previewing...' : 'Preview Import'}
            </button>
          )}
          {detected && progress.stage === 'idle' && hasCompetition && (
            <button className="da-btn" onClick={handleStartTether} title="Watch this drive for new photos in real-time">
              Watch Live
            </button>
          )}
          {/* WPD/MTP direct watch disabled — use Settings > Photo Tether > Auto-Watch Folder instead */}
          {progress.stage === 'done' && progress.unmatched > 0 && (
            <button className="da-btn" onClick={() => openOrphanReview()} title="Reassign or discard unmatched photos">
              Review Orphans ({progress.unmatched})
            </button>
          )}
          {progress.stage === 'done' && (
            <button className="da-btn" onClick={handleDismiss}>Done</button>
          )}
          {progress.stage === 'error' && (
            <button className="da-btn" onClick={handleStartImport}>Retry</button>
          )}
          {progress.stage !== 'done' && (
            <button className="da-btn dismiss" onClick={handleDismiss}>
              {isWorking ? 'Background' : 'Dismiss'}
            </button>
          )}
        </div>

        {autoUpload && progress.stage === 'idle' && (
          <div className="da-auto-note">Auto-upload is ON — photos will upload after matching</div>
        )}
      </div>
    </div>

    {previewSummary && (
      <div
        className="drive-alert-overlay"
        style={{ zIndex: 10000 }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setPreviewSummary(null)
        }}
      >
        <div
          className="drive-alert"
          style={{
            maxWidth: 560,
            background: '#1a1a24',
            border: '1px solid #3a3a4a',
          }}
        >
          <div className="da-header">
            <span className="da-icon">{'\u{1F50D}'}</span>
            <div>
              <div className="da-title">Preview Import</div>
              <div className="da-subtitle">
                {previewSummary.photosUploaded} would match, {previewSummary.orphaned} orphans,
                {' '}across {previewSummary.routinesUpdated} routine{previewSummary.routinesUpdated === 1 ? '' : 's'}
              </div>
            </div>
            <div className="da-header-actions">
              <button className="da-close" onClick={() => setPreviewSummary(null)}>{'\u2715'}</button>
            </div>
          </div>

          {previewSummary.cameraOffsets && Object.keys(previewSummary.cameraOffsets).length > 0 && (
            <div className="da-auto-note">
              Offsets: {Object.entries(previewSummary.cameraOffsets)
                .map(([b, ms]) => `${b} ${ms > 0 ? '+' : ''}${Math.round(ms / 1000)}s`)
                .join(', ')}
            </div>
          )}

          {(previewSummary.routinesOverMax?.length ?? 0) > 0 && (
            <div className="da-warning">
              {'\u26A0\uFE0F'} {previewSummary.routinesOverMax!.length} routine(s) over max —
              likely mis-match: {previewSummary.routinesOverMax!.slice(0, 5).map((x) => `R${x.entryNumber}=${x.count}>${x.threshold}`).join(', ')}
            </div>
          )}
          {(previewSummary.routinesUnderMin?.length ?? 0) > 0 && (
            <div className="da-warning">
              {'\u26A0\uFE0F'} {previewSummary.routinesUnderMin!.length} recorded routine(s) under min:
              {' '}{previewSummary.routinesUnderMin!.slice(0, 5).map((x) => `R${x.entryNumber}=${x.count}<${x.threshold}`).join(', ')}
            </div>
          )}

          {previewSummary.perRoutine && previewSummary.perRoutine.length > 0 && (
            <div
              style={{
                maxHeight: 200,
                overflowY: 'auto',
                border: '1px solid #2a2a3a',
                borderRadius: 4,
                padding: '6px 10px',
                margin: '10px 0',
                fontSize: 12,
                color: '#c0c0d0',
              }}
            >
              {previewSummary.perRoutine.map((r) => (
                <div key={r.routineId} style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>R{r.entryNumber}</span>
                  <span>{r.count}</span>
                </div>
              ))}
            </div>
          )}

          {previewSummary.previewJsonPath && (
            <div className="da-auto-note" style={{ fontSize: 11 }}>
              Saved to {previewSummary.previewJsonPath}
            </div>
          )}

          <div className="da-actions">
            <button
              className="da-btn primary"
              onClick={() => {
                const folder = previewSummary.folderPath
                setPreviewSummary(null)
                if (folder) {
                  // Run the actual import through the same entry point as
                  // the normal "Start Import" path.
                  runImport(folder)
                }
              }}
            >
              Accept &amp; Import
            </button>
            <button className="da-btn dismiss" onClick={() => setPreviewSummary(null)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
