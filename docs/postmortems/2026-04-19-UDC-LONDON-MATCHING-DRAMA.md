# Postmortem — UDC London 2026 Media-Matching Drama

**Date:** 2026-04-19 (Sunday, UDC London Day 3)
**Authored:** 2026-04-19 post-show (from CompPortal + CSE context)
**Scope:** CSE (CompSyncElectronApp) + CompPortal plugin API. No R2/object-store data loss. Customer-visible impact: thumbnail loading, delayed photo-portal unblock, 12 zero-photo routines requiring triage.
**Status of fixes:** mixed — several shipped live today (field-name alias, last_used_at debounce, ffmpeg thumbnails, UPLOAD_ALL filter loosening). The rest are proposed below, not shipped.

---

## TL;DR

Seven overlapping failure modes compounded over three days. None lost R2 object data; three lost *metadata* (EXIF captured_at, thumbnail_url, photo→routine mapping); three delayed re-ingest (watermark trap, lost queue, routine status drift); one almost melted the DB (plugin_api_keys hot-row). All seven are addressable with small, isolated changes. The highest-impact single fix not yet shipped is a watermark-safety invariant (never advance past unconfirmed-upload photos).

**Customer-visible residual:** 12 UDC London routines with zero photos (8 are the 502→509 CSE upload-gap cluster; 4 standalone); 7,251 photos needed thumbnail backfill (now 100% recovered); parent-portal unblock delayed by ~24h waiting on integrity audit.

---

## Timeline (all times Eastern)

### 2026-04-17 Fri — Day 1, first media-only competition
- Forward-going capture + upload ran. A portion of the day required overnight recovery — the 21k-photo "Friday recovery" scan referenced in `docs/plans/2026-04-18-friday-recovery-truths.md`. EXIF date-matching drift was noted (photos matched to wrong day by time-of-day only).
- Late Fri / early Sat: manual recovery script labelled EXIF as `+00:00` when values were actually local EDT → 4h offset across all overnight-matched photos. Required re-match.

### 2026-04-18 Sat — Day 2
- Forward capture continued; a group of Saturday routines never had their full SD drain completed before EOD.
- Wrong-date detection (`driveMonitor.sampleAndReportCameraClock`) flagged false positives because the sampler grabbed the filename-alphabetical-first JPEGs, which are the oldest — SDs already carried yesterday's photos → fake "N days off" popup.
- **Operator manually patched `compsync-state.json` on Sunday morning:** Fri+Sat routines force-set to `uploaded`, R433 `skipped`, `currentRoutineId` cleared, 10 `sdWatermarks` pre-seeded per body key (INBOX.md line 243). This was the only way to get the app back into a known-good starting state — but it also lied to the `UPLOAD_ALL` filter about which routines were actually drained.

### 2026-04-19 Sun — Day 3 (hottest day)
- **~09:22 ET:** Sharp thumbnail TypeError observed on every photo (pre-fix). Thumbnails silently left NULL; upload still succeeded, plugin/complete still called, `media_photos.thumbnail_url` populated as `""` or omitted.
- **10:55 ET:** CSE asar `467E6DD5…` deployed — first sharp fix attempt (explicit boolean options). Did not help.
- **13:00 ET:** CSE asar `9FB3492B…` deployed — offset detector hardening + multi-SD import queue. Sharp errors still firing (51 failures in last 500 log lines).
- **13:04 ET:** False-positive `CAMERA_CLOCK_MISMATCH` popup — H:\ "17 days off", F:\ "2 days off". Operator confirmed clocks correct.
- **13:07 ET:** Thumbnail TypeError continued (post-fix verification failure).
- **13:11–13:12 ET:** Main-thread freeze during H:\ + F:\ simultaneous import (~4,440 new post-watermark photos). UI unresponsive ~2 minutes while enqueue + match loops ran. OS reported process alive, no crash.
- **~14:42 ET:** CompPortal commit `c542a945` shipped straight to main: `/plugin/complete` now accepts both `photo_captured_at` (current CSE name since commit `0fa6e9e` on 2026-04-18) AND `capture_times` (legacy server-side name). Until this fix, every Sunday upload (R510–R525, 3,600+ photos) had `captured_at=null` on every photo because the server silently ignored the unknown field. Re-invocation backfill run later.
- **Sunday evening upload storm:** CSE hammered `/api/plugin/auth-check` / upload-url endpoints at several hundred req/s. Each request touched the same `plugin_api_keys` row to bump `last_used_at`. Tuple-lock pile-up → statement timeouts → cascading 500s.
- **~18:00 ET:** CompPortal commit `118112ab` shipped: 5-minute debounce on `last_used_at` writes (`src/lib/plugin-auth.ts:50-63`). DB recovered.
- **18:35 ET:** Operator restarted CSE to drain remaining uploads post-show.
- **~18:45 ET:** 33 routines had 1,384+ photos with `uploaded:false`. `Upload All` clicked → log says `Upload all: queued 0 routines` three times. Root cause: `UPLOAD_ALL` outer filter required `routine.status !== 'uploaded' && !== 'confirmed'`. Earlier batches had succeeded → routine.status was `uploaded/confirmed` → filter excluded them even though photos arrays still contained `uploaded:false` entries.
- **19:08 ET:** INBOX.md incident entry written.
- **19:20 ET:** Workaround applied via DevTools one-liner (`window.api.uploadRoutine(r.id, true)` per routine). Did not require restart so the patched in-memory-queue path worked. Uploads drained.
- **19:04–19:13 ET:** CompPortal-side admin backfill endpoint (`/api/media/admin/backfill-thumbnails`) deployed (commit `50c19815`) and regenerated 7,251 missing UDC London thumbnails. 100% coverage restored.
- **~19:30 ET:** Integrity audit complete — 12 zero-photo routines surfaced. 8 in cluster 502→509 (CSE upload gap 01:06–01:28 UTC; packages created, photos never uploaded), 4 standalone (332, 483, 608, 609). Media-portal unblock deferred to Mon midday pending these 12.
- **Working tree (not yet deployed):** CSE `UPLOAD_ALL` filter in `src/main/ipc.ts:422` loosened to enqueue when `routine.photos.some(p => !p.uploaded)` regardless of `routine.status`. Awaiting v7 deploy.

