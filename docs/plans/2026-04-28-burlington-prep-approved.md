# Burlington-prep autonomous block — locked spec
Date: 2026-04-28 EDT (decisions taken in evening session 11:00–22:30 EDT)
Status: ALL DECISIONS LOCKED — fresh session reads this doc and executes
Branch: stay on `feat/sd-import-overnight`
Test share code: `TEST2026` (Test Competition Spring 2026)

---

# Operating contract for the autonomous block

**Branch:** `feat/sd-import-overnight` (no new branch).

**Commit cadence:** per-item commit. Push after each item passes its smoke test. On smoke-test FAILURE: halt the block, write `docs/plans/2026-04-28-autonomous-failure-<item>.md` describing what broke, leave the failure in place locally without pushing it, do NOT proceed to the next item.

**Smoke test cadence:** after each item lands, run `npm run dev` (or appropriate dev command — verify in `package.json`), connect to share code `TEST2026`, exercise the changed surface, watch for crashes/console errors. If clean → commit + push. If not → halt + failure doc.

**Logs:** DART machine_logs are in Supabase project COMPSYNC, table `machine_logs` (cols: `ts`, `level`, `source`, `message`). Query when investigating runtime behavior — never SSH for logs.

**Don't:** kill any user-facing process, modify shared infrastructure, post to external services, force-push, or skip pre-commit hooks.

---

# Order of work tonight (small → large, dependency-aware)

1. ✓ **A52** — DONE in chat (verified type-check clean, no commit yet)
2. ✓ **A57** — DONE in chat (verified type-check clean, no commit yet)
3. **A19** chat pin styling — operator says already done; verify and mark SHIPPED if so
4. **A37** close-out checklist — operator says already done; verify
5. **A38** auto-skip scratched on NEXT — operator says already done; verify
6. **A40** dual counter regression — operator says already done; verify
7. **A47** audio silent banner re-record button — Stream Deck variant done; "no re-record button" rule already in A53/A55 design
8. **A51** METER-DIAG renderer console errors — clean up
9. **A41** NEXT button DISABLED when next event is awards block (not relabeled)
10. **A44** SD-swap heads-up row debug + fix (existing impl at `RoutineTable.tsx:412` not firing — investigate session inference)
11. **A1** SD pre-check fix (`driveMonitor.ts:93 collectJpegSamples`) — option (b)+(d) — mtime sample via `enumerateSdSamples`, remove 600-file cap
12. **A15 / Northstar UX** — explicit `copying` / `queueing` / `done` stages in import pipeline; pill flips to "Safe to remove" only after copy + queue both finish; distinct toast for "no new photos in folder — N already imported" vs "imported N matched"
13. **A35 CSE-side** — scratch-notify job in jobQueue, exempt from `clearAll()`; bulk-sync on share-code-resolve; CompPortal side flagged as separate session
14. **A53** cross-channel audio hash compare post-encode (SHA-256 of audio streams in 4 MP4s — perf + 3 judges); identical match → dismissable banner
15. **A55** per-routine audio verification — silence + loudness checks, all configurable in Settings; per-check toggles default true
16. **A56** narrow slice — header chip + photo-import + recording + upload stages with operator thresholds; in-app banner only (reuse existing alert banner pattern)
17. **Take-immutable refactor + A54** — full scope: data model + finalize-binding + click-to-reassign + empty-routine flow + 999-decrement (saved last; biggest)

---

# Locked decisions per item

## A52 — Zero delay on NEXT (DONE)

- **DELETE** `pauseAfterStopMs` from `nextSequence` type entirely
- **DELETE** `pauseBeforeRecordMs` from `nextSequence` type entirely
- **DELETE** their UI fields in `Settings.tsx`
- **DELETE** their `await sleep()` calls in `recording.ts:nextFull`
- **KEEP** `pauseBeforeLowerThirdMs` configurable (lower-third visual transition only)
- These two settings can never be non-zero again. Hardcoded behavior.

Operator verbatim: *"any sort of delay in between the recordings breaks it"* (2026-04-28 21:06 EDT).

