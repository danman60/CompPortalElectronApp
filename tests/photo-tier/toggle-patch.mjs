#!/usr/bin/env node
/**
 * Photo-tier change isolator — applies/reverts ONLY the photo-tier delta.
 *
 * upload.ts had pre-existing (non-photo-tier) session modifications before
 * this change, so `git checkout HEAD -- upload.ts` would also wipe unrelated
 * work and make the before/after unfaithful. jobQueue.ts was CLEAN at HEAD
 * before this change (verified: not in session-start `M` list; every deleted
 * line in its diff is the single photoJobs block this change replaced) — so
 * jobQueue.ts toggles via git checkout HEAD (unpatched) vs working tree
 * (patched).
 *
 * For upload.ts the photo-tier delta is exactly 5 byte-exact string
 * replacements (the 5 Edit operations that introduced it). This script
 * reverse-applies them (PATCHED new_string -> UNPATCHED old_string) to
 * reconstruct the upload.ts that has the SAME pre-existing session work but
 * WITHOUT the photo-tier change. `apply` re-applies. Idempotent & verified:
 * each replacement must match exactly once or the script aborts (no silent
 * partial toggle => no unfaithful run).
 *
 * Usage:  node toggle-patch.mjs revert   # -> UNPATCHED (orphan fix kept)
 *         node toggle-patch.mjs apply    # -> PATCHED
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = '/home/danman60/projects/CompSyncElectronApp'
const UPLOAD = `${ROOT}/src/main/services/upload.ts`
const JOBQ = `${ROOT}/src/main/services/jobQueue.ts`

const mode = process.argv[2]
if (mode !== 'apply' && mode !== 'revert') {
  console.error('usage: toggle-patch.mjs <apply|revert>')
  process.exit(2)
}

// The 5 photo-tier string pairs for upload.ts. PATCHED = the code now in the
// working tree; UNPATCHED = the exact text that was there before this change.
const PAIRS = [
  {
    name: 'UploadPayload.photoTier + photoTierFor helper',
    unpatched: `  isPhotoThumbRepair?: boolean
  sourcePhotoStoragePath?: string
  photoCaptureTime?: string
}`,
    patched: `  isPhotoThumbRepair?: boolean
  sourcePhotoStoragePath?: string
  photoCaptureTime?: string
  // Photo upload priority tier (2026-05-16 Burlington UDC). Set at enqueue
  // for real photo jobs only (NOT keyframes/videos/thumb-repairs):
  //   'priority'  = first ~1/3 of THIS routine's ordered pending photos —
  //                 round-robin interleaved across routines, beats all video
  //                 work in getNext('upload').
  //   'remaining' = the other ~2/3 — withheld until ALL video work drains.
  // A MISSING photoTier is treated as 'priority' by getNext (legacy / in-
  // flight jobs must never be stranded behind the video gate).
  photoTier?: 'priority' | 'remaining'
}

/**
 * Tier index → photoTier. Given a photo's zero-based position within its
 * routine's ORDERED PENDING photo sequence and that sequence's length, the
 * first ceil(length/3) are 'priority', the rest 'remaining'. Single source
 * of truth so both enqueue paths split identically.
 */
