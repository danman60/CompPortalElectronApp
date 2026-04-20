# CompSyncElectronApp — UDC London 2026 Weekend Retrospective

## Date range
2026-04-17 (Friday) → 2026-04-19 (Sunday), with dense Sunday 06:00–09:00 EDT dual-session (CSE+CompPortal) overnight-recovery window.

## Executive summary
Three live-show days at UDC London 2026. Friday ended with an 18-hour recovery slog (transcripts 04-18 CSE L2460: *"we've been at this for ~18 hours and I cant ge ta straight answer"*) stemming from clock-drift + wrong-TZ script labels + destructive overnight script that shifted 2,732 photos +1h. Saturday added its own incident (21,806-photo parallel full-drive import race, sharp thumbnail TypeError, R433 phantom-instance ghost recording). Sunday compounded it: R529/R530 re-record chaos (zero media_packages row for R530), -201s spurious P23 offset that misassigned ~4,298 photos, sharp 0.33.5 TypeError on every thumbnail (bug hidden by `if (copiedCount < 3)` log throttle), main-thread freeze during the 4,440-photo H:\ + 3,082-photo F:\ concurrent import, R483 repeat of the re-record class, and log rotation having already discarded every R483 forensic breadcrumb by the time we went looking.

Shipped this weekend: phantom-instance hard exit, window-all-closed guard, auto-SD import with minimized modal, SD watermark filter, per-camera-body offset detection + persistence + seed, orphan re-match on recording stop, drive+DCIM partition keys, wrong-day EXIF detection, clock-sync reminder + day-start/day-end checklists, EXIF-only timestamp rule, `photo_captured_at` in `/plugin/complete`, round-robin uploads, incremental `/plugin/complete`, sharp 0.32.6 downgrade + ffmpeg fallback, multi-SD FIFO queue, offset magnitude cap + zero-preferred short-circuit, aggressive main-thread yields, newest-photo clock-mismatch sampler, size-category-aware distribution-sanity thresholds, forward-going keyframe extraction, Gemini v2 keyframe-anchored validator (CompPortal), `competitions.media_published` kill-switch (CompPortal), Latest Photos feed (CompPortal), `/plugin/complete` upsert + `photo_captured_at` field-name alias fix (CompPortal c542a945 URGENT).

Still broken / at risk going into the next event: sharp thumbnail TypeError still fires (commit 452a6de8 fix verified not to work twice), UI freeze during imports (worker-thread refactor not built), re-record detection treats a legit new routine as a re-record when operator forgets to advance (R483/R529/R530), the -201s class of spurious offsets can still fire when detector sees reference-window gaps, and the debug HTTP server + log retention (v6) is built on SpyBalloon but not deployed.

**Highest-leverage single move:** move EXIF + matching + thumb generation onto a worker thread (`node:worker_threads`). This one change kills the UI freeze, lets thumbnail regressions fail loudly without cratering live-show responsiveness, and removes the need for main-thread yields to be tuned by hand every other release.

---

## Hardening / Efficiency Recommendations

### 1. Fix re-record detection — stop absorbing new routines into previous slot (HIGH)
- **Problem observed:** R483 (Sat 20:15), R529/R530 (Sun 09:27–09:30), R280, R291, R100 — same class. Operator started the next routine while app was still pointed at previous; app's re-record flow archived the real take to `_archive/v1/` and overwrote the DB window with the NEW routine's timing. R530 never got its own media_packages row at all.
- **Root cause:** `src/main/services/recording.ts:443` archives prior takes without distinguishing "operator re-shot the same routine in 30s" from "operator advanced to a new routine after a full performance."
- **Proposed fix:** Hard gate — if the new recording's duration > some threshold (e.g. >90s) AND the prior archive has processed outputs (performance.mp4 + keyframes already in `_archive/v1/`), require an explicit operator confirmation modal: "This looks like a new routine, not a re-record of R529 — advance instead?" Default to "Advance." Second defense: when we detect this pattern, automatically create a new media_packages row for the NEXT entry number and put the recording there, never silently overwriting the current.
- **Impact:** HIGH — produced three forensic recoveries this weekend, each 30+ minutes of manual DB surgery and R2 re-upload.
- **Evidence:** `docs/plans/2026-04-19-R529-R530-recovery.md`; 04-19 CSE L7202 *"Re-record flow treats a new recording in an in-progress slot as a re-record instead of advancing to next routine"*; L8412 *"Same re-record chaos class as R529/R530."*; 04-18 CSE L7214 *R100: 3.18 MB, mtime 12:24:32 UTC (bad/short re-record) ... 372.54 MB, 12:01:20→12:04:40 = 3m20s full-length*.
- **Effort:** M

### 2. Move EXIF + matching + thumbnail generation off the main thread (HIGH)
- **Problem observed:** 2026-04-19 13:11–13:13 EDT: operator clicked counter/overlay button during H:\ (4,440 new photos) + F:\ (3,082 new photos) concurrent import → UI unresponsive. 20+ upload jobs enqueued in ~1s (13:12:06–07). PID 19380 at 573s → 1,084s CPU in a few minutes.
- **Root cause:** Import pipeline runs on Electron main thread. Current `yieldToEventLoop()` every 10 EXIF reads is mitigation only — matching + per-photo enqueue don't yield enough. When the main thread is CPU-bound, IPC responses to renderer clicks queue up → "frozen."
- **Proposed fix:** `node:worker_threads` for EXIF read + matcher. IPC-only on main. Batch + debounce `jobQueue.enqueue` so we don't fire 20 enqueues in one tight loop. Cap per-tick work by routine-group, not by photo count.
- **Impact:** HIGH — unacceptable for live-show operation. INBOX already flags *"Do NOT ship another import-adjacent fix without this hardening."*
- **Evidence:** `INBOX.md` BUG (CRITICAL); 04-19 CSE L7595 *"I just attempted to click the counter button to take the overlay off and the app appears to be frozen and crashed"*; L7629 *"UI freeze during import (new, critical)"*.
- **Effort:** M–L

