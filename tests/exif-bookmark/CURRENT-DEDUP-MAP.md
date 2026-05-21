# CURRENT-DEDUP-MAP — photo import dedup / EXIF / hash path

Mapped 2026-05-16 (Eastern). Source-level only (GitNexus MCP down). Read end-to-end
before the per-subfolder pre-read filename bookmark was added. This documents the
state of the path the new FAIL-SAFE layer sits IN FRONT OF.

## Entry points

- `importPhotos(folderPath, routines, outputDir, opts)` — `photos.ts:940`. FIFO
  queue (`importQueue` :918) serializes concurrent SD inserts. Calls `runImport`.
- `runImport(folderPath, routines, outputDir, signal, opts)` — `photos.ts:1002`.
  The whole scan/dedup/match/copy pipeline.

`ImportPhotosOptions` (:920):
- `previewOnly` — dry-run; no copies, no watermark/cursor advance, no enqueue.
- `filenameAllowlist` — positive include set (scoped backfill). Per the doc
  comment (:924-926) it ALSO bypasses the SD watermark filter for included
  files. **This is the existing "bypass watermark for specific frames" path.**
- `dedupByDb` — negative exclude by basename already in CompPortal DB per routine.
- `autoAbortOffsetMs` — abort if detected clock offset exceeds threshold.

## Directory enumeration

`scanDir(rootDir)` — `photos.ts:1034-1058`. Iterative stack walk
(`pendingDirs`), recurses into EVERY subdirectory, collects every `*.jpg/.jpeg`.
Yields to event loop every 25 dirs. **Every DCIM subfolder is walked** — there
is no folder-level skip anywhere today.

## Partitioning (multi-SD / multi-camera namespace safety)

`photos.ts:1077-1106`. Photos grouped into `byDrive` keyed
`{driveRoot}::{dcimFolder}`:
- `driveRoot` = `path.parse(fp).root` (Windows `F:`) upper-cased; POSIX falls
  back to first path segment.
- `dcimFolder` = `getDcimFolderKey(fp)` (:338-347) — last path segment matching
  `^\d{3}_?` (e.g. `129EOSR6`, `166_PANA`), upper-cased; `''` if none.
- Composite key prevents filename-collision merge when two SDs share a drive
  letter OR two SDs both expose `166_PANA` (UDC London 2026-04-18 incident).
`partitionedPathsRaw` = concatenation of every partition's file list, scan order
preserved within a partition.

## Allowlist gate (existing scoped-import filter)

`photos.ts:1112-1129`. If `opts.filenameAllowlist` set, only basenames in the
(upper-cased) allowlist survive into `partitionedPaths`. This is the existing
scoped recovery/backfill path.

## DEDUP GUARANTEE #1 — per-volume EXIF cursor (build9o Item #2, the primary import-side gate)

The sole import-side dedup authority today. `photos.ts:1131-1215` + applied at
`:1417-1425` + advanced at `:2188-2213`.

- Per drive partition, `getVolumeInfo(driveRoot)` (`utils/volumeSerial.ts:40`)
  runs `vol <letter>:` (Windows only) → `{serial, label}`. Non-Windows / parse
  fail / drive missing → `serial=''`.
- `cursorByDrive: Map<driveKey, {serial, cursorIso, label}>`:
  - `serial===''` → entry `{serial:'',cursorIso:'',label:''}` → **no skip** (legacy
    short-circuit, safe: at worst re-import on dev).
  - existing `state.getSdCardCursor(serial)` → `cursorIso = existing.lastCaptureTime`.
  - else if `migrationSafetyMaxIso` (max `routine.photos[].captureTime` across the
    loaded comp, computed once :1021-1031) → **seed** the cursor at that ISO
    (`seededFromRoutines:true`) so first post-upgrade re-insert of an old card
    doesn't trigger a re-import wave.
  - else (brand-new card, empty comp) → `cursorIso=''`, emit `drive.unknownCard`.
- Applied in the EXIF read loop (:1393-1425): EXIF read FIRST
  (`getPhotoCaptureTime` or worker), then
  `if (captureTime && _vcEntry && _vcEntry.cursorIso && captureTime.toISOString() <= _vcEntry.cursorIso) { skippedDupes++; continue }`.
  - **Skip is `<=` against `.toISOString()` (UTC).** Cursor stored as
    `photo.captureTime.toISOString()` (:2198/2205) — both sides UTC, internally
    consistent (see TZ note below).
  - Empty `cursorIso` → never skips (`&& _vcEntry.cursorIso` short-circuits).
