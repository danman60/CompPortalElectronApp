# Plan — Move UDC London 2026 → E:\Transfer (DART)

Status: **DRAFTED, NOT EXECUTING.** Wait for operator "run" before any move.

Drafted: 2026-04-25 10:32 EDT.

## Source state (live read)

```
Source:    C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026\
Folders:   526 routine subfolders (flat — no day grouping at filesystem level)
Files:     37,049
Size:      354.77 GB (380,928,024,787 bytes)
Last ts:   2026-04-19 16:23 EDT (last UDC London write)
```

## Destination state (live read)

```
Drive:     E: (FileSystemLabel "Transfer", Fixed, 1863 GB total / 1632.6 GB free)
Path:      E:\Transfer\
Existing:  2026-04-18-c-cleanup\, friday-recovery-sd-dumps\
Proposed:  E:\Transfer\UDC London 2026\
```

## Space delta

```
Before move:
  C:  free  80.2 GB
  E:  free  1632.6 GB

After move:
  C:  free  434.97 GB   (+354.77 GB freed)
  E:  free  1277.83 GB
```

C: pressure relief is the goal — DART has been chronically tight at <100 GB free during recording days.

## Move strategy — robocopy, NOT PowerShell Move-Item

Cross-volume `Move-Item` is internally copy+delete-each-file (no batch atomicity). If interrupted partway, we get partial source + partial dest. Robocopy with `/MOV` is identical conceptually but much faster (multi-threaded), produces a verifiable log, and supports `/MT` for parallelism.

Plan uses **`/COPY` first, verify, then delete source** rather than `/MOV` directly so we have a known-good destination before any source loss.

### Phase 1 — copy

```powershell
$src = "C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026"
$dst = "E:\Transfer\UDC London 2026"
robocopy $src $dst /E /COPY:DAT /R:2 /W:5 /MT:8 /NP /LOG:"E:\Transfer\london-move-2026-04-25.log" /TEE
```

