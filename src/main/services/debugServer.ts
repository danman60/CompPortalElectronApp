/**
 * Read-only debug HTTP endpoint — localhost-bound, no auth.
 *
 * Serves on 127.0.0.1:8765. Intended for remote inspection via SSH tunnel:
 *   ssh -L 8765:localhost:8765 dart
 *   curl http://localhost:8765/debug/state
 *
 * Routes:
 *   GET /debug/state           — full structured state snapshot
 *   GET /debug/queue           — job queue summary + per-routine breakdown
 *                                query: ?status=pending&type=upload
 *   GET /debug/routines        — per-routine status + photo/video counts
 *   GET /debug/logs            — tail of main.log, optional grep + tail
 *                                query: ?tail=500&grep=Upload&since=ISO
 *   GET /debug/events          — recent structured events from ring buffer
 *                                query: ?limit=500&kind=import
 *   GET /debug/archives        — list rotated log files + sizes
 *   GET /debug/health          — process health: uptime, memory, versions
 *   GET /debug/offsets         — persisted camera offsets
 *   GET /debug/watermarks      — SD watermarks per camera body
 *
 * All responses: JSON except /debug/logs (text/plain) + /debug/archives
 * (JSON). Errors return {error: "..."} with 4xx/5xx.
 */

import http, { IncomingMessage, ServerResponse } from 'http'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { logger } from '../logger'
import * as state from './state'
import * as jobQueue from './jobQueue'
import * as events from './events'
import {
  handleTestRecordingStart,
  handleTestRecordingStop,
  handleTestImportPhotos,
  handleTestInjectTake,
  handleTestClearState,
  handleTestDispatchDecision,
  handleTestTriggerAudioAudit,
  handleTestSetWatermark,
  handleTestClearWatermarks,
  handleTestSetTakeRoutine,
  handleTestExtractKeyframes,
  handleTestReassignRecording,
  handleTestCaptureRenderer,
  handleTestObsState,
  handleTestAudioLevels,
  handleSnapshot,
} from './debugTestRoutes'

const PORT = 8765
const HOST = '127.0.0.1'
const MAX_LOG_TAIL_BYTES = 16 * 1024 * 1024 // 16MB cap on single log read

let server: http.Server | null = null

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const json = JSON.stringify(body, null, 2)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
    })
    res.end(json)
  } catch (err) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('serialization failed: ' + (err instanceof Error ? err.message : String(err)))
    } catch {}
  }
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function parseQuery(url: string): Record<string, string> {
  const q: Record<string, string> = {}
  const idx = url.indexOf('?')
  if (idx < 0) return q
  const qs = url.slice(idx + 1)
  for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=')
    if (k) q[decodeURIComponent(k)] = v ? decodeURIComponent(v) : ''
  }
  return q
}