### 3. Actually fix the sharp 0.33.5 thumbnail TypeError (HIGH)
- **Problem observed:** `TypeError: A boolean was expected` at `photos.ts:910` and `:1217` on every photo. Hidden from operator by `if (copiedCount < 3)` log-throttle. Sunday H:\ import: **0 / 1,557 thumbs generated (0%)**. Post-swap to 0.32.6 + ffmpeg fallback on Sunday 13:53 EDT: still firing on H:\ at 17:07 EDT (*"supposedly fixed in commit 452a6de8 earlier today"*) — plus the ffmpeg fallback produced no thumbnail either. 7,251 photos wound up with NULL `thumbnail_url` over the weekend and needed PIL backfill scripts.
- **Root cause:** Unknown. Sharp works standalone on the same JPG (*"Sharp works locally on the exact same photo. So the bug is Electron-runtime specific, not a library bug"* — L5521). Explicit boolean options on `sharp(...).webp(...)` didn't help.
- **Proposed fix:** (a) Remove the `if (copiedCount < 3)` log throttle so we see real failure rate. (b) Standalone repro from `resources/app.asar.unpacked/node_modules/sharp/` per INBOX triage. (c) If sharp continues to regress in the asar runtime, switch thumb generation to jimp or pure ffmpeg and delete sharp from the hot path entirely. (d) Move thumb gen OUT of import (into upload worker pool), so a thumb failure never blocks a photo landing in R2.
- **Impact:** HIGH — 7,251 photos (~25% of weekend output) uploaded without thumbnails; forced CompPortal fallback + manual PIL backfill; Latest Photos page showed full 2–5MB JPGs instead of 200×200 webp.
- **Evidence:** `INBOX.md` first bug section; 04-19 CSE L5170 *"every photo for R515 is throwing TypeError ... ~1800 thumbnails failed"*; L5457 *"0 / 1,557 uploaded today (0% coverage)"*; L9198 *"every single photo inserted in last 20 min has thumbnail_url IS NULL (1,680 photos without thumbnails)"*; L7548 *"supposedly fixed in commit 452a6de8 earlier today"*.
- **Effort:** M

### 4. Deploy v6 debug HTTP server + dated log retention (HIGH)
- **Problem observed:** R483's 20:15 Saturday incident had **zero** forensic trace by the time we looked on Sunday — `main.old.log` had rotated over it; `perf.log` / job-queue snapshots were all that remained. R530's creation-window logs were gone too (main.old.log started 09:36 EDT, R530 finished ~09:30).
- **Root cause:** Logger rotates by overwriting `main.old.log`. 2-file ring with small max size. No structured event log.
- **Proposed fix:** Already built on SpyBalloon at `release/win-unpacked/resources/app.asar` (md5 `e36705506cf5f3677f27aa07497fe115`). Adds 100MB log segments + dated rotation (not overwrite), debug HTTP server on `127.0.0.1:8765` (9 read-only routes), structured `events.log` append-only + 2000-event ring buffer, and hot-path instrumentation (offset decisions with rejection reason, re-record archive pre-archive file listing — the trail R483/R529/R530 lacked).
- **Impact:** HIGH — every re-record incident this weekend became unrecoverable forensically after ~2h because logs rotated. This makes the R483/R529/R530 root cause actually diagnosable next time.
- **Evidence:** `CURRENT_WORK.md` "Deploy v6"; 04-19 CSE L7007 *"Logs for R530's creation window are gone — main.old.log starts at 09:36:35 EDT"*; L8432 *"Saturday night logs are gone — log rotation discarded them"*; L8454 *"Coding. Fix: bump maxSize + archive rotated logs with timestamp suffix instead of overwriting."*
- **Effort:** S (swap-only; already built and staged path verified)

### 5. Offset detector: require >=Nms margin vs zero, and never accept across reference-window gaps (HIGH)
- **Problem observed:** Sunday second F:\ import (10:35 EDT) detected `-201s` for P23 when the real offset was **0s** (same body was `0s` on H:\ at 09:22 EDT same morning). ~4,298 photos misassigned one routine earlier. Cause: R530 had no media_packages row at all → reference-window gap → detector's score landed on the N-1 shifted slot as best match.
- **Root cause:** `detectClockOffset` scored candidates without requiring a meaningful margin over the zero-offset baseline. Also scored against a reference set that had a missing routine window.
- **Proposed fix (partially shipped 13:00 EDT):** magnitude cap (rejects |offset|>60s) + zero-preferred short-circuit are live. Add: (a) margin requirement — accept non-zero only if candidate score beats zero-offset score by >=K% AND >=M absolute matches. (b) Refuse to score if reference-windows array has gaps >15min between consecutive entries — error out with "reference set incomplete, using zero offset." (c) Persist `rejection_reason` on every detector decision into events.log (v6).
- **Impact:** HIGH — the one -201s event cost ~30min DB realignment + 4,600-photo cascade move post-show.
- **Evidence:** 04-19 CSE L6713 *"If the camera was synced perfectly the whole day, the -201s offset detection was WRONG"*; L6833 *"missing R530 video window means the detector had a gap in the reference set"*; L6902 *"-201s is pure detector noise from the R530 gap"*.
- **Effort:** S

