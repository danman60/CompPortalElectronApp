# Semantic Test Framework — full app scenarios

**2026-04-29 EDT — autonomous test-fix-bug loop driver**

The harness exists at `scripts/test/harness.mjs` + `scripts/test/scenarios/`. This doc is the source-of-truth list of **what the app actually does** and how each behavior translates into one or more executable tests.

For each scenario we define:
- **Trigger** — what the operator does (or what the system does autonomously)
- **Expected state changes** — what should be true afterwards in `state.takes[]`, `state.routines`, watermarks, queue, files on disk
- **Expected events** — IPC + machine_logs + debugServer events
- **Failure modes** — where this can go wrong and what bugs we'd catch
- **Test surface** — which test endpoints + assertions exercise it

---

## A. Recording lifecycle

### A1. Sequential recording — N routines in order

**Trigger:** Operator presses RECORD on routine N → STOP → NEXT → RECORD on routine N+1 → STOP → ...

**Expected state:**
- After each RECORD: new Take row added; `currentRoutineId = routine N`; `state.routines[N].status = 'recording'`; `recordingStartedAt` set.
- After each STOP: Take.stoppedAt + mkvPath set; `state.routines[N].status = 'recorded'`; encoding queued (if autoEncode); upload queued post-encode (if autoUpload).
- After NEXT: `state.currentRoutineId` advances; lower-third syncs.

**Failure modes:**
- Recording started without lower-third fire → operator's overlay missing
- NEXT advance walks past intended routine (UDC Toronto R354 → R356 bug)
- Take.currentRoutineId mismatch between renderer + main
- Status not updating after recording stop

**Test surface:**
- POST /debug/test/recording/{start,stop} with explicit routineId
- GET /debug/snapshot — verify takes[] grows + routines[N].status transitions
- GET /debug/events — verify recording.archived event NOT fired (no archive on first recording)

### A2. Re-record over existing routine — post-stop modal

**Trigger:** Operator presses RECORD on routine N that already has `recordingStartedAt + recordingStoppedAt`. New take ≥ 30s.

**Expected state:**
- Pre-record modal fires (blocking) with reassuring wording.
- New Take row added; in-flight.
- On STOP: post-stop modal IPC fires. Three actions:
  - **Archive (default)**: prior MKV → `_archive/v{N}/`; prior take's archivedPath set; currentRoutineId stays = N. New take = canonical for N.
  - **Specify Routine M**: new take's currentRoutineId mutates to M; file moves to M's folder. Prior take stays for N.
  - **Save as Extra E**: new lateInsert row at entryNumber `{N.5}`; new take's currentRoutineId = new lateInsert row.

**Failure modes:**
- Modal doesn't fire at threshold ≥30s
- Modal fires for sub-30s takes (regression of 4.2)
- Prior take's window gets nuked instead of preserved
- File doesn't move on Specify Routine
- Encode + upload pipelines don't re-fire on retarget

**Test surface:**
- POST /debug/test/recording/start (routine N, prior take exists)
- POST /debug/test/recording/stop (durationSec=35) → snapshot.takes shows new in-flight
- POST /debug/test/dispatch-decision { proposalId, decision: { kind: 'archive' } } → verify state mutation

### A3. Sub-5s tap-stop — silent discard

**Trigger:** RECORD then STOP within 5 seconds.

**Expected state:**
- File moved to `${outputDir}/_discard/<ISO>_<dur>s_<basename>.mkv`
- Take row preserved (immutable startedAt) but: stoppedAt set, mkvPath=null, archivedPath=discard, currentRoutineId=null
- Routine reverts to prior status
- NO modal, NO encoding, NO upload

**Test surface:** scenario `03-sub5s-discard.mjs` ✅ (already passing)

### A4. Mid-record click-to-reassign (Item 17)

**Trigger:** Recording in flight on routine N. Operator clicks routine M → confirms reassign popover.

**Expected state:**
- Take's currentRoutineId mutates from N → M (via state.setTakeRoutine + take.patchActiveTake)
- N's status reverts to prior
- M's status set to 'recording'
- On STOP: take finalizes against M, not N

**Test surface:** POST /debug/test/set-take-routine + verify state transitions

---

## B. SD card photo flow

### B1. Card insertion — auto-import

**Trigger:** SD card mounted with new EXIF photos.

**Expected state:**
- driveMonitor poll detects → DRIVE_DETECTED event
- importPhotos fires with dedupByDb=true + offset gate
- Per-body watermark filter skips already-processed photos
- Per-photo today-filter (always-on) skips non-today photos
- Matcher binds remaining photos to take windows (Phase 2.8)
- Photos copied to routine folders, queued for upload
- Pill: Scanning → Matching → Copying → Queueing → Safe to remove

**Failure modes:**
- Auto-import doesn't fire (drive monitor stalled)
- Watermark inert for non-Lumix bodies (Phase 2.2 regression)
- Photos bind to wrong routine (matcher uses routine instead of take window)
- Pill says "Safe to remove" before copy completes

**Test surface:**
- POST /debug/test/import-photos { folderPath: "C:\test\synth-sd" }
- Pre-create synth-sd via scripts/test/synth-sd-card.mjs (operator-side prereq)
- GET /debug/snapshot — routines[].photoCount > 0; queue.byType.upload increases

### B2. Re-insertion — watermark dedup

**Trigger:** Same SD card re-inserted (or operator re-runs manual import on same folder).

**Expected:** Photos with EXIF time ≤ watermark are skipped silently. Pill: "Resuming from HH:MM (FILE) — N to scan".

**Failure modes:** Watermark gate misses (re-imports duplicates), pill says "Scanning" instead of "Resuming"

**Test surface:** scenario `05-watermark-tiebreaker.mjs` ✅

### B3. Multi-day card

