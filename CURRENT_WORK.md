# Current Work — CompSyncElectronApp

## STATUS: Post-show recovery complete + autonomous build pass + post-incident patches — all uncommitted, awaiting operator review (2026-04-20 08:42 EDT)

### Quick recap (this combined handoff covers TWO workstreams)

**Workstream A — Data recovery (main chat, tmux 1):**
- 11,483+ photos recovered across R291, R483, R527, R542, R558, R502–R509 (Sat-gap), R608–R626 via external Python scripts
- Root cause found + patched: post-restart upload stall (in-memory queue lost + `UPLOAD_ALL` filter excluded `status='uploaded'` routines with new photos)
- Incident write-up added to top of `INBOX.md`
- Memory locked: `feedback_never_destructive_db.md` — no DELETE/TRUNCATE/mass-UPDATE on Supabase

**Workstream B — Autonomous v7 code pass (tmux 8 cse-auto):** see sections below

---

**Live asar md5 on DART:** `100A17C337A18D34742DF1F76F8CE76E` (v4)
**Staged on DART Desktop (NOT live):**
- `app.asar.staged-v5-2026-04-19-1438` md5 `2a144b18f618b7a6460216fa8d6d3b00` — v5 log retention
**Built on SpyBalloon (NOT yet staged on DART):**
- `release/win-unpacked/resources/app.asar` md5 `e36705506cf5f3677f27aa07497fe115` — v6 (v5 + debug HTTP server + events.log + instrumentation)
**v7 NOT BUILT YET** — autonomous session did source edits only. Needs `npm run build` before staging.

---

## Last Session Summary
Autonomous session (2026-04-19 18:36 → 2026-04-20 08:42 EDT) executed `/tmp/cse-autonomous-plan.md` — the retrospective punch list from `docs/plans/2026-04-19-weekend-retrospective.md`. 9 of 10 tasks complete, all additive, all type-clean. Operator constraint: no commits, no deploys, no DART access during the autonomous run.

## What Changed (uncommitted)
All changes sit in the working tree on `feat/sd-import-overnight`. Full per-task log at `/tmp/cse-autonomous-notes.md`.

- **T-F8-ui** — Settings.tsx: Photo Import section with "Mark Current SDs as Processed" / "Clear SD Watermarks" buttons, confirm dialogs, status hint. Wired preload API.
- **T-H19** — StartOfDayModal.tsx: stale-offset banner shown when camera offsets have `date` ≠ today; "Clear stale offsets" button calls new `state:clear-camera-offsets` IPC.
- **T-F7** — App.tsx `<ImportBusyBanner/>`: 2s pings of main via new `app:ping` IPC, shows sticky amber banner when RTT > 500ms, auto-clears < 250ms.
- **T-F4** — photos.ts: `detectClockOffset` now returns `{offsetMs, bestScore, zeroScore, totalPhotos}`. Offsets > 15s prompt the operator via new `photos:offset-proposal` IPC with 120s safety timeout. App.tsx `<OffsetConfirmToast/>` renders Yes / No / Skip. Skip remembers the camera body for the rest of the session.
- **T-H16** — ipcUtil.ts: `sendToRenderer` coalesces `photos:progress` / `upload:progress` / `ffmpeg:progress` at ~10 Hz per channel+routine with leading+trailing flush. Audio levels bypass.
- **T-H1/F1** (advisory only) — recording.ts: when archiving an existing routine dir and the new take is > 90s AND the prior dir had an encoded output, emit `recording:rerec-suspected`. App.tsx `<RerecordToast/>` shows amber toast, auto-dismiss 60s. Archive still proceeds — purely advisory. No advance-routine IPC added (deferred — risks live-show plugin/complete partial calls).
- **T-H17** — photos.ts: removed `sharp` import + both thumb-gen blocks (main import + reassignOrphan). upload.ts: new `ensurePhotoThumbnail` helper JIT-generates via bundled ffmpeg after each photo PUT; saves sibling `thumbnails/` dir (falls back to os.tmpdir()).
- **T-H13** — types.ts: new `PluginCompletePayload` interface documenting parallel `photos` / `photo_thumbnails` / `photo_captured_at` arrays + legacy `capture_times` alias. tests/contract-plugin-complete.spec.ts: Playwright test that posts canned payload to `COMPPORTAL_PREVIEW_URL`. Skips cleanly when env vars unset (COMPPORTAL_PREVIEW_URL / COMPPORTAL_PLUGIN_KEY / COMPPORTAL_TEST_ENTRY_ID / COMPPORTAL_TEST_COMPETITION_ID).
- **T-F3** — photos.ts: threaded `ImportPhotosOptions { previewOnly }` through `importPhotos` → `runImport`. Preview mode skips every mutating side effect (copyFile, setSdWatermarksBulk, setCameraOffset, appendEntries, enqueueRoundRobin/enqueueRoutine, updateRoutineStatus) and writes `_imports/preview-<runId>.json`. New IPC `photos:preview-import` + `photos:preview-complete`. DriveAlert.tsx: "Preview Import" button + result modal (per-routine counts, offsets, distribution warnings, "Accept & Import" shortcut).

