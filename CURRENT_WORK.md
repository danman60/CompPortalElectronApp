# Current Work — CompSyncElectronApp

**Status: 2026-05-06 ~23:30 EDT. BUILD #8n LIVE on DART (132,443,815 bytes). build9o code-complete on disk (NOT yet built/swapped). Operator-instructed autonomous run finished — TS clean, ready for build.**

Branch: `feat/ui-redesign-pass1` — uncommitted changes spanning build8m → build9o. Nothing pushed.

## build9o delta (on top of 8n) — autonomous run 2026-05-06 23:18 → 23:30 EDT

Three blocks: (A) SS premium pass, (B) Item #2 photo dedup simplification, (C) Item #11 chat pin two-destination CSE-side. All code-complete, `npx tsc --noEmit` passes.

### A. Starting Soon premium pass (broadcast hallmarks)

Goal: lift SS from "tasteful screensaver" to "Eurosport/Olympics-grade open." Five sub-features + bonus 30s takeover.

- **A1 — Logo plinth + halo (operator A2):** wraps `#ss-logo` with `.ss-logo-plate` (translucent beveled plate w/ inner shadow + backdrop blur) and `.ss-logo-halo` (rotating conic-gradient brand-tinted halo). Halo enters at +1.4s after first-show, then spins on a slow 18s loop. Toggleable via `LogoConfig.haloEnabled` (default true) + `haloColor`. Visible in CSS at lines ~1903-1965 of overlay.ts.
- **A2 — Venue identifier strip (operator A3):** `#ss-venue-id` element rendering up to 3 segments (event mark · venue · day) with hairline pipe dividers between segments. New `VenueIdentifierConfig` type, layout slot `layout.venueId`. Default enabled, defaults to empty strings — operator sets via SSE; strip stays hidden until at least one field has content.
- **A3 — Section identifier badge (operator C4):** top-corner pill with pulsing dot + label ("STARTING SOON"). New `SectionBadgeConfig`, layout slot `layout.sectionBadge`. Default enabled with red dot.
- **A4 — Two-row ticker (operator B2):** existing `.ss-ticker-rail` now wraps in `.ss-ticker-block` flex column. Optional accent row above shows category label + pulsing red LIVE indicator. New `SSTickerConfig` fields `twoRow`, `categoryLabel`, `liveIndicator` (defaults true/EVENT INFO/true).
- **A5 — Flip-board countdown (operator C2):** new `CountdownStyleConfig.style` field. `'flipboard'` default; renders each digit in a beveled plate with split-flap animation. Per-digit diff so unchanged digits don't flap each second. `'soft'` falls back to legacy color-blink.
- **A6 — 30s final-countdown takeover (operator-added mid-run):** new `.ss-final-cd` overlay layer (z-60) revealed when remaining ≤ threshold (30s default). Centered oversized flipboard (clamp 160-360px digits), brand-tinted halo flash on each digit change, red escalation at ≤5s, brightness-flash drop-out at zero. Layout countdown is opacity-faded while takeover is up. Returns to layout view if countdown extended past threshold. `CountdownStyleConfig.finalSecondsTakeover/Threshold/Label/SubLabel`.

Files touched:
- M `src/shared/types.ts` — `LogoConfig.haloEnabled/Color`, `VenueIdentifierConfig`, `SectionBadgeConfig`, `SSTickerConfig.twoRow/categoryLabel/liveIndicator`, `CountdownStyleConfig.style/finalSecondsTakeover/...`, layout `venueId/sectionBadge` slots, `StartingSoonConfig.venueIdentifier/sectionBadge`.
- M `src/main/services/overlay.ts` — defaults, deep-merge in loadSSConfig, ~340 lines new CSS, new DOM elements, applyStartingSoon render blocks for halo/venue/badge/two-row-ticker/flipboard, full updateCountdown rewrite for flipboard + takeover, escHtmlGlobal hoist.

### B. Item #9.2 — Photo dedup simplification (Option A: volume-keyed EXIF cursor)

**Drops sha1(first 128KB) per-file content hashing as the import-side dedup authority.** Per-card EXIF watermark (keyed by Windows volume serial number) is now the sole gate. Migration safety net + unrecognized-card thumbnail event also wired.

