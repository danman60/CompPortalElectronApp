# Durable media-completion (F1+F2) — built, proven, NOT integrated

**Date:** 2026-05-17 ~14:03 EDT. **Status:** code complete + proof-harnessed in an isolated worktree. NOT staged, NOT swapped, NOT committed to `feat/ui-redesign-pass1`. Post-show, operator-gated.

## Why
CompPortal inbox 2026-05-17 12:48 + handoff `~/projects/CompPortal/docs/issues/UDC_2026-05-17_media_finalize_failure.md`. Verified root cause (cause (a), dual-source + primary-source spot-check on R546): CSE terminal `/api/plugin/complete` video payload is built only from in-memory `routineState.encodedFiles[].uploaded/storagePath`, persisted only AFTER `callPluginComplete` 2xx; lost across `Restored state … 548/548` reloads between video R2 PUT and terminal call → terminal never fires (3/4) or fires photo-only (R486, 1/4). 28 routines/24h stuck `pending`, parent-facing, silent, recurs every event.

## What was built
- **F1** — `persistDurableStoragePaths()` writes `{uploaded:true, storagePath}` to durable `encodedFiles[]`/`photos[]` (`state.updateRoutineStatus` + `state.saveStateImmediate()`, not the 500ms debounce) BEFORE `callPluginComplete`. Reload between R2 PUT and terminal complete keeps the video↔path association on disk.
- **F2** — durable `Routine.videoCompletePending`(+`Since`) marker stamped when any video role has a storage path; cleared only on server success that carried a video role. `refireUnfinalizedCompletions()` extended into `mediaReconciler` post-reconcile (boot + ambient + manual + post-record) rebuilds the full payload purely from durable state (zero job-queue dependency) and re-fires with per-routine backoff. Idempotent, no empty re-publish, no double-publish. Visual-only "Awaiting finalize" count in `MediaAuditPanel` + EOD report — no audio/Notification, no modal, never gates recording.

## Files (additive, +883, 0 deletions)
`src/shared/types.ts` (+23) · `src/main/services/upload.ts` (+322) · `src/main/services/mediaReconciler.ts` (+19) · `src/main/services/state.ts` (+9) · `src/renderer/components/MediaAuditPanel.tsx` (+5) · `tests/durable-media-completion/harness.mjs` (+505, new proof harness).

## Proof (same fixture R486, opposite outcomes; verdict from real persisted compsync-state.json + captured POST bodies)
- F1 unpatched: terminal `files={photos:[…]}`, no performance/judge → bug reproduced. F1 patched: performance+judge1-3 = R2 keys (4/4).
- F2 unpatched: marker=0 scanned=0 completes=0 → never re-finalized. F2 patched: marker survives 500 (retained) → 2xx (cleared=1), payload carries video, 3rd sweep scanned=0 (no double-publish).
- 16/16 assertions PASS, `npx electron-vite build` exit 0, encoder grep (`h264_cuvid`/`hwaccel cuda`/`hwaccel_output_format`) = 0 in built bundle + all changed files. `ffmpeg.ts` untouched.

## Durable artifacts
- Patch: `docs/plans/2026-05-17-durable-media-completion-F1F2.patch` (46 KB, `git diff --cached --binary` vs base `7a0baf8`, includes the new harness).
- Worktree (live until cleaned): `.claude/worktrees/agent-a584c5b165b150398`, branch `fix/durable-media-completion`, HEAD at base `7a0baf8` (changes staged, uncommitted).

## ⚠ Post-show integration caveat (do NOT naive-apply)
Patch base = committed `7a0baf8`. The shared `feat/ui-redesign-pass1` tree has Codex's UNCOMMITTED deltas in some of these same files (state.ts, types.ts, upload.ts — the staged 82C34FC0 encode-deadlock work). A naive `git apply` onto the live tree can conflict. Post-show fold-in must: (1) wait until the encode-deadlock swap is resolved, (2) coordinate with Codex (shared tree), (3) 3-way merge or re-derive F1+F2 against the then-current tree, (4) rebuild a SEPARATE asar, (5) operator-gated swap — never bundled with the encode-deadlock asar.

## Primary fix is CompPortal's
CompPortal notified (INBOX) to ship the server-side R2→DB reconciler as the cause-agnostic PRIMARY net (recovers the 28 already-stuck + every future event regardless of CSE). F1+F2 is the secondary client hardening; the two converge.
