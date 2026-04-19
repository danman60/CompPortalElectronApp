
---

## From CompSyncElectronApp-current — 2026-04-18 15:20 ET

### Feature request: double-click routine row → operator note editor (faster trigger)

**From Saturday 2026-04-18 mid-show.** Operator wants a faster capture path for per-routine notes: mistakes, weirdness, re-record requests, audio issues, camera swaps, etc.

**Current state (as-wired — not missing, just slow):**
- `Routine.notes` field in `src/shared/types.ts` — stored in local `state.json` only
- `STATE_SET_NOTE` IPC + `setRoutineNote` preload method — wired
- `NoteEditor` component at `RoutineTable.tsx:282-327` — ✎ button per row opens inline textarea editor
- ✅ **Operator-only confirmed:** grep of `src/main/services/compPortal.ts` returned zero matches for `notes`. Nothing syncs to CompPortal. SDs/CDs cannot see these notes.
- ⚠️ **One leak path to be aware of:** notes ARE included in the local CSV session report (state.ts ~line 609, `exportReport`). If operator emails that CSV to anyone, notes go with it. Stays local to the machine unless explicitly exported + shared.

**What's missing — just the faster trigger:**
- Add `onDoubleClick` handler to the `<tr>` in `RoutineTable.tsx:468` area that opens the existing `NoteEditor` (rather than requiring the operator to hit the tiny ✎ button mid-show)
- No backend changes. Pure UI wire-up.
- Apply to the overlay panels automatically — `PreviousRoutines` and `NextRoutines` already use `RoutineTable` via the `windowMode` prop, so they inherit the handler for free.

**Why now:** during live shows routines happen 1-2 minutes apart. If something weird happens (music wrong, camera bumped, photographer missed front half) there's no fast way to capture it. By end of day operator has forgotten which routine had the issue. Post-hoc reconciliation takes hours.

**Not in scope:**
- Server sync to CompPortal (and SHOULD stay out — operator notes are by definition operator-private; surfacing them to SDs/CDs would break their purpose)
- Rich text / attachments / screenshots

**Optional hardening (also operator-private concern):**
- Consider adding a toggle in Settings: "Include operator notes in CSV session report" (default: off). Prevents the one current leak path even if operator accidentally emails the CSV.

---

## From CompSyncElectronApp-7 — 2026-04-18 ~13:30 ET

### Feature request: TRUE compact view — half-screen layout OR transparent OBS-overlay frame

**From Saturday 2026-04-18 mid-show.** Current "compact mode" still consumes most of the screen. Want a real space-saving view so OBS can share the screen.

**Two design options (operator wants exploration in a fresh session):**

**Option A — Half-screen mode**
- App docks to left or right half of screen (or top/bottom)
- OBS lives on the other half
- Compact-but-complete UI: routine table, current routine card, RECORD controls, audio meters all visible in half-width
- Window sizing/positioning configurable; remember last position/snap
- Keyboard shortcut to toggle

**Option B — Frame mode (more ambitious)**
- App wraps AROUND the screen edges (top bar + side strips + bottom bar)
- Center 16:9 area is fully transparent (Electron `transparent: true` + click-through where needed)
- OBS preview window positioned underneath the transparent center
- Operator sees OBS video THROUGH our app, controls live around the edges
- Pros: maximizes OBS viewing area, no window-management juggling
- Risks: Electron transparency on Windows is finicky; click-through behavior across the transparent zone needs testing; multi-monitor + scaling considerations

**Investigation needed in fresh session:**
- Electron transparent window support on DART's Windows + display setup
- Whether OBS can be positioned reliably underneath (always-on-bottom?) without a separate overlay manager
- How the existing components (RoutineTable, CurrentRoutine, Controls, AudioMeters, OverlayControls) reflow into either layout
- Whether Option A is good enough (simpler, lower risk) before tackling Option B

**Do NOT start in this session.** Operator wants a clean context to explore both options.

---

### Feature request: startup + shutdown day-checklist modals

**From Saturday 2026-04-18 mid-show.** Two modal flows tied to the day's recording schedule. Style: **same as the camera-clock-sync modal — big, obvious, dismissable.**

**Startup Modal — fires when app launches on a day where next-routine-to-record is the FIRST of the day.**
Operator's checklist (verbatim):
- Start the live stream (OBS) ~half hour to show
- TVs on and pointed to pages
- Set up cameras
- Stream Deck app running
- Judge backup audio recording

