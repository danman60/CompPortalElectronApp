# UDC London 2026 — Incident Prevention Log

**Running list of all fixes needed to prevent today's photo-sorting + upload
disaster from recurring. Updated as new gotchas surface.**

Context: during UDC London Day 1, a mix of bugs corrupted photo-to-routine
mapping for routines 100-120 (60s tether buffer + camera-clock offset era).
A disk re-sort happened externally (by another agent) but didn't update the
app's in-memory state, causing cascading issues. Photos stayed unassigned in
CompPortal DB for a huge portion of the day. This document captures every
root cause and preventive fix so this never repeats.

---

## CATEGORY 1 — Photo matching robustness

### 1.1 Clock-drift detection + operator warning
**Gap:** The tether matcher uses raw EXIF `DateTimeOriginal` to bucket photos
into recording windows. If the camera's clock drifts (battery swap, sync loss,
manual adjustment), photos silently land in the wrong routines.

**Fix:**
- On first N (say 5) photos of a session, compute `EXIF - wallClockNow`
  offset. If median `|offset| > 2 min`, display a persistent banner:
  "Camera clock drift detected: +X min. Photos may sort incorrectly. Verify
  camera time or enable manual offset."
- Add `tether.cameraClockOffsetManual` setting — operator can punch in a
  number that gets subtracted from EXIF before matching.
- Log clock-drift warnings to `main.log` with `[tether-clock-drift]` tag.

### 1.2 Window buffer sanity check
**Gap:** A 60s `matchBufferMs` was deployed and silently ruined routine
assignments because photos bled into adjacent routines.

**Fix:**
- Clamp `matchBufferMs` to `[0, 30_000]` at settings load. Values outside
  warn and clamp.
- Display the current buffer value in the tether status strip so operators
  can see at a glance.
- Unit test: a photo exactly on a routine boundary with buffer=5s must match
  the correct routine (first by start time).

### 1.4 Tether-idle alert + watch-folder staleness detection
**Gap:** Today the camera-side tether app was NOT running for a stretch of
routines. Photos piled up on the camera's SD card while CompSync's watcher
saw zero new files. The operator had no signal that something was wrong
until post-recording review. AND when the tether was reactivated, the
app didn't auto-catch-up (see Category 2.6 below).

**Fix:**
- Track rolling photos-per-minute rate at the tether watcher. Expected is
  routine-dependent (most routines at UDC London today had 100-300
  photos / 2-3 min = ~30-100/min).
- If a recording is active AND photos-per-minute drops below threshold
  (e.g. < 5/min for > 30s), raise a persistent banner:
  **"No photos detected from camera. Check that the tether software
  (e.g. Canon EOS Utility / Sony Imaging Edge) is running and connected.
  Watch folder: <path>"**
- Include file mtime of the most-recently-added photo in the tether
  status strip so operator can see at a glance "last photo: 3 min ago"
  vs "last photo: 2 sec ago."
- If watch folder hasn't received a file in > 2 min DURING a recording,
  auto-escalate the alert (red pulse, sound optional).

### 2.6 rescanPhotos doesn't walk when watcher is active
**Gap:** `rescanPhotos()` guards with `if (!watcherActive) { walk... }`.
Intent was "active watcher has caught everything already." Reality: when
chokidar starts with `ignoreInitial:true`, any files ALREADY in the watch
folder are invisible. So if the tether was off for a stretch and files
accumulated in the watch folder BEFORE the app's watcher started, those
files are never processed — even though the watcher is "active."

**Today's occurrence:** user reports the camera-side tether app wasn't
running for some routines; some photos may have landed in the watch
folder without CompSync seeing them.

**Fix:**
- On `startWatching()`, do a one-time walk BEFORE chokidar starts (or
  immediately after) to catch accumulated files. Feed them through
  `processNewPhoto` with the same matching logic.
- Drop the `!watcherActive` guard in `rescanPhotos()` — always walk the
  folder. The `importedFiles.has(path)` skip already prevents
  double-processing.
- Add a "Force rescan now" button in the UI for manual recovery.

### 1.3 "Photos outside window" alert
**Gap:** Nothing surfaces when tether is systematically assigning photos
whose EXIF is 10+ minutes earlier than the current wall time — a dead
giveaway of clock drift or buffer bloat.

**Fix:**
- Add rolling counter: photos matched where `wallClockNow - EXIF > 10 min`.
- If that counter exceeds 5 in the last 100 matches, raise banner in UI
  and log `[tether-suspicious]`.

---

## CATEGORY 2 — State / disk / queue consistency

