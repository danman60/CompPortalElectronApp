import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { Routine, RoutineStatus } from '../../shared/types'
import '../styles/table.css'

// ── Pipeline stage indicators ──────────────────────────────────────
// Each routine progresses: Record → Split → Photos → Upload
// The status column shows a compact pipeline with per-stage icons

type StageState = 'inactive' | 'active' | 'done' | 'error'

interface PipelineStage {
  label: string
  state: StageState
  detail?: string // tooltip or sub-text
}

interface MediaUploadSummary {
  totalVideos: number
  uploadedVideos: number
  totalPhotos: number
  uploadedPhotos: number
  hasVideos: boolean
  hasPhotos: boolean
  allVideosUploaded: boolean
  allPhotosUploaded: boolean
  allMediaUploaded: boolean
}

type PortalPackageStatus = NonNullable<Routine['mediaPackageStatus']>

function getMediaUploadSummary(routine: Routine, judgeCount: number): MediaUploadSummary {
  const totalVideos = judgeCount + 1
  const uploadedVideos = routine.encodedFiles?.filter((f) => f.uploaded).length ?? 0
  const totalPhotos = routine.photos?.length ?? 0
  const uploadedPhotos = routine.photos?.filter((p) => p.uploaded).length ?? 0
  const hasVideos = (routine.encodedFiles?.length ?? 0) > 0
  const hasPhotos = totalPhotos > 0
  const allVideosUploaded = !hasVideos || uploadedVideos >= totalVideos
  const allPhotosUploaded = !hasPhotos || uploadedPhotos >= totalPhotos

  return {
    totalVideos,
    uploadedVideos,
    totalPhotos,
    uploadedPhotos,
    hasVideos,
    hasPhotos,
    allVideosUploaded,
    allPhotosUploaded,
    allMediaUploaded: allVideosUploaded && allPhotosUploaded,
  }
}

function getPortalStatusMeta(
  routine: Routine,
): { text: string; className: string } | null {
  const status = routine.mediaPackageStatus
  switch (status) {
    case 'none':
      return { text: 'Portal None', className: 'portal-none' }
    case 'pending':
      return { text: 'Portal Pending', className: 'portal-pending' }
    case 'processing':
      return { text: 'Portal Processing', className: 'portal-processing' }
    case 'ready':
      return { text: 'Portal Ready', className: 'portal-ready' }
    case 'complete':
      return { text: 'Portal Complete', className: 'portal-complete' }
    case 'published':
      return { text: 'Portal Published', className: 'portal-published' }
    default:
      return null
  }
}

