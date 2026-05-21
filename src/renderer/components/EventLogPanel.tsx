import React, { useEffect, useMemo, useRef, useState } from 'react'
import { IPC_CHANNELS, type EventRecord, type EventSeverity } from '../../shared/types'
import { useStore, kindToBucket, kindIsError, type EventBucket } from '../store/useStore'
import '../styles/event-log.css'

/**
 * Build #9 item #4 — Unified Event Log Panel.
 *
 * Mounted as the third column in LeftPanel.tsx top row. Subscribes to the
 * EVENT_STREAM IPC channel and renders a scrolling list of event cards with
 * severity stripe, kind-specific label/summary formatting, sticky filter
 * chips, animated entry, and auto-scroll with "↓ N new" pill when the
 * operator scrolls up. Persistently visible per operator decision 2026-05-05.
 */

const BUCKET_LABELS: Record<EventBucket, string> = {
  imports: 'Imports',
  drives: 'Drives',
  encode: 'Encode',
  upload: 'Upload',
  audio: 'Audio',
  recording: 'Record',
  chat: 'Chat',
  other: 'Other',
  errors: 'Errors',
}

const VISIBLE_BUCKETS: EventBucket[] = ['imports', 'drives', 'encode', 'upload', 'audio', 'other', 'errors']

const HIDDEN_KINDS = new Set<string>([
  'import.requested',
  'import.match.summary',
  'import.match.warning',
  'recording.started',
  'recording.stopped',
  'encode.started',
  'upload.started',
  'chat.backfill.ok',
  'chat.message.received',
  // queue.status fires on every job state transition (pending→running→done
  // for each photo, plus retries). With round-robin upload spreading work
  // across routines, this dominates the Activity panel. Dedicated
  // upload.failed / encode.failed events surface real failures.
  'queue.status',
])

/* ── Batching ────────────────────────────────────────────────────────────── */

/**
 * Kinds that should collapse into one row when many fire in a short window.
 * Operator request 2026-05-15: don't spam one row per photo upload — batch
 * them into "5 uploads finished". Dedicated failure events stay un-batched.
 */
const BATCHABLE_KINDS = new Set<string>(['upload.completed', 'encode.completed'])
const BATCH_WINDOW_MS = 60_000

const BATCH_LABELS: Record<string, { singular: string; plural: string }> = {
  'upload.completed': { singular: 'upload finished', plural: 'uploads finished' },
  'encode.completed': { singular: 'encode finished', plural: 'encodes finished' },
}

interface RenderAPI {
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  eventsGetRecent: (limit?: number, kind?: string) => Promise<EventRecord[]>
}
function getApi(): RenderAPI | null {
  const w = window as unknown as { api?: RenderAPI }
  return w.api ?? null
}

/* ── Severity classifier ─────────────────────────────────────────────────── */

function severityForKind(kind: string): EventSeverity {
  if (/\.(failed|error)(\..*)?$/.test(kind)) return 'error'
  if (/\.(warning|divergence|rejected|mismatch)(\..*)?$/.test(kind)) return 'warning'
  if (/\.(finished|completed|ok|summary)(\..*)?$/.test(kind)) return 'ok'
  return 'info'
}

/* ── Kind → label/summary registry ───────────────────────────────────────── */

interface Formatted { label: string; summary: string }