### 2.1 Disk re-sort must update state.json atomically
**Gap:** Externally moving photo files between routine directories while the
app runs corrupts `routine.photos[].filePath`. The app's next save then
persists the stale paths, and uploads fail (ENOENT).

**Fix:**
- Build the in-app "Verify & Re-sort Photos" button (task #6). This does
  everything atomically: reads EXIF, moves files, rewrites `photos[]`,
  clears `uploadRunId`, cancels stale jobs, all in one flow.
- Never do external disk re-sort again. If absolutely necessary, the
  procedure is: (a) close app, (b) move files, (c) script rewrites
  state.json using disk EXIF as truth, (d) clear job-queue.json entries
  for affected routines, (e) relaunch.
- The runbook at `docs/plans/2026-04-17-photo-resort-runbook.md` has the
  full spec.

### 2.2 jobQueue cleanup on routine photo reset
**Gap:** Today's reset cleared `routine.photos[]` uploaded flags but did NOT
remove the matching upload jobs from `job-queue.json`. Those stale jobs
referenced old filenames (photo_258.JPG etc.) that no longer exist on disk.
They keep failing forever and block `plugin/complete` from firing.

**Fix:** When a routine's `photos[]` array is rewritten (re-sort, re-record,
manual reset):
- Walk `job-queue.json` and cancel ALL jobs (pending/running/failed) for
  that routine whose payload filename is not in the new `photos[]`.
- Better: cancel all upload jobs for the routine and re-enqueue fresh.
- Expose a `state.resetRoutinePhotos(routineId, newPhotos)` helper that
  does both the photos-array swap AND the jobQueue sweep.

### 2.3 `retrySkippedEncoded` is blocked by stale jobs
**Gap:** `retrySkippedEncoded()` (upload.ts:720) guards against re-enqueueing
a routine if it has any `pending/running/done` jobs — protects against
double-upload. But after a reset, this same guard prevents any re-enqueue.

**Fix:**
- On routine photo reset, cancel the stale jobs first (see 2.2), then the
  `hasPendingOrDone` guard yields false and retrySkippedEncoded works.
- Alternatively, add a "Force re-upload" path that ignores the guard and
  cancels existing jobs before enqueueing.

### 2.4 Don't delete photo files until upload is confirmed
**Gap:** The external disk re-sort deleted old photo_042.JPG (for example)
and wrote a different file at the same name. An in-flight upload of that
filename got the wrong bytes.

**Fix:** If implementing in-app re-sort, rename old files (e.g.
`photo_042.JPG.old-106`) before moving new files in. Delete `.old-*`
only after upload of new file succeeds. Provides a rollback.

### 2.5 jobQueue garbage collection
**Gap:** `job-queue.json` grew to 6.8 MB today with thousands of failed /
done jobs. Never pruned.

**Fix:** On app startup, prune jobs older than N days or with status in
`{done, cancelled, failed-permanently}`. Keep most recent 1000 for
diagnostic value.

---

## CATEGORY 3 — plugin/complete + DB contract

### 3.1 Send recording timestamps to DB
**Gap:** `plugin/complete` payload doesn't include
`videoStartTimestamp`/`videoEndTimestamp`. DB `media_packages` rows have
those columns NULL for every UDC London routine. Without them, no
server-side EXIF-vs-window reconciliation is possible — we had to pull
DART's local state.json over SSH to get the windows.

**Status:** Electron change drafted during this session (includes the
timestamps in the payload) but rolled back with the asar because the
second subagent build was broken. **Needs redeploy post-event.**

**CompPortal side:** `/api/plugin/complete/route.ts` must accept + persist
the fields. Filed in CompPortal INBOX 2026-04-17 entry.

### 3.2 Plugin/complete should not hang on missing files
**Gap:** A single failed upload (file missing from disk) causes plugin/
complete to never fire for that routine — all 257 other photos sit in
limbo because allDone is stuck.

**Fix (Electron side):** After N retry attempts on a file that consistently
returns ENOENT, auto-cancel that specific job with a clear failure reason,
allow the rest of the routine to complete.

**Fix (UI side):** Show per-routine upload progress with individual
file-failure counts so operators can see what's stuck.

### 3.3 Plugin/complete should be retryable without full re-upload
**Gap:** If plugin/complete itself fails (network timeout, 500), the whole
routine is stuck because routine status bounces back to 'encoded' and
retrying means re-uploading all photos again.

**Fix:** Separate the upload-complete signal from the
plugin/complete-called signal in routine state. Allow retrying just
plugin/complete (with the stored storagePaths) without redoing R2 puts.

