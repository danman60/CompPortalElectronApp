# UDC Toronto 2026 — Post-Mortem & Hardening Plan

*(Originally opened as: "Incident Report — Photo Import Cliff at R540 (UDC Toronto Day 3)". Scope expanded 2026-04-26 19:40 EDT to cover the full UDC Toronto post-mortem — photo cliff, re-record drama, queue saturation, EXIF +00:00 misattribution, recovery operations, and the consolidated hardening plan.)*

**Date opened:** 2026-04-26
**Reported:** 16:28 EDT
**Status:** Recovery complete; document evolving into the spec for the next pipeline iteration.

## Scope

This post-mortem covers every notable failure or design weakness exposed by UDC Toronto 2026:

1. **Photo import cliff** at R540 (08:38 EDT), 9-hour silent failure (the original incident report)
2. **Job-queue saturation cascade** that blocked R667–R675 video uploads (cascade off the cliff)
3. **EXIF `+00:00` photo misattribution** — 3,514 photos shifted -4h (Friday/Saturday Q53A camera, manual import path side effect — root cause confirmed by the user as non-camera, almost certainly a manual ingest script using the wrong timezone)
4. **Re-record / mis-slotted recording drama** — multiple routines on Day 1 (R118, R119, R136, R140, R145, R146) recorded into the wrong slot; inconsistent `_archive/` preservation between affected entries
5. **Cross-cutting hardening** — watermark generalisation, no-flow alerts, reconcile button, queue escape valves, lying-toast fixes — see HARDENING FIXES section.

The intent is for this single document to be the canonical reference when planning the next iteration of the photo + recording pipelines. The re-record redesign already has a frozen design reference at [`2026-04-26-rerecord-redesign.md`](./2026-04-26-rerecord-redesign.md); this post-mortem links to it rather than duplicating its contents.

## Mission for the work this incident report drives

> *"We're going to turn this incident report into a simple, elegant and hardened photo import / upload workflow and have alerts of when it's breaking so it's just doesn't happen again."* — operator, 2026-04-26 19:38 EDT

This document is not just an incident write-up. It is the **specification** for the next iteration of the photo pipeline. Every action item, every hardening fix, every NORTH-STAR clause below should be read as a contract: *"after this work lands, this class of failure cannot recur silently."* The bar is **simple, elegant, hardened, alerted** — a pipeline the operator can trust during a live event without watching a debug log.

## Summary

Photos stopped appearing in CompPortal (CD media portal) for routines from R540 onward (08:38 EDT). 116+ routines (R540–R660+) have `photo_count=0` in `media_packages`. Show continued recording videos normally; only photo ingest broke.

## Timeline (Eastern)

| Time | Event |
|---|---|
| 07:12:45 | Both cards detected: F:\ (SD_Alpha) + H:\ (PG_ALPHA), pre-check auto-skip |
| 07:12:56 | **Auto-IPC `photos:import` fired on H:\\DCIM** → 220 matched / 5074 unmatched at 07:16:59 |
| 08:57:31 | F:\ (SD_Alpha) re-detected, pre-check auto-skip |
| 08:57:31 | **Auto-IPC `photos:import` fired on F:\\DCIM** → 666 matched / 6633 unmatched / 2282 disk-exists-skipped at 09:04:02 |
| 09:04:02 | Last successful import. Last routine with photos in DB: **R539**. |
| 10:35:40 | F:\ (PG_ALPHA) re-mounted. Pre-check skip. **Renderer auto-IPC did NOT fire.** No import. |
| 12:18:55 | F:\ (PG_ALPHA) re-mounted. Pre-check skip. **No auto-IPC.** No import. |
| 14:01:21 | F:\ (SD_Alpha) re-mounted. Pre-check skip. **No auto-IPC.** No import. |
| 15:56:15 | F:\ (PG_ALPHA) re-mounted. Pre-check skip. **No auto-IPC.** No import. |
| 16:38:55 | F:\ (PG_ALPHA) re-mounted. Pre-check skip. **No auto-IPC.** No import. |
| 16:41:47 | Operator manually triggered `photos:import` on F:\\DCIM. Matcher resolved matches for R540+ from `124NZ6_2` (NAP_*.JPG). |
| 16:46:28 | copyFile failures (ENOENT) on R540–R547+ — operator moved files out of `F:\\DCIM\\124NZ6_2` while import was running. Import continued, no photos copied. |

## Root cause (observed)

**The renderer's DriveAlert auto-fire stopped triggering `PHOTOS_IMPORT` IPC after 08:57:31.** Both morning successful imports were renderer-fired on DRIVE_DETECTED. From 10:35 onward, drive detection continued firing on every card swap (5 swaps), but the IPC stopped. Operator was swapping cards expecting auto-import to handle ingest as it had in the morning.

Main-process auto-import has been failing pre-check ALL DAY (since 07:12). The pre-check sampler (`<2/3 of N samples are today`) has been broken on these cumulative-day cards continuously — both this morning AND afternoon. The morning's success path was the renderer's fallback IPC, NOT the main-process auto-import. When the renderer fallback stopped, there was no working auto-import path.

## Root cause (not yet identified)

**Why the renderer auto-IPC stopped firing after 08:57** is unknown. Possible candidates (not verified):
- DriveAlert UI dismissed/closed around 9 AM
- Renderer-side state corrupted after first successful import
- DriveAlert listener lost on some app event
- Setting or mode change

Need to inspect `renderer/components/DriveAlert*` or equivalent + correlate with renderer events around 09:04.

## Impact