## A57 — Thumbnail/keyframe columns (DONE)

- Two new columns added to `RoutineTable.tsx`: `THUMB` and `KEY`
- Binary ✓/✗ icon (matches existing pipeline column pattern)
- ✓ when all photos have `thumbnailStoragePath` (THUMB) / when `keyframes.length === 3` (KEY)
- ✗ when partial / missing
- — when not yet applicable (no photos / not yet recorded)
- Hidden in compactMode like the other pipeline columns

## A19 — Chat pin styling (operator says done)

Verify the pin is purple (brand) not yellow. If still yellow, fix.

## A37 — Close-out checklist (operator says done)

Verify functioning. Mark SHIPPED.

## A38 — Auto-skip scratched on NEXT (operator says done)

Verify functioning. Mark SHIPPED.

## A40 — Dual counter regression (operator says done)

Verify functioning. Mark SHIPPED.

## A47 — Audio silent banner (closed)

That was Stream Deck-related and shipped. The "no re-record button" rule on the audio-silent banner is already locked into A53/A55 design. No work.

## A51 — METER-DIAG console errors

Investigate the source of the spam (likely renderer-side console.error from the audio meter diagnostic). Silence or fix the underlying error. No log lines should appear in DevTools console for normal app boot + recording flow.

## A41 — NEXT button disabled when next event is awards block

Operator: *"Next button should be DISABLED if an awards block is the next event instead of another routine"* (2026-04-28 22:00 EDT).

- Detect "next event is awards block" via existing session-divider inference (15-min idle gap threshold) OR a new "awards block" marker if added to schedule data
- If detection ambiguous during implementation, surface as follow-up question in the failure doc — don't guess
- When awards block is next → NEXT button disabled with a tooltip explaining

## A44 — SD-swap heads-up row debug

Existing impl at `RoutineTable.tsx:412` and `table.css:317` ("just before the halfway point of a session"). Operator says "it was done but didn't work."

- Debug the trigger condition
- Likely cause: session-detection inference is off, so halfway point can't be computed — verify
- If session inference is the cause, ship a fix that either uses explicit session boundaries (when CompPortal supplies them) OR a more robust gap inference

Operator verbatim: *"around a just before halfway nto a session we need the operators to swap SD cards, they keep forgetting"* (2026-04-25 23:21 EDT).

## A1 — SD pre-check fix (`driveMonitor.ts`)

**Bug confirmed via Sunday 2026-04-26 machine_logs:**
- 10:35 EDT: F:\ detected → auto-import skipped (`<2/3 samples are today`)
- 12:18 EDT: F:\ detected → auto-import skipped
- 14:01 EDT: F:\ detected → auto-import skipped

Three SD insertions in 3.5 hours, all rejected by the same pre-check. Result: ~9:30 EDT–14:00 EDT dead window with no photos imported during a live event.

**Root cause** (`driveMonitor.ts:93 collectJpegSamples`):
1. BFS over SD reads subfolders in alphabetical-ish order (FIFO via `shift()`)
2. Older subfolders (`100EOSR6`, `101EOSR6`) processed first
3. Hits the `max * 200 = 600` file cap inside older-day subfolders before reaching today's subfolder (`124NZ6_2`)
4. Sorts the 600-file pool by basename descending — picks 3 highest-named files within the *older-day* subset
5. EXIF check on those 3 finds 0 are from today
6. Pre-check fails → auto-import skipped

The "Panasonic: highest sequence = most recent" assumption only holds within a single subfolder.

**Fix — option (b) + (d):**

- Replace `collectJpegSamples` body. Reuse `enumerateSdSamples` (line 393) which already collects mtime per file
- Walk the SD, collect all JPEGs with `mtimeMs`
- Sort by `mtimeMs` descending
- Take top 3 → return paths
- Remove the 600-file cap entirely (full walk, ~2s on 10k-photo card, still fast)

The `enumerateSdSamples` function has its own 50000-file safety cap; that's fine.

After fix, the 3 sampled photos will be the 3 most-recent shutter actions on the SD by mtime, regardless of subfolder. EXIF date check on those 3 reliably indicates today vs prior days.

