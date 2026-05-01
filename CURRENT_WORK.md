# Current Work — CompSyncElectronApp

**Status: 2026-05-01 ~14:42 EDT (Friday). Burlington UDC Day 1 ongoing. Mid-show + post-break swaps DONE. Branch ahead by 1 commit since live.**

---

## Branches + deploy state

- **Working tree:** `feat/ui-redesign-pass1` (HEAD `336e438` — clock-slide cached-layout)
- **Master:** `7a0baf8` — Burlington-safe, no UI redesign
- **DART live asar:** **132,284,194 bytes** (built 13:36 EDT, swapped 13:37 EDT) — contains 12 of 13 queued patches; 1 patch (clock-slide cached-layout robustness) committed but not yet swapped
- **DART backup:** `app.asar.bak.20260501-burl-break2` (the pre-13:37 asar with 11 patches)
- **Earlier backup:** `app.asar.bak.20260501-burl-mid` (the pre-mid-show asar)
- **Rollback tags:** `pre-ui-redesign-2026-04-29` at master `023b99e`; `v2.7.0-stable` at `11b97af`

---

## Burlington UDC 2026 — production data state

- Competition ID: `ab9a6076-8133-4d30-a782-770eaaac5e1c`
- Tenant: `00000000-0000-0000-0000-000000000004`
- Share code: `UDC-BURLINGTON`
- Date: 2026-05-01 to 2026-05-03

**Scratched (still scratched):** R108 BEFORE MORNING, R244 TIRED, R483 ROLLERCOASTERS — all JJ Dance Arts.

**R137 / R137.5 panic incident — leave alone per operator:** Operator click-error during the re-record modal blocking flow created lateInsert R137.5 locally on CSE. Server-side R137 has the correct 179s "QUEEN NYSSIA" video. R137.5 entry doesn't exist on CompPortal. Photos for that window matched to R137.5 in CSE local state, failed to upload (404 lateInsert-resolve missing). Operator instruction: **leave the data, no DB UPDATE.** CompPortal late-insert-resolve endpoint shipped on `feat/burl-2026-05-01-cd-portal-fixes` branch — once deployed, future R137.5-style cases will register cleanly.

---

## What landed today

### Mid-show batch (commit `3c94a71`, swapped 11:55-12:00 EDT — 13 patches)
- obs.ts: any-transition auto-revert to Cut after 500ms
- recording.ts: re-record auto-archive (no block) + sub-discard ≤10s
- App.tsx: re-record modal → bottom-right toast (covers chat area)
- index.ts: chat pin/unpin instant OBS overlay broadcast (wsHub.broadcastState wrapper)
- RoutineTable.tsx: SD swap heads-up at 40% (was 50%)
- RightPanel.tsx + header.css: REC denominator subscript + Proc/Up tiles removed
- header.css: meta-stats wrap, SystemMonitor wrap, routine-meta wrap (no clipping)
- PipelineHealthChip.tsx: portal + fixed positioning (popover draws over CurrentRoutine)
- CurrentRoutine.tsx + header.css: comp name in section title
- jobQueue.ts: video uploads prioritized over photos, latest-video-first
- pipelineHealth.ts: photoImport thresholds 75/120 min (interim — superseded by 2fe12cb)
- ffmpeg.ts: thumb-gen ffmpeg respects cpuPriority
- upload.ts: removed global `await sleep(backoffMs)` that starved queue after any failure; late-insert-resolve 404 quarantines siblings

### Post-break batch (swapped 13:37 EDT — 12 patches across 5 commits)
- `68aca53` — comp name visible (CSS specificity), PIPE viewport clamp, video duration in plugin/complete, keyframes server-fallback, chat unpin optimistic, chat hide/ban, chat routine-link badge
- `2fe12cb` — pipelineHealth pending-aware (photoImport only stale if pending work exists; no false yellow/red between SD swaps)
- `4e17ed6` — Encode Intensity slider in Settings (3-preset: aggressive/balanced/quiet/custom) + Audio Audit "Hide today" button
- `dfbc745` — Safe to remove pill: `· N photos · done H:MM AM/PM`
- `1ab9fee` — Clock slides into counter slot when counter hidden (for awards sessions)

