import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { Routine, RoutineStatus } from '../../shared/types'
import { requestReassign } from './ReassignPopover'
import { requestMoveAfter } from './MoveAfterPopover'
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
  // Photos must actually exist AND all be uploaded. Previously `!hasPhotos`
  // made this vacuously true for routines with zero photos imported, so a row
  // with videos uploaded but no photos showed "All Media Uploaded" — wrong.
  const allPhotosUploaded = hasPhotos && uploadedPhotos >= totalPhotos

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
  judgeCount: number,
): { text: string; className: string } | null {
  const status = routine.mediaPackageStatus
  // Operator-spec 2026-04-25: even if CompPortal says complete/published, do
  // NOT show the success pill if local photos haven't all been uploaded.
  // "Portal Complete" was firing on routines where the package existed on
  // the server but photos hadn't been pushed yet — misleading.
  const media = getMediaUploadSummary(routine, judgeCount)
  if ((status === 'complete' || status === 'published') && !media.allMediaUploaded) {
    return { text: 'Portal Partial — photos pending', className: 'portal-pending' }
  }
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

  // Stage 5: Thumbs (per-photo R2-uploaded thumbnails)
  const thumbsUploaded = routine.photos?.filter(p => p.thumbnailStoragePath).length ?? 0
  const thumbs: PipelineStage = { label: 'THUMB', state: 'inactive' }
  if (photoCount > 0) {
    if (thumbsUploaded >= photoCount) {
      thumbs.state = 'done'
      thumbs.detail = `${thumbsUploaded}/${photoCount} thumbs uploaded`
    } else {
      thumbs.state = 'error'
      thumbs.detail = `${thumbsUploaded}/${photoCount} thumbs uploaded`
    }
  }

  // Stage 6: Keyframes (3 video keyframes per routine)
  // Burlington UDC 2026-05-01 follow-up: post-asar-swap, local routine.keyframes
  // is empty for already-uploaded routines (state hydration gap). Server has
  // them — plugin/complete required keyframes in payload. So if status is
  // uploaded/confirmed and local count is empty, trust server-side instead of
  // flagging X. Pre-upload routines (status=encoded with empty count) still
  // surface X as a real "missing keyframes" error.
  const keyframeCount = routine.keyframes?.length ?? 0
  const keyframes: PipelineStage = { label: 'KEY', state: 'inactive' }
  if (rec.state === 'done' || routine.status === 'encoded' || routine.status === 'uploaded' || routine.status === 'confirmed') {
    if (keyframeCount >= 3) {
      keyframes.state = 'done'
      keyframes.detail = `${keyframeCount}/3 keyframes`
    } else if (routine.status === 'uploaded' || routine.status === 'confirmed') {
      // Local state lost on restart but server has them post-upload.
      keyframes.state = 'done'
      keyframes.detail = '3/3 keyframes (server)'
    } else {
      keyframes.state = 'error'
      keyframes.detail = `${keyframeCount}/3 keyframes`
    }
  }

  return [rec, split, photos, upload, thumbs, keyframes]
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
      if (routine.encodeSkipReason === 'shorter-than-archived') {
        return { text: 'Auto-encode skipped — prior take was longer', className: 'failed' }
      }
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
      // Distinguish "photos imported but not all up" vs "no photos imported yet"
      if (media.hasPhotos) return { text: 'Videos Uploaded', className: 'video-only' }
      return { text: 'Videos Uploaded — photos pending', className: 'video-only' }
    }
    case 'confirmed':
      if (portalStatus === 'published') {
        return { text: 'Portal Published', className: 'complete' }
      }
      if (media.allMediaUploaded) return { text: 'Server Package Present', className: 'complete' }
      return media.hasPhotos
        ? { text: 'Videos Synced', className: 'video-only' }
        : { text: 'Videos Synced — photos pending', className: 'video-only' }
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
  | { type: 'sd-swap-heads-up'; sessionNumber: number; routinesRemaining: number; totalInSession: number; percentage: number }
  | { type: 'judge-audio-reminder'; sessionNumber: number }