**Trigger:** Card with photos from Day 1 + Day 2 + ... + Day N (today).

**Expected:** Only photos with EXIF date == today import. Prior-day photos silently skipped (per-photo date filter).

**Failure modes:** `<2/3 today` pre-check misfires (Phase 2.1 regression — already removed); date filter doesn't apply

**Test surface:** Pre-built synth-sd folder with mixed-date EXIF photos + verify only today's get imported

### B4. Wrong-day card

**Trigger:** Card whose dominant EXIF date ≠ today (e.g. someone's vacation photos).

**Expected:** date-guard dialog fires; per-photo filter still active even if operator picks Continue.

**Test surface:** synth-sd with all yesterday's dates + import

---

## C. Audio audit

### C1. Tier-1 broken stream

**Trigger:** Encoded MP4 with audio bitrate < 16kbps (input disconnected).

**Expected:** AUDIO_LOW_BITRATE_DETECTED IPC; banner in renderer.

**Test surface:** synth-mkv `--profile broken` + POST /debug/test/trigger-audio-audit

### C2. Tier-2 silence

**Trigger:** Encoded MP4 with >50% silent fraction (mic muted).

**Expected:** AUDIO_SILENCE_DETECTED IPC; banner.

**Test surface:** synth-mkv `--profile silent` + audit

### C3. Cross-channel hash match (A53)

**Trigger:** Two judge tracks with identical audio (cross-routing).

**Expected:** AUDIO_IDENTICAL_TRACKS_DETECTED; banner shows "judge1=judge2".

---

## D. Pipeline + drift

### D1. 60-min photo-import stall banner (Phase 1.1)

**Trigger:** No photo-import activity for 60+ min during active comp.

**Expected:** PHOTO_IMPORT_STALL IPC fires once; HardeningBanner shows. bumpActivity('photoImport') re-arms.

**Test surface:** Hard to test without time-travel. Skip for now or use jest fake timers approach.

### D2. Comp-state drift detection (Phase 1.4/1.6)

**Trigger:** External DB edit between app close + reopen (when feature flagged on).

**Expected:** Boot fingerprint mismatch → COMP_STATE_DRIFT_DETECTED → orange banner with Refresh / Skip.

**Test surface:** Mock CompPortal /api/plugin/comp-fingerprint endpoint + boot test.

---

## E. Crash recovery + persistence

### E1. Boot with stale _active_take.json

**Trigger:** App crashed mid-recording. _active_take.json exists at boot.

**Expected:** RECORDING_STALE_TAKE_DETECTED IPC; renderer surfaces recovery UI.

**Test surface:** Pre-write _active_take.json + relaunch app + verify event fires.

### E2. State migration — pre-2.8 routines without takes[]

**Trigger:** Boot with compsync-state.json that has routines with `recordingStartedAt + recordingStoppedAt` but no `takes` field.

**Expected:** "Phase 2.8 boot migration: synthesized N take(s)" log line; takes[] populated.

**Test surface:** Already verified in machine_logs ✅

---

## Test-fix-bug loop

For each scenario above:

1. **Translate to executable test** — in `scripts/test/scenarios/<name>.mjs`
2. **Run harness** — `node scripts/test/harness.mjs`
3. **For each FAIL:**
   - Read the assertion message
   - Investigate via `/debug/snapshot` + machine_logs
   - Determine: is it a scenario bug (whitelist + retry) or app bug?
   - If app bug: write fix, commit, rebuild, redeploy, rerun
4. **Loop until 100% green** OR architectural blocker hit
5. **Schedule wakeup every 30 min** to monitor test fleet overnight

---

## Coverage matrix (current vs goal)

| Scenario | Test exists? | Pass? | Notes |
|---|---|---|---|
| A1 sequential recording | YES (18) | ✅ | 5 takes on 5 routines, distinct |
| A2 re-record post-stop modal | YES (21) | ✅ | dispatchDecision IPC accepts 3 kinds |
| A3 sub-5s discard | YES (03) | ✅ |  |
| A4 mid-record reassign | YES (04, 11) | ✅ | snapshot fixes both bugs caught |
| B1 card insertion auto-import | YES (17, 34) | ✅ | real synth photos end-to-end |
| B2 re-insertion watermark dedup | YES (05, 35) | ✅ | gate logic + real-import rerun |
| B3 multi-day card | YES (40) | ✅ | only today imports, yesterday filtered |
| B4 wrong-day card | YES (41) | ✅ | all-yesterday silent skip |
| C1 audio Tier-1 bitrate | YES (39) | ✅ | end-to-end with synth-broken.mp4 |
| C2 audio Tier-2 silencedetect | covered by 39 | ✅ | fires alongside Tier-1 |
| C3 cross-channel hash A53 | YES (42) | ✅ | judge1=judge2 same-file → match |
| D1 60-min stall | NO | — | deferred (needs fake-timers) |
| D2 drift detection | NO | — | deferred (needs portal mock) |
| E1 stale take recovery | YES (stale-take-recovery.mjs) | ✅ | end-to-end across kill+relaunch |
| E2 boot migration | YES (logs) | ✅ | verified earlier in machine_logs |

**Result: 13/15 fully covered, 2/15 deferred for portal-side / fake-timers approach.**

## Final test fleet inventory (after autonomous loop)

- 42 in-process scenarios via `harness.mjs` (all green)
- 4 restart-loop persistence checks via `restart-loop.mjs`
- 2 stale-take recovery checks via `stale-take-recovery.mjs`
- Stability runner `stability.mjs` cycles harness + restart-loop together (164/164 over 2 cycles)
- 7 real bugs caught + fixed during the loop (`pickLongestMkv`, `schedule`, `dayChecklist`, `jobQueue.list`, before-by-ref, state leak, legacy-watermark same-second)