- Advance (`:2188-2213`, `!previewOnly` only): per volume serial, max
  `photo.captureTime.toISOString()` across imported photos →
  `state.setSdCardCursor(serial, {lastCaptureTime, volumeLabel})`.
  `setSdCardCursor` (`state.ts:1534-1555`) only advances forward (refuses if
  `existing.lastCaptureTime > new`) — never rolls a watermark backward (immune
  to out-of-order recovery).

## DEDUP GUARANTEE #2 — DB dedup by basename (`opts.dedupByDb`)

`photos.ts:1760-1801` (pre-fetch) + `:1845-1851` (copy-loop exclude). On
auto-import, `uploadService.fetchExistingFilenames(routineIds)` pulls existing
basenames per matched routine from CompPortal. In the copy loop, if the matched
routine already has the basename, skip copy+enqueue. Endpoint unreachable →
empty map → no-op (degrade to "import anyway"; upload-side sourceHash is the
second line of defense). **Active even for unknown cards** (independent of
volume cursor).

## DEDUP GUARANTEE #3 — 5-min / 30s offset match gate

Photo→routine binding (`:1819-1834`, also `:1771-1777`): a photo matches a
routine window only if `captureTime + clockOffsetMs` is within
`[recordingStarted - 30000, recordingStopped + 30000]`. Per-camera-body offset
detection (`detectClockOffset` family :485-659, `resolveDetectForBody`) with
operator confirmation for large offsets. Unmatched photos are NOT copied.
(The "5min" in master refers to inter-routine gap heuristics in offset scoring;
the hard window tolerance applied at copy/dedup time is ±30s.)

## DEDUP GUARANTEE #4 — migration safety net seed

`migrationSafetyMaxIso` (:1021-1031) = max `routine.photos[].captureTime` across
the loaded comp. Seeds a brand-new-to-this-app card's cursor so an old card
re-inserted post-upgrade doesn't re-import everything already in the comp. Only
applies when there is NO existing `state.sdCardCursors` entry for the serial.

## DEDUP GUARANTEE #5 — per-body SD watermark (clock-sampler aid, NOT a dedup gate)

`maxCaptureByBody` (:1333) accumulated per `getCameraBodyKey` (:302) during the
EXIF loop, bulk-written via `state.setSdWatermarksBulk` (:2184-2186). Per
comments (:1458-1466) this is NO LONGER a dedup gate — it exists so
`driveMonitor`'s clock-sampler avoids sampling pre-imported files for the
"N-days-off" check. `skippedByWatermark` stays 0 in the loop (body watermark
skip removed by build9o; variable kept for log-parser compat — `:1212-1215`,
`:1504-1508`). `state.getSdWatermark` is also read (:1262) only for the
"Resuming from HH:MM" chip wording (`watermarkResume` :1251-1273) — purely
cosmetic, never gates a skip.

## DEDUP GUARANTEE #6 — Bug F cross-day pollution guard

`checkSourceDateMatchesToday` (:102-) samples ≤20 EXIF dates; if dominant date
≠ today, operator confirm/skip/cancel dialog (:1301-1315). Plus always-on
per-photo strict-today filter (`skipMismatchedDates` :1316-1323, gated by
`behavior.includePriorDayPhotos`). Drops photos whose EXIF date ≠ today
(`:1467-1472`).

## DEDUP GUARANTEE #7 — upload-side importManifest sourceHash

Synthetic `sourceHash = vol:SERIAL:BASENAME:ISO` (or `path:...` fallback)
(:1426-1435). No content read. Upload-side `importManifest`
markUploaded()/getUploadedHashes() keys on this so a re-enqueue of an
already-uploaded file is idempotent at the upload layer (second line of
defense behind the import-side cursor).

## CONTENT-HASH STATUS

No sha1 / createHash / crypto in photos.ts (`grep` confirmed). build9o Item #2
fully replaced `sha1(first 128KB)` with the volume cursor. The only `128*1024`
is `getPhotoCaptureTime`'s EXIF-header read (`:421-424`) — reads first 128KB to
let `ExifReader` parse `DateTimeOriginal`; NOT a hash. `seenHashes` /
`seenBasenames` retired (comment :1017).

## state.ts persistence

- `SdCardCursorEntry` (`state.ts:90-99`): `volumeSerial`, `volumeLabel?`,
  `lastCaptureTime` (ISO of latest EXIF DateTimeOriginal imported, stored as
  `.toISOString()` = UTC), `setAt`, `seededFromRoutines?`.
- `sdCardCursors: Record<serialUpper, SdCardCursorEntry>` (:108).
  `getSdCardCursor` (:1521), `setSdCardCursor` (:1534, forward-only),
  `clearSdCardCursor` (:1561), `clearAllSdCardCursors` (:1575).
- `SdWatermarkEntry` (:55-65): `lastCaptureTime`, `lastFilename?`,
  `lastFilenameSeq?`, `setAt`. `getSdWatermark`/`setSdWatermark`/
  `setSdWatermarksBulk` (:1422-1481).
