# Encode Deadlock — Handoff for Codex (LIVE SHOW, ENCODE DOWN)

Written 2026-05-17 ~11:15 EDT. UDC Cobourg 2026 show is LIVE and recording. **Video encode has been DEAD since 10:23:35 EDT (~50 min). Backlog growing ~1 routine/few-min, falling toward 50+ behind.** DO NOT TOUCH PRODUCTION without operator's explicit go. This doc is for whoever fixes it next — facts only, no theory.

## The symptom

- Zero ffmpeg activity since **10:23:35 EDT**. `last [FFmpeg] FFmpeg command:` = 10:23:35, `last frame=` = 10:24:47. Nothing since across ~50 min.
- `~26+` routines have no performance video and need encode; recording is live and continuing (reached routine ~548), so the gap is widening in real time.
- Encode worker is its own independent loop (`getNext('encode')` in `src/main/services/ffmpeg.ts` ~line 780; self-rescheduling). It is NOT producing ffmpeg.

## Confirmed root cause (evidence-based, from Supabase `machine_logs`, table `machine_logs`, col `ts` UTC→America/New_York)

**A single routine — #539 "KING KUNTA" — is stuck in `encoding` state and creates a self-perpetuating deadlock:**

1. 539 went `→ encoding` at 10:23:35 on the pre-swap build. Its ffmpeg was killed when the operator closed the app at ~10:25 for an asar swap.
2. On every relaunch since, 539 is still/again in `encoding` status (persisted state, survives process restart — it is in DART `compsync-state.json` and/or the job queue, NOT just memory).
3. The app derives an **`ffmpeg-busy`** condition from a routine being in `encoding`. With 539 perpetually `encoding`, `ffmpeg-busy` = true.
4. The startup encode auto-resume is **skipped when `ffmpeg-busy`**: log line `[App] Auto-resume skipped: ffmpeg-busy` (earlier it was `Auto-resume skipped: sd-import-in-progress`; once the SD card was removed the blocker MUTATED to `ffmpeg-busy`).
5. So: 539 stuck `encoding` → `ffmpeg-busy` true → encode-resume skipped → no ffmpeg ever spawns → 539 never leaves `encoding` → **permanent deadlock.**
6. Operator force-clearing 539 in-app does NOT work: it flips `encoded → encoding` straight back (observed `encoded → encoding` at 11:12:44, which was the operator's own clear attempt bouncing back). Something re-promotes 539 to `encoding` immediately.

`resumeRecordedRoutines()` (`src/main/services/ffmpeg.ts` ~line 1238, signature `(): number`) has been verified to have NO internal sd-import guard. Last time it logged `Resume recorded: queued N recorded routine(s) for encoding` was **20:14 yesterday** — it has not fired on ANY relaunch today (combined 10:28, ffrevert 10:54, latest 11:04:21 "Startup complete. 1661 jobs resumed").

## 539's actual DB state (Supabase, comp `7f796653-9e5a-4652-8968-21b7d18320fc`)

- entry 539 "KING KUNTA": `entry_status=registered`, `live_status=queued`, `media_packages.status=pending`, **`performance_video_url` = NULL** (no encoded video), 0 judges, photo_count=20, pkg updated 11:02 EDT.
- i.e. 539's video genuinely does NOT exist yet — it needs a real encode. It is not a "media already done, just stale flag" case; the source `.mkv` exists on DART (`...\UDC Cobourg 2026\539\539_KING_KUNTA_.mkv`) and must be encoded.

## What operator levers have been exhausted (none work)

- **Relaunch** (3×, incl. one with SD card OUT): startup encode-resume skipped (`sd-import-in-progress`, then `ffmpeg-busy`). Resume never fires.
- **Manual queue-kick**: fires `kickPhotoImports` (re-triggers photo import) + a job-queue kick; does NOT break the ffmpeg-busy deadlock.
- **Row "Nudge" action**: does not re-invoke encode resume.
- **Force-clear 539 in-app**: bounces `encoded → encoding` right back, re-deadlocks.
- SD card removed: ruled out sd-import as the (current) blocker; revealed `ffmpeg-busy` as the next gate.

## Builds in play (DART `C:\CompSync-staging\` staged, NONE swapped except where noted)

- **LIVE on DART now**: `app.asar` = `ffrevert` build, sha `ef44c08f7ebaf372482f0061173c8bb41806d55de381f15f6728eb97cc933569`, 132,569,626 bytes. = HEAD encode region (plain CPU-decode + `h264_nvenc -preset p4`, no `-hwaccel`, no cuvid) + orphan-resume + photo-tier[A] + exif-bookmark + archive-media + chat-highlight + Codex upload-speed/stinger. Swapped 10:52 EDT. Rollback backup: `C:\Program Files\CompSync Media\resources\app.asar.bak.20260517-ffrevert-pre` (the frozen combined `FF281CF0`).
- `C:\CompSync-staging\app.asar.kickfix.new` — sha `63d8065c466085365b4bb53026ba9e8c816a73fa2d1e20d25e89d959070dbd4f`, 132,575,226 bytes. Makes the manual kick call `resumeRecordedRoutines()` explicitly + logs it + bypasses the **sd-import** gate. **WARNING: this targets the sd-import gate, NOT the `ffmpeg-busy` gate that is the current live blocker. It is NOT verified to break this deadlock. Do not swap it assuming it fixes 539.**
- `app.asar.new` (combined chat+archive `FF281CF0…`), `app.asar.chatfix.new` (`339c2376…`) — older staged, irrelevant to encode.
- Rollback to last-known-good encoder: `app.asar.bak.20260517-combined` = sha `089283…`, 132,558,065 — this build *did* encode fine until 10:23:35 today, but its relaunch path has the SAME ffmpeg-busy/resume gating, so a naive rollback+relaunch will likely deadlock identically while 539 is stuck.

## The actual problem to solve (for Codex)

Two coupled defects in the encode-resume / ffmpeg-busy logic (file: primarily `src/main/services/ffmpeg.ts`, also `src/main/index.ts` ~619-645 startup auto-resume, `src/main/services/mediaReconciler.ts:264` sd gate, `src/main/ipc.ts` JOB_QUEUE_KICK ~1371-1410):

1. **`ffmpeg-busy` is a false/stale condition.** It is asserted because a routine (539) is in `encoding` status with NO actual ffmpeg process running (provable: zero ffmpeg for 50 min). The busy check must be reconciled against reality — if no ffmpeg child process is alive and no `frame=` progress for N seconds, `ffmpeg-busy` must self-clear; a routine in `encoding` with no live ffmpeg must be treated as resumable, not as "busy".
2. **The deadlock is unbreakable by design**: every recovery path (startup auto-resume, kick, nudge) that would re-encode 539 is itself gated by the very `ffmpeg-busy` flag that 539-stuck-in-encoding asserts. There must be a recovery path that is NOT gated by `ffmpeg-busy` (or that force-resets a stale `encoding` routine whose ffmpeg is dead), so the system can self-heal. The operator hardening requirement: "if recorded/encoding routines exist and no ffmpeg has progressed in N minutes, force-clear stale encode state and re-run the resume — must not depend on a manual kick, must not be gated by the stale flag."

## Immediate-mitigation candidate (NOT yet done — needs operator go; this is the lever, decide/verify before acting)

Surgically reset 539's stuck `encoding` state at the source so it stops asserting `ffmpeg-busy` and stops bouncing back, then let the (now-ungated) resume enqueue it + the backlog:
- DART `compsync-state.json` is the persisted state (electron-store). Editing requires: **app CLOSED**, **no-BOM write** (`[System.IO.File]::WriteAllText` with `UTF8Encoding($false)` — `Set-Content -Encoding UTF8` adds a BOM that wipes ALL settings on next launch; this is a documented prior incident — DO NOT use Set-Content).
- Set routine 539 status to `recorded` (NOT `encoding`, NOT `encoded` — its video does not exist, it must encode fresh) and clear whatever field drives the `encoding`/`ffmpeg-busy` derivation, so on relaunch the resume sees 539 as a normal `recorded` routine to encode and `ffmpeg-busy` is false.
- UNVERIFIED: exactly which field(s) in compsync-state.json drive the `encoding` status + `ffmpeg-busy` derivation, and what re-promotes 539 to `encoding` after a clear (step 6 above). Codex must read the state schema + the ffmpeg-busy/resume code to get this exactly right before any write. Getting it wrong risks wiping operator settings or re-deadlocking.

## Hard rules (unchanged, critical — LIVE SHOW)

- Never close/kill/restart the app or any process on DART — operator owns close+relaunch.
- Each asar swap = its own explicit operator-gated action; build local, scp to staging, byte-verify, operator-gated single-line `Move-Item` cutover, then operator relaunches.
- `compsync-state.json` writes only with app closed + no-BOM (`[System.IO.File]::WriteAllText`, `UTF8Encoding($false)`).
- DART logs via Supabase `machine_logs` (MCP `supabase-COMPSYNC`), col `ts` is UTC → convert to America/New_York. Never ssh DART for logs.
- Build: `npx electron-vite build && npx electron-builder --win --dir` (NOT `npm run dist` — needs dotnet, absent). Output `release/win-unpacked/resources/app.asar`.
- GitNexus MCP is DOWN — use `git diff` / source reads for impact.
- No DB/R2/CompPortal writes without explicit operator go (additive/idempotent only; the comp DB shows 539 needs a real encode — do not mark it done in DB).
- Number-first, no invented business logic, verify before declaring, self-blame before victim-blame.

## OUTSTANDING: Stream Deck plugin install (NOT done — operator expected it)

- The UDC Stinger Stream Deck plugin was staged by Codex at `C:\CompSync-staging\streamdeck-plugin` (22 files, 2026-05-17 09:02:43 EDT). Contains `com.compsync.streamdeck.udc-stinger` and the `setUdcStingerTransition` WebSocket action. The Stream Deck plugin is NOT inside `app.asar` (separate extraResource).
- **It was never installed to the live Stream Deck plugin directory.** Only `app.asar` was swapped. Operator expected the Stream Deck folder installed as part of the combined swap; it did not happen.
- Live `app.asar` = ffrevert (`ef44c08f`) which DOES contain the stinger **app-side** code (`setUdcStingerTransition`, `plugin.ts` registration) — so the staged plugin folder is compatible with what's live.
- **Install step (NOT performed — needs operator go; LIVE SHOW, Stream Deck is an operator-owned user-facing control surface):** copy `C:\CompSync-staging\streamdeck-plugin\com.compsync.streamdeck.sdPlugin` (verify exact folder name from the staged manifest) into the Stream Deck plugins directory (typically `%APPDATA%\Elgato\StreamDeck\Plugins\` — **UNVERIFIED, confirm exact target from the streamdeck-plugin manifest / the running Stream Deck install before copying; do not guess a path on the live machine**), then operator reloads/restarts Stream Deck. Copying into a running Stream Deck hot-reloads it — disrupts live controls, so this is operator-timed between routines.

## State of failed Claude attempts this incident (so they're not repeated)

1. Swapped a combined build (chat+archive+cuvid GPU pass) → encode froze. Wrong: blamed nothing concrete first.
2. Built+swapped `ffrevert` (reverted ffmpeg cuvid/GPU pass) → did NOT fix it. Proved the GPU code was never the cause.
3. Theory "SD-import gate blocks encode" → operator removed SD, relaunched → still dead, blocker mutated to `ffmpeg-busy`. Theory wrong.
4. Built `kickfix` (kick→resumeRecordedRoutines, sd-gate bypass) → targets wrong gate (sd, not ffmpeg-busy); staged, NOT swapped, NOT verified to fix this.
Net: the only solid, evidence-backed conclusion is the 539/`ffmpeg-busy` deadlock described above. The fix is in the ffmpeg-busy/resume self-heal logic + a one-time surgical 539 state reset to break the current deadlock.