- NEW `src/main/utils/volumeSerial.ts` — `getVolumeInfo(driveRoot)` via legacy `vol <letter>:` cmd. Cached per session. Returns `{ serial, label }`.
- NEW `generateInlineThumbBase64()` in ffmpeg.ts — scales JPEG to 96x96 webp via ffmpeg pipe:1, returns `data:image/webp;base64,...` (capped 32KB).
- M `src/main/services/state.ts` — new `SdCardCursorEntry` type + `sdCardCursors: Record<serial, entry>` map persisted in PersistedState. New API: `getSdCardCursor`, `setSdCardCursor`, `clearSdCardCursor`, `listSdCardCursors`, `clearAllSdCardCursors`. Hydrates on app load. Cursor only advances forward (never rolls backward on out-of-order recovery).
- M `src/main/services/photos.ts` — three changes:
  1. **Pre-EXIF-loop:** build `cursorByDrive` Map keyed by drive partition. For each drive: get volumeSerial → look up cursor. If no cursor exists AND comp has existing routine.photos[]: SEED cursor with comp's max captureTime + `seededFromRoutines: true` (migration safety net). If brand-new card AND brand-new comp: emit `drive.unknownCard` event with inline base64 thumb of latest scanned photo.
  2. **In EXIF loop:** moved EXIF read up before dedup gate. Replaced `manifest.computeSourceHash + seenHashes.has` block with cursor compare (`captureTime ≤ cursor.lastCaptureTime` → skip). Synthesizes `sourceHash = vol:SERIAL:BASENAME:ISO` (content-free, unique-per-file) so the upload-side `importManifest.markUploaded` keying still works with no content read.
  3. **Post-import:** advance per-volume cursors with batch's max captureTime per drive partition. Per-body `setSdWatermarksBulk` retained (driveMonitor's clock-sampler still reads it).
- Retired: `seenHashes`, `seenBasenames`, `stripDupAndUpper`, the hash-fail belt-and-suspenders gate. `skippedByFilenameDedup` kept at 0 for log-parser back-compat.

Both operator open-Qs answered yes:
- **Migration safety net:** YES — seeds cursor from existing routine.photos[] max captureTime on first-touch of unknown card in a comp that already has imports.
- **Unrecognized-card inline base64 thumb:** YES — emits `drive.unknownCard` event with thumbBase64 + samplePath + photoCount + driveRoot + serial + label so the EventLogPanel can render it inline.

### C. Item #9.11 — Chat pin two-destination (CSE side)

Built CSE-side against the documented contract (POST/DELETE `/api/plugin/chat/{id}/livestream-pin`). Local state advances on operator click; POST is best-effort. When CompPortal-2 ships its endpoint + livestream player overlay, CSE works end-to-end with zero redeploy.

- M `src/shared/types.ts` — new `LivestreamPinnedMessage` type (parallel to `PinnedChatMessage`, currently same shape). New IPC channels: `CHAT_LIVESTREAM_PIN`, `CHAT_LIVESTREAM_UNPIN`, `CHAT_GET_LIVESTREAM_PINNED`, `CHAT_LIVESTREAM_PIN_CHANGED`.
- M `src/main/services/chatBridge.ts` — `livestreamPinnedMessages` slice (cap MAX_PINNED=10). New: `getLivestreamPinned`, `livestreamPinMessage(id)` (POST), `livestreamUnpinMessage(id)` (DELETE), `clearLivestreamPinned`, `setOnLivestreamPinChange`. **Does NOT call onMessagePinned** (no LT/OBS broadcast). Emits `chat.livestream.pinned/unpinned` events on success.
- M `src/main/index.ts` — `setOnLivestreamPinChange` wired to push `CHAT_LIVESTREAM_PIN_CHANGED` to renderer + rebroadcast `wsHub.broadcastState()` so livestream player + WS clients converge.
- M `src/main/ipc.ts` — handlers for the three new channels.
- M `src/preload/index.ts` — `chatLivestreamPin/Unpin/GetLivestreamPinned` bridges.
- M `src/renderer/store/useStore.ts` — `chat.livestreamPinned` slice + `setChatLivestreamPinned` setter. Subscribes to `CHAT_LIVESTREAM_PIN_CHANGED` for live updates.
- M `src/renderer/components/PanelChat.tsx` — TWO icon buttons per row: 📹 (video, burn-into-recording) and 🌐 (livestream, no OBS). Each toggles independently with `.active` state. Two badges (📹/🌐) in the message meta row when pinned to either destination.
- M `src/renderer/styles/panels.css` — `.pin-video.active` (purple) / `.pin-stream.active` (mint) destination colors + shadows.

