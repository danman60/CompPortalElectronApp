# Friday 2026-04-17 Photo Recovery — Known Truths

**Last updated:** 2026-04-18 17:17 EDT
**Source:** Direct operator confirmation + SD dump scan verification.
**READ THIS FIRST. Do not re-derive any of these. Future sessions must work from this doc.**

---

## CAMERAS (operator-confirmed 2026-04-18)

- **CAMERA 1 ("OLD" camera):** filename prefix `P10XXXXX.JPG` (folders 101–110).
  - Clock correct EDT throughout the day.
  - Real UTC = raw EXIF + 4h.
  - Shot morning routines. P1011953.JPG = first real photo (R100). P1011878–P1011942 is pre-event warmup (Thu Apr 16 afternoon → Fri morning).

- **CAMERA 2 ("NEW" / "SECOND" camera):** filename prefixes `P16XXXXX`, `P17XXXXX`, `P18XXXXX` (folders 166–189).
  - P1667001 = first photo on this camera.
  - Clock was **~1h BEHIND real time** until manually reset.
  - **Reset moment confirmed in data**: consecutive files `P1687291.JPG` (raw 10:51:12) → `P1687292.JPG` (raw 11:50:57) — +59m45s forward jump between adjacent sequence numbers.
  - Reset happened at real EDT ~12:50–12:55 (per operator memory) during/around R188.

## OFFSET MATH (match-v6 rules — DO NOT CHANGE without operator approval)

Classify by **raw EXIF value**, not by folder or sort order (SDs were swapped mid-day):

| Camera | Condition | Offset to real UTC |
|---|---|---|
| Cam 1 (P10…) | any | raw + 4h |
| Cam 2 (P16/P17/P18…) | raw EXIF ≤ 2026-04-17 10:51:12 | raw + **5h** (pre-reset, clock 1h behind) |
| Cam 2 (P16/P17/P18…) | raw EXIF ≥ 2026-04-17 11:50:57 | raw + 4h (post-reset, EDT correct) |
| Folder 224 / F:224 | any | IGNORE (Camera 2 irrelevant data, EXIF Apr 2–3) |

There are zero photos in the ~1h reset gap. The gap is the discontinuity marker.

## SD CARDS

