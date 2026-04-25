# Incident: Photo Re-Import Duplication (UDC Toronto Day 1)

**Date:** 2026-04-24
**Detected:** 23:10 EDT (heartbeat showed 27,800-job pending queue against ~15k expected photos)
**Resolved (cleanup):** 2026-04-24 23:50 EDT
**Code fix shipped:** v15.8 (asar md5 `1a132f7ec564d5f932a3ff196d4f51b8`)

## Impact

- 9,094 duplicate `_dupN`-named rows in `media_photos` (Toronto comp, R2 keys + thumbnails)
- 4,920 cross-routine duplicate plain-named rows (same camera filename in 2+ routines)
- 43,022 duplicate `_dup`-named JPGs on DART local disk (35.08 GB)
- 27,360 stale pending upload jobs queued for re-upload of files already in R2
- Operator backlog estimate ballooned from real ~15k photos shot to apparent 27k pending — wall-clock anxiety + ~13h spurious drain ETA

## Root cause (chain of three failures)

**1. `_dupN` filename collision strategy was wrong.**
`photos.ts:1605` (and two sibling paths) used `_dup{N}` suffixes whenever a file with the destination basename already existed in a routine's photos folder. The intent was "two SDs / two cameras producing same Lumix counter". With one camera body per show day, every `_dupN` was a re-import of an already-imported file. SD reinsertions / app restarts compounded the problem: `Q53A0001.JPG` → `_dup1` → `_dup2` → `_dup3` across sessions.

**2. v15.7's pre-dedup didn't catch dup-suffixed state.**
Filename pre-dedup (added in v15.7) built the seen-set from `routine.photos[].sourcePath/filePath`. After prior collisions, those entries already had `_dupN` suffixes. The SD's plain `Q53A0001.JPG` did not match the state's `Q53A0001_dup3.JPG`, so the dedup let the file through and a fresh `_dup4` was created.

