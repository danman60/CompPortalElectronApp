# Current Work — CompSyncElectronApp

## Last Session Summary
v7 fully coded, committed, pushed, and built. Three commits on `feat/sd-import-overnight` cover all 16 completed retrospective items. v7 asar staged on DART at `C:\Users\User\Desktop\app.asar.v7-2026-04-20-0906` (md5 `d1c2dd7671f3f0fb50bbc868b5e4af63`). Ready for operator restart + swap on DART.

## What Changed

### Committed this session (3 commits, all pushed)

- **`c178c17 feat(v7): unified media reconciler + ambient drift healing (#26)`** — +736/-20 across 8 files. New `src/main/services/mediaReconciler.ts` (~400 lines): `reconcileMedia({ scope, routineIds?, silent? })` engine with gates (no-connection / SD-import / ffmpeg-busy / per-routine exponential backoff 15min→24h). `fetchMediaInventory` widened to consume extended `/api/plugin/list-photos` response (photos+videos+thumbs+keyframes). Converged trigger points: boot → `scope:'boot'`, manual Upload All / Resume Unfinished → `scope:'manual'`, SD plug-in → `scope:'sd-plugin'`, post-record → `scope:'post-record'`. Ambient `setInterval` from `settings.upload.reconcileCadenceMinutes` (default 15, range 2–1440, 0=disabled), silent by default. Settings → Automatic Sync section. `<ReconcileToast/>` in App.tsx.

- **`6dbdd3e feat(v7): upload recovery + resume engine`** — +813/-9 across 11 files. Tasks #20 (auto-resume on boot with DB cross-check + graceful-degrade), #21 (persist job queue to `compsync-state.json` with flushSync on terminal state, debounced on enqueue), #22 (Resume Unfinished Uploads button in Settings), #23 (auto-rollback `routine.status` uploaded/confirmed → encoded when new `uploaded:false` photos arrive), #25 (missing-photo detection on SD plug-in via `surveyAndReportMissingPhotos` + `<MissingPhotosToast/>`).

- **`f0be4ab feat(v7): post-show recovery patches + retrospective features`** — 15 retrospective items. Sharp log throttle removed, original camera filenames preserved end-to-end, reference-gap refusal in offset detector, re-record advisory toast, offset confirmation toast, import-busy banner, watermark-filtered clock-mismatch sampler, IPC event coalescing 10Hz, double-click routine→notes, day-start stale-offsets banner, mark/clear SD watermarks buttons, SD preview import mode, thumbs moved off main thread, `/plugin/complete` contract test, UPLOAD_ALL filter fix (post-incident patch).

### Uncommitted but tracked
- **`CLAUDE.md`** — 4-line addition to the PHOTOMATCH INVESTIGATION PROTOCOL banning invented filename classifications (MIXED/SYNTHETIC/do-not-delete/frame-extractor etc.) after a Monday-morning incident where I invented a segmentation scheme for `photo_NNN.JPG` files without asking the user.

### Intentionally untracked (not committing)
- `.ccbot-uploads/`, `.claude/`, `.claude-crash-transcript.md`, `compsync-state.json`, `docs/postmortems/`, `index-*.js`, `meters-*.png`, `preview-full.png`, `scripts/__pycache__/`, `test-results/sd-import-overnight/`, `tests/reports/empwr-london-2026-04-14-*` — stray session artifacts, playwright screenshots, Python bytecode, state dumps. These should be gitignored in a future cleanup pass.

## Build Status

**v7 electron-builder PASSING** (earlier in this session). asar md5 `d1c2dd7671f3f0fb50bbc868b5e4af63`, 131,923,633 bytes, built 2026-04-20 09:06 EDT. Staged on DART Desktop at `C:\Users\User\Desktop\app.asar.v7-2026-04-20-0906`. NOT yet swapped.

**tsc --noEmit PASSING** throughout.

## Filename Preservation Chain (v7)