## ⚠ Build / deploy gating

- **NO build executed yet** — operator owns build + asar swap. To build:
  ```bash
  npx vite build && npx electron-builder --win --config.compression=normal
  ```
- **TypeScript clean** verified (`npx tsc --noEmit`).
- **All edits on disk uncommitted** — operator owns commit + push.

## ⚠ Items 9.2 + 9.11 verification (post-build8n + build9o swap)

After operator builds + swaps:
1. Insert a known SD card → verify dedup skips already-imported via volume cursor (look for `[volume-cursor]` log lines).
2. Insert a NEW (unknown) SD card with no comp imports → verify `drive.unknownCard` event surfaces in EventLogPanel with thumbnail.
3. Insert a NEW SD card AFTER comp has imports → verify cursor seeded from routine.photos[] max captureTime (no false re-imports).
4. Trigger SS scene → verify halo + plate behind logo, venue strip in top corner (will be invisible until operator fills SSE), section badge in opposite corner with pulsing dot, two-row ticker with LIVE indicator (when ticker enabled).
5. Set countdown to 1 minute → verify flipboard digits, then crossing 30s reveals full-screen takeover with FINAL 30 SECONDS label, last-5 escalation to red, drop-out flash at 0.
6. Send chat message → verify two pin buttons (📹 / 🌐), each toggles independently. Burn-into-video pin still hits OBS LT broadcast as before; livestream-only pin POSTs to `/api/plugin/chat/.../livestream-pin` (will 404 until CompPortal-2 ships endpoint — error logged, local state still updates).

## build8n delta (on top of 8m)

This bundle adds, on top of build8m's Feature Card beauty pass + Crash Zoom blur gate:

### Build #9 item #3 — Move-after-routine button
- NEW `src/renderer/components/MoveAfterPopover.tsx` — modal with type-to-filter target picker, keyboard nav (↑↓ Enter Esc).
- M `src/renderer/components/RoutineTable.tsx` — "Move…" button on every row (beside View / Scratch / Nudge).
- M `src/renderer/App.tsx` — mount the popover.
- Splices source routine into `displayOrder` immediately after chosen target via existing `stateSetDisplayOrder` IPC. No main-process changes.

### Build #9 item #4 — Unified Event Log
- M `src/shared/types.ts` — `EVENT_STREAM`, `EVENTS_GET_RECENT` IPC channels + `EventRecord` / `EventSeverity` types.
- M `src/main/services/events.ts` — `setOnEmit(cb)` fanout hook.
- M `src/main/index.ts` — wire fanout to BrowserWindow via `sendToRenderer(IPC_CHANNELS.EVENT_STREAM, record)` before `createWindow`.
- M `src/main/ipc.ts` — `EVENTS_GET_RECENT` handler + `auto-toggle.changed` emit.
- M `src/main/services/recording.ts` — `recording.started` / `recording.stopped` emits.
- M `src/main/services/ffmpeg.ts` — `encode.started` / `encode.completed` / `encode.failed` emits.
- M `src/main/services/upload.ts` — `upload.started` / `upload.completed` / `upload.failed` emits.
- M `src/main/services/mediaReconciler.ts` — `reconcile.summary` emit.
- M `src/preload/index.ts` — `eventsGetRecent` bridge.
- M `src/renderer/store/useStore.ts` — events slice (ring 500), bucket filtering helpers `kindToBucket` / `kindIsError`, `appendEvent` / `setEvents` / `toggleEventBucket` / `dismissEvent`.
- NEW `src/renderer/components/EventLogPanel.tsx` — backfill 200 + live IPC stream + severity stripe + filter chips + animated entry + auto-scroll w/ "↓ N new" pill + expand-to-raw-JSON.
- NEW `src/renderer/styles/event-log.css` — hero-panel styling.
- M `src/renderer/components/Header.tsx` — mount `<EventLogPanel />` in `.topband-row` between Current Routine and Controls.
- M `src/renderer/styles/header.css` — `.topband-activity { flex: 0 0 360px }` matching Record column width.
- M `src/renderer/App.tsx` — unmount `AutoToggleToast`, `ReconcileToast`, `StartupToast`, `ImportSummaryToast` (kept components defined for rollback safety).