## A15 / Northstar UX — explicit pipeline stages

**Operator's NORTH STAR (verbatim, saved 2026-04-26 23:08 EDT):**
> Two human operators (CSE-app driver + photographer). Two SD cards rotating with a ~40% mid-session swap. When the CSE operator inserts a card: zero modals, zero confirmation, zero clicks. An unobtrusive top-left chip shows the app is matching/importing. When the card is truly done, a top-left "safe to remove" toast fires. Then the round-robin upload kicks off, latest-routine photos go to R2 + media_photos first so the slideshow refreshes. Repeat across every break. Never fall behind.

**Current gap:** The `IMPORT COMPLETE` signal fires when the match function returns, NOT when files are actually copied to disk + queued for upload. Operator pulling card at "Import Complete" risks losing files matched-but-not-yet-copied.

**Required stages (emit via `IPC_CHANNELS.PHOTOS_PROGRESS`):**

```
queued → scanning → reading-exif → matching → copying → queueing → done
```

Today only `queued`, `scanning`, `reading-exif`, `matching` are emitted. Add:

- `stage: 'copying'` — emit while files are being written to disk
- `stage: 'queueing'` — emit while files are being added to upload queue
- `stage: 'done'` + `canRemoveCard: true` — emit AFTER copy + queue both finish (NOT after upload completes; uploads can take minutes; operator should be able to swap card after copy + queue)

**Pill wording change** (`Header.tsx:476-486`):

- During `done` / `canRemoveCard`: "**Safe to remove**" (matches NORTH STAR verbatim, replaces "Import Complete — Remove SD Card")
- During `copying`: "Copying X/Y"
- During `queueing`: "Queueing X/Y"

**Distinct toast for zero-new-files case** (when pre-dedup leaves 0 files to scan):

- Today: pill says "Import Complete: 0 matched, 0 unmatched" — misleading, hides that files were dedup-skipped
- New: pill says "**No new photos in folder** — N already imported" so operator immediately knows where to look next
- Detection: `partitionedPaths.length === 0 && skippedByFilenameDedup > 0`

## A35 CSE-side — scratch sync to CompPortal

**Operator escalation 2026-04-27 12:23 EDT:** *"If a routine is SCRATCHED in elec app we want it to be marked SCRATCHED in media portal."*

