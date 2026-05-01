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
  const completeCount = useStore((s) => s.completeCount)
  const photosPendingCount = useStore((s) => s.photosPendingCount)

  const total = competition?.routines.length ?? 0
  const recorded = competition?.routines.filter(
    (r) => r.status !== 'pending' && r.status !== 'skipped' && r.status !== 'scratched',
  ).length ?? 0
  const remaining = total - recorded

  async function handleExportReport(): Promise<void> {
    await window.api.exportReport()
  }

  // Proc + Up tiles removed 2026-05-01 per operator at Burlington UDC — they
  // sit at 0 most of the time (queues drain faster than the operator can
  // glance at them) and the space they occupy was load-bearing for the rest
  // of the strip not clipping. PipelineHealthChip already surfaces queue
  // pressure when something IS stuck, which is the only time those tiles
  // actually mattered.
  return (
    <div className="health-strip">
      <div className="health-tile" title="Complete">
        <span className="health-label">Done</span>
        <strong>{completeCount}</strong>
      </div>
      <div className="health-tile" title="Photos pending">
        <span className="health-label">Pix</span>
        <strong>{photosPendingCount}</strong>
      </div>
      <div className="health-tile" title={`Recorded routines (${recorded}/${total})`}>
        <span className="health-label">Rec</span>
        <strong>{recorded}<span className="health-denom">/{total}</span></strong>
      </div>
      <div className="health-tile" title="Remaining routines">
        <span className="health-label">Rem</span>
        <strong>{remaining}</strong>
      </div>
    </div>
  )
}

export default function RightPanel(): React.ReactElement {
  return (
    <div className="right-panel">
      <RoutineTable />
    </div>
  )
}