### CompPortal admin livestream parity (queued via /tmp/cse-overlay-parity-prompt.md)
- M `src/shared/types.ts` — `WSCommandMessage.action` extended with 9 new verbs: `overlayFireLT`, `overlayHideLT`, `overlaySetTicker`, `overlaySetStartingSoon`, `overlaySetAnimationConfig`, `ssSetConfig`, `ssSavePreset`, `ssLoadPreset`, `ssDeletePreset`. Plus `payload?: Record<string, unknown>`.
- M `src/main/services/wsHub.ts` — 9 new case branches in `executeCommand` routed through `overlay.*` / `setSSConfig` / `saveSSPreset` / `loadSSPreset` / `deleteSSPreset`.
- M `src/main/services/controlRoomBridge.ts` — `pollCommands()` forwards `element` + `payload` to wsHub. `buildSnapshot()` adds `overlay: overlay.getOverlayState()` and `ssConfig: overlay.getSSConfig()`.

### Counter advance — premium animation pack
- M `src/main/services/overlay.ts` — 6 variants (v1 premium pop, v2 3D flip, v3 slide+bounce, v4 RGB glitch, v5 zoom-burst, v6 shimmer streak). Random no-repeat picker `pickCounterVariant()`. Iframe-side, broadcast-only — zero operator-app overhead.

### Starting Soon — design-pro pass (full 6-bucket pass)
- M `src/main/services/overlay.ts`:
  - **Atmospheric depth:** `.ss-vignette` (radial dark mask), `.ss-grain` (SVG fractal noise overlay 4% opacity), `.ss-bloom` (conic-gradient halo following logo position via CSS variables).
  - **Cinematic scene entry on `.first-show`:** zoom 1.025→1.0 over 2.4s, gradient saturation 0.55→1.0, title slide+letter-spacing+blur ignite, subtitle stagger, countdown digit ignite (blur 10→0, scale 0.85→1.03→1.0), time/date fade, logo enter with motion blur, accent line sweep. Auto-removed after 2.8s.
  - **Typography polish:** countdown `font-variant-numeric: tabular-nums` + negative tracking + drop-shadow + `<span class="ss-cd-colon">` blink wrapping. Title 0.04em letter-spacing + 4px-y/32px-radius shadow. Subtitle uppercase 0.18em tracking dimmed `#c5cae9`. Time/date dimmed `#b8b8d0`. Title accent line — 2px gradient hairline below title.
  - **Logo enter:** scale 0.92→1.0 with blur 4→0 staggered at +1.4s.
  - **Ticker rail:** edge-fade gradient mask 32px each side, `backdrop-filter: blur(6px)`.
- M `src/shared/types.ts` — `GradientPreset` extended with 5 new presets.
- 5 new gradient presets (overlay.ts + StartingSoonEditor.tsx): `slate-aurora`, `velvet-night`, `champagne-light`, `cinematic-teal`, `neutral-studio`. Listed FIRST in SSE picker.
- `defaultSSConfig.gradient.preset` switched from `aurora` → `slate-aurora`.
- M `src/renderer/components/StartingSoonEditor.tsx` — `PRO_PACKS` array with 4 packs (Broadcast / Theater / Festival / Studio), `applyProPack` callback, "Pro Packs" UI row at top of right panel.
- M `src/renderer/styles/startingSoonEditor.css` — `.sse-pro-packs` + `.sse-pro-pack` styles.

## Live state on DART
- **app.asar:** 132,443,815 bytes (build8n, swapped 2026-05-06 ~03:14 EDT)
- **Backups (most recent first):**
  - `app.asar.bak.20260506-build8m-pre8n` — 132,398,630 (build8m, pre-8n swap)
  - `app.asar.bak.20260505-build8k-pre8m` — 132,390,941
  - `app.asar.bak.20260504-build8j` — 132,390,068
  - older chain back to v2.7.0-stable
