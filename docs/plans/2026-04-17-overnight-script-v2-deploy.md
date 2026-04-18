# Overnight Script v2 — Deploy Runbook

**Time written:** 2026-04-17 ~19:30 ET
**Scheduled task fires:** 22:15 ET tonight (~2h45m runway)
**Hard rules:** SDs read-only forever. CompSync Media app stays quit. No DART writes without explicit operator OK.

---

## Artifact

**Source-of-truth (versioned):** `scripts/overnight-sd-import.py` in this repo
**Staging copy (deploy artifact):** `/tmp/overnight-sd-import-v2.py`
**SHA256:** `b6f6e56de69f6e764c5d1daa417195fbf058f76ee21c2250271210033f517089`
**Size:** 1,739 lines (+150 vs live, ~418 line-diff)

## What changed vs live (`C:\Users\User\scripts\overnight-sd-import.py`)

### Constants section
Removed phantom timezone offsets and per-photo smoothing constants.
Added marker-detection thresholds:
- `SWAP_FOLDER_JUMP_MIN = 10` — Panasonic folder-prefix jump that signals a different camera
- `RESET_GAP_MIN_SEC = 2400` / `RESET_GAP_MAX_SEC = 4800` — EXIF gap range (40-80 min) that signals an operator clock reset

### `_parse_exif_dt`
Now uses **EXIF DateTimeOriginal exclusively**. No fallback to `Image DateTime` (rewritable by editing software) or `EXIF DateTimeDigitized` (different from capture time on scans). Photos without DateTimeOriginal are skipped, not matched against a wrong timestamp.

### Phase 3 — `phase3_detect_offsets` (rewritten)
**Marker-based detection per operator spec.** No routine-window guessing.

1. Sort photos by filename (Panasonic naming = shooting order).
2. **Camera-swap start marker:** first folder-prefix jump > 10 (P176 → P224 = jump of 48; normal folder rolls step by 1).
3. **Clock-reset end marker:** within the swap-camera's continuous stream (allowing normal folder rolls), first EXIF DateTimeOriginal gap with `|gap|` in [40min, 80min].
4. **Direction:** sign of the gap. Negative gap (EXIF jumps backward ~1h) = bad clock was running fast → apply -3600s. Positive gap = bad clock was running slow → apply +3600s.
5. Apply offset to every photo from swap-start to reset-end (exclusive). All other photos: offset 0.
6. If swap detected but no reset gap found: NO correction applied, needs_review entry, operator handles manually.

### Phase 4 — `phase4_match` (rewritten)
**Strict containment.** No buffer. No nearest-routine fallback.

- Match if `window_start ≤ corrected_DateTimeOriginal ≤ window_end` for exactly one routine.
- Multiple overlapping windows: tightest fit (closest to window midpoint).
- No window contains it: photo is **unassigned** (between-routine candid, transition, pre-show, post-show). Logged for visibility but NOT a matcher failure.
- Photos lacking EXIF DateTimeOriginal: **no_capture_time**. Logged.

### Phase 8 — verify
Updated to read `photo_offset_sec` (with `cluster_offset_sec` fallback).

### Orchestrator / report
- Added `offset_swap_windows`, `offset_notes` to top-level report
- Added `match_stats` with `{exact, tightest, unassigned, no_capture_time}`
- `photos` rollup includes the new buckets; `unassigned_not_routine_photo` is a normal outcome, not a failure
- `overnight-orphans.json` still written (legacy path preserved for tooling)