### Queued for next swap (commit `336e438`, 1 patch)
- `336e438` — Clock-slide reapplies on every state update via cached layout (defensive — counter visibility toggles don't re-emit overlayLayout, so position-swap needs cached version)

### Stream Deck plugin (manual install during break)
- New plugin folder extracted to `C:\Users\User\AppData\Roaming\Elgato\StreamDeck\Plugins\com.compsync.streamdeck.sdPlugin\` from `compsync-sdplugin.tgz` in CompSync-staging
- Old `.bak-2026-04-25-pre-v6` and `.broken-v7` folders preserved next to it
- **SD app NOT running right now** — operator stopped it. Operator restarts SD app from desktop when ready (per memory: never start user-facing apps via SSH — they land in Session 0 invisibly)

---

## CompPortal companion branch — `feat/burl-2026-05-01-cd-portal-fixes`

Pushed to origin, Vercel auto-deployed. 4 endpoints shipped:
- `/api/plugin/chat/[id]/hide` — token-auth chat moderation
- `/api/plugin/chat/ban` — token-auth ban author
- `/api/plugin/late-insert-resolve` — registers a synthetic empty-{ts} routine as a real competition_entries row, returns entryId. Idempotent on (competition_id, synthetic_id).
- `/api/plugin/complete` accepts `performanceDurationSec` + `judgeDurationsSec`

DB changes:
- `competition_entries.synthetic_id TEXT` (partial UNIQUE on competition_id+synthetic_id WHERE NOT NULL)
- `livestream_chat_messages.routine_id_at_post UUID` (+ index)
- Migration files written, NEED TO BE APPLIED

---

## Tooling discovered + working

- **Renderer screenshot via debug endpoint** (existing): `POST http://127.0.0.1:8765/debug/test/capture-renderer` body `{outputPath, dismissModals: true}` — `behavior.testHooksEnabled: true` required (currently on for DART)
- **machine_logs streaming** (existing): DART logs stream to Supabase `machine_logs` table via logStreamer; query via Supabase MCP
- **Asar swap protocol** (NEW — documented at `docs/runbooks/asar-swap-protocol.md`): pre-stage build during operator's app-running window, single ssh per Move-Item (multi-line here-strings get mangled), verify Length + LastWriteTime after swap

---

## Active monitor mode

Show is active. Pre-fresh state: heartbeats every ~5 min via ScheduleWakeup, querying:
- machine_logs for new errors/warns (filtering tablet/judge3 loudness/MISSING_PHOTOS/control-room heartbeat/partition-processing/Distribution sanity)
- media_packages updates for routine cycle progression

Last heartbeat reported clean ~13:13 EDT. Show was at routine ~R171 area when /fresh called.

---

## Reason for refresh

Long Burlington show day session — context heavy from rapid mid-show iteration, multiple SWAP cycles, and broad next-break list management. /fresh called ~14:42 EDT.

---

## Next session pickup notes

**DO NOT:**
- Auto-start work from this file or the crash transcript — wait for operator instruction
- Make data fixes for R137/R137.5 (operator: "leave the data")
- Touch DART beyond read-only (machine_logs queries, log tail via SSH) without explicit go
- Start/stop user-facing apps on DART (CSE, Stream Deck, OBS, Lumix Tether, Chrome) — operator owns those (memory: feedback_never_kill_or_start_user_apps.md)
- Mark items ✅ unless END-TO-END working in operator's view (memory: feedback_partial_is_not_done.md)

**DO:**
- Resume show monitor cadence (~5 min heartbeats) if operator confirms still in show mode
- Pre-stage build + scp for next swap if there's a queued patch (currently `336e438` clock-slide cached-layout)
- Carry the next-break list forward — many items still queued (Wi-Fi display NVENC/HEVC rebuild post-show, in-app video split feature #30, etc.)

**Items deferred (operator-aware, not blockers):**
- #30 In-app video split feature (large, ~5-8 days)
- #31 Burned routine-number overlay (depends on #30)
- Wi-Fi display NVENC/HEVC Rust rebuild (post-show)
- Disable Windows AutoPlay popup on DART (one-shot PowerShell)
- UDC stinger lo-res Remotion render (tmux 14 agent waiting on operator's A-F quality choice)
