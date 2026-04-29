# Day 2 Fix List v2 — UDC Toronto 2026-04-25

Source of items: operator break-list, 09:00 EDT 2026-04-25.
Research basis: full-tree code map run 2026-04-25 09:05 EDT (file:line refs below).
Status: drafted, NOT executing. Wait for "build N" or "ship N" before any code change.

## Recommended implementation order

**Wave 1 — ship before next break:**
1a. Pill label (SCANNING vs IMPORTING) — `Header.tsx:432`
14. Status accuracy — "All Media Uploaded" no longer fires when zero photos imported — `RoutineTable.tsx:32-53`
11. Counter overlay — remove `counter-label` (the duplicate smaller number) — `overlay.ts:1474-1475,1611,866-871`
13. Remove TETHER + JOB QUEUE pills — `LeftPanel.tsx:32`, `ShowControlRail.tsx:24-34`
12. Auto-scroll active routine to upper-middle — `RoutineTable.tsx:497-516`
1. Import cancel actually cancels — `photos.ts:155-188,242-252` + DriveAlert pill reset
4. NEXT defensive scratched skip — `state.ts:512-538`

**Wave 2 — separate ship:**
10. Global KICK QUEUE + right-click AUTO toggle — `RoutineTable.tsx`, `upload.ts:462`

**Wave 3 — Stream Deck additions:**
6. NEXT button flash at 2:20 INTO recording — `streamdeck-plugin/src/actions/next-routine.ts`
7. Cycle OBS transitions — new `streamdeck-plugin/src/actions/cycle-transition.ts` + new IPC
3. CSController network/IO contention fix (now unblocked) — `upload.ts`, `obs.ts`

**Wave 4 — audio + drag/drop + judge re-record:**
8. Audio-flat banner during recording — `obs.ts`, `VerticalMeters.tsx`, `App.tsx:22-84`
5. Drag/drop reorder routine rows (NEXT-only effect, persists across schedule pushes) — `RoutineTable.tsx:454`
9. Judge re-record audio flow (versioned R2 path, archives old) — new feature, multi-file

**Item 2 removed** — disregarded by operator.

---

## Per-item plans

### 1. Importing pill stuck on "0 of 6.8k"; cancel doesn't cancel

**Diagnosis (verified live 2026-04-25 09:09 EDT):** 09:06:09 operator clicked import on F:\DCIM (yesterday's card). At 09:06:14, EXIF pre-check fired the date-mismatch dialog (20/20 photos NOT today). Dialog is modal; the import loop is held PRE-scan-loop waiting for operator answer. `currentImport.abortController.abort()` from cancel only releases the loop's signal — but the modal is rendered before the loop reaches its first signal check, so cancel never fires.

**Fix — `photos.ts:230,936-956,246`:**
- Move the abort-signal check to immediately before the date-mismatch modal awaits operator answer (line ~190-200 in photos.ts, before the dialog `await`).
- When cancel is pressed while modal is open: dispatch `dialog.close('cancel')` AND set abort, in that order. Modal close handler resolves to `'canceled'`, loop exits cleanly.
- Also clear the renderer pill state on cancel: send `import-progress` IPC with `{ stage: 'idle', current: 0, total: 0 }` so `useImportMinimizedState` snapshot resets. Currently the snapshot doesn't reset on cancel — that's why the pill stays at "0 of 7k".

**Sub-fix 1a (renderer-only):** Header pill at `Header.tsx:432` says "Importing N of M" regardless of stage. Switch label off `s.stage`:
- `scanning` / `exif` / `dedup` / `pre-check` → "SCANNING"
- `copying` / `inserting` → "IMPORTING"
- emit `stage` from `photos.ts` if not already emitted — verify in scan loop emit sites.

Risk: low. Renderer + main both touched but no DB/R2 effect.

---

### 2. Day transition / "stuck doing manual work syncing state"

**Current state pieces operator manually syncs at midnight (per code map):**
- `compsync-state.json.cameraOffsets` — per-body clock drift, KEEP across days (physical body trait)
- `compsync-state.json.sdWatermarks` — last-processed photo timestamp per camera body, **must reset** at midnight or the today-precheck eats today's photos before they're scanned
- `driveMonitor.knownDrives` (`driveMonitor.ts:705`) — already cleared on app boot, NOT day-boundary-aware. Need explicit clear at midnight too if app stays running across days
- Schedule re-load — operator currently picks new day's schedule manually
- Routine `status` flags from yesterday — must NOT leak into today's view (filter by competition_id is fine since each day's competition is a different `competition_id`, but verify)