// Operator-spec 2026-04-25: SD cards fill before the end of a long session and
// the operators routinely forget to swap mid-session. Show visible heads-up
// rows at 33% and 55% of any session with enough routines that the SD risks
// filling. Pure visual marker — no logic, no IPC. Threshold tightened from
// 50% (halfway) to 40% on 2026-05-01 to give more lead time.
const SD_SWAP_MIN_ROUTINES = 6

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

function buildGroupedList(routines: Routine[], options: { showDayHeaders: boolean; currentRoutineId?: string | null }): GroupedItem[] {
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

  // Post-process: insert SD-swap heads-up rows at 33% and 55% of each
  // session with enough routines to risk filling the card.
  // A44 fix 2026-04-28: previously suppressed for the session containing the
  // currently-selected routine — defeated the purpose. Now always visible.
  // 2026-05-01: split single 40% trigger into 33% + 55% (operator request
  // Burlington UDC) so a missed first heads-up still has a real second chance.
  const out: GroupedItem[] = []
  let sessionStart = 0
  let currentSessionNumber = 1
  // Burlington UDC 2026-05-02: operator dialed back from [20, 40, 60, 80] to two
  // mid-session thresholds [40, 65] — fewer heads-up rows in the table, both
  // still positioned to catch operator attention before card fill.
  const SD_SWAP_PERCENTAGES = [40, 65] as const
  function flushSessionWithHeadsUp(sessionItems: GroupedItem[], sessionNumber: number): void {
    const routineIdxs: number[] = []
    sessionItems.forEach((it, i) => { if (it.type === 'routine') routineIdxs.push(i) })
    const count = routineIdxs.length
    if (count < SD_SWAP_MIN_ROUTINES) {
      out.push(...sessionItems)
      return
    }
    // Build map of targetIdx → percentage for each threshold. If two thresholds
    // resolve to the same routine ordinal (very short sessions), keep only the
    // earlier one to avoid stacked rows.
    const insertions = new Map<number, number>()
    for (const pct of SD_SWAP_PERCENTAGES) {
      const ordinal = Math.max(0, Math.floor(count * pct / 100))
      const idx = routineIdxs[ordinal]
      if (!insertions.has(idx)) {
        insertions.set(idx, pct)
      }
    }
    for (let i = 0; i < sessionItems.length; i++) {
      const pct = insertions.get(i)
      if (pct !== undefined) {
        const ordinal = Math.max(0, Math.floor(count * pct / 100))
        out.push({
          type: 'sd-swap-heads-up',
          sessionNumber,
          routinesRemaining: count - ordinal,
          totalInSession: count,
          percentage: pct,
        })
      }
      out.push(sessionItems[i])
    }
  }
  // 2026-05-04: judge backup audio reminder — inert in-table row marker that
  // sits BEFORE the first routine of every session, so the operator's eye
  // catches it as they scroll past each session boundary. Mirrors the SD-swap
  // heads-up pattern; auto-derived from the same 15-min idle-gap session
  // inference, no separate config.
  let pendingJudgeAudio: GroupedItem | null = { type: 'judge-audio-reminder', sessionNumber: 1 }
  function flushPendingJudgeAudio(): void {
    if (pendingJudgeAudio) { out.push(pendingJudgeAudio); pendingJudgeAudio = null }
  }
  for (let i = 0; i < result.length; i++) {
    const it = result[i]
    if (it.type === 'day-header') {
      if (i > sessionStart) {
        flushPendingJudgeAudio()
        flushSessionWithHeadsUp(result.slice(sessionStart, i), currentSessionNumber)
      }
      out.push(it)
      sessionStart = i + 1
      currentSessionNumber = 1
      pendingJudgeAudio = { type: 'judge-audio-reminder', sessionNumber: 1 }
    } else if (it.type === 'session-divider') {
      if (i > sessionStart) {
        flushPendingJudgeAudio()
        flushSessionWithHeadsUp(result.slice(sessionStart, i), currentSessionNumber)
      }
      out.push(it)
      sessionStart = i + 1
      currentSessionNumber = it.sessionNumber
      pendingJudgeAudio = { type: 'judge-audio-reminder', sessionNumber: it.sessionNumber }
    }
  }
  if (sessionStart < result.length) {
    flushPendingJudgeAudio()
    flushSessionWithHeadsUp(result.slice(sessionStart), currentSessionNumber)
  }

  return out
}