function getPipeline(routine: Routine, judgeCount: number): PipelineStage[] {
  const media = getMediaUploadSummary(routine, judgeCount)
  const total = media.totalVideos
  const encoded = routine.encodedFiles?.length ?? 0
  const photoCount = media.totalPhotos
  const photosUploaded = media.uploadedPhotos
  const portalStatus = routine.mediaPackageStatus

  // Stage 1: Record
  const rec: PipelineStage = { label: 'REC', state: 'inactive' }
  if (routine.status === 'recording') {
    rec.state = 'active'
    rec.detail = 'Recording now'
  } else if (routine.status !== 'pending' && routine.status !== 'skipped' && routine.status !== 'scratched') {
    rec.state = 'done'
    rec.detail = routine.outputPath ? 'MKV saved' : 'Recorded'
  }

  // Stage 2: Split (FFmpeg encode into performance + judge tracks)
  const split: PipelineStage = { label: 'SPLIT', state: 'inactive' }
  if (routine.status === 'queued') {
    split.state = 'inactive'
    split.detail = 'Queued for encoding'
  } else if (routine.status === 'encoding') {
    split.state = 'active'
    split.detail = `Splitting ${encoded}/${total} tracks`
  } else if (encoded >= total) {
    split.state = 'done'
    split.detail = `${encoded}/${total} tracks ready`
  } else if (encoded > 0) {
    split.state = 'done'
    split.detail = `${encoded}/${total} tracks (partial)`
  } else if (routine.status === 'recorded') {
    split.state = 'inactive'
    split.detail = 'Awaiting encode'
  }

  // Stage 3: Photos
  const photos: PipelineStage = { label: 'PHOTO', state: 'inactive' }
  const thumbCount = routine.photos?.filter(p => p.thumbnailPath).length ?? 0
  if (photoCount > 0 && photosUploaded === photoCount) {
    photos.state = 'done'
    photos.detail = `${photoCount} uploaded`
  } else if (photoCount > 0 && photosUploaded > 0) {
    photos.state = 'active'
    photos.detail = `${photosUploaded}/${photoCount} uploaded`
  } else if (photoCount > 0 && thumbCount < photoCount) {
    photos.state = 'active'
    photos.detail = `${photoCount} matched, ${thumbCount}/${photoCount} thumbs`
  } else if (photoCount > 0) {
    photos.state = 'done'
    photos.detail = `${photoCount} matched`
  }
  // If no photos, stays inactive (dash)

  // Stage 4: Upload
  const upload: PipelineStage = { label: 'UP', state: 'inactive' }
  if (routine.status === 'failed') {
    upload.state = 'error'
    upload.detail = routine.error || 'Upload failed'
  } else if (routine.status === 'uploaded' || routine.status === 'confirmed') {
    upload.state = 'done'
    if (routine.status === 'confirmed') {
      upload.detail = portalStatus === 'published'
        ? 'Portal package is published'
        : media.allMediaUploaded
          ? 'Server package acknowledged'
          : `Server package present, photos ${photosUploaded}/${photoCount}`
    } else if (media.allMediaUploaded) {
      upload.detail = `Videos ${media.uploadedVideos}/${total}, photos ${photosUploaded}/${photoCount}`
    } else {
      upload.detail = `Videos ${media.uploadedVideos}/${total}, photos ${photosUploaded}/${photoCount}`
    }
  } else if (routine.status === 'uploading') {
    upload.state = 'active'
    const pct = routine.uploadProgress?.percent
    const cur = routine.uploadProgress?.currentFile
    const done = routine.uploadProgress?.filesCompleted ?? 0
    const tot = routine.uploadProgress?.filesTotal ?? 0
    upload.detail = pct !== undefined
      ? `${done}/${tot} files — ${pct}%${cur ? ` (${cur})` : ''}`
      : `${done}/${tot} files`
  } else if (media.uploadedVideos > 0 || photosUploaded > 0) {
    upload.state = 'active'
    upload.detail = `Videos ${media.uploadedVideos}/${total}, photos ${photosUploaded}/${photoCount}`
  }

  return [rec, split, photos, upload]
}

function stageIcon(state: StageState): string {
  switch (state) {
    case 'done': return '\u2713'     // ✓
    case 'active': return '\u25CF'   // ●
    case 'error': return '\u2717'    // ✗
    case 'inactive': return '\u2014' // —
  }
}

function stageClass(state: StageState): string {
  switch (state) {
    case 'done': return 'stage-done'
    case 'active': return 'stage-active'
    case 'error': return 'stage-error'
    case 'inactive': return 'stage-inactive'
  }
}

// Overall status text for the primary label
function statusToLabel(routine: Routine, judgeCount: number): { text: string; className: string } {
  const status = routine.status
  const media = getMediaUploadSummary(routine, judgeCount)
  const portalStatus = routine.mediaPackageStatus
  switch (status) {
    case 'pending':
      return { text: 'Waiting', className: 'waiting' }
    case 'skipped':
      return { text: 'Skipped', className: 'waiting' }
    case 'scratched':
      return { text: 'Scratched', className: 'scratched' }
    case 'recording':
      return { text: 'RECORDING', className: 'recording' }
    case 'recorded':
      return { text: 'Recorded — awaiting encode', className: 'processing' }
    case 'queued':
      return { text: 'Queued for encoding', className: 'waiting' }
    case 'encoding':
      return { text: 'Splitting tracks...', className: 'processing' }
    case 'encoded':
      return { text: 'Videos Rendered', className: 'complete' }
    case 'uploading':
      return { text: 'Uploading', className: 'uploading' }
    case 'uploaded': {
      if (media.allMediaUploaded) return { text: 'All Media Uploaded', className: 'complete' }
      return { text: 'Videos Uploaded', className: 'video-only' }
    }
    case 'confirmed':
      if (portalStatus === 'published') {
        return { text: 'Portal Published', className: 'complete' }
      }
      return media.allMediaUploaded
        ? { text: 'Server Package Present', className: 'complete' }
        : { text: 'Videos Synced', className: 'video-only' }
    case 'failed':
      return { text: 'Failed', className: 'failed' }
    default:
      return { text: status, className: 'waiting' }
  }
}