- Persisted in `PersistedState` (:67-84): `sdWatermarks`, `sdCardCursors`,
  `reportedCameraPrefixes`, `takes`. Atomic write tmp→rename + rolling backup
  (`doSave` :161-201). Hydrated on load (`applyLoadedState` :229-247) — cursors
  and watermarks do NOT expire on day boundary (camera offsets do).

## utils/volumeSerial

`getVolumeInfo(driveRoot)` (:40-59): Windows-only `vol F:` parse, session
cache. `serial`/`label` empty on any failure. `getVolumeSerial` convenience.
`clearVolumeCache` test-only.

## TZ / UTC BASIS (critical for the new layer)

- `getPhotoCaptureTime` (:418-438) → `parseExifLocalDate` (`exifTz.ts:36`)
  parses `"YYYY:MM:DD HH:MM:SS"` as **naive operator-machine-local** (no Z, no
  offset). Returns a JS `Date`.
- Existing cursor compare (:1422) and cursor advance (:2198/2205) BOTH use
  `captureTime.toISOString()` → that naive-local Date rendered in **UTC**.
  Both sides of the existing gate are the same `.toISOString()` projection of a
  Date built from naive-local components, so the existing cursor is internally
  TZ-consistent (compares like-for-like). The ISO string is shifted by the
  operator-machine offset vs wall-clock, but consistently on both sides, so the
  gate is correct as long as the machine TZ is stable across imports.
- **Implication for the new layer:** the FILENAME watermark is timezone-immune
  (string compare of monotonic camera names — no time involved) → it is the
  primary pre-skip gate. The capture-time BACKSTOP I store alongside it MUST be
  the SAME `.toISOString()` projection the existing cursor uses, so the new
  backstop and the existing cursor are the same basis. No TZ normalization
  migration is required for the path as it stands, because the existing cursor
  was already written with `.toISOString()` of a naive-local Date. A defensive,
  idempotent guard is still added (documented in the implementation) so that if
  a cursor was ever externally written with a different basis, the filename
  watermark + existing cursor still gate correctly and the failure direction is
  "read more," never "skip new."

## EVERY GUARANTEE THE NEW LAYER MUST KEEP WORKING (checklist)

1. Per-volume EXIF cursor skip (`<=` cursorIso) — UNCHANGED; new layer runs in
   front, never replaces it.
2. Empty serial / non-Windows / vol-cmd fail → no pre-skip at all (legacy path).
3. Migration safety-net seed from `routine.photos[]` max captureTime.
4. DB dedup by basename (`dedupByDb`) — UNCHANGED, downstream of read set.
5. ±30s window match gate — UNCHANGED, downstream.
6. Bug F cross-day guard + strict-today filter — UNCHANGED, downstream.
7. Upload-side importManifest sourceHash — UNCHANGED.
8. Per-body watermark for the clock-sampler — UNCHANGED.
9. `filenameAllowlist` bypass-watermark path — new pre-skip MUST also be bypassed
   when allowlist set (existing "bypass for specific frames").
10. `previewOnly` — no watermark/cursor writes; new filename watermark also must
    NOT be written under previewOnly.
11. Forward-only watermark advance (never roll back) — mirror for the new
    filename watermark.
12. FIFO import queue serialization — UNCHANGED.
13. Multi-SD `{drive}::{dcim}` partition keying — the new watermark is keyed by
    `(volumeSerial, dcimSubfolder)`, consistent with this partition model.

## RESIDUAL BEHAVIOR — out-of-band backfill (documented, accepted, bounded)

The pre-skip drops the contiguous filename prefix strictly below
`(bookmark − BOUNDARY_REREAD_BAND)`. Files INSIDE the band (the BAND entries
immediately before the bookmark, by sort position, + the bookmark itself +
everything after) are ALWAYS read regardless of name. Scenario (c) (task
spec): an out-of-order/backfilled file *within the boundary band* — these are
read + imported (proven by the harness: `backfillAllOpened` /
`backfillAllImported`).