### 3.5 CompPortal: photo_count double-increment on bulk INSERT
**Discovered 2026-04-17 during DB reconcile:** There appears to be a
trigger on `media_photos` INSERT that increments `media_packages.photo_count`
by 1 per row. When INSERT-ing in bulk with an explicit `photo_count`
(e.g., `photo_count = 257` on package creation + 257 row inserts), the
result is `photo_count = 514`. Inserting bulk without trigger awareness
doubles the count.

**Fix options:**
- Always recompute `photo_count = COUNT(*)` after any bulk INSERT
  (what I did here).
- Inspect/document the trigger; if it exists, plan around it.
- Consider removing the trigger and making photo_count a computed value.

### 3.4 CompPortal: clear `deleted_at` on plugin/complete
**Status:** Existing CompPortal INBOX item from prior session. Still open.
Must be shipped to prevent soft-deleted rows from masking live media.

---

## CATEGORY 4 — Upload pipeline throughput

### 4.1 Upload concurrency
**Gap:** `processLoop` in upload.ts:245 is a serial `while (!isPaused) { ... await ... }` loop. Even though multiple routines showed `status=uploading`, only one file is in flight at a time. At ~1 file/sec including signed-URL round trip, 7000+ photo backlog takes 2+ hours.

**Fix:** Convert to a promise pool with configurable concurrency (default 4-8). Each worker pulls `jobQueue.getNext('upload')` independently. Guard the `allDone` check against race conditions (single `updatedJobs` read + atomic status write).

### 4.2 Upload progress visibility per routine
**Gap:** During backlog drain, operator can't easily see which routines
are uploaded vs queued vs failed without reading main.log.

**Fix:** Existing progress events could feed a persistent
"Upload Queue Panel" in the UI. Grouped by status, with a retry button
per failed routine.

### 4.3 Pause / resume during recording
**Gap:** Uploads compete for network with OBS stream. If OBS is streaming
+ uploading simultaneously, OBS frames drop.

**Fix:** Setting `behavior.pauseUploadsDuringRecording`. When OBS is
recording AND streaming, upload processLoop is paused. Resumes on stop.

---

## CATEGORY 5 — Deploy + build safety

### 5.1 Asar build verification
**Gap:** A subagent built an asar that was only 1 MB (packed just `out/`
without node_modules). It was deployed and the app wouldn't start. Had
to roll back.

**Fix:**
- Add a post-build sanity check: if resulting asar < 50 MB, fail with
  clear error. Real CompSync asar is ~127 MB.
- Document the correct `npm run build` → electron-builder path so
  subagents don't shortcut via `npx asar pack out/`.
- Add the size check to the deploy skill/prompt when delegating builds.

### 5.2 Backup naming convention
**Gap:** Multiple backup files accumulated with non-standard names
(`app.asar.bak`, `app.asar.bak-pre-switch`, `app.asar.pre-2panel`,
`app.asar.v2.7.0-stable`, etc.). Hard to pick the right rollback target.

**Fix:** Always name as `app.asar.bak-<ISO-timestamp>-<short-description>`.
Document 3 standard rollback targets: (a) last-known-good, (b)
start-of-day, (c) last-stable-release.

---

## CATEGORY 6 — UX / operator ergonomics

### 6.1 Recording time indicator visibility
**Status:** Fixed this session (32px font, glowing red dot). Asar `7fc579b9`
deployed mid-show.

### 6.2 Dedicated "Upload Health" dashboard
**Gap:** Operator had to read main.log + state.json diffs to understand
"why aren't my uploads happening?"

**Fix:** A UI panel that shows, per routine: status, photo count disk vs
state, photo count state vs DB, jobs pending/failed/done, last
plugin/complete outcome. One glance answers 90% of production questions.

### 6.3 "Verify & Re-sort Photos" button — must auto-detect drift
**Status:** Logged as task #6. Spec is the runbook at
`docs/plans/2026-04-17-photo-resort-runbook.md`. Must be built before
the next event.

**Critical capability — drift detection, not just window matching:**
Today's 148-166 camera-clock incident proved pure EXIF window matching
isn't enough. When the camera drifts by hours, photos' EXIF falls into
OLD routine windows and they get silently misfiled. The flow must:

1. **Track arrival time** (file mtime at the tether watch folder,
   or chokidar 'add' event timestamp) ALONGSIDE EXIF capture time
   for every photo.
2. **Detect bulk drift by comparing distributions**: if the last N
   photos arrived during routine X's recording window but their EXIF
   timestamps cluster around a much earlier window Y, compute the
   median `arrival - EXIF` offset. If that offset is > 5 min and
   stable, flag as drift.
