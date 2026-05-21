/**
 * Photo-tier proof harness — REAL-MODULE entry (no mocking of logic under test).
 *
 * Imports the ACTUAL source modules:
 *   - jobQueue        (the REAL getNext('upload') tier selection + gate)
 *   - upload          (the REAL enqueueRoundRobin / enqueueRoutine tagging)
 *   - state           (the REAL setCompetition merge)
 *   - settings        (the REAL settings -> DEFAULT_SETTINGS)
 *
 * Only the two I/O BOUNDARIES are aliased at bundle time (esbuild plugin in
 * build-harness.mjs), NEVER the logic under test:
 *   - 'electron'  -> app.getPath() to an isolated tmp userData; BrowserWindow
 *                    /dialog no-ops. (filesystem/window boundary)
 *   - './schedule'-> in-memory getResolvedConnection() returning a fixed
 *                    connection. (the real one is a NETWORK share-code GET;
 *                    enqueue only reads conn.competitionId/apiBase/apiKey.)
 *
 * Scenario fixture (operator spec): a competition with 3 routines, each with
 * 9 photos (=> ceil(9/3)=3 priority, 6 remaining per routine) enqueued via the
 * REAL round-robin path (settings.upload.strategy default = 'round-robin'),
 * plus 1 video upload job per routine + 2 pending encode jobs.
 *
 * The verdict is read from the REAL getNext('upload') dispatch order +
 * the REAL job payloads (primary source — not the harness's reading of the
 * code). Output is JSON to stdout for the orchestrator to judge.
 */
import * as jobQueue from '../../src/main/services/jobQueue'
import * as upload from '../../src/main/services/upload'
import * as state from '../../src/main/services/state'
import type { Competition, Routine, PhotoMatch } from '../../src/shared/types'

const COMP_ID = 'pt-fixture-competition'
const TENANT = 'pt-fixture-tenant'

function makeRoutine(entryNumber: number, photoCount: number): Routine {
  const id = `r-${entryNumber}`
  const photos: PhotoMatch[] = []
  for (let i = 0; i < photoCount; i++) {
    photos.push({
      filePath: `/tmp/pt-fixture/${id}/photo_${String(i).padStart(2, '0')}.jpg`,
      // captureTime ascending within the routine (enqueueRoundRobin sorts asc)
      captureTime: new Date(Date.UTC(2026, 4, 16, 12, entryNumber, i)).toISOString(),
      confidence: 'exact',
      uploaded: false,
    })
  }
  return {
    id,
    entryNumber: String(entryNumber),
    routineTitle: `Routine ${entryNumber}`,
    dancers: 'Test Dancer',
    studioName: 'Test Studio',
    studioCode: 'TS',
    category: 'Jazz',
    classification: 'Competitive',
    ageGroup: 'Teen',
    sizeCategory: 'Solo',
    durationMinutes: 3,
    scheduledDay: 'Day 1',
    position: entryNumber,
    status: 'encoded',
    outputPath: `/tmp/pt-fixture/${id}/${id}.mkv`,
    outputDir: `/tmp/pt-fixture/${id}`,
    encodedFiles: [
      { role: 'performance', filePath: `/tmp/pt-fixture/${id}/performance.mp4`, uploaded: false },
    ],
    photos,
  } as unknown as Routine
}

function buildCompetition(): Competition {
  return {
    tenantId: TENANT,
    competitionId: COMP_ID,
    name: 'Photo-Tier Fixture',
    routines: [makeRoutine(1, 9), makeRoutine(2, 9), makeRoutine(3, 9)],
    days: ['Day 1'],
    source: 'api',
    loadedAt: new Date().toISOString(),
  }
}

function jobBrief(j: any) {
  const p = j?.payload || {}
  return {
    jobId: j?.id,
    type: j?.type,
    routineId: j?.routineId,
    payloadType: p.type,
    photoTier: p.photoTier ?? '(missing)',
    objectName: p.objectName,
    role: p.role,
  }
}