- `/E` = empty dirs included
- `/COPY:DAT` = data + attributes + timestamps (no ACLs needed — it's a media archive)
- `/R:2 /W:5` = retry twice, 5s between (don't loop forever on a hung file)
- `/MT:8` = 8-thread parallel copy (good for spinning disks; bump to 16 for SSD if wanted)
- `/NP` = no per-file percent (less log spam)
- `/LOG` = full log on E: for audit

**Expected duration:** 354 GB at ~150 MB/s (typical SATA→SATA on this hardware) ≈ **40 minutes**. Worst case (slow disk / disk pressure) ≈ 90 minutes. Watch the log for an ETA.

### Phase 2 — verify

Compare file count + total size. Mismatch = abort, do NOT delete source.

```powershell
$srcSize  = (Get-ChildItem $src -Recurse -File | Measure-Object Length -Sum).Sum
$dstSize  = (Get-ChildItem $dst -Recurse -File | Measure-Object Length -Sum).Sum
$srcCount = (Get-ChildItem $src -Recurse -File | Measure-Object).Count
$dstCount = (Get-ChildItem $dst -Recurse -File | Measure-Object).Count
"Source: $srcCount files, $srcSize bytes"
"Dest:   $dstCount files, $dstSize bytes"
"Match:  $($srcCount -eq $dstCount -and $srcSize -eq $dstSize)"
```

Expect: `Match: True`, exact byte+count parity.

(Skipping full md5 comparison because the file count is 37k — md5'ing all of them adds 30+ minutes for limited extra confidence over byte+count parity. Robocopy already retries on read errors.)

### Phase 3 — delete source

```powershell
Remove-Item -LiteralPath $src -Recurse -Force
```

Single command; if interrupted will leave partial source but destination is already verified.

### Phase 4 — sanity

```powershell
Get-PSDrive C | Format-Table Name, @{N="Free_GB";E={[math]::Round($_.Free/1GB,1)}}
Get-PSDrive E | Format-Table Name, @{N="Free_GB";E={[math]::Round($_.Free/1GB,1)}}
Test-Path $src    # expect False
Test-Path $dst    # expect True
```

Expect: C: ≥ ~430 GB free, E: ≈ 1278 GB free, source path gone, dest path present.

## Rollback path

If something goes wrong AFTER the source delete:
- Destination has full file structure preserved (`/COPY:DAT` keeps timestamps).
- Move can be reversed with same robocopy invocation, swapping `$src` and `$dst`.

If something goes wrong BEFORE the source delete (Phase 1 or 2 fails):
- Source is intact. Destination has partial copy. Either retry (robocopy is idempotent and resumes) or remove `$dst` and start over.

## Timing — when to run

DART has CompSync v3 (with all 11 fixes) running with active Toronto recording today. Robocopy will compete with disk I/O during encode/upload bursts. Two safer windows:

1. **End of Saturday's competition** (after last routine recorded + uploaded). Disk is quiet. ~40 min run.
2. **Tonight after operator wraps** — same as option 1 but with no risk of accidentally hitting the running app.

Do NOT run during a live routine recording: encoder writes go to C:\, robocopy reads from C:\, contention could starve the recording.

**Operator-assertable: London is fully uploaded to R2 + DB and verified.** Per `CURRENT_WORK.md`: "UDC London 2026 (`6f29f048-61f2-48c2-982f-27b542f974b2`) verified clean (read-only): 531 packages, 93,889 active photos, 128 legit `photo_*` rows, 0 `_dup`, 0 NULL." So the move is a local-only archive operation; no R2 / DB / CompPortal coordination needed.

## Per-day separation — possible but needs schedule lookup

The folder structure on disk is flat by routine number (100…). UDC London ran multiple days. Single-day moves would require:
- Day → routine_number range lookup from the schedule
- A move script that picks specific routine folders

Schedule lookup is straightforward (the routines table has `scheduledDay` per entry). Not implementing for this manual run — moving the whole comp is one shot. The "for later" feature (next section) handles per-day in the app UI.

---

## "For later" — In-app backup UI feature spec (build deferred)

Operator notes: "We already have a backup option but I believe it just backs up the whole app." Looking at the app, there is a recovery / state backup mechanism. What's missing: media-archive export with structure preservation.

### Goals
- Export competition media (or one day of it) to a chosen destination, structure intact.
- Re-import a previously exported archive into a (possibly re-created) competition.
- Use case: resume uploads when CompPortal share code changed.

### Sketch

**Export flow:**
1. UI: "Export Media Archive" entry in Settings or new Tools menu.
2. Step 1 — pick scope: whole comp, or one day (radio + day picker).
3. Step 2 — pick destination: `Browse...` opens folder dialog.
4. Step 3 — preview: total size, file count, ETA, expected free space delta.
5. Confirm → robocopy with `/COPY:DAT /MT:8` to `<dest>\<comp-name>\` (or `<dest>\<comp-name>\day-<N>\` for single-day).
6. Write a small `archive-manifest.json` at the export root: comp name, comp ID, original share code, original output dir, source DART hostname, export timestamp, scope (whole/day-N), file count, byte total, optional md5 of manifest itself.
7. Progress UI follows `[Photos]` import progress conventions (current/total/stage label).

**Import flow:**
1. UI: "Import Media Archive".
2. Pick source folder. App reads `archive-manifest.json`.
3. UI shows comp name, original share code, scope.
4. Operator pastes new share code (or reuses original).
5. App verifies the share code resolves to a comp on CompPortal.
6. Per-routine reconcile pass: walk archive folders, match each to a routine in the loaded comp by entry number, populate `outputPath` / `encodedFiles` / `photos` arrays, mark status appropriately based on what files exist (if `*.mp4` present → `encoded`; if `*.mp4.uploaded` → `uploaded`; etc.).
7. Resume queue automatically picks up unfinished uploads.

### State / wire-up

- New IPC channels: `ARCHIVE_EXPORT_PREVIEW`, `ARCHIVE_EXPORT_RUN`, `ARCHIVE_EXPORT_PROGRESS`, `ARCHIVE_IMPORT_LOAD`, `ARCHIVE_IMPORT_RECONCILE`.
- New main service `services/archive.ts` (export + import + manifest read/write).
- Archive uses robocopy on Windows (already invoked from spawn elsewhere) and `cp -a` / `rsync -a` on non-Windows.
- Manifest format versioned (`schemaVersion: 1`) so future changes don't break import.

### Estimated build size

Medium feature. Probably 2-3 hours of focused work end-to-end. Defer until operator OK and post-event.

### Risk

Low — additive feature, no DB or R2 writes, no destructive ops without explicit confirm. Existing recovery / backup paths untouched.

---

## Decision log

- Drafted: 2026-04-25 10:32 EDT
- Awaiting operator: "run" instruction with chosen window (end of Saturday's comp / tonight)
- Build of "for later" feature: deferred