function handleState(_req: IncomingMessage, res: ServerResponse): void {
  const comp = state.getCompetition()
  const routines = comp?.routines || []
  const statusCounts: Record<string, number> = {}
  for (const r of routines) {
    const key = r.status || 'unknown'
    statusCounts[key] = (statusCounts[key] || 0) + 1
  }
  sendJson(res, 200, {
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    competition: comp ? {
      id: comp.id,
      name: comp.name,
      routineCount: routines.length,
      currentRoutineId: comp.currentRoutineId || null,
    } : null,
    routineStatusCounts: statusCounts,
    cameraOffsets: state.listCameraOffsets(),
    eventRingSize: Object.keys(events.getKinds()).length,
    eventKinds: events.getKinds(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    memRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    memHeapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  })
}

function handleQueue(req: IncomingMessage, res: ServerResponse): void {
  const q = parseQuery(req.url || '')
  const typeFilter = q.type as 'upload' | 'encode' | undefined
  const statusFilter = q.status
  const routineId = q.routineId

  const all = jobQueue.getAll()
  let filtered = all
  if (typeFilter) filtered = filtered.filter((j) => j.type === typeFilter)
  if (statusFilter) filtered = filtered.filter((j) => j.status === statusFilter)
  if (routineId) filtered = filtered.filter((j) => j.routineId === routineId)

  // Group by routine for summary
  const byRoutine: Record<string, Record<string, number>> = {}
  for (const j of filtered) {
    const rid = j.routineId || '_unassigned'
    if (!byRoutine[rid]) byRoutine[rid] = {}
    byRoutine[rid][j.status] = (byRoutine[rid][j.status] || 0) + 1
  }
  const byStatus: Record<string, number> = {}
  for (const j of filtered) byStatus[j.status] = (byStatus[j.status] || 0) + 1
  const byType: Record<string, number> = {}
  for (const j of all) byType[j.type] = (byType[j.type] || 0) + 1

  sendJson(res, 200, {
    totalJobs: all.length,
    filteredCount: filtered.length,
    byStatus,
    byType,
    byRoutine,
    filter: { type: typeFilter, status: statusFilter, routineId },
  })
}

function handleRoutines(_req: IncomingMessage, res: ServerResponse): void {
  const comp = state.getCompetition()
  if (!comp) { sendJson(res, 404, { error: 'no competition loaded' }); return }
  const summary = comp.routines.map((r) => ({
    id: r.id,
    entryNumber: r.entryNumber,
    title: r.routineTitle,
    status: r.status,
    photoCount: (r.photos || []).length,
    hasEncodedFiles: (r.encodedFiles || []).length > 0,
    recordingStartedAt: r.recordingStartedAt || null,
    recordingStoppedAt: r.recordingStoppedAt || null,
    uploadRunId: r.uploadRunId || null,
    encodeSkipReason: r.encodeSkipReason || null,
  }))
  sendJson(res, 200, { count: summary.length, routines: summary })
}

function handleLogs(req: IncomingMessage, res: ServerResponse): void {
  const q = parseQuery(req.url || '')
  const tail = Math.min(parseInt(q.tail || '500', 10) || 500, 10000)
  const grep = q.grep || ''
  const since = q.since || ''
  const logPath = path.join(app.getPath('userData'), 'logs', 'main.log')

  try {
    if (!fs.existsSync(logPath)) { sendText(res, 404, 'main.log missing'); return }
    const stat = fs.statSync(logPath)
    const readBytes = Math.min(stat.size, MAX_LOG_TAIL_BYTES)
    const startPos = Math.max(0, stat.size - readBytes)
    const fd = fs.openSync(logPath, 'r')
    const buf = Buffer.alloc(readBytes)
    fs.readSync(fd, buf, 0, readBytes, startPos)
    fs.closeSync(fd)

    let lines = buf.toString('utf-8').split('\n')
    if (since) {
      lines = lines.filter((l) => l >= since)
    }
    if (grep) {
      try {
        const re = new RegExp(grep, 'i')
        lines = lines.filter((l) => re.test(l))
      } catch {
        sendText(res, 400, `invalid grep regex: ${grep}`); return
      }
    }
    lines = lines.slice(-tail)
    sendText(res, 200, lines.join('\n'))
  } catch (err) {
    sendText(res, 500, 'read failed: ' + (err instanceof Error ? err.message : String(err)))
  }
}

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  const q = parseQuery(req.url || '')
  const limit = Math.min(parseInt(q.limit || '500', 10) || 500, 5000)
  const kind = q.kind || undefined
  sendJson(res, 200, {
    events: events.getRecent(limit, kind),
    availableKinds: events.getKinds(),
  })
}

function handleArchives(_req: IncomingMessage, res: ServerResponse): void {
  const dir = path.join(app.getPath('userData'), 'logs')
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'))
    const details = files.map((f) => {
      const fp = path.join(dir, f)
      const s = fs.statSync(fp)
      return { name: f, sizeBytes: s.size, mtime: s.mtime.toISOString() }
    }).sort((a, b) => b.mtime.localeCompare(a.mtime))
    sendJson(res, 200, { dir, files: details })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const mu = process.memoryUsage()
  sendJson(res, 200, {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    memory: {
      rssMb: Math.round(mu.rss / 1024 / 1024),
      heapUsedMb: Math.round(mu.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mu.heapTotal / 1024 / 1024),
      externalMb: Math.round(mu.external / 1024 / 1024),
    },
    cwd: process.cwd(),
  })
}

