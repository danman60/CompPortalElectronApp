/**
 * Debug HTTP TEST endpoints — autonomous test harness surface.
 *
 * Gated behind settings.behavior.testHooksEnabled (default false). When the
 * flag is OFF, every endpoint returns 403. When ON, these routes can mutate
 * state for scenario-driven tests.
 *
 * Routes:
 *   POST /debug/test/recording/start
 *   POST /debug/test/recording/stop
 *   POST /debug/test/import-photos
 *   POST /debug/test/inject-take
 *   POST /debug/test/clear-state
 *   POST /debug/test/dispatch-decision
 *   POST /debug/test/trigger-audio-audit
 *   POST /debug/test/set-watermark
 *   POST /debug/test/clear-watermarks
 *   GET  /debug/snapshot   (full state dump for golden-file regression)
 *
 * MUST NOT BE ENABLED IN PRODUCTION. The harness sets the flag via the
 * Settings IPC at the start of a test run and resets it at the end.
 */

import { IncomingMessage, ServerResponse } from 'http'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { logger } from '../logger'
import { getSettings } from './settings'
import * as state from './state'
import * as jobQueue from './jobQueue'

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
      res.end('serialization failed')
    } catch {}
  }
}

function gateEnabled(res: ServerResponse): boolean {
  if (!getSettings().behavior?.testHooksEnabled) {
    sendJson(res, 403, { error: 'test hooks disabled — set behavior.testHooksEnabled=true' })
    return false
  }
  return true
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks)
        if (buf.length === 0) { resolve({}); return }
        resolve(JSON.parse(buf.toString('utf-8')) as Record<string, unknown>)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// ── POST /debug/test/recording/start ────────────────────────────────────
// Body: { routineId?: string, timestamp?: string }
// Synthesizes handleRecordingStarted without OBS. Creates Take row,
// transitions routine status to 'recording'. Returns { takeId, routineId }.
export async function handleTestRecordingStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  const ts = (body.timestamp as string) || new Date().toISOString()
  let routineId = body.routineId as string | undefined
  if (!routineId) {
    const cur = state.getCurrentRoutine()
    if (!cur) {
      sendJson(res, 400, { error: 'no routineId provided and no current routine' })
      return
    }
    routineId = cur.id
  }
  const takeId = crypto.randomUUID()
  state.addTake({
    takeId,
    startedAt: ts,
    currentRoutineId: routineId,
  })
  state.updateRoutineStatus(routineId, 'recording', { recordingStartedAt: ts })
  sendJson(res, 200, { ok: true, takeId, routineId, startedAt: ts })
}

// ── POST /debug/test/recording/stop ────────────────────────────────────
// Body: { takeId?, mkvPath?, durationSec?, timestamp? }
// Synthesizes handleRecordingStopped finalize semantics: setTakeStopped,
// updates routine recordingStoppedAt + outputPath. Skips file move + encode
// (test endpoint runs against synth paths). Sub-5s guard applied.
export async function handleTestRecordingStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  const takeId = body.takeId as string | undefined
  const mkvPath = (body.mkvPath as string) || `/tmp/synth-${Date.now()}.mkv`
  const stoppedAt = (body.timestamp as string) || new Date().toISOString()
  const durationSec = (body.durationSec as number) ?? 30

  let take = takeId ? state.getTake(takeId) : state.getActiveTake()
  if (!take) {
    sendJson(res, 404, { error: 'no active take found' })
    return
  }

  // Sub-5s discard simulation
  if (durationSec < 5) {
    state.setTakeStopped(take.takeId, stoppedAt, null)
    state.setTakeArchived(take.takeId, `/tmp/_discard/${path.basename(mkvPath)}`)
    state.setTakeRoutine(take.takeId, null)
    if (take.currentRoutineId) {
      const r = state.getCompetition()?.routines.find((x) => x.id === take.currentRoutineId)
      if (r) {
        const priorStatus = r.recordingStoppedAt ? 'recorded' : 'pending'
        state.updateRoutineStatus(r.id, priorStatus, priorStatus === 'pending'
          ? { recordingStartedAt: undefined, recordingStoppedAt: undefined }
          : {})
      }
    }
    sendJson(res, 200, { ok: true, action: 'sub-5s-discard', takeId: take.takeId })
    return
  }

  state.setTakeStopped(take.takeId, stoppedAt, mkvPath)
  if (take.currentRoutineId) {
    state.updateRoutineStatus(take.currentRoutineId, 'recorded', {
      recordingStoppedAt: stoppedAt,
      outputPath: mkvPath,
    })
  }
  sendJson(res, 200, { ok: true, action: 'finalized', takeId: take.takeId, durationSec })
}

