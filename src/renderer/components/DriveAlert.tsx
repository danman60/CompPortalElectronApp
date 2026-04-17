import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { DriveDetectedEvent, WPDDevice, WPDDeviceEvent, PhotoMatch } from '../../shared/types'
import '../styles/drive-alert.css'

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

export default function DriveAlert(): React.ReactElement | null {
  const [detected, setDetected] = useState<DriveDetectedEvent | null>(null)
  const [wpdDevice, setWpdDevice] = useState<WPDDevice | null>(null)
  const [progress, setProgress] = useState<ImportProgress>({
    stage: 'idle', message: '', current: 0, total: 0, matched: 0, unmatched: 0, copied: 0, uploadQueued: 0,
  })
  const [showResults, setShowResults] = useState(false)
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
    })

    return () => { unsubDrive(); unsubWPD(); unsubProgress(); unsubResult() }
  }, [])

  function runImport(photoPath: string): void {
    if (!competition) return
    setProgress((prev) => ({ ...prev, stage: 'scanning', message: `Scanning ${photoPath}...` }))

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

  function handleStartImport(): void {
    if (!detected || !competition) return
    runImport(detected.photoPath)
  }

  useEffect(() => {
    if (!autoImportOnDrive) return
    if (!detected || !competition) return
    if (progress.stage !== 'idle') return
    const key = `${detected.drivePath}::${detected.photoCount}`
    if (autoImportFiredRef.current.has(key)) return
    autoImportFiredRef.current.add(key)
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
  }

  if (!detected && !wpdDevice) return null

  const isWorking = ['scanning', 'reading-exif', 'matching', 'copying', 'uploading'].includes(progress.stage)
  const hasCompetition = !!competition
  const recordedCount = competition?.routines?.filter(
    (r) => r.recordingStartedAt && r.recordingStoppedAt,
  ).length ?? 0

  const sourceLabel = wpdDevice ? 'MTP/PTP Camera Detected' : 'SD Card Detected'
  const sourceSubtitle = wpdDevice
    ? `${wpdDevice.name}${wpdDevice.manufacturer ? ` — ${wpdDevice.manufacturer}` : ''}`
    : `${detected!.label} (${detected!.drivePath}) — ${detected!.photoCount} photos${detected!.isDcim ? ' in DCIM' : ''}`

  return (
    <div className="drive-alert-overlay">
      <div className="drive-alert">
        <div className="da-header">
          <span className="da-icon">{'\u{1F4F7}'}</span>
          <div>
            <div className="da-title">{sourceLabel}</div>
            <div className="da-subtitle">{sourceSubtitle}</div>
          </div>
          <button className="da-close" onClick={handleDismiss}>{'\u2715'}</button>
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
          {detected && progress.stage === 'idle' && hasCompetition && (
            <button className="da-btn" onClick={handleStartTether} title="Watch this drive for new photos in real-time">
              Watch Live
            </button>
          )}
          {/* WPD/MTP direct watch disabled — use Settings > Photo Tether > Auto-Watch Folder instead */}
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
  )
}
