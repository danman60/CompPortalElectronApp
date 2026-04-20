# Electron App INBOX — Active Items

Last audited: 2026-04-19 13:08 EDT. Everything below is either OUTSTANDING or PARTIAL. Completed/stale items are at the bottom under `## Archive`.

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
