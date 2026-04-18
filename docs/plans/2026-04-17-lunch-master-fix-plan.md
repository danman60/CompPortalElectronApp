# UDC London 2026 — Lunch Break Master Fix Plan

**Trigger:** ~1 hour window during lunch break. Show paused; operator
can stop/start the CompSync Media app. SD card available if needed
(but likely not required — see below).

**Goal:** fully reconcile DART + DB + R2 for all in-progress routines
(#100-current), restore the photo matcher, redeploy the
recording-timestamp asar, clean the jobQueue, upload everything that
should be uploaded, update DB to reflect final truth.

**Outcome after:** every recorded routine has correct photos on disk,
correct DB rows, correct R2 objects. App is running the fixed asar.
Show resumes with a clean pipeline.

---

## Additional live-show issues (surfaced after initial plan)

These must be verified as FIXED after the cleanup, or debugged if still broken.

### Issue X1: NEXT button slow, getting slower (up to ~15s)
**Root cause (diagnosed):** state.json is 4.1 MB, being rewritten ~8×/second
on photo matches. Each photo match triggers a state save + .bak file. The
app is doing ~150 MB/s of disk I/O just for state persistence during photo
bursts. Hundreds of .bak files accumulated. Plus the 8.2 MB jobQueue
amplifies this.

**Expected fix:** jobQueue nuke + .bak cleanup + app restart will clear
retained memory (~1.8 GB across 4 processes now). Post-restart NEXT should
return to <2s.

**Verification after restart:** operator does 3 NEXT presses in a row;
each must complete in <2s.

### Issue X2: Lower-third shows wrong routine during RECORDING
**Suspected root cause:** the matcher retry loop is logging "Tether: Retry
still no match — PNNNNN at <timestamp> vs 87 windows" continuously for the
pre-lunch unmatched photos. Each retry likely touches state. The overlay
"routine data updated" events compete with these. Log shows:
- 12:49:06 NEXT pressed
- 12:49:09 OBS stopped
- 12:49:12 overlay updated to #186 (PREVIOUS routine, 3s after stop)
- 12:49:14 overlay updated to #187 (new routine)
A 2-second window where the lower-third shows stale data.

**Expected fix:** once PHOTOIMPORT is bucketed and photos ARE matchable,
the retry loop stops. Overlay broadcasts should no longer race.

**Verification after restart:** operator records a test routine. Does
lower-third show the correct routine within 500ms of recording start?

### Issue X3: Matcher not sorting session 2 photos
**Root cause:** unknown. Photos land in PHOTOIMPORT but most don't get
copied into routine folders for #148-182. Worked briefly for #173-175.

**Verification after restart:** during a test recording, photos arriving
in PHOTOIMPORT should be copied into the recording routine's folder within
a few seconds. If not, the matcher has a persistent code bug, not just a
transient state issue.

### Correction to photo handling (from operator)
- **Every photo is a dancer photo — no test shots.** The 330 "unmatched"
  photos in mtime-bucket analysis are NOT orphans. Every file must be
  assigned to SOME routine.
- **Camera was never off** — so photos for #161-172 exist somewhere. If
  PHOTOIMPORT EXIF-bucket doesn't find them, they're on the SD card
  (tether buffering that never flushed) and the SD card pull IS needed.
- **Use EXIF `DateTimeOriginal`, not file mtime.** Mtime = DART-arrival
  time; EXIF = actual shot time. Tether buffering can shift mtimes by
  arbitrary amounts, but EXIF is authoritative. All bucketing must switch
  to EXIF. Add a 30-sample EXIF-vs-mtime diff check as the first
  diagnostic of lunch break.

---

## 0 — Current state (as of 2026-04-17 12:36 ET)

### Key findings (all verified against disk + state.json + DB)

**Photos on DART:**
- `PHOTOIMPORT\` = 11,832 JPGs total (camera dumps, not sorted into
  routine folders yet). Continuous sequence per operator — no missing
  files from the camera.
- `TesterOutput\UDC London 2026\<routine>\photos\` populated for
  #100-147 and #173-175 only. All session 2 routines (#148-172 except
  the #173-175 blip, and #176-current) are EMPTY on disk even though
  photos exist in PHOTOIMPORT.

**The matcher is broken.** Photos land in PHOTOIMPORT fine (tether
is actively transferring — last mtime 12:36:42 ET), but Electron isn't
copying them into routine folders for session 2.

**True camera-off window:** **#161-172** (12 routines, ~11:39-12:12
ET) — zero photos in PHOTOIMPORT for those windows. Camera was
genuinely not shooting. No data recovery possible for these.

**Photos in PHOTOIMPORT matched to recording windows but NOT yet
sorted into routine folders:**

| Routine block | Approx photos |
|---|---|
| #148-160 (13 routines) | ~1,500 |
| #176-182 (7 routines, growing) | ~750 |
| **Total to sort** | **~2,250** |

Plus ~330 "between-window" photos that don't match any routine (break
shots, test shots, transitional) — dump to orphan dir.

**DB state (reverted pending verification):**
- Routines 100-111 status='pending'; #112 complete (pre-existing);
  #113 'processing'
- photo_count fields correctly populated via Batch 3 recompute
- Routines #148+ have NO DB rows; need media_packages + media_photos
  created once photos are uploaded

**JobQueue:** 82+ stale entries blocking plugin/complete for #113 (and
likely for every reset routine). Confirmed during this session.

**Asar:** currently `app.asar.bak-20260417-145002` (= working
recording-text build, md5 `7fc579b9`). Needs redeploy with
`video_start_timestamp` + `video_end_timestamp` in plugin/complete
payload (previous attempt was bad build, rolled back).

### What's in `CompPortal` (receiving side)
- Plugin/complete endpoint: still needs `deleted_at` clear + needs to
  accept `video_start_timestamp` / `video_end_timestamp` fields. These
  are CompPortal-side fixes, can be done in parallel or during break.

---

## 1 — Pre-flight prep (DO NOW while show is live)

All cheap reads + local scripting. Zero DART writes.

### 1.1 Finalize recording-window data from state.json (DONE)
- `/tmp/session2-windows.json` — already written, but re-fetch right
  before lunch to catch latest routines (#180+ still recording)

### 1.2 Script: EXIF-bucket PHOTOIMPORT → routine folders
Python script `/tmp/sd-bucket.py`. Inputs:
- `--source` dir (default `C:\Users\User\OneDrive\Desktop\PHOTOIMPORT`)
- `--windows` JSON from state.json (all routines with recording
  windows, not just session 2 — we need to NOT re-copy photos that
  are already sorted)
- `--dest-root` `C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026`
- `--dry-run` (default on; must be explicitly turned off)
- `--buffer-sec` (default 5)

Behavior:
- Walk SOURCE for *.JPG
- Read EXIF `DateTimeOriginal` (falls back to file mtime if EXIF
  missing — which shouldn't happen for camera files)
- For each file, find unique routine window that contains EXIF time
  ± buffer
- If multiple windows match (overlap edge cases): pick one with
  EXIF closest to midpoint
- If no window matches: mark orphan
- For a matched file:
  - Check dest dir `dest-root\<en>\photos\`. If exists, find next
    available `photo_NNN.JPG` number AFTER the max existing. Never
    overwrite, never renumber existing.
  - Copy (not move) file to dest with new name
  - Record mapping: source P-name → dest entry_number / photo_NNN.JPG
- Emit JSON report: per-routine `{before: N, added: M, after: N+M}`
  + orphan list (count + sample filenames)
- If `--dry-run`: skip actual copies, just produce the report

Package this as a single Python file that DART's Python can run (DART
has Python per earlier runs of ollama-runner).

**Test it locally first**: run against a `/tmp/mock-photoimport` with
a handful of files to validate logic. Target: 100% of files matched
to an expected routine in mock.

### 1.3 Script: jobQueue cleaner
Python script `/tmp/clean-jobqueue.py`. Inputs:
- `--queue` path to `C:\Users\User\AppData\Roaming\compsync-media\job-queue.json`
- `--backup` path to write `.bak-<timestamp>`
- `--mode=surgical|nuke`

Behavior:
- Back up input to `<path>.bak-<timestamp>`
- Load JSON
- `surgical` mode: drop jobs where file does not exist on disk, OR
  where status is 'failed' and retries >= 3, OR where status is
  'completed' and age > 24h
- `nuke` mode: replace with `[]`
- Write back, report diff (counts by status/action before/after)

### 1.4 Asar redeploy artifact
The `video_start_timestamp` / `video_end_timestamp` change is on
branch / WIP. Need to:
- Build a KNOWN-GOOD asar locally (Linux side, per feedback_build_pattern)
- scp it to DART into a staging path (NOT the live app dir)
- During break: replace live asar with staging

**Action before break:**
- Review the rolled-back commit to understand what changed in
  plugin/complete payload
- Rebuild locally following the "local build + scp" pattern — including
  node_modules, full app.asar, confirmed > 50 MB
- Save as `/tmp/app.asar.staging-<timestamp>`
- scp to DART staging path: `C:\Users\User\app-asar-staging\app.asar-<timestamp>`
- DO NOT touch the live asar yet

### 1.5 Re-fetch main.log (cheap read) to diagnose matcher failure
Right before lunch, scp main.log. Look for:
- `[tether-watcher]`, `[photo-matcher]`, `[photo-import]` entries in
  post-break timeframe
- Exception stack traces around state file writes
- Chokidar errors
- FS permission errors

This tells us WHY the matcher broke. May inform whether a restart
alone will fix it, vs a code change.

### 1.6 Fetch latest snapshot of routines + DB state
One query each:
```
SELECT entry_number, COUNT(*) AS db_rows FROM media_photos
JOIN media_packages ... WHERE competition_id=... AND entry_number BETWEEN 100 AND 300
GROUP BY entry_number ORDER BY entry_number;
```
Reconcile against disk counts from `Get-ChildItem -Recurse` on
routine dirs. Output: for each routine, (disk, DB) pair.

### 1.7 Confirm CompPortal side
Read CompPortal INBOX: what's outstanding on the CompPortal side? May
need a branch ready there too (`deleted_at` clear +
video_start/end_timestamp accept). Build it separately in CompPortal
repo; deploy when time permits.

---

## 2 — Master execution plan (1-hr window)

Designed to fit inside 55 minutes with 5-min buffer. If anything runs
long, abort at a phase boundary and defer the rest to post-event.

### Phase 0 — Final pre-break sync (before operator stops app) [2 min]
Confirm:
- Show is paused
- Operator is ready at DART
- SD card is inserted (if going to use it)
- All staged files present on DART (staging asar, scripts)

### Phase A0 — EXIF-vs-mtime sanity check [2 min, before app stop]
**Critical gate before any bucket work.** Pull EXIF DateTimeOriginal
from 30 random PHOTOIMPORT files and compare to file mtime.

```bash
# Install exifread or use PIL.Image via python already on DART
# Sample 30 files, print (name, mtime, EXIF_DateTimeOriginal, diff_seconds)
```

Expected outcomes:
- All diffs near zero → tether writes files live, mtime ≈ EXIF. The
  mtime-bucket was correct; #161-172 really are camera-off gaps (but
  user says camera was never off, contradicting — flag for review).
- Diffs vary / some large → tether was buffering and flushing. EXIF
  bucket will recover more photos than mtime bucket did. Need SD?
  Probably not, since user confirmed "no missing sequence numbers" =
  every file is in PHOTOIMPORT.
- EXIF has photos in #161-172 window with later mtimes → confirms
  buffering theory. No SD pull needed.

**Decision from this check**: does SD card insertion give us anything?
If PHOTOIMPORT EXIF covers all windows → skip SD entirely.

### Phase A — Snapshot current state (reads only) [3 min]
```bash
# Fresh state.json + job-queue + settings
scp dart:"C:/Users/User/AppData/Roaming/compsync-media/compsync-state.json" \
    /tmp/lunch-A-state-$(date +%s).json
scp dart:"C:/Users/User/AppData/Roaming/compsync-media/job-queue.json" \
    /tmp/lunch-A-jobqueue-$(date +%s).json
scp dart:"C:/Users/User/AppData/Roaming/compsync-media/compsync-media-settings.json" \
    /tmp/lunch-A-settings-$(date +%s).json
# main.log
scp dart:"C:/Users/User/AppData/Roaming/compsync-media/logs/main.log" \
    /tmp/lunch-A-main-$(date +%s).log
```
Decision point: any smoking gun in main.log? If so, adjust plan
(e.g., if watcher crashed with a specific error, address that first).

### Phase B — Operator stops CompSync Media.exe [2 min]
**Operator action, not mine.** Normal close via X button, NOT
taskkill (per memory rule). Confirm process gone:
```bash
ssh dart "tasklist | findstr /i compsync"
```
Should be empty.

### Phase C — Dry-run bucket script from PHOTOIMPORT [5 min]
Upload `/tmp/sd-bucket.py` to DART. Run dry-run:
```bash
ssh dart "python C:\\Users\\User\\sd-bucket.py \
  --source C:\\Users\\User\\OneDrive\\Desktop\\PHOTOIMPORT \
  --windows C:\\Users\\User\\session2-windows.json \
  --dest-root \"C:\\Users\\User\\OneDrive\\Desktop\\TesterOutput\\UDC London 2026\" \
  --dry-run --report /tmp/bucket-dryrun.json"
scp dart:/tmp/bucket-dryrun.json /tmp/
```

Review report. Expected output:
- #148-160 gain ~100-200 photos each
- #161-172 gain 0 (camera was off)
- #173-175 gain 0 (already sorted)
- #176-182 gain ~80-140 each
- Orphans ~330

If numbers look sensible: proceed to Phase D.
If numbers look wildly off (e.g., half of PHOTOIMPORT is orphans):
STOP and diagnose before copying.

### Phase D — Real bucket copy [5 min]
Remove `--dry-run`:
```bash
ssh dart "python C:\\Users\\User\\sd-bucket.py \
  --source ... --windows ... --dest-root ... \
  --report C:\\Users\\User\\lunch-bucket-real.json"
```
Verify per-routine disk counts match expectation:
```bash
ssh dart 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\User\count-jpgs.ps1'
```

### Phase E — Unmatched reconciliation [3 min] (REVISED — no orphan dump)
**Per operator: every photo is a dancer photo, no test shots.** So
orphans don't exist — every unmatched photo belongs in SOME routine.

For any photo the bucket script couldn't match to a recording window:
1. Check if its EXIF timestamp falls in a break / between-routine gap.
   If so, assign to the nearest neighboring routine (by time delta)
   with a configurable threshold (e.g. within 3 min either side).
2. If EXIF is totally outside all windows (e.g. pre-show test or
   post-show): flag explicitly in the report. Operator decides.
3. No photos dropped; no files moved to an orphan dir.

The bucket script should have a `--tightest-neighbor-within SECS`
option. Set to 180 (3 min) for the real pass.

### Phase F — SD card validation pass (optional — safety check) [5 min]
Since user has SD card available, cross-check:
```bash
# Mount SD (operator sees drive letter — say E:)
ssh dart "dir /b E:\\DCIM\\*\\*.JPG | find /c /v \"\"" 
# Compare count to PHOTOIMPORT: should match (no missing transfers)
ssh dart "dir /b /s \"C:\\Users\\User\\OneDrive\\Desktop\\PHOTOIMPORT\\*.JPG\" | find /c /v \"\""
```
If SD has more than PHOTOIMPORT: there ARE missing transfers. Would
need an SD-vs-PHOTOIMPORT diff + copy-over. If counts match
(as expected): SD card provides no new data. Eject and move on.

### Phase G0 — .bak cleanup (big disk relief) [2 min]
state.json has accumulated hundreds of `.bak-NNNNNNNNNN` files in
`AppData\Roaming\compsync-media\`. Also jobQueue .bak files. These slow
every directory enumeration in that folder and contribute to NEXT lag.

```bash
ssh dart 'powershell -NoProfile -Command "Get-ChildItem C:\Users\User\AppData\Roaming\compsync-media\compsync-state.json.bak-* | Sort-Object LastWriteTime | Select-Object -SkipLast 5 | Remove-Item -Force"'
ssh dart 'powershell -NoProfile -Command "Get-ChildItem C:\Users\User\AppData\Roaming\compsync-media\job-queue.json.bak-* | Sort-Object LastWriteTime | Select-Object -SkipLast 5 | Remove-Item -Force"'
```
Keep newest 5 of each as safety. Count before/after; expect to go from
hundreds to 5.

### Phase G — Clean jobQueue [3 min]
```bash
ssh dart "python C:\\Users\\User\\clean-jobqueue.py \
  --queue C:\\Users\\User\\AppData\\Roaming\\compsync-media\\job-queue.json \
  --backup C:\\Users\\User\\AppData\\Roaming\\compsync-media\\job-queue.json.bak-lunch \
  --mode nuke"
```
**Recommend nuke** during break since app is stopped — simplest, no
ambiguity. Any in-flight jobs are moot (will be re-enqueued on upload
retrigger).

### Phase H — Redeploy asar with video_start/end_timestamp [5 min]

**CRITICAL — do not repeat the earlier failed build.** Prior attempt today
shipped a ~1 MB asar (only `out/`, no `node_modules`) and the app wouldn't
start. Rolled back to `app.asar.bak-20260417-145002` (= current live, md5
`7fc579b9`). Same failure mode would brick DART mid-lunch with no time to
recover.

**Safety sub-checklist (every box MUST tick before asar copy to live):**

Pre-flight (on Linux build host, BEFORE anything touches DART):
- [ ] Asar file size > 50 MB (correct build = ~80-200 MB)
  - `ls -la /tmp/app.asar.staging-<ts>`
  - If < 10 MB → BAD BUILD, do not deploy, investigate build process
- [ ] `asar list /tmp/app.asar.staging-<ts> | head -20` shows `node_modules/` entries
- [ ] `asar list /tmp/app.asar.staging-<ts> | grep -c "node_modules/"` returns >1000
- [ ] `asar list /tmp/app.asar.staging-<ts> | grep -E "(out/|dist/)" | wc -l` returns >10
  (renderer bundle present)
- [ ] `asar extract` to a tmp dir + `node -e "require('./<tmp>/package.json')"` succeeds
- [ ] Confirmed commit/diff includes `video_start_timestamp` +
  `video_end_timestamp` in plugin/complete payload (grep the extracted asar
  for those strings)

Transfer to DART staging:
- [ ] `scp /tmp/app.asar.staging-<ts> dart:C:/Users/User/app-asar-staging/app.asar-<ts>`
- [ ] Post-scp size check on DART: `ssh dart "dir C:\\Users\\User\\app-asar-staging\\app.asar-<ts>"`
  — size must match local
- [ ] Confirmed live asar has been backed up: copy current live to
  `app.asar.bak-lunch-<ts>`

Copy to live (only after all above ticked):
```bash
ssh dart "copy \"C:\\Program Files\\CompSync Media\\resources\\app.asar\" \
                \"C:\\Program Files\\CompSync Media\\resources\\app.asar.bak-lunch-<ts>\""
ssh dart "copy C:\\Users\\User\\app-asar-staging\\app.asar-<ts> \
               \"C:\\Program Files\\CompSync Media\\resources\\app.asar\""
ssh dart "dir \"C:\\Program Files\\CompSync Media\\resources\\app.asar\""
```

Rollback path (if app fails to launch after operator starts it):
```bash
# ≤30 second rollback to known-good
ssh dart "copy /y \"C:\\Program Files\\CompSync Media\\resources\\app.asar.bak-lunch-<ts>\" \
                    \"C:\\Program Files\\CompSync Media\\resources\\app.asar\""
# Fallback further back if needed:
# app.asar.bak-20260417-145002 (= today's working recording-text build)
# app.asar.bak-pre-recording-text-20260417-104709 (= pre-my-changes original)
```

Record in lunch-debrief.md:
- New asar file size + timestamp
- Source git commit / branch
- asar list summary (top-level entries)

**Skip Phase H entirely if any pre-flight check fails.** Defer asar fix
to post-event; lunch still benefits from jobQueue + photo-sort fixes.

### Phase I — Reset state.json photos arrays for newly-sorted routines [3 min]
App on restart will rescan disk (per C2.6 fix if deployed, or via
walk). For safety, pre-seed state.json with empty `photos: []` for
routines #148-182 so the app doesn't trust stale data:
```python
# /tmp/reset-photos-arrays.py: load state.json, set photos=[] on
# routines in range 148-300, write back. Backup first.
```
OR (simpler): leave state.json alone; trust app to reconcile on
startup. If in doubt, do this one.

### Phase J — Operator starts CompSync Media.exe (AS ADMIN) [2 min]
Per memory: must run as admin for touch/SendInput to work. Verify in
app that recording time + OBS connection come up normally. Check the
routine table — newly-sorted routines should show expected photo
counts.

### Phase K — Upload All [10 min, runs in parallel with verification]
In-app: Click "Upload All" for the outstanding range. Monitor:
```bash
# Poll upload progress via DB
# Every 30s: count media_photos rows per package, compare to disk
```

Routines to upload:
- #101, #102, #110, #111 (partials — may re-upload or top off)
- #114-147 (never uploaded before — entire range)
- #148-160, #173-182 (newly-sorted from PHOTOIMPORT)

Expected total: ~15,000+ JPGs to upload. At 2-3 MB each over the
venue wifi, could take 30+ min at peak. This may NOT fully finish
within lunch.

### Phase L — DB reconciliation [5 min, in parallel with uploads]
As uploads complete for each routine:
```sql
-- Recompute photo_count from COUNT(*)
-- Flip status to 'complete' for routines where DB == disk
```
Same pattern as Batch 3. For routines that don't finish uploading
by end of lunch: leave as pending; will finish naturally during
afternoon session.

### Phase M — Final verification [3 min]
Full table: per routine (#100-current): disk count, PHOTOIMPORT
matched count, DB count, status. All three should match or be
within tolerance. Document any mismatches.

### Phase N — Final smoke test [2 min]
Operator triggers one short test recording (a dummy clip) to verify
ALL issues are fixed:

**Must pass (blocking show resume):**
- [ ] OBS records, encoding works
- [ ] Photos arrive in PHOTOIMPORT AND get sorted into routine folder
      within <5s (Issue X3 — matcher fixed)
- [ ] plugin/complete payload contains video_start/end_timestamp
- [ ] No errors in main.log during the test run

**Performance checks (Issue X1 — NEXT speed):**
- [ ] Operator does 3 consecutive NEXT presses on dummy routines
- [ ] Each NEXT completes in <2 seconds
- [ ] state.json file size after test: <2 MB (was 4.1 MB before lunch)
- [ ] job-queue.json size: <100 KB (was 8.2 MB before lunch)

**Overlay checks (Issue X2 — lower third):**
- [ ] Start recording on a test routine
- [ ] Lower-third shows CORRECT routine name/info within 500ms
- [ ] Press NEXT; next routine's lower-third shows within 500ms of
      start-record event
- [ ] No "Retry still no match vs N windows" spam in main.log during
      the test (the retry loop that was poisoning overlay should be
      gone after jobQueue nuke)

If any Must-Pass fails: rollback asar, investigate before show resume.
If Performance or Overlay fails but Must-Pass green: show can resume
with a deferred fix docs in lunch-debrief.md.

---

## 3 — Decision points (resolve in the first 5 min of lunch)

1. **SD card usage?** — proposal: resolved by Phase A0 EXIF check.
   If EXIF shows all shot times covered in PHOTOIMPORT, skip SD.
   If EXIF-bucket still leaves gaps in #161-172 → SD pull required.
2. **jobQueue: surgical or nuke?** — proposal: **nuke** (simplest
   during paused app; 8.2 MB of stale entries).
3. **Tightest-neighbor threshold for between-window photos?** —
   proposal: 180 seconds.
4. **Asar redeploy: do now or defer?** — proposal: do now; this is
   the only window we get. If build isn't ready pre-break, skip
   Phase H entirely and defer.
5. **Matcher restart alone, or code fix?** — depends on main.log.
   If restart fixes it, no code change needed. If not, need branch
   deploy.
6. **Overlay bug (X2) persists after restart?** — proposal: defer to
   post-event code review if smoke test shows it's still broken but
   Must-Pass is green. Don't hold up show resume for a lower-third
   display race.

---

## 4 — Rollback paths

If anything goes catastrophically wrong:
- **Asar broken**: rename live app.asar → app.asar.broken;
  copy `.bak-lunch-<ts>` → app.asar. Operator restarts.
- **state.json corrupted**: restore from `.bak-<ts>` (we took one).
- **jobQueue needs entries back**: restore from `.bak-<ts>`.
- **Bucket script miscopied**: don't delete originals from
  PHOTOIMPORT; sorted files in routine dirs are copies. Can delete
  routine photos/ subdirs for affected routines and re-run.
- **Uploads duplicating**: plugin/complete double-count trigger
  (C3.5) is now known; recompute photo_count post-upload fixes it.

---

## 5 — Success criteria (what "done" looks like)

After lunch, all of these must be true:
- [ ] Every routine #100-(current-1) has photos on disk equal to
      (PHOTOIMPORT matched for its window — 0 for #161-172)
- [ ] Every routine with disk photos has a media_package row in DB
- [ ] DB photo_count per package == disk count (±0) for all
      full-coverage routines
- [ ] #161-172 DB rows exist but empty (status='empty' or
      'no_photos' — TBD how to represent)
- [ ] Test recording post-restart: matcher fires, photos land in
      correct routine folder
- [ ] plugin/complete payload includes video timestamps (verify in
      main.log for test recording)
- [ ] jobQueue has ≤ small number of entries (no stale from pre-lunch)
- [ ] App running on new asar (size > 50 MB, date = today)

---

## 5.5 — DART Lumix tether autoclose (UNDIAGNOSED — investigate during lunch)

**Incident:** Lumix tether app on **DART** (NOT Asteroid) keeps closing itself
unexpectedly. Latest observed event was around routine #192. Happens repeatedly
throughout the day and likely explains the photo gaps for #148-160, #161-172,
#176-180, and #192-era.

**NOT the cause (ruled out):** Earlier an Asteroid event-log check surfaced
Modern Standby cycling at 11:11 AM, but Asteroid is the wrong machine for this
bug — disregard. DART is writing state.json every ~120 ms per the live-show
diagnostics (NEXT-slowness finding), so DART is not going to sleep. Something
else is terminating the Lumix process.

**Candidates to check during lunch (on DART):**
- `Get-WinEvent` Application log filtered by provider `Application Error` /
  `Windows Error Reporting` around times the operator reports close events
- `Get-WinEvent` Security log (4689 = process exit, correlated with PID)
- Windows Defender exclusion list — is Lumix path whitelisted? Check
  quarantine history.
- Scheduled tasks that might kill non-whitelisted processes
- OOM / handle exhaustion — `Get-Process` memory pressure at time of close
- Third-party AV / endpoint protection
- Group Policy software restriction
- Lumix-internal crash (check Lumix's own log directory if it has one)

**Mitigation options (once diagnosed):**
- Add Defender + AV exclusions for Lumix install path
- Add scheduled task or watchdog script that relaunches Lumix if missing
- If internal crash: update Lumix or switch to a different tether product

**Cannot apply fix without diagnosis. Defer investigation to lunch break;
operator to manually relaunch Lumix each time it closes until then.**

---

## 6 — Out of scope for this window / deferred to post-event

- R2 orphan cleanup (harmless clutter)
- Video timestamp backfill for routines already uploaded pre-fix
- CompPortal `deleted_at` clear on plugin/complete (CompPortal-side PR)
- Class 3 full audit (what's in dir but not in R2) — requires
  post-event deep sort
- Class 3 re-upload for routines we don't touch in lunch
- Prevention log items for all 8 categories (Category 1-8 fixes)
- Camera clock drift story — now moot if tether was working the
  whole time (the matcher was the real failure)
- Partial reconciliation of #101 (-1), #102 (+1), #110 (-4) if
  they still don't clean up after bucket + re-upload

---

## 7 — Checklist: files/scripts to have ready BEFORE lunch

| Item | Location | Status |
|---|---|---|
| sd-bucket.py | `/tmp/sd-bucket.py` + staged on DART | ⏳ to build |
| clean-jobqueue.py | `/tmp/clean-jobqueue.py` + staged on DART | ⏳ to build |
| session2-windows.json | `/tmp/session2-windows.json` | ✅ written (may refresh right before lunch) |
| count-jpgs.ps1 | DART `C:\Users\User\` | ⏳ to build |
| reset-photos-arrays.py | `/tmp/reset-photos-arrays.py` | ⏳ optional, build if we use it |
| Rebuilt asar | `/tmp/app.asar.staging-<ts>` + DART staging dir | ⏳ to build |
| DB current-state snapshot query | N/A — saved in this doc | ✅ |
| /tmp/dart-state-lunch-prep.json (current state) | `/tmp/` | ✅ have a copy |
| /tmp/photoimport-mtimes.txt | `/tmp/` | ✅ have a copy |

---

## 8 — Communication plan with operator during the break

I will report at each phase boundary:
- Phase complete / partial / failed
- Any surprises (e.g., orphan count > expected)
- Ask before proceeding past any CAUTION point (asar swap, jobQueue
  nuke)

Operator decisions during break:
- Stop/start app (Phases B, J)
- Confirm orphan policy if ambiguous
- Approve asar redeploy
- Authorize Upload All trigger

---

---

## APPENDIX A — Full-morning log analysis (red flags to watch for)

Source: `main.log` + `main.old.log` covering 2026-04-17 08:05:36 - 12:54:05.
168,956 log lines parsed.

### A.1 App restart timeline
App was restarted THREE times today — operator may not have noticed all:
- **08:38:41** — version 2.7.0 starts, begins watching PHOTOIMPORT
- **09:29:32** — version 2.7.0 starts again (unexplained — crash? manual?)
- **10:53:44** — version 2.7.0 starts (this is the "asar-swap-and-restart" around the morning break)

Each restart means state.json reloaded fresh — any in-flight uploads/matches lost.
Confirm with operator whether 09:29 was a deliberate restart or app died.

### A.2 Filesystem lock crisis
**10:09:07 - 10:09:10: 11 consecutive `EPERM: operation not permitted, rename`** on state.json.tmp → state.json. Something held the target file open for ~2 seconds (strong candidate: OneDrive sync kicking in, or Defender AV scan, or an open text-editor handle).

**11:16:59: 1 jobQueue save EPERM** — same pattern.

**3 "OneDrive sync folder" warnings** during the day — app knows this is risky (recording output goes into `C:\Users\User\OneDrive\Desktop\TesterOutput\...`) but doesn't enforce anything.

**Mitigation for future shows:** move `TesterOutput` out of OneDrive-synced folder. For lunch: don't touch OneDrive settings (risky during show). Just be aware: if we see EPERM during lunch operations, retry after 1s.

### A.3 FFmpeg crash
**09:16:23 — one routine's encoding failed** with `FFmpeg exited with code 4294967295` (= signed -1 = killed / ran out of something). Routine UUID `0aa0823d-b4f5-4b0c-953c-99f90cdad6a2`. Translate to entry_number during lunch and verify that routine's mkv/mp4 survived.

### A.4 Tether retry noise (stat confirmed)
- **Successful photo matches: 10,833**
- **"Retry still no match vs N windows" attempts: 18,093**

The retry loop is spamming the system with ~2 retries per successful match. These are the pre-lunch unmatched photos (old P-series from #161-172 buffered) being retried forever. Expected fix: jobQueue nuke + re-bucket.

### A.5 Upload errors
- **234 "File not found" errors for photo_258.JPG through photo_NNN in routine #113** — these are the stale jobQueue entries we already know about (#113 post-reset). Every ~35 seconds, same 82 files retry.
- **24 similar failures for photo_185.JPG in routine #115** — same pattern, smaller.
- **3 "File not found" failures for photo_140.JPG in routine #111**.
- **4 "This operation was aborted" failures** around 08:52 — early-morning network glitches, self-resolved.
- **1 "fetch failed" at 12:28** — single network glitch, self-resolved.

### A.6 Plugin/complete
- **17 successful plugin/complete calls**
- **1 failure** at 08:43 (aborted) — routine UUID `06220d56-...` — also triggered **12 "Skipping orphaned completion: no uploadRunId"** warnings later. Orphan-completion path is handling abort correctly but noisy.

### A.7 Post-break observations (10:57-10:58 start of session 2)
- 10:57:58 operator jumped to routine #148 (manual routine-jump via IPC)
- 10:58:00 OBS recording started
- 10:58:00 app logged "Overlay: routine data updated → #148 VOILA"
- So overlay data WAS correct at the moment of the jump.
- BUT: the retry-spam for older unmatched photos was already firing, and this is when state.json write pressure compounds.

### A.8 "No new photos during active recording" alert (requested)
**Status:** already documented as **C1.4 "Tether-idle alert + watch-folder staleness detection"** in `2026-04-17-prevention-log.md`.
**What to add during lunch prep:** verify C1.4 details are still correct post-today's incident, and promote to top-priority for next dev cycle since today's matcher break would have been caught within 30s if this alert existed.

### A.9 Warnings summary
- **12x** `Skipping orphaned completion — no uploadRunId` (post-08:43 plugin/complete abort)
- **21x** `postNowPlaying failed: operation aborted` (early morning, recovered)
- **3x** OneDrive sync folder warning
- **2x** FFmpeg cancelled

### A.10 What's NOT in the log (suspicious absences)
- **No `chokidar` ready / error events** — meaning the watcher either hasn't logged them, or is silently hung. The matcher-breaking for session 2 likely traces to chokidar. Need debug-level logging on chokidar during lunch to catch it.
- **No explicit "Tether: Stopped" event** before the suspected tether-off window — so the app never "knew" tether went down (or it went down silently from app's perspective).
- **No memory-pressure warnings** — but process is at 1.8 GB. Electron won't warn until truly high.

### A.11 Red flags to watch during lunch
1. If state.json save fails during bucket-script copy: retry. Don't let EPERM silently poison the fix.
2. If jobQueue nuke triggers an EPERM: stop app first (should already be stopped).
3. If asar copy fails: confirm app is fully killed (per memory: close normally, not taskkill).
4. If post-restart test recording shows "Retry still no match" again: matcher has a deeper bug — deploy C2.6 (rescanPhotos walk on startWatching) if not already shipped.
5. If FFmpeg crash recurs on a routine: it may be a bad source file — skip and continue.

---

## Notes / opens

- **Why did the matcher stop?** Unknown until main.log is reviewed.
  May be chokidar silently dying, may be a state-write race, may be
  the post-reset walker never re-starting. Worth fixing root cause
  before show resumes.
- **#148-160 matched but not sorted suggests matcher was UP for
  #100-147, DOWN for #148+, UP briefly for #173-175.** A chokidar
  crash + partial recovery is consistent with this pattern.
- **Why did the DB UPDATE trigger not fire in Batch 2?** Trigger is
  INSERT/DELETE only, not UPDATE — that's by design. No bug there.
- **If the new asar fixes recording timestamps BUT also needs
  CompPortal-side acceptance**: the payload will include the fields,
  but CompPortal might 400/ignore them until it accepts. Verify
  CompPortal is tolerant of unknown fields (usually is).
