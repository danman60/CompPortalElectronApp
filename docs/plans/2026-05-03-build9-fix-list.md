# Build #9 fix list — captured 2026-05-03 23:30 EDT

Captured from operator dump post-Burlington UDC Day 3. Tracking per `feedback_track_all_complaints_next_break.md`. Not actionable until operator triages.

## CompPortal — admin dashboard
1. **Full operational parity on admin dash** — admin dash should mirror live operator state (current routine, what's next, schedule, progress). Includes "Starting soon" indicator (shows when next routine is approaching). **CSE-side parity DONE 2026-05-05** — wsHub gained 9 new case branches (`overlayFireLT/HideLT/SetTicker/SetStartingSoon/SetAnimationConfig` + `ssSetConfig/SavePreset/LoadPreset/DeletePreset`); controlRoomBridge `pollCommands` forwards `element` + `payload`; `buildSnapshot` includes `overlay.getOverlayState()` + `getSSConfig()`. CompPortal-side page already shipped (sibling session).

## CSE photo pipeline
2. **Simplify hash matching of photos** — further simplification beyond build #7 dedup elegance. Per-volume hash cache or hybrid (hash only on basename collision) candidates from prior discussion.

## CSE routine table UX
3. **"Move after routine X" button on routine row** — alternative to drag-and-drop for moves across large distances. Drag-and-drop stays for small reorders; button for jumps. **DONE 2026-05-05** — `MoveAfterPopover.tsx` with type-to-filter + keyboard nav, "Move…" button on every row, splices via existing `stateSetDisplayOrder` IPC.
5. **Jump-to instead of filter** — type-to-jump RoutineTable filter (build #7) currently filters the list; operator wants it to scroll-to-match instead, keeping all rows visible. **DONE 2026-05-02** — already shipped: search no longer filters, scrolls first match into view via `scrollIntoView({block:'center'})` (RoutineTable.tsx:689).
14. **Duplicate record-status button — remove** — there's a duplicate "record status" button somewhere (location TBD with operator).

## Unified event log (replaces toast soup)
4. **Event log window** — top-left scrolling panel; replaces toasts; shows photo-import progress, upload rate, encode rate, audio scan results, drive detect/remove, errors, auto-restart events. Currently toasts overlap the Current Routine card. Build #9 backlog item already. **DONE 2026-05-05** — `EventLogPanel.tsx` mounted in Header.tsx topband (far left, 360px width per operator). Live IPC stream from `events.emit()` fanout via `setOnEmit`. New emits: `recording.started/stopped`, `encode.started/completed/failed`, `upload.started/completed/failed`, `auto-toggle.changed`, `reconcile.summary`. Retired toasts: AutoToggleToast / ReconcileToast / StartupToast / ImportSummaryToast. Severity-striped cards, sticky filter chips (Imports / Drives / Encode / Upload / Audio / Record / Chat / Other / Errors), errors chip non-suppressible.
10. **"Import complete" toast → event window** — bottom-right "Import complete" still pops; route into event log. **DONE 2026-05-05** — fed by `import.finished` event; ImportSummaryToast unmounted.
19. **Tablet auto-refresh events into event log** — from Build #9 auto-restart-on-freeze; surfaces only into event log, no toast. **DONE 2026-05-05** — surfaces via `control-room.command.completed/failed` events already wired in controlRoomBridge.

## Session-start reminders
6. **Judge backup audio reminder** — small inline notification on the FIRST routine of a session reminding operator to enable judge backup audio recording.

## Slow zoom + transitions
7. **Perfect slow zoom + more transitions** — frame-perfect path via `obs.callBatch` SerialFrame (build #9 backlog). Also: more transition variety in the cycle list. **DONE 2026-05-05** — superseded by build8 transition system rewrite (Slow Zoom Move-transition w/ duration enforcement, Crash Zoom + blur gate, per-transition duration map).
8. **Crash blur zoom transition** — new transition: blur + zoom-in going from Wide scene to tight, and reverse on return. New transition asset.
16. **Longer full-screen stinger with studio/card logo** — bigger, longer stinger that shows the routine's studio logo or routine card full-screen during the transition. **DONE 2026-05-05** — replaced by Feature Card (build8i+8m), which delivers full-screen UP NEXT / THAT WAS w/ studio logo, brand-logo lockup, beauty pass animations.

## Tablet (Android CSController)
9. **Layout reorg: buttons to top row + cycle transition button, drop logo** — operator wants tablet button layout consolidated to top row, add cycle-transition button, kill the logo space.
15. **Operator app: ticker edit, full parity, program preview?** — operator app needs ticker edit ability, full parity with main CSE controls, and an open question on program-preview surface. **DONE 2026-05-05** — handled in CSController (Android) repo / CompPortal admin livestream parity work — out of CSE scope.

## Overlay (LT / chat / ticker / logo)
11. **Server-side chat pin vs local — both?** — chat pin currently local-only (or unclear); decide whether server-side authoritative pin, local, or both.
12. **LT center-up position / editable** — LT (Lower Third) might actually want to live center-up instead of bottom-left, OR position should be configurable in overlay settings. **DONE** — already shipped: VisualEditor exposes `lowerThird` X/Y/W/H sliders + asset override (VisualEditor.tsx:315, :396, :649). Operator can drag LT to center-up or anywhere via Visual Editor. Default still bottom-left; per-tenant override available.
13. **Ticker state sync app ↔ SD — BUG** — new `OverlayTickerAction` (build #8b) state isn't syncing between app toggle and Stream Deck button visual.
17. **Keep pushing LT / counter animation motion** — continue iterating; more drama.
18. **Looping UDC logo animation** — add a looping animation variant for the UDC logo (currently static or one-shot).

---

## Cross-cuts to flag
- Items 4, 10, 19 all consolidate into the unified event log — single phase.
- Items 7, 8, 16 all transition-system work — single phase.
- Items 9, 15 both Android CSController — single phase.
- Items 11, 12, 13, 17, 18 all overlay-engine — could batch.
- Items 3, 5, 14 all RoutineTable — could batch.

## NOT in this list (already in build #9 backlog from crash transcript)
- HEVC NVENC server rebuild (multi-day Rust)
- Per-button unified-meters role config UX (Property Inspector page)
- In-app slow-zoom button (mirror SD button)
- Hash phase progress UI (the silent EXIF/hash phase)