**Fix:**
- New main-process timer in `state.ts`: at 03:00 EDT (after midnight, before any operator activity), if `currentCompetition` exists and its date is not today, fire a `dayRollover()` routine:
  - `sdWatermarks = {}`
  - `driveMonitor.knownDrives.clear()`
  - emit IPC to renderer: `state-rolled-over` so UI re-fetches schedule
  - keep `cameraOffsets` untouched
- Manual rollover button in dev/operator UI for testing.

**Today determination:** `photos.ts:73-87` already uses local `getFullYear()/getMonth()/getDate()` (Eastern, since DART is set to Eastern). That's correct — no TZ bug. The `today` variable at `photos.ts:102` is captured at import-time per call, not held; verified safe.

Risk: medium. Operator-visible reset; needs testing on day boundary.

---

### 3. CSController APK lagging during encoding

**Confirmed:** "Tablet display" = CSController Android APK, separate device. ffmpeg priority on DART cannot directly affect the Android device. Lag root cause is data flow from DART to tablet getting starved when DART is busy.

**Two-pronged fix on DART:**

(a) **Network bandwidth contention.** DART runs concurrently: `wifi-display` server (~2.5 Mbps), 4× ffmpeg children, OBS WS, R2 uploads. When ffmpeg + upload hit at once, packets to tablet stall.
- Cap upload concurrency to 1 during active recording (`upload.ts:557-575`). Lift cap when recording stops.
- Inspect `wifi-display` server's QoS — does it run with any priority hint? (Expect: no.) If not, set process priority above normal so its packets aren't starved.

(b) **Windows I/O priority not set on ffmpeg.** Logs confirm CPU is `belownormal` (`[FFmpeg] Set FFmpeg PID 17120 priority to belownormal` at `obs.ts`). Windows I/O priority is separate; ffmpeg's disk I/O still defaults to normal. Lower it:
- Use `wmic` or PowerShell `Set-ProcessPriority` with I/O class on each ffmpeg PID after spawn.
- Test impact on encode duration (slower = OK; tablet smoothness wins).

(c) **WS heartbeat from main → CSController.** Code map flagged WS hub on port 9877. If main process is GC-pausing under load, WS messages stall. Verify the WS broadcast happens on a dedicated thread or async-flushed queue, not in the same tick as ffmpeg-stderr ingest. May need worker-thread-isolation if confirmed.

Risk: medium. (a) is safe; (b) needs measurement; (c) may be a no-op until profiled.

---

### 4. Scratched routines skipped by NEXT (still displayed)

**Current behavior — `state.ts:483-538`:**
- `getVisibleRoutines()` filters by `status !== 'skipped'` — does NOT filter `'scratched'`.
- `advanceToNext()` (line 512-538) reads `getVisibleRoutines()` then increments `idx + 1` blindly without checking the next routine's status.

**Fix:**
- Keep `getVisibleRoutines()` as-is so scratched still RENDERS in the table.
- In `advanceToNext()`, after resolving the next index, loop forward while `next.status === 'scratched'` to find the next non-scratched routine. Stop at end-of-list.
- Edge case: if entire remaining list is scratched, fall through to existing end-of-list handling.

Touches one function. No DB schema, no UI. Risk: low.

---

### 5. Drag/drop reorder routine rows (NEXT-only effect)

**Current state — `RoutineTable.tsx:454`:**
- Routines rendered directly from `competition?.routines` array order.
- No drag library in `package.json`. Drag handlers exist (line 558-579) but for video-file drop, not row reorder.
- NEXT advance reads from same array as render — they share order.

