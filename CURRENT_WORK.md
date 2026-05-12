# Current Work — CompSyncElectronApp

**Status: 2026-05-12 01:37 EDT. Burlington cryo archive transfer DONE under pipeline task `task-1778550068006-c106` / `archive-udc-burlington-2026-dart-to-cryo`. Started 2026-05-11 21:46:23 EDT, finished 2026-05-12 01:32:22 EDT. Final summary `/mnt/firmament/CryoStorage/_transfer_logs/UDC_Burlington_2026_summary_20260511-214623.json` reports source_after = destination_after = 32,809 files / 436,868,649,223 bytes, `verified_counts_and_bytes=true`, `source_deleted=false`. Destination is `/mnt/firmament/CryoStorage/UDC Burlington 2026`; rclone log is `/mnt/firmament/CryoStorage/_transfer_logs/UDC_Burlington_2026_rclone_20260511-214623.log`. Duplicate pending task `task-1778550240857-ff42` remains disabled.**

**Status: 2026-05-12. Backup Media feature hardened in code. `src/main/services/backup.ts` now defaults to current-competition backup scope, preserves nested folder structure during recursive copy, verifies source/destination file presence and byte counts, and writes `.compsync-backup/backup-summary-*.json` manifest after verification. `BackupMedia.tsx` exposes Current competition vs All configured media roots and shows verified vs copied-but-unverified results. `npm run build` passed.**

**Status: 2026-05-11 12:22 EDT. Share-code input diagnostic asar swapped live on DART after operator reported empty-box typing still fails. New `app.asar` is 132,491,045 bytes, LastWriteTime 2026-05-11 12:22:51 EDT; backup of the previous share-code patch is `app.asar.bak.20260511-sharecode-input-pre-diagnostic` (132,490,210 bytes). 4 CompSync Media processes responding.**

Branch: `feat/ui-redesign-pass1` — uncommitted work spans Activity panel migration + Visual Editor sizing/off-screen + webm logo support.

## Last Session Summary
Iterated build9o → build9x on top of v2.8.0. Major work: integrated post-record audio audit into the unified Activity (Event Log) panel, fixed broken-link icon for video/webm logo overrides via `/element-asset` route, fixed off-by-one in `browseAsset()` IPC return type, and unblocked Visual Editor element placement at canvas corners + off-screen.

## What Changed (uncommitted on `feat/ui-redesign-pass1`)

### Share Code Input Focus Fix
- `src/renderer/components/LoadCompetition.tsx` — stopped mouse/click events inside the Load popover from bubbling to outside-close handlers, so typing in the Live share-code box is not interrupted. First fix failed operator's empty-box path.
- Diagnostic now live: share-code input logs `[share-code-input]` pointer/mouse/focus/key/change events with value lengths only. Waiting for operator to reproduce once, then read `C:\Users\User\AppData\Roaming\compsync-media\logs\main.log`.
- Verification before diagnostic: `npm run build` passed; disposable Electron/xvfb run dismissed startup overlays, opened Load, clicked the input, typed `abc-123`, and confirmed input value `ABC-123` with active element `INPUT`. Packaged with `npx electron-builder --win --dir`, staged to DART, swapped live, and verified 4 responding processes.

### Activity (Event Log) Panel
- `src/renderer/components/EventLogPanel.tsx` — added `HIDDEN_KINDS` set: 11 noisy event kinds filtered (`import.requested`, `import.match.summary`, `import.match.warning`, `recording.started`, `recording.stopped`, `encode.started`, `encode.completed`, `upload.started`, `upload.completed`, `chat.backfill.ok`, `chat.message.received`). Added 5 audio.audit.* formatters.
- `src/renderer/styles/event-log.css` — chips no-wrap (8.5px), tighter row padding, smaller text (line1 10.5px, line2 9.5px), errors+warnings get outer glow box-shadow.
- `src/renderer/styles/header.css` — `.topband-activity` capped at `max-height: 220px` with `overflow: hidden` + `min-height: 0` on child to fix infinite vertical stretch.
- `VISIBLE_BUCKETS` in EventLogPanel.tsx: removed `recording` and `chat` chips → 7 chips fit one row.

### Audio Audit → Event Log Migration
- `src/main/services/ffmpeg.ts` — added `events.emit('audio.audit.*')` calls alongside existing `sendToRenderer(IPC_CHANNELS.AUDIO_*)` for: `identicalTracks.warning`, `silence.warning`, `lowLoudness.warning`, `lowBitrate.warning`, and the `summary` (pass) event.
- `src/renderer/App.tsx` — removed `AudioAuditBanner` import + mount. Banner is gone; findings now flow into Activity panel only.