- 116+ routines (R540–R660+) have `photo_count=0` in `media_packages` for UDC Toronto comp `a0adef31-...`.
- Photos still exist on the cards (~9900 JPEGs on PG_ALPHA, partitions including today's `124NZ6_2`).
- Videos for these routines are uploaded normally — video pipeline unaffected.
- CD media portal shows missing photos for these routines.

## Recovery state (16:54 EDT)

- 16:41:47 manual import is still running but compromised — every copyFile fails ENOENT because operator relocated files mid-run.
- Photos for today's routines are MATCHABLE (matcher correctly identified `NAP_*` files for R540–R547 etc.). Only the copy step is failing.
- No photo data lost. Source files exist somewhere on the system; just not at the path the import is reading.

## Recovery path

1. **Wait** for current broken import to finish (it'll log "Import complete" with 0 successful copies).
2. **Move the relocated photos back** to `F:\DCIM\124NZ6_2\` OR move them into a single accessible folder.
3. **Re-trigger manual import** pointing at the new accessible folder.
4. Run the same recovery for SD_Alpha card if it has unimported today photos.
5. Verify `photo_count` populates for R540+ in `media_packages`.

## Operator's desired state (NORTH STAR — verbatim from operator, 2026-04-26 23:08 EDT)

The competition runs with **two human operators** in coordination:

1. **CSE app operator** — drives the CompSync Electron app on DART, starting/stopping the per-routine recordings as routines play out one by one on stage.
2. **Photographer** — shoots stills onto an SD card, separately from the CSE machine.

**Two SD cards** are in rotation across the day. Roughly **40% of the way through any scheduled session**, the operators swap cards: the photographer's current card goes into the CSE machine, and the photographer continues shooting on the second card. This is the *normal* interleave — not an exception, not an error path.

When the CSE operator inserts a card, the desired UX is:

- **Zero modals. Zero confirmation prompts. Zero operator clicks.**
- An **unobtrusive top-left UI indicator** shows the app is working — matching and importing photos. That is the only feedback during ingest.
- The app scans the card and pulls the **latest photos**. It must NOT re-scan or re-import photos it has already seen and imported on a prior insertion of this card. Already-imported = skip silently.
- When the card is **truly done** — every photo has been copied off non-destructively, no operations are still happening on the card — a **top-left success toast** appears. That toast tells the operator the card is **safe to physically remove** ("safe to gank out").

Once import for that card is complete, the **round-robin upload** kicks in. The latest photos from the just-danced routines flow up to R2 + media_photos so they appear on the **CD-board's "latest photos" page**, which drives the **slideshow that plays during the break**.

When the break begins, the photographer hands off the **second** SD card. It goes into the CSE machine and the **same process repeats**. By the end of break, *all* routines from the previous session must be fully imported and uploading via round-robin.

**Rinse and repeat all day. Never fall behind on uploads. All media instantly available to families watching online.**

### Implementation requirements derived from the verbatim spec

- **Persisted, per-card high-watermark** keyed by card identity / volume serial (NOT drive letter — must survive remount, swap, drive-letter changes).
- Watermark is the **EXIF DateTimeOriginal** of the latest successfully imported photo for that card. On every DRIVE_DETECTED, the importer enumerates files newer than the watermark, EXIF-scans them, matches by routine window, uploads, advances the watermark.
- **No pre-check sampler.** No "<2/3 of N samples are today" guard. No date-prompt modal. No "is this the right card?" prompt. The only safeguard is *"is this newer than what we've already imported on this card?"* — answered from persisted state, not heuristics.
- **Periodic re-poll while card stays mounted.** If the photographer is shooting onto a card that is *currently sitting in the CSE reader* (some workflows keep the same card mounted across multiple routines), the importer re-checks the card every N seconds and pulls anything new since the last watermark advance.
- **Top-left progress chip + completion toast** as the *only* operator-facing UI. Specifically: a small chip (icon + "Importing N…") shows during scan/copy; on completion, the chip animates to a green "Card safe to remove" toast. No center-screen modals, no banner blocking the routine table, no confirmations.
- **Round-robin upload trigger** fires automatically when import completes — latest-routine photos go to R2 + media_photos *first* so the slideshow picks them up immediately, then older queue entries drain.

## Required visibility — silent-failure alert (BOTH SURFACES)

> **The OPERATOR (in the CSE app) AND the CD/admin (in CompPortal) must each get a loud, persistent warning if no photos are flowing while routines are actively being recorded.** Today's incident went undetected for 7+ hours because there was no "no flow" warning anywhere — operator was watching the app, CD was watching the portal, neither had any signal.

Two-surface mandate:

**1. CSE app (operator-facing)**
- Persistent banner/badge in app header — NOT a toast.
- Triggers when N consecutive recently-completed routines have `photo_count=0` (suggested N=3) AND ingest pipeline shows no successful imports in the last M minutes (suggested M=15).
- Includes fix hint: "SD card not auto-importing? Click here to manually import."
- Persists until photos resume flowing OR operator explicitly acknowledges with a reason ("camera being repositioned", "photographer on break", etc.).

**2. CompPortal CD/admin dashboard (CD-facing)**
- Same alert state surfaced on the admin livestream / CD dashboard — visible to CD staff who don't see the operator's app.
- Triggers off `media_packages.photo_count` for the live comp — if last 3 completed routines have `photo_count=0` while videos are uploading normally, alert fires.
- Visible alert in dashboard header + optional notification (email/push) to CD owner.
- Driven by Supabase queries against `machine_logs` and `media_packages`, not dependent on the CSE app being healthy (must work even if the CSE app crashed).

**Why both:** Today the operator was at the show running the CSE app. The CD/owner was monitoring CompPortal. NEITHER surface showed a problem. The pipe died silently for 7+ hours. The redundancy is intentional — operator AND portal must both be able to catch this independently.

Specs:
- Alerts must be persistent, not a toast (toasts can be missed and were silenced for related warnings).
- Suppression rule: only suppress if operator/CD explicitly acknowledges + selects a reason. Suppression is per-surface (operator suppressing it in the app does not suppress it in the portal).

## Action items (post-event)

1. **Implement persisted-watermark auto-import** — North Star above. This is the priority-one fix; supersedes the pre-check rewrite below.
2. **Implement no-flow alert** — silent-failure visibility per spec above.
3. **Fix renderer DriveAlert auto-fire regression** — identify why it stopped after the second success and didn't re-arm across card swaps. (May become moot once watermark-driven auto-import lands.)
4. **Retire the broken pre-check** (`<2/3 samples are today` guard in `driveMonitor.ts:590-610`). Replace with watermark check. Saved memory: `feedback_sd_import_latest_unimported.md`.
5. **Fix premature "Import complete" UI toast** — fires before actual import wraps. Operator saw "complete" while import was still running with errors.
6. **Add idempotency to import-from-folder** so file moves mid-run don't break recovery — re-resolve paths before each copy or fail-soft per file (current behavior already skips per-file ENOENT, but the toast misleads).

## Cascade failure: end-of-day 1,500-job queue backlog blocked R667–R675 video uploads

By end of show (~17:25 EDT), the CSE app's job queue had accumulated **~1,500 quarantined upload jobs** — the bulk being failed retries from the morning's broken-mid-run import (file paths pointing at `F:\DCIM\124NZ6_2\` after files were moved). The job queue retry loop kept hammering these dead paths.

**Impact:** Routines R667–R675 (recorded 16:55 → 17:25 EDT) had their videos and photos sitting on disk, but the CSE app's upload pipeline never advanced through these new entries — the queue was saturated with the dead retries. The app never created `media_packages` rows for R667–R675, never uploaded the 36 video files (4 per routine) to R2, never matched/uploaded the 365 photos shot during these routines.

This was caught only because the operator noticed at 18:25 EDT that R666 was the last DB-recorded routine despite shows continuing to R675. Manual recovery required:
1. Direct R2 video upload from DART (4.1 GB, ~12 min via parallel multipart from a side-loaded Python script)
2. Manual `INSERT` of 9 `media_packages` rows via Supabase MCP with full field parity
3. Re-running photo upload script against `E:\TOCard1` (Sunday card backup) to match 365 photos against the now-existing routine windows

**Root cause (combined with the morning's failures):** No bulk-clear endpoint exists in the CSE app's job queue. Operator can only `JOB_QUEUE_CANCEL` one job at a time. With 1,500 quarantined entries, the operator had no realistic way to drain the queue mid-event without restarting the app (which wasn't viable during a live show).

**Action item (link to existing post-event list):** Add `JOB_QUEUE_PRUNE_QUARANTINED` IPC + UI button. Without this, any future broken-mid-run import will saturate the queue and silently block all subsequent uploads. This is the second-order failure — the first was the import breaking, the second was the queue having no escape valve, blocking everything that came after.

---

## R2 reconciliation TODO (post-event)

At 17:04 EDT, 62 zombie `media_photos` rows for R548–R644 (UDC Toronto) were soft-deleted (`deleted_at = NOW()`) per operator directive to clear cliff-point state and unblock re-import.

These rows had standard R2 storage_urls (`<tenant>/<comp>/<entry_id>/photos/NAP_NNNN.JPG`). The corresponding R2 objects may or may not exist — the broken import was uploading in 5-second waves and ENOENT-failing once files were moved out of `F:\DCIM\124NZ6_2`. Some PUT calls likely completed before that.

**Reconcile post-event:**
- Inventory R2 objects under `compsyncmedia/00000000-0000-0000-0000-000000000004/a0adef31-177b-4dd6-8b63-7ff59fff0196/<entry_id>/photos/` for the affected entries (R548–R644).
- For each R2 object: if the matching `media_photos` row is soft-deleted AND a fresh row exists for the same filename + same entry from the recovery import, decide whether to delete the orphan R2 object or undelete the soft-deleted row to reclaim it.
- 62 row IDs were captured in the soft-delete query result — preserve that list for the reconcile script.

## Open questions

- Did operator dismiss any UI element around 09:00–09:05 EDT that might have killed the DriveAlert listener?
- Are there other times today the operator clicked "Import" and got silent failure (zero matches with no error)?
- Is the date-mismatch warning UI suppression (`suppressed UI 2026-04-25 per operator`) hiding a critical signal that should be re-enabled in a different form?
- Does the pre-dedup query filter on `deleted_at IS NULL`? (Affects whether soft-delete is sufficient to unblock re-import or whether we need hard delete.)

---

# P0 FINDING — 9-HOUR SILENT FAILURE (the headline of this incident)

**The single most damaging fact of the day:** photo ingest stopped at 09:04 EDT and was not detected until 18:25 EDT — **9 hours, 21 minutes** of zero photo flow with zero alerting, zero red banner, zero email, zero notification on either the operator's CSE app *or* the CD/admin dashboard in CompPortal. Two separate humans were watching two separate surfaces. **Neither saw a problem.**

Per operator: *"No photo uploads since 9:00 a.m. is an absolute disaster and no surfacing error to either the machine operator or the administrator panel."*

This is the failure of failures. Every other failure in this report (broken pre-check, ENOENT mid-run, queue saturation, etc.) is *recoverable* if a human knows about it within 5 minutes. None of them were known for 9 hours.

## What was already screaming in the logs but reaching no human

A retrospective scan of `machine_logs` for 2026-04-26 EDT surfaced a long list of distress signals that the app emitted into its own log stream and then *did not surface* to either operator or CompPortal:

| Signal in `machine_logs` | Count today | What it should have triggered | What it actually did |
|---|---|---|---|
| `MISSING_PHOTOS_DETECTED` warnings (recently-completed routine has 0 photos) | 5 | Loud persistent banner "no photos flowing" on app + portal | Logged silently. No UI surface. |
| `CAMERA_CLOCK_MISMATCH` | 5 | Clock-drift modal | **UI suppressed 2026-04-25 per operator** — still logged but no surface |
| Import "date mismatch" warnings | 5 | Date-mismatch modal | **UI suppressed 2026-04-25 per operator** — still logged but no surface |
| `dayChecklist` module errors (broken `require()` resolution after asar pack) | 158 | App-health red flag | Log spam only; app continued without dayChecklist UI |
| UDP video-receiver "no video for >Ns" timeouts | 21+ | Video pipeline degraded warning | Internal recovery; no operator-visible signal |
| UDP receiver socket recycles (forced rebind) | 7 | Same | Same |
| Audio flat-line on judge mics | 3 | Audio-down banner | None — only post-event audit found these |
| `control-room` heartbeat aborted | 5 | Connection-degraded banner | Same |
| ENOENT on copyFile during `import-from-folder` retry storm | 1500+ | Job-queue health alert | Quarantine counter incremented silently |

**Cumulative pattern:** every single one of these channels assumes "the log is good enough — somebody will look." Today nobody looked, because nobody was *paged*. The only feedback loop the operator had was: glance at the app UI; look at recent rows in the routine table; see green checkmarks. The app continued to draw green checkmarks while emitting 158 module errors, 21 UDP timeouts, 5 missing-photo warnings, and 1500 ENOENT retries into a log file nobody was tailing.

## Why the operator-side warnings were specifically silent

Three of the most important warning channels (`CAMERA_CLOCK_MISMATCH`, import "date mismatch", and arguably the import-complete toast itself) were **explicitly suppressed in the UI** on 2026-04-25 per operator request — they were noisy / firing on edge cases / interrupting flow. The suppression was the right *immediate* call; the failure was the lack of any **alternative surface** that still escalated when the same condition fired N times consecutively.

Suppression without escalation = silence.

## Why the CompPortal-side warnings were specifically silent

CompPortal's CD/admin dashboard has no "photo flow health" component at all. There is no widget that says "the last 3 completed routines for this comp have `photo_count=0` while videos are uploading normally — investigate." The only way for a CD/admin to know photos are missing is to manually open a routine's media package and notice it has zero photos — which they would only do if they already suspected a problem. Since `media_packages` rows continued to be created for every routine (the upload pipeline created them when video uploads completed), and the routine list looked normal, there was nothing visually wrong on the admin side.

Both surfaces failed in the same way: the data needed to detect the problem *existed*, but no component was watching it.

---

# Failure-mode catalog (what else broke today, beyond the photo cliff)

The photo cliff is the headline, but the day had additional silent-or-loud failure modes worth capturing so the hardening pass covers them all.

## A. Drive-detection / auto-IPC regression
- Renderer's DriveAlert auto-IPC fired twice (07:12, 08:57) and then stopped for the rest of the day across 5 subsequent card swaps.
- Main-process auto-import pre-check (`<2/3 of N samples are today`) was failing **all day** (since 07:12) on cumulative-day cards — it was *never* the working path; the morning's success was renderer-side only.
- Net effect: from 09:04 onward, *every* card insertion required operator manual import to do anything. Operator was not informed of this state change.

## B. Mid-run path invalidation (ENOENT storm)
- 16:41:47 manual import was started against `F:\DCIM\124NZ6_2`.
- 16:46:28 onward: operator moved files out of that folder while import was running. Import logic resolved file paths once at scan time and copied serially; every subsequent copyFile failed ENOENT.
- Per-file failures were swallowed (skip + continue), but **the "Import complete" toast fired anyway** with 0 successful copies — actively misinforming the operator.

## C. Job-queue saturation cascade
- The 1500+ ENOENT failures from B above did NOT short-circuit; they kept retrying in the job queue's quarantine/retry loop.
- Queue depth ballooned to ~1500 quarantined jobs by 17:25 EDT.
- Routines R667–R675 (recorded 16:55–17:25 EDT) were *physically captured* on disk and on the SD card, but the upload pipeline never advanced through their entries — the queue was full of dead retries.
- No `media_packages` rows were created for R667–R675 by the app. No videos uploaded. No photos uploaded.
- Detected only at 18:25 EDT by the operator manually noticing R666 was the last DB row.
- **Recovery required complete bypass of the app:** parallel multipart Python script direct-to-R2 from DART for 36 video files (4.1 GB, ~12 min); 9 hand-built `media_packages` INSERTs via Supabase MCP with full field parity; separate photo upload script against `E:\TOCard1` matching against the just-created routine windows.
- Root cause of cascade scope: **no bulk-clear endpoint exists in the queue.** Operator can `JOB_QUEUE_CANCEL` a single job at a time. With 1500 quarantined entries that's not a viable mid-event action.

## D. UDP video receiver instability
- 21+ "no video for >Ns" warnings across the day, plus 7 forced socket rebinds.
- All recovered automatically; no observable impact on final video files (every routine has a clean MKV+MP4 set).
- But: the recovery-time gap between "no video" and "video resumed" is *exactly* the window where a routine could have been mid-recording and lost frames. None of these events were correlated against routine timing in real time.

## E. Audio flat-line on judge mics (3 events)
- Judge audio cut out on 3 occasions today. No operator-visible alert.
- Detected only by post-event log scan.
- Affected commentary tracks may have silent stretches.

## F. dayChecklist module error spam (158)
- `require()` resolution failure for the dayChecklist module post-asar-pack — same class of bug that has bitten this codebase multiple times historically.
- App degraded gracefully (no dayChecklist UI surface) but logged 158 errors over the day.
- Did not affect ingest, but is an example of a class of asar-pack failures that *can* cause boot crashes under different load orders.

## G. control-room heartbeat aborts (5)
- 5 instances of the control-room websocket connection aborting mid-heartbeat. Each followed by reconnect.
- No operator-visible signal that the live-status link to CompPortal was flapping.

## H. Manually-triggered import — premature "Import complete" toast
- Toast fires at the end of file enumeration, *not* the end of file copies. With ENOENT on every copy (case B), the toast still fired with green checkmark while 0 files actually copied.
- This is a "lying success" UI bug — worse than no feedback, because it actively misleads the operator into believing recovery worked when it didn't.

## J. Re-record / mis-slotted recordings (Day 1, UDC Toronto 2026-04-24)

Multiple routines on Day 1 had recordings drop into the wrong slot, requiring hours of post-show DB cleanup:

| Routine | Mis-slotted as | Notes |
|---|---|---|
| R118 | recorded into R119's slot | no `_archive/v1/` despite class of mistake |
| R136 | recorded into R139's slot | no `_archive/v1/` |
| R140 | recorded into R142's slot | no `_archive/v1/` |
| R145 | long-recorded both R145 + R146 into R145's slot | needed split + relink |
| R139, R142 | re-recorded with `_archive/v1/` | archive *did* fire here |

**Two compounding bugs surface here:**

1. **The pre-record dialog is a native OS modal with default = Cancel** — confusing default for "I want to re-record"; operators frequently click through wrong direction under live pressure.
2. **The post-stop "Advance vs Archive" modal is framed around the *new take's destination*** rather than around the take the operator just made. Operators think *"what about the take I just recorded"*; the modal asks them to reason about a future routine. Mental-model mismatch produces wrong choices.
3. **Inconsistent `_archive/v1/` write logic.** R139 and R142 archived their pre-overwrite take. R118, R119, R136, R140 did NOT — same class of operation, different code path or version drift produced different behavior. Recovery is brittle without consistent archive presence.

**Downstream consequences:**

- Photos within a mis-slotted window match the wrong routine's video window → end up on the wrong entry in `media_photos`.
- Manual cleanup post-show requires: re-upload split/archived video to R2 → UPDATE `media_packages.video_*_url` + tighten window → UPDATE `media_photos.media_package_id` for displaced photos. Multi-hour task per affected routine.
- For Day 1 (R118/R119/R136/R140/R145/R146), the cleanup was substantially complete by 2026-04-25, but the pattern repeated risk has not been eliminated — only patched per-incident.

**Resolution for next iteration:** the re-record / take-management redesign was captured 2026-04-26 18:35 EDT in [`2026-04-26-rerecord-redesign.md`](./2026-04-26-rerecord-redesign.md). Key invariants from that doc:

1. Latest take is canonical for the slot it was recorded in. Always lands in the current routine's folder.
2. A take's recorded time window is **immutable**.
3. Time window = canonical truth for photo-routine matching.
4. No photo, take, or `.mkv` is ever deleted.
5. Photos relink additively.
6. Eager R2 preservation on re-record start.
7. Cascade max 1 — re-assigning displaced takes to occupied slots auto-stashes the existing take, no second confirmation.

The full redesign covers UI flow (non-blocking modal vs. blocking dialogs), state-machine, and migration; this post-mortem links to it as the implementation reference for any re-record-related hardening item.

## K. EXIF `+00:00` misattribution (3,514 photos, Friday + Saturday)

CompPortal session reported (2026-04-26 19:27 EDT, while this post-mortem was being written): 3,514 photos in UDC Toronto were stored with `captured_at` 4 hours earlier than actual stage time — interpreting EXIF as UTC when the camera clock face was set to Eastern. Filenames affected were 3,510 Q53A + 4 NAP_. CompPortal ran a corrective `UPDATE captured_at = captured_at + interval '4 hours'` on the affected rows, plus media_package_id moves on the ~30% subset that had been cross-attributed to neighboring routines.

**Operator's analysis (correct, accepted as ground truth):** this was NOT a camera bug. Cameras don't write `+00:00` when their clock face is set to local time. The 24.4% selectivity (3,510 of 14,383 Q53A photos affected — not 100%) supports the operator's hypothesis: **a manual import script processed a subset of Q53A photos using the wrong timezone interpretation while another path handled the rest correctly**. Same camera, same EXIF, different code paths.

**Routines spanned (from CompPortal's visual verification + restore work):** R118, R123, R125 → R126, R135, R138, R139, R145, R286 → R287. Friday morning Q53A (R118–R145) and Saturday Q53A (R286–R287). Cross-attribution proven by visual match of dancers/costumes (e.g. R125 had cheetah-print photos that matched R126's "AMIGAS CHEETAHS").

**Why this matters for the hardening plan:** every manual import / recovery / backfill script in this codebase needs an explicit Eastern timezone contract. The Friday recovery script (per memory `feedback_persist_expensive_derivations.md`) already labels EXIF as `+00:00` UTC when values are actually EDT — exact same class of bug. Today's recovery scripts (`upload-tosunday-DART-v2.py`, `upload-tocard1-DART-v3.py`) explicitly converted Eastern → UTC and were verified safe (1,805/1,807 rows in window). The fix is institutional: **no manual script lands rows in `media_photos` without a code-reviewed timezone clause**, and CompPortal's `Verify-Media` audit should keep flagging "no captured_at in window" as a soft alarm.

**Cross-reference action items:**
- Detection during ingest (in CSE app *and* CompPortal): if EXIF `OffsetTimeOriginal == '+00:00'` AND resulting `captured_at` falls outside ALL routine windows for the comp, flag for review rather than blindly storing.
- Periodic Verify-Media audit pass that surfaces "captured_at not in any routine window" as a yellow-flag list before publishing.

## L. Additional findings from cross-session transcript scan (UDC Toronto Fri–Sun)

These items surfaced during a sweep of `~/.claude/transcripts/2026-04-2{4,5,6}/Comp{Portal,SyncElectronApp}.md`. Each is a real complaint or bug the operator voiced during the event that is not otherwise captured above. Listed by category with verbatim quote where useful.

**Bugs**
- **L1. Cross-routine photo duplication.** *2026-04-25 03:12* — "Same photo getting copied to multiple routines. The `_dupN` suffix wasn't the only bug — there's matcher multi-routine assignment." 4,519 filenames found in multiple routine folders; matcher placed identical files into more than one routine.
- **L2. Pre-dedup scan reads every file even when only today's matter.** *2026-04-25 15:57* — "So even photos that will be skipped do 1-2 full file reads each." O(card size) instead of O(today's deltas) — directly fuels the wasted-cycles concern in P0.1 amendment.
- **L3. Manual import bypasses the pre-check guard entirely.** *2026-04-26 20:41* — `ipc.ts:629` (`PHOTOS_IMPORT`) calls `importPhotos()` without the pre-check; the manual button's behavior diverges from auto-import.
- **L4. Recovery chain fails on dynamic `require('./mediaReconciler')`.** *2026-04-25 22:19* — "[App] startup recovery sequence failed: Cannot find module './mediaReconciler'." Same asar-pack class as the `dayChecklist` errors — leaves 19,075 jobs dormant on boot-wake.
- **L5. Worker failing on deleted `_dup` files, all jobs stuck.** *2026-04-25 08:17* — "Worker is failing on every job — 9,697 pending jobs all point to deleted `_dup` files." Dead jobs accumulate after cleanup; queue can't drain.
- **L6. tabletLogServer bundling bug.** *2026-04-24 02:19* — "Pre-existing bundling bug uncovered — dynamic `require('./services/X')` preserved at runtime but the services aren't bundled into `index.js`." Same root cause as L4 + dayChecklist; needs systematic fix.
- **L7. Latest-photos scatter is too slow.** *2026-04-24 13:05* — "i need the whol chain of import/match/upload to support getting more routines on that page tho; the goal is for that page to rapidly show scattered photos across ALL ROUTIENS AS FAST AS POSSIBLE once card is in." Round-robin yields concentrated bursts per routine instead of even scatter.
- **L8. Latest-photos page only showed 6 photos during active import.** *2026-04-24 13:02* — Live flow expectation was rapid multi-routine scatter; reality was a tiny per-routine slice.
- **L9. METER-DIAG audio-meter log spam.** *2026-04-24 12:27* — "1408 — all METER-DIAG spam, safe." `console.error("[METER-DIAG #N] ...")` left in the audio-meter render path; floods `machine_logs` and hides real errors.
- **L10. R118/R119 mis-slotted (Day 1 confirmation).** *2026-04-24 13:44* — "data issue occured; 118 and 119 both got recorded into 119s slot." Provides timestamped origin of the Day 1 re-record drama (covered in §J).

**UX confusion / operator friction**
- **L11. Six modals on SD insert / app boot.** *2026-04-25 15:56* — "Very long scan happening, surely we don't need to scan so many photos.... There's like six modalles that pop up when an SD card is inserted or when the app boots with a card inserted. We need to streamline this." Direct confirmation of the NORTH-STAR "no modals on insert" goal — this is what the operator is reacting against.
- **L12. Re-record post-stop modal framing is wrong.** *2026-04-26 17:19* — "The confirmation modal are confusing for the operator, and typically the latest recording on a routine will be the correct one that should be promoted and be in the visible slot online." Operator-stated rule that maps directly into the re-record redesign's "latest take is canonical" invariant.
- **L13. Recent Events panel too short to be useful.** *2026-04-24 12:13* — "my issue with RECENT EVENTS panel is its too short to show rows, COMAND history can be smaller Recent events prioritiied." Layout priority is wrong for live-event use.
- **L14. UTC time leak in agent reports.** *2026-04-24 13:05* — "And you just showed me a UTC time code when your instructions say EST." Recurring sore spot for the operator (already enforced as a Claude rule but not enforced in some app log surfaces).

**Feature gaps**
- **L15. Logs not browser-reachable without SSH tunnel.** *2026-04-24 00:26* — "If you want it to be browser-reachable without a tunnel, that ne..." Operator wants easier observability that doesn't require terminal + curl.
- **L16. Admin livestream Recent Events surface needs human-readable + raw + more.** *2026-04-25 20:32* (CompPortal session) — "I need simple human readable RECENT EVENTS" with "raw log option" and "way more events." Currently shows unformatted diagnostics.
- **L17. CSE ↔ CompPortal state sync gap.** *2026-04-25 20:32* (CompPortal) — "i can still use more state-sync with the CSE app; whether recording is on." Live recording status doesn't reach the admin web view.
- **L18. Venue TV / livestream layout not responsive.** *2026-04-25 18:30* (CompPortal) — "I'm not super happy with it. In this case I would want more routines to be on the right and it's not filling up the whole screen." Sidebar doesn't fill viewport height; layout is hard-coded.

**Deployment friction**
- **L19. mingw DLL packaging blocked v9 boot.** *2026-04-24 02:13* — "The mingw-built 5.5MB binary is looking for shared DLLs not present on DART. Auto-restart loop triggers 3×, all fail." Same lesson as previous mingw incidents — bundle runtime DLLs or static-link.

---

## I. Field-parity gap on side-loaded recovery rows (introduced during recovery, fixed end-of-day)
- The bypass scripts (`upload-tosunday-DART-v2.py`, `upload-tocard1-DART-v3.py`, `upload-r667-videos-DART-v2.py`) initially inserted `media_photos` rows without `file_size_bytes` populated — 1807 rows had NULL where Friday/Saturday rows had real byte counts.
- Detected by operator and fixed via a backfill pass: HEAD'd all 1807 R2 objects via boto3, built scoped UPDATE statements, ran them in one transaction. Final state: 1807/1807 rows have `file_size_bytes`.
- **Caveat — content divergence:** the bypass scripts uploaded *full-resolution* JPEGs (avg 8.1 MB/photo, 14.7 GB total) instead of the in-app pipeline's optimized variant (avg ~1.1 MB/photo). R2 storage bloat for today's recovery photos: ~13 GB extra. Functionally fine — slideshow and downloads still work — but a re-encode pass post-event is desirable to reclaim storage and equalize delivery latency.

---

# HARDENING FIXES — prioritized P0 / P1 / P2

The action items list above is the original short version. This is the comprehensive one, organized by priority and grouped by failure mode. **P0 = ship before the next live event.** P1 = ship within 2 weeks. P2 = nice to have.

## P0 — must ship before next live event

### P0.1 — Persisted-watermark auto-import (kills the photo cliff at the root)
- Implement the NORTH STAR verbatim spec above.
- Per-card volume-serial keyed high-watermark in app userData.
- DRIVE_DETECTED → enumerate files newer than watermark → EXIF-scan → match → upload → advance watermark.
- No pre-check sampler, no date-prompt modal, no manual trigger.
- Periodic re-poll on continuously-mounted card.
- Top-left chip during, top-left toast on completion ("safe to remove"). No center-screen modals.
- Round-robin upload kicks off automatically post-import.

#### P0.1 amendment — operator concern (2026-04-26 19:38 EDT): stop wasting scan cycles

> *"It just feels like wasted cycles to scan the entire card every time, which is what I see it doing in the UI at least. By the end of the show, there's like 5,000 photos on the card and it just seems like wasted processing."*

**This is correct and important.** The current UI behavior (visible card-rescans across the day, even when no new photos exist) is exactly the symptom of what's broken. The fix is not "scan faster" — it is "**don't scan what we've already seen**." The watermark mechanism *exists* for this in `state.sdWatermarks` (keyed by camera body key, value = `lastCaptureTime` ISO + optional `lastFilename`), but two real code-level gaps were surfaced reading the source today (2026-04-26, post-incident):

1. **Body-key regex covers only Lumix `Pxx` cameras.** `photos.ts:254` matches `/^(P\d{2})\d{5}\.(?:jpg|jpeg)$/i`. **`NAP_*.JPG` (Nikon) and `Q53A*.JPG` (Canon) return `null`.** They get bucketed under `_unknown`, which means any watermark logic that branches on body key is silently broken for those cameras. Today's `NAP_*` photos lived in this null-key bucket. The pre-check, the watermark resume, the per-camera offset detector — all of these were operating on a key that didn't exist for the cameras actually in use.

2. **The watermark is `lastCaptureTime` only, not `(lastCaptureTime, lastFilename)` jointly.** `lastFilename` is logged but flagged in `state.ts:56` as *"legacy/back-compat log aid only — NOT used for resume matching."* That means if two photos share the same EXIF second (rapid burst), or the EXIF clock has any granularity issue, we have to re-scan to be sure. Adding `lastFilename` as a real second key (lexicographic max) is a small change that makes resume idempotent and bulletproof against burst-shot ambiguity.

**Required fixes to make the watermark actually work:**

- Generalize `getCameraBodyKey()` to recognize `NAP_`, `Q53A`, `Pxx`, and a small enum of common DSLR/mirrorless prefixes. Default to a sensible per-card identifier when the prefix is unknown rather than `_unknown` (e.g. fall back to volume serial + DCIM folder, so the watermark still works even for unrecognized cameras).
- Add `lastFilenameSeq` (parsed integer from the filename's numeric portion) as a *second* resume key alongside `lastCaptureTime`. Resume rule becomes: skip iff `(captureTime < lastCaptureTime) OR (captureTime == lastCaptureTime AND filenameSeq <= lastFilenameSeq)`. Burst-shot safe, sub-second-grain safe, never re-scans seen files.
- Promote the watermark from "per camera body" to "per (volume serial, body)" so two cards from the same camera don't share a single watermark entry. Fixes the swap workflow.
- UI must reflect the watermark state. The top-left chip during scan should show *"Resuming from 16:42:17 EDT (NAP_5074) — checking 38 newer files…"* instead of *"Scanning 9,870 files…"*. The visible difference is what the operator wants to see and is the contract that "we're not wasting cycles."
- Persist watermark advances on every file, not just at end-of-import. If a scan is interrupted (app crash, card pull mid-import), the next scan resumes from the last *fully-uploaded* file, not from where the last scan started. Idempotency by construction.

The combination of (P0.1 verbatim spec) + (P0.1 amendment) + (P0.6 reconcile button) is what gets us to the operator's stated bar: simple, elegant, hardened, alerted.

### P0.2 — Two-surface no-flow alert (kills the 9-hour silent failure)
**CSE app side (operator-facing):**
- Persistent badge in app header (NOT a toast). Color-graded yellow → red.
- Trigger: last N completed routines (default N=3) have `photo_count=0` AND no successful import in last M minutes (default M=15).
- Click expands a panel with: "Last successful import: HH:MM EDT", "Last card detected: HH:MM EDT", "Manual import" button, "Acknowledge — reason: [dropdown]" (e.g. *camera being repositioned*, *photographer on break*, *drone shot only*).
- Suppression: only on explicit operator acknowledge + reason. Re-arms automatically when photos resume flowing.

**CompPortal CD/admin side (CD-facing):**
- Same alert state surfaced on the admin livestream / CD dashboard. Independent of the CSE app's health (Supabase-driven, works even if CSE app crashed).
- Trigger: per-comp query against `media_packages.photo_count` over the last 3 *completed* routines.
- Header badge + optional email/push notification to CD owner.
- Suppression: per-surface (operator suppressing in app does NOT suppress in portal). CD must acknowledge separately.

### P0.3 — Job-queue bulk-clear escape valve (kills the cascade saturation)
- New IPC: `JOB_QUEUE_PRUNE_QUARANTINED` (drops all jobs in the quarantine bucket).
- New IPC: `JOB_QUEUE_PRUNE_BY_PATH_PREFIX` (drops all jobs whose source path starts with a given prefix — e.g. `F:\DCIM\124NZ6_2`).
- Both surfaced on a small admin panel inside the app (gated by a long-press or settings toggle so an operator can't fat-finger it during a show).
- Without this, any future broken-mid-run import will saturate the queue and silently block all subsequent uploads — exactly what happened to R667–R675 today.

### P0.4 — Fix "lying success" toasts
- "Import complete" toast must reflect actual file-copy success rate. Format: `"Import complete: 365 / 365 copied"`. If success_count < attempted_count, change to red `"Import finished with errors: 12 / 365 copied. See log."`
- Same rule for any other end-of-action toast that currently fires on enumeration completion rather than work completion.

### P0.5 — Idempotent import-from-folder re-resolution
- Each per-file copy step re-resolves the source path immediately before reading. If the source has moved, fall through to `JOB_QUEUE` for retry rather than counting it as a permanent failure.
- Combined with P0.3, this means a mid-run file move becomes "delayed import" instead of "1500 dead retries."

### P0.6 — Manual end-of-day SD reconciliation ("am I really up to date?")
**Operator-driven safety net** for the silent-failure class. The auto-import (P0.1) is the happy path; this is the explicit "verify nothing fell through the cracks" pass the operator can run at any safe moment (lunch break, end of session, end of day) without disrupting recording.

**Workflow:**
1. Operator plugs in both SD cards (or one — the feature works per-card or all-at-once).
2. Operator clicks "Reconcile cards" in the app (single button, top-left tools area).
3. App scans every `.JPG` on every detected card (no watermark filter, no date filter, no pre-check).
4. For each file: compare against what the DB believes is uploaded for this competition (filename + EXIF capture time).
5. Surface a per-card summary: *"SD_Alpha — 6,633 photos on card. 6,633 already in DB ✓"* OR *"PG_ALPHA — 9,870 photos on card. 9,754 already in DB. 116 photos missing — click to import."*
6. If a gap is found, single-click resolves it (kicks off a normal import for the missing files only).
7. Optional: detect *sequence gaps* in camera filenames (e.g., card has `NAP_0001`–`NAP_5074` but DB only has up through `NAP_4500` for this comp) and show those as a separate "potentially missing" count.

**Why this matters specifically given today's failure:**
Today's silent 9-hour failure could have been caught by the operator at lunch in 30 seconds: insert both cards → click Reconcile → see "116 photos on card not in DB" → click Import. Instead, no surface existed and the gap was discovered at 18:25 EDT, 9 hours after it started.

**Requirements:**
- Read-only by default — the scan compares but does NOT auto-import. Import is a second click. Operator stays in control.
- Per-card breakdown (volume serial in the UI label so operator knows which card is which).
- Run-time progress indicator (top-left chip — same surface as P0.1's import indicator, so operator UX is consistent).
- Non-blocking — recording can continue during the reconciliation scan; reconcile uses worker thread, not main.
- Sequence-gap detection ("missing files inside the camera's filename sequence") as a separate signal from "files on card not in DB."
- Persistent log of every reconciliation run + results, queryable for post-event audit.

**Why P0:** this is THE safety net for every silent-failure mode the auto-import has or could ever have. Even if every other P0 fix lands clean, this one button means today's failure can't repeat as a *9-hour* failure — at worst it becomes a *until-next-reconcile* failure, which the operator runs every break.

## P1 — within 2 weeks

### P1.1 — Re-introduce suppressed warnings as escalations, not modals
- `CAMERA_CLOCK_MISMATCH`: instead of a modal on every detection, accumulate. After 3 events in a session, escalate to a header banner. Operator can dismiss the banner with a single click + reason. The underlying detection keeps logging.
- Import "date mismatch": same pattern. First N go to log only; threshold breach surfaces a banner.
- Goal: all the channels that were turned off on 2026-04-25 because they were noisy come back as *escalating* signals that don't bother the operator on the first detection but *do* surface if they fire repeatedly.

### P1.2 — `MISSING_PHOTOS_DETECTED` must surface
- Currently logged silently in `machine_logs`. Wire it to the P0.2 banner system.

### P1.3 — Renderer DriveAlert auto-IPC re-arm
- Determine why the renderer's auto-fire stopped after the second success this morning. Either fix the regression OR make it moot by having the main-process watermark-driven import (P0.1) be the sole path.
- If keeping the renderer path as a fallback: add a heartbeat — every N minutes, the main process checks "is the renderer's IPC channel responsive?" and warns if not.

### P1.4 — UDP receiver health surface
- Surface "no video for >Ns" events as a small chip in the video panel. Auto-clears after recovery. Tracks N% of routines that hit the warning at all today.
- Same for forced socket rebinds.

### P1.5 — Audio flat-line detection + alert
- Detect audio level == 0 sustained for N seconds on any judge mic.
- Surface as a small chip + log entry. After M consecutive flat-lines, header banner.

### P1.6 — Pre-dedup query must respect `deleted_at IS NULL`
- If pre-dedup currently checks "have we ever seen this filename" without filtering soft-deleted rows, soft-delete is not enough to unblock re-import. Verify and fix if needed. (Carry-over from open questions.)

### P1.7 — Re-encode bypass-uploaded JPEGs (storage cleanup)
- 1807 R2 photos uploaded today at full resolution (~14.7 GB) instead of the in-app pipeline's ~1.1 MB optimized size. Re-encode pass to bring them in line. Strictly storage / bandwidth, not correctness.

### P1.8 — Re-record redesign implementation (kills the mis-slotted recording class)
- Implement the frozen design at [`2026-04-26-rerecord-redesign.md`](./2026-04-26-rerecord-redesign.md).
- Latest-take-is-canonical, immutable time windows, additive photo relink, eager R2 preserve, cascade max 1, non-blocking modals.
- Concrete ask: replace the native OS pre-record dialog (default=Cancel) with an in-app non-blocking modal; reframe the post-stop "Advance vs Archive" modal around the *take just made* rather than around the new take's destination.
- Audit and unify `_archive/v1/` write logic so it fires consistently on every re-record (R139/R142 wrote, R118/R119/R136/R140 didn't — that inconsistency must die before the modal can rely on archives existing).
- Until landed, today's mitigation = post-show DB cleanup per affected routine. With the redesign, the operator handles the disambiguation in the moment, with full mental model intact.

### P1.9 — Manual-import timezone contract (kills the EXIF +00:00 misattribution class)
- Every manual import / recovery / backfill script that writes to `media_photos` MUST go through a shared helper that requires an explicit `localTimezone: 'America/New_York'` argument and converts EXIF DateTimeOriginal → UTC before insert.
- No script merges to `scripts/` or runs against production R2 without this clause.
- Detection in both CSE app and CompPortal ingest: if EXIF `OffsetTimeOriginal == '+00:00'` AND resulting `captured_at` falls outside ALL routine windows for the comp, flag the photo for review and emit a `MISSING_PHOTOS_DETECTED`-class warning rather than blindly storing.
- Add "captured_at not in any routine window" as a soft-yellow list in CompPortal's `Verify-Media` audit (already partially exists per `src/app/api/media/cd/verify/structural/route.ts`); ensure it surfaces to operator + CD pre-publish.

## P2 — nice to have

### P2.1 — `dayChecklist` module asar packaging fix
- 158 module-resolution errors today. App functioned without dayChecklist; this is just spam.
- Apply the same fix as previous asar dynamic-`require` bugs (static imports + electron-builder file inclusion).

### P2.2 — control-room heartbeat retry observability
- Surface heartbeat aborts as a small connection-status dot. Green/yellow/red.

### P2.3 — Comprehensive incident replay tooling
- `machine_logs` already contains all of today's signals. Build a CD-side "show day timeline" view that pulls all distress signals (warnings, errors, recoveries) for a given comp into a single chronological view. Would have caught today's 09:04 cliff in seconds.

---

# Recovery operations log — what the bypass actually did, end-to-end

Captured here so a re-run is reproducible and the post-event reconciliation has full provenance.

## Step 1 — Diagnose the cliff
- 18:25 EDT operator notices R666 is last DB-recorded routine despite show running to R675.
- Live query against `machine_logs` shows last successful photo import was 09:04 EDT.
- Cards inserted post-09:04 had pre-check auto-skipped on the main process and renderer auto-IPC never fired.

## Step 2 — Recover R667–R675 videos (queue-saturation casualties)
- Script: `/tmp/upload-r667-videos-DART-v2.py` on DART.
- 9 routines × 4 videos (performance + 3 judge feeds) = 36 video files, ~4.1 GB total.
- boto3 multipart parallel upload: 8 MB chunks, 4 concurrent parts per file, 4 routines processed in parallel internally.
- Completed in ~11 min. Zero errors.

## Step 3 — Insert 9 R667–R675 `media_packages` rows
- Hand-built INSERT via Supabase MCP with full field parity (tenant_id, competition_id, entry_number, entry_id, video_start_timestamp, video_end_timestamp, video URLs, keyframes URLs, status fields).
- Timestamps from MKV `ctime` (start) and `mtime` (end) — matches what the in-app recording pipeline writes.

## Step 4 — Photo recovery for R643–R675 (Sunday card backup)
- Script: `/tmp/upload-tocard1-DART-v3.py` on DART against `E:\TOCard1` (Sunday backup card).
- Recursive scan, today-only filter (mtime >= 2026-04-26 00:00 EDT), skip 5841 already-imported filenames.
- 365 today JPGs found, 22 already done, 343 new.
- Per file: PIL EXIF DateTimeOriginal extraction, EDT→UTC conversion (`tzinfo=timezone(-4h)` then `astimezone(utc)`), match against pre-built routine windows, R2 PUT (full JPEG + 200x200 WEBP thumb), result row.
- Completed in 717s. 343/343 ok, 0 errors.

## Step 5 — Photo recovery for R540–R666 (cliff-point routines, multiple cards)
- Script: `/tmp/upload-tosunday-DART-v2.py` on DART against `D:\Transfer\TOSUNDAY` (operator-aggregated dump).
- Skip-existing-by-filename (already-done.json from prior pass).
- 1464 photos uploaded, EXIF-matched, all 99.5% inside their routine windows.

## Step 6 — Bulk INSERT `media_photos` rows
- 1807 rows total across recovery, chunked 35/INSERT, idempotent via `ON CONFLICT (media_package_id, storage_url) WHERE deleted_at IS NULL DO NOTHING`.
- Run via MCP for first 70 rows + via direct psql to Supabase pooler for remaining 1737.
- All R540–R675 routines now have `photo_count > 0`.

## Step 7 — Field-parity backfill (post-hoc fix for `file_size_bytes`)
- All 1807 inserted rows had `file_size_bytes = NULL` (the bypass scripts didn't capture file size at upload time).
- Pulled actual sizes via parallel boto3 HEAD against R2 (1807/1807 successful, ~30 sec at 32-thread concurrency).
- Built 4 scoped UPDATE statements (500 rows each), ran in one transaction via psql.
- Verified: 1807/1807 rows now have `file_size_bytes`. Sizes 4.0–9.7 MB (full-res; see I above).

## Step 8 — TZ verification (audit pass)
- All recovery scripts converted EXIF DateTimeOriginal as Eastern (UTC-04:00 hardcoded for April) → UTC before window matching.
- Post-hoc: 1457 / 1464 photos verified inside their routine `[start, end]` windows; 0 photos outside the ±30s buffer in either direction. Confidence: TZ math is correct.

## Step 9 — R2 reconciliation TODO (not yet executed)
- 62 zombie `media_photos` rows from R548–R644 were soft-deleted at 17:04 EDT to clear cliff-point state and unblock re-import. Their R2 objects may or may not exist (depends on whether the broken mid-run upload completed the PUT before the file was moved out of `F:\DCIM\124NZ6_2`).
- 62 row IDs preserved in soft-delete query result. Reconcile script TBD: inventory R2 objects under affected entries, match against soft-deleted rows + fresh recovery rows, decide undelete-vs-delete-orphan per object.