// ── POST /debug/test/import-photos ──────────────────────────────────────
// Body: { folderPath, dedupByDb?, autoAbortOffsetMs? }
// Runs photoService.importPhotos against folderPath. Returns import result
// summary (totalPhotos, matched, unmatched, clockOffsetMs).
export async function handleTestImportPhotos(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  const folderPath = body.folderPath as string | undefined
  if (!folderPath) {
    sendJson(res, 400, { error: 'folderPath required' })
    return
  }
  const comp = state.getCompetition()
  if (!comp) {
    sendJson(res, 400, { error: 'no competition loaded' })
    return
  }
  const outputDir = getSettings().fileNaming?.outputDirectory
  if (!outputDir) {
    sendJson(res, 400, { error: 'outputDirectory not configured' })
    return
  }
  try {
    const photos = await import('./photos')
    const result = await photos.importPhotos(folderPath, comp.routines, outputDir, {
      dedupByDb: !!(body.dedupByDb ?? true),
      autoAbortOffsetMs: (body.autoAbortOffsetMs as number) ?? 5 * 60 * 1000,
    })
    if ('error' in result) {
      sendJson(res, 500, { error: (result as { error: string }).error })
      return
    }
    sendJson(res, 200, {
      ok: true,
      totalPhotos: result.totalPhotos,
      matched: result.matched,
      unmatched: result.unmatched,
      clockOffsetMs: result.clockOffsetMs,
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// ── POST /debug/test/inject-take ────────────────────────────────────────
// Body: { takeId?, startedAt, stoppedAt?, mkvPath?, archivedPath?, currentRoutineId?, emptyRoutineNumber? }
// Directly add a Take row. For matcher-only tests where the recording
// lifecycle isn't exercised. Returns the resulting take.
export async function handleTestInjectTake(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  if (!body.startedAt || typeof body.startedAt !== 'string') {
    sendJson(res, 400, { error: 'startedAt required (ISO string)' })
    return
  }
  const takeId = (body.takeId as string) || crypto.randomUUID()
  const t = state.addTake({
    takeId,
    startedAt: body.startedAt,
    currentRoutineId: (body.currentRoutineId as string | null) ?? null,
    emptyRoutineNumber: body.emptyRoutineNumber as string | undefined,
  })
  if (body.stoppedAt && typeof body.stoppedAt === 'string') {
    state.setTakeStopped(t.takeId, body.stoppedAt, (body.mkvPath as string) || null)
  }
  if (body.archivedPath && typeof body.archivedPath === 'string') {
    state.setTakeArchived(t.takeId, body.archivedPath)
  }
  sendJson(res, 200, { ok: true, take: state.getTake(t.takeId) })
}

// ── POST /debug/test/clear-state ────────────────────────────────────────
// Wipes takes[], camera offsets, watermarks. Routine recording fields
// optionally cleared per route param. Use for repeatable test runs.
// Body: { clearRoutineRecordings?: boolean }
export async function handleTestClearState(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  const clearRoutines = !!body.clearRoutineRecordings

  // Clear takes by directly mutating (no public API for full clear)
  const all = state.getTakes()
  for (const t of all) {
    state.setTakeRoutine(t.takeId, null) // detach so matcher won't pick them up
  }
  state.clearSdWatermarks()

  if (clearRoutines) {
    const comp = state.getCompetition()
    if (comp) {
      for (const r of comp.routines) {
        if (r.recordingStartedAt || r.recordingStoppedAt) {
          state.updateRoutineStatus(r.id, 'pending', {
            recordingStartedAt: undefined,
            recordingStoppedAt: undefined,
            outputPath: undefined,
            photos: undefined,
            encodedFiles: undefined,
            uploadProgress: undefined,
          })
        }
      }
    }
  }
  sendJson(res, 200, { ok: true, takesDetached: all.length, watermarksCleared: true, routineRecordingsCleared: clearRoutines })
}

// ── POST /debug/test/dispatch-decision ──────────────────────────────────
// Body: { proposalId, decision: { kind: 'archive' } | { kind: 'specify-routine', routineId } | { kind: 'save-as-extra', emptyRoutineNumber } }
// Drive the post-stop modal programmatically by resolving a pending
// rerec decision. Returns ok or error.
export async function handleTestDispatchDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  const proposalId = body.proposalId as string | undefined
  if (!proposalId) {
    sendJson(res, 400, { error: 'proposalId required' })
    return
  }
  try {
    const recording = await import('./recording')
    recording.resolveRerecDecision(
      proposalId,
      body.decision as Parameters<typeof recording.resolveRerecDecision>[1],
    )
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// ── POST /debug/test/trigger-audio-audit ───────────────────────────────
// Body: { routineId, encodedFiles: [{role, filePath}, ...] }
// Runs audio audit against given files. Returns nothing on the wire (the
// audit emits IPC events) — caller observes via /debug/events afterwards.
export async function handleTestTriggerAudioAudit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  const routineId = body.routineId as string | undefined
  const encodedFiles = body.encodedFiles as Array<{ role: string; filePath: string }> | undefined
  if (!routineId || !encodedFiles || encodedFiles.length === 0) {
    sendJson(res, 400, { error: 'routineId + encodedFiles[] required' })
    return
  }
  const comp = state.getCompetition()
  const routine = comp?.routines.find((r) => r.id === routineId)
  if (!routine) {
    sendJson(res, 404, { error: 'routine not found' })
    return
  }
  try {
    // ffmpeg.runAudioAudit isn't exported. We emit a job-equivalent through
    // the existing handler if it's callable; otherwise we run inline by
    // calling the internals via dynamic import. For now just signal the
    // caller to watch /debug/events for AUDIO_* signals.
    const ffmpeg = await import('./ffmpeg') as any
    if (typeof ffmpeg.runAudioAudit === 'function') {
      void ffmpeg.runAudioAudit(routineId, routine.entryNumber, encodedFiles.map((e) => ({
        role: e.role,
        filePath: e.filePath,
        uploaded: false,
      })))
      sendJson(res, 200, { ok: true, async: true, message: 'audit running, watch /debug/events' })
    } else {
      sendJson(res, 501, { error: 'runAudioAudit not exported from ffmpeg.ts' })
    }
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

// ── POST /debug/test/set-watermark ──────────────────────────────────────
// Body: { bodyKey, lastCaptureTime, lastFilename?, lastFilenameSeq? }
export async function handleTestSetWatermark(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  const bodyKey = body.bodyKey as string | undefined
  const lastCaptureTime = body.lastCaptureTime as string | undefined
  if (!bodyKey || !lastCaptureTime) {
    sendJson(res, 400, { error: 'bodyKey + lastCaptureTime required' })
    return
  }
  state.setSdWatermark(
    bodyKey,
    lastCaptureTime,
    body.lastFilename as string | undefined,
    body.lastFilenameSeq as number | undefined,
  )
  sendJson(res, 200, { ok: true, watermark: state.getSdWatermark(bodyKey) })
}

// ── POST /debug/test/clear-watermarks ──────────────────────────────────
export async function handleTestClearWatermarks(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const before = Object.keys(state.listSdWatermarks()).length
  state.clearSdWatermarks()
  sendJson(res, 200, { ok: true, cleared: before })
}

// ── POST /debug/test/set-take-routine ─────────────────────────────────
// Body: { takeId, routineId, emptyRoutineNumber? }
// Mutates the take's currentRoutineId. Models the post-stop modal's
// "Specify Routine" + Item 17 click-to-reassign flow at the data layer.
export async function handleTestSetTakeRoutine(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gateEnabled(res)) return
  const body = await readBody(req).catch(() => ({}))
  const takeId = body.takeId as string | undefined
  if (!takeId) {
    sendJson(res, 400, { error: 'takeId required' })
    return
  }
  const before = state.getTake(takeId)
  if (!before) {
    sendJson(res, 404, { error: 'take not found' })
    return
  }
  const newRoutineId = (body.routineId as string | null) ?? null
  const emptyNumber = body.emptyRoutineNumber as string | undefined
  const after = state.setTakeRoutine(takeId, newRoutineId, emptyNumber)
  sendJson(res, 200, {
    ok: true,
    before: { currentRoutineId: before.currentRoutineId, emptyRoutineNumber: before.emptyRoutineNumber },
    after: { currentRoutineId: after?.currentRoutineId, emptyRoutineNumber: after?.emptyRoutineNumber },
    windowImmutable: before.startedAt === after?.startedAt && before.stoppedAt === after?.stoppedAt,
  })
}

// ── GET /debug/snapshot ────────────────────────────────────────────────
// Full deterministic state dump for golden-file regression testing.
// Excludes timestamps that change between runs (snapshot.takenAt is the
// only volatile field — caller diffs everything except that).
export function handleSnapshot(_req: IncomingMessage, res: ServerResponse): void {
  const comp = state.getCompetition()
  const routines = comp?.routines.map((r) => ({
    id: r.id,
    entryNumber: r.entryNumber,
    routineTitle: r.routineTitle,
    status: r.status,
    recordingStartedAt: r.recordingStartedAt,
    recordingStoppedAt: r.recordingStoppedAt,
    photoCount: r.photos?.length ?? 0,
    encodedFileCount: r.encodedFiles?.length ?? 0,
    lateInsert: r.lateInsert ?? false,
  })) ?? []
  const takes = state.getTakes().map((t) => ({
    takeId: t.takeId,
    startedAt: t.startedAt,
    stoppedAt: t.stoppedAt,
    mkvPath: t.mkvPath,
    archivedPath: t.archivedPath,
    currentRoutineId: t.currentRoutineId,
    emptyRoutineNumber: t.emptyRoutineNumber,
  }))
  const watermarks = state.listSdWatermarks()
  const queue = jobQueue.getAll().map((j) => ({
    id: j.id,
    type: j.type,
    routineId: j.routineId,
    status: j.status,
    error: j.error,
  }))
  const settings = getSettings()
  sendJson(res, 200, {
    snapshotVersion: 1,
    takenAt: new Date().toISOString(),
    competitionName: comp?.name ?? null,
    competitionId: comp?.competitionId ?? null,
    routines,
    takes,
    watermarks,
    queueSummary: {
      total: queue.length,
      byStatus: queue.reduce<Record<string, number>>((acc, j) => {
        acc[j.status] = (acc[j.status] ?? 0) + 1
        return acc
      }, {}),
      byType: queue.reduce<Record<string, number>>((acc, j) => {
        acc[j.type] = (acc[j.type] ?? 0) + 1
        return acc
      }, {}),
    },
    relevantSettings: {
      autoImportOnDrive: settings.behavior?.autoImportOnDrive,
      includePriorDayPhotos: settings.behavior?.includePriorDayPhotos,
      compStateDriftCheck: settings.behavior?.compStateDriftCheck,
      testHooksEnabled: settings.behavior?.testHooksEnabled,
      audioAudit: settings.audioAudit,
    },
  })
}
