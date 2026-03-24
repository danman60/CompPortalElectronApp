import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import type { DriveDetectedEvent } from '../../shared/types'
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
  const [progress, setProgress] = useState<ImportProgress>({
    stage: 'idle', message: '', current: 0, total: 0, matched: 0, unmatched: 0, copied: 0, uploadQueued: 0,
  })
  const [showResults, setShowResults] = useState(false)
  const competition = useStore((s) => s.competition)
  const settings = useStore((s) => s.settings)
  const autoUpload = settings?.behavior?.autoUploadAfterEncoding ?? false

  useEffect(() => {
    const unsubDrive = window.api.on('drive:detected', (data: unknown) => {
      setDetected(data as DriveDetectedEvent)
      setProgress({ stage: 'idle', message: '', current: 0, total: 0, matched: 0, unmatched: 0, copied: 0, uploadQueued: 0 })
      setShowResults(false)
    })

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

    return () => { unsubDrive(); unsubProgress(); unsubResult() }
  }, [])

  async function handleStartImport(): Promise<void> {
    if (!detected || !competition) return
    setProgress((prev) => ({ ...prev, stage: 'scanning', message: `Scanning ${detected.photoPath}...` }))
    try {
      const result = await window.api.photosImport(detected.photoPath)
      // Check for safeHandle error
      if (result && typeof result === 'object' && 'error' in result) {
        setProgress((prev) => ({
          ...prev,
          stage: 'error',
          message: (result as { error: string }).error,
        }))
        return
      }

      // If auto-upload is on, trigger upload
      if (autoUpload) {
        setProgress((prev) => ({ ...prev, stage: 'uploading', message: 'Auto-uploading photos...' }))
        await window.api.uploadAll()
      }
    } catch (err) {
      setProgress((prev) => ({
        ...prev,
        stage: 'error',
        message: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  function handleDismiss(): void {
    if (detected) {
      window.api.driveDismiss(detected.drivePath)
    }
    setDetected(null)
    setShowResults(false)
  }

  if (!detected) return null

  const isWorking = ['scanning', 'reading-exif', 'matching', 'copying', 'uploading'].includes(progress.stage)
  const hasCompetition = !!competition
  const recordedCount = competition?.routines?.filter(
    (r) => r.recordingStartedAt && r.recordingStoppedAt,
  ).length ?? 0

  return (
    <div className="drive-alert-overlay">
      <div className="drive-alert">
        <div className="da-header">
          <span className="da-icon">{'\u{1F4F7}'}</span>
          <div>
            <div className="da-title">SD Card Detected</div>
            <div className="da-subtitle">
              {detected.label} ({detected.drivePath}) — {detected.photoCount} photos
              {detected.isDcim ? ' in DCIM' : ''}
            </div>
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
          {progress.stage === 'idle' && hasCompetition && recordedCount > 0 && (
            <button className="da-btn primary" onClick={handleStartImport}>
              Match {detected.photoCount} Photos to {recordedCount} Routines
            </button>
          )}
          {progress.stage === 'done' && (
            <button className="da-btn" onClick={handleDismiss}>Done</button>
          )}
          {progress.stage === 'error' && (
            <button className="da-btn" onClick={handleStartImport}>Retry</button>
          )}
          {!isWorking && progress.stage !== 'done' && (
            <button className="da-btn dismiss" onClick={handleDismiss}>Dismiss</button>
          )}
        </div>

        {autoUpload && progress.stage === 'idle' && (
          <div className="da-auto-note">Auto-upload is ON — photos will upload after matching</div>
        )}
      </div>
    </div>
  )
}
