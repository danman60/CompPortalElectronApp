# UDC Toronto 2026 — data fix tracker

**Created:** 2026-04-25 18:05 EDT
**Comp UUID:** `a0adef31-177b-4dd6-8b63-7ff59fff0196`
**Tenant UUID:** `00000000-0000-0000-0000-000000000004`
**R2 path prefix:** `<tenant>/<comp>/<routine_id>/videos/{performance,judge1,judge2,judge3}.mp4`

## Method

For each affected slot:

1. **Disk truth** (operator-verified): which physical .mkv on DART is the "real" content for which routine.
2. **Window math:** `video_end_timestamp = file mtime (UTC)`. `video_start_timestamp = end − ffprobe duration`. `video_duration_seconds = round(duration)`. All UTC.
3. **Content placement:**
   - If the real content is **already in R2 under a different routine_id's path** → DB UPDATE the affected routine's URL fields to point at that existing R2 path. No R2 write.
   - If the real content is **only in a local `_archive/v1/` mkv** (never uploaded) → encode 4 mp4s on SpyBalloon, upload to the affected routine's own R2 path, UPDATE URLs.
4. **Photo re-match:** after window UPDATEs, re-attach `media_photos` rows so each photo's `captured_at` falls inside its assigned routine's new window. (Single SQL update; logic = `routine WHERE photo.captured_at BETWEEN start AND end`.)
5. **Audit + rollback:** snapshot `media_packages` rows for affected entries before the run; archive any R2 file we modify; never DELETE.

## Disk truth (operator-verified 2026-04-25 ~17:50 EDT)

### Day 1 area (R136–R143)

| Slot | File | Mtime (UTC) | Dur (s) | Operator says it is |
|---|---|---|---|---|
| 136 | `136_CRAZY_LITTLE_THING_CALLED_LOVE_.mkv` | 13:47:10 | 186.4 | empty stage clip (junk) |
| 137 | `137_INSOMNIA_.mkv` | 13:51:03 | 228.3 | INSOMNIA ✓ R137 |
| 138 | `138_HARD_KNOCK_LIFE_.mkv` | 13:51:10 | 1.1 | tiny scratch (junk) |
| 139 | `139_CRY_TO_ME_.mkv` | 13:56:39 | 175.7 | **HARD KNOCK LIFE** = R138 actual |
| 139/v1 | `139_CRY_TO_ME_.mkv` | 13:53:34 | 138.4 | **CRAZY LITTLE THING** = R136 actual |
| 140 | `140_PINK_.mkv` | 13:59:21 | 142.6 | unknown solo — ❓ ASSUMED **CRY TO ME** = R139 actual |
| 141 | `141_I'M_YOUR_#1_.mkv` | 14:04:47 | 160.0 | I'M YOUR #1 ✓ R141 |
| 142 | `142_COME_OUT_AND_PLAY_.mkv` | 14:07:35 | 162.2 | unknown duet — ❓ ASSUMED **COME OUT AND PLAY** = R142 itself ✓ |
| 142/v1 | `142_COME_OUT_AND_PLAY_.mkv` | 14:01:57 | 151.2 | **PINK** = R140 actual |
| 143 | `143_DANCE_WITH_ME_TONIGHT_.mkv` | 14:10:28 | 166.3 | DANCE WITH ME TONIGHT ✓ R143 |

### Day 2 R353–R356

| Slot | File | Mtime (UTC) | Dur (s) | Operator says it is |
|---|---|---|---|---|
| 353 | `353_AW_NUTS!_.mkv` | 13:56:06 | 149.1 | AW NUTS! ✓ R353 |
| 354 | `354_SATURDAY_NIGHT_.mkv` | 13:58:39 | 134.5 | **R353.5** (no DB row yet — late-insert blocked) |
| 354/v1 | `354_SATURDAY_NIGHT_.mkv` | 13:56:20 | 9.4 | junk |
| 355 | `355_GET_YOUR_SPARKLE_ON_.mkv` | 14:01:20 | 154.5 | **SATURDAY NIGHT** = R354 actual |
| 356 | `356_HANDS_.mkv` | 14:07:14 | 200.6 | HANDS ✓ R356 |
| 356/v1 | `356_HANDS_.mkv` | 14:03:33 | 125.1 | **GET YOUR SPARKLE ON** = R355 actual |

