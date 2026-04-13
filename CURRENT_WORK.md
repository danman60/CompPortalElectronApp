# Current Work — CompSyncElectronApp

## Last Session (2026-04-13)

Media-loss-prevention + time-of-day column. Decided to defer plugin/complete rewrite until end-to-end testing is possible. Real protection comes from manual R2 bucket lock (see below).

## Committed this session
- Phase 4 Electron changes: `uploadRunId` per attempt, reconcile pass with `RECONCILE_DRY_RUN = true`, types
- Time column in RoutineTable showing `scheduledTime` (HH:MM)

## DO NEXT (priority order)

1. **YOU: enable R2 bucket lock** (~30 sec, no code):
   - Cloudflare → R2 → `compsyncmedia` → Settings → Bucket lock rules → Add rule
   - Prefix: `00000000-0000-0000-0000-000000000004/`
   - Retention: 365 days
   - Closes the only real media-loss path (silent overwrite on retry). Verified from Cloudflare R2 docs — bucket lock prevents both delete and overwrite, prefix-scoped, retroactive.

2. **YOU: decide compSync push** (claude:3 tmux window is on hold):
   - compSync has Tier B + brief (b) ready and type-clean: soft-delete columns, deleted_at filters everywhere, deletePhoto soft-delete, schedule endpoint `mediaPackageStatus`/`mediaUpdatedAt`/`scheduledTime`
   - Tell compSync "push" or "hold"
   - If push, Vercel auto-deploys CompPortal → Time column in this app starts populating

3. **NEXT SESSION: flip RECONCILE_DRY_RUN to false** in `src/main/services/state.ts` only after compSync deploys AND you've watched one share-code reload in dry-run mode and confirmed the demote log looks correct.

## Deferred (do not build without explicit OK)

- **plugin/complete rewrite** (immutable upload paths, photo merge-by-filename, audit log writes) — held until end-to-end testing is possible. Tier B + bucket lock is the interim protection.
- **Temp routine feature** — has 3 open design questions (entry number scheme, stub field defaults, promote-to-scheduled). See `CompPortal/INBOX.md`.

## Known residual risks (after bucket lock + Tier B)

- `/api/plugin/complete` photos `deleteMany` still destructive — only fires if Electron sends a SHRUNK photo list. Document operator workflow: don't re-trigger photo uploads after first success. Monitor `media_photos` row counts during first real UDC.
- Cross-tenant read in `src/app/api/mobile/v1/[...path]/route.ts` (CompPortal) — read-only, not a loss path. Separate security item.
- No audit log writes yet (`plugin_write_log` table exists, empty).

## State elsewhere

- **Supabase COMPSYNC**: Phase 2 migrations applied (deleted_at columns, FK RESTRICT, plugin_write_log table). Do NOT re-run.
- **CompPortal**: Tier B + brief (b) uncommitted in compSync window (claude:3). 16 modified files. Type-clean per compSync.
- **`/home/danman60/projects/CompPortal/INBOX.md`**: contains 3 briefs for compSync. Item 1 (Phase 3 full) deferred. Item 2 (brief b) done. Item 3 (temp routines) deferred.

## Pre-existing modified files NOT touched this session

~31 files from prior sessions (SS editor, tablet display, OBS, tether, etc.). Do NOT commit accidentally. Filter commits by explicit file path.