- Both cards (F:/SD-A-20260418-1508 and H:/SD-B-20260418-1525) held photos from BOTH cameras at different times. Cards were swapped mid-day.
- DO NOT use (SD, folder) as a camera identifier. USE RAW EXIF or filename prefix.
- Contents copied to ASTEROID `D:\Transfer\friday-recovery-sd-dumps\SD-A-20260418-1508\` and `SD-B-20260418-1525\`.
- **Full EXIF scan** (30,905 photos, one JSONL line per photo with path/filename/sd_label/folder/raw_exif/file_size):
  - `/tmp/fri-recovery/full-exif-scan.jsonl`
  - `/home/danman60/compsync-friday-recovery/full-exif-scan-2026-04-18.jsonl` (durable)
  - ASTEROID `D:\Transfer\friday-recovery-sd-dumps\full-exif-scan-20260418T161858.jsonl` (durable)
- **DO NOT re-run the scan.** Future sessions must reuse these files.

## ROUTINE WINDOWS

Primary source: `media_packages.video_start_timestamp` / `video_end_timestamp` in DB (correctly UTC).
Fresh DB snapshot: `/tmp/fri-recovery/db-snapshot-2026-04-18T162300.json`.

**Window overrides needed for re-record / missing-window cases:**

| Routine | Title | Override | Source |
|---|---|---|---|
| R100 | WHAT IS THIS FEELING | 12:01:20–12:04:40 UTC | Archived MKV mtime on DART `_archive/v1/` (372 MB full-length take) |
| R244 | BEETLEJUICE | 20:49:23–20:51:50 UTC | Photo cluster confirmed by operator 2026-04-18 17:13 EDT (P1798987–P1799103, 117 photos) — R244 has NO `media_packages` row in DB |
| R280 | DON'T FAIL ME NOW | 23:42:26–23:45:50 UTC | Archived MKV mtime on DART `_archive/v1/` (380 MB full-length take) |

**Still unresolved:**
- R291 (YOU DON'T OWN ME) — DB has 11-second window only (bad take). No `_archive/vN/` MKV on DART. Real performance window unknown to us. **DO NOT speculate on photo clusters** — wait for operator to provide the real window.

## MATCH-V6 RESULTS

**29,895 / 30,905 photos matched (96.7%), plus 117 for R244 via window override = 30,012 matched.**

Output files:
- `/tmp/fri-recovery/match-v6.json` (one entry per photo with routine assignment)
- `/tmp/fri-recovery/match-v6-summary.md` (per-routine counts)
- Durable copies should be written to `/home/danman60/compsync-friday-recovery/` before operator leaves for the night.

**Per-routine coverage:**
- 207 of 208 Friday routines have matched photos ready for upload.
- Only R291 still zero (window problem, not a match problem).

**1,010 unmatched breakdown (from match-v6-summary.md):**
| Range | Count | Cause |
|---|---:|---|
| SD-B fol 101 P1011878–P1011942 | 65 | Pre-event warmup (Thu+Fri dawn) |
| SD-A fol 169 P1697905–P1697907 | 3 | Between-routine straggler |
| SD-A fol 171 P1717001–P1717006 | 6 | Between-routine (post-lunch session start) |
| SD-A fol 184 P1844174–P1844176 | 3 | Between-routine (R279→R280 area) |
| SD-B fol 179 P1798987–P1799103 | 117 | Was zero in match-v6, but operator identified as **R244 BEETLEJUICE** — now matched via override |
| SD-B fol 189 P1898604–P1899419 | 816 | **Saturday photos**, wrong day, out of scope |

After R244 override, "true" Friday unmatched = 65 (warmup) + 12 (between-routine) = 77 photos that shouldn't match any routine, which is correct.

## UPLOAD PIPELINE

Script: `/home/danman60/projects/CompSyncElectronApp/scripts/upload-friday-manifest.py`.
**Open questions before first real run (still unanswered by operator):**
1. Target host for `--source-root` (ASTEROID vs FIRMAMENT mount)
2. Env file location for R2 + Supabase service key
3. Storage-path shape (flat vs runId-nested)
4. `media_packages.photo_count` column — trigger updates, or add explicit UPDATE?
5. Missing `media_packages` rows (e.g. R244): OK to CREATE with status='complete'?
6. `sort_order`: hardcoded 0 vs per-routine monotonic by captured_at

## HARD RULES FOR FUTURE SESSIONS

1. **Primary sources first.** Live DB query + SD-dump `ls` + file on disk. Derived artifacts (`match-v*.json`, `db-photos.json`) are starting hypotheses, not authority.
2. **Never speculate on "where photos might be" for unmatched routines.** Wait for operator to identify. R244 was identified by operator telling us "P1798987 is BEETLEJUICE R244"; do not offer to search for similar clusters for other routines.
3. **Reuse durable artifacts.** Full EXIF scan lives at 3 locations listed above — do NOT re-run the scan (30k photos ~22 min).
4. **Latest recording is authoritative.** If a routine has an `_archive/vN/` MKV that's full-length and a "current" MKV that's short (re-record case), use the LATEST unless operator indicates the archive is the real take.
5. **Camera identity = filename prefix.** P10 = Cam 1, P16+/P17+/P18+ = Cam 2. NOT folder number alone (cards were swapped). NOT SD label (same reason).
6. **EXIF `DateTimeOriginal` is authoritative capture time.** Confirmed 2026-04-18 at 16:54 EDT via direct EXIF tag read (tag 36867), not transfer time (tag 306).
