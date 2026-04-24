# Next-session queue — 2026-04-23 handoff

Built during the three-surface coordination session (CSE + CSController + CompPortal CD-media + livestream machine monitor). This is the durable queue for the next session. Verified against live repo state at 2026-04-23 21:08 EDT.

## Deploy tonight (pre-UDC Toronto, Fri 04-24)

Artifacts staged at `C:\CompSyncStaging\2026-04-23\` on DART:

- `app.asar` md5 `4a96b051dccceefe33126a70197f0364` (126 MB)
- `wifi-display-server.exe` md5 `40063edf8525656b53c122464f149347` (5.5 MB, cross-compiled from `/home/danman60/projects/WifiDisplay/server/src/input.rs` monitor-index fix)

APK staged on Google Drive APKs folder: `CSController-2026-04-23.apk` (file id `1BmVG2dvztUAqbW2zBQDVNDcvTx1FGxF-`).

**Rule:** never close the app on DART. User closes before Claude swaps. Swap sequence:

```powershell
cd "C:\Program Files\CompSync Media\resources"
Rename-Item app.asar app.asar.bak.20260423
Rename-Item wifi-display-server.exe wifi-display-server.exe.bak.20260423
Copy-Item C:\CompSyncStaging\2026-04-23\app.asar .
Copy-Item C:\CompSyncStaging\2026-04-23\wifi-display-server.exe .
```

Smoke-test expectations in main.log after restart:
- `tabletLogServer listening on http://0.0.0.0:8766/tablet-log`
- `Wifi display started (PID ..., monitor index N)`
- On each tap: `[wifi-display] TOUCH_DOWN norm=(x,y) monitor=(mx,my)@WxH abs=(a,a)` — verify `(mx,my)` matches the captured monitor's virtual-screen origin

## Shipped this session (for reference, already live)

- CompPortal commit `3527d0a7` — Support Lookup modal + endpoint + livestream machine-tab compact retool
- CompPortal commit `53b2635f` — photographer camera-clock sync page at `<tenant>.compsync.net/sync`

## Already-shipped items removed from queue after verification

These were flagged in the UDC London 2026-04-19 retrospective as TODO but are confirmed live in current code:

- **F1** — Offset-detector margin requirement. `photos.ts:517` logs `"Clock offset REJECTED (insufficient margin): X scored Y vs zero Z — required ≥{zeroScore * NONZERO_REQUIRED_MARGIN}"`.
- **F3** — Persist rejection_reason. `photos.ts:446/498/509/519/526` emit `events.emit('offsetDetector.decision', { outcome: ... })` for all 5 outcomes.
- **G1** — v6 debug server + dated log retention. `logger.ts:10–18` has `maxSize = 100MB` + `archiveLogFn` writing `main.archive-YYYY-MM-DD_HH-MM-SS.log`. `debugServer` started at `index.ts:332`.
- **G2** — Log throttle removal. No `copiedCount < 3` log-throttle pattern in `photos.ts` or `upload.ts`.

## Queue — 46 items, sorted by P0→P1→P2 then risk

Risk legend: 🔴 HIGH · 🟡 MED · 🟢 LOW. Effort: S / M / L.

### P0 — ship before UDC Toronto weekend