**3. Auto-import gating compounded re-runs.**
Earlier directive (2026-04-19) silenced boot-mounted SDs to avoid mistaken yesterday-card imports. v15.6 reversed that with operator approval, but the safeguard was a today-only EXIF pre-check + dedupByDb. The dedupByDb flag was both gated and (per #2) didn't strip `_dupN`, so each restart fired a fresh re-import of the same SD.

## What was cleaned up

| Surface | Before | Removed | After |
|---|---|---|---|
| Disk `_dup*.JPG` files (TesterOutput + London archive) | 43,022 | 43,022 | 0 |
| Toronto `media_photos` rows (`_dup` filenames) | 9,094 | 9,094 (soft-delete) | 0 |
| Toronto `media_photos` rows (cross-routine plain dups) | 4,920 | 4,920 (soft-delete) | 0 |
| R2 objects in `compsyncmedia` (Toronto `_dup` photos + thumbs) | 18,188 | 18,188 | 0 |
| R2 objects (Toronto cross-routine excess photos + thumbs) | 9,840 | 9,840 | 0 |
| Pending upload + photo-import jobs in queue | 27,360 | 27,360 | 0 |

**Disk Q53A* files (Toronto only):** 14,458 (matches SDs at 14,243 within multi-routine residue)
**SD card content (read-only, untouched):** F:\ 7,417 + H:\ 6,826 = 14,243 photos
**Toronto `media_photos` active rows:** 7,469 (one per unique camera filename)
**Photos still to upload to bring DB → SD parity:** ~6,774 (will be picked up by v15.8 auto-import + reconciler on next launch)

## Code fixes shipped in v15.8

(Build verifiable: md5 `1a132f7ec564d5f932a3ff196d4f51b8`; SCP'd to DART; live on disk.)

1. **SKIP-on-collision** (`photos.ts:1604-1614`, plus two sibling sites for orphan dest and orphan reassign). When the destination basename already exists in the routine's photos folder, skip the copy + enqueue. No more `_dupN` files are written, ever. The SD retains the original.
2. **Always-on, dup-suffix-aware filename pre-dedup** (`photos.ts:1075-1110`). Strips `/_dup\d+/` from both the seen-set basenames (built from every routine's `photos[].sourcePath` and `.filePath`) and the SD's incoming basename before comparison. A photo previously imported as `Q53A0001_dup3.JPG` now matches an SD's plain `Q53A0001.JPG` and skips. No longer gated by `opts.dedupByDb`.
3. **Boot-time upload-worker wake** (`index.ts`, retained from v15.4). After `autoResumeUnfinished()`, if `jobQueue.getPending('upload').length > 0`, calls `uploadService.startUploads()`. Prevents the dormant-worker-after-restart case.
4. **Dynamic-import for mediaReconciler** (`upload.ts`, `driveMonitor.ts`, retained from v15.6). All `require('./mediaReconciler')` sites converted to `import('./mediaReconciler')` so the bundler emits the chunk and the asar resolver finds it at runtime. Previously caused `Cannot find module` on boot.
5. **Boot-mounted SD auto-import** (`driveMonitor.ts:679-710`, retained from v15.6). `knownDrives` no longer primed at startup, so already-mounted SDs at app launch fire `DRIVE_DETECTED` and trigger import. Today-only EXIF pre-check + `dedupByDb` + the new pre-dedup gate prevent wrong-day or already-imported runs.

## What did NOT change

- SD cards (F:\ and H:\) — read-only access only, never modified.
- UDC London archive folders (`TesterOutput\UDC London 2026\...`) — only `_dup` files were swept (those exist independently of London originals; the canonical London originals remain).
- Recording / encode / overlay subsystems.
- DB rows for `competition_id` other than UDC Toronto 2026 — strictly scoped.

## Next-launch expected behavior

When the operator launches the app in the morning:
1. Boot recovery runs (autoResume, retry orphaned, retry skipped, mediaReconciler `scope: 'boot'`).
2. Reconciler detects DB has fewer photos than state knows about → marks `uploaded: false` on the 14,014 photos whose DB rows we soft-deleted → enqueues uploads. Those uploads will land at *correct* per-routine R2 keys (one per unique camera filename now that DB has been deduped).
3. Boot-wake fires `startUploads()` → worker drains the freshly-rebuilt queue.
4. `driveMonitor` poll picks up boot-mounted SDs → auto-import.
5. Pre-dedup (always-on, `_dupN`-aware) checks every SD basename against state's seen-set. Photos already imported (regardless of dup suffix in state) skip. Truly-new photos pass through.
6. New photos copied into routine folders. SKIP-on-collision blocks any second-write of an existing basename.
7. Uploads stream to R2, plugin/complete writes DB rows.

Target end-state: `media_photos` (active) ≈ disk Q53A unique ≈ SD photo count ≈ 14,243 photos for UDC Toronto Day 1.

## Open follow-ups (not addressed tonight)

- Multi-routine matcher behavior: confirmed today that the **matcher itself produces one `matchedRoutineId` per photo** (`photos.ts:625`, `workers/matcher.ts:277`). The cross-routine duplicates we cleaned up came from sequential imports across sessions making *different* routine choices for the same source file — not from one matcher pass producing two matches. v15.8's always-on pre-dedup (item 2 above) prevents the same source from being re-matched after first import, which closes that loop. If future drift is observed, a `Set<sourceHash>` guard inside the per-import `for (const match of matches)` loop would be belt-and-suspenders.
- Recovery-time scheduling: `competition_entries.scheduled_start_time` was NULL for all 209 Toronto entries, so a "match dups by closest-scheduled-routine" cleanup couldn't run. Cross-routine cleanup fell back to "keep MIN(created_at) row" — deterministic but not necessarily semantically-correct routine. The reconciler's full re-match on next launch should resolve genuine misplacements when it sees the actual recording windows from local state.
- A persistent **work-status indicator** in the app header (Item #3 on the day-2 fix list) was deferred pending operator decisions on placement / behavior.
