# Post-Cobourg Fix Batch — 2026-05-19

**Authorized by operator 2026-05-19 12:42 EDT.** Show over (UDC Cobourg ended 2026-05-17). Batched post-show fixes on an isolated branch; nothing swapped/committed without operator review. Encoder untouched throughout (no `h264_cuvid`/`hwaccel cuda`/`hwaccel_output_format`).

## Structure
- Isolated git worktree branch `fix/post-cobourg-batch`. Live `feat/ui-redesign-pass1` tree + `C:\CompSync-staging` builds stay clean.
- Each code fix: explore → implement → proof-harness (real-module esbuild, before/after, mirror tests/orphan-resume) → `npx electron-vite build` exit 0 → encoder-safety grep 0. No electron-builder/asar/scp/swap/commit until operator review.
- DB write (D1) gated on explicit per-action operator go. State.json patch only app-closed + no-BOM.

## PHASE 0 — Verifications (read-only) — COMPLETE 2026-05-19 ~12:48 EDT
- V1 DONE (uncommitted): slowZoom.ts:56 force-revert→CUT after zoom; wsHub.ts:108 FADE forced 4000ms; obs.ts transition busy-gate. → B9 DROPPED (no build; verify on relaunch only).
- V2 ORDER A (uncommitted): jobQueue.ts:320-328 priority photos selected before videoJobs — matches operator 2026-05-16 lock. No build needed.
- V3 PRESENT (uncommitted): RoutineTable.tsx:893 single-day filter + day dropdown/steppers/AUTO (1045-1073). No build needed.
- Net: all 3 already implemented in working tree, never committed/shipped → raises value of C1 commit.

## PHASE 1 — Data (post-show safe; DB write gated)
- D1 R222/R223 split-routine cleanup. Move 43 photos `media_package_id c40d0848-ee7d-430b-afff-3c0f12645c02` → `d9961024-e887-45ed-893a-0983b31db0b4` WHERE captured_at >= 2026-05-15T20:23:02.463Z AND deleted_at IS NULL. Then DART compsync-state.json (app CLOSED, no-BOM): R222.recordingStoppedAt=2026-05-15T20:23:02.463Z, R223.recordingStartedAt=20:23:02.463Z, R223.recordingStoppedAt=20:26:05.394Z, R223.status=recorded. comp 7f796653-9e5a-4652-8968-21b7d18320fc.

## PHASE 2 — Code builds
- B1 4700 / queue fix: (a) close dialog (src/main/index.ts:217) counts distinct un-delivered media not raw pending+running job records; (b) jobQueue enqueue dedupes against already-uploaded/done before creating a job (kills duplicate re-enqueue storm — verified: same JP7A1830.JPG routine 130 enqueued 13:48 + 17:59, both fail "already exists"); (c) prune terminal failed/quarantined from job-queue.json or exclude from any pending surface. Root cause evidence: upload.ts enqueues photo (line 361) AND thumbnail (420-428) as separate jobs; 779 failed + 165 quarantined accumulate forever; DB 544/545 published proves zero media lost.
- B2 F1+F2 durable media-completion: fold existing `fix/durable-media-completion` (built+proven, docs/plans/2026-05-17-durable-media-completion-F1F2.{patch,md}) into the batch; provides the published/storagePath oracle B1(a) needs.
- B3 BATCH alerts in event log label (operator 2026-05-15: "I want BATCH alerts in that label (5 uploads finished etc)").
- B4 Activity log status tabs — EventLogPanel pivot to routine-state board (Queued/Encoding/Uploading/Uploaded). build9-fix-list.
- B5 Clear-media row action — CSE local archive (_archive/vN, never delete) + state reset + new CompPortal endpoint (set deleted_at on pkg+photos, null video fields). Cross-repo.
- B6 Import pill — DECISION PENDING: no-text .import-pill-dot pulse vs leave (speed fix already in staged build).
- B7 Perf #1 audio-meter — DECISION PENDING: coalesce OBS InputVolumeMeters ingest vs leave (WS already 5Hz throttled).
- B8 R2 archive-on-overwrite — CompPortal src/lib/r2.ts signGuardedUpload force=true overwrites key in place (no versioning, unrecoverable); call copyInR2(key→<key>.archived/<ts>) before signed PUT. CompPortal-only, Vercel deploy.
- B9 Slow-zoom/FADE — only if V1 shows not done.

## PHASE 3 — Close-out (each its own gated action)
- C1 commit/push feat/ui-redesign-pass1 + fix branch — operator go.
- C2 Combined staged build 82C34FC0 — DECISION PENDING: swap post-show / stay ffrevert / rebuild clean.

## STALENESS SWEEP — 2026-05-19 ~12:56 EDT (operator: "some items are stale, check first")
Primary-source verified. STALE/already-in-tree (ship via C1 commit, no build): V1,V2,V3; B3 (EventLogPanel.tsx:47-60,355-389 BATCHABLE_KINDS); B5-CSE (RoutineTable.tsx:915-944 archiveMediaForRoutine + menu:1366); B6 (drive-alert.css:125-131 progressPulse no-text); B7 (obs.ts:87-88 METER_THROTTLE_MS=100 10Hz).
GENUINELY NOT DONE: B1+B2 (running, hard-verified); B4 activity-log status tabs (absent); B5-CompPortal clear endpoint (no route); B8 R2 archive-on-overwrite (r2.ts:282-315 overwrites in place, copyInR2 321-328 unused).
D1 STALE PREMISE — do NOT execute original UPDATE. DB: R222 c40d0848=84 photos cap 05-15 16:19:59-16:25:53 EDT; R223 d9961024=43 photos (NOT 0) cap 05-15 12:23:31-12:25:53 EDT; both published. Windows don't match the "split @20:23:02Z" premise. Awaiting operator on correct end-state. Per photomatch protocol: ask, don't invent.
Re-scoped batch: B1+B2 (running) → B4, B5-CompPortal, B8 → C1 commit (ships all stale-but-coded items). B3/B5-CSE/B6/B7/B9 dropped as already-done. B6/B7 prior "decisions pending" are moot (already implemented).

## Current verified state (primary source 2026-05-19 ~12:37 EDT)
- DB comp 7f796653: 545 pkg, 544 published, 1 pending, 0 missing video, 26,632 photos.
- DART app running (PROC=4). job-queue.json: 967 upload jobs — 779 failed, 165 quarantined, 14 cancelled, 9 pending, 0 running.
- Live app.asar = ffrevert EF44C08F (82C34FC0 reverted 2026-05-17 14:52; preserved at app.asar.bad.20260517-deadlockfix + C:\CompSync-staging\app.asar.new).
- All work uncommitted on feat/ui-redesign-pass1.