### 6. Clock-mismatch sampler: use newest-by-EXIF photos, exclude already-watermarked (MED)
- **Problem observed:** 2026-04-19 13:04 EDT — H:\ popup said "17 days off," F:\ said "2 days off." Both false. Camera clocks were correct.
- **Root cause:** `sampleAndReportCameraClock` in `driveMonitor.ts` samples first 5 JPEGs via BFS through DCIM — hits filename-alphabetical-oldest files, which on a cumulative SD are prior-day data.
- **Proposed fix (shipped partially in Sunday v3):** sampler now picks newest photos. Add: exclude photos whose filename is below the `sdWatermarks` for that body, so we never sample photos that will be filtered out anyway. Update popup text — *"matcher attempts offset correction automatically"* is stale now that the magnitude cap rejects big bogus offsets.
- **Impact:** MED — noisy false-positive UX, doesn't cause data issues but erodes trust in any real future warning.
- **Evidence:** `INBOX.md` CAMERA_CLOCK_MISMATCH bug section; 04-19 CSE L5109 *"CAMERA_CLOCK_MISMATCH: dominant=2026-04-17, daysOff=2, samples=5 ... Likely spurious — samples came from the Friday partitions"*.
- **Effort:** S

### 7. Persist expensive EXIF scans durably (MED)
- **Problem observed:** Friday overnight recovery required a full 30,904-photo EXIF scan on ASTEROID. When we went to reuse the data on Saturday, no prior full-SD EXIF scan existed anywhere durable — prior sessions wrote to `/tmp/` which got cleared. Had to re-scan the entire ~40k Saturday photos (3h48m) and again Friday night.
- **Root cause:** Scripts wrote to session-scoped `/tmp/` (or not at all); derivations were re-run from scratch every session.
- **Proposed fix:** Every full EXIF scan writes to **both** `~/compsync-<day>-recovery/full-exif-scan-YYYY-MM-DD.jsonl` AND `/mnt/firmament/compsync-recovery/` AND `docs/plans/`. Same for full R2 inventories and full DB exports. Document as a rule in CLAUDE.md memory (`feedback_persist_expensive_derivations.md` already exists — enforce it in the overnight script template).
- **Impact:** MED — this is already in memory; making it a hard rule in the recovery script templates closes the loop.
- **Evidence:** 04-18 CSE L6968 *"no prior full-SD EXIF scan exists anywhere durable. Previous sessions ran scans, wrote to session-scoped /tmp/ (or worse, never wrote JSON at all), and threw the result away."*; L7299 *"Full ASTEROID EXIF scan (30,904 photos) completed and persisted at ~/compsync-friday-recovery/full-exif-scan-2026-04-18.jsonl"*.
- **Effort:** S

### 8. Single-flight lock on `photos:import` (MED — already partially shipped)
- **Problem observed:** Saturday 10:19 → operator double-clicked Photos (because no visible progress) → two parallel 21,806-photo imports ran simultaneously, race-writing the same routine folders, EBUSY errors, sharp conflicts. App had to be closed mid-show.
- **Root cause:** No single-flight on the IPC handler.
- **Proposed fix:** FIFO queue (shipped Sunday for multi-SD) is the right primitive. Verify same-drive re-invocations go through the queue too, not just different-drive. Surface "Import already running — queued after H:\" in the UI (currently log-only).
- **Impact:** MED — single worst Saturday incident. Fix is largely shipped but needs verification + UI surface.
- **Evidence:** `docs/plans/2026-04-18-saturday-photo-import-incident.md` Bug C; 04-19 CSE L7491 *"Queuing import of F:\DCIM behind H:\DCIM (position 1) ← the new queue code firing correctly. Pre-fix this would have errored 'already importing.'"*
- **Effort:** S

### 9. Explicit timezone field in app settings + durable in EXIF logs (MED)
- **Problem observed:** Friday overnight recovery script labeled EXIF values `+00:00` (UTC) when they were actually EDT. Resulted in 4-hour match offset across ALL routines. 18-hour debugging session. Also fuelled the "clock was an hour off" lunch confusion.
- **Root cause:** Implicit reliance on "DART's system clock is Eastern." V8's `new Date()` interprets no-suffix ISO strings as local time of the host — works on DART but is a silent landmine if the machine ever boots UTC.
- **Proposed fix:** Settings → "Local timezone" (default `America/New_York`). Every EXIF persist writes explicit offset (`2026-04-17T08:18:28-04:00`). Scripts that consume EXIF log their assumed TZ on first line. `INBOX.md` already flags this — promote to P1 for next release.
- **Impact:** MED — no current incident but catastrophic if DART ever boots UTC or if we run recovery scripts from a UTC box.
- **Evidence:** `INBOX.md` "Configurable timezone storage"; 04-18 CSE L2747 *"Right. EXIF is camera-local EDT but the script labeled it +00:00 (UTC). My matching was 4 hours off the whole time."*
- **Effort:** M

### 10. In-app reconciliation tool for re-record chaos + orphan MKVs (MED)
- **Problem observed:** R529/R530, R483, R433 each required manual DART folder forensics (archives listing, mtime reading, duration probing) + DB INSERT/UPDATE + R2 re-upload + photo realignment. Each took 30–90 minutes post-show.
- **Root cause:** No built-in tool for the operator or for a Claude session to point at "R483" and say "something's wrong, figure it out."
- **Proposed fix:** A new app panel "Media Reconciliation" that for a selected routine: lists `_archive/vN/` entries + sizes + durations, shows top-level MKV + duration, flags mismatches (tiny top-level + normal archive = probable re-record chaos), and offers one-click actions: "promote archive/v1 to canonical," "create missing media_packages row," "realign photos to this window." Pure client-side preview + 1 DB write behind the scenes.
- **Impact:** MED — scales to future events. Today Claude does this manually every time; this makes it a 30-second operator task.
- **Evidence:** 04-19 CSE L6963 *"this manual forensic process (detect re-record chaos, missing packages, recover orphaned MKV → create routine row → realign photos) should be a built-in reconciliation tool in the app. Adding to the backlog."*
- **Effort:** L

