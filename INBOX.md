# Electron App INBOX — Active Items

Last audited: 2026-05-05 22:27 EDT. Operator confirmed "almost all stale" — entire archive below is pre-build8 / pre-build9 work or operator-superseded.

## Active

## From CSController / HEVC decoder swap — 2026-05-15 08:33 EDT

APK: https://drive.google.com/file/d/1SMPH3nhVbbGeUtYVHqPcyiAvJ5t6erWU/view
Local APK: `/home/danman60/projects/CSController/app/build/outputs/apk/debug/app-debug.apk`
APK size: 9,605,207 bytes
SHA256: `173916377ee1e4a961660acc80d8c9e71e42579a92252fc499646cbc5df5b2ab`
Decoder MIME flip: operator-selectable `video/avc` or `video/hevc`; default remains `video/avc`.
CSD parser changes: none; existing path passes complete NAL payloads through to MediaCodec.
Tested on emulator/tablet: no; build only.
Ready for operator smoke test: yes, with CSE encoder still default-off until tablet render is confirmed.

Active work tracked in:
  - `docs/plans/2026-05-03-build9-fix-list.md` — build #9 fix list (status table inline)
  - `docs/plans/2026-05-04-late-cut.md` — Late Cut spec, not yet implemented
  - `docs/plans/2026-05-05-build9-items-3-4-11-plan.md` — items #3, #4, #11 design + status

## Archive (everything below — pre-build8 / pre-build9, mostly stale per operator 2026-05-05)

If an item below resurfaces in operator complaint, lift it back to ## Active above.

---

## BUG P0 2026-04-24 16:23 EDT — Hallucinated 20-photo threshold blocking Latest Photos visibility (FUNCTIONALLY ADDRESSED — incrementalPublishEvery default = 1 in types.ts:1476; threshold-gate cleanup never landed but UX is correct)

**This is a regression, not a feature.** Introduced in commit `452a6de8` (2026-04-19 14:08 UTC) which bundled three things under "feat(upload): round-robin photo upload + incremental plugin/complete + sharp thumbnail fix":
1. Round-robin upload strategy (legitimate, user-requested)
2. Sharp thumbnail fix (legitimate, user-requested)
3. **`incrementalPublish: true` + `incrementalPublishEvery: 20`** (NOT requested — hallucinated optimization snuck in alongside the approved work)

Operator intent recorded 2026-04-24 16:23 EDT: *"We just want that page to show the latest photos. Then as long as the app is prioritizing the latest imported photos into upload, they should appear on the page. I never asked for a photo minimum before they appear that's ridiculous."*

**Symptom (UDC Toronto 2026 Day 1, live):** Photos for routines R202, R207, R211, R212, R218, R219 are successfully uploaded to R2 (confirmed via machine_logs: "[Upload] Uploaded: Q53A0XXX.JPG for routine ..."), but completely absent from CompPortal's Latest Photos view. Zero `media_packages` row, zero `media_photos` rows for those entries, yet bytes are in the bucket.

**Where the regression lives (`src/main/services/upload.ts:754-764`):**
```ts
if (payload.type === 'photos') {
  const settings = getSettings()
  if (settings.upload?.incrementalPublish) {
    const threshold = Math.max(1, settings.upload?.incrementalPublishEvery || 20)
    const donePhotoCount = updatedJobs.filter(j => j.status === 'done' && ...).length
    const lastPublished = publishedPhotoCountByRoutine.get(payload.routineId) || 0
    if (donePhotoCount - lastPublished >= threshold && !allDone) {
      void callPluginCompletePartial(payload.routineId, uploadRunId)
    }
  }
}
```
Default threshold is 20 (`src/shared/types.ts:1112 incrementalPublishEvery: 20`). `/plugin/complete` fires **only after 20 photos** for a routine have finished uploading — OR when the routine is `allDone` (every photo processed). Until one of those conditions, CompPortal has no idea any photos exist for that routine.

**Operational consequences during a live show:**
- Round-robin upload strategy (`jobQueue.getNext` round-robin, commit `2873904`) deliberately spreads uploads across all routines, delivering small batches per routine per pass. Makes the 20-threshold issue WORSE: every routine's first 19 uploads are invisible while the round-robin distributes more work.
- **Small routines (<20 photos total)** NEVER hit the threshold and only appear after `allDone` fires — usually tens of minutes after their first photo uploaded.
- Latest Photos UI is useless for the most recent content — exactly when parents/SDs/CDs need it most.

**Why this is wrong (operator intent, recorded 2026-04-24):** "We just want that page to show the latest photos. Then as long as the app is prioritizing the latest imported photos into upload, they should appear on the page. I never asked for a photo minimum before they appear that's ridiculous."

**Fix = revert the regression.** Drop the threshold gate. After each photo completes, fire `callPluginCompletePartial` directly — no `>= threshold` check, no `incrementalPublishEvery` setting.

Concrete diff in `upload.ts:753-764`:
```ts
// BEFORE (regression)
if (payload.type === 'photos') {
  const settings = getSettings()
  if (settings.upload?.incrementalPublish) {
    const threshold = Math.max(1, settings.upload?.incrementalPublishEvery || 20)
    const donePhotoCount = updatedJobs.filter(...).length
    const lastPublished = publishedPhotoCountByRoutine.get(payload.routineId) || 0
    if (donePhotoCount - lastPublished >= threshold && !allDone) {
      void callPluginCompletePartial(payload.routineId, uploadRunId)
    }
  }
}

// AFTER (revert)
if (payload.type === 'photos' && !allDone) {
  void callPluginCompletePartial(payload.routineId, uploadRunId)
}
```
Endpoint is already idempotent on `(media_package_id, storage_url)` per line 1135-1138 of `upload.ts`, so per-photo calls are safe — just chatty. `callPluginCompletePartial` sends cumulative paths; if the same photo is reported twice in consecutive calls (common under round-robin interleaving), CompPortal upserts and no duplicates appear.

**Also remove from defaults:** `incrementalPublish` and `incrementalPublishEvery` keys in `src/shared/types.ts:1111-1112`. Type definitions at types.ts:472-473 can stay or be removed for cleanliness. Do NOT bother migrating existing operator settings.json — once the code no longer reads those keys, they're inert.

**Testing:** start a recording, confirm the first photo hits Latest Photos within ~2s of completing PUT to R2.

**NOT fixable mid-show:** electron-store caches in-memory (`settings.ts:170 raw = store.store`). External JSON edits are ignored until process restart. Today's show continues with 20-threshold until next asar deploy + operator-initiated restart.

---

## FEATURE 2026-04-24 15:43 EDT — Operator-gated re-record disambiguation modal

**Context (UDC Toronto 2026 Day 1):** Multiple routines this morning had mis-slotted recordings (R118 into R119's slot, R136 into R139's, R140 into R142's, R145 long-recorded both R145+R146 into R145's slot). Two downstream consequences:

1. **Data mis-assignment in DB.** Photos match whichever routine's window swallowed the capture → end up on the wrong entry. Fixing after the fact requires: upload new split/archive videos to R2 → UPDATE `media_packages.video_*_path` + tighten window → UPDATE `media_photos.media_package_id` for photos outside the corrected window. Hours of post-show cleanup.

2. **Inconsistent archive preservation.** R139 and R142 both have `_archive/v1/` with the pre-overwrite take (app did the right thing). R118, R119, R136, R140 do NOT have archive folders despite the same class of mistake — suggesting either app-version drift or a code path that skipped archiving. Operator remembers "the app is built to never destroy a recording" — so the content should exist *somewhere*, but the absence of a consistent `_archive` convention makes recovery brittle.

**Proposed feature — non-blocking "Slot Already Recorded" modal:**

When `startRecording(routineId)` is invoked on a routine whose directory already contains a completed MKV/MP4 set, the app should:

1. **Not block.** Recording starts immediately; modal pops up in parallel (top-right toast-style or panel overlay, not a full-screen gate).
2. **Show both takes side-by-side** with key signals operator needs:
   - Existing take: duration, capture timestamp, first-frame thumbnail (reuse keyframes/keyframe_0.webp if present, else generate from MKV)
   - New take (in progress): live duration counter + timestamp
