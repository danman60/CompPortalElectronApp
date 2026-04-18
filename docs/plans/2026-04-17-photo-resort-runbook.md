# Photo Re-Sort Runbook — UDC London 2026
# (Spec for future in-app "Verify & Re-sort Photos" button — Task #6)

## Purpose
Document every step of the historical photo re-sort so we can productize this
as an in-app feature. Every decision, input, transformation, and output is
logged here in execution order.

## Context (2026-04-17)
- UDC London live show, DART production machine
- Routines 100-124 were recorded under a mix of buggy photo-matching configs:
  1. 60s tether match buffer (too wide — bled photos across routines)
  2. Clock offset adjustment that was corrupted by tether transfer delay
- Fix deployed mid-show (~routine 120): buffer=5s + raw EXIF + no offset
- Data confirms forward-matching is now clean: #125-143 have 0% photos outside
  exact recording window
- Remaining mess: routines #100-120 on disk are contaminated. Most photos
  landed on #106 (754 photos, 91% outside its 12:18-12:20 window).

## Inputs (what the re-sort reads)
1. **`compsync-state.json`** from `%APPDATA%\compsync-media\compsync-state.json`
   - `competition.routines[]` — each with `entryNumber`, `id`,
     `recordingStartedAt`, `recordingStoppedAt`, `photos[]`
   - Each `photos[]` entry has: `filePath`, `captureTime` (ISO EXIF),
     `confidence`, `uploaded`, `matchedRoutineId`, optional `storagePath`