- CSE not yet relaunched after swap. Operator owns the launch.

## Active tasks for the fresh session

**1. Build8n verify on DART (operator-driven once they launch CSE):**
- ACTIVITY panel renders in topband far-left at 360px width matching Record column width
- Counter advance fires one of 6 variants (v1-v6) per advance, no-repeat with prior
- SS scene shows Slate Aurora gradient + atmospheric layers (vignette + grain + bloom) + cinematic entry on visibility flip
- LT and overlay-set commands from CompPortal admin livestream page execute end-to-end
- Move… button on every routine row opens modal popover, splices via stateSetDisplayOrder

**2. Item #11 — Two-destination chat pin (NOT IMPLEMENTED, plan written):**
- `docs/plans/2026-05-05-build9-items-3-4-11-plan.md` documents the design.
- Operator clarification: NOT server-vs-local sync. It's TWO PIN BUTTONS for two destinations: Burn-into-video (current LT broadcast path stays) vs Livestream-only (NEW CompPortal client-side overlay channel that never enters OBS).
- CompPortal-2 sibling session needs livestream player overlay component before CSE can wire to it.

**3. Item #2 — Photo dedup simplification (RESEARCHED, NOT IMPLEMENTED):**
- Operator agreed to Option A: pure volume-keyed EXIF cursor, drop hashing entirely.
- Two open Qs from operator: (a) migration safety net seeding cursors from existing `routine.photos[]` (+30 lines, no re-imports on first card insertion post-upgrade) — operator hasn't answered. (b) Unrecognized-card thumbnail UX confirmed: inline base64 in event-log row.
- Effort: ~3-4 hrs focused. Net subtractive (~80 lines removed, ~150 added).
- Concrete file plan in conversation: new `src/main/utils/volumeSerial.ts` + `state.sdCardCursors` + replace `computeSourceHash + seenHashes.has` block in `photos.ts:~1322` + `Photo.fromSdImport` flag.

**4. Other Build #9 fix list items still open:**
- #6 Judge backup audio reminder (not started)
- #8 Crash blur zoom — verify on DART post-build8n (build8l shipped logic)
- #9 Tablet button layout reorg (CSController repo, not started here)
- #13 Ticker state sync app ↔ SD bug (not started)
- #14 Duplicate record-status button — location TBD with operator
- #17 Push LT/counter motion iteration (taste call, may want next pass)
- #18 Looping UDC logo animation (clarity needed)

## Pre-existing Late Cut spec (locked, not implemented)
`docs/plans/2026-05-04-late-cut.md` — 114 lines, 12 sections. Recovery flow for missed routine boundaries: chord popover (-5/-10/-15/-20/-30/Custom), audio-snap deferred to encode time, synthetic second-take row at encode time, 5s undo grace, v1 single cut per take.

## Memory rules to honor
1. `feedback_never_kill_or_start_user_apps.md` — operator owns CSE close + start
2. `feedback_asar_swap_explicit_only.md` — every swap is its own gated action
3. `feedback_partial_is_not_done.md` — ✅ means END-TO-END
4. `feedback_use_log_server_not_ssh.md` — query Supabase `machine_logs` for DART logs
5. `feedback_no_chat_messages.md`
6. `feedback_just_execute.md` — read-only ops don't gate
7. **NEVER auto-code from CURRENT_WORK or this transcript.** Wait for operator instruction.

## Build/deploy reference
- Live asar path on DART: `C:\Program Files\CompSync Media\resources\app.asar`
- Staging path on DART: `C:\CompSync-staging\app.asar.new`
- FIRMAMENT staging: `/mnt/firmament/CompSync-builds/app.asar.build8n` (132,443,815 bytes)
- Local staging: `release/win-unpacked/resources/app.asar` (electron-builder output)
- Cutover protocol: `docs/runbooks/asar-swap-protocol.md`. Single-line per Move-Item via separate ssh invocations (multi-line here-strings get mangled).

## Reason for refresh
End of long session — substantial uncommitted work (item #3, #4, overlay parity, counter pack, SS design-pro pass), build8n cutover complete, operator called /fresh to start clean.
