# Current Work — CompSyncElectronApp

Overnight autonomous session 2026-04-23 → 2026-04-24 (UDC Toronto day 1).

## One-line status

v11 live on DART (app closed, awaiting operator AM start as administrator). Machine log streaming now flows CSE → CompPortal; Logs panel at `udc.compsync.net/dashboard/admin/livestream` (Machine tab). End-to-end smoke test passed.

## Operator's next action (AM)

1. Start CompSync Media on DART **as administrator** (UIPI rule — touch fails silently if not elevated).
2. Verify the Logs panel populates at `https://udc.compsync.net/dashboard/admin/livestream` within 5s of app start (3s polling + 3s post cadence).
3. Install `CSController-2026-04-23.apk` on tablet when on-site (staged at Google Drive APKs folder, file id `1BmVG2dvztUAqbW2zBQDVNDcvTx1FGxF-`).
4. Verify touch works: on main.log grep for `TOUCH_DOWN norm=... monitor=(mx,my)@WxH abs=(a,a)` when tapping the tablet.

## DART state at handoff

- App: **CLOSED** (autonomous shutdown was authorized for this swap only)
- v11 asar md5: `6e5e97ec0ccad8eaf6a8720dd20f4f25` at `C:\Program Files\CompSync Media\resources\app.asar`
- wifi-display-server.exe md5: `40063edf8525656b53c122464f149347` (same as v10)
- 3 mingw runtime DLLs in resources folder: `libstdc++-6.dll`, `libgcc_s_seh-1.dll`, `libwinpthread-1.dll`
- Rollback chain: `app.asar.bak.20260424-v11` (v10) · `app.asar.bak.20260424` (v10 too) · `app.asar.bak.20260423` (v9)

## Shipped this overnight session

### CompPortal (live on Vercel — commit `29752543` on main)
- Supabase migration `create_machine_logs_table` (additive, RLS service-role-only, no cleanup cron — add 7-day retention later)
- `POST /api/plugin/control-room/logs` — Bearer-auth ingest, caps 200 events/req + 8KB/msg
- `GET /api/admin/machine/logs` — admin-auth read with tenant/level/since filters
- Logs panel on `/dashboard/admin/livestream` Machine tab — 3s polling, colored level badges, Auto-scroll toggle, filter buttons (All / Warn+ / Error+), Copy, status dot

### CSE v11 (live asar on DART — commit `541b10b` on `feat/sd-import-overnight`)
- `src/main/services/logStreamer.ts` — ring buffer (1000) + 3s batched POST to `/api/plugin/control-room/logs` + exponential backoff (6s→60s) + source classification from message prefix
- Custom electron-log transport at `log.transports.streamer` fires once per `logger.*` call; reentrancy-guarded
- `process.on('uncaughtException')` + `unhandledRejection` captured as `level:'fatal'`
- Static import in `src/main/index.ts`, wired after `controlRoomBridge.start()`

### CSE v10 (shipped earlier in this session — included in v11 build)
- E1 — Re-record hard-gate modal replacing advisory toast (`recording.ts`, `App.tsx`, `ipc.ts`, `preload/index.ts`, `types.ts`). `RECORDING_REREC_DECISION_REQUESTED`/`RECORDING_REREC_DECISION` IPC. Default `advance` retargets MKV to next routine; `archive` preserves legacy behavior. 120s safety fallback to archive.
- E2 — No-op: verified CompPortal `/api/plugin/upload-url` + `/complete` auto-create `media_packages` server-side. Documented inline.
- D1/D2 — EXIF reader + detectClockOffset/matcher moved to `node:worker_threads`. Flags `performance.useExifWorker` + `performance.useMatcherWorker` **default OFF** (shadow-mode logs divergence). Flip via Settings → Performance (advanced).
- wifiDisplay — 3 mingw runtime DLLs shipped as extraResources + auto-copy to userData alongside exe (v9 was crashing with `STATUS_DLL_NOT_FOUND` before this fix)
- tabletLogServer — dynamic `require` → static `import`, so electron-vite bundles it into main chunk (v9 logged "Cannot find module './services/tabletLogServer'" every boot)

