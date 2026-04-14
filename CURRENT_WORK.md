# Current Work — CompSyncElectronApp

## Next session priority: AUTONOMOUS E2E TESTING ON EMPWR-LONDON

The user wants extensive end-to-end user-flow testing of the Electron app, autonomously, using the EMPWR Dance - London competition. Use the `test-electron` skill (per CLAUDE.md guidance) to launch a separate Claude session that runs the actual Electron app in a Windows context and drives it via Playwright Electron API.

### Test target

| Field | Value |
|---|---|
| Competition | EMPWR Dance - London |
| Share code | `EMPWR-LONDON` |
| Tenant ID | `00000000-0000-0000-0000-000000000001` |
| Competition ID | `79cef00c-e163-449c-9f3c-d021fbb4d672` |
| Entries | 562 (559 with `performance_time`) |
| Other EMPWR codes | `EMPWR-STCATH-1`, `EMPWR-STCATH-2` (smaller, secondary) |

### What to test (priority order)

1. **Cold load via share code**
   - Launch app, enter `EMPWR-LONDON` in share code field, click load
   - Verify: 562 routines load, day filter populated, no errors in main process log
   - Screenshot the loaded state
   - **Expected limitation:** `Time` column may show em-dashes if CompPortal brief (b) is NOT yet deployed. That's a known state, not a bug. If CompPortal deployed, expect HH:MM values.

2. **Navigation + filtering**
   - Day filter dropdown
   - Search box (entry number, title, studio, dancer)
   - Click row → jump-to-routine
   - Verify current routine highlight, current routine card update
   - Pipeline stage column (REC/SPLIT/PHOTO/UP) icons render

3. **Reconcile pass dry-run**
   - On load, look in main process log for "[DRY RUN] would demote" entries
   - For EMPWR-LONDON which has zero media_packages, no routines should be eligible (all start `pending`, no `uploaded`/`confirmed` to demote)
   - **Expected:** zero dry-run lines. If any appear, that's a bug.

4. **Record/encode/upload pipeline** (requires OBS + CompPortal up)
   - **SKIP unless OBS is actually running on the test machine.** Don't try to mock — the OBS WebSocket integration is too tightly coupled.
   - If OBS is up: pick one routine, click record button, verify status transitions: pending → recording → recorded → encoded → uploading → uploaded
   - Verify `compsync-state.json` persists state correctly between transitions
   - Verify the upload pipeline calls `/api/plugin/upload-url` with a `uploadRunId` field (Phase 4 change — not yet wired to server, will be ignored harmlessly)

5. **Settings panel**
   - Open settings, verify all sections render without errors
   - Tablet display section, OBS settings, FFmpeg settings, branding, etc.
   - Don't change anything destructive

6. **Wifi tablet display, overlay, hotkeys**
   - Smoke test only — open each panel, verify it renders, close. Don't actually start the wifi server or fire hotkeys.

### What NOT to test

- Real OBS recording (unless OBS is set up on the test machine)
- Real upload to CompPortal (would create real DB rows on production)
- Bulk operations that hit the network
- Anything that might leave state behind in the user's main `compsync-state.json` — use a temporary userData dir for tests if possible

### How to actually run this

Per CLAUDE.md, use the `test-electron` skill:
> Launch a new Claude Code (Opus) session in a separate tmux window to test an Electron app. Syncs to Windows filesystem, runs tests via cmd.exe with Playwright Electron API, verifies DB via Supabase MCP.

The fresh session should:
1. Read this CURRENT_WORK.md fully
2. Read the test target details above
3. Invoke `test-electron` skill to spawn the Windows-side test session
4. Brief that session with: share code, comp id, the 6 priority tests above, and the "what NOT to test" guardrails
5. Stay in the loop, watch results, document bugs in a fresh `tests/reports/empwr-london-e2e-2026-04-14.md` file
6. Report back findings

## Holdover items (from prior session, not blocking)

1. **Manual: enable R2 bucket lock** (~30 sec):
   - Cloudflare → R2 → `compsyncmedia` → Settings → Bucket lock rules → Add rule
   - Prefix: `00000000-0000-0000-0000-000000000004/`
   - Retention: 365 days
   - Verified from Cloudflare R2 docs: prevents delete + overwrite, prefix-scoped, retroactive

2. **compSync window (claude:3) is on hold** with Tier B + brief (b) uncommitted, type-clean:
   - Soft-delete columns + deleted_at filters everywhere
   - deletePhoto soft-delete
   - Schedule endpoint `mediaPackageStatus`/`mediaUpdatedAt`/`scheduledTime`
   - User decides push/hold. If push → Vercel auto-deploy → Time column populates.

3. **Phase 4 Electron changes** are now committed (this session). `RECONCILE_DRY_RUN = true` in `src/main/services/state.ts`. Flip to false ONLY after watching one real share-code reload in dry-run mode and confirming the demote log is empty/correct.

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