2. **Photo files on disk** at
   `<outputDir>\<ShareCode>\<entryNumber>\photos\photo_NNN.ext`
   - For UDC London: `C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026\<entry>\photos\`

## Algorithm

### 1. Build authoritative windows
From every routine with both `recordingStartedAt` and `recordingStoppedAt`,
build a sorted list of `(entryNumber, routineId, start, stop)`.

### 2. For each tracked photo, compute correct routine
Read `captureTime` from state (this is the EXIF `DateTimeOriginal`).
Match against windows:
- **Exact**: `start ≤ exif ≤ stop` → that routine
- **Gap (5s buffer)**: `start-5s ≤ exif ≤ stop+5s` → that routine
- Neither → mark unmatched

This mirrors `matchSinglePhoto` in `src/main/services/tether.ts` — the SAME
logic the live matcher uses, but now applied retroactively with the CORRECT
current buffer.

### 3. Emit a manifest
For each photo:
- `stay`: photo is already in the correct routine's dir
- `move`: photo's EXIF belongs to a different routine → generate
  (source_path, dest_routine_entryNumber, capture_time)
- `unmatched`: no routine window matches → leave in place, log

### 4. Execute moves on disk
For each move:
- Copy source file into destination routine's `photos/` dir
- Use a temp name first (e.g., `incoming_<uuid>.ext`) to avoid number
  collisions during concurrent copies
- After all copies succeed, delete the source files
- After all moves done per destination, **renumber** all files in that dir
  sequentially: `photo_001.<ext>`, `photo_002.<ext>`, ...

### 5. Rewrite state.json
For each affected routine, replace `photos[]` array so that:
- filePath reflects the NEW location + NEW name after renumber
- order follows renumber order (by captureTime ascending)
- `matchedRoutineId` updates to the new routine's id
- `uploaded`/`storagePath` preserved only if the photo was already uploaded
  (those R2 uploads will need DB re-association, see step 7)

### 6. App restart requirement
The live app holds `currentCompetition.routines[].photos` in memory. Disk
changes without an app restart cause:
- Next upload attempt uses stale `filePath` → ENOENT → upload fails
- State save overwrites our corrected state.json with stale memory

**The app MUST be restarted after the manifest executes**, loading the
corrected state.json on cold start.

### 7. Database sync (CompPortal)
After app restart + uploads catch up, DB needs reconciliation:
- **Create missing `media_packages` rows** for routines with new photos but
  no row yet (e.g., 113, 115, 116, 118-120 at time of this run)
- **Update `photo_count`** on every affected `media_packages` row to match
  disk truth
- **Re-associate `media_photos` rows** that were uploaded to the WRONG
  `media_package_id`:
  - For each uploaded photo, determine its correct routine from the manifest
  - `UPDATE media_photos SET media_package_id = <correct_id> WHERE id = ...`
  - Recompute parent `photo_count`
- **Flip `status`** from 'processing' back to 'complete' for the corrected
  packages

## Safety rails
- **Never** use ffmpeg for EXIF reads (spiked DART CPU to 99% last run).
  Use PowerShell `[System.Drawing.Image]` for JPG or exiftool.
- **Never** delete the source photo before verifying the copy succeeded.
- **Always** backup state.json before rewrite (`.bak-pre-resort-<ts>`).
- **Run only** during show break or post-event. Disk I/O during live
  recording may fight OBS for disk bandwidth.
- **Renumber is destructive**: if a move is re-run, photo_042.jpg might point
  to a different file. Script must be idempotent: compute target from EXIF,
  verify state.json matches disk, bail if drift detected.

## Edge cases to handle
1. **Photos on disk not in state.json** (e.g., arrived after last state save)
   - Read EXIF from file directly, match to window, handle as normal.
2. **Unmatched photos** (EXIF outside all windows — intermission shots)
   - Leave in current location. Log in a `/tmp/unmatched.txt` report.
3. **Identical timestamps across windows** (shouldn't happen with >5s gaps)
   - First match wins (sort-by-start order).
4. **Already-uploaded photos** that need to move
   - File move is fine. R2 object stays where it was; `media_photos` row
     gets `media_package_id` updated. `storage_url` unchanged.
5. **Camera clock drift > 30 minutes**
   - Would make all photos match wrong windows. Detect via median
     `(exif - wall_time)` across sampled photos. If > 5 min, abort re-sort
     and warn operator; requires manual offset correction.

## Productization notes — in-app button flow
- Button location: Settings > Tools or a dedicated "Media Tools" panel.
- UI flow: `Preview` → shows projected final counts per routine (like the
  Python manifest preview). User confirms → `Execute` → progress bar +
  live log. On completion, dialog: "Restart app to apply. Uploads will
  retry automatically."
- Implementation:
  - Read state.json in main process (already loaded in `state.ts`).
  - Use `exifreader` (already a dep — `src/main/services/tether.ts` imports it)
    to read EXIF from any untracked photos on disk.
  - File ops via `fs.promises.copyFile` / `fs.promises.rename`.
  - State rewrite via `saveStateImmediate()` after updating in-memory arrays.
  - After success: prompt user to restart; on restart the app is clean.
  - DB sync: trigger a `POST /api/plugin/resort-reconcile` endpoint on
    CompPortal that accepts a manifest `[{photoStoragePath, correctEntryId}]`
    and updates `media_photos.media_package_id` + recomputes counts.

## This Run — Execution Log (2026-04-17)

### Pre-flight (completed before break)
- Pulled DART state.json locally → `/tmp/dart-state.json` (scp, read-only)
- savedAt: 2026-04-17T14:09:02.247Z
- 527 routines total, 45 with full recording windows
- Currently recording: #144 (stopped 1s before snapshot, photos=0)
- Upload backlog: #111 uploading, #106+#112-143 stuck in 'encoded'

### Manifest computed locally
- Source: `/tmp/dart-state.json`
- Algorithm: Python implementation of matchSinglePhoto
- Output: `/tmp/dart-resort-manifest.json`
- Summary:
  - 6958 photos stay put
  - 1240 photos need to move
  - 6 unmatched (likely intermission)
- Top sources (photos moving OUT):
  - #106 → 685 (collapses to 69)
  - #113 → 78, #115 → 71, #114 → 63, #116 → 61, #117 → 57
- Top destinations (photos moving IN):
  - #105 +177, #103 +135, #102 +129, #104 +105, #101 +80

### Projected final counts after re-sort (100-120)
| Entry | Current | -Out | +In | = Final |
|-------|---------|------|-----|---------|
| 100   | 6       | 0    | 56  | 62      |
| 101   | 2       | 2    | 80  | 80      |
| 102   | 3       | 3    | 129 | 129     |
| 103   | 2       | 2    | 135 | 135     |
| 104   | 3       | 3    | 105 | 105     |
| 105   | 1       | 1    | 177 | 177     |
| 106   | 754     | 685  | 0   | 69      |
| 107   | 158     | 36   | 22  | 144     |
| 108   | 139     | 45   | 36  | 130     |
| 109   | 130     | 26   | 45  | 149     |
| 110   | 143     | 43   | 26  | 126     |
| 111   | 149     | 20   | 43  | 172     |
| 112   | 54      | 4    | 16  | 66      |
| 113   | 335     | 78   | 0   | 257     |
| 114   | 224     | 63   | 78  | 239     |
| 115   | 192     | 71   | 63  | 184     |
| 116   | 199     | 61   | 71  | 209     |
| 117   | 344     | 57   | 61  | 348     |
| 118   | 168     | 40   | 57  | 185     |
| 119   | 203     | 0    | 40  | 243     |
| 120   | 237     | 0    | 0   | 237     |

(121-143 unchanged — forward code already correct.)

### What's NOT yet done (awaiting user go)
- Execute move manifest on DART disk
- Rewrite compsync-state.json on DART
- Restart app
- DB sync (create missing rows, update photo_count, re-associate media_photos)
- Diagnose P1 upload backlog (see upload.ts for why #106+#112-143 are stuck)
