# UDC Toronto Day 2 — Tomorrow Fix List

Started 2026-04-24 22:20 EDT after Day 1.

Each item = scope, why, where in code. No implementation until operator gives go.

---

## 1. Close-confirmation dialog warning about in-flight jobs

**What:** When the operator clicks the window close button (or selects File → Quit), intercept it. If there are pending upload jobs, active encodes, in-flight imports, or unfinished routine recordings, show a confirmation dialog:

> CompSync Media has work in progress:
>
> • {N} upload jobs pending
> • {M} encodes in flight
> • {K} photo imports running
>
> Closing now will pause everything until you reopen. **We recommend leaving the app open.** It will keep uploading in the background.
>
> [ Leave open (recommended) ] [ Close anyway ]

**Why:** Day 1 ended with ~400 pending upload jobs and operator closed the app per end-of-day checklist. Tomorrow's launch had to drain that backlog before new work. If the app had stayed open overnight, the queue would've cleared by morning. The end-of-day checklist conflicts with the upload pipeline's batch nature.

**Where:**
- `src/main/index.ts` — wire `BrowserWindow.on('close')` handler. Today there's no close-event interception (close goes straight to `app.quit()`).
- Pending-job count: `jobQueue.getPending('upload').length` + ffmpeg encode queue + photos import worker state
- Block close until operator confirms via `dialog.showMessageBox` with cancel/quit options
- Settings flag `behavior.confirmCloseWithPendingJobs` (default true) so power-user ops can disable
- `app.on('before-quit')` covers Cmd+Q / shutdown paths; `BrowserWindow.on('close')` covers the X button. Need both.

**Edge case:** if app is being closed by an unrecoverable crash recovery flow, skip the prompt (we want it to actually quit).

---

## 2. Filename-based pre-dedup before EXIF scan

**What:** When `dedupByDb: true` is set on an import, do a cheap filename check
*before* the EXIF read loop. For every file on the SD, if the filename has
already been uploaded for this competition (per the DB / local manifest),
skip it entirely — no EXIF read, no hash compute.

**Why:** Today the EXIF loop reads every photo on the SD even when 4,900 of
5,000 are already in the DB. With multiple boot-mounted SDs, this slows the
"app should always be working until everything is done" loop noticeably.
User asked for this as "an easy enough check, not import photos that exist
in history."

**Where:**
- `src/main/services/photos.ts` ~line 1151 (top of EXIF read loop): before
  `manifest.computeSourceHash`, look up `path.basename(p)` in a pre-fetched
  set of already-uploaded filenames for the current competition.
- That set should be populated once at the top of importPhotos when
  `opts.dedupByDb` is true — single DB call to `/api/plugin/list-photos`
  (or equivalent) with `competitionId`, returning `{ filename, sourceHash }`
  pairs. Build an in-memory `Set<string>` for O(1) lookup.
- Keep the existing `seenHashes` (intra-run) and `opts.dedupByDb`
  (post-EXIF) checks as belt-and-suspenders.

**Edge cases:** Filename collisions across cameras (e.g. two Canons both
producing `IMG_0001.JPG`) — the sourceHash check on line 1156 still runs
for any file that passes the filename gate, so collisions don't silently
swallow new photos.

---

## 3. "Always working" visibility / never-idle indicator

**What:** A persistent header/footer indicator that shows the operator the
app is actively chewing through work. Counts of: pending uploads, encodes
running, thumbnails to generate, photos to match, EXIF backfill remaining.
Hits zero only when everything is truly done. Visual cue (spinner / pulse /
"WORKING" badge) when any subsystem is non-zero, hard "ALL CAUGHT UP"
state when all four are zero.

**Why:** Operator's stated bar — "I want the app to be always working until
all of it's importing and encoding, thumbnails, matching etc are complete."
Today the operator has to mentally aggregate from multiple panels to know
whether the app is genuinely caught up or just appears idle.

**Where:**
- New header strip component, e.g. `src/renderer/components/WorkStatus.tsx`,
  fed by a new `state:work-summary` IPC that returns `{ uploadsPending,
  encodesRunning, thumbsPending, photosPendingMatch, exifBackfillPending }`.
- IPC handler aggregates from `jobQueue` (upload + thumbnail types),
  `ffmpegService` (active encodes), and a new "needs match" counter on
  `state` (routines whose photos haven't been EXIF-matched yet).
- Pairs naturally with item #1 (close confirmation reads from the same
  signals).

---

## (placeholder — append more items below as they come up)
