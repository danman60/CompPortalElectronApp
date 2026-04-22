# Current Work — CompSyncElectronApp

**Authoritative handoff** → `docs/plans/2026-04-20-session-consolidated-wrapup.md`

Consolidates three parallel 2026-04-20 sessions (main chat + tmux 4 cse-auto + tmux 6 hybrid). Read it first.

## One-line status
v8 asar built, swapped live on DART, and verified by md5. Main app now has a media-audit panel + EOD verification export; upload priority is configurable; scratched routines are first-class; overlay floating panels can be hidden per session and reappear on next overlay launch with saved positions.

## Operator's next action
Restart CompSync Media on DART to load the new live asar.

## v8 deploy details
- **Built**: `release/win-unpacked/resources/app.asar`
- **Live on DART**: `C:\Program Files\CompSync Media\resources\app.asar`
- **Live md5**: `E4D27B6D695DFE14F2066996DAD651E7`
- **Rollback backup**: `C:\Program Files\CompSync Media\resources\app.asar.bak-v8-2026-04-22-0259-preswap`

## Filename preservation chain — end-to-end GREEN
1-8 via v7 CSE + CompPortal plugin/complete ✅
9-10 via CompPortal commits `345d2527` + `3b023063` ✅

## Landed in this pass
- Main-window media audit panel with clickable routine drilldown, visible notes, manual audit button, and end-of-day verification export.
- Auto-upload remains the master gate for ambient reconcile and idle self-heal.
- Upload queue now supports configurable photo priority; default is newest-first.
- Row-status cleanup distinguishes video-only vs all-media completion.
- Scratched routines no longer pollute recording windows / EXIF matching and can be toggled from table + controls.
- Overlay panels all have per-session hide `X` buttons; hidden panels return next overlay launch while bounds persist.

## Remaining open work
- #13 worker-thread refactor (deferred, dedicated session)
- T-V7-27 thumb-only backfill IPC (future; reconciler logs gap at info)
- Short-take-discard feature (proposed by tmux 6, NOT greenlit)
