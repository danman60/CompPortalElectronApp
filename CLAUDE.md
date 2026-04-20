<!-- GitNexus rules: see master ~/projects/CLAUDE.md → "GitNexus Workflow" section. Per-project index name is the project folder name. -->

# CompSyncElectronApp — Project Rules

## PHOTOMATCH INVESTIGATION PROTOCOL (NON-NEGOTIABLE)

This protocol applies whenever you are diagnosing photo-to-routine matching, orphan analysis, match windows, EXIF scans, or camera-to-routine mapping. Ignoring it = immediate rework.

### Banned explanations (these are hallucinated business logic, not findings)

Do not propose, mention, or imply any of these without DIRECT evidence from a primary source (DB row, operator statement, physical inspection):

- "Operator hit start-stop quickly during setup"
- "Recording was accidentally short"
- "Pre-recorded takes from the night before"
- "Virtual / remote entries"
- "Test takes"
- "Stale / wrong video windows"
- "Real dance didn't happen during these microsecond windows"
- "Operator's camera wasn't shooting at that time"
- "Saturday-night entries that wouldn't be shot Sunday morning"
- "Clock drift" — ONLY after showing the drift from paired reference timestamps
- "`photo_NNN.JPG` is video-frame extraction / synthetic / rendered / thumbnail / preview" — without ASKING the user what that filename pattern actually represents
- Any invented classification of photo filenames (MIXED / SYNTHETIC / SYNTHETIC-ONLY / do-not-delete / rendered / extracted / scratch / temp) that the user did not define
- Any invented pipeline name (frame-extractor, video-slicer, preview-generator, thumbnail-pipeline) that you haven't verified exists in code or docs
- Any explanation that attributes missing photos to operator behavior, workflow exception, or scheduling quirk
- Any segmentation / categorization scheme built on an unknown filename pattern — if you don't know what `photo_NNN.JPG` means, the answer is "I don't know what that is, can you tell me?" — NOT "probably X, so here's how to handle it."

These are ALL business-logic hallucinations. The first hypothesis is always: your scan / match query / time-window math / camera assignment / SD mount / EXIF parser / timezone conversion is wrong.

### Required investigation order (do not skip steps)

When you see "R### has 0 matching photos":

1. **Verify the routine's window is real.** `SELECT routine_number, start_ts, end_ts, EXTRACT(EPOCH FROM (end_ts - start_ts)) AS duration_sec FROM routines WHERE routine_number = N`. If duration is absurdly short (< 30s), that's a schema/timezone bug to investigate, NOT an operator error.
2. **Verify EVERY timestamp is the same timezone.** Routine window, EXIF ts, photo file mtime, scan timestamp — all must be EDT (or all must be UTC — don't mix). Print the TZ used for each side of the comparison in your report.
3. **Query photos directly by RAW time range** — no cache, no pre-built manifest, no v3.json. Example: `SELECT COUNT(*) FROM photos WHERE exif_ts BETWEEN '<start>' AND '<end>'`. Report N.
4. **If N=0, widen the window** by ±5 minutes, re-query. Report N_wide. If N_wide > 0, you have a boundary / TZ problem — NOT a missing photo.
5. **If N=0 at ±5min, check the camera axis.** Are photos restricted by camera_id, photographer_id, session_id? Remove the filter, re-query. Report N_nocam.
6. **If N=0 even without camera filter, check the source.** Are there photos in the DB with exif_ts within ±60 min of the routine? If YES, the issue is filter logic. If NO, check the ingest pipeline (see "MISSING DATA → SUSPECT INGEST/PIPELINE" in master).
7. **Only AFTER steps 1–6** may you even consider that a photo doesn't exist — and only by saying "DB has zero photos with exif_ts within routine window ± X minutes across all cameras; ingest pipeline last ran at <timestamp>; <N> photos remain in staging." Never by inventing a behavioral explanation.

### Reporting format for photo-match investigation

One line per query. Number-first. TZ tagged. No prose between queries.

```
R291 window: 2026-04-19 14:22:03 → 14:22:05 EDT (2s duration) ⚠ SUSPICIOUS DURATION
photos in [start, end] all-cameras: 0
photos in [start-5min, end+5min] all-cameras: 847
photos in [start-5min, end+5min] camera=2 only: 312
→ filter discrepancy, not missing data. Investigating camera assignment.
```

Not:

```
R291 has a 2s window which appears to be an accidentally-short recording
where the operator likely hit start-stop quickly during setup. The real dance
wouldn't have happened during these microsecond windows.
```

The first is a diagnosis. The second is fiction.

### When to ask the user

If the routine's recorded window is genuinely < 30s AND you cannot find photos within ±5min via any camera, STOP and ask:

> "R291's recorded window is 2s (14:22:03–14:22:05 EDT). No photos match within ±5min across all cameras. This is either a window bug or a real short recording. Before investigating further: can you confirm the real dance time for R291?"

Do NOT guess. Do NOT invent. Ask.