**Shutdown Modal — fires after the LAST routine of the day is recorded.**
Operator's checklist (verbatim):

*App actions:*
- Close CompSync
- Stop stream
- Turn off counter

*Physical / hotel:*
- Mevos/banks charging (charge banks with banks charging Mevos — use tablet charger cable, etc.)
- Cameras off, charging deadest batteries overnight
- Stream off / TVs off (hold bottom power button)
- Each Photo SD card in each Reader (**MUST BE IN BY 10:15pm**)

**Implementation notes:**
- Trigger logic: track "last recorded routine of day" + "next pending routine" — modal fires on the boundary
- Style: like camera-sync modal (big, front-and-center, dismissable). Re-openable from a menu.
- Each checklist item: checkbox + skip + N/A
- Per-day persistence in `state.json` so reopen mid-day doesn't re-fire startup modal
- Hard deadline alert: bold the "MUST BE IN BY 10:15pm" line, escalate visually if past time

---

### Feature request: preserve original camera filenames

**Operator request from Friday recovery debugging.** App renames photos to sequential `photo_NNNN.jpg` on import, destroying the audit trail. When matching goes wrong (today's R310 pollution, Friday's +70min cascade), this makes recovery dramatically harder.

**Why renaming hurts:**
- Lose camera identity (folder prefix tells you which body — P101 vs P166 vs P196)
- Lose sequence position (P1965014 → know it's the 5014th shot of folder 196)
- Wrong-routine assignments become very hard to reverse without re-scanning source SDs every time
- File-density-based debugging (finding clock corrections from EXIF order) impossible after rename

**Proposed:**
- Option A: preserve original filename directly (`P1965014.jpg`) — best for traceability
- Option B: hybrid `photo_NNNN__P1965014.jpg` — keeps sequential prefix for predictable URLs + original name for audit
- Option C: store original filename in a sidecar metadata file or DB column (`media_photos.source_filename`) even if file is renamed

Combined with the timezone fix below, would have made today's recovery work tractable instead of an 18-hour debugging marathon.

---

### Feature request: configurable timezone, save timestamps in that TZ (not UTC)

**Operator request from Friday recovery debugging session.** Repeated UTC↔local conversion bugs caused major confusion: overnight script labeled EXIF as `+00:00` UTC when the values are actually camera-local EDT, leading to 4-hour offset errors during photo→routine matching.

**Proposed:**
1. Add a setting: "Local timezone" (default to system TZ, e.g., `America/New_York`).
2. **Store all timestamps in the configured local TZ** — not UTC. Camera EXIF is already local, so just copy it directly. Video recording timestamps from app: capture in local, store in local.
3. DB: store as `timestamp without time zone` semantically representing local clock time, OR store as ISO string with explicit local offset like `2026-04-17T08:18:28-04:00`. NO silent UTC conversion.
4. CompPortal side: same — read what was stored, no conversion. UI displays as-is.

**Why simpler:** every comparison (EXIF vs video window) is already in the same TZ. No conversion errors. EXIF is naturally local-clock from cameras anyway.

**Known tradeoff:** DST transitions (twice a year) will produce a 1-hour ambiguous window. Not a problem for live competitions which never run across DST boundaries.

**Migration consideration:** existing UTC data needs a one-time conversion + flag. New writes use local TZ.

This would have prevented today's 18-hour debugging session.

---

## From CompPortal session — 2026-04-13

### Tier B deployed (not full Phase 3)

User decision: **minimum safe subset** of Phase 3 on CompPortal, not the full rewrite. Reason: real competition data starts flowing soon, no time to properly test a rewritten `plugin/complete` endpoint. Current e2e pipeline (app → website → download) works and we're not touching it.

**What CompPortal IS doing:**

1. Prisma schema synced (`db pull`) — `deleted_at` columns on media_packages/media_photos, `plugin_write_log` table, all picked up.
2. `GET /api/plugin/schedule/[competitionId]` — adds two additive fields to each routine:
   - `mediaPackageStatus`: `'complete'` if a non-deleted package exists for the entry, else `'none'`
   - `mediaUpdatedAt`: ISO timestamp of package's `updated_at`, or `null`
   - `status` field unchanged (still `'pending'` for all routines)
3. `src/server/routers/media.ts` `deletePhoto` → soft delete (sets `deleted_at`, preserves R2)
4. Read-path audit — `deleted_at: null` filter added to all media_packages/media_photos reads across the repo
5. `deleteFromR2` call sites removed (function kept for future ops script)

**What CompPortal is NOT doing (deferred):**

- `getMediaStoragePath` signature change (no `uploadRunId` in path). **R2 paths remain mutable — re-uploads still overwrite.**
- `POST /api/plugin/upload-url` does NOT require `uploadRunId`. If Electron sends it, server ignores it.
- `POST /api/plugin/complete` is **UNCHANGED**. Still does the original `deleteMany` for photos, still sets status unconditionally, still no audit log.

### Implications for Electron deploy

- **Electron's reconcile logic CAN work** — it just reads `mediaPackageStatus` from the schedule endpoint. This is the most valuable Phase 4 protection and it's live.
- **Do NOT rely on `uploadRunId` being stored server-side.** Electron can still generate and send it, but CompPortal drops it. No per-run isolation on R2 paths until off-season.
- **Re-uploads will still overwrite R2 objects.** If a user re-triggers an upload on the same entry, photos/videos from the previous run are gone. This is the pre-existing behavior, not new risk.
- **`plugin/complete` photo behavior is unchanged.** It still wipes and recreates photo rows on every call. Don't assume filename-merge semantics.
- **No plugin_write_log audit trail yet.** `plugin_write_log` table exists but CompPortal's plugin endpoint doesn't write to it.

### Deploy order

Tier B on CompPortal is safe to deploy any time — it's additive + soft-delete only, zero risk to the current upload pipeline. No deploy-order constraint with Electron.

New Electron build can deploy whenever — it doesn't matter if CompPortal has Tier B deployed first, because the new Electron fields (`uploadRunId`) are ignored server-side rather than rejected.

### Flags still outstanding (from the original Phase 3 plan)

User is aware but deferring:

1. Cross-tenant exposure in `handleFamilyMediaRoutines` / `handleFamilyMediaDownload` (mobile family API, no `tenant_id` filter)
2. `updatePackageStatus` admin tRPC allows downgrades
3. `streamstage/` prefix in compsyncmedia bucket (StreamStage migration artifact)

These aren't being fixed in this session.

### Action items for Electron session

- Can proceed with Phase 4 commits at your discretion
- Reconcile logic should work against the additive schedule fields
- Don't remove Electron-side `uploadRunId` generation — it's forward-compatible even though server is dropping it
- If you want to verify the CompPortal schedule changes are live, fetch `/api/plugin/schedule/<competitionId>` with a plugin key and confirm `mediaPackageStatus` and `mediaUpdatedAt` appear on each routine

---

## To UITweaker-FIX (claude:2) — 2026-04-15 19:55, from CompSync Electron session

Context: I just finished scp'ing a fresh 127 MB `app.asar` to DART 5 minutes ago and watched it launch. Raw experience, no theory.

### 1. NSIS installer deploy path on DART
- CompSync installs to `C:\Program Files\CompSync Media\` (perMachine, not OneDrive). That's the real path the pinned taskbar shortcut points to. Anything on the Desktop is a leftover test copy — ignore.
- For electron-builder NSIS: `"perMachine": true` + `"allowToChangeInstallationDirectory": false` keeps it predictable. `oneClick: true` skips wizard.
- Silent install: `UITweaker-Setup.exe /S` (capital S). Add `/D=C:\Program Files\UITweaker` LAST with NO quotes and NO trailing backslash — `/D` is whitespace-sensitive and must be the final token. So: `UITweaker-Setup.exe /S /D=C:\Program Files\UITweaker`
- `/allusers` or `/currentuser` override the electron-builder scope choice if needed.
- After install, find the asar at `C:\Program Files\UITweaker\resources\app.asar` — same pattern as CompSync.

### 2. Transferring the .exe to DART
- `scp UITweaker-Setup.exe dart:/tmp/ut.exe` then `ssh dart 'mv /tmp/ut.exe "/mnt/c/Users/User/Desktop/UITweaker-Setup.exe"'`. The `dart` host alias (port 2222) works.
- **Do NOT try to scp directly to a path with spaces.** I just got bitten: `scp file dart:/mnt/c/Program\ Files/...` → `dest open "/mnt/c/Program\\ Files/..."` failure (OpenSSH double-escapes the backslash through the remote shell). scp to `/tmp/` first, then `ssh dart mv` with proper double-quoting.
- DART's SSH shell is **git-bash / MSYS2-style with `/mnt/c/` mounts, NOT WSL.** `cmd.exe` and `powershell` are not on PATH by default — use `/mnt/c/Windows/System32/cmd.exe` or `/mnt/c/Windows/System32/tasklist.exe` with full paths if you need them.
- SMB to `/mnt/firmament/` is a FIRMAMENT thing, not DART. DART is a separate Windows box on tailnet. Stick with ssh/scp via the `dart` alias.
- **Always MD5-verify after transfer**: `ssh dart md5sum <path>` and compare to local. I just caught a successful transfer this way — takes 2 seconds, saves an hour of "why isn't my fix working".
- 83 MB over a *direct* Tailscale link is ~10 s. Over a relay (esp. `jnb` Johannesburg if you see it in `tailscale status`), it's several minutes and flaky. If your node is relayed, force re-register with `tailscale up --force-reauth` on DART before transferring.

### 3. First-launch gotchas
- **SmartScreen WILL fire** on any unsigned installer. "Windows protected your PC" dialog → "More info" → "Run anyway". No workaround without real EV code signing. CompSync has lived with this for months.
- **If your installer has a self-signed cert**, SmartScreen treats it *worse* than no cert. Strip the cert before shipping if you're not going to pay for a real one.
- **asar unpack globs**: if UITweaker depends on any native modules (sharp, onnxruntime, canvas, serialport, etc.), the `build.asarUnpack` array must match them. Missing entries → runtime `require` from inside asar fails cryptically ("cannot find module X.node"). Check the unpacked dir post-install: `ls "C:\Program Files\UITweaker\resources\app.asar.unpacked\"` — if a native dep isn't there, add its path to `asarUnpack` and rebuild.
- **Chromium sandbox on Windows works fine.** No WSL issue — DART's SSH shell is MSYS, not WSL. Chromium sandbox runs normally. The only thing that breaks it is running as SYSTEM (not an issue here) or custom ACLs on `%LOCALAPPDATA%\Temp` (don't touch those).
- **If UITweaker spawns a CDP inspector child process**, make sure the port (default 9222) isn't already in use — DART has services on 9876 (overlay) and 9877 (ws hub). Pick something like 9229 or 9300.
- **Electron window restore on multi-monitor**: if DART has 8 detected displays with most detached (VDDs from wifi-display), `electron-window-state` can restore to a detached monitor and the window vanishes. Either bound with `ensureInView`, or delete `AppData/Roaming/<appname>/window-state.json` after install so first launch is centered.
- **Elevation**: if you add a `net session`-style elevation gate like CompSync fix #5, put the escape hatch (`settings.allowNonElevated`) in BEFORE the check, not after. Otherwise a bad build = unlaunchable without editing AppData by hand.