function trunc(s: unknown, n = 60): string {
  const str = typeof s === 'string' ? s : String(s ?? '')
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

function num(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString() : String(v ?? '?')
}

const FORMATTERS: Record<string, (data: Record<string, unknown>) => Formatted> = {
  'import.requested': (d) => ({
    label: 'Import queued',
    summary: trunc(d.folderPath as string ?? 'unknown source'),
  }),
  'import.started': (d) => ({
    label: 'Importing photos',
    summary: trunc(d.folderPath as string ?? 'unknown source'),
  }),
  'import.finished': (d) => ({
    label: 'Import complete',
    summary: `${num(d.matched)} matched · ${num(d.unmatched)} unmatched${d.dedupSkipped ? ` · ${num(d.dedupSkipped)} dedup-skip` : ''}`,
  }),
  'import.failed': (d) => ({
    label: 'Import failed',
    summary: trunc(d.error as string ?? 'unknown error'),
  }),
  'import.exif.summary': (d) => ({
    label: 'EXIF scan complete',
    summary: `${num(d.scanned)} scanned · ${num(d.failed)} failed`,
  }),
  'import.exif.progress': (d) => ({
    label: 'EXIF scanning',
    summary: `${num(d.processed)}/${num(d.total)}`,
  }),
  'import.match.summary': (d) => ({
    label: 'Photo match',
    summary: `${num(d.matched)} matched · ${num(d.unmatched)} unmatched`,
  }),
  'import.match.warning': (d) => ({
    label: 'Match anomaly',
    summary: trunc(d.message as string ?? 'unexpected distribution'),
  }),

  'drive.detected': (d) => ({
    label: 'SD card inserted',
    summary: `${trunc(d.label as string ?? d.drive as string)} · ${num(d.photoCount)} photos`,
  }),
  'drive.clockMismatch': (d) => ({
    label: 'Camera clock mismatch',
    summary: `${trunc(d.label as string ?? d.drivePath as string)} · ${num(d.daysOffMax)}d off · dominant ${d.dominantDate}`,
  }),
  'drive.missingPhotos': (d) => ({
    label: 'Possible missing photos',
    summary: `${num((d.affectedRoutines as unknown[] | undefined)?.length)} routines flagged`,
  }),

  'recording.archived': (d) => ({
    label: 'Auto-archived prior take',
    summary: `R${d.entryNumber} · ${trunc(d.archivedFile as string)}`,
  }),
  'recording.started': (d) => ({
    label: 'Recording started',
    summary: `R${d.entryNumber} — ${trunc(d.title as string ?? 'untitled')}`,
  }),
  'recording.stopped': (d) => ({
    label: 'Recording stopped',
    summary: `R${d.entryNumber} · ${num(d.durationSec)}s`,
  }),

  'encode.started': (d) => ({
    label: 'Encoding',
    summary: `R${d.entryNumber} — ${num(d.tracks)} tracks`,
  }),
  'encode.completed': (d) => ({
    label: 'Encoded',
    summary: `R${d.entryNumber} · ${num(d.tracks)} tracks`,
  }),
  'encode.failed': (d) => ({
    label: 'Encode failed',
    summary: `R${d.entryNumber} · ${trunc(d.error as string)}`,
  }),

  'upload.started': (d) => ({
    label: 'Uploading',
    summary: `R${d.entryNumber} · ${num(d.fileCount)} files`,
  }),
  'upload.completed': (d) => ({
    label: 'Uploaded',
    summary: `R${d.entryNumber}${d.allMedia ? ' · all media' : ''}`,
  }),
  'upload.failed': (d) => ({
    label: 'Upload failed',
    summary: `R${d.entryNumber} · ${trunc(d.error as string)}`,
  }),

  'audio.flatline.warning': (d) => ({
    label: 'Audio silence warning',
    summary: `${trunc(d.channel as string ?? 'aggregate')} silent ${num(d.silentMs)}ms`,
  }),

  'audio.audit.identicalTracks.warning': (d) => ({
    label: 'Identical tracks detected',
    summary: `R${d.entryNumber} · ${trunc(((d.pairs as string[] | undefined) ?? []).join(', '), 60)}`,
  }),
  'audio.audit.silence.warning': (d) => ({
    label: 'Recording mostly silent',
    summary: `R${d.entryNumber} · ${trunc(d.role as string)} ${(((d.silentFraction as number) ?? 0) * 100).toFixed(0)}% silent`,
  }),
  'audio.audit.lowLoudness.warning': (d) => ({
    label: 'Low audio level',
    summary: `R${d.entryNumber} · ${trunc(d.role as string)} mean ${((d.meanRmsDb as number) ?? 0).toFixed(1)} dBFS < ${d.thresholdDb} dBFS`,
  }),
  'audio.audit.lowBitrate.warning': (d) => ({
    label: 'Broken audio stream',
    summary: `R${d.entryNumber} · ${trunc(d.role as string)} ${num(d.kbps)} kbps < ${num(d.thresholdKbps)} kbps`,
  }),
  'audio.audit.summary': (d) => ({
    label: 'Audio scan ✓',
    summary: `R${d.entryNumber} · ${num(d.trackCount)} tracks captured, all distinct`,
  }),

  'queue.enqueued': (d) => ({
    label: 'Queued',
    summary: `R${d.entryNumber ?? '?'} · ${trunc(d.kind as string)}`,
  }),

  'auto-toggle.changed': (d) => ({
    label: `Auto-${d.kind} ${d.state}`,
    summary: '',
  }),
  'reconcile.summary': (d) => ({
    label: 'Reconcile',
    summary: `${num(d.queued)} queued · ${num(d.skipped)} skipped`,
  }),
  'startup.check': (d) => ({
    label: 'Startup check',
    summary: trunc(d.summary as string ?? 'completed'),
  }),

  'control-room.command.failed': (d) => ({
    label: 'Tablet command failed',
    summary: `${trunc(d.action as string)} · ${trunc(d.error as string)}`,
  }),

  'chat.backfill.ok': (d) => ({
    label: 'Chat synced',
    summary: `${num(d.merged)} new · ${num(d.total)} total`,
  }),
  'chat.message.received': (d) => ({
    label: 'Chat message',
    summary: `${trunc(d.name as string ?? 'anon')} · ${num(d.ageMs)}ms ago`,
  }),
}

function formatRecord(record: EventRecord): Formatted {
  // Batched synthetic row: data._batchCount > 1 means this row stands in
  // for N adjacent same-kind events collapsed in the visible pass below.
  const batchCount = typeof record.data._batchCount === 'number' ? record.data._batchCount : 0
  if (batchCount > 1) {
    const meta = BATCH_LABELS[record.kind]
    if (meta) {
      return { label: `${batchCount} ${meta.plural}`, summary: '' }
    }
  }
  const fn = FORMATTERS[record.kind]
  if (fn) return fn(record.data)
  // Fallback: derive label from kind, summary from JSON snippet
  const niceLabel = record.kind
    .split('.')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase())
    .join(' › ')
  const dataStr = Object.keys(record.data).length > 0
    ? Object.entries(record.data).slice(0, 3).map(([k, v]) => `${k}=${trunc(v, 24)}`).join(' · ')
    : ''
  return { label: niceLabel, summary: dataStr }
}