function getProgressPercent(routine: Routine, judgeCount: number): number {
  const media = getMediaUploadSummary(routine, judgeCount)
  switch (routine.status) {
    case 'pending':
    case 'skipped':
    case 'scratched':
      return 0
    case 'recording':
      return 15
    case 'recorded':
      return 25
    case 'queued':
      return 30
    case 'encoding':
      return 50
    case 'encoded':
      return 70
    case 'uploading':
      return routine.uploadProgress?.percent
        ? 70 + (routine.uploadProgress.percent * 0.3)
        : 75
    case 'uploaded':
      return media.allMediaUploaded ? 100 : 85
    case 'confirmed':
      return media.allMediaUploaded ? 100 : 90
    case 'failed':
      return 0
    default:
      return 0
  }
}

function getBarClass(status: RoutineStatus, routine: Routine, judgeCount: number): string {
  const media = getMediaUploadSummary(routine, judgeCount)
  switch (status) {
    case 'recording':
      return 'recording'
    case 'encoding':
    case 'recorded':
    case 'queued':
      return 'processing'
    case 'uploading':
      return 'uploading'
    case 'uploaded':
      return media.allMediaUploaded ? 'complete' : 'video-only'
    case 'confirmed':
      return media.allMediaUploaded ? 'complete' : 'video-only'
    case 'encoded':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'scratched':
      return 'scratched'
    default:
      return ''
  }
}

// ── Session-aware visual grouping ─────────────────────────────────
// Sessions are inferred client-side from gaps between consecutive routines.
// TODO: move to AppSettings.schedule.sessionGapMinutes if operators need tunable thresholds.
const SESSION_GAP_MIN = 15

type GroupedItem =
  | { type: 'routine'; routine: Routine }
  | { type: 'day-header'; dayLabel: string; dayKey: string }
  | { type: 'session-divider'; sessionNumber: number; gapMinutes: number; idleStartTime: string; idleEndTime: string }

function parseHHMMToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + (m || 0)
}

function formatMinutesToHHMM(min: number): string {
  const normalized = ((min % 1440) + 1440) % 1440
  const h = Math.floor(normalized / 60)
  const m = normalized % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatDayLabel(dayString: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dayString)) {
    const d = new Date(dayString + 'T00:00:00')
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  }
  return dayString || 'Unknown Day'
}

function buildGroupedList(routines: Routine[], options: { showDayHeaders: boolean }): GroupedItem[] {
  const result: GroupedItem[] = []
  let lastDay: string | null = null
  let lastEndMin: number | null = null
  let sessionNumber = 1

  for (const routine of routines) {
    const currentDay = routine.scheduledDay || ''

    if (currentDay !== lastDay) {
      if (options.showDayHeaders) {
        result.push({
          type: 'day-header',
          dayLabel: formatDayLabel(currentDay),
          dayKey: currentDay,
        })
      }
      lastDay = currentDay
      lastEndMin = null
      sessionNumber = 1
    }

    if (routine.scheduledTime) {
      const startMin = parseHHMMToMinutes(routine.scheduledTime)
      const duration = routine.durationMinutes || 3

      if (lastEndMin !== null) {
        let gap = startMin - lastEndMin
        // midnight rollover — if the routine wraps past 24h, re-anchor
        if (gap < -12 * 60) gap += 24 * 60
        if (gap >= SESSION_GAP_MIN) {
          sessionNumber++
          result.push({
            type: 'session-divider',
            sessionNumber,
            gapMinutes: Math.round(gap),
            idleStartTime: formatMinutesToHHMM(lastEndMin),
            idleEndTime: formatMinutesToHHMM(startMin),
          })
        }
      }

      result.push({ type: 'routine', routine })
      lastEndMin = startMin + duration
    } else {
      result.push({ type: 'routine', routine })
    }
  }

  return result
}

interface NoteEditorExternalOpen {
  routineId: string
  seq: number
}