### 11. Distribution-sanity validator: size-category-aware thresholds (MED — shipped, verify)
- **Problem observed:** Hard `>300 = flag` threshold raised false positive on legit Production routines (970 photos × 27 dancers) and missed a contaminated solo at 692 photos.
- **Root cause:** `photos.ts:1016-1040` used two hardcoded constants tuned to UDC averages.
- **Proposed fix (SHIPPED commit 5b43741):** `SIZE_BOUNDS` lookup by `Routine.sizeCategory`. Solo 30–300, Production 80–1500, etc. Verify the toast now includes the applied threshold so operators understand why Production 970 is NOT flagged.
- **Impact:** MED — Sunday CompPortal session flagged ~4 UDC solos with 500+ photos invisible to the old heuristic.
- **Evidence:** Commit `5b43741 feat(photos): size-category-aware distribution-sanity thresholds`; INBOX archive item from CompPortal-1 2026-04-19 10:20.
- **Effort:** S (done — just needs next-event validation)

### 12. Preserve original camera filenames end-to-end — rename only at download (HIGH, PROMOTED 2026-04-19 EDT)
- **Problem observed:** App renames photos to `photo_NNNN.jpg` on import. Friday recovery was much harder because original `P1965014.jpg` → `photo_0042.jpg` loses camera identity + burst-sequence position (burst siblings end up non-adjacent when round-robin distributes them). Operator Saturday: *"I also wonder if the app shouldn't be renaming name like that isn't it making it harder?"*
- **Root cause:** `src/main/services/photos.ts:887` renames `destFile = path.join(routineDir, `photo_${String(copiedCount+1).padStart(3,'0')}.jpg`)` for tidy routine folders.
- **Proposed fix (operator-directed 2026-04-19 18:08 EDT):** **Two-phase naming**. Preserve original camera filename EVERYWHERE internal — local disk (`routineDir/P1965014.jpg`), thumbnail sibling (`P1965014_thumb.webp`), R2 storage path, `media_photos.filename`, sort_order, CD views. **Rename ONLY at download time** — when a parent/SD/CD clicks "Download photos" the backend streams a ZIP where each entry is renamed to `{entry_number}_{routine_title}_{studio_code}_{dancer_name}_{original_filename}.jpg` (format TBD — configurable). Source stays canonical; download view is cosmetic.
- **Key benefits:**
  - Every future recovery — grep/sort/burst-sequence all preserve camera identity for free
  - Duplicate detection across SD re-scans becomes trivial (same camera, same filename = already imported)
  - Forensic timeline works (`P1965014` → `P1965015` → `P1965016` shows true shot order, current `photo_0042/0043/0044` does not because round-robin pulls from multiple camera sources)
  - No schema change required — existing `media_photos.filename` just changes what it stores
  - Download-rename is a presentation concern, lives entirely in the download route
- **Proposed fix — implementation steps:**
  1. CSE: remove rename at `photos.ts:887`; copy with original basename (`P1965014.jpg`)
  2. CSE: update thumb path in `photos.ts:901` to `P1965014_thumb.webp`
  3. CSE: `upload.ts` already uses `path.basename(photo.filePath)` — just works
  4. CompPortal: download route (wherever the parent/SD/CD "Download all" ZIP is generated) reads the package metadata (entry_number, routine title, studio code, dancer names) and maps each photo to friendly name on the fly. Config: a template string like `{entry_number}_{routine}_{studio}_{original}`.
  5. Migration: existing `photo_NNNN.jpg` photos can stay as-is (no rename needed — new imports use original names from today forward). Optional later: walk existing rows, match each `photo_NNNN.jpg` to its source EXIF and rename historical entries (low priority).
- **Impact:** HIGH — compounds over time. Every future recovery is faster. Parents/SDs get sensible ZIP contents. Operator stops manually explaining "photo_0042 was actually P1965014."
- **Evidence:** `INBOX.md` "Preserve original camera filenames"; 04-18 CSE L3059; 2026-04-19 18:08 EDT operator directive (this session).
- **Effort:** M — CSE changes are S; CompPortal download-rename is M (depends on current download surface).

### 13. Gate `/plugin/complete` field-name contracts behind integration tests (MED)
- **Problem observed:** Sunday 14:42 URGENT: `/plugin/complete` read `files.capture_times` but Electron had been sending `files.photo_captured_at` since 2026-04-18. Silent dropped: every Sunday photo on R510–R525 (3,286 rows) got `captured_at=null`. Required URGENT one-line alias + direct-to-main CompPortal deploy (`c542a945`) outside the planned lockstep, plus a state.json backfill pass.
- **Root cause:** Two repos evolved the payload contract independently; no round-trip integration test.
- **Proposed fix:** Shared contract file (JSON Schema or TS types in a submodule) consumed by both. CI test on CompPortal preview that posts a canned `/plugin/complete` payload and asserts the round-trip fields. Rename-safe: `photo_captured_at` preferred; `capture_times` legacy alias retained (already in place).
- **Impact:** MED — this incident drove a hotfix during a live show and a manual backfill pass.
- **Evidence:** CompPortal commit `c542a945 URGENT fix(plugin/complete): accept both photo_captured_at + capture_times`; 04-19 CompPortal L3024 *"Field-name bug in /plugin/complete route: reads files.capture_times but CSE has been sending files.photo_captured_at since 2026-04-18. Result: every Sunday photo today uploaded with captured_at=null (3,286 rows)."*
- **Effort:** M

