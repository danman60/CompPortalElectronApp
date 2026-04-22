import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { IPC_CHANNELS, type Routine } from '../../shared/types'
import '../styles/media-audit.css'

interface AuditRunResult {
  scanned: number
  repaired: number
  queued: number
  errors: string[]
  scope: string
  tookMs: number
  endpointAvailable: boolean
  skippedReason?: string
}

interface RoutineAudit {
  routine: Routine
  issues: string[]
  videosUploaded: number
  videosTotal: number
  photosUploaded: number
  photosTotal: number
  thumbsMissing: number
  keyframesPresent: number
}

function buildRoutineAudit(routine: Routine): RoutineAudit {
  const photos = routine.photos || []
  const encodedFiles = routine.encodedFiles || []
  const videosUploaded = encodedFiles.filter((file) => file.uploaded).length
  const photosUploaded = photos.filter((photo) => photo.uploaded).length
  const thumbsMissing = photos.filter((photo) => photo.uploaded && !photo.thumbnailStoragePath).length
  const keyframesPresent = (routine.keyframes || []).filter(Boolean).length
  const hasMediaState = routine.status !== 'pending' && routine.status !== 'skipped' && routine.status !== 'scratched'

  const issues: string[] = []
  if (routine.status === 'failed' || routine.error) issues.push('Error')
  if (hasMediaState && encodedFiles.length === 0 && !['recording', 'recorded', 'encoding', 'queued'].includes(routine.status)) {
    issues.push('Missing video')
  }
  if (encodedFiles.length > 0 && videosUploaded < encodedFiles.length) issues.push('Video upload pending')
  if (hasMediaState && photos.length === 0) issues.push('No photos matched')
  if (photos.length > 0 && photosUploaded < photos.length) issues.push('Photo upload pending')
  if (thumbsMissing > 0) issues.push('Missing thumbnails')
  if (encodedFiles.length > 0 && keyframesPresent < 3) issues.push('Missing keyframes')
  if (routine.notes) issues.push('Operator note')
  if (routine.status === 'scratched') issues.push('Scratched')

  return {
    routine,
    issues,
    videosUploaded,
    videosTotal: encodedFiles.length,
    photosUploaded,
    photosTotal: photos.length,
    thumbsMissing,
    keyframesPresent,
  }
}

