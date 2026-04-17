import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import type { PhotoMatch } from '../../shared/types'
import '../styles/orphan-review.css'

// Module-level snapshot + listener set. DriveAlert pushes orphans here after
// the latest import; the drawer subscribes. Keeps App.tsx plumbing minimal
// (no store changes for a drawer that's only ever relevant post-import).
let orphansSnapshot: PhotoMatch[] = []
let openSnapshot = false
const listeners = new Set<() => void>()
function notify(): void { for (const fn of listeners) { try { fn() } catch {} } }

export function setOrphansFromResult(matches: PhotoMatch[] | undefined): void {
  if (!matches) return
  orphansSnapshot = matches.filter(m => m.confidence === 'unmatched')
  notify()
}

export function openOrphanReview(): void {
  openSnapshot = true
  notify()
}

export function closeOrphanReview(): void {
  openSnapshot = false
  notify()
}

export function useOrphanState(): { open: boolean; orphans: PhotoMatch[] } {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = (): void => force((n) => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return { open: openSnapshot, orphans: orphansSnapshot }
}

export default function OrphanReview(): React.ReactElement | null {
  const { open, orphans } = useOrphanState()
  const competition = useStore((s) => s.competition)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [localOrphans, setLocalOrphans] = useState<PhotoMatch[]>(orphans)

  useEffect(() => { setLocalOrphans(orphans) }, [orphans])

  if (!open) return null

  async function onReassign(orphan: PhotoMatch, routineId: string): Promise<void> {
    if (!routineId) return
    setBusyPath(orphan.filePath)
    try {
      const res = await window.api.photosReassignOrphan(orphan.filePath, routineId) as { ok: boolean; error?: string }
      if (res && res.ok) {
        setLocalOrphans((prev) => prev.filter(o => o.filePath !== orphan.filePath))
      } else {
        alert(`Reassign failed: ${res?.error || 'unknown'}`)
      }
    } finally {
      setBusyPath(null)
    }
  }

  async function onDiscard(orphan: PhotoMatch): Promise<void> {
    if (!confirm(`Delete ${orphan.filePath.split(/[\\/]/).pop()}?`)) return
    setBusyPath(orphan.filePath)
    try {
      const res = await window.api.photosDiscardOrphan(orphan.filePath) as { ok: boolean; error?: string }
      if (res && res.ok) {
        setLocalOrphans((prev) => prev.filter(o => o.filePath !== orphan.filePath))
      } else {
        alert(`Discard failed: ${res?.error || 'unknown'}`)
      }
    } finally {
      setBusyPath(null)
    }
  }

  const routines = competition?.routines || []

  return (
    <div className="orphan-drawer">
      <div className="or-header">
        <div className="or-title">Orphan Review</div>
        <button className="or-close" onClick={() => closeOrphanReview()}>{'\u2715'}</button>
      </div>
      {localOrphans.length === 0 ? (
        <div className="or-empty">No orphans. Every imported photo was matched to a routine.</div>
      ) : (
        <div className="or-list">
          {localOrphans.map((o) => {
            const fileName = o.filePath.split(/[\\/]/).pop() || o.filePath
            const isBusy = busyPath === o.filePath
            return (
              <div key={o.filePath} className={`or-row${isBusy ? ' busy' : ''}`}>
                <div className="or-filename" title={o.filePath}>{fileName}</div>
                <div className="or-meta">EXIF: {o.captureTime}</div>
                <div className="or-meta or-path" title={o.filePath}>{o.filePath}</div>
                <div className="or-actions">
                  <select
                    className="or-select"
                    defaultValue=""
                    disabled={isBusy}
                    onChange={(e) => onReassign(o, e.target.value)}
                  >
                    <option value="" disabled>Reassign to…</option>
                    {routines.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.entryNumber} — {r.routineTitle}
                      </option>
                    ))}
                  </select>
                  <button
                    className="or-btn or-discard"
                    onClick={() => onDiscard(o)}
                    disabled={isBusy}
                    title="Delete this orphan"
                  >
                    Discard
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
