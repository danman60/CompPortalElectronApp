# HANDOFF: UDC media-package finalize failure (videos in R2, DB row stuck `pending`)

**Severity: HIGH — silent, parent-facing, recurring during live events.**
**Opened:** 2026-05-17 (UDC Cobourg, live). **Author:** Claude (CompPortal session).
**Status:** Root cause VERIFIED (code + DB evidence below). Interim mitigation applied + proven. Needs a durable fix.

## Symptom (proven)

Media uploads to R2 fully and correctly, but `media_packages.status` stays `pending` with `performance_video_url` / `judgeN_video_url` NULL. The portal/player reads those DB columns, so complete-in-R2 media is invisible to parents → "my dance is missing" support emails mid-event.

Evidence (UDC Cobourg, comp `7f796653-9e5a-4652-8968-21b7d18320fc`, tenant `00000000-0000-0000-0000-000000000004`), 2026-05-16→17:
- **28 routines** in this state in ~24h (R486, R493.5, R472.5, then a sweep found 25 more: R362, R471, R504, R513–526, R539–546).
- Each: `aws s3 ls .../<entryId>/videos/` showed `performance.mp4 + judge1/2/3.mp4 + keyframes + photos` all present, faststart-OK; DB row `pending`, all video-URL columns NULL, `updated_at` stale 1–12h, but `photo_count` > 0.
- Parent-reported via the media feedback form (Amanda Brown R486, Vanessa Berzak R472.5).

## ROOT CAUSE — verified, not inferred

**The `/api/plugin/complete` request that carries the video file paths never successfully reaches the server for these routines. The photo/partial calls do.** The server is NOT at fault — its logic is provably correct.

Verification chain:
1. **Code (`src/app/api/plugin/complete/route.ts:196-212`):** the route sets `videoData[<role>_video_url] = getMediaPublicUrl(path)` **the instant** `files[role]` is a non-empty string in the POST payload — deterministic, no gating. So a NULL video-URL column means no `/complete` call ever carried that video path.
2. **Code (`route.ts:323-345`):** status recompute = `hasAnyVideo && hasPhotos` → (with `auto_publish`) `published`, else `pending`. A row with photos but zero video URLs is *correctly* held `pending` by this logic — it has nothing to publish.
3. **DB (`competitions.auto_publish` = `true` for this comp):** so one `/complete` call carrying a video path → straight to `published`, no manual step. Confirmed: of **462 published** Cobourg rows, **462 have a performance_video_url AND photos** — zero exceptions. The published path requires a video URL and always has one.
4. **DB (stuck rows):** `photo_count > 0` and `updated_at` moved past `created_at` → the photo round-robin / partial `/complete` calls *did* land and were processed. Only the video-bearing call is missing. Videos are confirmed present in R2 (verified per entry). So: video files uploaded to R2 fine; the completion call that registers them never arrived.

This **eliminates** "server keeps it pending despite receiving the videos" — the server writes the URL whenever the path is present; the rows prove the path was never sent. The failure is entirely on the client→server completion call for the video payload.