function NoteEditor({
  routine,
  externalOpen,
}: {
  routine: Routine
  externalOpen?: NoteEditorExternalOpen | null
}): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(routine.notes || '')
  const lastSeqRef = useRef<number>(-1)

  // Parent can force-open the editor (e.g. row double-click) by incrementing
  // externalOpen.seq for this routine. We gate on seq change so closing + later
  // re-opening is a clean signal rather than a bool flip race.
  useEffect(() => {
    if (
      externalOpen &&
      externalOpen.routineId === routine.id &&
      externalOpen.seq !== lastSeqRef.current
    ) {
      lastSeqRef.current = externalOpen.seq
      setEditing(true)
    }
  }, [externalOpen, routine.id])

  function handleSave(): void {
    window.api.setRoutineNote(routine.id, text.trim())
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="note-editor" onClick={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSave()
            }
            if (e.key === 'Escape') {
              setText(routine.notes || '')
              setEditing(false)
            }
          }}
          placeholder="Add note..."
          rows={2}
        />
      </div>
    )
  }

  return (
    <button
      className={`note-btn${routine.notes ? ' has-note' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      title={routine.notes || 'Add note'}
    >
      {routine.notes ? '\u270E' : '\u270E'}
    </button>
  )
}

interface RoutineTableProps {
  /**
   * Optional window-mode for Overlay Mode panels. When set, only a slice of
   * the schedule is shown around the current routine:
   *   - 'previous': N routines immediately before the current index
   *   - 'next':     N routines immediately after the current index
   * Day-headers / session-dividers / search / day-filter are bypassed so the
   * panel stays compact.
   */
  windowMode?: 'previous' | 'next'
  count?: number
}

export default function RoutineTable({ windowMode, count = 5 }: RoutineTableProps = {}): React.ReactElement {
  const competition = useStore((s) => s.competition)
  const currentRoutine = useStore((s) => s.currentRoutine)
  const currentIndex = useStore((s) => s.currentIndex)
  const settings = useStore((s) => s.settings)
  const dayFilter = useStore((s) => s.dayFilter)
  const searchQuery = useStore((s) => s.searchQuery)
  const compactMode = useStore((s) => s.compactMode)
  const obsState = useStore((s) => s.obsState)
  const judgeCount = settings?.competition.judgeCount ?? 3

  async function handleNudgeRoutine(e: React.MouseEvent, routine: Routine): Promise<void> {
    e.stopPropagation()
    try {
      switch (routine.status) {
        case 'recorded':
        case 'queued':
          await window.api.ffmpegEncode(routine.id)
          break
        case 'encoding':
          await window.api.ffmpegResume()
          break
        case 'encoded':
        case 'uploading':
        case 'uploaded':
        case 'confirmed':
        case 'failed':
          await window.api.uploadRoutine(routine.id)
          await window.api.uploadStart()
          break
        default:
          await window.api.mediaReconcileRun('manual')
          break
      }
    } catch {
      // handled server-side
    }
  }
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // Double-click on a row opens the row's note editor (F5 wire-up). The seq
  // increments per double-click so re-clicking the same row re-opens the
  // editor cleanly after close.
  const [noteOpenTarget, setNoteOpenTarget] = useState<NoteEditorExternalOpen | null>(null)
  const nextUnrecordedRowRef = useRef<HTMLTableRowElement | null>(null)
  const hasAutoScrolledRef = useRef(false)
  const isWindowMode = windowMode != null

  function openNoteForRoutine(routineId: string): void {
    setNoteOpenTarget((prev) => ({
      routineId,
      seq: (prev?.routineId === routineId ? prev.seq : 0) + 1,
    }))
  }

  useEffect(() => {
    if (isWindowMode) return // no auto-scroll in panel window mode
    if (hasAutoScrolledRef.current) return
    if (!competition?.routines?.length) return
    const row = nextUnrecordedRowRef.current
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: 'auto' })
    hasAutoScrolledRef.current = true
  }, [competition?.routines?.length, isWindowMode])

  let routines = competition?.routines ?? []

  // Window-mode slice (for overlay panels) happens BEFORE filters so prev/next
  // stays stable regardless of the main window's day filter or search state.
  if (isWindowMode && competition) {
    const idx = Math.max(0, Math.min(currentIndex, routines.length - 1))
    if (windowMode === 'previous') {
      routines = routines.slice(Math.max(0, idx - count), idx).reverse()
    } else {
      routines = routines.slice(idx + 1, idx + 1 + count)
    }
  }

  if (!isWindowMode && dayFilter) {
    routines = routines.filter((r) => r.scheduledDay === dayFilter)
  }

  if (!isWindowMode && searchQuery) {
    const q = searchQuery.toLowerCase()
    routines = routines.filter(
      (r) =>
        r.routineTitle.toLowerCase().includes(q) ||
        r.entryNumber.includes(q) ||
        r.studioName.toLowerCase().includes(q) ||
        r.dancers.toLowerCase().includes(q),
    )
  }

  async function handleJumpTo(routine: Routine): Promise<void> {
    if (obsState.isRecording) return
    await window.api.jumpToRoutine(routine.id)
  }

  async function handleViewMedia(routine: Routine): Promise<void> {
    const dir = routine.outputDir || (routine.outputPath ? routine.outputPath.replace(/[/\\][^/\\]+$/, '') : null)
    if (dir) {
      await window.api.openPath(dir)
    }
  }

  function handleDragOver(e: React.DragEvent, routineId: string): void {
    e.preventDefault()
    e.stopPropagation()
    setDropTargetId(routineId)
  }

  function handleDragLeave(e: React.DragEvent): void {
    e.preventDefault()
    setDropTargetId(null)
  }

  async function handleDrop(e: React.DragEvent, routine: Routine): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    setDropTargetId(null)
    const files = Array.from(e.dataTransfer.files)
    const videoFiles = files.filter((f) =>
      /\.(mp4|mkv|mov|avi|webm|ts|mts)$/i.test(f.name),
    )
    if (videoFiles.length === 0) return
    for (const file of videoFiles) {
      const filePath = (file as File & { path: string }).path
      if (filePath) {
        await window.api.importFile(routine.id, filePath)
      }
    }
  }

  return (
    <div className="table-scroll">
      <table className="upload-table">
        <thead>
          <tr>
            <th className="th-num" style={{ paddingLeft: '10px' }}>#</th>
            <th className="th-time">Time</th>
            <th>Routine</th>
            {!compactMode && <th className="th-pipeline">REC</th>}
            {!compactMode && <th className="th-pipeline">SPLIT</th>}
            {!compactMode && <th className="th-pipeline">PHOTO</th>}
            {!compactMode && <th className="th-pipeline">UP</th>}
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(() => {
            const uniqueDays = Array.from(new Set(routines.map((r) => r.scheduledDay || '')))
            const showDayHeaders = !isWindowMode && (!dayFilter || uniqueDays.length > 1)
            const items = isWindowMode
              ? routines.map((r) => ({ type: 'routine' as const, routine: r }))
              : buildGroupedList(routines, { showDayHeaders })
            const firstUnrecorded = routines.find(
              (r) => r.status === 'pending' || r.status === 'queued',
            )
            const firstUnrecordedId = firstUnrecorded?.id ?? null
            return items.map((item, idx) => {
              if (item.type === 'day-header') {
                return (
                  <tr key={`day-${item.dayKey}-${idx}`} className="day-header-row">
                    <td colSpan={99}>
                      <div className="day-header">
                        <span className="day-label">{item.dayLabel}</span>
                      </div>
                    </td>
                  </tr>
                )
              }
              if (item.type === 'session-divider') {
                return (
                  <tr key={`session-${idx}`} className="session-divider-row">
                    <td colSpan={99}>
                      <div className="session-divider">
                        <span className="session-label">SESSION {item.sessionNumber}</span>
                        <span className="session-gap">· {item.gapMinutes} min break ({item.idleStartTime}–{item.idleEndTime})</span>
                      </div>
                    </td>
                  </tr>
                )
              }
              const routine = item.routine
              const isLive = routine.status === 'recording'
            const isNotRecorded = routine.status === 'pending' || routine.status === 'skipped' || routine.status === 'scratched'
            const isCurrent = currentRoutine?.id === routine.id
            const statusInfo = statusToLabel(routine, judgeCount)
            const progress = getProgressPercent(routine, judgeCount)
            const barClass = getBarClass(routine.status, routine, judgeCount)
            const pipeline = getPipeline(routine, judgeCount)
            const portalStatus = getPortalStatusMeta(routine)

            return (
              <tr
                key={routine.id}
                ref={routine.id === firstUnrecordedId ? nextUnrecordedRowRef : undefined}
                className={`${isCurrent ? 'current-row' : ''}${dropTargetId === routine.id ? ' drop-target' : ''}`}
                onClick={() => handleJumpTo(routine)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  openNoteForRoutine(routine.id)
                }}
                onDragOver={(e) => handleDragOver(e, routine.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, routine)}
                style={{
                  cursor: obsState.isRecording ? 'not-allowed' : 'pointer',
                  ...(isLive
                    ? { background: 'rgba(239,68,68,0.06)', borderLeft: '3px solid var(--recording)' }
                    : {}),
                  ...(isCurrent && !isLive
                    ? { background: 'rgba(99,102,241,0.08)', borderLeft: '3px solid var(--accent)' }
                    : {}),
                  ...(isNotRecorded && !isCurrent ? { opacity: 0.35 } : {}),
                  ...(dropTargetId === routine.id
                    ? { background: 'rgba(99,102,241,0.15)', outline: '2px dashed var(--accent)', outlineOffset: '-2px' }
                    : {}),
                }}
              >
                <td className="td-num" style={{ paddingLeft: isLive || isCurrent ? '7px' : '10px' }}>
                  <span
                    className="entry-num"
                    style={isLive ? { color: 'var(--recording)' } : undefined}
                  >
                    {routine.entryNumber}
                  </span>
                </td>
                <td className="td-time">
                  <span className="entry-time">
                    {routine.scheduledTime ? routine.scheduledTime.slice(0, 5) : '\u2014'}
                  </span>
                </td>
                <td>
                  <div className="r-name" style={isLive ? { display: 'flex', alignItems: 'center', gap: '5px' } : undefined}>
                    {isLive && <span className="live-indicator" />}
                    {routine.routineTitle}
                    {isLive && <span className="live-badge">LIVE</span>}
                  </div>
                  <div className="r-sub">
                    {routine.studioName} · {routine.ageGroup} {routine.category} · {routine.classification}
                  </div>
                </td>
                {!compactMode && pipeline.map((stage, i) => (
                  <td key={i} className="td-pipeline" title={stage.detail || stage.label}>
                    <span className={`stage-icon ${stageClass(stage.state)}`}>
                      {stageIcon(stage.state)}
                    </span>
                    {stage.state === 'active' && stage.detail && (
                      <span className="stage-detail">{stage.detail}</span>
                    )}
                  </td>
                ))}
                <td>
                  {isNotRecorded ? (
                    <div className="status-stack">
                      <span className={`status-label ${statusInfo.className}`}>{statusInfo.text}</span>
                      {portalStatus && <span className={`portal-pill ${portalStatus.className}`}>{portalStatus.text}</span>}
                    </div>
                  ) : (
                    <div className="status-stack">
                      <div className="status-progress">
                        <div className="bar-track">
                          <div
                            className={`bar-fill ${barClass}`}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className={`status-label ${statusInfo.className}`}>
                          {statusInfo.text}
                          {routine.status === 'uploading' && routine.uploadProgress?.percent !== undefined
                            ? ` \u2014 ${routine.uploadProgress.percent}%`
                            : ''}
                        </span>
                      </div>
                      {portalStatus && <span className={`portal-pill ${portalStatus.className}`}>{portalStatus.text}</span>}
                    </div>
                  )}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                    <NoteEditor routine={routine} externalOpen={noteOpenTarget} />
                    {(routine.status === 'uploading' || (routine.status === 'encoded' && routine.error)) && (
                      <button
                        className="view-btn"
                        style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          window.api.uploadCancelRoutine(routine.id)
                        }}
                        title="Cancel upload for this routine"
                      >
                        Cancel
                      </button>
                    )}
                    {['recorded', 'queued', 'encoding', 'encoded', 'uploading', 'uploaded', 'confirmed', 'failed'].includes(routine.status) && (
                      <button
                        className="view-btn"
                        style={{ color: 'var(--upload-blue)', borderColor: 'var(--upload-blue)' }}
                        onClick={(e) => {
                          void handleNudgeRoutine(e, routine)
                        }}
                        title="Manually resume this routine's next processing or upload step"
                      >
                        Nudge
                      </button>
                    )}
                    {routine.status === 'failed' && (
                      <button
                        className="view-btn"
                        style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          window.api.uploadRoutine(routine.id)
                        }}
                        title="Retry upload"
                      >
                        Retry
                      </button>
                    )}
                    {routine.status !== 'scratched' ? (
                      <button
                        className="view-btn"
                        style={{ color: '#f59e0b', borderColor: '#f59e0b' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          window.api.recordingScratch(routine.id)
                        }}
                        title="Mark routine as scratched / did not perform"
                      >
                        Scratch
                      </button>
                    ) : (
                      <button
                        className="view-btn"
                        style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          window.api.recordingUnscratch(routine.id)
                        }}
                        title="Return scratched routine to pending"
                      >
                        Unscratch
                      </button>
                    )}
                    {!isNotRecorded && (
                      <button
                        className="view-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleViewMedia(routine)
                        }}
                      >
                        View
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )
            })
          })()}
        </tbody>
      </table>
    </div>
  )
}