**Fix proposal:**
- Add `@dnd-kit/core` + `@dnd-kit/sortable` (~30KB, framework-agnostic, modern, maintained).
- Introduce parallel `displayOrder: string[]` (routine IDs) on `competition` state — NULL means "use default routine_number order".
- Render order = `displayOrder` if set, else routine_number sort.
- NEXT advance reads `displayOrder` (single source of truth — operator sees what NEXT will pick).
- Persistence: in-memory + `compsync-state.json` (survives app restart).
- **On schedule re-import from CompPortal: PRESERVE `displayOrder`.** New routines (not in existing `displayOrder`) are appended at the end in schedule-order. Removed routines drop out of `displayOrder` automatically. Operator's manual order persists.
- Strictly local to operator UI — not pushed to tablet/CompPortal.

Risk: medium. New library, new state field. Touches `RoutineTable.tsx`, `state.ts`, schedule loader.

---

### 6. NEXT Stream Deck button flash at 2:20 INTO recording

**Mapped — `streamdeck-plugin/src/actions/next-routine.ts:7-15`:**
- Library: `@elgato/streamdeck` v2.0.1. No native blink/animation API.
- Recording start tracked at `recording.ts:830`: `recordingStartedAt: timestamp` on Routine record.
- IPC `recording-started` event fires at `main/index.ts:354`.

**Fix:**
- Plugin subscribes to recording-state changes via existing WS (`streamdeck-plugin/src/conn.ts`).
- On `recording-started`, plugin starts a 140-second `setTimeout` (= 2:20).
- At fire-time: alternate `setImage()` between normal SVG and a high-contrast warning SVG (red bg, large arrow) every 250ms via `setInterval`.
- Stop blink on either: NEXT pressed (operator advanced), or `recording-stopped` event.
- Operator-tunable: 140s default, expose as a Stream Deck per-action setting (`@elgato/streamdeck` supports per-action settings persistence).

Risk: low. Plugin-side only, no main-app code change beyond the WS event (already emitted).

---

### 7. CS Stream Deck button cycles OBS transitions, indicates active

**Mapped — OBS WebSocket v5 (`obs-websocket-js@5.0.6`), `obs.ts`:**
- v5 methods needed: `GetSceneTransitionList`, `SetCurrentSceneTransition`, `GetCurrentSceneTransition`. Event: `CurrentSceneTransitionChanged`.
- No transition calls exist today.

**Fix:**
- New `obs.ts` helpers: `getTransitionList()`, `getCurrentTransition()`, `setCurrentTransition(name)`.
- Subscribe to `CurrentSceneTransitionChanged` event; broadcast over WS to plugin.
- New plugin action `cycle-transition.ts`:
  - On press: fetch list, find current index, advance to next (wrap), call `setCurrentTransition`.
  - On render: show current transition name on button face (via SVG label).
  - Subscribe to transition-change events to keep face fresh.

Risk: low. Additive. No state file changes.

---

### 8. Audio-flat banner during recording > 5s

**Mapped:**
- Audio meter UI: `VerticalMeters.tsx:54-65` consumes `audioLevels` WS messages.
- Subscription to OBS audio: **NOT wired**. `setOnAudioLevels` callback exists at `obs.ts:28-30` but no `obs.on('InputVolumeMeters')` listener configured.
- Recording state: `obs.ts:63-67` has `state.isRecording` from `RecordStateChanged` event.
- Banner precedent: `App.tsx:22-23,43-48,77-84` — pattern is `useState` + IPC listener + conditional banner top-of-app.

**Fix:**
- In `obs.ts`, subscribe to `InputVolumeMeters` event when recording starts; unsubscribe on stop.
- Per channel (P, J1, J2, J3): track rolling 5s peak. If `peak < -55 dBFS` for ≥5s continuous AND `state.isRecording === true`, fire IPC `audio-flat-alert` with `{ channel, sinceTs }`.
- Renderer subscribes; when alert active:
  - Banner at top of `App.tsx`: `"AUDIO SILENT — {channel} flat for {N}s"` red bg, dismissible.
  - `VerticalMeters.tsx`: matching channel bar glows red (CSS class on bar element).
  - WS broadcast `audio-flat-alert` event so Stream Deck plugin can flash a dedicated AUDIO ALERT button (new action, follows item 6 pattern).

