# B1+B2 — 4700/queue fix + durable media-completion (built, proven, NOT integrated)

**2026-05-19 ~14:06 EDT.** Built+proven in isolated worktree. NOT staged/swapped/committed. Patch base = committed `7a0baf8` (clean apply, zero conflicts — that worktree was pinned to the patch base; the dirty `feat/ui-redesign-pass1` tree may still conflict on fold-in).

## Durable artifacts
- Patch: `docs/plans/2026-05-19-post-cobourg-B1B2.patch` (84 KB, `git diff --cached --binary 7a0baf8`, excludes node_modules; includes both harnesses).
- Worktree (live until cleaned): `.claude/worktrees/agent-ae5ae7d8b6735ef48`, branch `fix/post-cobourg-batch`, HEAD `7a0baf8` (staged, uncommitted).
- Supersedes/absorbs `docs/plans/2026-05-17-durable-media-completion-F1F2.patch` (B2 = that F1+F2, applied clean here).

## Files (1566 insertions, 9 deletions, 7 source + 2 harness)
`src/shared/types.ts` +23 · `src/main/services/upload.ts` +462 · `src/main/services/jobQueue.ts` +96 · `src/main/services/mediaReconciler.ts` +19 · `src/main/services/state.ts` +9 · `src/main/index.ts` ±32 · `src/renderer/components/MediaAuditPanel.tsx` +5 · `tests/post-cobourg-queue/harness.mjs` +424 · `tests/durable-media-completion/harness.mjs` +505.

## What it does
- **B2 (F1+F2)** — F1 persists per-role `encodedFiles[].uploaded/storagePath` durably at R2-PUT confirm (before callPluginComplete). F2 `Routine.videoCompletePending` marker + `refireUnfinalizedCompletions()` in mediaReconciler post-reconcile re-fires callPluginComplete from durable state until server published; visual-only "Awaiting finalize" in MediaAuditPanel (no audio, no modal, never gates recording).
- **B1(a)** `index.ts:202-262` + new `upload.ts getUndeliveredMediaSummary()` — close dialog reports distinct un-delivered media (durable F1/F2 oracle), not raw `getPending+getRunning`; awaitingFinalize + terminalJobs shown as non-blocking asides; log records honest + raw.
- **B1(b)** `upload.ts` enqueue sites + `jobQueue.hasActiveOrDeliveredUploadJob()` — dedupe every enqueue against durable-uploaded state + done jobs (kills the duplicate re-enqueue storm); `force=true` re-record still passes.
- **B1(c)** `jobQueue.pruneTerminal()` — hard ceiling (recent-N AND age) on failed/quarantined/cancelled, wired into init() boot + hourly; pending/running/done never touched. (Hard-ceiling not "OR" because the live 967-carcass incident was all <24h in one show day.)

## Proof (real-module esbuild, verdict from real persisted compsync-state.json/job-queue.json)
- B1(a): UNPATCHED close count **1509** → PATCHED **6** genuinely-undelivered; 200 carcasses reported separately not in headline.
- B1(b): dup (routine,objectName) → 1 job/0 dup; already-uploaded → 0 re-enqueue; force=true → still enqueues.
- B1(c): 200 terminal → pruned 0, idempotent, pending/done untouched.
- B2: 16/16 (F1 payload carries video post-restore; F2 marker survives 2 restarts, clears on 2xx, no double-publish).
- 14/14 + 16/16, `npx electron-vite build` exit 0, encoder grep 0 (bundle + source). ffmpeg.ts untouched.

## ⚠ Post-show fold-in caveat
Patch base `7a0baf8`; live `feat/ui-redesign-pass1` has uncommitted deltas in upload.ts/state.ts/types.ts/jobQueue.ts/index.ts. Fold-in: 3-way merge or re-derive against then-current tree, rebuild SEPARATE asar, operator-gated swap — never bundled with the encode-deadlock asar. Re-run BOTH harnesses on the merged tree before any build.