### 4. Things I wish I'd known first time
- **Verify `tasklist` shows no lock BEFORE overwriting.** A running Electron process keeps the asar file-locked. scp silently "succeeds" to a new inode, leaving the running process with the old asar plus a phantom copy. Always: `ssh dart '/mnt/c/Windows/System32/tasklist.exe | grep -i <app>'` first, and if non-empty, kill it.
- **Backups need a timestamp, not `.bak`.** CompSync's backup history on DART is `.bak`, `.pre-2panel`, `.v2.7.0-stable` — a mess. Use `.bak-YYYY-MM-DD` from day 1 so you have real rollback options.
- **Tailscale stale relay = offline node.** If `tailscale status` shows the DART node with relay `jnb` (or any relay on a Canadian box) it has NOT re-registered with the coordination server recently. Doesn't matter that the tray says connected — force-reauth on DART first, THEN transfer.
- **Don't cross-compile native modules from scratch.** electron-builder auto-pulls prebuilt binaries for `win32-x64` (sharp has `@img/sharp-win32-x64` as an explicit dep exactly for this). If you find yourself running `npm rebuild --platform=win32`, stop — the electron-builder flow already does it correctly and 5× faster.
- **Skip `predist` if it runs anything optional.** CompSync's `predist` script runs a `dotnet publish` for a helper exe — that failed on my Linux box because no .NET SDK. I ran `electron-builder --win --dir` directly (without the npm script wrapper) and the actual asar build worked fine; the failure was in a post-asar extraResource step and didn't affect the output.
- **The `predist` / extraResources failure mode is deceptive.** electron-builder writes the asar early and fails on a missing extraResource LATER. If your exit code is non-zero, the asar may still be valid — check `release/win-unpacked/resources/app.asar` mtime and size before assuming the build is broken.
- **Test the version you're deploying before you deploy it.** The local `app.asar` I almost shipped was a broken 1.4 MB partial-pack from some prior session, not a real electron-builder output. I only caught it by `npx asar list` — saw 12 entries with no `node_modules/`. Always `asar list` the file before scp'ing it.

