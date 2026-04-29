# Current Work — CompSyncElectronApp

**Status: 2026-04-29 ~09:25 EDT (Wednesday). Burlington 2 days away. Item 17 deployed + smoke-tested live; fix-list in progress.**

Branch: **`master`** (operator chose master; `feat/sd-import-overnight` retired).

---

## Live deploys today

| Time (EDT) | Asar build | Notes |
|---|---|---|
| 08:32 | first overnight deploy | items A1, A15, A19, A35, A37/38, A41, A44, A47, A51, A52, A53/55, A56, A57 + snapshot |
| 09:09 | item 17 round 1 | take-immutable + click-to-reassign + 999-overflow + SAVE AS EMPTY |
| 09:18 | item 17 fix round 1 | 3.5-position fix, sticky header, audio-banner consolidation |

DART backups (rollback path):
- `app.asar.bak.20260429-091847` — pre-09:18 deploy (item 17 v1)
- `app.asar.bak.20260429-090937` — pre-09:09 deploy (pre-item-17)
- `app.asar.bak.20260429-083148` — pre-08:32 deploy (Apr-25 baseline)

DART state cleared this morning: `job-queue.json` = `[]`, `compsync-state.json` removed (loads TEST2026 fresh on boot).

---

## Verified working in production (this morning, on TEST2026)

✅ **Item 17 take-immutable + click-to-reassign — full E2E proven:**
Operator started recording on R1, clicked R2 mid-record, confirmed reassign, stopped → R1 reverted to pending, R2 finalized as recorded with the original 13:10:08 start time. machine_logs trace at 09:10:08–09:10:33 EDT confirms `take: wrote`, `reassignActiveTake: reverted 1 to pending`, `retargeted to 2`, `take: cleared` cleanly.

✅ **Items 1–16 from the autonomous run** (deployed 08:32, no regressions reported)

---

## Open fix list (from 09:11–09:25 EDT smoke)

| # | Issue | State | Fix landed in | Notes |
|---|---|---|---|---|
| F1 | Empty-routine "3.5" jumped to bottom | ✅ FIXED | commit `76a71dc` | splice after R3 |
| F2 | Sticky table header didn't stick when scrolling | ✅ FIXED | commit `76a71dc` | overflow:hidden was breaking sticky |
| F3 | Audio audit banners too aggressive (9 floats stacked) | ✅ FIXED | commit `76a71dc` | one top-banner per routine + Dismiss all |
| F4 | All HardeningBanners need "Dismiss all" when multiple fire | 🟡 CODED, NOT DEPLOYED | uncommitted in App.tsx | needs build + redeploy |
| F5 | X symbol shows when hovering a row | 🚫 OPEN | — | Claude couldn't locate via grep; needs operator screenshot showing where the X appears |

---

## Open / blocked items NOT in active fix list

| # | Item | State | Notes |
|---|---|---|---|
| A40 | Dual-counter regression | 🚫 BLOCKED | meaning of "dual counter" unclear in transcript; needs operator clarification |
| A1 | SD pre-check fix | ⏳ DEFERRED VERIFICATION | code shipped + verified in bundle; needs real SD-insert event to smoke (Burlington) |
| Item 17 sweep | Boot-time stale-take recovery UI | ⏳ thin slice | currently logs + clears; future: surface a "recover MKV" button if file present |
| A35 server side | CompPortal /api/plugin/routine-status[-bulk] | ⏳ separate session | CSE side queues jobs that 404 until portal lands |

---

## Plan hierarchy (read in this order)