### 14. Phantom-instance / stray-touch hardening (MED — shipped, monitor)
- **Problem observed:** Saturday 15:57–16:00 EDT — "phantom" second Electron instance spawned + died mid-show. Likely cause: Rust tablet-server uses `SendInput` to inject touch-to-mouse on monitor #1; during a tablet disconnect/reconnect storm a stray touch clicked the CompSync taskbar icon → Windows launched a new instance.
- **Root cause:** Single-instance lock fell through after whenReady emitted logs + fought for the same port.
- **Proposed fix (SHIPPED commit a4c9d31):** Failed single-instance lock → `app.exit(0)` immediately (was `app.quit()`). Boot log now includes `pid/ppid/argv` so we can see WHICH instance spawned. `window-all-closed` guard during recording blocks the classic quit path.
- **Next step:** Consider making the taskbar icon non-clickable or registering a Windows AppUserModelID filter so stray clicks on it no-op while a recording is active.
- **Impact:** MED — shipped; needs next-event confirmation. If stray clicks still cause issues, escalate to icon lock.
- **Evidence:** Commit `a4c9d31`; 04-18 CSE L6585 *"stray touches during tablet reconnect chaos can click the CompSync taskbar icon → Windows launches a new instance"*.
- **Effort:** S (done) / M (icon filter)

### 15. Keep keyframe extraction from SSHFS-timing out on live DART (MED)
- **Problem observed:** Sunday keyframe backfill: 31/440 routines failed with "extract-all-failed" — all ffmpeg 30s timeouts, all because the backfill ran 10:13–12:30 EDT during live DART encoding/upload. SSHFS contention starved the probe. Idempotent re-run post-show handles it but the first pass was wasted.
- **Root cause:** SSHFS + ffmpeg probe + live DART I/O doesn't fit in a 30s window.
- **Proposed fix:** (a) Backfill runs AFTER show by default; if operator wants it live, raise timeout to 120s. (b) Partial extraction (1/3 or 2/3) is still useful — script already tolerates it; verify the "1/3 keyframes" routines are marked as "needs-retry" not "complete-failed." (c) Consider running keyframe backfill on ASTEROID or FIRMAMENT against an SMB/OneDrive mirror of the MKVs instead of SSHFS — far fewer I/O hops.
- **Impact:** MED — cosmetic-ish (Gemini validator still works with 1 keyframe), but affects any future keyframe-based audit.
- **Evidence:** 04-19 CSE L6021 *"many routines logging '1/3' or '2/3 keyframes extracted' — ffmpeg partial extraction"*; L7748 *"94% of photos are being read via the /tmp/dart-to SSHFS mount ... DART is now under load from H:\ + F:\ imports, so SSHFS is contending."*
- **Effort:** S

### 16. Throttle renderer IPC event emission during bulk imports (MED)
- **Problem observed:** During SD import the main process emits thousands of IPC events (match progress, photo copy, upload %, plugin/complete). Renderer chokes. Operator's click sits behind the IPC queue → looks like a hang.
- **Root cause:** Per-photo IPC with no coalescing.
- **Proposed fix:** Coalesce progress events to ≤10/sec (leading + trailing edge). Route audio-meter ticks through a separate channel so they don't share a queue with import progress. Add a renderer-side responsiveness heartbeat: main pings every 2s, renderer responds; if the round-trip exceeds 500ms, surface "Import busy — controls may lag" banner.
- **Impact:** MED — UI-only, but operator-confidence-critical during live show.
- **Evidence:** 04-19 CSE L5368 *"during and after import, the main process emits thousands of IPC events to the renderer ... When it's chewing through 15k+ messages, your 'Next' click sits in the event queue behind them."*; L5248 *"UI lag from the renderer trying to render 3,649 incoming upload-progress events + audio meter updates at once."*
- **Effort:** S–M

### 17. Unblock thumbnail generation from the import path entirely (LOW — covered by #2/#3)
- **Problem observed:** When sharp fails on every photo during import, each photo still lands on disk (thumbnail failure is caught + logged), but without a thumb. The copy/thumb loop itself is main-thread-expensive and contributed to the UI freeze.
- **Root cause:** Thumb gen is synchronous with copy.
- **Proposed fix:** Skip sharp thumbnail gen during import entirely; upload worker pool generates thumbs as a post-copy step (jimp or ffmpeg scale=200:200). Removes sharp from the critical path. L7768 already proposed this: *"Skip sharp thumbnail gen during import — eliminates #1 (thumbnail bug) AND removes a major chunk of main-thread work."*
- **Impact:** LOW/MED — partially addressed by fixing #2 and #3, but cleanest long-term path is to just move thumbs to the upload worker.
- **Evidence:** 04-19 CSE L7768.
- **Effort:** S

### 18. Stop guessing on zero-photo routines — enforce PHOTOMATCH INVESTIGATION PROTOCOL (LOW)
- **Problem observed:** 2026-04-19 18:34 EDT: Claude said R291/R332/R502-R509 were *"pre-recorded takes from Saturday night (likely virtual/remote entries, or test takes)"* — pure business-logic hallucination. Operator (correctly) called it out: *"483 only has 1 photo"* → pivoted → R483 was a re-record, not a no-show.
- **Root cause:** Protocol violation. `CLAUDE.md` PHOTOMATCH INVESTIGATION PROTOCOL already bans these explanations.
- **Proposed fix:** No code change. Memory update: when operator asks about zero-photo routines, the first diagnostic is always "check `_archive/vN/` on DART for re-record artifacts." Add a debug endpoint on v6 `/debug/routines?zeroPhotos=true` that lists zero-photo routines with archive-folder listing inline — removes the guessing entirely.
- **Impact:** LOW — process / trust issue, not a code bug.
- **Evidence:** 04-19 CSE L8387 *"You're right — I speculated on R291/332/502-509 ('virtual entries', 'accidental short recordings', 'pre-recorded takes'). Those were business-logic guesses. Dropping them. Facts only."*
- **Effort:** S (debug endpoint)

