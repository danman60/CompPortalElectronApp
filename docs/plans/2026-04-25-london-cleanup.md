# London Cleanup + Toronto Move

Created 2026-04-25. Both items are DART-side actions; no destructive execution
until operator gives the go.

---

## Plan A — Move UDC Toronto 2026 disk data to `D:\Transfer`

**Why:** DART has only ~100 GB free. Toronto data on local disk is redundant —
all photos are in R2 (`compsyncmedia` bucket) under per-package keys, and the
DB tracks every package/photo. Moving to `D:\Transfer` (Seagate Expansion 1.8TB
USB) frees disk for Day 2 capture/encode.

**Pre-flight verification (read-only, runs from orchestrator):**
1. DB count of Toronto active rows must equal what we're about to delete from
   disk for each routine folder. Mismatch = abort.
2. Each routine folder's Q53A* file count vs DB rows for that package — if disk
   has files NOT in DB, upload first or treat as orphans.
3. R2 listing must contain every `storage_url` referenced in DB (presigned HEAD
   on a sample is sufficient).

**Source paths on DART:**
- `C:\Users\User\OneDrive\Desktop\TesterOutput\<entry_number>_<title>_*\photos\*.JPG`
  — routine photo folders (Toronto only; London leftovers handled in Plan B).
- `C:\Users\User\OneDrive\Desktop\TesterOutput\<entry_number>_*\encoded\*.mp4`
  — encoded videos (if any remain locally; some may already be in R2 only).
- `C:\Users\User\OneDrive\Desktop\TesterOutput\_orphans\*` — unmatched-photo
  orphans. Move with the rest, but do NOT delete from R2 (they're not there
  anyway, by definition).

**Target:** `D:\Transfer\udc-toronto-2026\<entry_number>_<title>_*\` mirroring
the source structure.

**Sequence per routine (operator-initiated):**
1. App MUST be stopped or at least quiet (no in-flight import / encode for that
   routine). Ideal window: post-show.
2. `robocopy <src> <dst> *.JPG /MIR /COPY:DAT /NDL /R:3 /W:10 /MT:8` — preserves
   timestamps, multi-threaded, retry-on-fail.
3. After successful copy, compare file counts + total bytes (`Get-ChildItem |
   Measure-Object -Sum Length`) source vs dest. Equal = OK.
4. `Remove-Item <src> -Recurse -Force` only after match.
5. Log to a transfer manifest: `D:\Transfer\udc-toronto-2026\manifest.csv`
   with `entry_number,routine_title,source_size_bytes,dest_size_bytes,
   moved_at,verified`.

**Estimated free space:**
- 14,458 disk Q53A files × ~1.1 MB ≈ 16 GB
- Encoded MP4s (per routine 100-300 MB × ~210 routines) ≈ 20-60 GB
- Total likely freed: **30-70 GB**

**Safety rules during move:**
- Do NOT touch the SDs (F:\, H:\). They are the source of truth.
- Do NOT touch R2 or DB during the move (the move is disk-only).
- Do NOT touch UDC London 2026 archive folders during this move (separate plan).
- If any verification step fails, ABORT that routine's move and log; continue
  with others.

---

## Plan B — UDC London 2026 disk leftover cleanup on DART

**Why:** ~71 routine folders + 3,307 `photo_NNN.JPG` files from UDC London 2026
(2026-04-17 → 2026-04-19 weekend) are still sitting in
`C:\Users\User\OneDrive\Desktop\TesterOutput\` alongside Toronto folders.
Caused by routine-number reuse: today's Toronto routine 122 ("BOSSA NOVA BABY")
gets folder `122_BOSSA_NOVA_BABY_*\`, but yesterweek's London routine 122
("OH SO QUIET") still has its own `122_OH_SO_QUIET_*\` folder beside it.
These London folders take ~30+ GB and are stale.

**Read-only audit (just run from orchestrator):**

DB UDC London 2026 (`6f29f048-61f2-48c2-982f-27b542f974b2`) is intact and clean:
- 531 active packages
- 93,889 active photos (intact — DO NOT touch DB or R2 for London)
- 128 `photo_*` filenames in DB (genuine London uploads from old-code era;
  matched + uploaded successfully — leave them alone)
- 0 `_dup`-named, 0 NULL EXIF

So **Plan B touches LOCAL DISK ONLY on DART**. It does not change R2 or DB for
either comp.

**Source paths on DART (London leftovers):**
- `C:\Users\User\OneDrive\Desktop\TesterOutput\UDC London 2026\` — explicit
  London folder, ~29,498 JPGs in archive subfolders. **Do NOT delete this entire
  tree** until operator confirms the data is also safe in R2 (it should be:
  93,889 in DB suggests yes, but confirm with a per-package R2 spot-check).
- The ~71 leftover routine folders mixed in alongside Toronto folders that have
  London routine titles. Identify by listing `TesterOutput\<dir>` and checking
  `<dir>\photos\*.JPG` mtime — files dated 2026-04-17/18/19 are London leftovers.

**Cleanup sequence (operator-initiated, after Plan A's Toronto move):**
1. List every immediate-child folder of `TesterOutput\` whose photos `*.JPG`
   files have mtime 2026-04-17 → 2026-04-19 EDT (London weekend) OR whose name
   matches a London routine title pattern (cross-ref via DB if needed).
2. For each candidate, **verify ALL photos are in DB** for the corresponding
   London package_id. Skip any folder where local disk has photos NOT in DB
   (those are unrecovered London originals — preserve them).
3. Move verified folders to `D:\Transfer\udc-london-2026-leftovers\` (or delete
   if explicitly OK'd by operator). Same robocopy pattern as Plan A.
4. Same with `TesterOutput\UDC London 2026\` archive tree — bulk move to
   transfer drive (size-permitting) or delete after R2 cross-check.

**Estimated free space:**
- 29,498 archive JPGs × ~1.1 MB ≈ 32 GB
- ~71 leftover folders' photos (3,307 photo_NNN + various) ≈ 5-10 GB
- Total likely freed: **35-45 GB**

---

## Audit done now (2026-04-25 ~08:08 EDT, read-only — no DART touched)

- UDC Toronto 2026 (`a0adef31-177b-4dd6-8b63-7ff59fff0196`): 14,383 active
  rows, 0 NULL EXIF, 0 `_dup`-named. Source of truth for Plan A pre-flight
  step 1.
- UDC London 2026 (`6f29f048-61f2-48c2-982f-27b542f974b2`): 531 packages,
  93,889 active photos, 128 `photo_*` rows (genuine), 0 NULL EXIF, 0 `_dup`.
  All R2 keys live in `compsyncmedia` bucket. **DB clean, no work needed
  there.**
- EMPWR Dance - London (`79cef00c-e163-449c-9f3c-d021fbb4d672`): 0 active
  packages / photos. Already empty in DB; no cleanup needed.

---

## What's NOT in this plan

- Anything that touches the SD cards (F:\ or H:\) — operator-only.
- Any DB / R2 cleanup for London — already verified clean and intact.
- Any cleanup mid-show — Day 2 is live; wait for safe window.