---

## Root patterns

Each section lists current code, failure mechanic, customer impact, and detection gap. Proposed fixes are in the next section.

### A. `markCurrentSdsAsProcessed` is too coarse

**Code:** `src/main/services/photos.ts:1522-1554` — scans every JPEG on every mounted camera drive, computes `maxByBody[body] = highest filename`, calls `state.setSdWatermarksBulk(maxByBody)`. See also the "auto-advance on import" path at `photos.ts:1243-1252` inside `importPhotos`, which does the same thing on every successful import run (using `partitionedPathsRaw`, the full scanned set, not just matched or uploaded photos).

**Failure mechanic:** A watermark advance is a *permanent* instruction to skip filenames ≤ the watermark on all future imports. The current implementations advance the watermark based on what exists on the SD right now — including photos that are sitting unmatched, not yet copied, not yet uploaded, and not yet acknowledged by the server. If the operator hits "Mark SDs as processed" (or runs an import that fails partway through), the watermark advances past photos that never landed in R2. Those photos are silently orphaned forever on that SD — next insertion skips them.

**Customer impact (estimated):** This likely contributed to the Saturday routines whose photos never reached the server. The 2026-04-19 morning state-patch pre-seeded 10 watermarks across camera bodies (INBOX.md line 243). If any Sat routine's photos sat between the capture time and the pre-seeded watermark, they became invisible to every subsequent import. The 4 standalone zero-photo routines (332, 483, 608, 609) are plausible casualties; definitive attribution requires SD forensics.

**Detection gap:** No signal. The operator presses a button and the toast says "marked N drives". There is no "N photos behind watermark are unuploaded" warning because the function doesn't cross-check state.

### B. Routine `status` and per-photo `uploaded` flag drift

**Code:** `src/main/services/upload.ts:201-302` (`enqueueRoutine`) skips photos where `photo.uploaded === true`. Routine-level status is set to `uploaded`/`confirmed` when the video flow completes. Photos arriving later on an already-`uploaded` routine don't roll the status back.

**Failure mechanic (the 19:08 ET incident):**
1. Routine R has video + initial photo batch — all upload. `routine.status = 'uploaded'`.
2. Operator inserts an SD later in the day. Import adds N more photos to `R.photos[]` with `uploaded:false`.
3. Operator restarts the app. `R.status` is still `'uploaded'` (persisted).
4. Operator clicks "Upload All". The pre-fix filter was:
   ```ts
   for (const routine of comp.routines) {
     if (routine.status === 'uploaded' || routine.status === 'confirmed') continue
     // enqueue...
   }
   ```
   → R is skipped. The N unuploaded photos on R sit idle.

**Current state:** The working tree has a patched version (`ipc.ts:429-449`) that *also* checks `routine.photos.some(p => !p.uploaded)` before skipping. This is not yet in the live asar.

**Customer impact:** 33 routines × ~42 photos avg = 1,384+ photos held idle for ~1h post-show until the DevTools workaround. Zero permanent loss — the workaround drained them — but the parent portal's planned Sunday-evening content window was blown.

**Detection gap:** The log line `Upload all: queued 0 routines` is the only signal. Operator happened to notice it three times in a row. A non-observant operator would have gone home, restarted the next day, and the Monday `Upload All` would have behaved the same way until somebody flipped `routine.status` by hand in state.json.

### C. Job queue *is* persisted — but operator state patching defeats it

**Important clarification on the original scope note:** the CSE job queue is already persisted. See `src/main/services/jobQueue.ts:55-84,118-140`. `enqueue()` calls `flushSync()` inline (line 139). `load()` reads `job-queue.json` on startup and flips any `running` jobs back to `pending`. `init()` is wired from `src/main/index.ts:243`. So "app restart loses queue" is not literally true today.