### Day 2 R398–R400

| Slot | File | Mtime (UTC) | Dur (s) | Operator says it is |
|---|---|---|---|---|
| 397 | `397_LET'S_STAY_IN_LOVE_.mkv` | 16:39:31 | 167.8 | LET'S STAY IN LOVE ✓ R397 (assumed; not reviewed) |
| 398 | `398_12_TO_12_.mkv` | 16:41:47 | 132.4 | not reviewed — ❓ |
| 399 | `399_WHERE_IS_MY_HUSBAND_.mkv` | 16:44:26 | 146.6 | **12 TO 12** = R398 actual |
| 400 | `400_YOU_DON'T_KNOW_ME_.mkv` | 16:47:34 | 185.0 | YOU DON'T KNOW ME ✓ R400 |

### Day 2 R405–R408

| Slot | File | Mtime (UTC) | Dur (s) | Operator says it is |
|---|---|---|---|---|
| 405 | `405_KILL_THE_LIGHTS_.mkv` | 16:59:26 | 40.9 | junk fake (40s in fake range) |
| 406 | `406_SCHOOL_DAYS_.mkv` | 17:04:32 | 112.2 | "group, guy with photo camera" — ❓ ID needed |
| 407 | `407_DO_IT_LIKE_THIS_.mkv` | 17:07:13 | 139.0 | "group, all in yellow" — ❓ ID needed |
| 408 | `408_LOOK_AT_ME_.mkv` | 17:13:03 | 149.0 | LOOK AT ME ✓ R408 (no encoded mp4s yet — needs encode) |
| 408/v1 | `408_LOOK_AT_ME_.mkv` | 17:10:17 | 170.0 | **DO IT LIKE THIS** = R407 actual (has encoded mp4s) |

## R2 truth (verified 2026-04-25 18:38 EDT via HEAD)

Each routine's R2 `videos/performance.mp4` byte size = the corresponding disk slot's encoded `*_P_performance.mp4`. So the upload-retarget hypothesis is fully confirmed: each routine's R2 path holds whatever was on disk in that routine's *slot*, regardless of content.

| Routine | R2 perf bytes | = disk slot | Slot's actual content (per op) |
|---|---|---|---|
| R136 | 109,367,907 | 136/perf.mp4 | empty stage (junk) |
| R138 | **729,007** ⚠️ tiny/broken | 138/perf.mp4 | 1.1s scratch |
| R139 | 168,786,194 | 139/perf.mp4 | HARD KNOCK LIFE = R138 actual |
| R140 | 111,283,193 | 140/perf.mp4 | unknown solo (= R139 actual, assumed) |
| R142 | 110,049,478 | 142/perf.mp4 | unknown duet (= R142 itself, assumed) |
| R354 | 87,852,779 | 354/perf.mp4 | R353.5 |
| R355 | 109,607,910 | 355/perf.mp4 | SATURDAY NIGHT = R354 actual |
| R356 | 202,274,575 | 356/perf.mp4 | HANDS = R356 ✓ |
| R398 | 73,490,064 | 398/perf.mp4 | (assumed = R399 in symmetric swap) |
| R399 | 84,992,563 | 399/perf.mp4 | 12 TO 12 = R398 actual |
| R405 | 20,099,229 | 405/perf.mp4 | 40s fake (junk) |
| R406 | 94,295,824 | 406/perf.mp4 | small group "guy with photo camera" = R405 actual |
| R407 | **760,041** ⚠️ tiny/broken | 407/perf.mp4 | "all in yellow" = R406 actual (orig 122 MB on disk) |
| R408 | 167,157,944 | 408/_archive/v1/perf.mp4 | R407 actual (170s, encoded archive) |

