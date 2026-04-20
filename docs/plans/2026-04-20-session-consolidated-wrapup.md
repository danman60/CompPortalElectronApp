# 2026-04-20 Monday — Consolidated Session Wrap-Up

**Authoritative handoff.** Consolidates three parallel sessions (main chat, tmux 4 cse-auto, tmux 6 hybrid) into one state-of-the-world document for whoever picks up next.

---

## TL;DR

- **CSE**: 4 commits today on `feat/sd-import-overnight`. v7 asar built, md5 `d1c2dd7671f3f0fb50bbc868b5e4af63`, staged on DART at `C:\Users\User\Desktop\app.asar.v7-2026-04-20-0906`. NOT swapped. Live = v4.
- **CompPortal**: 21 commits today on `main`. Display-name flip (Task 1 of flip) shipped at 15:45 EDT. ZIP friendly-rename (Task 2) **still in-flight in tmux 6** at wrap-up time.
- **Filename preservation chain**: green up through portal display. Green-but-in-flight for ZIP download. Once Task 2 lands it's end-to-end green.
- **Data recovery overnight**: 11,483+ photos recovered via external scripts (Python in `scripts/upload-pending-photos*.py` + `upload-sat-evening-gap.py`). UDC London DB state: 73,436 original P-format + 36,053 legacy `photo_NNN.jpg` (irreversibly written by pre-v7 pipeline + recovery scripts).
- **Memory rules locked this session**: `feedback_never_destructive_db.md` (no destructive Supabase ops), PHOTOMATCH protocol extended to ban invented filename classifications.

---

## CSE repo commits today

`/home/danman60/projects/CompSyncElectronApp` on branch `feat/sd-import-overnight`, all pushed:

| Time EDT | SHA | Subject | Tasks |
|---|---|---|---|
| 12:47 | `f0be4ab` | feat(v7): post-show recovery patches + retrospective features | #1 #2 #3 #5 #6 #7 #8 #9 #10 #11 #12 #14 #18 + UPLOAD_ALL filter post-incident patch (15 retrospective items) |
| 15:01 | `6dbdd3e` | feat(v7): upload recovery + resume engine | #20 #21 #22 #23 #25 |
| 15:10 | `c178c17` | feat(v7): unified media reconciler + ambient drift healing (#26) | #26 + T-V7-26a consumer (graceful-degrades on v1 server shape) |
| 19:33 | `8f1d960` | chore: CLAUDE.md protocol addendum + CURRENT_WORK.md session wrap-up | PHOTOMATCH protocol — ban invented filename classifications |

**Tracker reconciliation**: #4 (re-record advisory) is inside `f0be4ab`. #13 (worker-thread) **deliberately deferred** — only remaining open CSE v7 task. #15 (Media Reconciliation panel) deferred as large standalone. #16 / #17 / #19 / #24 are CompPortal-side (see below).

---

## CompPortal repo commits today

`/home/danman60/projects/CompPortal` on `main`, all pushed. Filtered to session-relevant items (others are concurrent work by separate hybrid/other sessions):

| Time EDT | SHA | Subject | Relevance |
|---|---|---|---|
| 13:33 | `c9d80dc5` | feat(media-names): additive display_name field + naming audit | Audit report + `src/lib/media-display-name.ts` helper + `display_name` added to 3 media API routes (parent/SD/CD). `filename` untouched. **Report at** `docs/plans/2026-04-20-naming-convention-audit.md`. |
| 13:34 | `58df63f4` | feat(plugin): GET /api/plugin/list-photos for CSE auto-resume | T-V7-24. Bearer plugin key, ≤100 entryIds, tenant-scoped. Required by CSE #20 auto-resume. |
| 13:38 | `929fa90f` | feat(cd): self-service thumbnail regeneration button | T-F16 #19. `POST /api/cd/regenerate-thumbs`, non-destructive (NULL thumbs only). |
| 13:40 | `b08b6085` | feat(latest-photos): accept since= URL param for incremental polling | T-F2 #17. Filter `media_photos.created_at > since`. |
| 15:01 | `127c2c92` | feat(plugin): extend list-photos response with videos + keyframes + thumb flags | T-V7-26a. Additive extension consumed by CSE #26 reconciler. |
| 15:42 | `cab59f4a` | feat(media-visibility): granular per-comp × audience × type matrix | Concurrent (not this session) |
| 19:30 | `f0e00185` | fix(media-visibility): dark-styled Listbox replaces native select | Concurrent (not this session) |
| 19:45 | `28717cca` | feat(media): render display_name in parent/SD/CD photo tiles | **FLIP Task 1**. Swap `{filename}` → `{display_name ?? filename}` in photo tiles. 5 files, +28/-3. |

**Still in-flight (tmux 6 working)**: FLIP Task 2 — ZIP friendly-rename in `/api/media/download/[packageId]`, `/api/media/bulk-manifest`, `/api/media/photo-download`. Template: `{entry_number}_{routine_title}_{studio_code}_{dancer_name}_{original}.jpg` with Windows-safe sanitization. Not yet committed.

---

## v7 asar staging + deploy sequence

**Built**: 2026-04-20 09:06 EDT, electron-builder, md5 `d1c2dd7671f3f0fb50bbc868b5e4af63`, 131,923,633 bytes (125.8 MB).
**Staged on DART**: `C:\Users\User\Desktop\app.asar.v7-2026-04-20-0906` (md5 verified matching).
**Live on DART**: v4 asar (md5 `100A17C337A18D34742DF1F76F8CE76E`).
**NOT yet swapped** — awaiting operator.

### Deploy sequence (operator to run on DART)

```powershell
cd "C:\Program Files\CompSync Media\resources"
# 1. Backup current live as rollback target
Copy-Item app.asar app.asar.bak-v4-2026-04-20-preswap

# 2. Close running CompSync Media (GUI or Task Manager)

# 3. Swap
Move-Item app.asar app.asar.pre-v7
Move-Item "C:\Users\User\Desktop\app.asar.v7-2026-04-20-0906" app.asar

# 4. Launch from Start menu (SSH Start-Process does NOT attach to user session)
```

### Rollback chain on DART

| Marker | Path | Use |
|---|---|---|
| pre-swap v4 | `app.asar.bak-v4-2026-04-20-preswap` (to be created in step 1 above) | **If v7 has issues — rollback target** |
| prior v3 | `app.asar.bak-2026-04-19-1353-v3` | Two versions back |
| prior v2 | `app.asar.bak-2026-04-19-1300-prerestart` | Three versions back |
| prior morning | `app.asar.bak-2026-04-19-1050-preswap` | Four versions back |

### v7 smoke tests after launch

1. Verify no `Sharp thumb failed` warnings in `%APPDATA%\compsync-media\logs\main.log`
2. Drop known-dirty SD → confirm Preview Import button appears + offset confirmation toast behavior
3. Verify ImportBusyBanner shows during bulk import scan (>500ms RTT trigger)
4. DevTools console: `await window.api.resumeUnfinishedUploads()` — verify queries CompPortal list-photos and enqueues only true misses
5. Watch ambient reconciler: first tick 30s after boot, then every `settings.upload.reconcileCadenceMinutes` (default 15)
6. Open Settings → Photo Import section (mark/clear SD watermarks buttons) + Automatic Sync section (cadence slider + silent toggle)

---

## Filename preservation chain — end-of-session state

| Stage | Filename | Status |
|---|---|---|
| 1. Camera SD | `P2234563.JPG` (Lumix native) | Native |
| 2. CSE local disk copy | `P2234563.JPG` + `_dup{N}` collision suffix | ✅ shipped v7 commit `f0be4ab` |
| 3. Local thumb sibling | `P2234563_thumb.webp` | ✅ shipped v7 |
| 4. R2 photo object | `P2234563.JPG` | ✅ shipped v7 |
| 5. R2 thumb object | `P2234563_thumb.webp` | ✅ shipped v7 |
| 6. `/plugin/complete` payload | storage paths carry original | ✅ shipped v7 |
| 7. `media_photos.filename` INSERT | verbatim from storage path | ✅ CompPortal `plugin/complete:177` (unchanged since Feb, verified in naming audit) |
| 8. Portal display (parent/SD/CD tiles) | `{display_name ?? filename}` → shows `138_1` | ✅ shipped CompPortal commit `28717cca` 15:45 EDT |
| 9. ZIP download | `{entry}_{routine}_{studio}_{dancer}_{original}.jpg` | ⏳ **IN-FLIGHT in tmux 6** (Task 2 of flip) |
| 10. Single-photo download | to match template | ⏳ **IN-FLIGHT in tmux 6** |

**Legacy DB state** (audit 10:58 EDT): UDC London has 73,436 P-format filenames + 36,053 `photo_NNN.jpg` + 0 other. Legacy originals are **not recoverable from DB** (would need SD re-scan). 1,328 UDC London rows have `filename` ≠ `basename(storage_url)` from non-plugin/complete writes (historical artifact).

---

## Remaining open work

### CSE (cse-auto's domain)

| # | Task | Owner | Status |
|---|---|---|---|
| #13 | Worker-thread refactor for EXIF + matching (H2) | cse-auto (future session) | **Deferred** — half-done breaks live-show critical path; needs dedicated session with DART smoke test after v7 proven stable |
| #15 | Media Reconciliation in-app panel (H10/F9) | cse-auto (future) | Deferred large scope |
| T-V7-27 | Thumb-only backfill IPC (noted in batch 3 trade-offs) | cse-auto (future) | Rare in practice; reconciler currently logs gap at info |

### CompPortal (hybrid's domain)

| Task | Status | Notes |
|---|---|---|
| FLIP Task 2 — ZIP friendly-rename | **IN-FLIGHT** | tmux 6 currently working. Expected commits in next ~10 min. |

### Cross-repo (not started)

| Proposal | Origin | Greenlit? | Owner |
|---|---|---|---|
| **Short-take-discard feature** | tmux 6 proposed between flip tasks | **NOT greenlit** — operator didn't respond to it | Would split: cse-auto (Settings UI, recording.ts threshold gate, `_discarded/<runId>/` archive dir, detectClockOffset reference-duration gate, telemetry event, plugin/complete sender) + hybrid (plugin/complete route handler accepts optional `short_takes_discarded: [{duration_ms, discarded_at, take_basename?}]` payload, persists to new nullable `media_packages.short_takes_discarded` jsonb column via migration). **See tmux 6 scrollback for full proposal; not yet formalized as a task.** |

---

## Operator questions still open

1. **When does v7 swap happen on DART?** v7 asar staged since 09:06 EDT; operator controls timing. No show active.
2. **Greenlight short-take-discard?** tmux 6 proposed the feature; operator hasn't approved/rejected.
3. **Post-UDC-London release — retroactively back-rename 36,053 legacy `photo_NNN.jpg` rows?** Would require SD re-scan; drafted in naming audit report as "not run". Operator can call.
4. **Thumbnail backfill for pre-v7 NULL rows?** `POST /api/cd/regenerate-thumbs` shipped (commit `929fa90f`). Operator can trigger per-routine via CD dashboard button whenever ready.
5. **Retry ~114 R608-R626 stragglers from Sunday recovery?** Low priority; CompPortal API was flaky at 8-worker concurrency. Re-run with workers=4 when convenient.

---

## Memory rules locked this session

Project memory at `~/.claude/projects/-home-danman60-projects-CompSyncElectronApp/memory/`:

1. **`feedback_never_destructive_db.md`** — NEW. No DELETE/TRUNCATE/DROP/mass-UPDATE against CompSync Supabase without explicit per-action operator approval. Includes banned statements + allowed ops (INSERT via plugin/complete, targeted single-row UPDATE with approval, SELECT).

2. **PHOTOMATCH INVESTIGATION PROTOCOL** (in `CLAUDE.md`, not memory file) — extended with 4 new banned explanations:
   - "`photo_NNN.JPG` is video-frame extraction / synthetic / rendered / thumbnail / preview" without asking user
   - Invented filename classifications (MIXED / SYNTHETIC / do-not-delete / etc.)
   - Invented pipeline names (frame-extractor, video-slicer, preview-generator)
   - Any segmentation built on unknown filename pattern — answer is "I don't know what that is, can you tell me?" NOT "probably X, so here's how to handle it"

---

## Coordination rules (still in force)

- **tmux 4 cse-auto** = CSE-only write scope
- **tmux 6 hybrid** = CompPortal-only write scope (CSE read-only via `git show <sha>:<path>`, NOT working tree)
- **Main chat** = orchestrator + audit + hybrid dispatch + operator communication
- **API contract** — `GET /api/plugin/list-photos` response shape locked; if changed, notify both sessions

---

## Files touched per repo

### CSE (`/home/danman60/projects/CompSyncElectronApp`)

Source: `src/main/index.ts`, `src/main/ipc.ts`, `src/main/ipcUtil.ts`, `src/main/logger.ts`, `src/main/services/photos.ts`, `src/main/services/tether.ts`, `src/main/services/driveMonitor.ts`, `src/main/services/recording.ts`, `src/main/services/upload.ts`, `src/main/services/state.ts`, `src/main/services/mediaReconciler.ts` **(NEW)**, `src/main/services/overlayPanels.ts`, `src/main/services/debugServer.ts` **(NEW)**, `src/main/services/events.ts` **(NEW)**, `src/preload/index.ts`, `src/shared/types.ts`, `src/renderer/App.tsx`, `src/renderer/components/RoutineTable.tsx`, `src/renderer/components/DriveAlert.tsx`, `src/renderer/components/Settings.tsx`, `src/renderer/components/StartOfDayModal.tsx`, `src/renderer/components/NextRoutines.tsx`, `src/renderer/components/PreviousRoutines.tsx`, `src/renderer/components/PanelApp.tsx`, `src/renderer/components/PanelChat.tsx` **(NEW)**, `src/renderer/styles/panels.css`.

Tests: `tests/contract-plugin-complete.spec.ts` **(NEW)**.

Docs: `INBOX.md`, `CLAUDE.md`, `CURRENT_WORK.md`, `docs/plans/2026-04-18-saturday-recovery-truths.md` **(NEW)**, `docs/plans/2026-04-19-R529-R530-recovery.md` **(NEW)**, `docs/plans/2026-04-19-weekend-retrospective.md` **(NEW)**, this file **(NEW)**.

Scripts: `scripts/upload-pending-photos.py` **(NEW)**, `scripts/upload-pending-photos-parallel.py` **(NEW)**, `scripts/upload-sat-evening-gap.py` **(NEW)** — reference impl for task #25, `scripts/backfill-keyframes.py` **(NEW)**.

### CompPortal (`/home/danman60/projects/CompPortal`)

From this session (hybrid tmux 6): `src/lib/media-display-name.ts` **(NEW)**, `src/app/api/plugin/list-photos/route.ts` **(NEW)**, `src/app/api/plugin/complete/route.ts`, `src/app/api/cd/regenerate-thumbs/route.ts` **(NEW)**, `src/app/api/media/cd/latest-photos/route.ts`, `src/app/api/media/cd/routine-clusters/route.ts`, `src/app/api/media/parent/[dancerId]/route.ts` (or equivalent), `src/app/api/media/studio/[studioId]/route.ts`, `src/app/api/media/cd/entry/[entryId]/route.ts`, `src/app/dashboard/director-panel/media/latest-photos/page.tsx`, `src/components/media/PhotoLightbox.tsx`, `src/components/media/MediaShowAllModal.tsx`, `src/app/media/[dancerId]/page.tsx`, `src/app/dashboard/media/page.tsx`, `src/app/dashboard/director-panel/media/page.tsx`, `docs/plans/2026-04-20-naming-convention-audit.md` **(NEW)**.

In-flight (Task 2 uncommitted as of 15:45 EDT): `src/app/api/media/download/[packageId]/route.ts`, `src/app/api/media/bulk-manifest/route.ts`, `src/app/api/media/photo-download/route.ts`, likely `src/lib/media-display-name.ts` extension for `getPhotoDownloadName`.

---

## Gotchas for next session

1. **v7 live = v4.** Until operator swaps, none of the 4 CSE commits from today are running. All patches described here are DB-inspectable in code but not yet running in production.
2. **Legacy `photo_NNN.jpg` rows are permanent** unless operator chooses to re-scan SDs. 36,053 UDC London rows affected.
3. **Ambient reconciler is on by default** once v7 deploys (cadence 15 min, silent). If operator wants aggressive: set `upload.reconcileCadenceMinutes = 5`, `upload.reconcileSilent = false`. To disable: set cadence to 0.
4. **Reconciler graceful-degrades against pre-127c2c92 CompPortal shape.** CompPortal IS at 127c2c92 as of 15:01 EDT today — but if CompPortal production hasn't redeployed, reconciler will log a warning and run photos-only. Verify CompPortal production is caught up before running v7.
5. **Thumb-only backfill path not wired** (T-V7-27). If DB shows photo present but thumbnail NULL, reconciler logs at info. For bulk backfill, use CompPortal `POST /api/cd/regenerate-thumbs` button.
6. **Job-queue persistence debounce** — 500ms save cadence on enqueue; flushSync on terminal transitions (running/done/failed). Crash in the 500ms window loses up to one batch. Trade-off documented in `/tmp/cse-auto-batch3-notes.md`.
7. **CLAUDE.md PHOTOMATCH protocol was extended today** — don't invent filename classifications without asking.
8. **Stray files in repo root** (should be gitignored): `.ccbot-uploads/`, `.claude/`, `compsync-state.json`, `docs/postmortems/`, `index*.js`, `meters-*.png`, `preview-full.png`. Cleanup in a future pass.
9. **CompPortal flip Task 2 still in-flight at wrap-up**. Check tmux 6 for completion; expected commit subject `feat(media): friendly-rename photos at download time (ZIP + single-photo)`. If hybrid hangs or errors, Task 2 may need a nudge.
10. **Short-take-discard proposal is DORMANT.** Operator didn't respond to tmux 6's proposal. If resurrected, split per tmux 6's plan (see "Remaining open work" → "Cross-repo").

---

## See Also

- `/tmp/cse-auto-batch3-notes.md` — reconciler task log
- `/tmp/hybrid-batch-notes.md` — CompPortal-side audit + commits
- `docs/plans/2026-04-19-weekend-retrospective.md` — full weekend retro
- `docs/plans/2026-04-19-R529-R530-recovery.md` — re-record chaos playbook
- `/home/danman60/projects/CompPortal/docs/plans/2026-04-20-naming-convention-audit.md` — naming audit report
- `INBOX.md` — 2026-04-19 19:08 EDT post-show UPLOAD_ALL stall incident write-up