1. **`docs/plans/2026-04-26-fix-plan.md`** — the BIG plan. 1756 lines, post-mortem-driven, Phase 1–5, operator North Star, full goal-backward derivation. This is the ground-truth multi-point plan; everything else descends from here.
2. **`docs/plans/2026-04-28-burlington-prep-approved.md`** — the SUBSET locked for the Burlington autonomous run. 17 items, smaller scope, all decisions locked across 30 questions on 2026-04-28.
3. **`docs/plans/2026-04-28-operator-issues-status.md`** — the 103-row operator-issues table (A1-A56 + B1-B40). This is the running ledger of every operator complaint with shipped/open/blocked status and commit references.
4. **`docs/plans/2026-04-26-photo-import-incident.md`** + **`docs/plans/2026-04-26-rerecord-redesign.md`** — input docs that drove the big plan.
5. **`docs/plans/2026-04-28-incident-r199-judge-audio-loss.md`** — UDC Toronto judge-audio incident (not recoverable; documented).

This CURRENT_WORK.md is the deploy + fix-loop scratchpad. Items by ID (A1, A52, etc.) cross-reference back into 1+2+3.

## Coverage relative to the big plan (2026-04-26-fix-plan.md)

The Burlington prep run (item 1+2 above) deliberately picked the highest-impact small wins from each phase of the big plan — NOT the entire phase. So phases are mostly partial-shipped:

| Big-plan phase | Item count | Status |
|---|---|---|
| **Phase 1** (Detection & Escape valves) | ~10 | A35 (scratch-notify CSE-side) + A56 (pipeline chip) shipped. Phase 1.4 (lying-success toast), 1.5 (queue-bulk-prune UI), 1.6 (clear-on-startup option), CompPortal CD no-flow banner — NOT in this run. |
| **Phase 2** (Watermark + matcher invariants + take-immutable) | ~8 | A1 (SD pre-check mtime fix) + Item 17 (take-immutable + click-to-reassign + 999-overflow + SAVE AS EMPTY) shipped. Phase 2.7 (DB partial unique index) — operator deferred. Watermark generalization for NAP_/Q53A bodies — NOT in this run. |
| **Phase 3** (NORTH STAR UX) | ~6 | A15 (Scanning→Matching→Copying→Queueing→Safe to remove + No new photos toast) shipped. Top-left chip + escalating mismatch banners — NOT in this run. |
| **Phase 4** (Re-record drama, Phase-1-of-rerecord-redesign) | ~5 | None — entirely deferred. |
| **Phase 5** (long tail) | ~10 | A53/A55 (audio audit) + A56 (pipeline detector slice) shipped. Timezone contract / asar packaging / R2 reconcile — NOT in this run. |

**What's NOT yet shipped from the big plan** (paraphrased priority items the next session should re-evaluate against Burlington-readiness):