A backfilled file whose name sorts BELOW the band (i.e. a file that not only
is out-of-order but lands far below the last-imported name) WOULD be
pre-skipped unread. This is the documented, accepted boundary of the
optimization and is consistent with the invariant: the invariant permits
skipping the "clearly-old contiguous filename prefix." A file whose camera
sequence number is far below the last imported one is, under the monotonic-
camera-sequence model that the whole feature rests on, genuinely old. The
only way a *new* photo gets such a name is a sequence wrap / reset — which is
the ROLLOVER case, detected separately (`maxName ≤ bookmark` → full read, no
skip). For a single far-below backfill that is NOT a wrap (the entire batch's
max name is still above the bookmark, only one file is anomalously low), the
EXIF cursor cannot rescue it because the pre-skip happens before EXIF read.
This is the one residual the band size bounds: a larger BAND widens the
always-read window. Default BAND=5. The failure is contained to a
single-file, far-below-watermark, non-wrap backfill — not a contiguous run,
not a wrap, not a normal recent backfill (which lands near the end, in-band).
Unknown cards / no-serial / previewOnly / allowlist are never pre-skipped at
all, so the residual cannot occur there. If the operator ever needs to force
a full re-scan of a card (suspected anomalous backfill), the existing
`filenameAllowlist` bypass path or clearing the bookmark
(`state.clearSdFilenameBookmark`) both disable the pre-skip — the EXIF cursor
+ DB dedup still prevent re-import of anything already imported.

## PROOF RESULTS (2026-05-17, full orchestrator, exit 0)

Number-first, from `tests/exif-bookmark/results/` (primary source = instrumented
real fs.open/fs.copyFile + the import's emitted events):

```
RUN A (unpatched)      verdict exit 0  — all 81 serial files opened, 0 new dropped
RUN B (patched)        verdict exit 0  — pre-skip active, 67 opens, 0 new dropped
RUN B-TZ (patched +5h) verdict exit 0  — TZ-skewed cursor, 0 new dropped
GATING new-photos-dropped:  A=0  B=0  B-TZ=0          (the data-loss invariant)
SPEED serial-card opens:    A=81  B=67                (B<A — pre-skip elided 14 EXIF reads)
SAME NEW-PHOTO SET imported: A=71  B=71  B-TZ=71      (identical across all variants)
backfill in-band P12901013Z.JPG: opened=true imported=true (scenario c — NOT lost)
129EOSR6 expSkip=10 skippedButOpened=0 ; 130EOSR6 expSkip=4 skippedButOpened=0
140EOSR6 rollover → full read, 20/20 new imported
150EOSR6 unknown card → no pre-skip, 15/15 new imported, all opened
exif.summary scanned=47 accepted=47 skippedWrongDate=0 (patched; existing cursor still ran)
```

THE GATING ASSERTION (count of genuinely-new photos that failed to import == 0)
holds in every scenario including the TZ-skewed-cursor variant. Total copies
differ A=61 vs B=47 by design — B correctly elides re-importing the 14
already-old files below the bookmark (the optimization working); the
genuinely-NEW set (71) is imported identically in A, B, and B-TZ.

## HARNESS FIDELITY NOTES (for the next session)

- The harness drives the REAL `importPhotos`/`runImport` (esbuild-bundled
  photos.ts + state.ts). Only `electron`, `../utils/volumeSerial` (the
  Windows `vol F:` cmd — unavailable on Linux; shim returns a per-card serial
  via a one-card-at-a-time active-card signal, faithfully mirroring "one card
  in the reader"), and `./recording` (renderer IPC push) are aliased. EXIF
  read, the EXIF cursor, DB-dedup, ±30s window match, the strict-today Bug F
  guard, and the new pre-skip are all REAL.
- Fixture photos MUST carry the REAL current local date — photos.ts's
  always-on strict-today filter drops any photo whose EXIF date != today.
  `make-fixture.mjs` now stamps `new Date()` (was hardcoded; a session that
  crossed local midnight turned a green run red because every photo became
  "yesterday"). This is the filter working correctly — the fixture works
  WITH it.
- The harness hard-exits (`process.exit(0)`) after writing its verdict JSON.
  The REAL `state.saveState()` the import calls schedules a *referenced*
  500ms debounce `setTimeout`; without the explicit exit the harness process
  hangs indefinitely after `main()` resolves (confirmed via a SIGUSR2 node
  report: sole active libuv handle = that timer, no JS stack). The state
  file is already durably written by `saveState()`'s leading-edge `doSave()`,
  so exiting is equivalent to the app's `saveStateImmediate()` on quit.

## WHERE THE NEW LAYER PLUGS IN

After `partitionedPaths` is built (post-allowlist, :1129) and after
`cursorByDrive` is populated (:1206), BEFORE the EXIF read loop (:1393). For
each `{drive}::{dcim}` partition with a known volume serial, look up the new
per-(serial,subfolder) filename watermark, sort that partition's basenames,
and drop ONLY the contiguous prefix strictly below `(watermark - boundary
band)` — keeping the watermark file + N-after always read. Everything kept
flows into the UNCHANGED EXIF loop / cursor / DB-dedup / window gate. Skipped
files are removed from `partitionedPaths` so they never reach EXIF. The new
filename watermark is advanced post-import (next to the existing cursor
advance, same `!previewOnly` guard).