### 19. Pre-event data-hygiene checklist before the first SD insert (LOW)
- **Problem observed:** Sunday morning: `state.json.cameraOffsets.P23 = -201000ms` was still persisted from Saturday's detector mistake. INBOX had flagged it as low priority but it remained cosmetic noise in day-start context.
- **Root cause:** No pre-show sweep.
- **Proposed fix:** Add a day-start checklist item: "Camera offsets from yesterday: <list>. Clear?" defaulting to Clear. Blocked: only clears same-day. This prevents yesterday's mistakes from biasing today's detector seeds.
- **Impact:** LOW — but zero-friction to ship.
- **Evidence:** `CURRENT_WORK.md` task 4 *"Clear persisted P23 offset — state.cameraOffsets.P23 = -201000ms ... Low priority — cosmetic."*
- **Effort:** S

### 20. Auto-recover orphan MKVs on app start (LOW)
- **Problem observed:** R433 ghost recording — OBS kept writing past a 15:59 app restart; MKV sat in OBS output folder, not linked to any routine. Required manual Claude intervention + SCP + DB update.
- **Root cause:** `checkAndRecover` / `scanForOrphans` exists but doesn't surface actionable UI.
- **Proposed fix:** On app start, if `scanForOrphans` finds an MKV whose window overlaps a routine currently in `recording` state, pop a dialog: "Orphaned recording: 433_BURY_.mkv (306MB). Link to R433 or discard?" — one click, no DB gymnastics. (CompSyncElectronApp already proposed this pattern on 04-18 L6133.)
- **Impact:** LOW — already handled by Claude for R433; this makes it operator-self-service for future events.
- **Evidence:** 04-18 CSE L6017 *"Nothing recorded to R100. Post-show, rename the MKV into R433's output folder and re-link — no data loss."*; L6133 *"Dialog 'Orphaned Recordings Found — 433_BURY_.mkv (306MB)' pops → click Recover"*.
- **Effort:** M

---

## Feature Suggestions