function handleOffsets(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, state.listCameraOffsets())
}

function handleWatermarks(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, state.listSdWatermarks())
}

function handleIndex(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    name: 'CompSync Media debug server',
    version: 1,
    host: HOST,
    port: PORT,
    routes: [
      'GET /debug/state',
      'GET /debug/queue?status=pending&type=upload&routineId=X',
      'GET /debug/routines',
      'GET /debug/logs?tail=500&grep=Upload&since=ISO',
      'GET /debug/events?limit=500&kind=import',
      'GET /debug/archives',
      'GET /debug/health',
      'GET /debug/offsets',
      'GET /debug/watermarks',
    ],
  })
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
const ROUTES: Record<string, Handler> = {
  '/': handleIndex,
  '/debug': handleIndex,
  '/debug/': handleIndex,
  '/debug/state': handleState,
  '/debug/queue': handleQueue,
  '/debug/routines': handleRoutines,
  '/debug/logs': handleLogs,
  '/debug/events': handleEvents,
  '/debug/archives': handleArchives,
  '/debug/health': handleHealth,
  '/debug/offsets': handleOffsets,
  '/debug/watermarks': handleWatermarks,
  '/debug/snapshot': handleSnapshot,
}

const POST_ROUTES: Record<string, Handler> = {
  '/debug/test/recording/start': handleTestRecordingStart,
  '/debug/test/recording/stop': handleTestRecordingStop,
  '/debug/test/import-photos': handleTestImportPhotos,
  '/debug/test/inject-take': handleTestInjectTake,
  '/debug/test/clear-state': handleTestClearState,
  '/debug/test/dispatch-decision': handleTestDispatchDecision,
  '/debug/test/trigger-audio-audit': handleTestTriggerAudioAudit,
  '/debug/test/set-watermark': handleTestSetWatermark,
  '/debug/test/clear-watermarks': handleTestClearWatermarks,
  '/debug/test/set-take-routine': handleTestSetTakeRoutine,
  '/debug/test/extract-keyframes': handleTestExtractKeyframes,
  '/debug/test/recording/reassign': handleTestReassignRecording,
  '/debug/test/capture-renderer': handleTestCaptureRenderer,
  '/debug/test/obs-state': handleTestObsState,
  '/debug/test/audio-levels': handleTestAudioLevels,
}

export function startDebugServer(): void {
  if (server) return
  server = http.createServer((req, res) => {
    const startNs = Date.now()
    const url = req.url || '/'
    const pathname = url.split('?')[0]

    events.emit('debugServer.request', { method: req.method, path: pathname })

    let handler: Handler | null = null
    if (req.method === 'GET') {
      handler = ROUTES[pathname] || null
    } else if (req.method === 'POST') {
      handler = POST_ROUTES[pathname] || null
    }

    if (!handler) {
      sendJson(res, 404, {
        error: `unknown route ${req.method} ${pathname}`,
        availableGet: Object.keys(ROUTES),
        availablePost: Object.keys(POST_ROUTES),
      })
      return
    }

    try {
      const result = handler(req, res)
      // Test routes return promises — handle rejection.
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          logger.app.warn(`debugServer: async handler ${pathname} threw`, err)
          try {
            if (!res.headersSent) {
              sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
            }
          } catch {}
        })
      }
    } catch (err) {
      logger.app.warn(`debugServer: handler ${pathname} threw`, err)
      try {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      } catch {}
    }

    res.on('finish', () => {
      events.emit('debugServer.response', {
        path: pathname,
        status: res.statusCode,
        durationMs: Date.now() - startNs,
      })
    })
  })

  server.on('error', (err) => {
    logger.app.warn(`debugServer: listen error on ${HOST}:${PORT}: ${err.message}`)
  })

  server.listen(PORT, HOST, () => {
    logger.app.info(`debugServer listening on http://${HOST}:${PORT}/debug`)
    events.emit('debugServer.started', { host: HOST, port: PORT })
  })
}

export function stopDebugServer(): void {
  if (!server) return
  server.close(() => {
    logger.app.info('debugServer stopped')
    events.emit('debugServer.stopped', {})
  })
  server = null
}