| Stage | Filename | Status |
|---|---|---|
| 1. Camera SD | `P2234563.JPG` | Native |
| 2. CSE local disk | `P2234563.JPG` (+ `_dup{N}` on collision) | ✅ shipped |
| 3. Local thumb sibling | `P2234563_thumb.webp` | ✅ shipped |
| 4. R2 photo object | `P2234563.JPG` | ✅ shipped |
| 5. R2 thumb object | `P2234563_thumb.webp` | ✅ shipped |
| 6. `/plugin/complete` payload | storage paths carry `P2234563.JPG` | ✅ shipped |
| 7. `media_photos.filename` INSERT | verbatim from storage path | ✅ shipped (CompPortal c9d80dc5) |
| 8. Portal display (parent/SD/CD) | still renders `filename` (currently mix of P-format + legacy `photo_NNN.jpg`) | On hold — post-UDC-London flip |
| 9. Single-photo + ZIP download | still uses `photo_NN.jpg` templates | On hold — post-UDC-London flip |

**Audit on DB** (2026-04-20 10:58 EDT): UDC London has 73,421 P-format rows + 36,033 legacy `photo_NNN.jpg` rows. Legacy originals are NOT recoverable from DB — only re-scannable from physical SD cards. No migration run.

## CompPortal Side (tracked separately — different repo)