**Defaults (override if you want different):**
- Threshold: -55 dBFS (well below normal speech baseline of -25 to -10)
- Window: 5s continuous
- Channels monitored: all 4 (P + J1 + J2 + J3) independently

Risk: medium. Subscribes to high-frequency OBS event; need to debounce + handle unsubscribe correctly to avoid CPU drain.

---

### 9. Re-record judge audio flow

**Mapped:**
- Existing record path: OBS records master MKV with multiple tracks → `ffmpeg.ts:586-649` splits performance + judge tracks → uploads each as separate MP4 (`upload.ts:28` `role` field).
- R2 paths: `judge1_video_url`, `judge2_video_url`, `judge3_video_url`, `judge4_video_url` columns on `media_packages`.
- Master raw MKV: stays local on DART at `TesterOutput\<comp>\<entry>\<entry>_<title>.mkv`. Not uploaded to R2.
- Audio-only mux precedent: `audioTranscription.ts:126-140` already uses `ffmpeg -c:v copy -c:a aac -i audio.wav -i video.mp4` pattern.
- No video player in renderer today.

**Flow per your spec (judge selected first):**
1. New page in CSE renderer: "Re-record judge audio".
2. **Step 1 — judge select:** dropdown {J1, J2, J3, J4} from current competition's judge slots.
3. **Step 2 — routine select:** searchable list of recorded routines for current competition.
4. **Step 3 — playback + record:**
   - Load existing performance MP4 (download from R2 to temp dir if not local) into HTML5 `<video>` element with default audio output.
   - Capture mic via OBS scene "JudgeRecord" (configured once: routes selected judge's XLR to a dedicated audio track) — or via direct ffmpeg dshow capture if simpler.
   - Big record button: starts ffmpeg `-f dshow -i audio="<mic>" -t <video-duration> -c:a pcm_s16le judge_recap.wav` synchronously when video plays.
   - Auto-stop when video ends.
5. **Step 4 — mux:** ffmpeg `-i performance.mp4 -i judge_recap.wav -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 judge_re_mixed.mp4`.
6. **Step 5 — upload + archive + assign:**
   - Read existing `judgeN_video_url`. Move/copy that R2 object to `archive/judgeN_<originalTs>.mp4` BEFORE writing new (cheap server-side copy via R2 CopyObject).
   - PUT new judge audio-mix MP4 to a versioned path (e.g., `judgeN_v<N+1>.mp4` where `N` increments per re-record).
   - Update DB column `judgeN_video_url` to new versioned path.
   - Old object remains accessible via archive path for audit / undo.
   - Never overwrite an existing R2 path.

**Confirmed:** mic source = same as app already reads (the OBS source already mapped to the chosen judge). Implementation reads existing judge→OBS-source mapping from settings, captures from that source via OBS during re-record session.

**Audio sync:** trust ffmpeg `-itsoffset 0` start-on-play timing. If drift surfaces during testing, add manual offset slider in step 4 — defer until needed.

**R2 versioning — still ambiguous:** overwrite existing path (`judgeN_video_url`) so URL stays stable + CDN refresh happens via TTL — OR write to versioned path (`judgeN_v2.mp4`) and update DB column to point at new path? Tradeoff: overwrite is simpler, version-path keeps audit trail. Need your call.

Risk: high. New surface, multiple ffmpeg flows, R2 write. Build behind a settings flag.

---

### 10. Global KICK QUEUE + right-click AUTO toggle on top routine row

**Mapped:**
- Queue scheduler: `upload.ts:462` `startUploads()`, `upload.ts:557-575` `processLoop()`.
- AUTO state: `useStore.ts:33-34` global `autoEncode`/`autoUpload`. Per-row toggle does NOT exist today.
- Right-click context menu: not implemented in `RoutineTable.tsx` (line 558-579 is video-file drop, not contextmenu).
- Stuck detection: none. Jobs either run, fail (quarantine), or sit pending until something nudges the loop.

**Fix interpretation (confirm if I have the trigger semantics right):**
- Add right-click handler on routine row's UPLOAD and PROCESS buttons.
- Right-click toggles a per-row AUTO flag (separate from global) — meaning "auto-act on this routine when it's ready".
- The toggle action ALSO fires `kickQueue()` as a side effect.
- `kickQueue()` = re-call `startUploads()` + `startProcessing()` regardless of current flags + clear any "scheduler is sleeping" state.
- ALSO: a separate KICK QUEUE button in the header for the global manual kick (no targeting).

Persistent: per-row AUTO flag survives app restart? Recommend yes (in `compsync-state.json.routineAutoFlags`).

**Confirmed:** right-click toggles. Visual badge on button when AUTO=on for that row.

Risk: medium. Per-row state new; queue kick is straightforward.

---

### 11. Counter overlay — keep larger numeral only

**Mapped — `overlay.ts:17,604-606`:**
- `overlayState.counter = { visible, current, total, entryNumber }`.
- Two numerals rendered = `current` (counts UP, since you confirmed) and a second smaller numeral (likely `total` or `entryNumber` depending on overlay HTML).
- Overlay HTML/CSS lives outside `src/` tree (express server-served static assets) — code map didn't locate it. Need to find: probably `resources/overlay/` or `public/overlay/` or similar.

**Fix:**
- Locate overlay HTML/CSS first (one grep for "counter" inside the resources tree).
- Remove the smaller numeral element. Keep only the larger one.
- Preserve `overlayState.counter.current` updates as-is.

Risk: very low. Pure visual.

---

### 12. Auto-scroll active routine to upper-middle

**Mapped — `RoutineTable.tsx:509-516`:**
- Currently scrolls `nextUnrecordedRowRef` ONCE on mount via `scrollIntoView({ block: 'center' })`. `hasAutoScrolledRef.current = true` blocks repeats.
- Active-row marker: `routine.id === firstUnrecordedId` at line 650.

**Fix:**
- "Active" = currently-recording routine (you confirmed). Use `currentRoutineId` from state instead of `firstUnrecordedId`.
- Replace the once-only `useEffect` with one that runs whenever `currentRoutineId` changes.
- `block: 'start'` with offset, OR `scrollIntoView({ block: 'center' })` then offset by `-rowHeight*2` to land in upper-middle (1/3 from top).
- Operator-protection: if user manually scrolled within last 5s (track `wheel`/`touchmove`), defer auto-scroll. Resume after 5s idle.

Risk: low. Single component.

---

### 13. Remove TETHER + JOB QUEUE pills

**Mapped:**
- TETHER: `TetherStatus.tsx`, mounted at `LeftPanel.tsx:32`.
- JOB QUEUE: `JobQueuePanel`, mounted at `ShowControlRail.tsx:32-33`.

**Fix:**
- Delete both `<X />` mounts at the two sites.
- Delete the component files (`TetherStatus.tsx`, `JobQueuePanel` block in `RightPanel.tsx:7-76`).
- Leave underlying state subscriptions in `useStore.ts` — they may still drive other UI (verify with grep before deletion).
- Delete CSS files if not referenced elsewhere.

Risk: very low. Pure UI removal.

---

## Cross-cutting notes

- `recording.ts` is touched by items 2, 4, 6, 8 — single asar deploy must batch these to avoid merge conflicts.
- `RoutineTable.tsx` is touched by items 4, 5, 12 — same.
- `state.ts` is touched by items 2, 4, 5, 10 — same.
- Item 9 (judge re-record) is the only item with R2 write + new feature surface — keep behind a build flag, ship after others land.
- Item 3 (tablet CPU) blocked on user clarification before any code change.

## Build sequence proposal

1. **Wave 1 + Wave 2 in one swap** — items 1, 1a, 4, 10, 11, 12, 13. Renderer + main, no new libs, no new flows. ~60 min code, normal QA.
2. **Wave 3 separate swap** — item 2 (day rollover) + items 6, 7 (Stream Deck). Stream Deck plugin needs separate install on operator's host. ~90 min code.
3. **Wave 4 separate swap each** — item 8 (audio), item 5 (drag/drop), item 9 (judge re-record). Each is a discrete feature; bundle if scope allows.
4. **Item 3 deferred** until tablet-vs-LT clarification.

---

## Status

All items unblocked. Wave 1+2 building now. Operator will close + swap when ready.