| # | Change | Where | Effort | Risk |
|---|---|---|---|---|
| J1 | Swap asar + binary on DART after close signal | DART `Program Files\CompSync Media\resources\` | S | 🔴 |
| J3 | Install `CSController-2026-04-23.apk` on tablet | Tablet | S | 🟢 |
| J4 | Smoke-test `TOUCH_DOWN` monitor-rect + topology-heal | DART main.log | S | 🟢 |
| E1 | Re-record hard-gate modal replacing advisory-only toast at `recording.ts:534–568` — block archive with "Advance instead?" default | `recording.ts` + new renderer modal | M | 🔴 |
| E2 | Auto-create `media_packages` row for next entry_number when re-record triggers | `recording.ts` + upload flow | M | 🔴 |
| D1 | Move EXIF reader into `node:worker_threads` (no worker_threads usage today) | new `src/main/workers/exifReader.ts` | M | 🔴 |
| D2 | Move matching math (`detectClockOffset`, window assignment) to worker | same worker or sibling | M | 🔴 |

### P1 — pre-next-event

| # | Change | Where | Effort | Risk |
|---|---|---|---|---|
| L2 | One-click reconciliation actions: promote archive/v1 canonical, create missing package row, realign photos | IPC + CompPortal endpoints | L | 🔴 |
| M1 | Enable RLS with service_role-only policies on `dancer_claims`, `invoice_payments`, `sub_invoices`, `password_reset_events` (all 4 still rowsecurity=false) | Supabase migration | S | 🔴 |
| A2 | `POST /api/admin/dancer/:id/attach-parent` — CD-initiated claim on behalf of parent; consent email; activity_logs | new route | M | 🟡 |
| A3 | `PATCH /api/admin/dancer/:id` — edit DOB/first/last with before/after audit | new route | M | 🟡 |
| A4 | Extend `CDSupportLookupModal.tsx` — Attach parent (autocomplete) + inline Edit dancer actions per card | existing component | M | 🟡 |
| B3 | `GET /api/media/cd/verify/per-routine` — per-slot `{urlPresent, r2Present (cached HEAD), bytes, contentType, durationSec, suspicious, updatedAt}` | new route | M | 🟡 |
| B4 | Per-slot health grid UI tab, color-coded cells, click-through to Replace/Move modals | `VerifyMediaAuditTab.tsx` | M | 🟡 |
| C2 | 800×800 WebP q82 medium variant at upload (ffmpeg); schema `media_photos.thumbnail_medium_url`; `/complete` payload `photo_thumbnails_medium[]` | `upload.ts:ensurePhotoThumbnail` + CSE types + CompPortal `/complete` + schema | M | 🟡 |
| E3 | CompPortal re-record guard in `/api/plugin/complete` — flag two packages with uploadRunIds within Ns for consecutive entry_numbers | `app/api/plugin/complete/route.ts` | M | 🟡 |
| F2 | `detectClockOffset`: refuse to score if reference-window gap >15 min | `photos.ts:detectClockOffset` | S | 🟡 |
| L1 | "Media Reconciliation" renderer panel — pick routine → list `_archive/vN/` + sizes + durations → flag mismatches | new renderer surface | L | 🟡 |
| A1 | Move Support Lookup trigger to `/dashboard/director-panel/media` header | `CompetitionDirectorDashboard.tsx` remove + `director-panel/media/page.tsx` add | S | 🟢 |
| A5 | `multi_parent_claims` feature-flag branching on attach-parent | modal + endpoint | S | 🟢 |
| B1 | Rule 9 — duplicate filename across packages | `verify/structural/route.ts` | S | 🟢 |
| B2 | Rule 11 — `video_duration_seconds < 10s` | `verify/structural/route.ts` | S | 🟢 |
| C1 | Latest Photos: 1×3 → **3 clusters × 3 photos** per routine (early/mid/late sort_order) | `routine-clusters/route.ts` | S | 🟢 |
| D3 | Batch + debounce `jobQueue.enqueue` | `jobQueue.ts` | S | 🟢 |
| D4 | Cap per-tick work by routine-group, not photo count | `photos.ts` import loop | S | 🟢 |
| G3 | DART clock drift detector — compare `system.timestamp` to server clock each heartbeat; surface drift >5s on `/sync` + admin machine tab | `controlRoomBridge.ts:buildSnapshot` + `/sync/page.tsx` + `/api/sync/time/route.ts` | S | 🟢 |
| J2 | Commit uncommitted `input.rs` monitor-index fix in WifiDisplay repo | `/home/danman60/projects/WifiDisplay` | S | 🟢 |
| K1 | "Local timezone" setting (default `America/New_York`) + UI | `settings.ts` + Settings panel | S | 🟢 |
| K2 | EXIF persist writes explicit local offset (`-04:00`) instead of `.toISOString()` UTC | `tether.ts` + `photos.ts` EXIF sites | S | 🟢 |
| N1 | Fuzzy DOB: try ±1 year shift when day+month match (Ella Irvin 2013↔2012) | `app/api/media/lookup/route.ts` | S | 🟢 |
| O1 | Recent Events panel density — one-liner per event, click-to-expand JSON | `app/dashboard/admin/livestream/page.tsx` | S | 🟢 |

### P2 — backlog

| # | Change | Where | Effort | Risk |
|---|---|---|---|---|
| B5 | Layer 3 AI repair — reverse keyframe search (FIRMAMENT CLIP + Gemini) | new | L | 🔴 |
| B6 | Layer 3 visual clustering on over-photo'd routines | new | L | 🔴 |
| N2 | Choreographer / teacher per-routine access permission model (Rebecca Moore case) | new table + claim flow + UI | L | 🔴 |
| A6 | Self-serve "Remove dancer from my account" on parent portal (Georgia Jeffrey) | `ParentMediaLookup` + new endpoint | S | 🟡 |
| B7 | Layer 4 batch-approve UI with undo stack | new | L | 🟡 |
| H1 | `livestream_archives` table + migration | Supabase | S | 🟡 |
| H2 | Admin UI to CRUD VODs | `/dashboard/admin/livestream` | M | 🟡 |
| H3 | `/livestream/page.tsx` reads DB instead of hardcoded `ARCHIVE_EVENT` at lines 21–48 | `livestream/page.tsx` | S | 🟡 |
| I2 | Broadcast banner channel from admin to `/sync` viewers | new push mechanism | M | 🟡 |
| M2 | Tighten `email_logs`, `mp3_reminder_log`, `ss_setups` `rls_policy_always_true` → `auth.role() = 'service_role'` | Supabase | S | 🟡 |
| P1 | Forward last-N main.log lines in CSE heartbeat; render Logs panel in admin livestream tab | `controlRoomBridge.ts:buildSnapshot` + admin UI | M | 🟡 |
| P2 | Bind CSE debug server to `0.0.0.0` on tenant-PIN-gated port for LAN browser access | `debugServer.ts` HOST + auth | S | 🟡 |
| C3 | Backfill 800×800 medium variants for UDC London + earlier comps | one-shot script | S | 🟢 |
| I1 | "Photographer sync link" QR card on CSE Settings | Settings panel | S | 🟢 |
| K3 | Overnight script templates log assumed TZ on first line | `scripts/**` | S | 🟢 |
| M3 | Drop stale backup tables (`_test_entry_mapping_jan9`, `_counter_fix_backup_2026_04_17`, `_data_correction_snapshots` — all 3 still present) | Supabase | S | 🟢 |

## Out-of-scope for this session (keep for future)

- Ticket clusters already shipped: DOB fuzzy ±30d + transposition, email typo guard, claim conflicts (Request Access + CD grant), reset-before-claim UX, iOS/mobile download resilience, apostrophe/whitespace name normalization, signed URL TTL bump to 7d.
- v7/v8 already shipped: unified media reconciler, upload recovery + resume, Friday recovery toolkit, media audit panel, EOD export, size-category-aware distribution thresholds, SD import overnight pipeline, auto-SD flow.

## Cross-surface contracts the queue is working against

- Plugin API: `/api/plugin/resolve/[code]`, `/schedule/[compId]`, `/upload-url`, `/complete`, `/list-photos`, `/now-playing`, `/control-room/heartbeat`, `/control-room/commands`
- UDP discovery payload: `{host, videoPort, touchPort, wsPort, tabletLogPort, name}` (all fields now live in staged asar)
- wsHub protocol: identify / state / command / audioLevels
- wifi-display-server CLI: `--monitor-index`, `--video-port`, `--touch-port`, `--bitrate`, `--fps`
- Control room command allowlist: `startRecord`, `stopRecord`, `nextRoutine`, `prev`, `skip`, `pauseUploads`, `resumeUploads`, `reconcileMedia`, `nudgeRoutine`, `pinChatMessage`, `unpinChatMessage`, `setCameraOffset`, `clearCameraOffsets`

## On session start

1. Read this file top-to-bottom.
2. If the staged asar is still waiting to swap on DART (check main.log for `tabletLogServer listening`), deploy J1/J3/J4 first.
3. Otherwise work down the P0 block in order.
4. Session memory pointers:
   - `~/.claude/projects/-home-danman60-projects-CompSyncElectronApp/memory/project_session_scope_cse_tablet_portal.md` — cross-surface contracts
   - `~/.claude/projects/-home-danman60-projects-CompSyncElectronApp/memory/feedback_never_close_app_on_dart.md` — deploy rule
   - `docs/plans/2026-04-19-weekend-retrospective.md` — UDC London lessons
   - `docs/plans/2026-04-19-media-integrity-system.md` — audit Phase B+ source spec
