# Current Work - CompSync Electron App

## Last Session Summary
Set up remote production diagnostics infrastructure. Created `~/projects/compsync-dart-ops/` with CLAUDE.md, hotfix-deploy.sh, rollback.sh, and health-check.sh for live SSH-based diagnostics and hotfix deployment to DART during production. No code changes to the app itself.

## What Changed

### New project: compsync-dart-ops
- `~/projects/compsync-dart-ops/CLAUDE.md` — full ops runbook (SSH commands, app architecture, log scopes, state files, safety rules)
- `~/projects/compsync-dart-ops/scripts/hotfix-deploy.sh` — build on SpyBalloon, deploy asar to DART via SSH
- `~/projects/compsync-dart-ops/scripts/rollback.sh` — restore .bak or v2.7.0-stable
- `~/projects/compsync-dart-ops/scripts/health-check.sh` — full app health snapshot via SSH
- All scripts use `dart-win` (native Windows SSH, port 22) — no WSL dependency

### Uncommitted (carried forward from prior sessions)
- `src/main/services/overlay.ts` — bind host fix
- `src/main/services/recording.ts` — recording pipeline changes
- `src/main/services/tether.ts` — tether refactor
- `src/main/services/upload.ts` — upload targeting improvements
- `src/renderer/components/RightPanel.tsx` — removed unused section
- `src/renderer/components/RoutineTable.tsx` — table updates
- `src/renderer/components/TetherStatus.tsx` — status display changes
- `src/renderer/styles/header.css` — header styling
- `AGENTS.md`, `CLAUDE.md` — minor updates

## Build Status
NOT RUN this session — no app code changes

## Known Bugs & Issues
- **WS disconnected on tablet**: Firewall rules added for TCP 9877 / UDP 5000-5002. Needs retest.
- **Touch injection not working**: wifi-display-server needs elevation if OBS runs as admin
- **Sharp thumbnails broken on Windows**: `TypeError: A boolean was expected` — disabled, pre-existing

## Incomplete Work
- 13 files with uncommitted changes from prior wifi-display sessions (see git status)
- Touch injection elevation fix
- WS connection verification after firewall fix
- Tablet button functionality verification

## Tests
- No tests run this session
- QA agent checklists not updated for tablet feature

## Next Steps (priority order)
1. **Commit uncommitted changes** — 13 modified files from wifi-display work, review and commit
2. **Verify WS connects after firewall fix** — restart CS on DART, check tablet
3. **Fix touch injection** — spawn wifi-display-server elevated if OBS is admin
4. **Test all 11 tablet buttons** — end-to-end verification
5. **Production dry-run** — power on DART, run health-check.sh, verify ops workflow

## Gotchas for Next Session
- DART is currently offline (last seen 2d ago as of 2026-04-06)
- `dart-win` is the only SSH host to use during production (no WSL)
- Rollback tag: `v2.7.0-stable` = commit `11b97af`
- compsync-dart-ops is a separate project, not inside CompSyncElectronApp

## Files Touched This Session
None in CompSyncElectronApp — all work was in ~/projects/compsync-dart-ops/