3. **Offer the operator a correction**: "We detected photos arriving
   in real-time but with EXIF 1h 3m in the past. Apply -1h 3m offset
   to EXIF for sorting?" Operator clicks yes → matcher applies offset
   going forward AND optionally to last N photos already bucketed.
4. **Re-sort retroactively**: given an offset, walk the affected
   routines' photos[] arrays, add the offset to captureTime, re-match
   to windows, move files between routine directories, rewrite
   state.json, cancel stale jobQueue entries.
5. **Reject suspicious matches at intake**: if an incoming photo's
   `arrival_time - EXIF` differs from the rolling median offset by
   > 5 min, flag it (don't auto-match) so operator sees it.

**Today's workaround being rolled into spec:** I'm doing this by hand
during the break using state-stable.json + disk inspection. In-app
this should be a single button click with a preview modal.

### 6.4 Live DB-vs-disk drift indicator
**Gap:** Operator had no way to know DB state diverged from disk for 47
routines. They only noticed photo counts looked off hours later.

**Fix:** Poll `photo_count` from CompPortal (via an endpoint or direct
SQL) and compare to `routine.photos[].length`. Flag red if different.

---

## CATEGORY 7 — Orchestration / post-mortem tooling

### 7.1 DB re-association utility
**Gap:** Had to hand-roll SQL during the incident. No reusable tool.

**Fix:** Build `scripts/reassociate-photos.ts` (or a CompPortal admin
page) that takes:
- Competition ID
- Range of routines
- Local state.json (for EXIF + captureTime mapping)

Outputs: `UPDATE media_photos SET media_package_id = ...` SQL + an
`INSERT INTO media_packages` for routines lacking rows. Dry-run preview
then execute.

### 7.2 Retroactive timestamp backfill
**Gap:** UDC London routines have NULL `video_start_timestamp` /
`video_end_timestamp` in DB. Once the Electron app change ships, NEW
routines will populate. But historical ones stay NULL unless we backfill.

**Fix:** After Electron change ships, run a one-time backfill script
that reads each routine's `recordingStartedAt` / `recordingStoppedAt`
from the DART state.json and does `UPDATE media_packages SET
video_start_timestamp = ..., video_end_timestamp = ...` for all
competitions we care about.

---

## CATEGORY 8 — Process / session

### 8.1 Always check for an existing remediation before starting one
**Gap:** I spent ~15 min computing a re-sort manifest and state rewrite
before discovering another agent had already moved photos on disk. Wasted
time and nearly caused double-processing.

**Fix:**
- At session start, check `CURRENT_WORK.md` AND look at fresh disk+state
  diff to see if work is partially done.
- Coordinate via INBOX.md when multiple agents may touch the same project.

### 8.2 Never modify state.json while app is running
**Gap:** State writes from Claude's side race with the app's periodic
saves. In this session I got lucky (app was closed) but the precedent
is dangerous.

**Fix:** Standard procedure: ask user to close app → modify → user
restarts. If app must stay running, use IPC commands only.

### 8.3 Document "DB is not primary source of truth"
**Gap:** During the incident I initially tried to diagnose via DB but
the live state was on DART's local state.json. The DB only reflects
what plugin/complete has successfully pushed — which can lag hours
behind disk reality.

**Fix:** Update project CLAUDE.md: "For live-show incident diagnosis,
pull `compsync-state.json` from DART first. DB lags; local state is
authoritative until plugin/complete closes the gap."

---

## Root theme of today's incident

**The #1 failure mode today was photo ingestion — getting photos from
camera → watch folder → correct routine → DB.** Every major issue
cascaded from a break somewhere in that chain:

1. **Camera → watch folder**: Tether software on the camera side wasn't
   always running. Photos piled on SD card, invisible to CompSync. (C1.4)
2. **Watch folder → CompSync**: When tether was reactivated, accumulated
   files in watch folder stayed invisible due to `ignoreInitial:true` +
   `rescanPhotos` guard. (C2.6)
3. **CompSync → correct routine**: Buggy matchers (60s buffer + corrupted
   clock offset; later camera clock drift at #148-166) put photos in
   wrong routines. (C1.1, C1.2, C1.3)
4. **Correct routine → DB**: Plugin/complete blocked by stale jobQueue
   entries after external disk re-sort. 47 routines stuck. (C2.2, C2.3, C3.2)

**Priority for post-event fixes should be Categories 1 & 2** — photo
ingestion integrity. Get the pipe reliable before optimizing anything
else (concurrency, UX polish, etc.). The in-app "Verify & Re-sort"
button (C6.3) is the single-biggest lever because it addresses all four
of the above failure modes in one tool.

## Recorded incidents this event

### 2026-04-17 — Tether software not running (routines ~148-170) [CORRECTED 16:30 ET]
Per operator report (corrected): the camera-side tether software was not
running for the **entire second session** — from start of session 2
(routine **~#148**) through **~#170**. Photos during this window stayed
on the camera SD card and did not transfer to DART's watch folder. When
tether was reactivated ~#170, the app did NOT auto-catch-up (see C2.6).

Session boundary inferred: UDC London competition_sessions table is
empty in DB; schedule dividers are client-side-only (15-min idle gap in
RoutineTable). Operator confirmed session 1 ended at #147, session 2
started at #148. Exact end-of-gap routine (~#170) to be re-verified
post-event by comparing SD card contents to DART disk.

**NOTE:** this range FULLY OVERLAPS the "Camera clock drift" entry
below (#148-166). The two incidents are not separate — if tether was
off for #148-170, the earlier "drift" hypothesis for #148-166 is likely
obsolete because no photos transferred at all. Revisit that entry
post-event after SD card is pulled.

**State of those photos:**
- Camera SD card has the originals for #148-170
- DART watch folder did NOT receive them (tether off = no transfer path)
- DART disk for #148-170 likely has zero or near-zero photos

**Recovery plan (post-event):**
- Pull all originals from camera SD card
- Reconstruct per-routine bucket from EXIF + session 2 schedule
- Copy into correct routine dirs (or use C6.3 "Verify & Re-sort"
  button once built) then upload

### 2026-04-17 — Camera clock drift on resume (routines 148-166) [SUPERSEDED? — revisit post-event]
**Status update 16:30 ET:** operator reported tether software was OFF
for the entire session 2 (#148-170). If tether was off, no photos
transferred to DART during this window, so the clock-drift story below
is likely moot at the DART-app level. The drift may have affected
on-SD-card EXIF timestamps which will matter during post-event SD pull
+ bucket. Keep original analysis intact below for reference; re-evaluate
once SD card contents are examined.

---

After the ~10:29 ET break, the camera clock was off by **at least an hour**
(running ~1h earlier than wall time). Affected routines **148 through 166**,
roughly 10:50 ET through 11:50 ET. Corrected at/after routine 166.

**IMPORTANT for post-event photo bucketing:** when the operator reset the
camera clock mid-day, EXIF `DateTimeOriginal` across the day's photos is
NOT monotonic. Expect a **~1hr discontinuity** (sudden jump forward or
backward) at the reset moment. Any sort/match logic that assumes strictly
increasing EXIF time across the day will break — bucket photos in two
passes (pre-reset era and post-reset era) or apply a known offset to
pre-reset photos before merging.

**Consequence:** Photos shot during recordings of #148-166 had EXIF
timestamps ~1h in the past. The tether matcher bucketed them into whatever
earlier routine's window the drifted EXIF fell into — likely piling onto
routines in the 100-130 range. Those earlier routines will show inflated
counts on disk; routines 148-166 will show zero or few photos on disk.

**State of data:**
- `/tmp/dart-state-stable.json` was captured at 14:09 UTC — PRE-drift.
- Disk count snapshot was captured at 14:22 UTC — PRE-drift.
- Any disk state read AFTER 14:53 UTC (show resumption) reflects the
  contamination from 148-166.

**Action required:**
- Re-query DART's current state to see which routines absorbed the 148-166
  drift.
- Use routine 148's recording window as the oldest "real" capture time
  expected for the affected period — anything EXIF-older than #148's
  start that arrived during 148-166 was almost certainly a drifted
  photo.
- Moving those photos back to their correct routine requires either
  (a) a known offset to subtract, or (b) identifying them by arrival
  time + filename pattern rather than EXIF.

## Progress tracker
- [x] Recording timer UI — shipped (asar 7fc579b9)
- [ ] Electron: send recording timestamps in plugin/complete (drafted + rolled back; redeploy post-event)
- [ ] CompPortal: accept + persist video timestamps
- [ ] CompPortal: clear deleted_at on plugin/complete
- [ ] "Verify & Re-sort Photos" in-app button (task #6)
- [ ] jobQueue cleanup on routine photo reset
- [ ] Clock-drift detection + warning banner
- [ ] Upload concurrency (promise pool)
- [ ] Asar build size sanity check
- [ ] DB re-association utility
- [ ] Backfill video_start/end_timestamp for UDC London 2026