Locally encoded mp4s present in `_archive/v1/` for: 139, 142, 354, 356, 408 — these are NOT yet in R2.
Locally NOT encoded yet: 408 current 149s mkv only.

R407 + R138 R2 entries are 760KB / 729KB — these are broken partial uploads, not real perfs.

- **🟢 High confidence (operator-verified content, both ends mapped):** R136, R138, R140, R354, R355, R407
- **🟡 Medium (one assumption pending):** R139 (assumed = 140 solo), R142 (assumed = 142 current duet), R398 (assumed = 398 current after R399 swap)
- **🔴 Blocked (need operator review):** R398/406/407 song IDs to confirm cascade vs. one-off; R353.5 + R399.5 inserts blocked by late-insert endpoint

### Action table (🟢 + 🟡 only)

| # | Routine | What's currently at routine's R2 path | Real content location | New `video_start_timestamp` | New `video_end_timestamp` | New dur | Action |
|---|---|---|---|---|---|---|---|
| 1 | R136 (CRAZY LITTLE THING CALLED LOVE) | empty stage clip (junk) | DART `139/_archive/v1/.mkv` (NOT in R2) | 2026-04-24 13:51:16 UTC | 2026-04-24 13:53:34 UTC | 138 | **Encode + upload 4 mp4s** to R136's R2 path; UPDATE URLs + window |
| 2 | R138 (HARD KNOCK LIFE) | 1.1s scratch | R2 under R139 path `be9f4bee.../` | 2026-04-24 13:53:43 UTC | 2026-04-24 13:56:39 UTC | 176 | **Server-side R2 copy** R139 path → R138 path; UPDATE URLs + window |
| 3 | R139 (CRY TO ME) — 🟡 | (current correct? = HARD KNOCK LIFE; will be moved by #2) | R2 under R140 path `22c8cd3f.../` (assuming 140 solo = R139) | 2026-04-24 13:56:57 UTC | 2026-04-24 13:59:21 UTC | 143 | **Server-side R2 copy** R140 path → R139 path; UPDATE URLs + window |
| 4 | R140 (PINK) | unknown solo (assumed R139) | DART `142/_archive/v1/.mkv` (NOT in R2) | 2026-04-24 13:59:26 UTC | 2026-04-24 14:01:57 UTC | 151 | **Encode + upload** 142/v1 → R140's R2 path; UPDATE URLs + window |
| 5 | R354 (SATURDAY NIGHT) | R353.5's content (134.5s) | R2 under R355 path `9acf36a4.../` | 2026-04-25 13:58:46 UTC | 2026-04-25 14:01:20 UTC | 155 | Server-side R2 copy R355 path → R354 path; UPDATE URLs + window |
| 6 | R355 (GET YOUR SPARKLE ON) | R354's content (per #5 prior) | DART `356/_archive/v1/.mkv` (NOT in R2) | 2026-04-25 14:01:28 UTC | 2026-04-25 14:03:33 UTC | 125 | Encode + upload 356/v1 → R355 path; UPDATE URLs + window |
| 7 | R398 (12 TO 12) — 🟡 | not reviewed | R2 under R399 path `234d64ff.../` | 2026-04-25 16:41:59 UTC | 2026-04-25 16:44:26 UTC | 147 | Server-side R2 copy R399 path → R398 path; UPDATE URLs + window — **PENDING op review of 398** |
| 8 | R407 (DO IT LIKE THIS) | R408 LOOK AT ME (149s, no encoded mp4s yet) — wait, see note | DART `408/_archive/v1/.mkv` + 4 encoded mp4s already on disk | 2026-04-25 17:07:27 UTC | 2026-04-25 17:10:17 UTC | 170 | Upload 4 existing mp4s from `408/_archive/v1/` → R407's R2 path; UPDATE URLs + window |
| 9 | R408 (LOOK AT ME) | R407's content (170s, encoded) | DART `408/.mkv` (no encoded mp4s yet) | 2026-04-25 17:10:34 UTC | 2026-04-25 17:13:03 UTC | 149 | Encode 408 current → upload to R408 R2 path; UPDATE URLs + window |

### Held back

- **R353.5, R399.5** — need late-insert endpoint deployment first
- **R405** — only junk on disk; real R405 not yet located (could be in 406's content if that's a different group's number, cascading)
- **R406** — pending operator song ID
- **Day 1 cascade closure** — R142 current is "unknown duet" but slot title matches; assuming this IS R142 (no action). If wrong, action 4 chains further

## Photo re-match (single SQL, runs after all UPDATEs)

```sql
WITH affected AS (
  SELECT entry_id, video_start_timestamp, video_end_timestamp
  FROM media_packages
  WHERE competition_id = 'a0adef31-177b-4dd6-8b63-7ff59fff0196'
    AND deleted_at IS NULL
)
UPDATE media_photos mp_photo
SET media_package_id = (
  SELECT mp.id FROM media_packages mp
  WHERE mp.competition_id = 'a0adef31-177b-4dd6-8b63-7ff59fff0196'
    AND mp.deleted_at IS NULL
    AND mp_photo.captured_at BETWEEN mp.video_start_timestamp AND mp.video_end_timestamp
  LIMIT 1
)
WHERE mp_photo.captured_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM media_packages mp
    WHERE mp.competition_id = 'a0adef31-177b-4dd6-8b63-7ff59fff0196'
      AND mp.deleted_at IS NULL
      AND mp_photo.captured_at BETWEEN mp.video_start_timestamp AND mp.video_end_timestamp
  );
```

(Will use a more targeted query in execution — limit to photos whose current package is in the affected list, run as dry-run COUNT first, then UPDATE.)

## Pre-fix snapshot (rollback)

Save full `SELECT * FROM media_packages WHERE entry_id IN (...)` to `docs/plans/assets/2026-04-25-toronto-fix-snapshot-pre.json` before any write.

## Validation (proof of correctness)

For each row in the action table, run BEFORE and AFTER:

1. **Photo count delta predicted** = COUNT(media_photos.captured_at BETWEEN new_start AND new_end). Compare to `routine_window_source` and operator's "did this routine have photos shot during it" intuition.
2. **Window sanity:** new_end - new_start = duration ± 1s.
3. **URL correctness:** HEAD on new perf URL returns the byte size matching ffprobe of the local file.
4. **Cross-routine consistency:** sum of photo_counts across affected routines = same as before (no photos created/deleted, only redistributed).

## Questions for operator before execution

1. **Day 1 #3:** is `140/140_PINK_.mkv` (solo, 142.6s, recorded 9:56:57–9:59:21 EDT) actually R139 CRY TO ME? (Assumption underpins #3 and indirectly #4.)
2. **Day 1 #closure:** is `142/142_COME_OUT_AND_PLAY_.mkv` (duet, 162.2s) actually R142 itself? (If yes, no action on R142. If no, the cascade continues into R143.)
3. **Day 2 #7:** Is `398/398_12_TO_12_.mkv` (132.4s, not reviewed) what should be R397 cascading? (Drives whether #7 needs adjustment.)
4. **Day 2 R405/R406:** Real R405 is missing — group with "guy with photo camera" (in 406) and "all in yellow" (in 407) — what routines are those by entry number/title? (Drives R405/R406/R407 cascade resolution.)

## Execution order (post-confirmation)

1. Snapshot DB.
2. Server-side R2 copies (Phase 2: cheap, no encoding).
3. Encodes on SpyBalloon for archive-only content (Phase 3: ffmpeg locally).
4. Uploads to R2 (Phase 4).
5. DB UPDATEs (Phase 5: per-row, in transaction).
6. Photo re-match SQL (Phase 6).
7. Spot-check 3 random rows in CD media portal (Phase 7: human verification).