### Phases UNCHANGED (good as-is)
- Phase 0 boot, lock acquisition, R2 connectivity probe
- Phase 1 SD scan + 10-file SHA256 baseline
- Phase 2 DB baseline query
- Phase 5 routine-level dedup (skips routines with photo_count > 0 — protects DB-fixed routines 100-120)
- Phase 6 upload (originals + WebP thumbs inline, HEAD-check before PUT, 8-thread concurrency, error-burst backoff)
- Phase 7 register via `/api/plugin/complete` with `photo_thumbnails`
- Phase 9 disk cleanup (only on confirmed-uploaded photos in routine folders, never on SD)
- Phase 10 SD integrity SHA256 re-hash (fails the run loud if anything changed)
- Phase 11 summary write
- All `_safe_open` / `_assert_not_sd_path` / `_safe_unlink` / `_safe_rename` SD safety wrappers

---

## Validation done locally

- `python3 -m py_compile` passes
- Synthetic test (`/tmp/test-overnight-matcher.py`) passes:
  - 100 routines, 4-min cycle
  - 250 cam1 photos (P101-P109), 250 cam2 photos (P224-P228)
  - Cam2 routines 50-64 simulated with bad clock (+1h EXIF), reset at routine 65
  - Phase 3 detects exactly 1 swap window covering 75 photos with offset -3600s, reset gap -3520s
  - Phase 4 matches all 500 routine photos to correct routines
  - Unassigned: 7 (4 pre-show + 3 between-routine candids) — these are NOT routine photos, not a failure
  - All cam2 photos correctly attributed to routines 50-99

---

## Deploy procedure (when operator says go)

These are commands FOR THE OPERATOR to run. Nothing about this gets executed without explicit go.

### 1. Verify artifact local SHA256 matches expected
```bash
sha256sum /tmp/overnight-sd-import-v2.py
# Expect: b6f6e56de69f6e764c5d1daa417195fbf058f76ee21c2250271210033f517089
```

### 2. Backup current live script on DART
```bash
ssh dart "copy C:\Users\User\scripts\overnight-sd-import.py C:\Users\User\scripts\overnight-sd-import.py.bak-pre-v2"
```

### 3. SCP to DART
```bash
scp /tmp/overnight-sd-import-v2.py dart:"C:/Users/User/scripts/overnight-sd-import.py"
```

### 4. Verify SHA256 on DART matches
```bash
ssh dart "powershell -Command \"Get-FileHash C:\Users\User\scripts\overnight-sd-import.py -Algorithm SHA256\""
# Expect: B6F6E56DE69F6E764C5D1DAA417195FBF058F76EE21C2250271210033F517089
```

### 5. Verify Python parses it on DART
```bash
ssh dart "python C:\Users\User\scripts\overnight-sd-import.py --help"
# Expect: argparse usage banner, no syntax errors
```

### 6. Confirm scheduled task is still set
```bash
ssh dart "schtasks /query /tn OvernightSDImport /v /fo LIST | findstr /i \"next run status\""
# Expect: Status = Ready, Next Run Time = today 22:15 ET
```

That's it for staging. The scheduled task will pick up the new script automatically when it fires at 22:15.

## Rollback (if anything looks wrong before fire)

```bash
ssh dart "copy C:\Users\User\scripts\overnight-sd-import.py.bak-pre-v2 C:\Users\User\scripts\overnight-sd-import.py /Y"
```

## Post-fire monitoring (after 22:15)

- Heartbeat: `C:\Users\User\logs\overnight-heartbeat.json` (updated every 60s)
- Final report: `C:\Users\User\logs\overnight-report.json`
- Orphan/unassigned dump: `C:\Users\User\logs\overnight-orphans.json`
- Stdout: `C:\Users\User\logs\overnight-stdout.log`

What success looks like in the report:
- `offset_swap_windows`: exactly 1 entry, offset -3600 or +3600, photo_count in the dozens (matching the camera-2 routines on the SDs)
- `photos.matched`: most of the day's routines filled
- `photos.unassigned_not_routine_photo`: small (between-routine candids only — not a failure mode)
- `photos.no_capture_time`: 0 ideally; any number here means EXIF was unreadable on those JPGs
- `sd_integrity_verified`: true (the 10-file SHA256 baseline still matches after the run)