export default function MediaAuditPanel(): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const jobQueue = useStore((s) => s.jobQueue)
  const currentRoutine = useStore((s) => s.currentRoutine)
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [auditBusy, setAuditBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [lastAudit, setLastAudit] = useState<AuditRunResult | null>(null)

  const routines = competition?.routines ?? []
  const audits = routines
    .map(buildRoutineAudit)
    .sort((a, b) => {
      if (b.issues.length !== a.issues.length) return b.issues.length - a.issues.length
      return a.routine.position - b.routine.position
    })

  const selectedAudit = audits.find((audit) => audit.routine.id === selectedRoutineId) || audits[0] || null

  useEffect(() => {
    if (!selectedAudit) return
    setSelectedRoutineId(selectedAudit.routine.id)
    setNoteDraft(selectedAudit.routine.notes || '')
  }, [selectedAudit?.routine.id, selectedAudit?.routine.notes])

  useEffect(() => {
    if (!window.api) return
    const off = window.api.on(IPC_CHANNELS.MEDIA_RECONCILE_RESULT, (data: unknown) => {
      setLastAudit(data as AuditRunResult)
    })
    return () => { try { off() } catch {} }
  }, [])

  async function handleRunAudit(): Promise<void> {
    setAuditBusy(true)
    try {
      const result = await window.api.mediaReconcileRun('manual') as AuditRunResult
      setLastAudit(result)
    } finally {
      setAuditBusy(false)
    }
  }

  async function handleExportVerification(): Promise<void> {
    setExportBusy(true)
    try {
      await window.api.exportVerificationReport()
    } finally {
      setExportBusy(false)
    }
  }

  async function handleJumpToRoutine(routine: Routine): Promise<void> {
    await window.api.jumpToRoutine(routine.id)
  }

  async function handleOpenMedia(routine: Routine): Promise<void> {
    const dir = routine.outputDir || (routine.outputPath ? routine.outputPath.replace(/[/\\][^/\\]+$/, '') : '')
    if (dir) await window.api.openPath(dir)
  }

  async function handleSaveNote(routine: Routine): Promise<void> {
    await window.api.setRoutineNote(routine.id, noteDraft.trim())
  }

  const routinesWithIssues = audits.filter((audit) => audit.issues.some((issue) => issue !== 'Operator note')).length
  const pendingPhotoRoutines = audits.filter((audit) => audit.issues.includes('Photo upload pending')).length
  const pendingVideoRoutines = audits.filter((audit) => audit.issues.includes('Video upload pending') || audit.issues.includes('Missing video')).length
  const thumbIssueRoutines = audits.filter((audit) => audit.issues.includes('Missing thumbnails')).length
  const activeJobs = jobQueue.filter((job) => job.status === 'pending' || job.status === 'running').length

  return (
    <div className="media-audit-panel">
      <div className="media-audit-header">
        <div>
          <div className="section-title" style={{ marginBottom: 2 }}>Media Audit</div>
          <div className="media-audit-subtitle">
            Main-window audit and routine drilldown. Overlay mode stays unchanged.
          </div>
        </div>
        <div className="media-audit-actions">
          <button className="audit-btn" onClick={handleRunAudit} disabled={auditBusy}>
            {auditBusy ? 'Running Audit...' : 'Run Audit Now'}
          </button>
          <button className="audit-btn secondary" onClick={handleExportVerification} disabled={exportBusy}>
            {exportBusy ? 'Exporting...' : 'Export EOD Report'}
          </button>
        </div>
      </div>

      <div className="media-audit-summary">
        <div className="audit-card"><strong>{routinesWithIssues}</strong><span>Routines with issues</span></div>
        <div className="audit-card"><strong>{pendingPhotoRoutines}</strong><span>Photo upload issues</span></div>
        <div className="audit-card"><strong>{pendingVideoRoutines}</strong><span>Video upload issues</span></div>
        <div className="audit-card"><strong>{thumbIssueRoutines}</strong><span>Thumbnail issues</span></div>
        <div className="audit-card"><strong>{activeJobs}</strong><span>Active queue jobs</span></div>
        <div className="audit-card accent"><strong>{currentRoutine?.entryNumber || '—'}</strong><span>Current routine</span></div>
      </div>

      <div className="media-audit-body">
        <div className="audit-routine-list">
          {audits.length === 0 && <div className="audit-empty">Load a competition to inspect media health.</div>}
          {audits.map((audit) => (
            <button
              key={audit.routine.id}
              className={`audit-routine-row${selectedAudit?.routine.id === audit.routine.id ? ' selected' : ''}`}
              onClick={() => setSelectedRoutineId(audit.routine.id)}
            >
              <div className="audit-routine-top">
                <span className="audit-entry">{audit.routine.entryNumber}</span>
                <span className="audit-title">{audit.routine.routineTitle}</span>
              </div>
              <div className="audit-routine-meta">
                <span>{audit.routine.studioCode || audit.routine.studioName}</span>
                <span>{audit.routine.status}</span>
                <span>{audit.photosUploaded}/{audit.photosTotal} photos</span>
                <span>{audit.videosUploaded}/{audit.videosTotal} videos</span>
              </div>
              <div className="audit-issue-tags">
                {(audit.issues.length > 0 ? audit.issues : ['OK']).slice(0, 3).map((issue) => (
                  <span key={issue} className={`audit-tag${issue === 'OK' ? ' ok' : ''}`}>{issue}</span>
                ))}
              </div>
            </button>
          ))}
        </div>

        <div className="audit-detail">
          {!selectedAudit && <div className="audit-empty">No routine selected.</div>}
          {selectedAudit && (
            <>
              <div className="audit-detail-header">
                <div>
                  <div className="audit-detail-entry">#{selectedAudit.routine.entryNumber} · {selectedAudit.routine.routineTitle}</div>
                  <div className="audit-detail-meta">
                    {selectedAudit.routine.studioName} · {selectedAudit.routine.ageGroup} {selectedAudit.routine.category} · {selectedAudit.routine.status}
                  </div>
                </div>
                <div className="audit-detail-actions">
                  <button className="audit-btn secondary" onClick={() => handleJumpToRoutine(selectedAudit.routine)}>Jump To</button>
                  <button className="audit-btn secondary" onClick={() => handleOpenMedia(selectedAudit.routine)} disabled={!selectedAudit.routine.outputDir && !selectedAudit.routine.outputPath}>Open Media</button>
                </div>
              </div>

              <div className="audit-check-grid">
                <div className="audit-check"><span>Videos</span><strong>{selectedAudit.videosUploaded}/{selectedAudit.videosTotal}</strong></div>
                <div className="audit-check"><span>Photos</span><strong>{selectedAudit.photosUploaded}/{selectedAudit.photosTotal}</strong></div>
                <div className="audit-check"><span>Thumbs Missing</span><strong>{selectedAudit.thumbsMissing}</strong></div>
                <div className="audit-check"><span>Keyframes</span><strong>{selectedAudit.keyframesPresent}/3</strong></div>
              </div>

              <div className="audit-issues-block">
                <div className="audit-block-title">Audit flags</div>
                <div className="audit-issue-tags detail">
                  {(selectedAudit.issues.length > 0 ? selectedAudit.issues : ['OK']).map((issue) => (
                    <span key={issue} className={`audit-tag${issue === 'OK' ? ' ok' : ''}`}>{issue}</span>
                  ))}
                </div>
                {selectedAudit.routine.error && (
                  <div className="audit-error">{selectedAudit.routine.error}</div>
                )}
              </div>

              <div className="audit-notes-block">
                <div className="audit-block-title">Routine note</div>
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="Operator notes for end-of-day verification..."
                />
                <div className="audit-note-actions">
                  <button className="audit-btn secondary" onClick={() => setNoteDraft(selectedAudit.routine.notes || '')}>Reset</button>
                  <button className="audit-btn" onClick={() => handleSaveNote(selectedAudit.routine)}>Save Note</button>
                </div>
              </div>

              <div className="audit-last-run">
                {lastAudit
                  ? `Last audit: scanned ${lastAudit.scanned}, repaired ${lastAudit.repaired}, queued ${lastAudit.queued}, errors ${lastAudit.errors.length}, ${lastAudit.tookMs}ms.`
                  : 'No manual audit run yet in this session.'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