**CSE-side scope:**
- New IPC and jobQueue work in `state.scratchRoutine()` and `state.unscratchRoutine()` to enqueue a `scratch-notify` job
- New job type `'scratch-notify'` in `jobQueue.ts`
- Job calls `POST /api/plugin/routine-status` with auth pattern from `upload.ts:1062` (Bearer token)
- Payload: `{ competitionId, entryId, status: 'scratched'|'unscratched', scratchedAt? }`
- **NO `scratched_reason` text field** — operator dropped 2026-04-28 11:00 EDT
- `jobQueue.clearAll()` MUST exempt `scratch-notify` jobs (so post-event queue clear doesn't wipe an unflushed scratch)
- Boot-time bulk-sync: on share-code-resolve, send a bulk `POST /api/plugin/routine-status-bulk` with current scratched routines (idempotent; backstop for missed notifications)

**CompPortal side is OUT OF SCOPE for this session.** Flag in commit message:
- DB migration: `competition_entries.scratched_at TIMESTAMPTZ NULL`
- New routes `/api/plugin/routine-status` and `/api/plugin/routine-status-bulk`
- Parent media portal hides "media pending", shows "Routine scratched" pill
- CD media admin shows greyed/badged scratched state
- No-flow banner excludes `scratched_at IS NOT NULL`
- Verify-Media audit excludes scratched routines
- Livestream view rolls forward when current routine scratched

## A53 — Cross-channel audio identity check

**Anchor:** *"alert fire if we can confirm that all of the audio is the exact same in the four channels as that is likely what happened on Friday"* (2026-04-28 20:22 EDT).

**Scope:**
- After post-encode mux completes (around `ffmpeg.ts:435-465` where `encodedFiles` is built), SHA-256 the audio stream of each output MP4 (perf + judge1 + judge2 + judge3)
- Hash extraction: `ffmpeg -i <file> -map 0:a -c:a copy -f hash -hash sha256 -` OR equivalent
- Compare all pairs. If ANY two hashes match → fire event
- New event `audio.identical_tracks_detected` with `{ routineId, matched_files: ['judge1.mp4','judge2.mp4'] }`
- New IPC channel `AUDIO_IDENTICAL_TRACKS_DETECTED: 'audio:identical-tracks-detected'` in `src/shared/types.ts`
- Renderer: dismissable banner only (NO re-record button — explicitly hallucinated and rejected). *"R203 — judge1 and judge2 audio is identical. Likely ASIO rebind. Verify."*
- No CompPortal-side push, no audio-verify queue (operator picked option (a) at decision 22:18 EDT)

**Pure silence collision is a feature** — both silent tracks producing identical hash IS a real failure mode worth flagging. Not a false positive.

## A55 — Per-routine 4-track audio verification (silence + loudness)

**A53 covers identity check.** A55 adds silence + loudness:

**Silence check:**
- `ffmpeg silencedetect=noise=<X>dB:d=<Y>` per encoded MP4 audio stream
- Default `noise=-50dB:d=10` (configurable in Settings)
- Track flagged if >50% of duration is silent
- New settings: `audioAudit.silenceCheckEnabled` (default true), `audioAudit.silenceNoiseFloorDb` (default -50), `audioAudit.silenceMinDurationSec` (default 10)

**Loudness check:**
- Compute mean RMS per track via ffmpeg `astats` filter (or `volumedetect`)
- Flag track if mean RMS below threshold
- New settings: `audioAudit.loudnessCheckEnabled` (default true), `audioAudit.loudnessFloorDb` (default -40)
- When triggered, banner names the failing source: *"R203 — J2 audio below -40 dBFS (mean -47 dBFS) — verify mic input."*

**Identity toggle:**
- New setting: `audioAudit.identityCheckEnabled` (default true) gates A53 too

**UI:**
- Pass: small dismissible toast at top — *"R203 audio scan ✓ — 4 tracks captured, all distinct, all audible"*. Auto-fades ~10s, click to dismiss.
- Fail: persistent banner with the specific failure (which track, which threshold, observed value). Doesn't auto-dismiss.

**Scheduling:**
- Run on every routine post-encode in the post-stop ffmpeg pipeline
- Total ~7s background CPU per routine during the inter-routine gap. Negligible during 30s+ gaps.

## A56 — Universal pipeline detector (narrow slice tonight)

**Tonight's slice:** header chip + photo-import + recording + upload stages.

**Header chip:**
- Persistent in app header
- Green / yellow / red dot
- Click → expand panel showing each stage's last activity timestamp + pending count
- "Kick all" button → JOB_QUEUE_KICK across all worker types

**Stages in this slice:**

| Stage | Tolerance | Trigger |
|---|---|---|
| Recording | Zero | Routine completes (per `state.updateRoutineStatus(id, 'recorded', ...)` expected event) without a video file → red immediately |
| Photo import | ~30 routine durations | No new `media_photos` rows in last 30 routine windows → yellow; 60 → red |
| Photo upload | 5/10 min | No jobQueue transitions in 5 min during active comp → yellow; 10 → red |
| Video upload | 5/10 min | Same shape |

**Encode + thumb + keyframe stages deferred** (not in tonight's slice).

**Alerts:** in-app banner only (reuse existing alert banner pattern). NO OS-level notifications (operator picked option (b) at decision 22:01 EDT).

**Encode threshold (for future): 10 min yellow / 14 min red** (operator picked option (b) at decision 21:37 EDT).

## Take-immutable refactor + A54 + empty-routine + 999-decrement

**Operator scope (option D from question 10):** full mechanical refactor + click-to-reassign + empty-routine flow + 999-decrement fallback. Runs past midnight; that's expected.

### Take-immutable data model

- New persistent take state: `<outputDir>/_active_take.json` with `{ takeId, startedAt, currentTargetRoutineId }`. Atomic writes.
- New Take interface in `src/shared/types.ts`
- Crash recovery: on app boot, if `_active_take.json` exists, surface "this take started at X — pick a slot or discard" rather than auto-binding.

### handleRecordingStarted change

- DO NOT call `state.updateRoutineStatus(routine.id, 'recording', { recordingStartedAt: timestamp })` (currently at `recording.ts:860-862`)
- Instead, write `_active_take.json` with `{ takeId, startedAt, currentTargetRoutineId: routine.id }`
- Set `activeRecordingRoutineId = routine.id` as today (runtime pointer)

### handleRecordingStopped change

- Read current `activeRecordingRoutineId` (which may have been changed via reassign)
- Write `recordingStartedAt` (from `_active_take.json`) + `recordingStoppedAt` (now) to whatever routine `activeRecordingRoutineId` points at
- Existing preserve-and-archive logic at `recording.ts:567-723` runs against that routine — works as today
- Delete `_active_take.json` after successful finalize

### Renderer "is recording?" sites

5–10 places that check `routine.recordingStartedAt` for "is this routine currently recording?" — switch to checking `activeRecordingRoutineId === routine.id`. Find via grep on `recordingStartedAt` and inspect each use.

### A54 click-to-reassign

- Renderer: routine row click during active recording → triggers a centered, NON-BLOCKING modal-styled popover *"Save recording as R355? ✓"*
- Recording continues uninterrupted
- Click ✓ → fires `RECORDING_REASSIGN_TARGET` IPC with new routineId
- Click outside / press Escape / new click on different row → dismiss with no action (cancel)
- Main process IPC handler: updates `activeRecordingRoutineId`, persists to `_active_take.json` (`currentTargetRoutineId`)
- Lower-third overlay + burned-in counter re-render at next tick (driven by `state.getCurrentRoutine()`)
- If the target slot already has a completed take → existing preserve-and-archive workflow kicks in at finalize (no special handling needed at reassign time)

### "Save as empty routine" button

- Existing button "START EMPTY ROUTINE" (top right beside RECORD)
- During active recording → label changes to **"SAVE AS EMPTY ROUTINE"**
- Click during recording → opens a centered, NON-BLOCKING number-input popover
- Number input pre-populated with placeholder `<currentRoutineNumber>.5` (e.g., currently on R226 → placeholder "226.5")
- Validation: accepts 3-digit numbers, optionally with `.5` suffix. Examples: `355`, `355.5`, `155.5`
- ✓ → fires `RECORDING_REASSIGN_TARGET` with the entered number; if no row matches that number, an extra-routine row gets created (`lateInsert: true`) at that number
- Click outside / Escape / no input → dismisses; on STOP, the take gets the auto-overflow number (see below)

### 999-decrement overflow counter

- New field `competition.nextOverflowNumber: number` in persisted state, default `999`
- Decrements per use (999, 998, 997, ...)
- Persists across app restarts within a competition
- Used when a take stops without an explicit slot assignment (operator never confirmed reassign or empty-routine)
- The take is saved as a NEW row with `entryNumber = nextOverflowNumber.toString()` and `lateInsert: true`
- `nextOverflowNumber` decrements by 1
- Pushed to CompPortal via existing `/api/plugin/complete` payload — `lateInsert: true` flag flows server-side; CompPortal's existing extras handling creates the row

### Recording never blocked

- The overall rule applies: NEVER block the start of a recording. The reassign / empty-routine popovers are non-blocking and dismissible. RECORD button is never gated on operator decision.
- Take is always saved somewhere — explicit slot, typed number, or auto-overflow.

---

# Smoke test plan per item

| After | Smoke test |
|---|---|
| A52 | Boot dev → load TEST2026 → verify NEXT advances without 4s pause |
| A57 | Boot → verify THUMB and KEY columns render with ✓/✗ on routines that have/don't have media |
| A19 | Boot → check chat pin styling is purple |
| A37/A38/A40 | Boot → spot-check each "operator says done" feature |
| A51 | Boot → DevTools console → verify no METER-DIAG spam |
| A41 | Boot → load schedule with awards block → verify NEXT button disabled before awards |
| A44 | Boot → load long session schedule → verify SD-swap row appears at halfway |
| A1 fix | Boot — no easy SD simulation; rely on type-check + log-trace; flag for next-event verification |
| Northstar UX | Boot → import a folder → verify pill goes Scanning → Matching → Copying → Queueing → Safe to remove |
| A35 | Boot → scratch a routine → verify `scratch-notify` job appears in queue admin |
| A53 / A55 | Hard to simulate without actual recording; rely on type-check + minimal unit-style invocation against a stored sample MP4 if one exists in repo |
| A56 chip | Boot → verify chip renders green when no stages stalled |
| Take-immutable refactor | Boot → start recording → verify state still tracks; click another row → verify reassignment confirmation appears + fires |

**On regression:** halt block, write `docs/plans/2026-04-28-autonomous-failure-<item>.md`, leave dev build running, do NOT commit/push the broken item.

---

# Items NOT in scope (deferred / dropped)

- **2.7 strict one-photo-one-routine DB index** — operator deferred 2026-04-28 10:43 EDT as "likely a non-issue from manual reimports."
- **`scratched_reason` text field** — dropped 2026-04-28 11:00 EDT.
- **`[Re-record]` button on audio-silent banner** — flagged hallucinated 2026-04-28 11:02 EDT.
- **Counter-nudge recovery_note text field** — dropped 2026-04-28 10:43 EDT (silent persistence only).
- **Backfill of existing R2 keyframes** — operator decided forward-only 2026-04-28 10:30 EDT.
- **Full R2 path hierarchy `comp/{compId}/routine/{N}/cam{C}/...`** — Claude-invented. Operator's anchor (INBOX R-4) only asks for filename rewrite.
- **A11 SCRATCH button replaced** — operator said "ignore" 2026-04-28 22:04 EDT.
- **A42 green checkmark on SD press** — operator and Claude both unsure what this is. Skip.
- **A56 encode + thumb + keyframe stages** — deferred from tonight's narrow slice.
- **CompPortal side of A35 scratch sync** — separate session.
- **OS-level notifications** — operator chose in-app banner only.
- **5-second undo on click-to-reassign** — replaced by the centered non-blocking confirmation popover (operator picked option D at 21:57 EDT).

---

# Hard rules (do not violate)

1. **NEVER block the start of a recording** — no modal/validation/required-field can gate "start recording."
2. **NEVER kill user-facing processes** — Electron, Chrome, ollama-runner, in-flight rclone, anything operator depends on.
3. **NEVER destructive DB ops** on CompSync Supabase. Additive/idempotent only.
4. **NEVER skip pre-commit hooks.** If hook fails, fix the underlying issue and create a NEW commit.
5. **NEVER force-push.**
6. **NEVER self-invoke /fresh, /wrap-up, or /compact.** The operator decides when to reset session.
7. **NEVER push to remote on a smoke-test failure.** Halt + failure doc.
8. **NEVER speculate about business logic** — only verifiable technical inferences.

---

# State at start of autonomous block

- Branch: `feat/sd-import-overnight`
- A52 + A57 edits made in chat session (NOT yet committed)
- Files touched in chat:
  - `src/shared/types.ts` (A52 — removed two pause settings + their defaults)
  - `src/main/services/recording.ts` (A52 — removed two sleep calls)
  - `src/renderer/components/Settings.tsx` (A52 — removed two UI fields)
  - `src/renderer/components/RoutineTable.tsx` (A57 — added two pipeline columns + thumb/keyframe stage logic)
- Type-check passed clean after both
- No commit yet — fresh session should commit A52 and A57 first as separate commits, run smoke test, push, then proceed to remaining items in order

---

# Why this doc exists

Operator and Claude went through ~30 decision questions in the 11:00–22:30 EDT window of 2026-04-28. Several decisions corrected earlier draft plans that were flagged as hallucinated. This doc is the durable record so a fresh session can execute autonomously without re-litigating any decision.