- Phase 1.4 — Lying-success toast fix (the "Import Complete" toast that fires when match returns, not when files copy). A15 covers part of this; the "lying" wording fix may still need one more pass.
- Phase 1.5 — Job-queue bulk-prune UI button.
- Phase 1.6 — Queue clear-on-startup setting (operator escalation 2026-04-27 12:01 EDT).
- Phase 2.4 — Watermark per (volume-serial, body-key) instead of just body. NAP_/Q53A/Pxx camera-body regex generalization.
- Phase 2.6 — Manual `PHOTOS_IMPORT` IPC routed through the same watermark/dedup path as auto-import.
- Phase 2.8 — Immutable take-windows: PARTIALLY shipped (Item 17 took the data-model + UI piece; the matcher-side awareness of historical take windows is still on the table).
- Phase 3 NORTH STAR top-left chip is NOT yet built (A15 ships staged pill in the existing header pill location, not the spec'd top-left chip surface).
- Phase 4 entire — re-record decision modal redesign per `2026-04-26-rerecord-redesign.md`.

## Next session pickup contract

You're walking into this fresh. Read the plan hierarchy above + this file.

### Immediate actions (in order)

1. **Build asar** (already coded, just needs build+deploy):
   - Uncommitted F4 ("Dismiss all" on HardeningBanners) is in `src/renderer/App.tsx`. `git status` will show it.
   - Stage + commit it as a separate commit.
   - Run `npx electron-vite build && npx electron-builder --win --dir`
   - Output: `release/win-unpacked/resources/app.asar`
2. **Wait for operator close-app + "go"**, then deploy:
   - Backup existing asar with timestamped `.bak`
   - `scp release/win-unpacked/resources/app.asar dart:/Users/User/AppData/Local/Temp/app.asar.new`
   - `ssh dart "powershell -NoProfile -Command \"Move-Item ... -Force\""`
3. **Ask operator for the X-on-hover screenshot** (F5). Without that, I can't locate the bug.
4. **Continue fix loop** — operator surfaces issues, I fix on master, rebuild, redeploy. Each asar swap = its own gated "go".

### Hard rules carried forward

1. NEVER block start of a recording.
2. NEVER kill user-facing processes (operator closes the app for asar swaps).
3. Asar swap is its own gated action — never bundle with other writes.
4. **PowerShell JSON writes for Node.js consumers must be no-BOM** — incident 2026-04-29 08:31 wiped settings; memory entry exists.
5. NEVER self-invoke /fresh / /wrap-up / /compact unless operator explicitly says so. Operator did say so this round.
6. NEVER push on smoke-test failure.

### Diagnostics on DART

- machine_logs: Supabase project COMPSYNC, table `machine_logs` (cols `ts`, `level`, `source`, `message`)
- Debug HTTP server: `http://127.0.0.1:8765/debug` on DART, accessible via SSH-PowerShell `Invoke-WebRequest`
- Routes: `/debug/state`, `/debug/queue`, `/debug/routines`, `/debug/health`, `/debug/logs`, `/debug/events`

### Files touched in this session you'll see git history on

- `src/main/services/take.ts` (new — item 17 persistence)
- `src/main/services/recording.ts` (handleRecordingStarted/Stopped — take wiring + overflow fallback)
- `src/main/services/state.ts` (assignOverflowRoutineForTake, reassignActiveTake)
- `src/main/services/pipelineHealth.ts` (A56)
- `src/main/services/ffmpeg.ts` (A53/A55 audio audit)
- `src/main/services/driveMonitor.ts` (A1 mtime-sort)
- `src/main/services/compPortal.ts` (A35 scratch-notify drain)
- `src/main/services/photos.ts` (A15 staged emit)
- `src/main/services/jobQueue.ts` (A35 prune exempt scratch-notify)
- `src/renderer/App.tsx` (mounts, HardeningBanners + Dismiss all uncommitted)
- `src/renderer/components/AudioAuditBanner.tsx` (rewritten 09:13 — top banner consolidation)
- `src/renderer/components/PipelineHealthChip.tsx` (new — A56 chip)
- `src/renderer/components/ReassignPopover.tsx` (new — item 17 / A54)
- `src/renderer/components/RoutineTable.tsx` (THUMB/KEY columns + handleJumpTo branch + A44)
- `src/renderer/components/Controls.tsx` (A41 NEXT-disable + SAVE AS EMPTY label)
- `src/renderer/components/Header.tsx` (A15 pill verbs + chip mount)
- `src/renderer/components/EndOfDayModal.tsx` (A37)
- `src/main/services/dayChecklist.ts` (A37)
- `src/shared/types.ts` (Take, AppSettings.audioAudit, IPC channels)
- `src/preload/index.ts` (recordingReassignTarget, dayChecklist*, etc.)
- `src/main/ipc.ts` (RECORDING_REASSIGN_TARGET handler)
- `src/main/index.ts` (pipelineHealth init + stale-take detect on boot)

### Build pattern

```bash
rm -rf out release/win-unpacked release/builder-debug.yml
npx electron-vite build && npx electron-builder --win --dir
# Output: release/win-unpacked/resources/app.asar (~132 MB)
```

`npm run dist` triggers `predist` which fails on `dotnet not found` (WPD helper). Skip predist; the existing `tools/wpd-helper/bin/wpd-helper.exe` placeholder is fine — DART's deployed app has the real binary alongside the asar.

---

## Burlington countdown

2026-04-29 09:25 EDT — **2 days, 14 hours** until Burlington 2026-05-01 doors. Fix loop is the priority; item 17 take-immutable changes the recording hot path so smoke-test thoroughly before Friday.
