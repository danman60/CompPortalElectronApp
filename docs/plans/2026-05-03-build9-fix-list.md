# Build #9 fix list — captured 2026-05-03 23:30 EDT

Captured from operator dump post-Burlington UDC Day 3. Tracking per `feedback_track_all_complaints_next_break.md`. Not actionable until operator triages.

## CompPortal — admin dashboard
1. **Full operational parity on admin dash** — admin dash should mirror live operator state (current routine, what's next, schedule, progress). Includes "Starting soon" indicator (shows when next routine is approaching). **CSE-side parity DONE 2026-05-05** — wsHub gained 9 new case branches (`overlayFireLT/HideLT/SetTicker/SetStartingSoon/SetAnimationConfig` + `ssSetConfig/SavePreset/LoadPreset/DeletePreset`); controlRoomBridge `pollCommands` forwards `element` + `payload`; `buildSnapshot` includes `overlay.getOverlayState()` + `getSSConfig()`. CompPortal-side page already shipped (sibling session).

## CSE photo pipeline
2. **Simplify hash matching of photos** — further simplification beyond build #7 dedup elegance. Per-volume hash cache or hybrid (hash only on basename collision) candidates from prior discussion. **DONE 2026-05-06 (build9o)** — Option A (volume-keyed EXIF cursor) shipped. Drops sha1(first 128KB) per-file content hashing as primary dedup. Per-card EXIF watermark in `state.sdCardCursors`, keyed by Windows volume serial. Migration safety net seeds cursor from existing routine.photos[] max captureTime on first-touch of unknown card. Unknown-card thumbnail event (`drive.unknownCard`) emits inline base64 96x96 webp via ffmpeg pipe.

## CSE routine table UX
3. **"Move after routine X" button on routine row** — alternative to drag-and-drop for moves across large distances. Drag-and-drop stays for small reorders; button for jumps. **DONE 2026-05-05** — `MoveAfterPopover.tsx` with type-to-filter + keyboard nav, "Move…" button on every row, splices via existing `stateSetDisplayOrder` IPC.
5. **Jump-to instead of filter** — type-to-jump RoutineTable filter (build #7) currently filters the list; operator wants it to scroll-to-match instead, keeping all rows visible. **DONE 2026-05-02** — already shipped: search no longer filters, scrolls first match into view via `scrollIntoView({block:'center'})` (RoutineTable.tsx:689).
14. **Duplicate record-status button — remove** — there's a duplicate "record status" button somewhere (location TBD with operator). **DONE** (operator-confirmed 2026-05-06).

## Unified event log (replaces toast soup)
4. **Event log window** — top-left scrolling panel; replaces toasts; shows photo-import progress, upload rate, encode rate, audio scan results, drive detect/remove, errors, auto-restart events. Currently toasts overlap the Current Routine card. Build #9 backlog item already. **DONE 2026-05-05** — `EventLogPanel.tsx` mounted in Header.tsx topband (far left, 360px width per operator). Live IPC stream from `events.emit()` fanout via `setOnEmit`. New emits: `recording.started/stopped`, `encode.started/completed/failed`, `upload.started/completed/failed`, `auto-toggle.changed`, `reconcile.summary`. Retired toasts: AutoToggleToast / ReconcileToast / StartupToast / ImportSummaryToast. Severity-striped cards, sticky filter chips (Imports / Drives / Encode / Upload / Audio / Record / Chat / Other / Errors), errors chip non-suppressible.
10. **"Import complete" toast → event window** — bottom-right "Import complete" still pops; route into event log. **DONE 2026-05-05** — fed by `import.finished` event; ImportSummaryToast unmounted.
19. **Tablet auto-refresh events into event log** — from Build #9 auto-restart-on-freeze; surfaces only into event log, no toast. **DONE 2026-05-05** — surfaces via `control-room.command.completed/failed` events already wired in controlRoomBridge.
21. **Photo scan: per-DCIM-subfolder pre-read EXIF bookmark (skip before opening)** — **Captured 2026-05-16 19:18 EDT, live UDC Cobourg.** Current volume cursor (photos.ts:1131, build9o item #2) is a POST-read filter: it reads every photo's EXIF DateTimeOriginal then skips those ≤ cursor → a 1000-photo card with 950 already imported still opens+EXIF-reads all 1000 every import (slow; and the source of the 2026-05-16 ENOENT storm — re-reading already-imported files off a flaky reader). Operator requirement: every DCIM subfolder enumerated/scanned independently, but within each folder nothing before that folder's bookmark is opened. Design: watermark keyed by (volumeSerial, DCIM subfolder); sort each subfolder by filename (monotonic camera sequence), skip ≤ watermark filename WITHOUT opening, only EXIF-read files after it; thin boundary re-EXIF band for out-of-order writes; per-subfolder rollover (9999→0001) detection falling back to capture-time cursor for that batch; TZ: filename skip is TZ-immune (primary gate), capture-time cursor compares EXIF (naive camera-local, no TZ) vs cursor in SAME basis — one-time normalization of any UTC-written state.sdCardCursors entries, basis logged per scan. Upgrade to existing cursor, not a rewrite. Not actionable until operator triages window + decides fold-in vs separate follow-up. Relates to [[feedback_sd_import_latest_unimported]].
20. **Activity log: status tabs/views listing routines by pipeline state** — operator wants tabs (or grouped views) in the Activity (Event Log) panel that show *which routines* are currently in each pipeline state — e.g. Queued, Encoding, Uploading, Uploaded — not just the chronological event stream. At-a-glance answer to "what's encoding right now / what's queued behind it / what's still uploading." **Captured 2026-05-16 14:38 EDT, live UDC Cobourg.** Origin: during the post-GPU-fix backlog drain the operator saw a routine sitting "queued for encoding" and had no in-app view of the serial encode queue depth or what state each routine was in — had to ask Claude to read machine_logs. The data already exists (routine state machine: pending→recording→recorded→queued→encoding→encoded→uploading→uploaded; events.emit fanout already feeds EventLogPanel). Not actionable until operator triages. Likely a new tabbed/segmented mode on EventLogPanel that pivots from event-stream to a routine-state board.

## Session-start reminders
6. **Judge backup audio reminder** — small inline notification on the FIRST routine of a session reminding operator to enable judge backup audio recording. **DONE** (operator-confirmed 2026-05-06).

## Slow zoom + transitions
7. **Perfect slow zoom + more transitions** — frame-perfect path via `obs.callBatch` SerialFrame (build #9 backlog). Also: more transition variety in the cycle list. **DONE 2026-05-05** — superseded by build8 transition system rewrite (Slow Zoom Move-transition w/ duration enforcement, Crash Zoom + blur gate, per-transition duration map).
8. **Crash blur zoom transition** — new transition: blur + zoom-in going from Wide scene to tight, and reverse on return. New transition asset. **DONE** (operator-confirmed 2026-05-06; logic shipped build8l).
16. **Longer full-screen stinger with studio/card logo** — bigger, longer stinger that shows the routine's studio logo or routine card full-screen during the transition. **DONE 2026-05-05** — replaced by Feature Card (build8i+8m), which delivers full-screen UP NEXT / THAT WAS w/ studio logo, brand-logo lockup, beauty pass animations.

## Tablet (Android CSController)
9. **Layout reorg: buttons to top row + cycle transition button, drop logo** — operator wants tablet button layout consolidated to top row, add cycle-transition button, kill the logo space.
15. **Operator app: ticker edit, full parity, program preview?** — operator app needs ticker edit ability, full parity with main CSE controls, and an open question on program-preview surface. **DONE 2026-05-05** — handled in CSController (Android) repo / CompPortal admin livestream parity work — out of CSE scope.

## Overlay (LT / chat / ticker / logo)
11. **Server-side chat pin vs local — both?** — chat pin currently local-only (or unclear); decide whether server-side authoritative pin, local, or both. **DONE end-to-end 2026-05-06 (build9o + CompPortal commit 1fadb9ea).** Operator-clarified as TWO destinations. CSE: `LivestreamPinnedMessage` type, `CHAT_LIVESTREAM_PIN/UNPIN` IPC, two-button pin UI (📹/🌐), `chatBridge.livestreamPinMessage/Unpin` POST/DELETE. CompPortal: POST/DELETE `/api/plugin/chat/{id}/livestream-pin`, GET `/api/livestream/livestream-pinned?competitionId=X` backfill, `LivestreamPinOverlay` component on `/livestream` page, postgres_changes Realtime channel `livestream-pins:<competitionId>`, `livestream_chat_messages.livestream_pinned_at` column + partial index, independent 10-pin cap, idempotent POST/DELETE.
12. **LT center-up position / editable** — LT (Lower Third) might actually want to live center-up instead of bottom-left, OR position should be configurable in overlay settings. **DONE** — already shipped: VisualEditor exposes `lowerThird` X/Y/W/H sliders + asset override (VisualEditor.tsx:315, :396, :649). Operator can drag LT to center-up or anywhere via Visual Editor. Default still bottom-left; per-tenant override available.
13. **Ticker state sync app ↔ SD — BUG** — new `OverlayTickerAction` (build #8b) state isn't syncing between app toggle and Stream Deck button visual. **OPERATOR-CLARIFIED 2026-05-06:** UI quirk — turning the ticker ON via Stream Deck button drifts out of on/off state sync with the local CSE app. Likely SD-action send path doesn't await the state echo before flipping its visual, OR app toggle doesn't broadcast back to SD. Single-trace fix; one round-trip of state from CSE → SD after every SD-initiated toggle.
17. **Keep pushing LT / counter animation motion** — continue iterating; more drama. **DONE** (operator-confirmed 2026-05-06; counter advance 6-variant premium pack + LT iteration shipped build8n).
18. **Looping UDC logo animation** — add a looping animation variant for the UDC logo (currently static or one-shot). **DONE 2026-05-06** — three variants shipped from `RemotionVideo` to `/mnt/firmament/REMOTION RENDERS/`, all VP9 webm w/ alpha (1080p@30, alpha_mode=1):
    - `UDCLogoLoop-2026-05-06-1080p-vp9-alpha.webm` — gold-shimmer 6s seamless loop, breath (cosine 1.00→1.028→1.00) + diagonal gold shimmer (2 passes/loop, masked to silhouette). 13.2 MB.
    - `UDCLogoEntryWhite-2026-05-07-1080p-vp9-alpha.webm` — graceful 2s entrance (buoyant float-up + soft scale + ≤4° pre-tilt + glow bloom) + 15s static hold. White-on-alpha logo. 4.4 MB.
    - `UDCLogoBug-2026-05-06-1080p-vp9-alpha.webm` — 19s perpetual broadcast bug. Dancer enters tiny off-center → zooms huge to bug-center (heavy speed ramp, easeOutQuint) → jumps to TL home → wordmark pops in from right (easeOutBack overshoot) → 5s static hold → wordmark retracts → dancer back to center → fades. Frame 0 == frame 570, perfect head-to-tail loop. Splits client white-on-alpha logo into dancer-only + wordmark-only sprites animating independently. 12.3 MB.
    Render scripts: `npm run render-udc-logo-loop` / `render-udc-logo-bug` etc.

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
