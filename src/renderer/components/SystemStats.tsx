import React from 'react'
import { useStore } from '../store/useStore'

export default function SystemStats(): React.ReactElement {
  const stats = useStore((s) => s.systemStats)
  const encodingCount = useStore((s) => s.encodingCount)
  const uploadingCount = useStore((s) => s.uploadingCount)
  const completeCount = useStore((s) => s.completeCount)

  const cpu = stats ? Math.round(stats.cpuPercent) : null
  const diskFree = stats ? stats.diskFreeGB : null
  const diskTotal = stats ? stats.diskTotalGB : null
  const mem = stats?.memPercent != null ? Math.round(stats.memPercent) : null

  const diskPct = (diskFree != null && diskTotal && diskTotal > 0)
    ? Math.round(100 - (diskFree / diskTotal) * 100)
    : null

  return (
    <div className="panel-sysstats">
      <div className="sys-row">
        <span className="sys-label">CPU</span>
        <span className={`sys-value ${cpuClass(cpu)}`}>{cpu != null ? `${cpu}%` : '—'}</span>
      </div>
      {mem != null && (
        <div className="sys-row">
          <span className="sys-label">RAM</span>
          <span className={`sys-value ${cpuClass(mem)}`}>{mem}%</span>
        </div>
      )}
      <div className="sys-row">
        <span className="sys-label">Disk</span>
        <span className={`sys-value ${diskClass(diskFree)}`}>
          {diskFree != null ? `${diskFree.toFixed(1)} GB free` : '—'}
          {diskPct != null && <span className="sys-sub"> ({diskPct}% used)</span>}
        </span>
      </div>
      <div className="sys-divider" />
      <div className="sys-row">
        <span className="sys-label">Encoding</span>
        <span className="sys-value">{encodingCount}</span>
      </div>
      <div className="sys-row">
        <span className="sys-label">Uploading</span>
        <span className="sys-value">{uploadingCount}</span>
      </div>
      <div className="sys-row">
        <span className="sys-label">Complete</span>
        <span className="sys-value ok">{completeCount}</span>
      </div>
    </div>
  )
}

function cpuClass(value: number | null): string {
  if (value == null) return ''
  if (value >= 90) return 'danger'
  if (value >= 70) return 'warn'
  return ''
}

function diskClass(freeGB: number | null): string {
  if (freeGB == null) return ''
  if (freeGB < 10) return 'danger'
  if (freeGB < 30) return 'warn'
  return ''
}