Hybrid session tmux window `CSE-CompPortal-hybrid-1` shipped 5 commits on `CompPortal/main`:
- `c9d80dc5` additive `display_name` field + naming audit doc
- `58df63f4` `GET /api/plugin/list-photos` (cse-auto's T-V7-20 dependency)
- `929fa90f` CD thumb regen route + per-routine button
- `b08b6085` `?since=` param on Latest Photos
- `127c2c92` extended `/api/plugin/list-photos` response with videos+keyframes+thumb flags (T-V7-26a)

All pushed.

## Known Bugs & Issues

- **`photo_NNN.jpg` legacy rows in DB (~36k)** — irreversibly written by pre-v7 CSE pipeline + external Python recovery scripts that copied already-renamed local files. Can't be fixed without SD re-scan.
- **`compsync-state.json` in repo root** — sitting untracked; gitignore needed.
- **`index-DSOIuT24.js` + `index-QqNFl2m1.js` + `index.js` in repo root** — stray Vite outputs; gitignore or delete.
- **`meters-*.png` in repo root** — debug screenshots from earlier audit; delete.
- **Tests directory has empwr-london artifacts (2026-04-14 reports)** — outside repo scope, leftover playwright runs. Consider moving to `.gitignore` or cleaning.

## Incomplete Work

- **v7 not yet deployed on DART** — staged at `C:/Users/User/Desktop/app.asar.v7-2026-04-20-0906` awaiting operator restart + swap. Rollback target: current live v4 asar at `C:\Program Files\CompSync Media\resources\app.asar` (md5 `100A17C337A18D34742DF1F76F8CE76E`). Pre-swap backup command in "Next Steps" below.
- **Post-UDC-London flip** — display-name render + ZIP friendly-rename are drafted in CompPortal but held until operator greenlights mid-release.

## Tests

- **No new test suite run this session.** Contract test (`tests/contract-plugin-complete.spec.ts`) was added in commit `f0be4ab`; skips cleanly when env vars absent — not exercised live yet.
- **`npx tsc --noEmit`** clean at wrap-up.
- **electron-builder** shipped successfully (v7 asar md5 verified matching on DART).
- **Untested in production**: everything in v7 — no live-run validation yet. Smoke test required after operator swap.

## Next Steps (priority order)

1. **Operator: swap v7 on DART.** Sequence:
   ```powershell
   cd "C:\Program Files\CompSync Media\resources"
   Copy-Item app.asar app.asar.bak-v4-2026-04-20-preswap
   # Close running CompSync Media app via GUI or Task Manager
   Move-Item app.asar app.asar.pre-v7
   Move-Item "C:\Users\User\Desktop\app.asar.v7-2026-04-20-0906" app.asar
   # Operator launches from Start menu (SSH Start-Process does not attach to user session)
   ```
2. **v7 smoke tests on DART** after launch:
   - Verify no `Sharp thumb failed` warnings in `main.log`
   - Drop known-dirty SD; watch Preview Import button + offset confirmation toast behavior
   - Verify ImportBusyBanner shows during bulk import scan
   - Open DevTools → `window.api.resumeUnfinishedUploads()` → verify it queries CompPortal list-photos and only enqueues true misses
   - Watch ambient reconciler fire at the 30s boot-first-tick, then every 15min
3. **Retry remaining ~114 stragglers** from Sunday R608–R626 recovery when CompPortal API is quiet (max 4 workers; 8 triggered timeouts).
4. **Post-UDC-London display-name flip** (CompPortal side) — swap `{photo.filename}` → `{photo.display_name ?? photo.filename}` in parent/SD/CD tiles; ship ZIP download-rename template. Hybrid session stays idle until operator greenlights.
5. **T-H2 worker-thread refactor** — last deferred v7 task. Requires fresh session + DART-runtime testing after v7 proven stable.
6. **Gitignore cleanup** — root stray artifacts.

## Gotchas for Next Session

- **v7 ambient reconciler cadence = 15 min default**, silent by default. If the operator wants aggressive auto-sync during live shows, set `upload.reconcileCadenceMinutes = 5` + `upload.reconcileSilent = false`. If they want it off entirely, set cadence to 0.
- **Thumb-only backfill is deferred (would-be T-V7-27)**. If reconciler detects DB has the photo but `thumbnail_url IS NULL`, it currently logs at info but doesn't enqueue a thumb-only job. Full-upload path writes thumbs alongside, so drift is rare. Add later if it becomes a problem.
- **`compsync-state.json` schema now includes `jobQueue`** (persisted). Existing installs' state.json will be auto-migrated on first save (additive field; load is defensive).
- **Job queue persistence = debounced saves @ 500ms on enqueue, flushSync on status transitions (running/done/failed)**. Crash in the 500ms window loses up to one batch of pending enqueues. Trade-off documented in `/tmp/cse-auto-batch2-notes.md`.
- **Reconciler graceful-degrades against old CompPortal server shape** (photos-only, no videos/thumbs/keyframes). If the CompPortal deploy lags behind CSE deploy, reconciler logs a warning and runs photos-only reconcile. No crash.
- **Coordination memory locked** in `~/.claude/projects/-home-danman60-projects-CompSyncElectronApp/memory/feedback_never_destructive_db.md` — no DELETE/TRUNCATE/DROP/mass-UPDATE on Supabase without explicit per-action approval.
- **Tmux window layout** (2026-04-20 EDT):
  - `claude:1` CompSyncElectronApp (this session — wrapping up)
  - `claude:4` cse-auto (CSE autonomous worker, idle after batch 3)
  - `claude:5` cse-retro (idle, produced weekend retrospective)
  - `claude:6` CSE-CompPortal-hybrid-1 (CompPortal worker, idle after 5 commits)
  - `claude:7` CompPortal-9 (photo pollution analysis R148–R187, separate workstream)
  - `claude:8-10` other CompPortal / bash windows
- **Autonomous workers' plans + notes** at:
  - `/tmp/cse-autonomous-plan.md`, `/tmp/cse-autonomous-notes.md` (batch 1)
  - `/tmp/cse-auto-batch2-plan.md`, `/tmp/cse-auto-batch2-notes.md` (batch 2)
  - `/tmp/cse-auto-batch3-plan.md`, `/tmp/cse-auto-batch3-notes.md` (batch 3)
  - `/tmp/hybrid-batch-addendum.md`, `/tmp/hybrid-batch-notes.md` (CompPortal batch)
  - `/tmp/fresh-prompt-hybrid-naming.md` (hybrid's primary directive)

## Files Touched This Session (CSE repo)

Committed in f0be4ab / 6dbdd3e / c178c17 (across three commits):
- `src/shared/types.ts` (+IPC channels, PluginCompletePayload, ReconcileOpts)
- `src/preload/index.ts` (new API surfaces)
- `src/main/index.ts` (ambient reconciler boot, settings-change hot-restart)
- `src/main/ipc.ts` (multiple handlers — UPLOAD_RESUME_UNFINISHED, PHOTOS_PREVIEW_IMPORT, STATE_LIST_CAMERA_OFFSETS, STATE_CLEAR_CAMERA_OFFSETS, APP_PING, PHOTOS_MARK_SDS_PROCESSED, PHOTOS_CLEAR_SD_WATERMARKS, RECONCILE_MEDIA)
- `src/main/ipcUtil.ts` (progress-event coalescer 10Hz)
- `src/main/logger.ts` (100MB segments + dated rotation)
- `src/main/services/photos.ts` (preserve original filenames, sharp log throttle removed, reference-gap refusal, preview-only gates, getCameraBodyKey exported)
- `src/main/services/tether.ts` (preserve filenames)
- `src/main/services/driveMonitor.ts` (watermark-filtered sampler, surveyAndReportMissingPhotos)
- `src/main/services/recording.ts` (re-record advisory IPC)
- `src/main/services/upload.ts` (JIT thumb via ffmpeg, autoResumeUnfinished wiring, fetchMediaInventory client, UPLOAD_ALL filter relaxed)
- `src/main/services/state.ts` (camera offsets list/clear, jobQueue persistence)
- `src/main/services/mediaReconciler.ts` (NEW, 400+ lines)
- `src/main/services/overlayPanels.ts`
- `src/main/services/debugServer.ts` (NEW, v6 debug HTTP :8765)
- `src/main/services/events.ts` (NEW, structured events.log + ring buffer)
- `src/renderer/App.tsx` (ImportBusyBanner, OffsetConfirmToast, RerecordToast, MissingPhotosToast, ReconcileToast)
- `src/renderer/components/RoutineTable.tsx` (double-click row → notes)
- `src/renderer/components/DriveAlert.tsx` (Preview Import button + result modal)
- `src/renderer/components/Settings.tsx` (Photo Import section, Automatic Sync section)
- `src/renderer/components/StartOfDayModal.tsx` (stale offsets banner)
- `src/renderer/components/NextRoutines.tsx`, `PreviousRoutines.tsx`, `PanelApp.tsx`
- `src/renderer/components/PanelChat.tsx` (NEW)
- `src/renderer/styles/panels.css`
- `tests/contract-plugin-complete.spec.ts` (NEW)
- `INBOX.md` (2026-04-19 19:08 EDT incident write-up + v7 to-do list)
- `CLAUDE.md` (this session's addendum still uncommitted pending wrap-up commit)
- `docs/plans/2026-04-18-saturday-recovery-truths.md` (NEW)
- `docs/plans/2026-04-19-R529-R530-recovery.md` (NEW — re-record chaos playbook)
- `docs/plans/2026-04-19-weekend-retrospective.md` (NEW — full weekend retro)
- `scripts/upload-pending-photos.py` (NEW — stranded-upload resume)
- `scripts/upload-pending-photos-parallel.py` (NEW — parallel variant)
- `scripts/upload-sat-evening-gap.py` (NEW — R502–R509 recovery, reference impl for #25)
- `scripts/backfill-keyframes.py` (NEW)

## See Also

- `INBOX.md` — incident log top of file
- `docs/plans/2026-04-19-weekend-retrospective.md` — full weekend retro
- `/tmp/cse-auto-batch3-notes.md` — reconciler task log
- `/tmp/hybrid-batch-notes.md` — CompPortal-side batch log
- `~/.claude/projects/-home-danman60-projects-CompSyncElectronApp/memory/MEMORY.md` — project memory index