**What actually broke:** On Sunday morning the operator hand-edited `compsync-state.json` to mark Fri+Sat routines as `uploaded/confirmed`. This touched only `compsync-state.json` — NOT `job-queue.json`. Any job-queue state that had survived earlier restarts no longer mattered, because the UPLOAD_ALL filter keyed off `routine.status` (which had just been manually lied about), not off pending jobs.

**Net: the persistence exists, but two classes of action can still "lose" work:**
1. Manual `compsync-state.json` patching with no corresponding `job-queue.json` update or audit entry.
2. Any code path that reads `routine.status` or `routine.photos[i].uploaded` as truth without cross-checking `jobQueue.getByRoutine(routine.id)` or the DB.

**Detection gap:** No audit trail on state.json edits. A diff is not recorded; no operator knows what was changed or when.

### D. Field-name drift: `photo_captured_at` vs `capture_times`

**Code:**
- CSE: `src/main/services/upload.ts:1051,1071` sends `files.photo_captured_at` (landed 2026-04-18, commit `0fa6e9e`).
- CompPortal (before `c542a945`): `src/app/api/plugin/complete/route.ts` read `files.capture_times` only.
- CompPortal (after `c542a945`, 2026-04-19 ~14:42 ET): reads either name, prefers `photo_captured_at`.

**Failure mechanic:** No field-level schema handshake between CSE and the plugin API. Server silently dropped the unknown field for ~20h (from the 2026-04-18 CSE deploy of `0fa6e9e` through the 2026-04-19 14:42 server hotfix). Every photo in that window was persisted with `captured_at=null`. Affected: R510–R525 plus any Sunday routines that uploaded before the server fix — 3,600+ photos.

**Customer impact:** EXIF-ordered galleries degraded to upload-ordered for affected photos. Downstream consumers that rely on `captured_at` (e.g. chronological merge across cameras, temporal-outlier audit rule 8) returned degraded results. Recoverable by re-invoking `/plugin/complete` per routine from state.json (the local sidecars still hold EXIF) — requires a backfill pass.

**Detection gap:** Server 200-OKs unknown fields (per Next.js route conventions — extra body keys are not validated). Zero logging on either side. Only discovery path was "open DB, find `captured_at` nulls on every Sunday photo" — which someone noticed ~20h in.

### E. Sharp/thumbnail failure silent at per-photo granularity

**Code:** `src/main/services/photos.ts` previously called `sharp(destFile, {failOn:'none',…}).rotate().resize(200,200,{fit:'cover'}).webp({quality:80,…}).toFile(thumbPath)` in the import copy loop. Error thrown: `TypeError: A boolean was expected at Sharp.toFile (output.js:1536)`.

**Current mitigation:** Thumbnail generation was moved out of the import loop in T-H17 and switched to ffmpeg subprocess in `src/main/services/ffmpeg.ts:295` (`generatePhotoThumbnail`). Upload worker calls `ensurePhotoThumbnail()` on demand (`upload.ts:64-87`). Sharp is gone from the hot path.

**Residual problem:** the ffmpeg path still only returns `null` on failure (`upload.ts:81`, `ffmpeg.ts:320-338`). The upload proceeds, the photo lands in R2, `photoThumbnailStoragePaths[i]` is empty string, `media_photos.thumbnail_url` ends up NULL. There is NO surfaced counter on the routine, no toast, no dashboard indicator. The operator only discovers failures by inspecting DB.

**Customer impact:** 7,251 photos on UDC London (7% of total) had NULL thumbnails until Sunday evening's backfill. Parent galleries served full JPGs → slow page load + ~35× R2 egress per view. Zero data loss; purely UX degradation.

**Detection gap:** 4-24h. The 7% figure was discovered while writing the unblock runbook, not from any CSE-side signal.

### F. Hot-row contention on `plugin_api_keys.last_used_at`

**Status:** FIXED (CompPortal commit `118112ab`, 2026-04-19 ~18:00 ET). `src/lib/plugin-auth.ts:50-63` now writes `last_used_at` at most once per 5 minutes per API key.

**Failure mechanic:** Each `/api/plugin/*` request took a row-level lock on the same `plugin_api_keys` record to bump `last_used_at`. At several-hundred-req/s upload storm, lock-wait queue overflowed → statement timeouts → 500s → CSE retries → worse storm. Classic hot-row antipattern.

**Customer impact:** Cascading 500s on upload-url issuance during the evening storm. Uploads recovered once debounce deployed.

**Detection gap:** ~30 min between first timeout signal and deploy. Alerting on Supabase advisory locks would have caught this earlier — not wired.

### G. State patching is manual and risky (no audit log)

**Code:** None — the "tool" was a text editor on `compsync-state.json`.