function photoTierFor(indexInPending: number, pendingCount: number): 'priority' | 'remaining' {
  const threshold = Math.ceil(pendingCount / 3)
  return indexInPending < threshold ? 'priority' : 'remaining'
}`,
  },
  {
    name: 'enqueueRoutine photo loop -> pending-list + tier',
    unpatched: `  // Queue photos
  if (routine.photos) {
    for (const photo of routine.photos) {
      if (!force && photo.uploaded) continue
      const photoObjectName = path.basename(photo.filePath)
      if (skipObjectNames.has(photoObjectName)) continue
      jobQueue.enqueue('upload', routine.id, {
        routineId: routine.id,
        entryId: routine.id,
        competitionId: conn.competitionId,
        filePath: photo.filePath,
        objectName: photoObjectName,
        contentType: 'image/jpeg',
        type: 'photos',
        photoCaptureTime: photo.captureTime,
        // Carry the local thumb path (if any) so the upload loop can PUT it next
        // to the original. Only SD-import photos have this; tether-flow photos
        // skip the thumb upload (thumbnailPath undefined).
        thumbnailPath: photo.thumbnailPath,
      } satisfies UploadPayload as unknown as Record<string, unknown>)
      jobCount++
    }
  }`,
    patched: `  // Queue photos. Photo-tier split (2026-05-16): the ordered PENDING photos
  // for this routine (same routine.photos order this path already used, minus
  // already-uploaded and dupe-skip) are the unit the 1/3 threshold applies
  // to. Pre-compute the pending list so the priority/remaining boundary is
  // ceil(pending/3) within THAT sequence — exactly as the operator spec'd.
  if (routine.photos) {
    const pendingPhotos = routine.photos.filter((photo) => {
      if (!force && photo.uploaded) return false
      if (skipObjectNames.has(path.basename(photo.filePath))) return false
      return true
    })
    pendingPhotos.forEach((photo, idx) => {
      const photoObjectName = path.basename(photo.filePath)
      jobQueue.enqueue('upload', routine.id, {
        routineId: routine.id,
        entryId: routine.id,
        competitionId: conn.competitionId,
        filePath: photo.filePath,
        objectName: photoObjectName,
        contentType: 'image/jpeg',
        type: 'photos',
        photoCaptureTime: photo.captureTime,
        // Carry the local thumb path (if any) so the upload loop can PUT it next
        // to the original. Only SD-import photos have this; tether-flow photos
        // skip the thumb upload (thumbnailPath undefined).
        thumbnailPath: photo.thumbnailPath,
        photoTier: photoTierFor(idx, pendingPhotos.length),
      } satisfies UploadPayload as unknown as Record<string, unknown>)
      jobCount++
    })
  }`,
  },
  {
    name: 'enqueueRoundRobin bucket shape (pendingCount/popped)',
    unpatched: `  // Pass 2: bucket each routine's unuploaded photos, round-robin pop
  const buckets: Array<{ routine: Routine; queue: PhotoMatch[] }> = []
  for (const routine of routines) {
    const pending = (routine.photos || [])
      .filter((p) => !p.uploaded && p.confidence !== 'unmatched')
      .sort((a, b) => (a.captureTime || '').localeCompare(b.captureTime || ''))
    if (pending.length > 0) {
      buckets.push({ routine, queue: pending })
    }
  }`,
    patched: `  // Pass 2: bucket each routine's unuploaded photos, round-robin pop.
  // photoTier (2026-05-16): tier is decided by the photo's index within its
  // routine's ORDERED PENDING list (the captureTime-asc sequence built here),
  // NOT the interleaved global enqueue order. pendingCount snapshots that
  // list's length; popped counts front-shifts from THIS bucket, so popped is
  // exactly the photo's index in the routine's ordered pending sequence —
  // matching enqueueRoutine's split semantics.
  const buckets: Array<{
    routine: Routine
    queue: PhotoMatch[]
    pendingCount: number
    popped: number
  }> = []
  for (const routine of routines) {
    const pending = (routine.photos || [])
      .filter((p) => !p.uploaded && p.confidence !== 'unmatched')
      .sort((a, b) => (a.captureTime || '').localeCompare(b.captureTime || ''))
    if (pending.length > 0) {
      buckets.push({ routine, queue: pending, pendingCount: pending.length, popped: 0 })
    }
  }`,
  },
  {
    name: 'enqueueRoundRobin pop -> tier tagging',
    unpatched: `    const photo = bucket.queue.shift()
    if (!photo) {
      buckets.splice(idx, 1)
      continue
    }
    const objectName = path.basename(photo.filePath)
    const skip = skipByRoutine.get(bucket.routine.id)!
    if (!skip.has(objectName)) {
      jobQueue.enqueue('upload', bucket.routine.id, {
        routineId: bucket.routine.id,
        entryId: bucket.routine.id,
        competitionId: conn.competitionId,
        filePath: photo.filePath,
        objectName,
        contentType: 'image/jpeg',
        type: 'photos',
        photoCaptureTime: photo.captureTime,
        thumbnailPath: photo.thumbnailPath,
      } satisfies UploadPayload as unknown as Record<string, unknown>)
      photoJobs++
    }`,
    patched: `    const photo = bucket.queue.shift()
    if (!photo) {
      buckets.splice(idx, 1)
      continue
    }
    // Index within this routine's ordered pending sequence == #front-shifts
    // already taken from this bucket (shift() always pops the head).
    const photoTier = photoTierFor(bucket.popped, bucket.pendingCount)
    bucket.popped++
    const objectName = path.basename(photo.filePath)
    const skip = skipByRoutine.get(bucket.routine.id)!
    if (!skip.has(objectName)) {
      jobQueue.enqueue('upload', bucket.routine.id, {
        routineId: bucket.routine.id,
        entryId: bucket.routine.id,
        competitionId: conn.competitionId,
        filePath: photo.filePath,
        objectName,
        contentType: 'image/jpeg',
        type: 'photos',
        photoCaptureTime: photo.captureTime,
        thumbnailPath: photo.thumbnailPath,
        photoTier,
      } satisfies UploadPayload as unknown as Record<string, unknown>)
      photoJobs++
    }`,
  },
  {
    name: 'processLoop null-handling re-kick',
    unpatched: `  while (!isPaused) {
    const job = jobQueue.getNext('upload')
    if (!job) break

    const activeCompetitionId = state.getCompetition()?.competitionId`,
    patched: `  while (!isPaused) {
    const job = jobQueue.getNext('upload')
    if (!job) {
      // 2026-05-16 Burlington UDC photo-tier rule: getNext('upload') now
      // WITHHOLDS the REMAINING-tier photo slice (~2/3 per routine) while any
      // video work is outstanding (pending/running encode OR pending video
      // upload). When that's the only pending upload work, getNext returns
      // null even though the queue is NOT empty — those photos must run once
      // video work drains.
      //
      // Pre-tier behavior: the loop broke on null and exited (isUploading
      // ← false). The ONLY re-kick of the loop was ffmpeg.ts's
      // startUploads() after a successful encode + autoUpload enqueue. That
      // re-kick does NOT fire when: autoUploadAfterEncoding is false, the
      // final encode FAILS (ffmpeg.ts error path has no startUploads), or
      // encodes drain via the backoff-retry timer. In all those cases the
      // withheld remaining photos would strand forever (deadlock).
      //
      // Fix (surgical, bounded, self-terminating): if the only thing
      // blocking us is the video-work gate AND remaining photos are pending,
      // sleep briefly then re-loop. No tight spin (fixed 3s wait, not a
      // 0-delay busy poll). Self-terminating: once video work drains,
      // getNext returns the remaining photo and the loop proceeds; once the
      // remaining photos are exhausted, hasPendingRemainingPhotos() goes
      // false and we break normally. isPaused still wins immediately.
      if (
        !isPaused &&
        jobQueue.hasPendingRemainingPhotos() &&
        jobQueue.hasOutstandingVideoWork()
      ) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }
      break
    }

    const activeCompetitionId = state.getCompetition()?.competitionId`,
  },
]

function replaceExactlyOnce(src, find, repl, label) {
  const first = src.indexOf(find)
  if (first === -1) throw new Error(`toggle ABORT: pattern not found for "${label}"`)
  if (src.indexOf(find, first + find.length) !== -1) {
    throw new Error(`toggle ABORT: pattern matched >1x for "${label}"`)
  }
  return src.slice(0, first) + repl + src.slice(first + find.length)
}

// --- upload.ts: reverse/forward-apply the 5 photo-tier pairs ----------------
let up = fs.readFileSync(UPLOAD, 'utf-8')
for (const p of PAIRS) {
  if (mode === 'revert') up = replaceExactlyOnce(up, p.patched, p.unpatched, p.name)
  else up = replaceExactlyOnce(up, p.unpatched, p.patched, p.name)
}
fs.writeFileSync(UPLOAD, up)

// --- jobQueue.ts: clean at HEAD, so checkout HEAD = unpatched ---------------
if (mode === 'revert') {
  execFileSync('git', ['-C', ROOT, 'checkout', 'HEAD', '--', 'src/main/services/jobQueue.ts'])
} else {
  // restore the patched jobQueue.ts from the stash we made in `revert`
  const stashRef = process.env.PT_JOBQ_STASH
  if (!stashRef) throw new Error('toggle ABORT: PT_JOBQ_STASH not set for apply')
  fs.writeFileSync(JOBQ, fs.readFileSync(stashRef, 'utf-8'))
}

console.log(`toggle ${mode}: OK (upload.ts 5 pairs ${mode === 'revert' ? 'reverted' : 'applied'}; jobQueue.ts ${mode})`)