### Webm Video Logo Fix
- `src/main/services/overlay.ts`:
  - `<img>` brand surfaces (`#logoImg`, `#ltBrandImg`, `#ss-logo-img`, `#fc-brand-img`) get default `src="data:image/svg+xml;base64,PHN2Zy8+"` (no-op SVG) so they never show broken-image when src is empty.
  - `applyState` Flow A (`#logo` visibility): now flips `.visible` on when EITHER `o.logo.url` OR `o.logo.assetUrl` is set; null-guards `logoImg.src=` so it doesn't crash if `mountElementAsset` already replaced the `<img>` with a `<video>`.
  - `/brand-logo` HTTP route: if configured file is `mp4|webm|mov|m4v`, returns a 1×1 transparent PNG instead of streaming bytes (legacy `<img>` slots can't trip a broken-image icon when accidentally pointed at a video file).
  - `mountElementAsset`: video/img use `width: 100%; height: 100%; object-fit: cover; display: block` (changed from `maxWidth: 100% / contain`). Bounding box matches visible asset exactly.
  - Diagnostic console.log added in `mountElementAsset`: `[mountElementAsset] <key> assetUrl=... isVideo=true/false` — visible in iframe DevTools.
- `src/renderer/components/VisualEditor.tsx`:
  - **CRITICAL bug fix**: `browseAsset()` was treating `settingsBrowseFile` return as an array (`result[0]` indexed first character of the path string — `"D"` from `"D:\..."`). Now checks `typeof result === 'string'` and uses the whole string. THIS is what made the broken-link appear after picking a webm.
  - Drag clamps widened from `0..95` (X) / `0..98` (Y) to `-100..200` for both — element can be dragged completely off-screen.
  - Resize clamps widened to `2..200` (was `5..(100-pos.x)` etc.) — allows oversize beyond canvas.
  - Arrow-key nudge clamps matched to drag clamps.
  - "Reset position" button added in per-element properties panel — restores selected element's x/y/w/h from `DEFAULT_LAYOUT`. Hint text updated.
- `src/renderer/styles/visualEditor.css`:
  - Resize handles (`.ve-handle-right`, `.ve-handle-bottom`, `.ve-handle-bottom-right`) moved from `right: -8px` / `bottom: -8px` (outside element, clipped at canvas edge) to `right: 1px` / `bottom: 1px` (inside element).
  - `.ve-element.selected` outline switched from `outline-offset: 3px` (outside) to `outline-offset: -1px` (inset).

## Build Status
PASSING — last build9x, 132,489,458 bytes, swapped to live on DART at 14:50 EDT. TypeScript clean throughout the session.

## Live state on DART (per Phase 3 verify after build9x cutover)
- `app.asar` Length: 132,489,458 (matches local) · LastWriteTime: 2026-05-07 14:49:40 EDT
- 4× CompSync Media processes, all `Responding=True`
- **Backups (most recent first):**
  - `app.asar.bak.20260507-build9w-pre9x` — 132,488,671
  - `app.asar.bak.20260507-build9v-pre9w` — 132,488,409
  - `app.asar.bak.20260507-build9u-pre9v` — 132,488,409
  - `app.asar.bak.20260507-build9t-pre9u` — 132,487,837
  - `app.asar.bak.20260507-build9s-pre9t` — 132,487,855
  - `app.asar.bak.20260507-build9r-pre9s` — 132,498,447
  - older chain back to v2.7.0-stable

## Known Bugs & Issues
- **None outstanding from this session.** Webm logo override works end-to-end after the `browseAsset()` fix. Activity panel container constrained.
- Branding-side logo (`Settings → Logo Image → Browse`) uses the legacy `/brand-logo` route and was not extended for video — only the per-element Visual Editor `assetUrl` flow supports webm. If operator picks a webm via the Settings dialog, `/brand-logo` returns a transparent PNG (no broken icon) but no video plays; they should use Visual Editor → element → Asset override → Browse instead. Not flagged as a defect, just a known surface boundary.

## Incomplete Work
- **Diagnostic console.log left in** `src/main/services/overlay.ts:mountElementAsset`. Cheap no-op in production; can stay or be removed in next session.
- All build9 changes are uncommitted to git (HEAD still at `4f9ac8f bump 2.8.0`). Wrap-up commit in progress.

## Tests
- No formal test runs this session — all verification was operator-driven on live DART during Burlington comp.
- Manual verification done: Activity panel rows render (build9s+), webm logo loads after correct `assetUrl` save (build9u+), Visual Editor handles + off-screen drag (build9w+ / build9x).

## Next Steps (priority order)
1. **Wait for operator verification of build9x** — they were sizing/placing the video logo when session ended. If anything's off (cropping wrong, off-screen behaving weird, reset button not where expected), iterate.
2. **Consider unifying brand logo override** — operator originally expected `Settings → Logo Image` to also accept webm. Could either (a) extend that to support video (parallel pipeline to `/element-asset`), or (b) cross-link from Settings to Visual Editor with copy explaining where video goes. Not urgent.
3. **Migrate remaining banners/toasts to Activity panel** (operator's locked spec from 2026-05-05): `HardeningBanners` (10 alert kinds in App.tsx), `AutoToggleToast`, `ReconcileToast`, `MissingPhotosToast`, `OffsetConfirmToast`, `ImportBusyBanner`, `DriveAlert`. Interactive ones become inline action rows. Audio audit was the first surface migrated this session — pattern is established.
4. **Late Cut spec** still locked at `docs/plans/2026-05-04-late-cut.md`, NOT implemented.
5. **CSController HEVC decoder swap** still queued in `~/projects/CSController/INBOX.md` — production gate before flipping `settings.wifiDisplay.encoder = 'hevc-nvenc'`.

## Gotchas for Next Session
- `settingsBrowseFile` IPC returns `string | null` (single path), NOT `string[]`. Any new "browse file" caller in the renderer should `typeof result === 'string'` check, not `result[0]`. The bug we hit affected `VisualEditor.browseAsset()`; verify other callers (`src/preload/index.ts:61` is the contract).
- `/element-asset?key=<key>` is the per-element route (mp4/webm/mov/m4v MIME supported). `/brand-logo` is the legacy single-logo route (no video — returns transparent PNG for video extensions to avoid broken-icon).
- `mountElementAsset` REPLACES the inner `<img>` with a `<video>` (or another `<img>`) when `assetUrl` is set. Any code that grabs `document.getElementById('logoImg')` after that point may get null or a `<video>` — handle defensively.
- Activity panel's `.topband-activity` has hard `max-height: 220px` cap. If operator wants more visible rows, tune that constant.
- Drag clamps in Visual Editor allow `-100..200` percent — that means an element can be COMPLETELY off-screen. Default Layout is the only reset path (per-element Reset button restores from `DEFAULT_LAYOUT`).
- This session did NOT touch upload/queue/encoder/recording/state/SD ingest/CompPortal sync. Burlington comp was running live throughout — only render-tier changes.

## Files Touched This Session
**Modified (uncommitted):**
- `CURRENT_WORK.md` — this file (overwritten)
- `INBOX.md`
- `src/main/services/ffmpeg.ts` — audio.audit.* events
- `src/main/services/overlay.ts` — mountElementAsset, /brand-logo, /element-asset wiring, default img srcs, diagnostic log
- `src/renderer/App.tsx` — removed AudioAuditBanner mount + import
- `src/renderer/components/EventLogPanel.tsx` — HIDDEN_KINDS, audio.audit.* formatters, removed 2 chips
- `src/renderer/components/VisualEditor.tsx` — browseAsset string fix, drag clamps -100..200, Reset position button
- `src/renderer/styles/event-log.css` — chip + row sizing, error/warn glow
- `src/renderer/styles/header.css` — .topband-activity height cap
- `src/renderer/styles/visualEditor.css` — handle positions, outline-offset

## Memory rules to honor
1. `feedback_never_kill_or_start_user_apps.md` — operator owns CSE close + start (broken twice this session — operator explicitly said "you close it" / "yes" to authorize)
2. `feedback_asar_swap_explicit_only.md` — every swap is its own gated action
3. `feedback_partial_is_not_done.md` — ✅ means END-TO-END
4. `feedback_use_log_server_not_ssh.md` — query Supabase `machine_logs` for DART logs (used twice this session to confirm webm/asset state)
5. `feedback_no_chat_messages.md`
6. `feedback_just_execute.md` — read-only ops don't gate
7. **NEVER auto-code from CURRENT_WORK or this transcript.** Wait for operator instruction.

## Build/deploy reference
- Live asar path on DART: `C:\Program Files\CompSync Media\resources\app.asar`
- Staging path on DART: `C:\CompSync-staging\app.asar.new`
- Local staging: `release/win-unpacked/resources/app.asar` (electron-builder output)
- Cutover protocol: `docs/runbooks/asar-swap-protocol.md`. Single-line per Move-Item via separate ssh invocations.
- Build cmd: `npm run build && npx electron-builder --win --dir`

## Pre-existing Late Cut spec (locked, not implemented)
`docs/plans/2026-05-04-late-cut.md` — 114 lines, 12 sections. Recovery flow for missed routine boundaries. Verified at session start: 0 references in `src/`, no commits in git history.