**Failure mechanic:** Operator edits state.json between app runs to mark routines uploaded/skipped, clear `currentRoutineId`, or pre-seed watermarks (INBOX.md line 243). This is necessary because:
- No in-app "reset routine to uploaded" action exists.
- The upload queue in `job-queue.json` would otherwise try to re-upload drained routines on next restart.
- The Sat morning patch was triggered by loss of confidence in which routines had actually finished — the operator fixed the file to match their mental model.

**Risk:**
1. Typos or structural mistakes corrupt the file. (Mitigated by `state.ts:140-150` rolling backup.)
2. `compsync-state.json` and `job-queue.json` can drift silently. (No mitigation today.)
3. No record of what was changed or why. A post-hoc "why is R433 skipped?" question cannot be answered.

**Customer impact:** Indirect. The Sun morning patch flipped Fri+Sat routines to `uploaded` — which then triggered the 19:08 `UPLOAD_ALL` trap because anything arriving later in those routines became invisible to the outer filter.

**Detection gap:** Zero audit. The only reason we can piece this together is the INBOX.md narrative.

---

## Customer impact summary

| Category | Count | Recoverable? | Status as of 2026-04-19 19:30 ET |
|---|---|---|---|
| Photos with NULL `thumbnail_url` | 7,251 | Yes (server-side regen from R2 original) | ✅ 100% backfilled |
| Photos with `captured_at=null` (field drift) | 3,600+ | Yes (re-invoke /plugin/complete from state.json) | 🟡 backfill not yet run |
| Routines with zero photos (genuine gap) | 12 | Possibly — if SDs still hold them | ⏸ awaiting SD forensics decision |
| Routines stuck behind UPLOAD_ALL filter | 33 | Yes (DevTools workaround drained them) | ✅ drained 19:20 ET |
| Plugin/complete EXIF ordering degraded | 15–20 routines | Yes after backfill (E above) | 🟡 pending |
| DB statement timeouts during upload storm | Minutes of errors | N/A (transient) | ✅ debounce shipped |

**Media-portal unblock for UDC London:** delayed from Sunday evening (original plan) to Monday midday (runbook deadline) pending the 12 zero-photo decision.

---

## Detection gap summary

| Pattern | Gap (time to discover) | Signal that fired | Missing signal |
|---|---|---|---|
| A — watermark over-advance | ∞ (never caught by system) | None | "watermark advanced past N unuploaded photos" toast |
| B — status/photo drift | ~30 min (operator noticed `queued 0`) | Log line | Non-zero counter on dashboard |
| C — state vs queue divergence | ∞ (only via audit) | None | Diff of state.json + queue on every mutation |
| D — field-name drift | ~20 h | Manual DB inspection | Server-side unknown-field warning; schema handshake |
| E — thumbnail silent failure | 4–24 h | Manual DB inspection | Per-routine failure counter + toast |
| F — hot-row contention | ~30 min | 500s spike | Lock-wait alerting |
| G — manual state patching | ∞ | None | Diff log on state.json writes |

---

## Action items