/* ── Time formatting ─────────────────────────────────────────────────────── */

function timeOfDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/* ── Component ───────────────────────────────────────────────────────────── */

export default function EventLogPanel(): React.ReactElement {
  const events = useStore((s) => s.events)
  const appendEvent = useStore((s) => s.appendEvent)
  const setEvents = useStore((s) => s.setEvents)
  const activeBuckets = useStore((s) => s.eventLogActiveBuckets)
  const toggleBucket = useStore((s) => s.toggleEventBucket)
  const dismissedIds = useStore((s) => s.eventLogDismissedIds)
  const clearDismissals = useStore((s) => s.clearEventDismissals)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const [newSinceScrollUp, setNewSinceScrollUp] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Backfill on mount + subscribe to live stream.
  useEffect(() => {
    const api = getApi()
    if (!api) return
    api.eventsGetRecent(EVENT_LOG_INITIAL_BACKFILL).then((records) => {
      if (Array.isArray(records)) setEvents(records)
    }).catch(() => { /* ignore */ })
    const off = api.on(IPC_CHANNELS.EVENT_STREAM, (record: unknown) => {
      if (record && typeof record === 'object' && 'kind' in record) {
        const r = record as EventRecord
        // Drop HIDDEN_KINDS at the IPC boundary so they never enter the
        // store and never trigger React re-renders. main/index.ts fans out
        // every events.emit() regardless of visibility; without this gate,
        // high-volume kinds (chat.backfill.ok, queue.status) drown the
        // renderer and produced a 75s "Next" lag on 2026-05-15.
        if (HIDDEN_KINDS.has(r.kind)) return
        appendEvent(r)
      }
    })
    return () => { try { off() } catch { /* ignore */ } }
  }, [appendEvent, setEvents])

  // Auto-scroll: when new events arrive AND operator hasn't scrolled up, snap to bottom.
  useEffect(() => {
    if (!autoFollow) {
      setNewSinceScrollUp((n) => n + 1)
      return
    }
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [events.length, autoFollow])

  function handleScroll(): void {
    const list = listRef.current
    if (!list) return
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24
    if (atBottom) {
      if (!autoFollow) setAutoFollow(true)
      if (newSinceScrollUp > 0) setNewSinceScrollUp(0)
    } else if (autoFollow) {
      setAutoFollow(false)
    }
  }

  function snapToBottom(): void {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
    setAutoFollow(true)
    setNewSinceScrollUp(0)
  }

  // Build the visible list — apply bucket filters; errors chip is non-suppressible
  // (errors always render regardless of bucket toggles).
  const visible = useMemo<Array<EventRecord & { id: string; severity: EventSeverity; bucket: EventBucket; isError: boolean }>>(() => {
    const errorsOn = activeBuckets.has('errors')
    const filtered = events
      .map((e, idx) => ({
        ...e,
        id: `${e.t}::${e.kind}::${idx}`,
        severity: severityForKind(e.kind),
        bucket: kindToBucket(e.kind),
        isError: kindIsError(e.kind),
      }))
      .filter((e) => {
        if (HIDDEN_KINDS.has(e.kind)) return false
        if (dismissedIds.has(e.id)) return false
        if (e.isError && errorsOn) return true
        return activeBuckets.has(e.bucket)
      })

    // Collapse adjacent runs of same batchable kind within BATCH_WINDOW_MS
    // into one synthetic row. Anchor on the newest event so the row's time
    // and severity reflect "when the batch finished".
    const out: typeof filtered = []
    let i = 0
    while (i < filtered.length) {
      const head = filtered[i]
      if (!BATCHABLE_KINDS.has(head.kind)) {
        out.push(head)
        i++
        continue
      }
      const startMs = new Date(head.t).getTime()
      let j = i + 1
      while (
        j < filtered.length &&
        filtered[j].kind === head.kind &&
        Math.abs(new Date(filtered[j].t).getTime() - startMs) <= BATCH_WINDOW_MS
      ) {
        j++
      }
      const count = j - i
      if (count === 1) {
        out.push(head)
      } else {
        const newest = filtered[j - 1]
        out.push({
          ...newest,
          id: `batch::${head.kind}::${head.id}::${count}`,
          data: { ...newest.data, _batchCount: count, _batchStart: head.t },
        })
      }
      i = j
    }
    return out
  }, [events, activeBuckets, dismissedIds])

  return (
    <div className="event-log-panel">
      <div className="event-log-header">
        <div>
          <span className="event-log-title">Activity</span>
          <span className="event-log-count">{visible.length}</span>
        </div>
        {dismissedIds.size > 0 && (
          <button className="event-log-clear" onClick={clearDismissals} title="Restore dismissed events">
            Restore {dismissedIds.size}
          </button>
        )}
      </div>

      <div className="event-log-chips">
        {VISIBLE_BUCKETS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => toggleBucket(b)}
            className={`event-log-chip${activeBuckets.has(b) ? ' active' : ''}${b === 'errors' ? ' errors' : ''}`}
            title={`Toggle ${BUCKET_LABELS[b]}`}
          >
            {BUCKET_LABELS[b]}
          </button>
        ))}
      </div>

      <div ref={listRef} className="event-log-list" onScroll={handleScroll}>
        {visible.length === 0 ? (
          <div className="event-log-empty">
            <div className="event-log-empty-glyph">∅</div>
            <div>No events match current filters.</div>
          </div>
        ) : (
          visible.map((e) => {
            const { label, summary } = formatRecord(e)
            const isExpanded = expandedId === e.id
            return (
              <div
                key={e.id}
                className={`event-log-row sev-${e.severity}${isExpanded ? ' expanded' : ''}`}
                onClick={() => setExpandedId(isExpanded ? null : e.id)}
              >
                <div className="event-log-stripe" />
                <div className="event-log-body">
                  <div className="event-log-line1">{label}</div>
                  {summary && <div className="event-log-line2">{summary}</div>}
                </div>
                <div className="event-log-time">{timeOfDay(e.t)}</div>
                {isExpanded && (
                  <pre className="event-log-raw">{JSON.stringify({ kind: e.kind, t: e.t, data: e.data }, null, 2)}</pre>
                )}
              </div>
            )
          })
        )}
        {!autoFollow && newSinceScrollUp > 0 && (
          <button className="event-log-new-pill" onClick={snapToBottom}>
            ↓ {newSinceScrollUp} new
          </button>
        )}
      </div>
    </div>
  )
}

const EVENT_LOG_INITIAL_BACKFILL = 200