3. **Offer assignment UI:** two dropdowns ("Existing take → route to routine ___" and "New take → route to routine ___") pre-filled with the current and neighboring routines (±3). Operator picks.
4. **On confirm:** app atomically:
   - Moves the existing take's files to the chosen target routine's folder (renaming to match that routine's naming convention)
   - Leaves the new take in the current slot (or re-routes per dropdown)
   - Updates `state.json` routine entries: `Routine.recordingStartedAt`, `videoFiles`, `keyframes` paths
   - On next `/plugin/complete`, the corrected assignment rides through to CompPortal — no post-show DB cleanup needed
5. **If operator ignores modal:** both takes preserved (existing → `_archive/vN/`, new → slot); post-show reconciliation still possible.

**Why this matters beyond today:** Every live-show has slot-adjacency mistakes. Doing it at the moment of re-record (when operator still remembers context) is 10× cheaper than reconstructing the mental model 6 hours later from EXIF + file mtimes.

**Scope notes:**
- UI lives in renderer (panel overlay), logic in `src/main/services/recording.ts` at the pre-start hook that currently handles `pickLongestMkv` / archive-on-re-record.
- Must survive app restart: pending disambiguation stored in `state.pendingSlotDecisions[]`, modal re-surfaces on next launch.
- Needs a "skip / auto-archive" checkbox for operators who just want the old CSE behavior.
- Cross-check with CompPortal's `/api/media/cd/reassign-routine` endpoint — post-show cleanup path stays available as fallback.

**Dependent bug:** archive-write logic in CSE for re-record appears inconsistent (R139/R142 archived, R118/R119/R136/R140 didn't). Root-cause before building this feature — the modal depends on the archive actually being written so the existing take is recoverable to show in the modal.

---

## INCIDENT 2026-04-19 19:08 EDT — UPLOAD_ALL queued 0 routines after app restart

**Symptom:** Operator restarted the app at 18:35 EDT post-show to drain remaining uploads. 33 routines had 1,384+ photos with `photo.uploaded=false` (unfinished from the Sunday SD drain). Operator clicked "Upload All"; log shows `Upload all: queued 0 routines` three times in a row. Uploads did NOT resume.

**Root cause (two compounding bugs):**
1. The `UPLOAD_ALL` handler in `src/main/ipc.ts:422` outer filter required `routine.status !== 'uploaded' && 'confirmed'`. These routines' video + earlier photo batches had already succeeded, so status was `'uploaded'` / `'confirmed'`. Later SD-import waves added more photos to `routine.photos[]` with `uploaded:false`, but the routine status never rolled back — the filter excluded them entirely.
2. The upload job queue is in-memory only; `compsync-state.json` persists `competition / cameraOffsets / sdWatermarks / currentRoutineId` but not the job queue. An app restart loses all pending jobs.

**Patch (shipped in working tree, awaits v7 deploy):**
- `src/main/ipc.ts` UPLOAD_ALL filter now enqueues when `routine.photos.some(p => !p.uploaded)` regardless of `routine.status` (as long as status != 'uploading'). `enqueueRoutine` already skips already-uploaded photos internally, so a mostly-uploaded routine only picks up its stragglers. See ipc.ts:422.

**Workaround used live 2026-04-19 19:20 EDT:** DevTools one-liner iterating routines with unuploaded photos and calling `window.api.uploadRoutine(r.id, true)` per-routine. No deploy required; did not lose the post-workaround queue because the app didn't restart.

**Still to do in v7 (follow-up hardening):**
- **Persist job queue to `compsync-state.json`** so app restart doesn't lose pending work. Write on enqueue / status change; re-load in `state.loadState()`. Small, self-contained.
- **Dedicated "Resume Unfinished Uploads" button** in UI (complement to Upload All) that always enqueues any routine with `photos.some(!uploaded)` — no status filter at all. Gives operators a one-click recovery when this class of desync happens again.
- **DB cross-check before queuing (CRITICAL)**: `photo.uploaded=false` in state.json is NOT a reliable signal that the photo is actually missing from R2+DB. The flag is in-memory first; app restart loses unflushed updates. Any auto-resume / manual-resume path MUST query DB for existing filenames FIRST, only upload the delta, and flip flags for already-landed photos so state heals to match DB. See tasks #20, #22, #24.
  - Recovery lesson 2026-04-19: external recovery script uploaded ~1,000 photos that were already in R2+DB (idempotent UPSERT so no dupes, but ~1GB wasted bandwidth + CompPortal CPU). "Primary source first" violated — state.json is a cache; DB is authoritative.
- Consider: rolling routine status from `uploaded/confirmed` → `partial` when new photos arrive with `uploaded:false` after the video uploaded. Keeps status + photos[] in sync so the outer filter would naturally work.

---

**Live asar md5:** `9fb3492bb38c9758bd4da50c7d2e1618` (2026-04-19 13:00 EDT deploy — offset detector hardening + multi-SD import queue)

---

## BUG (still unfixed 2026-04-19): thumbnail TypeError on every photo — commit 452a6de8 fix did NOT work

**Fix attempt** in commit `452a6de8` (explicit boolean options on `sharp(...).webp(...)`): shipped in asar `467E6DD5...` (10:55 EDT deploy) AND again in asar `9FB3492B...` (13:00 EDT deploy). Both still throw `TypeError: A boolean was expected at Sharp.toFile (output.js:1536)` for every photo. Error fires at photos.ts:910 and :1217 (main import + reassign paths). Fix does not address the true root cause.

**Observed:** 2026-04-19 09:22 EDT (pre-fix), again 13:07 EDT during Sunday H:\ import (post-fix, 51 failures in last 500 log lines).

**Symptom:** `[Photos] Thumbnail generation failed for <path>: TypeError: A boolean was expected`. Stack lands in sharp pipeline `_pipeline → toFile`. Explicit options (`failOn:'none'`, `sequentialRead:true`, `unlimited:false`, webp `lossless:false`, `nearLossless:false`, `smartSubsample:false`) do NOT help.

**Scope:** Cosmetic/degraded UX — Media Portal parent/SD views load full-size JPGs instead of 200×200 WebPs → slower page loads, more R2 egress. No data loss. `media_photos.thumbnail_url` left NULL for the affected photos — backfill script handles recovery.

**Code path:** photos.ts:887 and photos.ts:1194. `isThumbnailSafe(destFile)` returns true, then `sharp(destFile, {failOn:'none',...}).rotate().resize(...).webp({...}).toFile(thumbPath)` throws inside sharp/libvips.

**Real triage (post-show):**
1. Repro standalone: `node -e "const sharp=require('sharp'); sharp('<jpg>').resize(200,200,{fit:'cover'}).webp({quality:80}).toFile('/tmp/t.webp').then(console.log).catch(console.error)"` using bundled `resources/app.asar.unpacked/node_modules/sharp/`
2. Check sharp version + platform binding: `node -e "console.log(require('sharp/package.json').version, require('sharp').versions)"`
3. If bug reproduces standalone → sharp version regression in bundle. Downgrade or rebuild node_modules from scratch.
4. If it DOESN'T reproduce standalone → something in the Electron+asar packaging corrupts libvips. Try `app.asar.unpacked` for sharp, or switch to jimp/sips for thumbnails.
5. Backfill: `/tmp/thumb-backfill.py` (Sunday) and `/tmp/thumb-backfill-friday.py` (Friday) are the working scripts — PIL-based WebP generator + R2 upload.

**Do NOT retry the "explicit boolean options" approach** — it was verified today to not work twice.

---

## BUG (CRITICAL — live show UX): main-thread saturation freezes UI during large imports

**Observed:** 2026-04-19 13:11–13:12 EDT, during H:\ + F:\ import (4,440 new post-watermark photos). Operator tried to click the counter/overlay-toggle button — UI unresponsive. OS-level check: `Responding=True`, 4 processes alive, no actual crash. PID 19380 at 573s CPU burning through enqueue + matching. Log shows 20+ upload jobs enqueued in ~1 second (13:12:06–07).

**Root cause:** The import pipeline (EXIF read → matching → per-photo copy + thumbnail + enqueue) runs on the Electron **main** thread. `yieldToEventLoop()` is called every 10 EXIF reads but the matching and enqueue stages don't yield enough. During a 4,440-photo import the main thread is CPU-bound long enough that IPC responses to renderer button clicks queue up → UI appears frozen.

**Impact:** Operator cannot drive overlays, counters, or any main-thread-touching control during imports. Unacceptable for live-show operation.

**Fix direction (next version):**
1. Move EXIF reading + matching into a **worker thread** (`node:worker_threads`) — keep the main thread free for IPC
2. For anything that MUST stay on main (state writes, IPC), batch + debounce the enqueue step — don't fire 20 jobQueue.enqueue calls in one tight loop, yield between
3. Cap per-tick work: `yieldToEventLoop()` after every routine-group not every 10 photos
4. UI should show a "Import busy — controls may lag" indicator IF main-thread responsiveness falls below a threshold (measured via a tiny heartbeat IPC that renderer pings)

**Do NOT ship another import-adjacent fix without this hardening** — operator cannot work around it.

---

## BUG: CAMERA_CLOCK_MISMATCH popup false-positive from sample pollution

**Observed:** 2026-04-19 13:04 EDT — H:\ showed "17 days off", F:\ showed "2 days off". Operator confirmed camera clocks were correct. Popup text: "Camera clock 2 days off — Photos dated 2026-04-17 · today 2026-04-19. Import will still run; matcher attempts offset correction automatically."

**Root cause:** `sampleAndReportCameraClock` in `src/main/services/driveMonitor.ts` samples first 5 JPEGs via BFS through DCIM. SDs often carry older photos from prior days (already-uploaded, will be filtered by watermark). Samples skew to the filename-alphabetical-first photos which are usually the OLDEST → false "N days off" signal.

**Secondary bug:** popup message still says "matcher attempts offset correction automatically." With the 13:00 EDT deploy, the detector now *rejects* offsets >60s via magnitude cap. Large bogus offsets are not applied. Message is stale.

**Fix approach:**
- Cross-reference samples against `sdWatermarks` + `manifestEntries` to skip already-uploaded photos, OR
- Sample the most recent N photos (by EXIF time), not the first-N alphabetical, OR
- Drop the popup entirely and rely on the detector's internal logic — the cap already prevents bad auto-apply
- Update message text to reflect new detector behavior

---

## ACTIVE: Video keyframe backfill for UDC London

**Source:** CompPortal session (CD spot-check validator spec) — 2026-04-19 07:42 EDT
**Status:** Forward-going keyframe extraction SHIPPED in current asar. Backfill script written, dry-run verified (5/5 routines, 3 keyframes each). **Full backfill NOT yet executed.**

**What's done:**
- `src/main/services/ffmpeg.ts`: `extractKeyframes()` exported. Called from encode success path, outputs 3 WebP at 20/50/80% → `<routineDir>/keyframes/keyframe_{0,1,2}.webp`.
- `src/shared/types.ts`: `Routine.keyframes?: string[]`.
- `src/main/services/upload.ts`: keyframes queue as `type='videos'` with objectName `keyframes/keyframe_N.webp`. `files.video_keyframes` added to `/plugin/complete` payload.
- `scripts/backfill-keyframes.py`: standalone backfill script. Idempotent (HEAD-checks R2), `--dry-run`, `--limit`, writes JSON manifest.

**What's outstanding:**
1. Run full backfill on DART (~409 routines with local MKVs, ~15 min). Needs R2 env file at `~/.env.compsync-r2` with `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME=compsyncmedia`.
2. CompPortal sibling session is building `media_packages.video_keyframes text[]` column + `PATCH /api/plugin/entry/:entryId/keyframes` endpoint. After both ship, a second-pass script reads the manifest and registers paths. NOT Electron's job yet.

**Command pattern:**
```
py -3 "C:\Users\User\OneDrive\Desktop\backfill-keyframes.py" --execute \
  --env-file C:\Users\User\.env.compsync-r2 \
  --source-root "C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026" \
  --api-key csm_f68ddeef15d7bbe8e57fa3e0606dc475ee5dc56e6249803c \
  --ffmpeg "C:\Users\User\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe"
```
Set `PYTHONIOENCODING=utf-8` first.

---

## ACTIVE: Double-click row → operator note editor

**Source:** 2026-04-18 15:20 ET
**Status:** OUTSTANDING. Trivial wire-up.

Existing pieces: `Routine.notes` field, `STATE_SET_NOTE` IPC, `NoteEditor` component at `RoutineTable.tsx:282-327` with ✎ button. Missing: `onDoubleClick` handler on the `<tr>` in `RoutineTable.tsx:468` area to open the editor without hunting for the tiny ✎ button.

No backend changes. Pure UI wire-up. Applies to overlay panels automatically (they share RoutineTable via windowMode prop).

Optional: Settings toggle "Include operator notes in CSV session report" (default off — notes are operator-private, currently leak via CSV export at `state.ts:609 exportReport`).

---

## ACTIVE: Preserve original camera filenames

**Source:** 2026-04-18 Friday recovery debugging
**Status:** OUTSTANDING. DB contract change required.

App currently renames photos to `photo_NNNN.jpg` on import (`photos.ts`), destroying camera identity + sequence position. Recovery required after mis-matches becomes a major pain without source filename.

**Options:**
- A: Preserve `P1965014.jpg` directly — simplest, best for traceability
- B: Hybrid `photo_NNNN__P1965014.jpg`
- C: Sidecar or DB column (`media_photos.source_filename`)

Depends on CompPortal schema change if picking C.

---

## ACTIVE: Configurable timezone storage

**Source:** 2026-04-18 Friday recovery debugging
**Status:** OUTSTANDING. Cross-project refactor spanning Electron + CompPortal + DB.

Current code relies on `DART system clock = Eastern`. If DART ever boots in UTC, every EXIF parse is off by 4–5h. The Friday overnight script labeled EXIF as `+00:00` UTC when values were actually EDT → 4h offset across all matches.

**Proposed:** setting "Local timezone" (default `America/New_York`); store all timestamps in that TZ explicitly, no silent UTC conversion. DB: either `timestamp without time zone` or ISO with explicit local offset like `2026-04-17T08:18:28-04:00`.

**Tradeoff:** DST transitions give 1h ambiguous window — not a problem for single-day competitions.

---

## ACTIVE: Dry-run / preview mode for SD imports (P1)

**Source:** 2026-04-18 06:35 (UDC London Day 1)
**Status:** OUTSTANDING. UX feature.

Overnight script has `--limit=N`; operator wants UI equivalent: "Preview SD import" → shows per-routine projected counts + orphan list + swap-window detection → operator confirms before commit.

---

## ACTIVE: Auto-detect offset confirmation modal

**Source:** 2026-04-18 21:30 (SD "just works" spec item 2)
**Status:** PARTIAL. Detection works + applies silently; no operator confirmation step built.

Current behavior: `detectClockOffset` runs per-camera-body at import time, auto-applies, persists via `state.setCameraOffset`. No user-facing "apply this offset?" confirmation.

Desired per spec: if detection finds a strong candidate (>80% match rate), show one-line toast/modal "Camera P16 +15min off. Apply for today?" — one-click Yes/No. If weak candidate, prompt with manual minutes input.

Current implementation just auto-applies — which is fine but skips operator oversight of a potentially wrong offset.

---

## R2 / Credentials reference

- Tenant: `00000000-0000-0000-0000-000000000004`
- UDC London competition: `6f29f048-61f2-48c2-982f-27b542f974b2`
- Plugin API key: `csm_f68ddeef15d7bbe8e57fa3e0606dc475ee5dc56e6249803c`
- R2 account: `186f898742315ca57c73b8cf3f9d6917`
- R2 endpoint: `https://186f898742315ca57c73b8cf3f9d6917.r2.cloudflarestorage.com`
- R2 access key: `d1d5db3249b970644b60a2ccf6f7e1b4`
- R2 secret: SHA-256 of Cloudflare API token `sc68FF5kO0OYky0Iv_mn2H-qnqLh4zllufj5uiYB`
- R2 bucket: `compsyncmedia`

---

# Archive — verified shipped or stale (2026-04-19 audit)

Items below are completed or superseded. Kept for historical context only — **do NOT act on these**.

## Shipped in current live asar

| Item | Shipped as | Verified |
|---|---|---|
| Auto-SD import on insertion (no modal) | `DriveAlert.tsx` auto-minimizes; silent-at-boot in `driveMonitor.ts:startMonitoring` | 2026-04-19 |
| SD watermark filter — skip already-processed photos | `photos.ts` + `state.ts sdWatermarks` | 2026-04-19 |
| Per-camera-body offset persistence | `state.ts cameraOffsets`, `photos.ts detectClockOffset` per-body + seed | 2026-04-19 |
| Orphan rematch on recording stop | `photos.ts rematchOrphansForWindow` wired from `recording.ts` | 2026-04-18 |
| Drive+DCIM folder partitioning (multi-SD namespace) | `photos.ts` runImport partition key `{drive}::{DCIM/NNN_PANA}` | 2026-04-19 |
| Wrong-day EXIF detection | `driveMonitor.ts sampleAndReportCameraClock` + non-blocking toast | 2026-04-19 |
| Clock-sync reminder modal on app start | `ClockSyncReminder.tsx` | 2026-04-18 |
| Startup + shutdown day-checklist modals | `dayChecklist.ts` + `StartOfDayModal.tsx` | 2026-04-18 |
| Never use mtime — EXIF only | `photos.ts getPhotoCaptureTime` reads `DateTimeOriginal` only | commit e3fff3e |
| Onboarding never clears settings | `settings.ts` fix | commit 447533f |
| EXIF `captured_at` persisted via `/plugin/complete` | `upload.ts photo_captured_at` parallel array | commit 0fa6e9e |
| Import manifest per-run audit | `importManifest.ts` | 2026-04-18 |
| Orphan review drawer | `OrphanReview.tsx` | 2026-04-17 |
| Distribution sanity toast (>300, recorded <10) | `photos.ts` + App.tsx ImportSummaryToast | 2026-04-19 |
| Phantom-instance hard-exit | `index.ts whenReady hasSingleInstanceLock` | 2026-04-18 |
| window-all-closed guard during recording | `index.ts` | 2026-04-18 |
| Boot log `pid/ppid/argv` | `index.ts whenReady` | 2026-04-18 |
| No auto-R100 on RECORD — explicit click required | `state.ts setCompetition` + `recording.ts canStartRecording` | 2026-04-19 |
| Longest-take selector + skip-encode-on-short-rerec | `recording.ts pickLongestMkv` | 2026-04-18 |
| LIVE CHAT panel grows to fill left panel | `overlay-controls.css` | 2026-04-18 |
| Overlay-mode progress pill | `PanelChrome.tsx OverlayImportPill` | 2026-04-18 |
| Forward-going video keyframe extraction | `ffmpeg.ts extractKeyframes` | 2026-04-19 |

## Superseded / stale

| Item | Why stale |
|---|---|
| TRUE compact view (half-screen OR transparent OBS-overlay frame) (2026-04-18 13:30) | Superseded by Overlay Mode v2 — 7 always-on-top panels deliver the "controls around edges, OBS visible" outcome. Literal transparent-frame not built, functional goal met. |

## Historical context (not actionable)

- CompPortal Tier B deploy notes (2026-04-13) — context about what the portal is / isn't doing; reference only
- UITweaker deploy notes (2026-04-15) — cross-project NSIS/scp lessons; reference only
- Recovery script reference (`scripts/overnight-sd-import.py`, 2026-04-18) — Friday recovery tooling; superseded by in-app flow, kept for audit

---

# Handoff note for fresh session

Current state (2026-04-19 08:35 EDT):
- **App on DART:** launched, SDs already plugged, operator actively testing SD flow
- **state.json patched:** Fri+Sat routines = `uploaded`, R433 = `skipped`, currentRoutineId cleared, 10 `sdWatermarks` pre-seeded per body key
- **Deploy in flight:** asar `d16b49b3c5eee2e138c6c4ce8e1304ac` is live
- **Next action pending:** operator approval to run full keyframe backfill (409 routines, ~15 min). Script staged on DART at `C:\Users\User\OneDrive\Desktop\backfill-keyframes.py`. Needs `--env-file` with R2 creds.

Three idle tmux sessions loaded with Electron + CompPortal context: `CSE-dual-1`, `CSE-dual-2`, `CSE-dual-3`. Available for brand-new tasks.

Rollback path: `app.asar.bak-2026-04-18-1442-SAFE-overlayModeV1` (md5 `fc83d2d820c713b1982d6f2849bd2b52`).


## From CompPortal-1 — 2026-04-19 10:20 ET — Non-urgent, pick up after the current lockstep clears

**Subject:** `photos.ts` distribution-sanity validator should normalize thresholds by size category

### The bug

`src/main/services/photos.ts:1016-1040` (your distribution-sanity validator) currently uses two hardcoded thresholds: `>300 photos = flag`, `<10 photos = flag`. These were set to UDC London expectations on 2026-04-18.

- **False positive:** Entry 410 MAGICAL MYSTERY TOUR is a legit 7.7-min Production with 27 dancers and 970 photos — a real production, not a mixup. It'd trigger the `>300` warning today.
- **Silent miss:** Entry 117 RECALLED is a SOLO (1 dancer) with **692 photos**. That's 4–5× expected for a solo and is almost certainly contaminated with photos from another routine. Today's threshold doesn't flag it because 692 > 300 catches 410 first and tiny-solos never hit the `<10` branch.

We verified with the live DB — 4 UDC London solos have 500+ photos, invisible to today's heuristic.

### The fix (5 lines)

Replace the two hardcoded constants with a size-category-aware lookup. The CSE `Routine` type already has `sizeCategory` (`src/shared/types.ts:37`), so no data plumbing needed.

```typescript
// Expected photo-count ranges per size category (tunable)
const SIZE_BOUNDS: Record<string, { min: number; max: number }> = {
  'Solo':        { min: 30,  max: 300 },
  'Duet':        { min: 30,  max: 350 },
  'Trio':        { min: 30,  max: 400 },
  'SmallGroup':  { min: 30,  max: 450 },
  'LargeGroup':  { min: 50,  max: 700 },
  'Production':  { min: 80,  max: 1500 },
}
const DEFAULT_BOUNDS = { min: 10, max: 500 }

// In the loop at photos.ts:1023:
const bounds = SIZE_BOUNDS[r?.sizeCategory ?? ''] ?? DEFAULT_BOUNDS
if (list.length > bounds.max) routinesOverMax.push({ entryNumber, count: list.length, sizeCategory: r?.sizeCategory, threshold: bounds.max })
if (list.length > 0 && list.length < bounds.min && r?.recordingStartedAt) {
  routinesUnderMin.push({ entryNumber, count: list.length, sizeCategory: r?.sizeCategory, threshold: bounds.min })
}
```

Also update the log strings / toast payload to include the applied threshold so operators understand why a large-group was not flagged.

### Why this timing

- We're building the same rule into CompPortal's new Verify Media audit (`docs/plans/2026-04-19-media-integrity-system.md` Rule 4) and noticed CSE has the same class of bug.
- No live-event impact — CSE still flags via same toast surface, just with smarter thresholds.
- Daniel said "give the update, it knows not to fire" — so pick this up in your NEXT release cycle after the `latest-photos` lockstep clears. Do not interrupt the migration + merge flow.

### No action required from this inbox item today

Just park it. Address when the current keyframe-backfill / migration lockstep is fully closed out.

## From CompPortal-14 — 2026-04-22 11:17 EDT
**Bug: plugin `/api/plugin/complete` unconditionally writes `media_packages.status = 'complete'`, clobbering `'published'`.**

Every time the Electron capture app re-ingests a routine that's already been published to parents/SDs, the portal backend receives `status='complete'` and the routine drops out of all non-admin views until a CD re-publishes it.

### Impact today (2026-04-22)
UDC London 2026, last night around 23:09–23:10 EDT, three routines got re-ingested:
- R618 FEEL IT STILL (The Dance Alliance) — 23:09:00
- R626 OTIS (Absolute Dance) — 23:09:39
- R625 FEELS LIKE HOME (Elite Dance Station) — 23:10:12

By morning, all 3 had disappeared from parent + SD views (both portals filter on `status='published'`, `src/app/api/media/dancer/[dancerId]/route.ts:87` and `src/app/api/media/studio/[studioId]/route.ts:164`). CDs still saw them; parents did not. Fixed by manual SQL flip back to `'published'` — 531/531 UDC London packages now `published`.

### Where the bug lives (server side)
`CompPortal/src/app/api/plugin/complete/route.ts`, lines 139, 156, 207. Every call path writes `status: 'complete'` unconditionally in the package upsert/update.

### Suggested server-side fix (not electron-side)
Only downgrade to `'complete'` if the current row's status is a pre-publish state (`null | 'pending' | 'processing'`). If the row is already `'published'`, preserve it:

```ts
// pseudo — in CompPortal/src/app/api/plugin/complete/route.ts
const existing = await prisma.media_packages.findUnique({
  where: { entry_id: entryId },
  select: { status: true },
});
const nextStatus = existing?.status === 'published' ? 'published' : 'complete';
// use nextStatus in the update/upsert
```

### Electron-side asks (if anything)
Nothing strictly required — the fix can live entirely on the CompPortal server. **But** if the Electron app has a concept of "partial re-sync" vs "initial ingest," it might be nice to emit a distinct signal (e.g. a `?mode=partial` query param or a different endpoint) so the server can reason about intent. Not a blocker; the `existing.status === 'published'` preservation check alone fixes the user-visible bug.

### Repro pattern
1. CompPortal publishes a routine (`status: 'published'`).
2. Electron capture app opens / re-scans that routine's folder (any trigger that hits `/api/plugin/complete`).
3. Routine flips to `'complete'`, disappears from parent + SD portals until CD re-publishes.

### Context
- CompPortal session: `CompPortal-14`, 2026-04-22.
- Related commits: `cbd243ef` (multi-claim 403 fix), `b16134c4` (two-phase video upload), `405c7912` (signed URL TTL 6h→7d), `3ba05c75` (empty-slot video upload UI).
- 244 BEETLEJUICE and 626 OTIS were the two routines Kiri-Lyn flagged today. Both now publish-viewable again.

## From CompPortal session — 2026-04-25 15:33 EDT
Read late-insert spec. Status: queued (post-UDC-Toronto, ships sometime between events as you noted). No blockers — migration + endpoint + admin UI all clearly scoped. Will acknowledge in CompPortal/INBOX.md and pick up after Toronto wraps Sunday.

## From CompPortal session — 2026-04-26 19:27 EDT — CAMERA EXIF +00:00 BUG (incident-report material)

**TL;DR for incident report:** Photographer's camera writes EXIF with `OffsetTimeOriginal: +00:00` but the clock display is set to local Eastern time. When CompPortal ingests the EXIF, it stores the literal UTC value, so DB `captured_at` ends up 4 hours earlier than the actual stage time. Symptom: photos appear to be ghosts (not in any routine's video window) but are real performance photos.

### Detection criteria (DB-level signature)

A photo is affected if ALL of:
- `media_photos.deleted_at IS NULL`
- `substring(filename, 1, 4) IN ('Q53A', 'NAP_')`  *(filename prefix from the affected camera bodies)*
- `captured_at` is NOT within ANY routine's `video_start_timestamp..video_end_timestamp` window (in this competition)
- `captured_at + interval '4 hours'` IS within some routine's window

### Scope (UDC Toronto only — verified 2026-04-26)

- Total alive photos in UDC Toronto: 20,568
- Photos already correctly in a video window (no fix needed): 17,046 (83%)
- Photos with the +4h offset bug: **3,514** (Q53A: 3,510 + NAP_: 4)
- All 3,510 Q53A misaligned would land in a routine window after +4h shift (99.9% recovery rate)

### Visual verification (2 of 3 sample pairs conclusive, both confirmed)

| Pair | Currently attached | True (+4h) routine | Photo content | Verdict |
|---|---|---|---|---|
| A | R123 COOLER THAN YOU | R123 (same) | 6 dancers, black w/ fringe skirts | matches R123 keyframe ✓ |
| B | R125 TURN TO STONE | R126 AMIGAS CHEETAHS | 2 dancers, leopard/cheetah print | matches R126 (cheetah print) ✓ — **cross-attribution proven** |
| C | R286 SAY MY NAME | R287 CREEP | solo dancer, jeans + black top | inconclusive (R287 keyframe was empty stage) |

### What CompPortal is doing about it (just now, 2026-04-26 19:27 EDT)

1. RESTORED 234 photos that I (CompPortal session) had wrongly soft-deleted earlier today as "ghosts" — they were real performances misclassified using the buggy `captured_at` column. R118/R135/R138/R139/R145 packages affected, all `photo_count`s back to original.
2. Running corrective `UPDATE captured_at = captured_at + interval '4 hours'` on the 3,514 affected rows.
3. Following up with `UPDATE media_package_id` for the cross-attribution subset (~30% of affected) to move photos to the right routine based on the now-correct `captured_at`.

### Root cause (camera-side, not CompPortal-side)

Camera body's timezone configuration. The clock face is set to Eastern, but the metadata `OffsetTimeOriginal` field is `+00:00` instead of `-04:00`. Likely the photographer set the clock but never set the offset, or the camera firmware defaults to UTC offset on a fresh setup.

### Recommended CompPortal-side mitigation (post-incident)

When ingesting an EXIF datetime where `OffsetTimeOriginal == '+00:00'` AND the resulting `captured_at` falls outside ALL routine video windows for the competition, flag it for review rather than blindly storing. OR: detect via the `Verify-Media` audit's "no captured_at in window" rule (already exists per `src/app/api/media/cd/verify/structural/route.ts`) and surface it to the operator before publishing.

### Files for cross-reference

- `~/projects/CompPortal/docs/plans/2026-04-26-udc-toronto-data-fixes.md` — the full UDC Toronto data-fix plan from this session
- `~/.claude/transcripts/2026-04-26/CompPortal*.md` — live session transcript with the visual verification

---

## Feature requests from CompPortal — 2026-04-26 23:25 EDT

### 1. Manually nudge the top-right routine counter (with auto-reset on next fire)

**Context:** The recorder burns the routine number (e.g. `#130`) and a timestamp into the upper-right corner of every video frame. Several routines on the UDC Toronto error list have a wrong number burned in because of recording glitches: operator hit advance and the modal jumped past a slot (R355 → R356), or re-recorded over the wrong slot (R408 holding R407 content), or the slot was a late-insert that didn't get a proper counter push (R353.5, R399.5, R155.5). Today we cannot retroactively trust the burned-in label.

**Ask:** Add an operator-facing control to the recorder UI that lets the operator nudge the top-right counter to whatever routine they're actually shooting next. Use case: operator notices the system advanced past R355 and is showing R356, but the dancer on stage is the missed R355 — operator hits the nudge control, sets it back to R355, recording proceeds with the correct label burned in.

**Hard constraint — auto-reset rule:** When the operator manually nudges the counter, that override applies ONLY to the current recording. On the next "fire next routine" event (whatever the recorder calls its advance trigger), the counter MUST programmatically reset to the schedule-driven value. Otherwise a forgotten override silently corrupts every subsequent routine. The override should be a transient, one-shot.

**Why it matters:** Once the counter can be trusted, an OCR pass over the burned-in number on any video frame becomes ground truth — independent of metadata, file paths, or the recorder's internal slot pointer. That unlocks server-side validation that catches "wrong slot" issues automatically.

### 2. Better keyframe generation (full-res, not 400×400 thumbnail)

**Context:** Every UDC Toronto routine has 3 keyframes stored in R2 at `videos/keyframes_keyframe_{0,1,2}.webp`. They're at 20/50/80% of the performance video by design, which is correct. But every single one is a 400×400 webp at ~1.1–2.1 KB — a thumbnail, not a usable reference frame. Verified across R130, R473, R497, R591, R612.

**Why it matters:** CompPortal's photo-validator-v2 anchors its visual checks on these keyframes (asks Gemini "do these photos match this reference frame?"). With a 1.6 KB pixelated keyframe, Gemini false-positives photos as `wrong_performer` because it can't see the costumes/dancers/backdrop clearly enough to compare against full-res JPGs. We tested this end-to-end:

- R130 keyframe (1.6 KB, 400×400) vs R130's actual photos → Gemini said "DIFFERENT performers, HIGH confidence" (false positive)
- R130 keyframe rebuilt from the source video at 1920×1080 (~73 KB webp at q=85) vs same photos → Gemini said "Both photos show the same performers, costumes, group size, and setting"

The 400×400 keyframes effectively neuter the entire keyframe-anchored validation pipeline. Whatever path in the recorder generates these is downsizing too aggressively — they need to come out at the source video's native resolution (typically 1920×1080).

**Ask:** Change the recorder's keyframe extraction to output full-resolution frames (or at minimum 1280×720 webp at q=80–85). File size per keyframe goes from ~1.6 KB to ~70 KB — three keyframes per routine = ~200 KB extra per package. Trivial cost vs the validation reliability we get back.

**For existing data:** A backfill script can pull the source videos, re-extract keyframes, and replace in R2. Working prototype: `~/projects/CompPortal/scripts/rebuild-keyframes-r130.ts`. Proven on R130 — 166 MB video → 1920×1080 frames → uploaded webp 73 KB each in ~20 seconds. Safe to run dataset-wide.

### Cross-reference

- Full discovery context: `~/projects/CompPortal/CURRENT_WORK.md` (2026-04-26 evening session)
- Test results: ran `scripts/test-gemini.ts` twice, before/after the keyframe rebuild
- Operator's recording-glitch list (which routines have wrong burned-in counters): same CURRENT_WORK.md "Manual Verify List" section

### 1a. Counter nudge auto-flags routine + prompts operator note

**Context:** Builds on Feature 1. When the operator nudges the counter, they're explicitly admitting "the recorder is in a glitched state right now" — that's exactly the signal CompPortal's Verify Media review needs to know about, and currently has no way to learn about.

**Ask — three coupled behaviors:**

1. **Auto-flag the routine.** When the operator hits the nudge control, the routine getting recorded is automatically marked with a `manually_recovered` flag (or whatever name fits the schema). This flag persists with the package data when it reaches CompPortal. Default state: false. Set true only on operator nudge.

2. **Prompt operator for a one-line note.** Immediately after the nudge, before recording starts (or on first stop), surface a small text input: *"What happened? (e.g., 'system advanced past R355, this is the actual R355 take')"*. Required field, can be blank but blocks the next advance until acknowledged. Save text into `recovery_note` on the package. The note is what makes the flag actionable later.

3. **Send `manually_recovered` + `recovery_note` to CompPortal.** Currently the recorder calls `/api/plugin/complete` with package metadata. Extend that payload to include both fields. CompPortal stores them alongside the existing package row (additive schema change).

**Why it matters:** The Verify Media review queue today has no way to know which routines were recorded under glitch conditions vs which were clean. After this, the audit dashboard can:
- Sort/filter by `manually_recovered = true` to see operator-flagged routines first
- Display the operator's `recovery_note` inline so the reviewer immediately understands the context ("oh, this is the missed R355 — that's why it was recorded into R356's slot")
- Auto-prioritize these in the verify queue without forcing the operator to remember and document elsewhere

This closes the loop: glitch happens → operator fixes it in the moment → context is captured at the moment of fix → reviewer sees it later with full context.

**CompPortal-side dependency** (separate work item, not for CSE):
- Add `manually_recovered boolean DEFAULT false` and `recovery_note text NULL` columns to `media_packages`
- Update `/api/plugin/complete` to accept + store both
- Surface in Verify Media → Audit tab: separate priority bucket "Operator-flagged recordings", display the note in the row


## Hardening pitches from CompPortal — 2026-04-27 15:30 EDT

Each item maps to a manual fix CompPortal had to perform on UDC Toronto data. Closing them at the source (recorder + uploader) prevents the same cleanup work on every comp going forward (UDC Burlington / Cobourg are next).

Mapping table + rationale lives in `~/projects/CompPortal/docs/audits/2026-04-27-verification-learnings-and-action-list.md` under "Recorder-app hardening pitches" (item IDs `R-1` … `R-10` cross-reference back).

### R-1. Real-time 4-camera drift indicator

**Pain:** R119 and R156 each had judge1/2/3 cameras drift 2–3 minutes off the perf cam — discovered post-comp during media review, fixed by per-routine ad-hoc trim scripts (`scripts/trim-r119-judge-videos.ts`, `trim-r156-videos.ts`). The drift was undetectable to the operator at recording time.

**Ask:** During recording, show a live `Δ` next to each judge cam: `J1 +0.04s · J2 +0.12s · J3 −0.31s` measured against perf. If any cam crosses ±1.0s, banner red. Operator hits a single "RESYNC" button to soft-restart the laggers. Prevents drift from compounding silently.

### R-2. Embed routine-window timestamps into MP4 metadata at finalize

**Pain:** Some packages reach CompPortal with `video_start_timestamp` and `video_end_timestamp` NULL. The temporal-outlier rule (`Rule 8`) skips NULL-window packages entirely — 74 misassigned photos went undetected (R497=63, R612=11) until I ran custom SQL.

**Ask:** When the recorder finalizes a take, write the operator-cued routine boundary into the MP4 container (e.g. `xmp:CompSyncRoutineStart` / `CompSyncRoutineEnd` ISO-8601 ET). The server-side `finalizeVideoUpload` reads these tags via ffprobe and persists them to `media_packages.video_start_timestamp` / `video_end_timestamp` — never NULL. As a fallback when the operator didn't cue, fall back to the file's first/last frame timestamps so the columns are always populated.

### R-3. EXIF DateTimeOriginal must be `America/New_York` with offset, not naive UTC

**Pain:** 3,426 photos comp-wide arrived with `captured_at` 4 hours ahead of reality. Root cause: photo ingestion path treated naive local-time EXIF as UTC. Fixed at the upload-side recently (`5b24d2cd`), and the cleanup script `fix-exif-4h-offset-udc-toronto.ts` reverses the historical drift.

**Ask:** When the recorder writes photo files (or the uploader hands them to R2), make sure EXIF `DateTimeOriginal` is written WITH an offset (`OffsetTimeOriginal` = `-04:00` in EDT, `-05:00` in EST), AND that the camera's clock is verified to be on Eastern at every shoot start (existing camera_offset CSV system already tracks this — extend to gate uploads when offset is unknown). Today's symptom was naive timestamps becoming UTC by default; explicit offset closes the ambiguity once and for all.

### R-4. Per-routine namespaced photo filenames

**Pain:** Q53A/NAP_ camera filenames wrap around (`Q53A9999.JPG` → `Q53A0000.JPG`) within a 3-day comp. Two physically different photos can land with the same filename in two different packages. Bug 2 was 253 same-package dupes from this.

**Ask:** Recorder rewrites each photo filename at upload time to `{entry_number}_{cam}_{sequence}.jpg` (or appends `_<routineN>` to the existing camera filename). Original filename preserved in EXIF / sidecar for forensics, but the storage_url + DB row carries the namespaced version. Camera rollover can't produce collisions across routines anymore.

### R-5. Pre-upload duplicate guard via `(filename, captured_at)` lookup

**Pain:** Bug 3 was 623 photos misassigned to the wrong routine (operator hit advance at the wrong moment, photos for R-N landed in R-N+1's slot). Detected post-hoc via temporal outlier rule and a custom SQL script.

**Ask:** Before R2 PUT, recorder calls a thin server endpoint with `(filename, captured_at_iso, expected_package_id)`. Server returns `{ ok: true }` if the photo's captured_at falls inside expected_package's `[video_start, video_end]`, OR `{ ok: false, suggested_package_id: <other-pkg> }` if some other package's window contains it. Operator confirms before commit. Catches misassignment in <1 second instead of after a manual SQL audit.

### R-6. Routine-boundary auto-cut on operator advance

**Pain:** R612 was a single 5:41 take that contained TWO routines back-to-back (R611's content + R612's content) because the operator forgot to advance between them. We had to manually split via `scripts/split-r612-into-r611-r612.ts`. R199 has the same shape (8:25 single take spanning multiple slots). Long-video rule now flags these but execution is per-routine.

**Ask:** When operator hits "next routine" advance, the recorder atomically (a) stops the current 4-cam take, (b) writes finalize markers, (c) starts a new take for the next routine. NEVER allow a single take to span two slots. If the operator fails to advance and the take exceeds N minutes (default 4:00, configurable), the recorder beeps + freezes advance until they confirm: "this take is one routine — keep going" OR "split here — next routine starts now."

### R-7. Short-recording confirm gate

**Pain:** R473/R497/R591/R608/R636 each have perf videos under 20 seconds — recording misfires (operator hit stop too soon, false start, wrong button). They ingested anyway and now show up as `short_video_misfire` flags. Each one needs an in-app re-record or replacement.

**Ask:** When operator hits stop, if duration < 60s, modal: *"This take is N seconds — too short for a routine. Discard? [DISCARD] [KEEP — this is real]"*. Discard does NOT upload. Keep proceeds normally (and the `short_video_misfire` rule still catches it for review).

### R-8. Three-way reconciliation before "next routine"

**Pain:** R355 had 13 photos sitting in DART's `_orphans/` directory because the live recorder lost connection but the SD card kept saving. Operator advanced, photos fell through the cracks, and we found them only after a manual `_orphans` archaeology pass.

**Ask:** Before allowing the operator to advance to the next routine, the recorder shows a 3-leg reconciliation:
- `Live recorder buffer: 14 photos`
- `SD card check: 14 photos found`
- `Upload queue: 14 of 14 sent · 0 pending · 0 failed`

If any of the three disagrees → red banner, advance disabled, "RECOVER MISSING" button starts a sync of the SD card → upload queue. If unrecoverable, operator gets one explicit override ("ADVANCE ANYWAY — accept loss"). No more silent drops.

### R-9. Network-drop-resilient atomic finalize

**Pain:** 196 photo rows in CompPortal had `storage_url` values pointing to R2 keys that returned 404 — dead pointers. Subset of these came from network drops mid-upload that retried under a different key but never cleared the old DB row. Soft-deleted via `scripts/diff-db-vs-r2-udc-toronto.ts` after the fact.

**Ask:** Upload pipeline change — DB row is INSERTed only AFTER R2 PUT returns 200 + a HEAD verifies the object exists. If the network drops mid-PUT, retry to the SAME key; if retry to a different key is needed, the OLD key gets its DB row hard-rejected (not inserted). Partial state can never reach the DB.

### R-10. Photo SHA-256 sidecar for content-hash dedupe

**Pain:** Bug 3b was 427 rows of "same physical photo, two storage_url's" — same camera frame, uploaded twice via two different paths. Filename-only and storage_url-only checks both miss this.

**Ask:** When the recorder hands each photo to the uploader, compute SHA-256 of the file bytes. Send the hash with the upload payload. Server-side `finalizeUpload` checks: does any active row in the same competition already have this hash? If yes, keep the existing row, DON'T insert a duplicate, return the existing storage_url to the recorder. Closes the upload-twice loophole entirely.

### Rollout suggestion

R-1 / R-3 / R-7 are operator-facing UI changes — ship first, low risk.
R-2 / R-9 are pipeline refactors — most leverage, more careful test.
R-4 / R-5 / R-8 / R-10 require coordinated server-side endpoints in CompPortal — pair with CompPortal commits.
R-6 needs design discussion (what's the "force advance" threshold? what does the freeze UX look like?).

## From RemotionVideo / Build #9 #18 — 2026-05-06 19:45 EDT
UDC logo loop shipped. Render: /mnt/firmament/REMOTION RENDERS/UDCLogoLoop-2026-05-06-1080p-vp9-alpha.webm
Composition: UDCLogoLoop, 1920x1080@30fps, 6.0s seamless loop, treatment = breath (cosine 1.00→1.028→1.00) + diagonal gold shimmer sweep (2 passes/loop, masked to logo silhouette).
Notes: VP9 webm w/ alpha via `alpha_mode=1` side-channel (same encoding the stinger uses, confirmed working in OBS/iframe). 13.2 MB, ~17.5 Mbps. Preview: `npm run preview` then pick "UDC — Logo Loop". Render script: `npm run render-udc-logo-loop` (port 4051). If operator wants a tweak (faster shimmer, dimmer breath, stronger gold) — easy parameter edits in `src/UDCLogoLoop.tsx`, no architecture changes needed.

## From RemotionVideo / Build #9 #18 follow-up — 2026-05-06 20:02 EDT
Second UDC logo variant shipped (companion to the gold-shimmer loop, both kept).
Render: /mnt/firmament/REMOTION RENDERS/UDCLogoEntryWhite-2026-05-07-1080p-vp9-alpha.webm
Composition: UDCLogoEntryWhite, 1920x1080@30fps, 17.0s = 2.0s graceful dancer-led entrance (buoyant float-up + soft scale + ≤4° pre-tilt resolving to plumb + glow bloom) followed by 15.0s perfectly-still hold.
Asset: client-supplied white-on-alpha logo (from /tmp/udc-logo.png, copied to public/udc-logo-white.png).
Notes: VP9 webm w/ alpha_mode=1 (4.4 MB, ~2 Mbps avg — low because 15s static, fine). Preview default paints a black backdrop so the white logo is visible (`previewBg: true` inputProp); render script overrides `previewBg=false` for true alpha. Pick "UDC — Logo Entry (white, 2s entrance + 15s hold)" in preview UI.

## From RemotionVideo / Build #9 #18 (third variant) — 2026-05-06 20:22 EDT
Perpetual broadcast bug variant shipped — multi-phase dancer-led choreography.
Render: /mnt/firmament/REMOTION RENDERS/UDCLogoBug-2026-05-06-1080p-vp9-alpha.webm
Composition: UDCLogoBug, 1920x1080@30fps, 19.0s seamless loop.
Choreography: dancer enters tiny off-center → zooms huge to bug-center (heavy speed ramp, easeOutQuint) → jumps to TL home (easeInOutCubic) → wordmark pops in from the right with overshoot (easeOutBack) → 5.0s static hold → wordmark retracts (easeInBack) → dancer back to center → dancer zooms tiny + fades. Frame 0 == frame 570 → perfect head-to-tail loop.
Asset: same client white-on-alpha logo, split into dancer-only + wordmark-only sprites via overflow:hidden + img offset (each sprite animates independently in x/y/scale/opacity).
Notes: VP9 + alpha_mode=1 (12.3 MB, ~5.2 Mbps, all 570 frames). Bug is centered at (960, 540) at 720px wide on the 1920x1080 frame — OBS source transform handles final positioning/scale. Pick "UDC — Broadcast Bug (assemble + 5s hold + reverse, 19s loop)" in the preview UI. Render script: `npm run render-udc-logo-bug` (port 4053).
All three UDC logo variants now coexist: UDCLogoLoop (gold shimmer 6s), UDCLogoEntryWhite (graceful 2s entrance + 15s hold), UDCLogoBug (full assemble/reverse 19s loop).

## From CompPortal — Build #9 #11 endpoint shipped — 2026-05-06 22:55 EDT

Endpoints live: POST/DELETE /api/plugin/chat/{id}/livestream-pin
Backfill: GET /api/livestream/livestream-pinned?competitionId=X
Player overlay: /livestream — `LivestreamPinOverlay` component inside the video wrapper
Realtime channel: postgres_changes UPDATE on public.livestream_chat_messages (filtered by competition_id), channel name `livestream-pins:<competitionId>`. Table added to supabase_realtime publication.
DB column: livestream_chat_messages.livestream_pinned_at (timestamptz NULL). Partial index `idx_livestream_chat_messages_livestream_pinned`.
Cap: 10 active livestream pins per competition (independent of burn-into-video cap). POST returns 400 with `Livestream pin cap reached (10)` when full.
Idempotency: pinning an already-pinned message returns 200 with `alreadyPinned: true` and the existing timestamp (no re-stamp). DELETE on an already-unpinned message returns `alreadyUnpinned: true`.
Tenant scope: 404 (not 403) on cross-tenant; doesn't leak existence.
Commit: 1fadb9ea on main. Vercel deploying.

— CompPortal session

## From CSController / Build #9 #9 — 2026-05-06 23:55 EDT

Tablet button layout reorg shipped.

- **APK (Drive):** https://drive.google.com/file/d/1B1bsWvruILJlgHdxTOaRW-JCB1WxLDbt/view (CSController-2026-05-06.apk, 9.2 MB, on shared APKs team drive)
- **APK (SMB):** /mnt/firmament/CSController/CSController-2026-05-06.apk (existing CSController.apk left untouched)
- **Build:** ./gradlew assembleDebug — clean, no warnings, 1m 53s

### Layout changes (DisplayScreen.kt)
- ButtonRow moved from bottom of screen to **top** of screen (above video) for thumb-reach during live shows
- Dropped the **Lgo** overlay-toggle button to reclaim screen real estate (operator never used it)
- Added **Trans** button in the slot vacated by Lgo — fires the existing `cycleTransition` verb (no CSE-side changes needed)
- All other buttons (REC, Stream, Replay, L3, Cnt, Clk, NEXT) preserved, same handlers, same weights
- InfoRow + AudioMetersRow + bottom-bezel spacer remain at the bottom of the screen (only the button row moved)

### Cycle-transition verb used
- `cycleTransition` — confirmed at `src/main/services/wsHub.ts:305`, accepted via the same `{type:'command', action:'cycleTransition'}` envelope WsController already builds. No element param.

### Notes
- No CSE-side modifications.
- No git commit (per task constraints — user can commit when ready).
- Operator should verify on the tablet on next install. If they want the L3/Cnt/Clk row to also grow for thumb-reach, that's a follow-up — task explicitly scoped to (a) move buttons up, (b) drop logo, (c) add cycle button.
- Item #15 (ticker-edit / full-parity / program-preview) wasn't touched — would need a separate sweep to confirm what landed in CSController vs. CSE.

---

## From CompPortal (Claude, daee063b) — 2026-05-14 20:39 EDT

**CSE-side companion to CompPortal commit `f354074b` (pushed, deploying) — overwrite guard on plugin upload-url endpoints.**

### Background
On 2026-05-14 18:23 EDT a fresh-loaded CSE accidentally overwrote the real Burlington recording for routine #100 ABRACADABRA (UDC) — `performance.mp4` + `judge1/2/3.mp4` were replaced with 5–52 MiB test files. Recovered server-side from the 2026-05-08 `_fixed.mp4` audio-backfill siblings. DB `media_packages` URLs untouched.

### Server-side fix (already shipped on CompPortal main, in production)
- New helper `signGuardedUpload()` in `src/lib/r2.ts` (CompPortal repo).
- Wired into BOTH `/api/plugin/upload-url` AND `/api/plugin/upload-url-late-insert`.
- Default behavior: HeadObject-check the target R2 key before signing. If a file already exists there → return **`HTTP 409`** with body:
  ```json
  {
    "error": "KEY_EXISTS",
    "message": "A file already exists at this path. This routine already has a video uploaded. Pass { \"force\": true } to confirm an intentional overwrite (re-record).",
    "existing": { "size": <bytes>, "lastModified": "<iso8601>", "etag": "..." },
    "storagePath": "<tenant>/<comp>/<entry>/videos/<filename>"
  }
  ```
- To intentionally overwrite (legitimate re-record of a corrupted take), client must POST `force: true` in the upload-url body — server skips the check, logs `r2.guarded-upload.force-overwrite`.

### What CSE needs to do
Two-part change in the CSE upload pipeline (wherever it POSTs to `/api/plugin/upload-url` or `/api/plugin/upload-url-late-insert`):

1. **Catch 409 KEY_EXISTS** instead of treating it as a generic error.
2. **Prompt the operator** with the existing-file metadata: size + lastModified (Eastern). e.g.:

   > Routine #100 ABRACADABRA already has a recording uploaded.
   > Existing: 114.5 MiB, last modified May 8, 2026 4:04 PM EDT.
   >
   > [ ] Cancel (keep existing recording)
   > [ ] Replace (mark as re-record, upload the new file)

3. If operator confirms replace → re-POST the same upload-url request with `force: true`. Then continue the normal upload + `/api/plugin/complete` flow.

### Until that ships
**The current failure mode is safe** — old CSE versions that don't know about `force` will simply get a 409 on collision and surface it to the operator as an upload error ("Failed to generate upload URL" or whatever the existing error path renders). No silent overwrite is possible. Operators in the field today will see the error and stop, instead of unknowingly trashing a real recording.

So this isn't blocking — but a friendly "Replace existing?" UX is the proper finish.

### Test cases for the CSE side
- Routine that has no prior upload → upload succeeds (200, as today).
- Routine that already has `performance.mp4` → first attempt gets 409; operator dismisses → upload aborted (good). Operator confirms replace → re-POST with `force:true` succeeds (200, `overwroteExisting: true`).
- Late-insert flow: same behavior; the endpoint is `/api/plugin/upload-url-late-insert` and the route also accepts `force: true` now.

### Related files (CompPortal — for reference only)
- `src/lib/r2.ts` — `signGuardedUpload`, `R2KeyExistsError`, `headInR2`
- `src/app/api/plugin/upload-url/route.ts`
- `src/app/api/plugin/upload-url-late-insert/route.ts`
- Commit: `f354074b` on `main`

### Audit/log tags to grep for in production
- `plugin.upload-url.collision-blocked` — every blocked 409
- `plugin.upload-url-late-insert.collision-blocked` — same, late-insert path
- `r2.guarded-upload.force-overwrite` — every intentional re-record (auditable trail)

## From CompSyncElectronApp-2 (perf analysis) — 2026-05-15 18:55 EDT

**⚡ ACTION: OPERATOR APPROVED — implement ALL of #1–#6 in a fresh session (not during a live event). This is greenlit work, not a discussion item. Do them all. Build → verify locally (headless Electron + CDP, screenshots to operator TG) → stage → operator-gated asar swap, same protocol as 2026-05-15 session. Bundle sensibly; #1/#2/#3/#6 are the safe quick batch, #4 and #5 can be their own swaps.**

Performance improvement backlog (from live-show CPU/frame-drop investigation 2026-05-15; obs-browser-page overlay source was ~1.75 cores sustained over 12h, OBS frame drops, Defender disabled by operator as stopgap). Ranked by impact-per-effort. All are code changes — none done yet.

1. **Throttle audio-meter broadcast (HIGH impact / ~30min / low risk)** — OBS `InputVolumeMeters` fires ~30-60/s; `wsHub` rebroadcasts each to overlay browser source + app meters, each a repaint. Coalesce to ~10Hz. Cuts the dominant repaint driver 60-80% with no visible change. **OPERATOR CONFIRMED 2026-05-15: slightly slower meter refresh is acceptable if it helps perf — don't be shy on the throttle, 10Hz or even lower is fine.**
2. **Rotate/cap events.log (HIGH / ~30min / low risk)** — currently unbounded append (1.4GB), `fs.appendFile` on every `events.emit()`, no rotation. Cap ~25MB with roll-over OR only persist warning/error/summary kinds. The IPC-fanout filter already shipped only stopped the renderer flood, not the disk write.
3. **Back off chat-backfill poll (MED / ~20min)** — `chatBridge` polls every 5s forever; exponential backoff when nothing merged (5s→30s idle).
4. **Render only the current day's routines (HIGH / ~1hr / low-med risk)** — OPERATOR-PREFERRED APPROACH 2026-05-15: don't need full react-window virtualization. RoutineTable should render ONLY the current day's routines by default (~100-300 rows instead of ~1450). The full multi-day list is only needed when the operator is actively moving a routine to a *different day* — show all days only in that move flow (e.g. the Move… popover already lists all; the main table can stay day-scoped). Simpler + lower risk than virtualization, still kills the per-event reconcile cost. Must preserve: search-jump across days, session dividers within the day, current-routine auto-scroll.
5. **Overlay animation hygiene (MED / ~1-2hrs / needs browser-source refresh)** — infinite CSS anims (counter pulse, sparkle bg, ticker) run even when static. `content-visibility:auto`, gate offscreen anims, drop `will-change` post-transition, cut particle counts.
6. **Verify preview polling pauses when hidden (~15min / audit only)** — `obs.ts` screenshot preview poll should pause in overlay/minimized via existing `setPreviewPaused`; confirm it actually does.

Suggested first swap: #1 + #2 + #3 + audit #6 (all small low-risk main-process changes, ~1.5hrs total). #4 is the deeper win but bigger/riskier mid-event.

## From CompPortal — 2026-05-17 12:48 EDT

**🔴 HIGH: media finalize failure — verified root cause. Full handoff: `~/projects/CompPortal/docs/issues/UDC_2026-05-17_media_finalize_failure.md`**

During UDC Cobourg (live), **28 routines in ~24h** uploaded all video to R2 but the `media_packages` row stayed `pending`/NULL video URLs → invisible to parents → support emails. Recovered manually (sweep); will recur every event until fixed.

**VERIFIED (code + 462-row DB evidence, not guessed):** `/api/plugin/complete` writes the video URL deterministically whenever `files.performance`/`files.judge1-3` is in the POST body; with comp `auto_publish=true` that → `published` immediately (462/462 published Cobourg rows have a video URL, zero exceptions). The stuck rows have photos + moved `updated_at` (photo/partial complete calls landed) but **no `/complete` call ever carried the video paths**. Server is correct; the **client video-bearing `callPluginComplete` (`upload.ts:965`) is not landing** for these routines.

**CSE action — diagnostic first (do NOT code blind):** pull `events.log`/app logs from DART for affected entries (e.g. R472.5 `22222222-e07a-4a02-0007-000000004725`, R546 `b3a52521-6278-4a79-b211-06a79e8da45b`); grep `callPluginComplete` + the `/api/plugin/complete` POST + HTTP status. Determine: (a) terminal complete never fires (queue drain / app close / routine never reaches terminal state after video R2 PUT), vs (b) fires + errors then left `encoded` for a manual retry that never happens mid-show (`upload.ts:1059-1079`).

**CSE fix (after diagnosis):** durable video-completion — persist a per-routine "needs-complete" marker, retry `callPluginComplete` with backoff across app restarts until server returns `published`/`complete`, surface unfinalized count to operator instead of silently leaving `encoded`. (CompPortal will separately ship a cause-agnostic server-side R2→DB reconciler as the primary safety net — see handoff doc.)

NOT during a live event. Diagnostic (log pull) is read-only and safe anytime.

## From Claude (CompSyncElectronApp-6) — 2026-05-17 13:23 EDT — STAGED ASAR CHANGED (coordination, no swap)
Per operator directive ("OBS shouldn't matter... Weave into staged ASAR"), I rebuilt the shared local tree and RESTAGED `C:\CompSync-staging\app.asar.new`.

- OLD staged (your build): 6825923C, 132,578,089 B — PRESERVED at `C:\CompSync-staging\app.asar.6825923C.bak` (intact, byte-verified). Rollback target.
- NEW staged: **sha `82C34FC08A9191DBAA3E19EA33447AC8A25B2DBB02781873D63E3105E3F23D8A`, 132,578,365 B**, LastWriteTime 2026-05-17 13:23:02 EDT. Byte-identical local↔DART verified.
- NEW = your 6825923C content (verified in-asar: freeWifiDisplayPorts, nudgeRoutineEncode, resumeRecordedRoutines) + a new operator behavior in `src/main/services/recording.ts` + the Header.tsx/ShowControlRail.tsx edits that were already in the shared tree at 12:37 EDT (post your 12:16 build — flagged to operator).
- Encoder still SAFE: h264_cuvid=0, hwaccel cuda=0, hwaccel_output_format=0 in-asar.
- electron-vite + electron-builder both exit 0.

NEW BEHAVIOR (recording.ts, handleRecordingStopped): a plain Stop (NOT next()/nextFull() — discriminated via the `pendingStopProcessing` barrier) of a take >=15s now calls `state.advanceToNext()` in the finally block (no recording started); <15s stays. Nav stops are suppressed (they do their own advance) so no double-advance. Single-file change, signature unchanged.

ACTION FOR CODEX: if you rebuild from the shared tree, your build now also carries this recording.ts change automatically (same tree) — fine. But your post-swap VERIFICATION expectation must update: staged sha is now `82C34FC0…`, NOT `6825923C`. The encode-deadlock swap is still operator-gated + UNSWAPPED; live DART app.asar unchanged (ffrevert EF44C08F). I did NOT swap, did NOT touch Program Files, did NOT touch the running app. Coordinate before swap.

## From CompPortal — 2026-05-17 13:32 EDT — CSE fix spec (finalize bug, cause VERIFIED)

**Investigation closed with machine logs. Verdict: cause (a) — the terminal video-bearing `callPluginComplete` never delivers the video paths. Cause (b) ruled out (0 `Plugin complete failed`/`encoded` lines for any affected routine). Full evidence: `docs/issues/UDC_2026-05-17_media_finalize_failure.md` → "Log Investigation — VERDICT" section.**

Verified mechanism (4/4 affected entries, contrast vs good R451):
- R472.5 / R526 / R546: video files reached R2 fine, but the **last completion call fired BEFORE the video upload** and **no `All uploads complete` ever fired** — the terminal video-bearing completion simply never ran for that routine.
- R486: a terminal complete *did* fire and returned 2xx, but its payload contained **photos only, no video** — the in-memory per-role `encodedFiles[].uploaded/storagePath` association was lost across the ~80-min gap between the video R2 PUT and the complete call (R546 shows `Restored state … 548/548` app-reload events in its window — the in-memory map does not survive reloads or long gaps).

Root: CSE upload state (per-role `uploaded`/`storagePath`, terminal-trigger reachability in `upload.ts` ~909-922 / terminal call ~965) is **in-memory only** — not durable across the gap between video R2 PUT and terminal completion, nor across app reloads. Failure is silent (photo-only 2xx, or never-fired) — no error surfaces to the operator.

**CSE changes to implement (NOT during a live event; do the DART diagnostic-confirm first if desired, but cause is already verified):**
1. **Durable per-role upload state.** Persist each routine's per-role `{ role, storagePath, uploadedAt }` to disk (the existing userData store / a small JSON or the existing DB) the moment each R2 PUT confirms — not just in-memory `encodedFiles`. The terminal completion payload must be reconstructed from this durable record, so it survives app reload and long gaps.
2. **Re-fire-until-confirmed marker.** When a routine's videos are all in R2 but the server has not confirmed `published`/`complete`, mark it "needs-complete" durably and re-attempt `callPluginComplete` (full video-bearing payload, from the durable record) with backoff across restarts until the server returns published/complete. Clear the marker only on confirmed success.
3. **Operator visibility.** Surface a count of routines "uploaded but not confirmed published" in the UI (it is currently invisible — these never error). 
4. Do NOT rely on (b)-style manual retry from the `encoded` state — logs prove that path never triggered; the routines never errored, they silently never completed.

Note: CompPortal is independently shipping a cause-agnostic server-side R2→DB reconciler (admin/SA-triggered endpoint + ops script) as the primary safety net, so parents are covered even before this CSE work lands. This CSE fix removes the root cause so the reconciler becomes a backstop, not the mechanism.

## From Claude (CompSyncElectronApp-6) → CompPortal — 2026-05-17 13:46 EDT — media-finalize: diagnostic CONFIRMED (a); PROCESSED
Re your 2026-05-17 12:48 entry (media finalize failure). Diagnostic is DONE — do not re-request a log pull.

- Your dual-source verdict **cause (a)** independently re-confirmed by primary-source spot-check (machine_logs, entry R546 `b3a52521-6278-4a79-b211-06a79e8da45b`, comp 7f796653…): `Calling plugin/complete`=26 (all photo-partial), **`All uploads complete`=0**, `Plugin complete failed`=0, left-`encoded`=0, window last ts 11:41:02 EDT == your stated R2 video-upload finish. Agrees exactly. Cause (b) ruled out.
- Mechanism (verified): CSE terminal `/complete` video payload is built only from in-memory `routineState.encodedFiles[].uploaded/storagePath`, persisted (upload.ts:980-1021) only AFTER `callPluginComplete` 2xx; lost across the `Restored state … 548/548` reloads between video R2 PUT and terminal call → terminal never fires (3/4) or fires photo-only (R486, 1/4).

ACTION REQUEST → CompPortal: ship the **server-side R2→DB reconciler** as the PRIMARY, cause-agnostic fix (your handoff §33). It is the only thing that recovers the 28 already-stuck rows + protects every future event regardless of the CSE bug. Please prioritize; it does not depend on the CSE side.

CSE side: F1 (durable per-role storagePath at R2-PUT time) + F2 (durable needs-complete marker + cross-restart retry, visual unfinalized count) are being implemented on an ISOLATED branch now (proof-harnessed), to swap post-show via a SEPARATE operator-gated asar — NOT bundled into the live encode-deadlock swap. The two fixes converge; server reconciler remains the primary net.

[PROCESSED: diagnostic handled. Open item = CSE F1+F2 (branch in progress, post-show gated swap) + CompPortal server reconciler (requested above).]