### One open sub-question (does NOT block the fix)
Whether the video-bearing `callPluginComplete` (CSE `upload.ts:965`, `await`ed terminal call) **(a) never fires** (app closed / queue drained / routine never reached terminal state between the video R2 PUT finishing and the complete call) or **(b) fires and errors** (network/5xx; `upload.ts:1059-1079` then leaves the routine `encoded` for an operator manual-retry that doesn't happen during a busy show). Decisive diagnostic: pull CSE `events.log`/app logs from DART for a known-affected entry (e.g. R472.5 `22222222-e07a-4a02-0007-000000004725`, R546 `b3a52521-6278-4a79-b211-06a79e8da45b`) and grep `callPluginComplete` + the `/api/plugin/complete` POST + HTTP status. This only refines the *client* hardening; the recommended fix below is cause-agnostic and fixes it either way.

## Required fix

**Primary (cause-agnostic, ship this): server-side media reconciler in CompPortal.**
A job/endpoint that, per active competition, lists R2 `<entry>/videos/`; if `performance.mp4 + judge1..N.mp4` exist (faststart-OK) but the `media_packages` row is `pending`/missing video URLs, finalize it exactly as `/complete` would: set `performance_video_url`/`judgeN_video_url` from the R2 keys, ffprobe durations (range-read the moov — already done by `ffprobeDurationByR2Key`), `judge4_video_url` NULL when the comp is 3-judge, recompute status (honors existing `auto_publish`). Idempotent; guard `WHERE status <> 'published'`; never touches originals (DB-only repoint to existing objects). Run on a timer during events + expose a CD "Reconcile media" button. This *is* the manual sweep below — productized.

**Secondary (client hardening, CSE — refine after the DART-log diagnostic):** make the video-bearing completion durable: persist a per-routine "needs-complete" marker, retry `callPluginComplete` with backoff across app restarts until the server returns `published`/`complete`, and surface the unfinalized-routine count to the operator instead of silently leaving it `encoded`.

## Interim mitigation — PROVEN, repeat until the reconciler ships

Used successfully 2026-05-17 (recovered 25 in one pass; 0 collateral):
1. `SELECT entry_id FROM media_packages WHERE competition_id=<c> AND status<>'published'`.
2. Per row: `aws s3 ls s3://compsyncmedia/<t>/<c>/<entry>/videos/` — require `performance.mp4 + judge1/2/3.mp4` all present.
3. **Exclude** anything `updated_at` within ~15 min (live in-flight — never publish a mid-write row) and perf-only/partial rows (see R223 below).
4. Range-probe each `performance.mp4` first ~2.6 MB → `ffprobe` duration + confirm `moov` before `mdat`.
5. Batched, guarded: `UPDATE media_packages SET status='published', performance_video_url/judge1-3_video_url=<keys>, judge4_video_url=NULL, *_duration_seconds=<probed>, updated_at=now() WHERE entry_id=… AND status<>'published'`.
- R2 creds `CLOUDFLARE_R2_*` in `~/.env.keys`; bucket `compsyncmedia`; key `<tenantId>/<compId>/<entryId>/videos/<role>.mp4`.

## Not part of this bug (track separately)
- **R223 "1000 Years"** — `media_packages` perf-URL-only, no judges, `photo_count` 0, untouched since 2026-05-15 21:10 EDT. Distinct partial-capture case; investigate on its own, do NOT fold into reconciler scope.
- **R559–566** (9) — correctly left `pending` during the 2026-05-17 sweep; they were uploading that minute and should self-finalize (or be caught by the next sweep/reconciler).

---

## Log Investigation — VERDICT: cause (a) (terminal video-bearing `callPluginComplete` never fired). Cause (b) RULED OUT. 5/5 entries consistent.

**Method:** read-only on DART (live event — logs only). Decisive source: `machine_logs` table in Supabase COMPSYNC — a durable server-side mirror of CSE's `[Upload]` logger, 299,893 rows covering 2026-05-16 18:00 → 2026-05-17 13:06 EDT (fully spans the affected window). Cross-checked against DART local `events.log` (`C:\Users\User\AppData\Roaming\compsync-media\logs\events.log`, JSONL, 2026-05-16 00:37 → 2026-05-17 16:58 UTC) and `main.log` (1.32 GB, same userData path). Supabase `api`/`postgres` `get_logs` did NOT corroborate (retention windows: api 2026-05-17 13:05:54–13:06:10 EDT, postgres 12:12–13:03 EDT — both far short of the affected window; `/api/plugin/complete` is a Vercel route, not Supabase, so it would not appear there regardless). The `machine_logs` mirror is the server-side corroboration and it DOES cover the window.

**Key code signatures (CSE `src/main/services/upload.ts`):** terminal video-bearing path logs `Calling plugin/complete` (1856) → on 2xx `Plugin complete success` (1912) → `All uploads complete for routine <id>` (1043); on throw the `catch` (1056-1062) logs `Plugin complete failed for <id>: <err>` and sets status `encoded`. The photo round-robin (`callPluginCompletePartial`, 1690) also emits `Calling plugin/complete`/`Plugin complete success` but never `All uploads complete`.

**Cause (b) is fully ruled out:** ZERO `Plugin complete failed`, `completion call failed`, or `marked … encoded` lines exist for ANY of the 5 entries across the entire affected window. Every `Calling plugin/complete` is followed ~1–4 s later by `Plugin complete success`. No completion call ever errored; no routine was ever left `encoded` for a manual retry.

**Per-entry evidence (file: `machine_logs`, source=`main`, all timestamps EDT):**

- **R451 entry `ac0ff60e-…` — CONTRAST / SUCCESS.** Photo round-robin completes 20:00:36 → 21:07:30, then terminal `All uploads complete` **21:07:41**. Second cycle (video-bearing round; `events.log`: `upload.started fileCount:45` 23:25:03 → `upload.completed allMedia:true` 23:25:49): `Calling plugin/complete` **23:25:43** → `Plugin complete success` **23:25:47** → **`All uploads complete` 23:25:49**. Terminal complete for the video round fired and succeeded → DB `published` (created 19:17, published 23:25 — naturally, not by the mitigation sweep). This is the signature of correct finalization.

- **R472.5 entry `22222222-…0007-000000004725` — cause (a).** 100 partial complete/success pairs 20:12:25 → **last at 21:56:37**. Video files uploaded to R2 **23:07:50–23:09:04** (`performance.mp4`, `judge1/2/3.mp4`, `keyframe_0/1/2.webp` — all `Uploaded:` OK). **No `Calling plugin/complete` after 21:56 and no `All uploads complete` ever.** The terminal video-bearing completion for the post-video upload round never fired; videos sat in R2 with the `media_packages` row never told. (`events.log` shows repeated re-record/force-overwrite `queue.status` errors 01:30–03:31Z — the routine churned and the terminal complete was never reached.)

- **R526 entry `4bd00ba5-…` — cause (a).** 50 partial pairs 09:20:12 → **last at 09:30:45**. Video uploaded to R2 **09:44:22–09:44:53** (perf+judge1/2/3+3 keyframes OK). **No completion call after 09:30 and no `All uploads complete` ever.** Identical signature to R472.5.

- **R546 entry `b3a52521-…` — cause (a).** 52 partial pairs 10:41:56 → **last at 11:03:59**. Three `Restored state for UDC Cobourg 2026 … 548/548 routines matched` events at **10:28:39, 10:54:34, 11:04:23** (app reload/restart cycles during the routine's lifecycle). Video uploaded to R2 **11:40:19–11:41:02** (perf+judge1/2/3+3 keyframes OK). **No completion call after 11:03 and no `All uploads complete` ever.** Terminal complete never fired; the interleaved state restores explain why the in-memory `encodedFiles[].uploaded/storagePath` association needed by the terminal payload was not durable.

- **R486 entry `2a72d995-…` — cause (a), state-loss variant (important nuance).** Video files uploaded to R2 **22:51:06–22:51:20** (`performance.mp4`, `judge1/2/3.mp4`, `keyframe_0/1/2.webp` all `Uploaded:` OK). The photo upload queue then drained for ~80 more min; the terminal `Calling plugin/complete` **00:10:52** → `Plugin complete success` **00:10:56** → `All uploads complete` **00:11:02**. So a terminal complete *did* fire and *did* return 2xx — **but the only `Uploaded:` lines anywhere in the 00:08–00:11 terminal window are photos (`JP7A7826/7827/7828/7829.JPG`); no video file was in that final upload round's job set.** Per `upload.ts:909-922` the terminal payload's `files.performance/judge*` are populated only from `routineState.encodedFiles[]` where `uploaded && storagePath` are still set in memory. Between the 22:51 video R2 PUT and the 00:11 terminal complete the in-memory video `uploaded/storagePath` association was lost (state reload — same `Restored state` mechanism observed for R546), so the terminal POST carried a **photo-only payload**. Server (provably correct) wrote no video URL because the path was absent → row held `pending`. Net effect is identical to pure (a): **the video-bearing completion payload never reached the server**, even though a (photo-only) `/complete` returned 2xx.

**Verdict:** **cause (a)** for all 4 affected entries — the video-bearing terminal `callPluginComplete` never delivered the video storage paths to the server. 3 of 4 (R472.5, R526, R546) never fired a terminal complete at all after the video R2 upload; R486 fired a terminal complete that succeeded but carried a photo-only payload due to in-memory state loss of the video `uploaded/storagePath` flags. **Cause (b) (fire-and-error → left `encoded`) did not occur for any entry — zero failure/encoded log lines exist.** Common thread: CSE in-memory upload state (`encodedFiles[].uploaded/storagePath`, terminal-trigger reachability) is not durable across the long gap between the video R2 PUT and the terminal completion — and across app reloads (`Restored state … 548/548` events directly observed for R546). This corroborates the existing root cause ("video-bearing `/complete` never successfully carries the video path") and refines the open sub-question to **(a), with the dominant mechanism being lost/never-reached terminal completion + photo-only terminal payloads after state restore — not network/5xx errors.**

**Implication for the fix:** the recommended server-side reconciler (cause-agnostic) remains correct and is the right primary fix. The CSE-side hardening should specifically target **(1)** persisting the per-role `uploaded/storagePath` association durably (survive `Restored state`/restart) so any terminal complete after a state reload still carries the video paths, and **(2)** a durable "video uploaded to R2 but no terminal published-complete confirmed" marker that re-fires `callPluginComplete` with the full video payload until the server returns `published` — since the failure is silent (2xx photo-only or never-fired), not an error path the operator can see.

**Independent dual-source agreement (self-blame check):** the verdict was reproduced by two independent methods against two independent sources — (A) Supabase `machine_logs` mirror via SQL, and (B) a direct `Select-String` scan of the raw 1.32 GB `main.log` on DART. Both agree exactly on the decisive signals: `Plugin complete failed` count = **0** for all 5 entries; `All uploads complete` = R451:2, R486:1, R472.5:0, R526:0, R546:0. The two sources concur — verdict is not an artifact of one log pipeline.

**Provenance:** every quoted line is from `machine_logs` (Supabase COMPSYNC, durable CSE `[Upload]` mirror) cross-checked with DART-local raw `main.log` (`C:\Users\User\AppData\Roaming\compsync-media\logs\main.log`) and `events.log` lifecycle events (`recording.started/stopped`, `upload.started/completed`, `queue.status`, `encode.completed`). Read-only throughout; no writes, kills, or state changes on DART.