## Build Status
- `npx tsc --noEmit` — **PASSING (clean)** at session close
- `npm run build` — **NOT RUN** (operator constraint — no builds, no deploys)
- ipc.ts showed a linter-triggered re-save — non-functional; watched on close; tsc still clean.

## PAUSED / DEFERRED
- **T-H2** — worker-thread refactor for EXIF + matching. NOT STARTED. Plan explicitly said "Do not start if you can't afford to finish — half-done worker refactor will break the live-show build." Needs a dedicated session where operator can smoke-test a full SD import on DART after deploy. No partial work in tree.
- **Advance-routine corrective IPC for T-H1/F1** — advisory-only implementation shipped. A "really advance and split" IPC would need plugin/complete partial semantics; deferred.

## Known Gotchas for Next Session
- `src/main/services/photos.ts`: `sharp` import is gone. `tether.ts` and `clipVerify.ts` still import sharp — untouched. If the operator removes sharp as a dep, those two must switch to ffmpeg first.
- `src/main/services/upload.ts`: JIT thumb gen means every upload worker now spawns an ffmpeg subprocess per photo. On DART's CPU profile this may add ~200ms per photo to the upload loop (was effectively 0 when thumbs were pre-generated on import). Watch the live R2 upload throughput after v7 deploy — if sluggish, consider a small thumb cache per import run.
- `detectClockOffset` signature changed from `number` to an object. Only one call site inside photos.ts — I updated it. If any external caller (or a worker-thread spawn path for T-H2) reaches in, it needs updating.
- Offset confirm toast has a 120s safety default-to-`yes` timeout. Intentional — an unattended laptop won't freeze imports.
- Preview JSON lives at `<outputDir>/_imports/preview-<runId>.json`. `<outputDir>` is `settings.fileNaming.outputDirectory` — same place the normal import writes `_orphans/`. Harmless to delete.
- Coalesced IPC uses `routineId` from payload when present to partition streams. Audio-meter channel is NOT in the allowlist so VU meters stay real-time.

## TODAY'S TODO LIST (must-do before end of day)

### 🔴 Review + commit the autonomous build pass
All 9 task changes are additive and live on `feat/sd-import-overnight`. Review the diff, commit however granularly suits, or cherry-pick by task. Per-task log at `/tmp/cse-autonomous-notes.md`.