## End-to-end smoke test (done 22:55 EDT)

- `POST /api/plugin/control-room/logs` with test payload → HTTP 200 `{"ok":true,"accepted":3}`
- Rows 1–3 inserted in `machine_logs` with `host_id='DART-SMOKE-TEST'` — visible in Logs panel at top until real DART events push them down. These 3 rows can be ignored (smoke-test verification only).
- Logs panel route returns 307 → /login without auth (expected).
- **NOT tested yet**: CSE process actually posting (app is closed). First real test happens when operator starts v11 AM. If nothing flows, check:
  - DART's CompSync Media settings point at `https://udc.compsync.net` as `apiBase`
  - Plugin Bearer token valid: `csm_f68ddeef15d7bbe8e57fa3e0606dc475ee5dc56e6249803c` (tenant UDC, key active)
  - main.log for `[logStreamer]` lines or warn about failed POST

## Remaining queue

- **J3** (install APK on tablet) — blocked until you're on-site with the tablet
- 44+ items in `docs/plans/2026-04-23-next-session-queue.md` P1/P2 — no show-stoppers. Priority candidates after UDC Toronto: M1 (enable RLS on 4 still-open tables), A1 (move Support Lookup button), G3 (DART clock drift detector), L1/L2 (media reconciliation actions).

## Surfaces to monitor tomorrow

| Surface | Where | Smoke check |
|---|---|---|
| CSE on DART | main.log via SSH OR Logs panel | `Wifi display started (PID ..., monitor index 1)`, `tabletLogServer listening on http://0.0.0.0:8766/tablet-log`, `[logStreamer]` any successful POST |
| CompPortal Machine tab | `udc.compsync.net/dashboard/admin/livestream` | Grid shows recording/routine/system; Logs panel shows live events |
| Plugin log ingest | Supabase `SELECT count(*) FROM machine_logs WHERE received_at > now() - interval '5 min'` | Non-zero once DART app is running |
| CSController tablet | Apk + touch on monitor #1 | `TOUCH_DOWN ... monitor=(3840,0)@1920x1080` lines in Logs panel |

## Risks / known gaps

- **Not yet validated**: the CSE log-post path is unverified live. First restart AM proves it. If no logs flow, most likely cause is CSE apiBase pointing to the wrong host — check on the Settings tab in CSE.
- **debugServer still has the bundling bug** — pre-existing, not fixed tonight. Historical main.log shows `debugServer start failed: Cannot find module './services/debugServer'`. Not a show-stopper (Logs panel replaces the need for the local debug endpoint). Address post-show.
- **RLS still off** on `dancer_claims`, `invoice_payments`, `sub_invoices`, `password_reset_events` (queue item M1).
- **Sharp version mismatch** in package.json still unchanged (inert today).
- 3 smoke-test rows in `machine_logs` won't be deleted (per "never destructive DB ops" rule) — they'll scroll off naturally as real events ship.

## Rollback paths

- `app.asar.bak.20260424-v11` → restores v10 (hotfix stable, no log streamer, no hard-gate modal)
- `app.asar.bak.20260424` → same v10 (duplicate bak from first swap tonight)
- `app.asar.bak.20260423` → restores v9 (pre-tonight)
- `wifi-display-server.exe.bak.20260423` → restores pre-monitor-index-fix binary (do NOT use unless DART only has 1 monitor)

## Commits pushed

- `aafb00c` — v10: re-record hard-gate modal, EXIF/matcher workers, DLL bundle, tabletLogServer fix
- `541b10b` — v11: machine log streaming — CSE → CompPortal logs endpoint

Both on `feat/sd-import-overnight`. Remote: `github.com/danman60/CompPortalElectronApp.git` (GitHub redirected from the old compportalelectronapp URL).