Shout if anything's unclear. — CompSync Electron session (claude:?)

## From CompSyncElectronApp-5 — 2026-04-18 06:35 ET

Recommendations for the Electron app from UDC London 2026 Day 1 overnight
SD-import recovery work.

### P0 — clock-sync reminder modal (operator request)
Direct response to the Camera 2 disaster (171 photos lost, clock 15 days off).

**On app start, every time:** Modal pops front-and-center with:
  - Big, bright readout of the system clock including seconds (live-updating)
  - Instruction: "Match every camera's clock to this time before shooting"
  - Dismissible (operator clicks acknowledge)

**Re-trigger condition:** If no recording activity for 10 minutes, the modal
pops again automatically. Always dismissible. Catches the case where the
operator swaps in a new camera (or switches batteries, which can reset the
clock on some bodies) mid-day without realizing it.

Why front-and-center: a passive footer indicator gets ignored. A modal forces
acknowledgment. The 10-min idle re-trigger catches mid-day camera swaps.

Implementation notes:
  - Live clock display: `setInterval(() => setNow(new Date()), 250)` on the
    modal component
  - "No recording for 10 min" timer should reset whenever a routine
    starts/stops or a manual import fires (any signal of operator activity)
  - Modal should NOT block the app — operator can dismiss and continue
    working immediately, the modal just nudges