### 🔴 Deploy v6 (when operator authorizes restart)
v6 has everything v5 has PLUS:
- Debug HTTP endpoint at `http://127.0.0.1:8765/debug/*` (localhost only, read-only)
- Routes: `/debug/state`, `/debug/queue`, `/debug/routines`, `/debug/logs?tail=N&grep=X`, `/debug/events?limit=N&kind=X`, `/debug/archives`, `/debug/health`, `/debug/offsets`, `/debug/watermarks`
- Structured events.log (append-only) + in-memory 2000-event ring buffer
- Instrumented: offset detector decisions (with rejection reasons), drive detection, clock-mismatch warnings, re-record archive (captures pre-archive file list — the forensic trail R483/R529/R530 lacked)
- Remote access: `ssh -L 8765:localhost:8765 dart` then `curl http://localhost:8765/debug/state`

Deploy sequence (same as prior): stage v6 to DART Desktop, backup current asar, stop app, swap, **operator launches** (SSH Start-Process doesn't work).

### 🟡 Build + stage v7 (autonomous changes)
After review + commit, `npm run build` on SpyBalloon, then stage the resulting asar next to v6 for comparison before the operator chooses which to deploy.

### 🟡 Post-deploy smoke checks (after v7 goes live)
- Drop a known-dirty SD and watch for offset-confirm toast on Cam 2 / Cam 4 if any clock drift > 15s.
- Run a "Preview Import" on a real SD to sanity-check the projected per-routine distribution before committing.
- Verify ImportBusyBanner shows during bulk import scan.
- Check `main.log` for absence of `Sharp thumb failed` warnings (confirms T-H17 took effect).

### 🔴 Data recovery (post-show or as DART load permits) — unchanged from prior session
See prior CURRENT_WORK.md notes at HEAD for the Friday/Saturday/R529/R530 recovery punch list; nothing in this autonomous pass touched that workstream.

## Files Touched This Session (autonomous 2026-04-19 → 2026-04-20)
- `src/shared/types.ts`
- `src/preload/index.ts`
- `src/main/ipc.ts`
- `src/main/ipcUtil.ts`
- `src/main/services/photos.ts`
- `src/main/services/recording.ts`
- `src/main/services/upload.ts`
- `src/renderer/App.tsx`
- `src/renderer/components/Settings.tsx`
- `src/renderer/components/StartOfDayModal.tsx`
- `src/renderer/components/DriveAlert.tsx`
- `tests/contract-plugin-complete.spec.ts` (new)

Other tracked-dirty files in the working tree are from the pre-autonomous v5/v6 build pass (already described at HEAD) — not touched by this session.

---

## Workstream A Additions (main-chat 2026-04-19 post-show through 2026-04-20 08:42 EDT)

### Additional code changes (not in autonomous pass)

- **`src/main/services/photos.ts`** (on top of autonomous):
  - Sharp log throttle removed (`if (copiedCount < 3)` gate deleted — every Sharp failure now logs). Sunday H:\ import silently had 1,557 Sharp failures; only 3 warnings surfaced. Real failure rate now visible.
  - Preserve original camera filenames end-to-end (`P2234563.JPG` stays as `P2234563.JPG`, not `photo_NNN.jpg`). Main import loop + orphan dir + `reassignOrphan`. Thumb sibling names match `deriveThumbObjectName` convention (`P2234563_thumb.webp`). `_dup{N}` collision suffix.
  - Reference-gap refusal in `detectClockOffset`: if recording-windows array has any consecutive gap > 15min, refuse non-zero offset (would have caught R530 -201s incident). Emits `offsetDetector.decision` event with `outcome: 'rejected-reference-gap'`.
  - `getCameraBodyKey` exported (was internal).

- **`src/main/services/tether.ts`**:
  - Tether-path photo copy also preserves original camera filename. `_dup{N}` collision suffix. Same rationale as main import loop.

- **`src/main/services/driveMonitor.ts`**:
  - `sampleAndReportCameraClock` over-collects 5×5=25 candidates and filters out photos below per-body `sdWatermarks[body].lastFilename` before sampling. Kills the "N days off" false-positive popups from leftover prior-day photos.

- **`src/renderer/components/DriveAlert.tsx`**:
  - Clock-mismatch popup text updated — "matcher attempts offset correction automatically" was stale after magnitude cap shipped. Now says "Large offsets (>60s) are rejected; photos outside every window fall back to nearest-window matching."

- **`src/renderer/components/RoutineTable.tsx`**:
  - Double-click routine row opens `NoteEditor` via `externalOpen: {routineId, seq}` prop pattern (F5 wire-up). Existing IPC + editor component, just needed the wire.

- **`src/main/ipc.ts` UPLOAD_ALL filter (CRITICAL post-incident patch)**:
  - Old filter: `if (routine.encodedFiles && status !== 'uploaded' && status !== 'confirmed' && status !== 'uploading')` — excluded routines whose video finished but new photo waves arrived.
  - New filter: also allow-through any routine with `photos.some(p => !p.uploaded)` regardless of status (as long as not `'uploading'`). `enqueueRoutine` already skips already-uploaded photos internally.
  - **This is the fix for tonight's post-restart stall** (33 routines / 1,384+ stranded photos, `Upload all: queued 0` three times in log).

### Documentation added

- **`INBOX.md` top**: full incident write-up — 2026-04-19 19:08 EDT UPLOAD_ALL stall. Root cause (three-part: filter gate + in-memory queue + status desync). Workaround used (external Python). V7 follow-up checklist.
- **`docs/plans/2026-04-19-R529-R530-recovery.md`** (new): re-record chaos playbook. Reference for R483/R529/R530/any future re-record incident. Step-by-step: pull archive/v1, extract keyframes, UPDATE window, INSERT missing package row, realign photos.
- **`docs/plans/2026-04-19-weekend-retrospective.md`** (new, cse-retro tmux 4 wrote it): full weekend retrospective across CSE + CompPortal transcripts. 20+ hardening recommendations + 15+ feature suggestions, every item cited to transcript line.
- **Memory (`~/.claude/projects/-home-danman60-projects-CompSyncElectronApp/memory/`)**:
  - `feedback_never_destructive_db.md` — hard rule: no DELETE/TRUNCATE/DROP/mass-UPDATE on Supabase. Additive or targeted-single-row only, with explicit approval. Added to `MEMORY.md` index.

### Recovery scripts (new, in `scripts/`)
- `scripts/upload-pending-photos.py` — serial recovery, ran 18:40–20:24 EDT Sunday
- `scripts/upload-pending-photos-parallel.py` — parallel ThreadPoolExecutor version
- `scripts/upload-sat-evening-gap.py` — **reference implementation for task #25**. Scoped recovery for R502-R509 Sat-evening gap: enumerates D:\DCIM\P23*.JPG in mtime window, EXIF-reads, matches to routine windows, uploads via plugin API. 1,973 photos in 28 min, zero errors.

### Data recovery performed tonight (2026-04-19 post-show → 2026-04-20)

| Event | Before | After | Method |
|---|---|---|---|
| R483 window + keyframes | 1 photo | 357 | Earlier Sunday main chat |
| Sunday 555+ thumb backfill | ~0 thumbs | 2,574 | Python script |
| Post-restart stranded uploads (33 routines) | ~4,000 pending | 4,000 landed | `upload-pending-photos.py` |
| R502-R509 Sat-evening gap | 0/8 routines | **1,973 photos / 8 routines** | `upload-sat-evening-gap.py` |
| R608-R626 Sunday tail | partial | 1,899/2,013 | `upload-pending-photos-parallel.py` |

Final photo counts (all recovered routines): R291:153, R483:357, R502:174, R503:274, R504:294, R505:259, R506:328, R507:214, R508:194, R509:236, R527:460, R542:419, R558:166, R608:119, R609:81, R610:50, R611:101, R612:101, R613:92, R614:57, R615:79, R616:94, R617:76, R617.5:99, R618:139, R619:87, R620:98, R621:98, R622:73, R623:111, R624:97, R625:171, R626:148.

### Additional v7 tasks added (tracker)
- **#20 Auto-resume pending photo uploads on app boot** — MUST include DB cross-check (not state.json flag trust). Highest-leverage recovery fix.
- **#21 Persist upload job queue to `compsync-state.json`** — survive crashes mid-upload. Don't persist presigned URLs; re-sign on dequeue.
- **#22 "Resume Unfinished Uploads" manual button** — defense-in-depth. Requires DB cross-check.
- **#23 Auto-rollback routine.status** — when new photos arrive after a routine is marked `uploaded`, demote status so standard filters self-heal.
- **#24 CompPortal: GET /api/plugin/list-photos** — batch filename endpoint needed by #20 + #22.
- **#25 Missing-photo detection on SD plug-in** — the big auto-recovery feature. Full spec includes the validated pattern from tonight: monotonic-filename handoff detection, DB-truth driven recovery, direct R2 PUT, body-rollover awareness. Reference implementation: `scripts/upload-sat-evening-gap.py`. Acceptance test: operator plugs SD, sees "Found N photos covering zero-photo routines, import?" toast within 10s.

### Known remaining work (workstream A)

- ~114 photos still missing from R608-R626 recovery (CompPortal API timeouts during plugin/complete batch calls). Script is idempotent; a targeted retry with 4 workers + 120s timeouts would finish clean. Low priority.
- **CompPortal API flakiness under load** — 8 workers → 30s upload-url timeouts. 4 workers = clean. V7 upload logic should cap concurrency at 4.
- Root untracked files (don't commit): `compsync-state.json`, `index.js`, `index-DSOIuT24.js`, `index-QqNFl2m1.js`, `meters-*.png`, `preview-full.png`, `meters-debug.png`, etc. Likely stale test artifacts; verify + gitignore.

---

## Combined Next Steps (priority order)

1. **Review the working tree diff** before committing. 3,007 insertions / 1,274 deletions across 39 files from BOTH workstreams (autonomous + main-chat patches). Dan wants to inspect personally.
2. **Build v7 asar** — `npm run build` + electron-builder. Preserve v6 asar (`release/win-unpacked/resources/app.asar` md5 `e36705506cf5...`) as rollback target before rebuilding that path.
3. **Stage v7 + swap `app.asar` on DART** — operator-driven (SSH Start-Process doesn't attach to user session).
4. **Smoke-test v7 live** — drop a known-dirty SD; run "Preview Import"; verify `ImportBusyBanner` shows during bulk import; verify no `Sharp thumb failed` in `main.log`; verify new `UPLOAD_ALL` filter picks up state-pending routines.
5. **Complete v7 code work** — tasks #20, #21, #22, #23, #24, #25 from tracker. Highest leverage: #20 (auto-resume on boot) + #24 (list-photos endpoint). These close the "post-restart recovery" gap that cost hours tonight.
6. **Retry ~114 stragglers** when CompPortal is quiet.
7. **T-H2 Worker-thread refactor** (#13) — dedicated session with ability to re-test on DART.

---

## Post-Wrap-Up Reminders

- **No auto-commit performed.** Both workstreams committed nothing; operator reviews + commits personally (master rule: `NEVER EXECUTE WITHOUT APPROVAL`).
- **No deploy performed.** Live DART asar is still v4 from Sunday 13:53 EDT. v6 is staged but not swapped. v7 not built.
- **CompPortal session (tmux 9) has separate uncommitted work** — needs its own wrap-up (photo pollution analysis R148-R187 in progress when this session wrapped).
- **Live asar = v4.** None of the 39 files of changes in the tree are running in production yet.

## Reference
- Per-task log with timestamps + rationale: `/tmp/cse-autonomous-notes.md`
- Plan executed: `/tmp/cse-autonomous-plan.md`
- Retrospective source: `docs/plans/2026-04-19-weekend-retrospective.md`
- Live R529/R530 recovery precedent: `docs/plans/2026-04-19-R529-R530-recovery.md`
