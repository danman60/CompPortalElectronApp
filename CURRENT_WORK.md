# Current Work — CompSyncElectronApp

**Status: 2026-04-29 ~15:15 EDT (Wednesday). Burlington 2 days away. Decision-mode rapid build session.**

Branch: **`master`**.

---

## What's deployed live on DART RIGHT NOW

Last deploy at 13:31 EDT — asar `132,207,681` bytes — commit `e29a4e3`.

**Live changes:** F5 cursor · swap-SD halfway math · IMPORT BUSY gate · Kick→PIPE merge · NORTH STAR §3.1 (modal suppress) · §3.2 (watermark-aware chip copy) · Phase 1.1 (10/30/60 min photo-stall thresholds + banner) · Phase 1.3 (lying-success toast partial-failure surfacing).

Backups on DART: `bak.20260429-133123` (pre-e29a4e3), `bak.20260429-124744` (pre-d3e2c47), `bak.20260429-092651`, `bak.20260429-091847`, `bak.20260429-090937`, `bak.20260429-083148`.

---

## Committed but NOT YET deployed (queued for next deploy)

| Commit | What | Burlington-critical? |
|---|---|---|
| `d2a0e24` | Phase 1.4+1.6 drift sync (feature-flag OFF; needs CompPortal endpoint) | No — gated |
| `7d0cf88` | Phase 2.2 body-key regex generalize (Lumix+Nikon+Sony+Canon) + unknown-body banner | YES |
| `f08af32` | Phase 2.1+2.3+2.4+2.6 — watermark-driven import (replaces `<2/3 today` pre-check), filename-seq tiebreaker, manual import parity, exifTz.ts helper, Settings clear-watermarks rewording, includePriorDayPhotos toggle | YES |

**Building now** (background `bv8u1x4uf`) — bundles all 3 commits + everything from `e29a4e3`. Asar will be ~132MB, deploy when operator closes app.

CompPortal-side work pending — see `~/projects/CompPortal/INBOX.md` (added `/api/plugin/comp-fingerprint` endpoint spec for Phase 1.4/1.6).

---

## Decisions LOCKED (per operator, this session) — pending implementation

### Take architecture (Phase 2.8 + Phase 4 redesign §4.2)

**Data model:**
```
Take {
  takeId             uuid, immutable
  startedAt          ISO, immutable (set on OBS RecordingStarted)
  stoppedAt          ISO|null, immutable once set
  mkvPath            path; immutable once set
  archivedPath?      set when mkv moves to _archive/v{N}/
  currentRoutineId   string|null, MUTABLE (reassign / re-record / save-as-extra)
  emptyRoutineNumber? Item 17 SAVE AS EMPTY case
}
```

