# Current Work — CompSyncElectronApp

## STATUS: Friday recovery + Saturday show in progress (2026-04-18 ~13:42 PM EDT)

**Saturday show wraps ~10pm EDT.** App patched twice mid-show:
- 13:05 EDT: 5 show-survival fixes + auto-scroll-to-next-pending (MD5 `B3B2E0FBF3879C021E8BD7136755BC12`)
- 13:42 EDT: lower-third update-gate fix + LeftPanel restructure (CurrentRoutine + Controls/RECORD moved to top, PreviewPanel removed) (**current MD5 `D9EF73529F8467C6267730067EBFF264`**)

**Active task for fresh session:** Explore TRUE compact view feature — see INBOX.md top entry. Two options to investigate (half-screen OR transparent OBS-overlay frame). DO NOT pick stale tasks from this CURRENT_WORK.md.

## Recent fixes deployed today (Saturday)

- **Lower-third bug:** Removed visibility-gate at `overlay.ts:607` that blocked text updates while LT was visible — caused multi-routine staleness
- **Layout restructure:** `LeftPanel.tsx` reorganized — CurrentRoutine + Controls (RECORD) at top, OverlayModules/Controls below, PreviewPanel removed (was disabled anyway)
- **Drive monitor startup fix:** Already-mounted SDs now fire DRIVE_DETECTED at app startup
- **Photo import:** Single-flight + cancel button + EXIF date sanity check + sharp guard

## Chat bug NOT FIXED

DART log shows Supabase Realtime channel TIMED_OUT after 10s on every subscribe attempt. Realtime IS enabled (operator confirmed chat works elsewhere). Likely DART-specific network issue or wrong channel name on producer side. Needs post-show investigation.

## Read first (in order)

1. `docs/plans/2026-04-18-friday-recovery-truths.md` — operator-confirmed facts (cameras, offsets, timezone, video windows). **Treat as ground truth, do NOT re-derive.**
2. `docs/plans/2026-04-18-friday-script-mistakes-postmortem.md` — what last night's v4 script got wrong
3. `docs/plans/2026-04-18-saturday-photo-import-incident.md` — today's mid-show app failure + 6 bugs documented
4. `docs/plans/2026-04-18-overnight-runbook-v5.md` — tonight's overnight execution plan
5. `INBOX.md` top entries — feature requests captured today (timezone storage, original filename preservation, day-checklist modals, completed-routine flag)

## Friday recovery state

- Match v3 done: **17,944 / 18,325 orphans matched** (97.9%)
- Cam B clock correction confirmed at H:168 P1687292.JPG boundary
- 15 missing video windows (R101-R119) backfilled from MKV mtimes today
- Manifest at `/tmp/fri-recovery/v5-imports/v5-2026-04-17-<ts>.json` (17,936 entries from v5 dry-run)
- v5 script ready at `scripts/overnight-sd-import-v5.py`

## ⚠️ Manifest does NOT pass operator's distribution rules

Operator expectations: no routines >300 photos, every routine 50-150, no zero-photo routines.

Projected final state (purge misassigned + add orphan matches):
- **10 routines with 0 photos**: R230, R244, R258, R266, R274, R278, R280, R282, R284, R291
- **41 routines under 50** (R190-195, R228-231, R255-260 etc.)
- **57 routines in 50-150 target range** ✅
- **77 routines 151-300**
- **23 routines over 300** (R117=692, R121=575, R113=514, R122=487, etc.)

**Three things to investigate before approving the manifest for upload:**
1. Why R244-R291 (afternoon) have zero matches when Cam B post-correction folders F:178-F:189 should cover that time range. Photos went somewhere else? Already in DB under different routines? Lost?
2. Whether the >300 routines are real (both cameras shot, legit doubling) or duplicate-counted from same source files.
3. Whether the 50-150 expectation is **per camera** or **total** (Friday had 2 cameras, Saturday has 1).

## Saturday recovery state

- Show in progress until ~10pm EDT
- 9,283 Saturday photos confirmed on F:189-F:196 + H:196-H:198 as of 10:17 EDT scan (more being added)
- Single camera body, 2 SDs, swap at 09:38 between F:196 and H:196
- Operator says EXIF perfect (no offset, no clock issues)
- Videos already going to R2 in normal flow
- Need fresh SD scan after show ends, then mapping, then operator review

## Tonight's overnight plan

After 10pm EDT show ends:
1. Fresh SD scan for Saturday → match v5 dry-run for Saturday
2. Operator reviews both Friday and Saturday manifests
3. Resolve the 3 Friday investigation items above
4. Operator approves both
5. Kick off upload script on DART (mechanical R2 + DB writes from manifests)
6. Sleep through it

## Constraints / hard rules

- **Cameras set to EDT.** EXIF naive value = EDT. The `+00:00` label in orphan JSON is wrong.
- **Use `media_packages.video_start_timestamp/end_timestamp` for routine windows**, NOT `performance_time`.
- **Camera identity by folder prefix**, NOT drive letter.
- **No between-routine shots** — every photo is during a routine.
- **F:224 / Camera 2** is irrelevant, ignore.
- **R310 has 144 legit Saturday photos** at 8:06-8:09 AM mtime from a parallel sync flow that worked correctly — do NOT delete.
- DART app: NEVER kill without operator approval. Operator does asar swaps after closing app themselves.

## Recent files of interest

- `/tmp/fri-recovery/match-v3.json` — per-photo Friday matches (gold standard)
- `/tmp/fri-recovery/match-v3-summary.md` — readable summary
- `/tmp/fri-recovery/video-windows-v3.json` — fresh DB pull including the backfilled 15
- `/tmp/fri-recovery/sd-inventory-saturday.json` — Saturday SD inventory at 10:17 EDT (stale)
- `/tmp/fri-recovery/v5-logs/` — v5 dry-run output
- `/tmp/fri-recovery/dart-pull/` — Friday data pulled from DART (compsync-state.json, main-log-photos.txt, etc.)

## Reference IDs

- Competition: `6f29f048-61f2-48c2-982f-27b542f974b2` (UDC London)
- Tenant: `00000000-0000-0000-0000-000000000004`
- Supabase MCP: `supabase-COMPSYNC` (project `cafugvuaatsgihrsmvvl`)
- R2 bucket: `compsyncmedia` (private)
- Plugin API key: `csm_f68ddeef15d7bbe8e57fa3e0606dc475ee5dc56e6249803c`
- DART SSH alias: `dart` (Windows, cmd.exe shell — use PowerShell for complex commands)
- App data: `C:\Users\User\AppData\Roaming\compsync-media\`
- TesterOutput: `C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026\`