interface NoteEditorExternalOpen {
  routineId: string
  seq: number
}

function NoteEditor({
  routine,
  externalOpen,
  triggerless,
}: {
  routine: Routine
  externalOpen?: NoteEditorExternalOpen | null
  /**
   * When true, the standalone pencil button is not rendered — the editor is
   * only opened via the row action menu (externalOpen seq bump). The inline
   * textarea still appears in the row's action cell while editing.
   */
  triggerless?: boolean
}): React.ReactElement | null {
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

  if (triggerless) return null

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
  const setSearchQuery = useStore.getState().setSearchQuery
  // Perf #4: header day stepper writes through the EXISTING dayFilter store —
  // not a parallel filter. Empty string = "auto (follow current routine)".
  const setDayFilter = useStore.getState().setDayFilter
  const compactMode = useStore((s) => s.compactMode)
  const obsState = useStore((s) => s.obsState)
  const judgeCount = settings?.competition.judgeCount ?? 3

  async function nudgeRoutine(routine: Routine): Promise<void> {
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

  // Was the Nudge button's right-click gesture. Surfaced as an explicit row
  // action-menu item so the behaviour isn't lost when the inline buttons
  // collapse into the menu. Toggles the relevant global auto setting (encode
  // vs upload follows the routine's pipeline stage) and kicks the queue.
  async function toggleAutoForRoutine(routine: Routine): Promise<void> {
    const kind: 'encode' | 'upload' =
      routine.status === 'recorded' || routine.status === 'queued' || routine.status === 'encoding'
        ? 'encode'
        : 'upload'
    try {
      const res = await (window.api as any).jobQueueAutoToggle(kind)
      const label = kind === 'encode' ? 'Auto-encode' : 'Auto-upload'
      const stateText = (kind === 'encode' ? res?.autoEncode : res?.autoUpload) ? 'ON' : 'OFF'
      window.dispatchEvent(new CustomEvent('compsync:auto-toggled', {
        detail: { label, state: stateText },
      }))
    } catch {
      window.dispatchEvent(new CustomEvent('compsync:auto-toggled', {
        detail: { label: 'Auto toggle', state: 'FAILED' },
      }))
    }
  }

  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // Per-row action menu: a single floating menu (not one per row) anchored to
  // the clicked ⋯ trigger. Replaces the wrapping cluster of inline buttons.
  const [actionMenu, setActionMenu] = useState<{ routineId: string; rect: DOMRect } | null>(null)
  const actionMenuRef = useRef<HTMLDivElement | null>(null)
  // Double-click on a row opens the row's note editor (F5 wire-up). The seq
  // increments per double-click so re-clicking the same row re-opens the
  // editor cleanly after close.
  const [noteOpenTarget, setNoteOpenTarget] = useState<NoteEditorExternalOpen | null>(null)
  const activeRowRef = useRef<HTMLTableRowElement | null>(null)
  const searchMatchRowRef = useRef<HTMLTableRowElement | null>(null)
  const tableScrollRef = useRef<HTMLDivElement | null>(null)
  const operatorScrolledAtRef = useRef<number>(0)
  const isWindowMode = windowMode != null

  function openNoteForRoutine(routineId: string): void {
    setNoteOpenTarget((prev) => ({
      routineId,
      seq: (prev?.routineId === routineId ? prev.seq : 0) + 1,
    }))
  }

  // Dismiss the row action menu on outside pointer-down, Escape, or scroll
  // (a scrolled table would leave the menu floating at a stale anchor).
  useEffect(() => {
    if (!actionMenu) return
    function onDown(e: MouseEvent): void {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setActionMenu(null)
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setActionMenu(null)
    }
    function onScroll(): void {
      setActionMenu(null)
    }
    // Bubble phase: the trigger and menu stopPropagation their mousedown so
    // an in-widget click never reaches this listener.
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    const scrollEl = tableScrollRef.current
    scrollEl?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      scrollEl?.removeEventListener('scroll', onScroll)
    }
  }, [actionMenu])

  // Auto-scroll the active (currently-recording, else first-pending) routine
  // to roughly 1/3 from the top of the visible scroll area. Re-runs when the
  // active routine changes. Yields to the operator if they scrolled within
  // the last 5s so we don't fight a deliberate manual scroll.
  useEffect(() => {
    if (isWindowMode) return
    const row = activeRowRef.current
    const scrollEl = tableScrollRef.current
    if (!row || !scrollEl) return
    const sinceManual = Date.now() - operatorScrolledAtRef.current
    if (sinceManual < 5000) return
    const rowRect = row.getBoundingClientRect()
    const containerRect = scrollEl.getBoundingClientRect()
    const desiredOffsetFromTop = containerRect.height / 3
    const delta = (rowRect.top - containerRect.top) - desiredOffsetFromTop
    scrollEl.scrollTo({ top: scrollEl.scrollTop + delta, behavior: 'smooth' })
  }, [currentRoutine?.id, isWindowMode])

  // 2026-05-02 (Burlington UDC Day 2): when search query produces a match,
  // scroll the FIRST match into view but do NOT filter the table — keeps the
  // surrounding routines visible so the operator can resume nav after jumping.
  // Always honors the user-initiated search; bypasses the manual-scroll grace
  // period (typing a search IS the deliberate action).
  //
  // 2026-05-04 (post-Burlington): operator reported "type to jump does nothing".
  // Two robustness fixes:
  //   1. scrollIntoView({block:'center'}) replaces manual scrollTo(delta) math —
  //      works reliably with sticky headers and zero-overflow edge cases where
  //      the previous delta calc could compute a no-op or scroll under the head.
  //   2. requestAnimationFrame defers the scroll one frame so the ref
  //      attachment from the just-completed render has fully landed.
  useEffect(() => {
    if (isWindowMode) return
    if (!searchQuery) return
    const raf = requestAnimationFrame(() => {
      const row = searchMatchRowRef.current
      if (!row) return
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [searchQuery, isWindowMode])

  useEffect(() => {
    const el = tableScrollRef.current
    if (!el) return
    function markManualScroll(): void {
      operatorScrolledAtRef.current = Date.now()
    }
    el.addEventListener('wheel', markManualScroll, { passive: true })
    el.addEventListener('touchmove', markManualScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', markManualScroll)
      el.removeEventListener('touchmove', markManualScroll)
    }
  }, [])

  let routines = competition?.routines ?? []

  // Item 5 (2026-04-25): if operator has set a manual displayOrder, sort the
  // rendered routines by that order. IDs not in displayOrder fall to the end
  // in their original schedule order so newly-arrived routines stay visible.
  if (competition?.displayOrder && competition.displayOrder.length > 0) {
    const orderIdx = new Map<string, number>()
    competition.displayOrder.forEach((id, i) => orderIdx.set(id, i))
    const inOrder: Routine[] = []
    const trailing: Routine[] = []
    for (const r of routines) {
      if (orderIdx.has(r.id)) inOrder.push(r)
      else trailing.push(r)
    }
    inOrder.sort((a, b) => (orderIdx.get(a.id)! - orderIdx.get(b.id)!))
    routines = inOrder.concat(trailing)
  }

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

  // Perf backlog #4 (2026-05-16, operator-approved): default-render ONLY the
  // current day's routines instead of mounting/reconciling all ~1450 rows on
  // every state broadcast. We REUSE the existing global `dayFilter` mechanism
  // (store: dayFilter / setDayFilter; UI: LoadCompetition select + the header
  // stepper added below) — no parallel filter state.
  //
  // Day list = scheduledDay values in render order (after displayOrder sort).
  // Driven off scheduledDay (not competition.days) so it stays aligned with
  // the items array / day-header grouping which all key off scheduledDay.
  const orderedDays: string[] = []
  if (!isWindowMode) {
    const seenDays = new Set<string>()
    for (const r of routines) {
      const d = r.scheduledDay || ''
      if (!seenDays.has(d)) {
        seenDays.add(d)
        orderedDays.push(d)
      }
    }
  }

  // Search scans the FULL list (all days) BEFORE any day-scoping so a query
  // never gets limited to the visible day (constraint 4). Match highlight +
  // first-match scroll behavior unchanged from the 2026-05-02 in-place design.
  const searchMatchIds = new Set<string>()
  let firstSearchMatchId: string | null = null
  let firstSearchMatchDay: string | null = null
  if (!isWindowMode && searchQuery) {
    const q = searchQuery.toLowerCase()
    for (const r of routines) {
      if (
        r.routineTitle.toLowerCase().includes(q) ||
        r.entryNumber.includes(q) ||
        r.studioName.toLowerCase().includes(q) ||
        r.dancers.toLowerCase().includes(q)
      ) {
        searchMatchIds.add(r.id)
        if (firstSearchMatchId === null) {
          firstSearchMatchId = r.id
          firstSearchMatchDay = r.scheduledDay || ''
        }
      }
    }
  }

  // Effective day scope:
  //   - explicit non-empty dayFilter  → operator pinned a day; honor it as-is
  //     (also covers LoadCompetition's existing day select). Unchanged path.
  //   - empty dayFilter (the default) → scope to the "current day" =
  //     scheduledDay of currentRoutine, else first pending routine, else the
  //     first day present. This is what kills the 1450-row reconcile.
  // Cross-day search jump (constraint 4): if a search match lands on a day
  // other than the resolved scope, follow the match's day so the existing
  // searchMatchRowRef scrollIntoView still lands. This OVERRIDES both the
  // default scope AND an explicit operator pin — search must never be limited
  // to the shown day. (The pin is restored as soon as the search is cleared.)
  let effectiveDay = ''
  if (!isWindowMode && orderedDays.length > 0) {
    if (dayFilter && orderedDays.includes(dayFilter)) {
      effectiveDay = dayFilter
    } else {
      const currentDay = currentRoutine?.scheduledDay
      const firstPendingDay = routines.find(
        (r) => r.status === 'pending' || r.status === 'queued',
      )?.scheduledDay
      effectiveDay =
        (currentDay && orderedDays.includes(currentDay) && currentDay) ||
        (firstPendingDay && orderedDays.includes(firstPendingDay) && firstPendingDay) ||
        orderedDays[0]
    }
    if (
      firstSearchMatchDay !== null &&
      orderedDays.includes(firstSearchMatchDay) &&
      firstSearchMatchDay !== effectiveDay
    ) {
      effectiveDay = firstSearchMatchDay
    }
  }

  // Multi-day competitions only: scope to the effective day. Single-day comps
  // (orderedDays.length <= 1) render unchanged — nothing to scope.
  if (!isWindowMode && orderedDays.length > 1) {
    routines = routines.filter((r) => (r.scheduledDay || '') === effectiveDay)
  }

  async function handleJumpTo(routine: Routine): Promise<void> {
    // Item 17 / A54: when actively recording, a routine row click does NOT
    // jump the cursor — it surfaces the reassign-confirmation popover so
    // the operator can save the in-flight take to a different slot. Pre-
    // recording behavior unchanged.
    if (obsState.isRecording) {
      requestReassign({ kind: 'routine', routine })
      return
    }
    await window.api.jumpToRoutine(routine.id)
  }

  async function handleViewMedia(routine: Routine): Promise<void> {
    const dir = routine.outputDir || (routine.outputPath ? routine.outputPath.replace(/[/\\][^/\\]+$/, '') : null)
    if (dir) {
      await window.api.openPath(dir)
    }
  }

  // Operator "Archive Media" row action (scope A — CSE-local only).
  // Confirms (destructive-to-local-state, NOT to media — files are moved
  // into _archive/, never deleted), then archives the routine's local
  // media and resets the routine to pre-record `pending` so a fresh
  // recording can be made. CSE-local only — does not touch the uploaded
  // or published copy. Simple confirm, no audible alert, does not block
  // recording start.
  async function archiveMediaForRoutine(routine: Routine): Promise<void> {
    if (['recording', 'queued', 'encoding', 'uploading'].includes(routine.status)) {
      window.alert(
        `Archive Media is blocked while R${routine.entryNumber} is ${routine.status}. Stop or let the active job finish, then archive the local media.`,
      )
      return
    }
    const ok = window.confirm(
      `Archive media for R${routine.entryNumber} "${routine.routineTitle}"?\n\n` +
      `The current local recording/photos will be MOVED into this routine's ` +
      `_archive folder (never deleted) and the routine will be reset so you ` +
      `can record it fresh. The already-uploaded copy on the portal is not changed.`,
    )
    if (!ok) return
    try {
      const res = await (window.api as any).routineArchiveMedia(routine.id)
      if (res && res.ok === false) {
        window.alert(`Archive Media failed: ${res.reason}`)
      }
    } catch (err) {
      window.alert(`Archive Media failed: ${err instanceof Error ? err.message : String(err)}`)
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

  // Item 5 (2026-04-25): native HTML5 row reorder. The drag handle (⋮⋮ cell)
  // sets a custom MIME type so we can distinguish a row drag from a video-file
  // drag without breaking the existing file-import drop handler.
  const ROW_REORDER_MIME = 'application/x-compsync-routine-id'

  function handleRowDragStart(e: React.DragEvent, routineId: string): void {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(ROW_REORDER_MIME, routineId)
    e.dataTransfer.setData('text/plain', routineId)
  }

  async function reorderRoutine(draggedId: string, targetId: string): Promise<void> {
    if (!competition || draggedId === targetId) return
    const allIds = competition.routines.map(r => r.id)
    const baseOrder =
      (competition.displayOrder && competition.displayOrder.length > 0)
        ? competition.displayOrder.filter(id => allIds.includes(id))
        : allIds.slice()
    // Append any routines not already in baseOrder (defensive — shouldn't happen).
    for (const id of allIds) if (!baseOrder.includes(id)) baseOrder.push(id)
    const fromIdx = baseOrder.indexOf(draggedId)
    const toIdx = baseOrder.indexOf(targetId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return
    baseOrder.splice(fromIdx, 1)
    baseOrder.splice(toIdx, 0, draggedId)
    try {
      await (window.api as any).stateSetDisplayOrder(baseOrder)
    } catch (err) {
      console.error('reorder failed:', err)
    }
  }

  async function handleDrop(e: React.DragEvent, routine: Routine): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    setDropTargetId(null)
    // Row reorder takes precedence over file drop. Custom MIME type means
    // this is a same-table row drag, not a file from the OS.
    const draggedRoutineId = e.dataTransfer.getData(ROW_REORDER_MIME)
    if (draggedRoutineId) {
      void reorderRoutine(draggedRoutineId, routine.id)
      return
    }
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
    <>
    <div className="table-scroll" ref={tableScrollRef}>
      <table className="upload-table">
        <thead>
          <tr>
            <th className="th-num" style={{ paddingLeft: '10px' }}>#</th>
            <th className="th-time">Time</th>
            <th className="th-routine-search">
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <input
                  type="text"
                  className="th-search-input"
                  placeholder="Search # / name / studio..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {!isWindowMode && orderedDays.length > 1 && (() => {
                  const curIdx = orderedDays.indexOf(effectiveDay)
                  const goTo = (idx: number): void => {
                    const d = orderedDays[idx]
                    if (d != null) setDayFilter(d)
                  }
                  return (
                    <div className="day-nav" title="Day (default follows current routine)">
                      <button
                        type="button"
                        className="day-nav-btn"
                        disabled={curIdx <= 0}
                        onClick={() => goTo(curIdx - 1)}
                        aria-label="Previous day"
                      >‹</button>
                      <select
                        className="day-nav-select"
                        value={effectiveDay}
                        onChange={(e) => setDayFilter(e.target.value)}
                        title="Jump to day"
                        aria-label="Select day"
                      >
                        {orderedDays.map((d) => (
                          <option key={d} value={d}>{formatDayLabel(d)}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="day-nav-btn"
                        disabled={curIdx < 0 || curIdx >= orderedDays.length - 1}
                        onClick={() => goTo(curIdx + 1)}
                        aria-label="Next day"
                      >›</button>
                      {dayFilter ? (
                        <button
                          type="button"
                          className="day-nav-btn day-nav-auto"
                          onClick={() => setDayFilter('')}
                          title="Resume auto-follow of current routine"
                        >AUTO</button>
                      ) : (
                        <span className="day-nav-auto-on" title="Following current routine">AUTO</span>
                      )}
                    </div>
                  )
                })()}
              </div>
            </th>
            {!compactMode && <th className="th-pipeline">REC</th>}
            {!compactMode && <th className="th-pipeline">SPLIT</th>}
            {!compactMode && <th className="th-pipeline">PHOTO</th>}
            {!compactMode && <th className="th-pipeline">UP</th>}
            {!compactMode && <th className="th-pipeline">THUMB</th>}
            {!compactMode && <th className="th-pipeline">KEY</th>}
            <th>Status</th>
            <th className="th-actions"></th>
          </tr>
        </thead>
        <tbody>
          {(() => {
            const uniqueDays = Array.from(new Set(routines.map((r) => r.scheduledDay || '')))
            // Perf #4: rows are now day-scoped, so only show day-headers when
            // more than one day is actually visible (multi-day fallback / a
            // single-day comp that wasn't scoped). Session-dividers WITHIN the
            // day are emitted by buildGroupedList regardless and stay intact.
            const showDayHeaders = !isWindowMode && uniqueDays.length > 1
            const items = isWindowMode
              ? routines.map((r) => ({ type: 'routine' as const, routine: r }))
              : buildGroupedList(routines, { showDayHeaders, currentRoutineId: currentRoutine?.id ?? null })
            const firstUnrecorded = routines.find(
              (r) => r.status === 'pending' || r.status === 'queued',
            )
            const firstUnrecordedId = firstUnrecorded?.id ?? null
            // Pin auto-scroll to: live recording row > current selection > first unrecorded.
            const recordingRoutine = routines.find((r) => r.status === 'recording')
            const activeRowId = recordingRoutine?.id
              ?? currentRoutine?.id
              ?? firstUnrecordedId
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
              if (item.type === 'sd-swap-heads-up') {
                return (
                  <tr key={`sdswap-${idx}`} className="sd-swap-heads-up-row">
                    <td colSpan={99}>
                      <div className="sd-swap-heads-up">
                        <span className="sd-swap-icon" aria-hidden="true">💾</span>
                        <span className="sd-swap-label">SWAP SD CARDS</span>
                        <span className="sd-swap-detail">
                          · {item.percentage}% through Session {item.sessionNumber} · {item.routinesRemaining} of {item.totalInSession} routines remaining
                        </span>
                      </div>
                    </td>
                  </tr>
                )
              }
              if (item.type === 'judge-audio-reminder') {
                return (
                  <tr key={`judge-audio-${idx}`} className="judge-audio-reminder-row">
                    <td colSpan={99}>
                      <div className="judge-audio-reminder-inline">
                        <svg
                          className="judge-audio-icon"
                          viewBox="0 0 24 24"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          aria-hidden="true"
                        >
                          <path
                            d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"
                            fill="currentColor"
                          />
                          <path
                            d="M5 11a7 7 0 0 0 14 0"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            fill="none"
                          />
                          <path
                            d="M12 18v3M9 21h6"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                        <span className="judge-audio-label">JUDGE BACKUP AUDIO</span>
                        <span className="judge-audio-detail">
                          · Start the external recorder for Session {item.sessionNumber}
                        </span>
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
            const portalStatus = getPortalStatusMeta(routine, judgeCount)

            const isSearchMatch = searchMatchIds.has(routine.id)
            const isFirstSearchMatch = firstSearchMatchId === routine.id
            return (
              <tr
                key={routine.id}
                ref={(el) => {
                  if (routine.id === activeRowId) activeRowRef.current = el
                  if (isFirstSearchMatch) searchMatchRowRef.current = el
                }}
                className={`${isCurrent ? 'current-row' : ''}${dropTargetId === routine.id ? ' drop-target' : ''}${isSearchMatch ? ' search-match' : ''}${isFirstSearchMatch ? ' search-first' : ''}`}
                draggable
                onDragStart={(e) => handleRowDragStart(e, routine.id)}
                onClick={() => handleJumpTo(routine)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  openNoteForRoutine(routine.id)
                }}
                onDragOver={(e) => handleDragOver(e, routine.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, routine)}
                style={{
                  cursor: 'pointer',
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
                <td className="td-actions">
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'flex-start' }}>
                    <NoteEditor routine={routine} externalOpen={noteOpenTarget} triggerless />
                    <button
                      className="view-btn action-menu-btn"
                      aria-haspopup="menu"
                      aria-expanded={actionMenu?.routineId === routine.id}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = e.currentTarget.getBoundingClientRect()
                        setActionMenu((prev) =>
                          prev?.routineId === routine.id ? null : { routineId: routine.id, rect },
                        )
                      }}
                      title={routine.notes ? `Note: ${routine.notes}` : 'Row actions'}
                    >
                      {routine.notes ? '⋯ •' : '⋯'}
                    </button>
                  </div>
                </td>
              </tr>
            )
            })
          })()}
        </tbody>
      </table>
    </div>
    {actionMenu && (() => {
      const r = competition?.routines.find((x) => x.id === actionMenu.routineId)
      if (!r) return null
      const notRecorded = r.status === 'pending' || r.status === 'skipped' || r.status === 'scratched'
      const canCancel = r.status === 'uploading' || (r.status === 'encoded' && !!r.error)
      const canNudge = ['recorded', 'queued', 'encoding', 'encoded', 'uploading', 'uploaded', 'confirmed', 'failed'].includes(r.status)
      const canRetry = r.status === 'failed'
      const close = (): void => setActionMenu(null)
      const item = (label: string, run: () => void, color?: string): React.ReactElement => (
        <button
          className="view-btn"
          style={{ display: 'block', width: '100%', textAlign: 'left', ...(color ? { color, borderColor: color } : {}) }}
          onClick={(e) => { e.stopPropagation(); close(); run() }}
        >
          {label}
        </button>
      )
      return (
        <div
          ref={actionMenuRef}
          className="row-action-menu"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: Math.min(actionMenu.rect.bottom + 2, window.innerHeight - 8),
            right: Math.max(window.innerWidth - actionMenu.rect.right, 8),
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            padding: '4px',
            background: 'var(--panel, #1b1d24)',
            border: '1px solid var(--border, #333)',
            borderRadius: '6px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
            minWidth: '170px',
          }}
        >
          {item(r.notes ? 'Edit note' : 'Add note', () => openNoteForRoutine(r.id))}
          {canCancel && item('Cancel upload', () => window.api.uploadCancelRoutine(r.id), 'var(--warning)')}
          {canNudge && item('Nudge', () => void nudgeRoutine(r), 'var(--upload-blue)')}
          {canNudge && item('Toggle auto-encode/upload', () => void toggleAutoForRoutine(r), 'var(--upload-blue)')}
          {canRetry && item('Retry upload', () => window.api.uploadRoutine(r.id), 'var(--accent)')}
          {r.status !== 'scratched'
            ? item('Scratch', () => window.api.recordingScratch(r.id), '#f59e0b')
            : item('Unscratch', () => window.api.recordingUnscratch(r.id), 'var(--accent)')}
          {item('Move…', () => requestMoveAfter(r))}
          {!notRecorded && item('View media', () => void handleViewMedia(r))}
          {item('Archive Media', () => void archiveMediaForRoutine(r), '#f59e0b')}
        </div>
      )
    })()}
    </>
  )
}