### 1. "Advance routine" confirmation modal when operator mid-show-restarts (HIGH)
- **User pain point:** R483, R529/R530 re-record overwrites were all user-behavior-plus-race-condition. Operator started next routine while app still pointed at previous. There's no in-app warning.
- **Proposed feature:** If new recording's duration exceeds 90s AND prior archive has processed outputs, a non-blocking toast appears in OBS overlay: "Starting R484 — prior R483 take archived. Tap if this is a NEW routine, not a re-record." One-tap advances; no tap = continue as re-record.
- **Why now:** 3× incidents this weekend, all same class.
- **Scope:** S (UI only; detection logic feeds from ticket #1 hardening item).
- **Evidence:** See hardening #1.

### 2. Latest Photos feed integrated with round-robin upload visibility (HIGH — partially shipped)
- **User pain point:** 04-19 CSE L5372: *"Could be for a button maybe at the top of the dashboard that says latest photos which could be clicked into that would just show a constant stream of all the latest photos that are being uploaded as opposed to the operator having to clip with each routine row"*
- **Proposed feature:** (a) CompPortal Latest Photos SHIPPED Sunday (`8e6b2a5f`). (b) Add deep-link from CSE — button on the Electron app that opens the portal Latest Photos view scoped to current comp with `since=<last-app-session-start>` URL param. (c) Indicator badge inside Electron when new uploads are landing (polling the Latest Photos endpoint or reading job-queue stats directly). That way operator can triage without leaving the app.
- **Why now:** CompPortal side is live; Electron-side affordance is missing.
- **Scope:** S (Electron button + URL param wiring).
- **Evidence:** CompPortal commit `8e6b2a5f`, `1dcb8045`, `86ca27dc`, `9e72a18a`.

### 3. SD "Preview import" mode before committing (HIGH)
- **User pain point:** INBOX "Dry-run / preview mode for SD imports (P1)" — operator wants to see the projected per-routine counts + orphan list + any swap-window detection BEFORE the matcher commits to writing state.
- **Proposed feature:** New button in DriveAlert: "Preview import" (runs exactly the same pipeline but writes to a preview JSON, no disk copy, no uploads). Shows operator: "H:\ will add 4,440 photos across 12 routines. R571 projected 300 photos (warn: above median). 48 orphans — 12 in R572's window ±5s. Offset: 0s. Accept?"
- **Why now:** Twice this weekend the operator would've caught bad offsets / contamination before data hit the DB.
- **Scope:** M.
- **Evidence:** `INBOX.md` "Dry-run / preview mode for SD imports (P1)"; Sunday -201s + Saturday cross-day pollution both preventable.

### 4. Explicit "Apply this offset? Y/N" toast on non-zero offset detection (HIGH)
- **User pain point:** 04-19 CSE L4376: *"Fair. That's exactly the failure mode that caused Friday's 18-hour debugging session — a wrong offset silently applied to 20k photos."*
- **Proposed feature:** When detector returns strong non-zero candidate, show a toast: "Camera P16 +15min off (86% match, N=132). Apply for today?" — Yes/No/Skip. Default focus on Yes (safe for well-scoring cases). Weak candidates prompt for manual minutes input. INBOX "Auto-detect offset confirmation modal" item already specs this.
- **Why now:** Two silent wrong-offset events this weekend (Friday overnight script +1h, Sunday -201s).
- **Scope:** S.
- **Evidence:** `INBOX.md` "Auto-detect offset confirmation modal"; 04-19 CSE L4376.

### 5. Double-click routine row → notes editor (MED)
- **User pain point:** `Routine.notes` + `NoteEditor` component + `STATE_SET_NOTE` IPC all exist, but only wired to a tiny ✎ button. Operator asked for double-click during show.
- **Proposed feature:** `onDoubleClick` on the `<tr>` in `RoutineTable.tsx:468` opens the editor. Zero backend change; pure UI wire-up.
- **Why now:** Live-show friction — operator needs notes during the run, not later.
- **Scope:** S (trivial wire-up).
- **Evidence:** `INBOX.md` "Double-click row → operator note editor"; INBOX `2026-04-18 15:20 ET`.

### 6. Camera-clock-sync reminder modal with big seconds readout (MED — shipped, polish)
- **User pain point:** 04-18 CSE L1418: *"I'll also like to add to the electron app that on app start every time. There should be a reminder modal front and center to match the system, clock to the photo camera clock and a big bright readout of the system clock including seconds. So it's easy for the user to match. And maybe that modal pops up again and is always dismissible but pops up again during a period when there's no recording for 10 minutes"*
- **Proposed feature (SHIPPED base version 3f7323b):** `ClockSyncReminder.tsx` lives. Polish: seconds readout should be XXL font. Re-pop logic on 10-min no-recording idle is spec but verify. Add a one-click "Mark cameras synced at HH:MM:SS" button that resets the day's offset baseline.
- **Why now:** Root cause of Friday disaster was cameras 70 min fast. This modal would've caught it.
- **Scope:** S (already ~70% there).
- **Evidence:** Commit `3f7323b feat(clock-sync): front-and-center camera clock reminder modal`; L1418 source.

### 7. "Import busy — controls may lag" status banner (MED)
- **User pain point:** During the 13:11 freeze, the operator didn't know whether the app was hung or working. Had to ask Claude.
- **Proposed feature:** Renderer pings main every 2s; if round-trip >500ms, show a sticky banner: "Import busy — Next/Overlay buttons may take a moment." Clears automatically when responsiveness returns.
- **Why now:** 04-19 CSE L7595 *"I just attempted to click the counter button to take the overlay off and the app appears to be frozen and crashed"* — operator shouldn't have to guess.
- **Scope:** S.
- **Evidence:** `INBOX.md` bug section proposing it; L7595.

### 8. One-click "Mark current SDs as already processed" watermark calibrator (MED)
- **User pain point:** Friday/Saturday SDs carried prior-day photos — the watermark system catches this but requires prior import runs. After any manual recovery pass (like the ASTEROID overnight ones), the in-app watermark is stale.
- **Proposed feature:** Button in Settings or a day-start checklist step: "Mark current SDs as fully processed up to now." Iterates SDs, sets per-body watermark to current-max filename. Prevents re-processing.
- **Why now:** Saturday + Sunday both had SDs carrying prior-day data; the watermark system is reactive, this makes it proactive.
- **Scope:** S.
- **Evidence:** 04-18 CSE L3153 *"Add a one-click calibration button — 'Mark current SDs as already processed.' Sets watermark to current-max for each camera body. Operator clicks this once after Fri/Sat manual work, then future inserts only pick up new photos."*

### 9. In-app Media Reconciliation panel (MED)
- **User pain point:** Every re-record chaos incident (R483, R529, R433) required Claude + SSH + SCP + DB surgery.
- **Proposed feature:** See hardening #10.
- **Why now:** 3 incidents this weekend. Next event (whichever) will have more.
- **Scope:** L.
- **Evidence:** L6963 (see hardening #10).

### 10. Worker-thread progress pill with cancel (MED)
- **User pain point:** The Saturday 10:19 parallel-import disaster was because the manual Photos button is silent for 20+ min on 21k photos. Operator clicked twice thinking the first hung.
- **Proposed feature (partially shipped via pill):** Overlay-mode progress pill (shipped) + cancel button + per-phase breakdown ("EXIF scan: 4,440/7,522 — matching in 2min"). Progress pill currently shows just a count.
- **Why now:** Already a shipped primitive; cancel affordance is the missing bit. When the #2 worker-thread refactor happens, add cancel to it.
- **Scope:** S (incremental to worker-thread refactor).
- **Evidence:** `docs/plans/2026-04-18-saturday-photo-import-incident.md` Bug B; commit `a4c9d31 feat(show-survival)`.

### 11. Temp routine / "shoot without routine" fallback (MED — shipped, validate)
- **User pain point:** R433 phantom spawn + R100 first-in-list absorption, and generally any "record but not pointed at the right routine" scenario.
- **Proposed feature (SHIPPED a4c9d31 no-routine-fallback):** Capture into a temp bucket that can be assigned to a routine afterward, rather than silently absorbing into the first routine in the list. Validate this works end-to-end next event.
- **Why now:** Saved Sunday. Harden for next event.
- **Scope:** S (validation).
- **Evidence:** Commit `a4c9d31 feat(show-survival): phantom-instance exit + no-routine-fallback + SD auto-flow + rematch`.

### 12. Per-competition "media ready" publish kill-switch surfaced in CSE (LOW)
- **User pain point:** Parents mess with Media Portal before CD has culled. Sunday CompPortal shipped `competitions.media_published` default false as the kill-switch — but Electron app has no indicator of the state.
- **Proposed feature:** In Settings → show "Media portal published: [status]" with a link to toggle on CompPortal. Non-interactive read-only surface so operator knows whether parents are currently seeing the set. Future: toggle in-app.
- **Why now:** CompPortal side shipped Sunday; Electron awareness is missing.
- **Scope:** S.
- **Evidence:** CompPortal commit `f7e244a1 feat(media): per-competition publish/block toggle on CD dashboard`; CSE memory `project_media_published_toggle.md`.

### 13. Debug HTTP endpoint surfaced via SSH tunnel for Claude sessions (LOW — shipped, document)
- **User pain point:** Every Claude session SSH-greps `main.log` manually. Different sessions rediscover the same queries.
- **Proposed feature (SHIPPED in v6):** `curl http://localhost:8765/debug/state|queue|routines|logs|events|archives|health|offsets|watermarks`. After deploy, document the ssh tunnel command as a reusable pattern in memory (`reference_asteroid_deploy.md` or a new `reference_cse_debug_endpoint.md`).
- **Why now:** Built but not deployed; no cross-session knowledge yet.
- **Scope:** S (doc once deployed).
- **Evidence:** `CURRENT_WORK.md` "Deploy v6"; 04-19 CSE L8747.

### 14. Day-start + day-end modal checklists (shipped — audit) (LOW)
- **User pain point:** Operator context loss between days — forgot to sync cameras, forgot to eject SDs before launch.
- **Proposed feature (SHIPPED c15b681 day modals):** `dayChecklist.ts` + `StartOfDayModal.tsx`. Verify on next event that every item is actionable (not info-only).
- **Why now:** Audit ensures the shipped version is worth the modal real-estate.
- **Scope:** S (audit only).
- **Evidence:** Commit `c15b681 fix(app): mid-show stability + Friday recovery toolkit + day modals`.

### 15. Round-robin upload strategy (shipped) with per-routine completion indicator in CD view (LOW)
- **User pain point:** 04-19 CSE L3333: *"Okay, photos are uploading and being used but they don't appear to be uploading by routine order. It appears to be random"* — operator didn't realize round-robin was the intentional new behavior.
- **Proposed feature (SHIPPED 452a6de8 round-robin):** CompPortal CD dashboard could show a per-routine "% uploaded" bar that sums to 100 when the final plugin/complete fires. Removes the "is it done?" ambiguity under round-robin.
- **Why now:** Round-robin shipped Sunday + incremental plugin/complete; the progress indicator is the other half.
- **Scope:** S (CompPortal change).
- **Evidence:** Commit `452a6de8`; L3333 source.

### 16. Automated thumbnail backfill script triggered by CD dashboard (LOW)
- **User pain point:** Weekend produced 7,251 photos with NULL `thumbnail_url` from the sharp bug. Backfill required manual SSH + Python invocation.
- **Proposed feature:** CD dashboard "Regenerate thumbs for routine X / comp Y" button that invokes the backfill script as a queue task (could run on ASTEROID / FIRMAMENT against R2 sources). Falls back to R2 download + re-encode if local JPEGs deleted.
- **Why now:** Sharp will regress again. We now have 7,251 rows of history showing manual backfill was needed twice this weekend (Fri + Sun).
- **Scope:** M.
- **Evidence:** 04-19 CSE L5457, L6638 *"6,807 photos need thumbnails"*; `/tmp/thumb-backfill.py`, `/tmp/thumb-backfill-friday.py` both written ad hoc.

---

## Already queued / in progress (don't duplicate)

From `CURRENT_WORK.md` (do not re-propose):
- **Deploy v6** — built, staged on SpyBalloon, NOT yet on DART. Includes: 100MB log rotation, debug HTTP server on :8765 (9 routes), structured events.log + 2000-event ring buffer, hot-path instrumentation.
- **R291 (Fri), R332 (Sat), R502-R509 (Sat eve)** — pending data recovery when DART I/O allows.
- **31 failed keyframes** — idempotent re-run post-show.
- **Worker-thread refactor for EXIF + matching** (listed as future; item #2 above fleshes it out).
- **Re-record detection UX** (listed as future; item #1 above fleshes it out).
- **Offset state per-session scoping**.
- **"Import busy" UI banner** (listed as future; item #7 above fleshes it out).

From `INBOX.md`:
- Thumbnail TypeError real triage plan (do NOT retry explicit-options approach).
- Main-thread saturation hardening path (do NOT ship more import-adjacent fixes without it).
- CAMERA_CLOCK_MISMATCH sampler fix (sampling strategy + popup message staleness).
- Video keyframe backfill full run.
- Operator notes double-click wire-up.
- Preserve original camera filenames.
- Configurable timezone storage.
- SD dry-run / preview mode.
- Auto-detect offset confirmation modal.

CompPortal parked items (`CompPortal/CURRENT_WORK.md`):
- Photo Auto-Pick ML (`2026-04-19-photo-autopick-ml.md`).
- Media Integrity Phase B/C/D (`2026-04-19-media-integrity-system.md`).
- CompPortal-side thumbnail backfill for the ~5,700 UDC NULL-thumb photos.

## Deferred / out-of-scope

- Tether path refactor (live tether was off this weekend — operator used SD-only per `feedback_every_routine_captured.md`). Not urgent until it's used again.
- Moving thumbnail gen to the upload worker pool — covered implicitly by items #2/#17 but deferred until worker-thread refactor lands.
- Windows taskbar icon filter to block stray touch clicks — hard/flaky; re-visit only if single-instance exit fix proves insufficient after next event.
- Sharp → jimp migration — defer until sharp failure rate demonstrably beats fix attempts, or until the worker-thread refactor makes the swap painless.

## Top 3 priorities by leverage

If the operator can only do three things before the next event, these are them:

1. **Worker-thread refactor** for EXIF + matching (+ thumb gen moved out of import). Kills the UI freeze, defangs sharp regressions, removes main-thread-yield tuning as a perpetual knob. (Hardening #2, cross-references #3 #16 #17.)
2. **Ship re-record detection UX + v6 debug server/log retention.** One prevents new incidents; the other ensures the next one is diagnosable instead of lost to rotation. (Hardening #1 + #4 + feature #1.)
3. **Pre-import preview + explicit offset confirm.** One dialog each. Catches both classes of silent data corruption (cross-day pollution, spurious offsets) before they hit the DB, at zero live-show cost. (Feature #3 + feature #4 + hardening #5.)