### CompPortal (server side)
- ✅ `plugin/complete` accepts `photo_captured_at` + `capture_times` (shipped `c542a945`).
- ✅ `last_used_at` debounced to 5-min (shipped `118112ab`).
- ✅ Admin thumbnail backfill endpoint (`/api/media/admin/backfill-thumbnails`, `50c19815`).
- 🟡 Consider a `/api/plugin/schema` or `/api/plugin/healthcheck` endpoint that returns expected field names + a schema version (see CSE recommendation #4).
- 🟡 Add Postgres advisory-lock alerting for hot-row detection.
- 🟡 Log + return 4xx (not 2xx) on unknown fields in `/plugin/complete` — at least in a "strict" mode CSE can opt into.

### CSE (client side)
- ✅ `UPLOAD_ALL` filter loosened to check `routine.photos.some(!uploaded)` (working tree; awaits v7 deploy).
- ✅ Sharp replaced with ffmpeg for thumbnail generation (shipped).
- 🟢 **Ship #3 first** (persistent queue already exists — close the "manual state patch desynced it" gap; see recommendation #3 below).
- 🔴 **Highest unfixed risk** is A (watermark over-advance). See recommendation #1.
- 🔴 Next highest: B (status rollback on late-arriving photos). See recommendation #2.
- 🟡 D (schema handshake), E (thumbnail visibility), G (state audit log). See recommendations #4/#5/#7.

---

## Proposed CSE code changes

Each section below is a proposal. Nothing has been applied. Working tree already has many modifications to the same files, so the reviewer should diff-and-merge rather than naively overlay.

### 1. Watermark safety — separate "scanned" from "uploaded"

**Problem:** `markCurrentSdsAsProcessed` (photos.ts:1522-1554) advances `sdWatermarks` to the highest filename observed on disk. So does the auto-advance path inside `importPhotos` at photos.ts:1243-1252. Neither cross-checks whether the advanced-past photos are actually uploaded.

**File:** `src/main/services/photos.ts`

**Current behavior** (photos.ts:1534-1548):
```ts
for (const d of drives) {
  const files = await collectJpegFilenames(d.photoPath)
  for (const full of files) {
    const body = getCameraBodyKey(full)
    if (!body) continue
    const f = path.basename(full).toUpperCase()
    if (!maxByBody[body] || f > maxByBody[body]) maxByBody[body] = f
  }
}
state.setSdWatermarksBulk(maxByBody)
```

**Proposed behavior:** Refuse to advance past any file whose manifest entry is not `uploaded:true`. Two cursors:
- `scanWatermark` — highest filename seen on disk (for "don't re-read EXIF" optimization).
- `uploadWatermark` — highest filename for which `manifestEntries.find(e => e.sourcePath === full).uploaded === true`. This is the cursor used by the SD watermark filter in `importPhotos` (photos.ts:764-795).

Pseudocode:
```ts
for (const d of drives) {
  const files = await collectJpegFilenames(d.photoPath)
  for (const full of files) {
    const body = getCameraBodyKey(full)
    if (!body) continue
    const f = path.basename(full).toUpperCase()
    const manifestEntry = await manifest.findBySourcePath(full)
    // Only advance the upload watermark past files we know landed in R2.
    if (manifestEntry?.uploaded === true) {
      if (!maxByBody[body] || f > maxByBody[body]) maxByBody[body] = f
    }
    // (scanWatermark is advanced unconditionally for EXIF-skip perf — separate field.)
  }
}
state.setSdWatermarksBulk(maxByBody)  // only uploadWatermarks
// After advancing, report the gap:
const unconfirmedCount = files.length - countUploadedOnDrive(files)
if (unconfirmedCount > 0) {
  sendToRenderer(IPC_CHANNELS.TOAST, {
    level: 'warn',
    message: `${unconfirmedCount} photos on SD not yet confirmed uploaded — watermark held back`,
  })
}
```

**Test plan:**
1. Insert SD with 100 photos, 60 of which have `manifestEntries[i].uploaded = true`. Call `markCurrentSdsAsProcessed`. Expect: watermark set to the highest *uploaded* filename; toast reports 40 pending.
2. Remove SD before upload completes. Insert again next day. Verify the 40 pending photos are re-read (watermark filter does NOT skip them).
3. Unit: mock `manifest.findBySourcePath` to return `uploaded:false` for the top 10. Expect those 10 excluded from `maxByBody`.

**Risk:** Low. Changes a persistent side effect in the operator-triggered path and the end-of-import auto-advance. No change to the watermark-filter read path.

---

### 2. Routine status rollback — `partial` state when new photos land after upload

**Problem:** When import copies new photos into `routine.photos[]` with `uploaded:false`, and `routine.status` is already `uploaded`/`confirmed`, status never rolls back. UPLOAD_ALL filter (pre-fix) missed them. The working-tree patch papers over this by checking `photos.some(!uploaded)` in the filter; the cleaner fix is to keep status + photos[] in sync at write time.

**Files:**
- `src/main/services/photos.ts` — `importPhotos` photo-copy loop around line 1190-1197.
- `src/shared/types.ts` — `RoutineStatus` union (add `'partial'`).
- `src/main/services/state.ts` — `updateRoutineStatus` callers.
- `src/main/ipc.ts:422-453` — revert to simpler filter.
- Renderer: `RoutineTable.tsx` needs a badge for `'partial'`.

**Current behavior** (photos.ts:1190-1198):
```ts
if (!previewOnly) {
  for (const [routineId, routinePhotos] of photosByRoutine) {
    const routine = routines.find(r => r.id === routineId)
    if (routine) {
      state.updateRoutineStatus(routineId, routine.status, { photos: routinePhotos })
    }
  }
  broadcastFullState()
}
```

**Proposed behavior:**
```ts
if (!previewOnly) {
  for (const [routineId, routinePhotos] of photosByRoutine) {
    const routine = routines.find(r => r.id === routineId)
    if (!routine) continue
    const incomingUnuploaded = routinePhotos.some((p) => !p.uploaded)
    // If the routine had previously reached a "done" state and new photos
    // arrive that need uploading, demote to 'partial' so downstream filters
    // and UI both see there's unfinished work.
    const nextStatus =
      incomingUnuploaded && (routine.status === 'uploaded' || routine.status === 'confirmed')
        ? 'partial'
        : routine.status
    state.updateRoutineStatus(routineId, nextStatus, { photos: routinePhotos })
  }
  broadcastFullState()
}
```

Then the UPLOAD_ALL outer filter can be:
```ts
if (routine.status === 'uploading') continue
if (routine.status !== 'partial' &&
    routine.status !== 'uploaded' &&
    routine.status !== 'confirmed' &&
    !routine.encodedFiles) continue
```
— and `partial` routines naturally pick up their stragglers via `enqueueRoutine` which already skips individual uploaded photos. Video-encoding gating is unchanged.

When all photos on a `partial` routine have landed, upload.ts `markRoutineDone` equivalent should promote back to `uploaded`/`confirmed` per existing promotion rules.

**Test plan:**
1. Set up routine with video + 100 photos, all `uploaded:true`, status `uploaded`.
2. Run a second SD import that adds 20 more photos.
3. Expect `routine.status = 'partial'`. Click UPLOAD_ALL. Expect only the 20 new photos enqueued (not the 100 already-done). After all 20 land, status returns to `uploaded`.
4. Also cover the restart case: step 2 → kill app → relaunch → state loaded → `partial`. Click UPLOAD_ALL. Same outcome.

**Risk:** Medium. Introduces a new status value. UI must handle it (new badge + color). Any code path switching on status will need to know about `partial` (grep for `'uploaded'` / `'confirmed'` in renderer). Preserves the working-tree safety filter as a belt-and-suspenders backup.

---

### 3. Persistent queue — verify it actually works across restart

**Update to original scope:** the queue is already persisted via `src/main/services/jobQueue.ts`. `init()` is called on startup (`src/main/index.ts:243`), `cleanup()` on shutdown (`index.ts:503`), `enqueue()` calls `flushSync()` inline. So the proposed fix shifts from "add persistence" to "verify it works and surface any desync at startup".

**Files:**
- `src/main/services/jobQueue.ts` (already persisted — audit only).
- `src/main/index.ts` (startup sequence).

**Proposed additions:**
1. On startup, after `jobQueue.init()`, emit a summary log: `Job queue hydrated: N pending, M running (reset to pending), K failed, L done.` If N > 0, also show an in-app banner: "Resuming N pending uploads from last session." Operator sees the queue survived and has a clear expectation.
2. Cross-check at startup: for each `routine` in state, count `jobQueue.getByRoutine(r.id).filter(j => j.status !== 'done' && j.status !== 'cancelled')`. If a routine has `status = 'uploaded'` but pending jobs exist, log a WARN and promote to `partial`. If status is pending but no queue entries, that's normal (never enqueued). The point is to catch the state-patching-desync class (G).
3. Add a button "Resume Unfinished Uploads" in UI (INBOX.md has this already queued). Action: iterate routines, ignore status entirely, re-enqueue any routine with `photos.some(!uploaded)` via `enqueueRoutine(r, /*force=*/false)`. Belt for the suspenders.

**Test plan:**
1. Enqueue 50 upload jobs. Verify `userData/job-queue.json` contains them. Kill app mid-upload. Relaunch. Expect: banner "Resuming 47 pending uploads"; log confirms 3 running→pending reset; uploads resume.
2. Simulate state-patching desync: manually edit `compsync-state.json` to mark R42 `uploaded`. Leave `job-queue.json` alone (still has 10 pending uploads for R42). Relaunch. Expect: WARN log "R42 has 10 pending jobs but status=uploaded — demoting to partial"; UPLOAD_ALL picks it up.

**Risk:** Low. Additive only. Log + banner + button. No behavior change on the happy path.

---

### 4. Field schema handshake — `/plugin/schema` healthcheck on CSE startup

**Problem:** Silent field drop for 20h (pattern D). Server 200-OKs requests with unknown fields; CSE assumes delivery succeeded; DB nulls pile up.

**File proposals:**
- CompPortal: `src/app/api/plugin/schema/route.ts` — new endpoint returning the expected shape of `/plugin/complete` body (field names + JSON Schema for each). Versioned. Example:
  ```ts
  return NextResponse.json({
    version: '2026-04-19',
    endpoints: {
      'POST /api/plugin/complete': {
        body: {
          entryId: 'string',
          competitionId: 'string',
          uploadRunId: 'string',
          files: {
            performance: 'string?',
            photos: 'string[]?',
            photo_thumbnails: 'string[]?',
            photo_captured_at: 'string[]?',  // preferred
            capture_times: 'string[]?',      // legacy alias
            video_keyframes: 'string[]?',
          },
        },
      },
    },
  })
  ```
- CSE: `src/main/services/compPortal.ts` — on app init after upload-connection resolves, fetch `/api/plugin/schema`, diff against a bundled `schema-expected.json`, and:
  - If exact match: silent pass.
  - If fields CSE sends are all present in server's accepted list: log INFO.
  - If CSE sends fields the server does NOT accept (drift): log ERROR and surface a blocking toast. Refuse to start uploads until acknowledged.
  - If the server accepts fields CSE doesn't send: log WARN ("new server capability").
- Fallback for offline / no `/schema` endpoint: treat as legacy server, log WARN but proceed.

**Test plan:**
1. Mock server returning schema missing `photo_captured_at`. Expect CSE to block uploads with a clear modal.
2. Mock server returning schema with an additional `photo_widths` field. Expect INFO-level log, no block.
3. Mock server returning 404 on `/schema`. Expect WARN, uploads proceed.

**Risk:** Low. New endpoint server-side (additive). New startup call CSE-side — failure mode defaults to "proceed with WARN".

---

### 5. Thumbnail failure visibility

**Problem:** `ensurePhotoThumbnail` returns `null` on failure. Photo uploads without thumb. No counter, no toast, no dashboard indicator. Discovery window 4-24h (pattern E).

**Files:**
- `src/main/services/upload.ts:64-87` (`ensurePhotoThumbnail`) + upload loop around line 555-562.
- `src/shared/types.ts` — add `Routine.thumbnailFailures?: number`.
- `src/main/services/state.ts` — new `incrementThumbnailFailure(routineId)` helper.
- `src/renderer/components/RoutineTable.tsx` — surface a pill "3 thumbs failed — Regenerate".
- New IPC channel `PHOTOS_REGEN_THUMBS_FOR_ROUTINE`.

**Proposed behavior:**
- When `ensurePhotoThumbnail` fails for a photo in a given routine, call `state.incrementThumbnailFailure(routineId)`.
- Upload continues. Photo lands in R2. `photoThumbnailStoragePaths[i] = ''` as today.
- The routine row in the UI shows a yellow pill: `⚠ N thumbnails missing — Regenerate`. Button invokes the new IPC, which loops the routine's photos, re-runs `ensurePhotoThumbnail` on any whose `thumbnailPath` is not present, and re-uploads the thumb alone (new payload type `type: 'thumbnail-retry'` or similar). On success, decrement the counter.
- Server side: CompPortal's existing `/api/media/admin/backfill-thumbnails` endpoint can be the regen backend — no sharp inside CSE.

**Test plan:**
1. Force `generatePhotoThumbnail` to return `false` (mock ffmpeg failure). Import 50 photos. Expect `routine.thumbnailFailures = 50`. UI shows pill. Click Regenerate → counter decrements as server-side backfill confirms thumbs.
2. Simulate mixed success: 45 succeed, 5 fail. Upload proceeds; counter = 5. Regenerate one-click fixes them.

**Risk:** Low-medium. Purely additive to existing silent-failure path. Only risk is the regen flow itself — but that's also additive.

---

### 6. `last_used_at` debounce — DONE server-side

Already shipped: CompPortal commit `118112ab` (`src/lib/plugin-auth.ts:50-63`). No CSE change needed.

Optional CSE follow-up: batch `/api/plugin/auth-check` calls. Currently each upload re-validates the key. CSE could cache a positive auth-check result for the session and reuse the CompPortal-issued `keyId` until a 401 forces a re-check. Would halve plugin_api_keys read pressure. Low priority — debounce already solved the hot-row write problem.

---

### 7. State patch audit log

**Problem:** Manual edits to `compsync-state.json` are silent (pattern G). No record of what changed, when, or why. Future "how did R433 get to skipped?" is unanswerable.

**Files:**
- `src/main/services/state.ts` — add `.patch-log.jsonl` writer.
- Optionally a new CLI tool `tools/patch-state.ts` for operators to use instead of a text editor.

**Proposed behavior (minimal):**
- On `loadState()`, compute a hash of the file (sha256 of the JSON). Store in memory.
- On next `doSave()`, before writing, compute the current hash and compare to last-write-after hash. If the file changed *externally* (i.e. the current on-disk hash != last-write-after hash), the user-data dir was edited between runs. Write a structured entry to `compsync-state.json.patch-log.jsonl`:
  ```json
  {"ts":"2026-04-19T08:30:00Z","kind":"external-edit-detected","fields_changed":["routines[42].status","sdWatermarks"],"pre_hash":"abc","post_hash":"def"}
  ```
- Take a timestamped backup of the pre-patch file.
- Surface a one-time toast: "state.json was edited outside the app — diff saved to …/patch-log.jsonl".

**Test plan:**
1. Start app, shut down. `state.json` on disk has hash H1.
2. Hand-edit `state.json` to flip R42 status. Hash changes to H2.
3. Restart app. Expect: toast fires, `patch-log.jsonl` contains an entry with the field diff, pre-patch backup saved as `compsync-state.json.pre-patch-<ts>.bak`.

**Risk:** Low. Purely observational. Doesn't block or reverse any patch; just records it.

---

## Lowest-risk ship-tonight candidate: none

The working tree on `src/main/services/state.ts`, `photos.ts`, `upload.ts`, `ipc.ts`, and many other files is extensively modified (see `git status` — 20+ modified files in `src/`). Shipping the recommended "persistent queue startup log" addition (#3.1) would touch `src/main/index.ts` startup logic on top of in-flight changes. That's additive but in the same path as undeployed work the operator is about to v7-deploy. Merge risk non-zero; discovery cost of a subtle ordering bug in startup is high.

**Decision: write the postmortem; do NOT ship code.** Per the budget's "Quality > speed" guidance and the "do not push without tsc --noEmit" gate — a clean ship requires a dedicated non-autonomous session on a clean tree (or a conscious rebase of the in-flight work). The risk of bolting startup-log code onto a tree that already has modifications the reviewer hasn't seen outweighs the modest benefit of one extra INFO log tonight.

---

## Additional patterns found while researching (not on the original list)

### H. Main-thread saturation during large imports (documented in INBOX.md line 56-70)

Not novel — already in the INBOX as a CRITICAL issue. Called out here for completeness: the freeze during the 13:11-13:12 ET H:\ + F:\ import compounded all the other failures because the operator could not click "Upload All", retry buttons, or the counter overlay while diagnosing. This is an amplifier of every other pattern's detection gap. Fix direction is well-specified in INBOX.md: move EXIF + matching to a worker thread, cap per-tick work, add a responsiveness heartbeat indicator.

### I. Off-by-one / partial advance in `importPhotos` auto-watermark path (photos.ts:1243-1252)

The auto-advance on successful import uses `partitionedPathsRaw` (the full scanned set *before* duplicate and wrong-date filtering) to compute `maxFileByBody`. So if a run scans 500 files, drops 200 as wrong-date, and uploads the remaining 300 — the watermark still advances past all 500. The 200 dropped files are never re-considered. On a future day, if those 200 *were* legitimately today's photos (e.g. a camera clock was off by a day and got corrected), they're gone from the scanner's view permanently. Fix is same as recommendation #1 (cross-check with manifest before advancing) but worth calling out separately — this path fires every import, not just on the operator button.

### J. Orphan handling retains ALL matches, even those destined to be dropped by the wrong-date filter

`skipMismatchedDates` (photos.ts:823) drops wrong-date photos from the `photos[]` array BEFORE matching. They never become orphans. If the wrong-date detection was a false positive (the sampler bug, pattern in INBOX.md line 74-86), those photos silently vanish. Current orphan drawer cannot recover them because they were never passed through the orphan pipeline. Fix direction: route wrong-date photos to a dedicated `_skipped-wrong-date/<runId>/` sidecar folder with an operator "unskip and match" action. Preserves the SD auto-flow speed (filter still drops them from matching) while keeping a recovery path.

### K. Upload.ts `publishedPhotoCountByRoutine` map loses state on app restart

`upload.ts:144` — `publishedPhotoCountByRoutine` is in-memory only. It tracks how many photos have been included in a `/plugin/complete` call per routine, so incremental completes know when to re-publish. On restart, this is lost; the next /plugin/complete might re-send already-sent photo indices. The server upsert path should dedupe (media_photos by storage_key), so duplicate payload is idempotent on wire but wastes bandwidth. Similar-class issue to the (now-solved) job queue persistence. Low priority — cosmetic on the happy path.

---

## Handoff notes

- Most proposed changes sit in files with existing working-tree modifications. Any implementer MUST `git diff` first and either rebase their changes onto the current work or wait for v7 deploy to land.
- CompPortal side: the three shipped fixes today (`c542a945`, `118112ab`, `50c19815`) are already in `main`. The field-alias fix is doing double duty (accepts both new and legacy names) so the CSE side can migrate at leisure.
- CSE asar in-flight is v7 (from INBOX: "awaits v7 deploy"). Live asar is `9fb3492bb38c9758bd4da50c7d2e1618` as of 13:00 EDT 2026-04-19. Rollback target: `app.asar.bak-2026-04-18-1442-SAFE-overlayModeV1`.
- Media-portal unblock plan: `docs/runbooks/UDC_LONDON_MEDIA_UNBLOCK.md` in CompPortal. Awaiting decision on the 12 zero-photo routines (re-upload from SD vs publish-with-gap vs hide).

---

## Appendix — file references (CSE)

- `src/main/services/photos.ts:764-795` — SD watermark filter (read path)
- `src/main/services/photos.ts:1190-1198` — routine status update after import (drift site)
- `src/main/services/photos.ts:1243-1252` — auto-advance watermark after import (pattern A, secondary site)
- `src/main/services/photos.ts:1522-1554` — `markCurrentSdsAsProcessed` (pattern A, primary site)
- `src/main/services/state.ts:92-115` — `saveState` / `saveStateImmediate`
- `src/main/services/state.ts:165-200` — `applyLoadedState` (hydration)
- `src/main/services/state.ts:762-800` — `setSdWatermark` / `setSdWatermarksBulk`
- `src/main/services/upload.ts:64-87` — `ensurePhotoThumbnail`
- `src/main/services/upload.ts:201-302` — `enqueueRoutine`
- `src/main/services/upload.ts:1030-1110` — `callPluginComplete` (field names)
- `src/main/services/jobQueue.ts:55-84,118-140` — persistent queue (already works)
- `src/main/ipc.ts:422-453` — `UPLOAD_ALL` handler (working tree has the loosened filter)
- `src/shared/types.ts:420-423` — `photo_captured_at` + `capture_times` (plugin payload schema)

## Appendix — file references (CompPortal)

- `src/lib/plugin-auth.ts:30-69` — `last_used_at` debounce (shipped `118112ab`)
- `src/app/api/plugin/complete/route.ts:55-63` — field-name alias (shipped `c542a945`)
- `src/app/api/media/admin/backfill-thumbnails/route.ts` — (shipped `50c19815`; not read for this document but referenced)
- `docs/runbooks/UDC_LONDON_MEDIA_UNBLOCK.md` — full unblock plan + audit findings
