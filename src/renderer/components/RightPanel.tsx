import React from 'react'
import { useStore } from '../store/useStore'
import RoutineTable from './RoutineTable'
import type { JobRecord } from '../../shared/types'
import '../styles/rightpanel.css'

export function JobQueuePanel(): React.ReactElement | null {
  const jobQueue = useStore((s) => s.jobQueue)
  const jobQueuePanelOpen = useStore((s) => s.jobQueuePanelOpen)
  const setJobQueuePanelOpen = useStore((s) => s.setJobQueuePanelOpen)

  const pending = jobQueue.filter((j) => j.status === 'pending').length
  const running = jobQueue.filter((j) => j.status === 'running').length
  const failed = jobQueue.filter((j) => j.status === 'failed')
  const quarantined = jobQueue.filter((j) => j.status === 'quarantined')
  const totalActive = pending + running + failed.length + quarantined.length

  if (totalActive === 0 && !jobQueuePanelOpen) return null

  async function handleRetry(job: JobRecord): Promise<void> {
    await window.api.jobQueueRetry(job.id)
  }

  async function handleCancel(job: JobRecord): Promise<void> {
    await window.api.jobQueueCancel(job.id)
  }

  return (
    <div className="job-queue-panel">
      <div
        className="job-queue-header"
        onClick={() => setJobQueuePanelOpen(!jobQueuePanelOpen)}
      >
        <span className="job-queue-title">Jobs</span>
        <div className="job-queue-counts">
          {running > 0 && (
            <span className="jq-badge running">{running} running</span>
          )}
          {pending > 0 && (
            <span className="jq-badge pending">{pending} queued</span>
          )}
          {failed.length > 0 && (
            <span className="jq-badge failed">{failed.length} failed</span>
          )}
          {quarantined.length > 0 && (
            <span className="jq-badge failed">{quarantined.length} quarantined</span>
          )}
        </div>
        <span className="job-queue-toggle">{jobQueuePanelOpen ? '\u25B2' : '\u25BC'}</span>
      </div>
      {jobQueuePanelOpen && (failed.length > 0 || quarantined.length > 0) && (
        <div className="job-queue-list">
          {failed.map((job) => (
            <div key={job.id} className="job-queue-item failed">
              <span className="jq-type">{job.type}</span>
              <span className="jq-error" title={job.error}>{job.error || 'Unknown error'}</span>
              <div className="jq-actions">
                <button className="jq-btn retry" onClick={() => handleRetry(job)}>Retry</button>
                <button className="jq-btn cancel" onClick={() => handleCancel(job)}>Cancel</button>
              </div>
            </div>
          ))}
          {quarantined.map((job) => (
            <div key={job.id} className="job-queue-item failed">
              <span className="jq-type">{job.type}</span>
              <span className="jq-error" title={job.error}>{job.error || 'Quarantined'}</span>
              <div className="jq-actions">
                <button className="jq-btn retry" onClick={() => handleRetry(job)}>Retry</button>
                <button className="jq-btn cancel" onClick={() => handleCancel(job)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function HealthStrip(): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const encodingCount = useStore((s) => s.encodingCount)
  const uploadingCount = useStore((s) => s.uploadingCount)
  const completeCount = useStore((s) => s.completeCount)
  const photosPendingCount = useStore((s) => s.photosPendingCount)
  const jobQueue = useStore((s) => s.jobQueue)

  const activeUploadRoutineCount = new Set(
    jobQueue
      .filter((j) => j.type === 'upload' && (j.status === 'pending' || j.status === 'running'))
      .map((j) => j.routineId),
  ).size
  const visibleUploadingCount = Math.max(uploadingCount, activeUploadRoutineCount)

  const total = competition?.routines.length ?? 0
  const recorded = competition?.routines.filter(
    (r) => r.status !== 'pending' && r.status !== 'skipped' && r.status !== 'scratched',
  ).length ?? 0
  const remaining = total - recorded

  async function handleExportReport(): Promise<void> {
    await window.api.exportReport()
  }

  return (
    <div className="health-strip">
      <div className="health-tile">
        <span className="health-label">Processing</span>
        <strong>{encodingCount}</strong>
      </div>
      <div className="health-tile">
        <span className="health-label">Uploading</span>
        <strong>{visibleUploadingCount}</strong>
      </div>
      <div className="health-tile">
        <span className="health-label">Complete</span>
        <strong>{completeCount}</strong>
      </div>
      <div className="health-tile">
        <span className="health-label">Photos</span>
        <strong>{photosPendingCount}</strong>
      </div>
      <div className="health-tile">
        <span className="health-label">Recorded</span>
        <strong>{recorded} / {total}</strong>
      </div>
      <div className="health-tile">
        <span className="health-label">Remaining</span>
        <strong>{remaining}</strong>
      </div>
      <button
        className="output-dir-change health-export"
        onClick={handleExportReport}
        title="Export session report (CSV)"
      >
        Export Report
      </button>
    </div>
  )
}

export default function RightPanel(): React.ReactElement {
  const searchQuery = useStore((s) => s.searchQuery)
  const setSearchQuery = useStore.getState().setSearchQuery

  return (
    <div className="right-panel">
      <div className="right-header schedule-header">
        <input
          type="text"
          className="search-input"
          placeholder="Search # / name / studio..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            flex: '0 1 240px',
            padding: '4px 10px',
            fontSize: '11px',
            border: '1px solid var(--border)',
            borderRadius: '3px',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
          }}
        />
        <div className="section-title" style={{ marginBottom: 0, marginLeft: 'auto' }}>
          Schedule
        </div>
      </div>
      <RoutineTable />
    </div>
  )
}