// Build-agnostic probes. PATCHED jobQueue exports hasOutstandingVideoWork /
// hasPendingRemainingPhotos; UNPATCHED does not. Feature-detect so the SAME
// harness entry runs against both builds. The encode-pending probe is
// computed from getAll() (present on both) — primary source either way.
function encodeWorkPending(): boolean {
  for (const j of (jobQueue as any).getAll()) {
    if (j.type === 'encode' && (j.status === 'pending' || j.status === 'running')) return true
    if (j.type === 'upload' && j.status === 'pending' && (j.payload as any).type === 'videos') return true
  }
  return false
}
const hasOutstandingVideoWork: () => boolean =
  typeof (jobQueue as any).hasOutstandingVideoWork === 'function'
    ? (jobQueue as any).hasOutstandingVideoWork
    : encodeWorkPending
const hasPendingRemainingPhotos: () => boolean =
  typeof (jobQueue as any).hasPendingRemainingPhotos === 'function'
    ? (jobQueue as any).hasPendingRemainingPhotos
    : () => false // UNPATCHED has no tier => never "withholds" => never re-checks

async function main() {
  const out: any = { scenario: {}, enqueued: {}, dispatch: [], assertions: {} }
  out.build = {
    hasOutstandingVideoWorkExport:
      typeof (jobQueue as any).hasOutstandingVideoWork === 'function',
    hasPendingRemainingPhotosExport:
      typeof (jobQueue as any).hasPendingRemainingPhotos === 'function',
  }

  // 1. REAL setCompetition (exercises the real merge; isolated UD => no
  //    persisted-state overlay, clean path).
  const comp = buildCompetition()
  state.setCompetition(comp)
  out.scenario.competitionId = COMP_ID
  out.scenario.routines = comp.routines.map((r) => ({
    id: r.id,
    entry: r.entryNumber,
    photoCount: r.photos?.length,
  }))

  // 2. Seed 1 VIDEO upload job per routine (REAL jobQueue.enqueue, the same
  //    payload shape enqueueRoutine emits for encodedFiles).
  for (const r of comp.routines) {
    jobQueue.enqueue('upload', r.id, {
      routineId: r.id,
      entryId: r.id,
      competitionId: COMP_ID,
      filePath: `/tmp/pt-fixture/${r.id}/performance.mp4`,
      objectName: 'performance.mp4',
      contentType: 'video/mp4',
      type: 'videos',
      role: 'performance',
    })
  }

  // 3. Seed 2 pending ENCODE jobs (the video-work gate input).
  for (let i = 0; i < 2; i++) {
    jobQueue.enqueue('encode', comp.routines[i].id, {
      routineId: comp.routines[i].id,
      inputPath: `/tmp/pt-fixture/${comp.routines[i].id}/${comp.routines[i].id}.mkv`,
      outputDir: `/tmp/pt-fixture/${comp.routines[i].id}`,
      judgeCount: 3,
    })
  }

  // 4. Enqueue PHOTOS via the REAL round-robin path (exercises tier tagging).
  const res = upload.enqueueRoundRobin(comp.routines)
  out.enqueued.roundRobinResult = res

  // Snapshot every enqueued photo job's tier (primary source = job payloads).
  const allJobs = jobQueue.getAll()
  const photoJobs = allJobs.filter(
    (j) => j.type === 'upload' && (j.payload as any).type === 'photos',
  )
  const tierByRoutine: Record<string, { priority: number; remaining: number; missing: number }> = {}
  for (const j of photoJobs) {
    const rid = j.routineId
    tierByRoutine[rid] = tierByRoutine[rid] || { priority: 0, remaining: 0, missing: 0 }
    const t = (j.payload as any).photoTier
    if (t === 'priority') tierByRoutine[rid].priority++
    else if (t === 'remaining') tierByRoutine[rid].remaining++
    else tierByRoutine[rid].missing++
  }
  out.enqueued.photoJobCount = photoJobs.length
  out.enqueued.tierByRoutine = tierByRoutine

  // 5. Inject ONE legacy/in-flight photo job with NO photoTier (must be
  //    treated as priority — never stranded). Routine 1, extra object.
  jobQueue.enqueue('upload', comp.routines[0].id, {
    routineId: comp.routines[0].id,
    entryId: comp.routines[0].id,
    competitionId: COMP_ID,
    filePath: `/tmp/pt-fixture/${comp.routines[0].id}/legacy_notier.jpg`,
    objectName: 'legacy_notier.jpg',
    contentType: 'image/jpeg',
    type: 'photos',
    photoCaptureTime: new Date(Date.UTC(2026, 4, 16, 12, 1, 99)).toISOString(),
    // photoTier intentionally OMITTED
  })

  // 6. DRAIN via the REAL getNext('upload'). Simulate the dispatch loop:
  //    pull a job, mark it running->done, repeat. The video-work gate is
  //    fed by the 2 encode jobs + 3 video upload jobs already queued.
  //    To prove the gate releases, we clear video work PARTWAY and continue.
  // Build-agnostic drain. Each step records whether encode/video work was
  // still pending at the moment getNext() handed the job out (the starvation
  // signal: a non-priority photo going out while encode work is pending).
  //
  //  - PATCHED: getNext returns null while the gate is up + remaining photos
  //    pending (the withhold). The harness then simulates "video work
  //    drained" ONCE and continues — proving remaining photos release (no
  //    deadlock) and never ran earlier (no starvation).
  //  - UNPATCHED: getNext NEVER returns null while any photo job exists (no
  //    gate) — photos stream out immediately while the 2 encode jobs + video
  //    uploads are still pending. First null == queue genuinely empty;
  //    clearedVideoWork stays false. That IS the reproduced starvation.
  //
  // A hard iteration ceiling proves "no busy-spin": the only way to exceed it
  // is a tight null loop, which the bounded re-check + single video-clear
  // forbids.
  const MAX = 500
  let clearedVideoWork = false
  let nullCount = 0
  let busySpinNulls = 0 // consecutive nulls WITHOUT progress (must stay ~0/1)
  let iterationsAfterVideoCleared = 0
  let lastWasNull = false
  for (let step = 0; step < MAX; step++) {
    const encPendingAtPull = encodeWorkPending()
    const job = jobQueue.getNext('upload')
    if (!job) {
      nullCount++
      if (lastWasNull) busySpinNulls++
      lastWasNull = true
      const gateUp = hasOutstandingVideoWork()
      const remPending = hasPendingRemainingPhotos()
      out.dispatch.push({
        step,
        got: null,
        hasOutstandingVideoWork: gateUp,
        hasPendingRemainingPhotos: remPending,
        encodeWorkPending: encPendingAtPull,
      })
      if (!clearedVideoWork && gateUp && remPending) {
        // PATCHED withhold path: drain ALL video work, then continue. (In a
        // live app this is the encode worker finishing + startUploads re-kick
        // OR the new processLoop bounded re-check; here we deterministically
        // model "video work finished".)
        for (const j of jobQueue.getAll()) {
          if (j.type === 'encode' && (j.status === 'pending' || j.status === 'running')) {
            jobQueue.updateStatus(j.id, 'done')
          }
          if (
            j.type === 'upload' &&
            j.status === 'pending' &&
            (j.payload as any).type === 'videos'
          ) {
            jobQueue.updateStatus(j.id, 'running')
            jobQueue.updateStatus(j.id, 'done')
          }
        }
        clearedVideoWork = true
        continue
      }
      // No withhold (UNPATCHED, or PATCHED after remaining drained) => queue
      // genuinely empty for uploads => stop.
      break
    }
    lastWasNull = false
    if (clearedVideoWork) iterationsAfterVideoCleared++
    const brief = jobBrief(job)
    brief.step = step
    brief.gateUp = hasOutstandingVideoWork()
    brief.encodeWorkPending = encPendingAtPull
    out.dispatch.push(brief)
    // advance: running -> done (REAL jobQueue state transitions)
    jobQueue.updateStatus(job.id, 'running')
    jobQueue.updateStatus(job.id, 'done')
  }
  out.assertions.nullReturns = nullCount
  out.assertions.consecutiveBusySpinNulls = busySpinNulls
  out.assertions.iterationsAfterVideoCleared = iterationsAfterVideoCleared
  out.assertions.clearedVideoWork = clearedVideoWork

  // --- Derived assertions (computed from the REAL dispatch, not opinion) ---
  const dispatched = out.dispatch.filter((d: any) => d.got !== null)
  // Phase boundary = the step index where video work was cleared.
  const clearStep = out.dispatch.find(
    (d: any) => d.got === null && d.hasOutstandingVideoWork === true,
  )?.step
  out.assertions.videoGateClearedAtStep = clearStep ?? null

  // Was any 'remaining' photo dispatched BEFORE video work cleared?
  let remainingBeforeClear = 0
  let priorityBeforeClear = 0
  let videosBeforeClear = 0
  let remainingAfterClear = 0
  for (const d of dispatched) {
    const beforeClear = clearStep == null ? true : d.step < clearStep
    if (d.payloadType === 'videos') {
      if (beforeClear) videosBeforeClear++
      continue
    }
    if (d.payloadType !== 'photos') continue
    const isRemaining = d.photoTier === 'remaining'
    if (beforeClear) {
      if (isRemaining) remainingBeforeClear++
      else priorityBeforeClear++
    } else {
      if (isRemaining) remainingAfterClear++
    }
  }
  out.assertions.priorityPhotosDispatchedBeforeVideoCleared = priorityBeforeClear
  out.assertions.videosDispatchedBeforeVideoCleared = videosBeforeClear
  out.assertions.remainingPhotosDispatchedBeforeVideoCleared = remainingBeforeClear
  out.assertions.remainingPhotosDispatchedAfterVideoCleared = remainingAfterClear

  // BUILD-AGNOSTIC STARVATION SIGNAL (does NOT depend on photoTier, which is
  // absent on UNPATCHED). At the instant getNext() handed out each PHOTO job,
  // was encode/video work still pending?
  //   UNPATCHED: photos pour out with encode pending  => HIGH (= ALL 28
  //              photos; getNext has no gate). Reproduces today's starvation.
  //   PATCHED:   ONLY the priority slice + the missing-tier legacy job can go
  //              out with encode pending; getNext withholds the rest. So this
  //              count == priority photos only (9 + 1 legacy = 10), and the
  //              count of NON-priority (remaining) photos dispatched while
  //              encode pending is exactly 0.
  let photosDispatchedWhileEncodePending = 0
  let totalPhotosDispatched = 0
  for (const d of dispatched) {
    if (d.payloadType !== 'photos') continue
    totalPhotosDispatched++
    if (d.encodeWorkPending === true) photosDispatchedWhileEncodePending++
  }
  out.assertions.totalPhotosDispatched = totalPhotosDispatched
  out.assertions.photosDispatchedWhileEncodePending = photosDispatchedWhileEncodePending
  out.assertions.photosStarvedFraction =
    totalPhotosDispatched > 0
      ? Number((photosDispatchedWhileEncodePending / totalPhotosDispatched).toFixed(3))
      : 0

  // Missing-photoTier job: must have been dispatched as a priority-tier photo
  // (i.e. BEFORE video cleared, never stranded to the remaining phase).
  const legacyJob = dispatched.find((d: any) => d.objectName === 'legacy_notier.jpg')
  out.assertions.legacyMissingTierJob = legacyJob
    ? {
        dispatched: true,
        reportedTier: legacyJob.photoTier, // '(missing)'
        beforeVideoCleared: clearStep == null ? true : legacyJob.step < clearStep,
      }
    : { dispatched: false }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

main().catch((err) => {
  process.stderr.write('HARNESS ERROR: ' + (err?.stack || String(err)) + '\n')
  process.exit(3)
})