### P0 — wrong-day camera detection at SD insertion
When an SD is inserted, sample 5 photos' EXIF DateTimeOriginal. If any have
a date != today (or != system date when the operator confirms today's date),
surface a modal: "Camera clock is N days off. Want to assign manually or
attempt correction?" Tonight: Camera 2 in F:\DCIM\224_PANA had EXIF dates
2 weeks ago, generated 171 unmatchable photos.

### P0 — persist EXIF DateTimeOriginal in the tether path
The in-app tether matcher reads EXIF but doesn't send `captured_at` to
CompPortal. Result: media_photos rows have NULL captured_at, post-hoc dedup
impossible. Fix once: pass capture times in `/api/plugin/complete` body
(matching the CompPortal P0 in that repo's inbox).

### P0 — multi-SD/multi-camera namespace awareness
Tonight: F:\DCIM\166_PANA and H:\DCIM\166_PANA both exist with DIFFERENT
photos that share the same filenames (P1667001.JPG on each). Any code that
sorts photos across drives by filename is wrong. Always partition by drive
letter (or camera serial) first, then sort within.

### P1 — onboarding must NEVER clear settings
If state.json is cleared (which happens occasionally), onboarding triggers and
WIPES `compsync-media-settings.json` overwriting things like share code,
output dir, behavior toggles. Tonight: had to restore from a backup. Fix:
onboarding adds defaults only for missing keys, never overwrites existing
configured values.

### P1 — never use file mtime as a time signal in matching
v4 of the overnight script went hard on EXIF DateTimeOriginal only (no
fallback to file mtime / Image DateTime / DateTimeDigitized). Same rule
should hold in the in-app tether matcher: copying or syncing files shifts
mtime, contaminates matching. Use only DateTimeOriginal or fail loud.

### P1 — first-class dry-run mode for SD imports
v4's `--limit=N` was operator-facing for the script. Make this UI-facing too:
"Preview SD import" → shows per-routine projected counts, orphan list,
swap-window detection — operator confirms before commit. Would have saved
tonight's two rollbacks.

### P2 — persist scan + match manifest on every SD import
Even on success, write `<output>/imports/<sd-uuid>-<timestamp>.json` with
every photo's source path, EXIF, matched routine, and offset. Tonight's
overnight script does this; the in-app tether path doesn't. Audit gold.

### P2 — surface unassigned photos in the existing orphan drawer
v2 added the orphan review drawer. Verify it consumes the overnight script's
`overnight-orphans.json` (or a standardized manifest) so operator can triage
the 18,325 unassigned photos from tonight's run.

### Recovery script reference (this repo, scripts/overnight-sd-import.py)
v4 lives at `scripts/overnight-sd-import.py` SHA `9662d6c0...`. Known issues:
  - Phase 3 swap detection completely disabled (false positives on
    session-boundary EXIF gaps were uncatchable from data alone)
  - Wrong-day camera handling: skipped (correct — they're unsalvageable
    via offset)
  - Strict containment matcher is currently MISSING 34 routines that the
    operator confirmed WERE shot — investigation in progress in fresh
    session CompSyncElectronApp-6

---

## From CompSyncElectronApp-bugfix — 2026-04-18 21:30 ET

### Feature request: SD card "just works" flow — auto-import, auto-offset, background processing

**Operator context (verbatim, 2026-04-18 ~21:17 ET):** mid-session SD swaps are the primary workflow. Operator wants:
- Plug SD mid-session → no modal, no clicking through steps
- Photos auto-match to routines, auto-upload to CompPortal in background
- If a known-bad offset is detected, one-line popup to confirm/correct; offset then persists for rest of day (per camera body)
- While session continues, second SD goes in later → same silent flow
- By end of session, all photos live in CompPortal DB, sorted by routine

**What was shipped as a partial fix tonight (2026-04-18 build md5 `5fc6349546e80...`):**
- `DriveAlert.tsx` now auto-minimizes when `settings.behavior.autoImportOnDrive === true` (the default). Operator now sees a Header progress pill instead of the full-screen modal. Existing background import + orphan review drawer + wrong-day detection all unchanged.

**Still to do (this is the full spec — don't build piecemeal, build as a coherent flow):**

1. **Persistent per-camera offset**
   - `state.json` → add `cameraOffsets: { [folderPrefix: string]: { offsetMinutes: number, appliedAt: ISO, confirmedBy: 'operator' | 'auto' } }`
   - Keyed by folder prefix (e.g., `P166`, `P196`, `F:\DCIM\224`) since that identifies the camera body, not drive letter (drive letters rotate)
   - Applied to all subsequent EXIF timestamps from that prefix for the rest of the day (until app restart OR operator clears)
   - Cleared on new session day (compare `date(cameraOffsets[*].appliedAt)` to today)

2. **Auto-detect suggested offset**
   - On SD insert, sample first 20 photos' EXIF
   - If <20% match any recording window → compute candidate offset by looking for the offset value that maximizes matches
   - If a strong candidate exists (say +X min gives >80% match), offer it: tiny one-line modal "Camera clock appears +X min off. Apply for today?" → one click Yes/No
   - If no strong candidate → still show the modal with a manual minutes input, pre-filled with the best guess
   - Soft modal (dismissible, reappears until addressed)

3. **Re-match orphans when new recordings complete**
   - Current: photos whose EXIF doesn't fall in any known recording window become orphans (visible in the orphan drawer)
   - Desired: every time a routine's recording stops (recordingStoppedAt set), re-scan orphans. If any now match the new window, auto-assign them
   - This makes the "drop SD in mid-session, later recordings pick up photos for not-yet-recorded routines" flow work naturally

4. **Upload ordering — raw first, thumbnails second**
   - Currently upload.ts uploads both. Flip priority: full-res photo uploads first, thumbnail queues after
   - Rationale: the secondary operator who culls for the on-stage slideshow views photos directly on CompPortal and needs the hi-res (they zoom / inspect). Thumbnails are only a fallback for grid rendering speed
   - Thumbnails still get generated and uploaded — just not first
   - Paired with CompPortal's "prefer hi-res, fall back to thumb" serving change (see CompPortal INBOX 2026-04-18 21:27)

5. **Toast copy**
   - Instead of current progress pill text ("Importing 45/2000"), add a clear "SD matched — X photos, importing" toast on start, and "Import complete — X matched, Y orphan" toast on finish
   - Soft toast, dismissible, non-blocking

**Not in scope:**
- WPD/PTP mode — still shelved
- Thumbnails-on-CD-portal size (handled in CompPortal INBOX)
- Photo culling UI on the app itself

**Known related issues from today:**
- "Every routine WAS captured" feedback memory (`feedback_every_routine_captured.md`) — matcher bugs cause false absences, not real absence. Whatever offset detection we build must never dismiss a whole folder as "no matches" silently.
- Friday recovery showed offset chaos (+60min post-lunch, -15 days Cam B) — per-camera offset storage is ESSENTIAL, not nice-to-have.