- New top-level `state.takes[]`, persisted in `compsync-state.json`
- Photos bind to take's window. Photo's routine = `take.currentRoutineId`. Take moves → photos follow.
- Item 17's `_active_take.json` collapses to "the take with `stoppedAt === null`"
- `Routine.recordingStartedAt/stoppedAt` becomes denormalized convenience field (= latest take's window for that routine)
- Boot migration: synthesize Take rows from existing `recordingStartedAt + recordingStoppedAt` fields
- **End-of-comp invariant:** every second of the comp covered by some take's window. Forensic queryable.

### Pre-record modal (already-recorded slot)

- **Stays blocking** — operator must click OK
- New wording: *"This routine already has a recording. Starting a new one keeps the old recording safe in an archive folder — nothing is overwritten or lost. Continue?"*
- Buttons: [Cancel] | [Re-record]

### Post-stop modal (replaces "Advance | Archive")

**Trigger:** new take ≥ **30 seconds** AND prior take existed in this slot. Sub-30s = silent archive (was 90s threshold).

**Three actions:**
1. **Archive** (default) — new take canonical for this routine. Prior MKV → `_archive/v{N}/`. Prior take's `(startedAt, stoppedAt, archivedPath)` PRESERVED in state.takes[]; `currentRoutineId` keeps pointing to this routine. Photos in BOTH windows still bind to this routine.
2. **Specify Routine** — dropdown of routines starting at the **routine the take was originally bound to**. New take's `currentRoutineId` → picked routine. Prior take stays in this routine.
3. **Save as Extra Routine** — text input default `{currentEntryNumber}.5`. Creates `lateInsert: true` row. New take's `currentRoutineId` → new lateInsert row.

**Mid-record reassign (Item 17, already shipped) uses same patterns** (Specify Routine / Save as Extra) for unified UX.

### Phase 2.8 — Photo matcher rewrite

`photos.ts:1405-1412` source of windows: switch from `routines.filter().map()` to `state.takes.filter(t => t.stoppedAt && t.currentRoutineId).map()`. Photos bind to `take.currentRoutineId`.

**On any path that mutates `currentRoutineId`:** encoding + upload pipelines re-fire for the new routine.

---

## Implementation order for next session

If picking this up fresh, the sequence is:

### Stage A — Data layer (~1.5 hrs)
1. Add `Take` type to `src/shared/types.ts` (after `ActiveTake` definition)
2. Add `takes: Take[]` to `PersistedState` interface in `src/main/services/state.ts`
3. Add module-level `let takes: Take[] = []` and getters/setters: `getTakes()`, `addTake()`, `updateTake(takeId, patch)`, `setTakeStopped(takeId, stoppedAt, mkvPath)`, `setTakeArchived(takeId, archivedPath)`, `setTakeRoutine(takeId, routineId)`
4. Persist takes alongside competition/cameraOffsets/sdWatermarks in saveState
5. Boot migration in `loadState`: for any routine with `recordingStartedAt + recordingStoppedAt` and no synthesized take yet, create a synthetic Take with auto-generated takeId, `currentRoutineId = routine.id`
6. **Type-check + commit checkpoint**

### Stage B — Recording lifecycle (~2 hrs)
1. `recording.ts:907-917` `handleRecordingStarted`: in addition to writing `_active_take.json`, also call `state.addTake({ takeId, startedAt, currentRoutineId: routine.id })`. Keep `_active_take.json` write for back-compat during transition.
2. `recording.ts:514+` `handleRecordingStopped`: when finalizing, call `state.setTakeStopped(takeId, timestamp, outputPath)`. After file move, call `state.setTakeArchived(takeId, finalPath)` if it ended up in `_archive/v{N}/` due to advance branch. Reassign before stop → already mutates currentRoutineId on the active take, but ensure state.takes record matches.
3. `state.ts:reassignActiveTake`: also call `state.setTakeRoutine(takeId, newRoutineId)`.
4. Re-record archive branch (`recording.ts:707`): mark archivedPath for prior take's record. KEEP `currentRoutineId` pointing to same routine (per operator: photos in old window still belong here).
5. **Type-check + commit checkpoint**

### Stage C — Pre-record modal rewording (~30 min)
1. `recording.ts:309-328` `confirmReRecordIfNeeded`: update message + detail + buttons to the new reassuring wording.
2. **Type-check + commit checkpoint**

### Stage D — Post-stop modal redesign (~3 hrs)
1. Threshold change at `recording.ts:649`: `NEW_DURATION_THRESHOLD_SEC = 30` (was 90).
2. `RerecDecision` type: change from `'advance' | 'archive'` to `'archive' | 'specify-routine' | 'save-as-extra'`.
3. Default decision in resolver timeout: `'archive'` (was `'archive'` already).
4. Renderer modal component: new design with dropdown (anchored at original routine) + text input.
5. Renderer dispatches one of 3 decisions back. Main process handles each:
   - `archive`: existing path
   - `specify-routine`: file move to picked routine, currentRoutineId mutate, encoding + upload re-fire for new routine
   - `save-as-extra`: create `lateInsert: true` row at typed entry number, file move, currentRoutineId mutate, encoding + upload re-fire
6. **Type-check + commit checkpoint**

### Stage E — Matcher rewrite (~2 hrs)
1. `photos.ts:1405-1412`: change source from `routines.filter().map()` to `state.getTakes().filter(t => t.stoppedAt && t.currentRoutineId).map(t => ({ routineId: t.currentRoutineId, ..., recordingStarted: new Date(t.startedAt), recordingStopped: new Date(t.stoppedAt) }))`.
2. Verify photo binding flows through correctly: matchedRoutineId on PhotoMatch points at the take's `currentRoutineId`.
3. Smoke against TEST2026 with synthetic re-record scenario.
4. **Final commit + build + deploy.**

---

## Files touched in this session you'll see git history on

- `src/main/services/photos.ts` — body-key regex, watermark seq, exifTz integration, dedupByDb default, copy-failure detail
- `src/main/services/state.ts` — SdWatermarkEntry seq, watermark gate
- `src/main/services/exifTz.ts` (NEW)
- `src/main/services/driveMonitor.ts` — `<2/3` removed, exifTz integration, kickPhotoImports
- `src/main/services/compStateSync.ts` (NEW) — Phase 1.4/1.6
- `src/main/services/pipelineHealth.ts` — 10/30/60 min thresholds + banner
- `src/main/index.ts` — checkOnBoot wiring
- `src/main/ipc.ts` — manual import parity, drift refresh/dismiss, kick all
- `src/preload/index.ts` — drift IPC bindings
- `src/shared/types.ts` — many new types/channels/settings
- `src/renderer/App.tsx` — drift banner, photo-stall banner, unknown-body banner, IMPORT BUSY gate
- `src/renderer/components/Settings.tsx` — clear-watermarks button, includePriorDayPhotos toggle
- `src/renderer/components/Header.tsx` — pill failure surfacing, Kick→PIPE merge, watermark resume copy
- `src/renderer/components/PipelineHealthChip.tsx` — Kick All Stages button
- `src/renderer/components/RoutineTable.tsx` — F5 cursor, swap-SD halfway math
- `src/renderer/components/DriveAlert.tsx` — failure detail propagation, watermark fields, modal suppression

---

## Hard rules carried forward

1. NEVER block start of recording (Phase 4.1 future cleanup; pre-record toast spec'd but not built)
2. NEVER kill user-facing processes; operator closes app for asar swaps
3. Asar swap is its own gated action — never bundle with other writes
4. PowerShell JSON writes must be no-BOM
5. NEVER self-invoke /fresh / /wrap-up / /compact unless operator explicitly says so (operator did say so this session for /fresh continuation)
6. NEVER push on smoke-test failure
7. NEVER add audible alerts (Audio/AudioContext/Notification etc) — visual signals only
8. `git add <specific files>`, never `-A` (290+ untracked test artifacts must not be committed)

---

## Diagnostics on DART

- machine_logs: Supabase project COMPSYNC, table `machine_logs` (cols `ts`, `level`, `source`, `message`)
- Debug HTTP server: `http://127.0.0.1:8765/debug` on DART, accessible via SSH-PowerShell `Invoke-WebRequest`
- Routes: `/debug/state`, `/debug/queue`, `/debug/routines`, `/debug/health`, `/debug/logs`, `/debug/events`

---

## Burlington countdown

2026-04-29 15:15 EDT — **2 days, 8 hours** until Burlington 2026-05-01.

Burlington-critical items: ALL DONE pending deploy of `f08af32` build.

Take architecture: separate session, separate deploy. Recommend TEST2026 soak before live event.
