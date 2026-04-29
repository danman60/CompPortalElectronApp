# Re-record fixes — queued for next session

**Created:** 2026-04-25 13:11 EDT (UDC Toronto Day 2, mid-show)
**Status:** QUEUED. Do not ship live during UDC Toronto. Pick up after show or in a clean session.
**Operator note:** "caused a big mess at end of this session" — recording slot advance jumping past skipped/scratched routines was visible mid-show today.

---

## Issue A — Advance jumped over R355 (re-record + Advance flow)

### Reported behavior
- Operator re-recorded **R354**.
- The "Re-record or missed advance?" modal fired.
- Operator clicked **Advance**.
- `advanceToNext()` returned **R356** — **R355 was skipped**.

### Modal reference

See `assets/2026-04-25-re-record-modal.jpg` (operator screenshot from a separate R408 incident, captured 2026-04-25 13:13 EDT for design reference).

The green button always renders the resolved next-routine number — e.g., **"Advance to next routine — R409"**. So the modal's button text IS the answer to whether the bug is upstream or downstream of `advanceToNext`.

### Hypotheses (in order of likelihood, sharpened with modal reference)

The modal includes the next-routine number on the green button, so the question collapses to: when that button fired for R354's stop, what number did it say?

1. **Button said "R355" but advance went to R356** → real bug. Modal text comes from one path, `advanceToNext` from another, and they disagreed. Trace both `recording.ts:597-647` (modal text) and `state.ts:advanceToNext` (advance action) and find the divergence.
2. **Button said "R356" and advance went to R356** → not a bug. R355 was already `scratched`, `skipped`, or moved by drag/drop at the time. The behavior was correct; the operator's expectation ("next is R355") was based on a stale mental model. UX fix only — make the "skipping over X because…" reason visible in the modal.

### Investigation order (do not write code without doing these first)
1. **Ask operator: when the modal fired for R354's re-record, what number did the green button show?** That single answer routes the rest of the work.
2. If the answer is ambiguous / can't be recalled, look at `events.log` on DART around the time of the R354 stop — there should be a `recording.advanceModal.fire` or similar entry with the resolved number. Search around the operator-recalled timestamp.
3. Read `src/main/services/recording.ts:597-647` — modal text path.
4. Read `src/main/services/state.ts` `advanceToNext` — advance action path.
5. Diff the two paths' "next visible after current" computation. If they share a helper (e.g., `getNextVisibleAfter`), the bug is elsewhere — check displayOrder writes between modal-fire and button-click. If they don't share, that's the bug: split source-of-truth.
6. **Only after** the above: propose a fix.

### What NOT to do
- Do not "patch" `advanceToNext` blindly to handle R355's case. Without confirming R355's actual status + displayOrder at the time, any patch is a guess.
- Do not change the modal text without confirming what fired. If the modal said the wrong number, the bug is upstream of `advanceToNext`.

### Files to read first
- `src/main/services/recording.ts:597-647`
- `src/main/services/state.ts` — search for `advanceToNext`, `getVisibleRoutines`, `getNextVisibleAfter`
- `src/renderer/components/RoutineTable.tsx:454` — drag/drop (displayOrder)

---

## Issue B — Item 9 from day-2 fix list: Judge re-record audio flow (held back)

Held back during UDC Toronto Day 2 wave 4 — flagged risky (new surface, R2 writes, multiple ffmpeg flows, build behind a flag).

Full spec already captured in `docs/plans/2026-04-25-day2-fix-list-v2.md` lines 194–227.

### Open question that gates implementation
> "**R2 versioning — still ambiguous:** overwrite existing path (`judgeN_video_url`) so URL stays stable + CDN refresh happens via TTL — OR write to versioned path (`judgeN_v2.mp4`) and update DB column to point at new path? Tradeoff: overwrite is simpler, version-path keeps audit trail. Need your call."

Resolve this before any code is written.

### Defaults to assume IF operator says "I don't care, pick"
- Versioned path `judgeN_v<N+1>.mp4` with audit archive at `archive/judgeN_<originalTs>.mp4`. The "never overwrite an R2 path" rule from existing memory carries higher weight than CDN simplicity.

### Plan
- Re-read item 9 in `2026-04-25-day2-fix-list-v2.md`.
- Confirm R2 versioning answer.
- Build behind `settings.judgeReRecord.enabled` flag (default false).
- Stage on DART Desktop, swap with operator-controlled close, validate on tester comp before UDC enables.

---

---

## Operator's data-corruption list — UDC Toronto Day 2 (captured 2026-04-25 13:19 EDT)

The advance-modal confusion produced concrete misplacements during the show today. Operator-stated truth (NOT inferred — these are ground truth):

| Routine | Slot | What's there | Notes |
|---|---|---|---|
| **R353.5** | archive of R354 | (operator note: "956-958 for window/exif") | Need clarification on "956-958" — entry numbers? frame/EXIF range? |
| **R354** | R354 (current) | NEWEST take = R354 proper | Older archive content is the .5 above |
| **R355 proper** | **R356 (archive)** | R355's actual performance | Result of the R354→R356 advance bug. Operator quote: *"prompts to advance are glitchy, i had recorded over 354 and when i said advance to next it jumped to 356"* — confirms Issue A is a real bug, not skipped/scratched state. |
| **R356** | R356 (current) | NEWEST take = R356 proper | R355's perf is in this slot's archive. |
| **R399 proper** | **R398 (current)** | All video AND EXIF for R399 went into R398's slot | Two-routine misplacement chain. |
| **R399.5** | R399 (current) | "Which is actually 398 proper" — interpreting: the R399 slot now contains R398's proper performance. Need clarification. |
| **R405** | R405 (current+archive) | Archive has a "fake" 40s recording; real R405 = NEWEST current | Refines the 30s heuristic — duration ≥30s isn't always "different routine"; can also be "fake" (operator-defined). Need definition of "fake" vs "different routine". |
| **R405 proper** | R406 (archive)? | Operator: "might be in 406 archive, confusing modal again" | Uncertain — operator wasn't sure. |
| **R406** | R406 (current) | NEWEST take = R406 proper | |
| **R379** | R379 (current) | Operator stopped and started again — *longest take is good* | Different rule than the newest-wins default. Capture this exception. |
| **R407** | R407 (current) | NEWEST = R407 proper | |
| **R407 proper might also be in R408** | R408 archive? | "may have gone into 408 re record glitching" | Uncertain — same modal-glitch class. |

### Round 2 answers — operator 2026-04-25 14:38 EDT

| Q | Answer |
|---|---|
| **R399 slot's most recent take?** | R398 proper. So R399 the slot currently holds R398's actual performance. |
| **R398 slot's most recent take?** | R399 proper. So R398 the slot currently holds R399's actual performance. Symmetric swap with R399. |
| **`.5` routines (R353.5, R399.5) handling?** | Need to be **inserted** as new schedule rows in CompPortal DB. Re-attribution then assigns the right takes to the new routine ids. |
| **R405→R406 + R407→R408 uncertainty?** | Operator will check manually (watch the videos and identify by content). Don't act on these without operator-confirmed mapping per slot. |

### Resulting per-routine action plan (post-show, additive only)

| Affected slot | Current contents | Correct contents | Action |
|---|---|---|---|
| R354 | R354 proper (newest) — already correct | R354 proper | None — already correct. R353.5 lives in R354 archive (window 9:56–9:58 EDT, ~2m). |
| R355 | (not stated — likely missing/empty) | R355 proper | Re-attribute the R356-archive take that is actually R355 proper. |
| R356 | R356 proper (newest) — already correct | R356 proper. R355 proper sits in R356's archive. | UPDATE: re-attribute the archive take's media_package to R355's routine_id. |
| **R398** | **R399 proper** (newest take) | R398 proper | UPDATE media_packages: this slot's media → routine_id of R399. (Plus separately find R398's actual proper.) |
| **R399** | **R398 proper** (newest take) | R399 proper | UPDATE media_packages: this slot's media → routine_id of R398. (Plus check whether R399.5 also has a take here.) |
| R405 | R405 proper (newest) + 40s "fake" archive | R405 proper. Fake = junk, leave alone. | None on current; manual check on R406 archive for R405-proper claim. |
| R406 | R406 proper (newest); maybe R405 proper in archive | R406 proper. R405 proper if confirmed in archive → re-attribute. | Manual check + UPDATE if confirmed. |
| R407 | R407 proper (newest) — possibly also in R408 | R407 proper | Manual check; if R408's archive holds R407 proper, re-attribute. |
| R408 | (uncertain — operator quote: "may have gone into 408 re record glitching") | R408 proper | Manual check needed. |
| R353.5 | Lives in R354 archive (~9:56–9:58 EDT) | R353.5's own (new) routine row | INSERT new routine row, then re-attribute. |
| R399.5 | (operator quote: "399.5 recorded into 399") — may be in R399 slot stack OR R400/elsewhere | R399.5's own (new) routine row | INSERT new routine row, then re-attribute. Note: R399 slot's *current* take is R398 per Q above, so R399.5 is either in R399 archive or another adjacent slot. Manual check during video review. |

### Late-insert auto-upload + assignment flow (operator-spec 2026-04-25 15:21 EDT)

Operator added: **empty routines should auto-upload for future assignment**. Architecture:

**CSE changes** (small, ~30 min):
- When `routine.lateInsert === true`, route the upload-url request to a new endpoint `/api/plugin/upload-url-late-insert` instead of the standard one.
- Payload: `{ syntheticId: routine.id, recordedAt: routine.recordingStartedAt, afterEntryId: <id-of-the-routine-current-when-empty-was-inserted>, competitionId }`.
- Response includes the freshly-minted CompPortal entry uuid; CSE patches `routine.id` to that uuid and continues upload via the standard flow.

**CompPortal changes** (medium, ~2 hr):
1. **Migration**: add `competition_entries.is_late_insert_pending boolean default false`. Add `competition_entries.late_insert_after_entry_id uuid null references competition_entries(id)` so the eventual ordering is preserved.
2. **New endpoint** `/api/plugin/upload-url-late-insert`: validates plugin api key + competitionId, creates a `competition_entries` row (`is_late_insert_pending=true`, `routine_title='Late insert — pending assignment'`, `entry_number = <after_entry>.5`), returns the new uuid + signed upload URL with the same shape as the existing upload-url endpoint.
3. **Admin UI** `/dashboard/admin/late-inserts`: lists entries where `is_late_insert_pending=true` for the active comp; per-row form to fill in title/dancer/studio/category/age/size, then a "Clear pending" action that sets the flag false. Once cleared, the entry behaves as a normal entry (media already attributed).
4. **Filter**: parent + SD media portal queries should exclude `is_late_insert_pending=true` so audience never sees placeholder entries.

**Why this design**:
- Files always upload — no operator memory required to do something post-show. The recording is durable in R2 the same way as normal routines.
- Operator's post-show task is purely metadata (fill in title etc.), not file shuffling.
- The `.5` entry_number convention matches the operator's mental model from today's data list.

**Scope summary**: ~3–4 hours across 2 codebases. Single migration. Sequenced after the data correction list because both touch `competition_entries`.

---

### Implementation sequence (post-show)

1. **Read-only audit query first.** SELECT every media_package + filename + duration for routines [354, 355, 356, 398, 399, 405, 406, 407, 408] plus their archive content from disk. Surface in a single table for operator scan.
2. **Operator confirms each row.** No re-attribution without per-row confirmation.
3. **DB inserts** for R353.5 and R399.5 (CompPortal `competition_entries` table or equivalent). Capture new routine_ids.
4. **Per-routine UPDATE statements** to re-attribute media_packages.routine_id. All single-row, all targeted, all logged.
5. **Optional filesystem clarity moves** — rename `_archive/v1/<file>` to `_archive/v1/<file>.<actual-routine>.bak` so on-disk identity matches DB attribution. Never delete.



1. **"5 routine"** = `.5` routines (late-add inserts like R353.5, R399.5) that may not have rows in the schedule DB at all. The "different issue" referenced is: their proper slots don't exist in the data, so their performances landed in adjacent slots' archives.
2. **"956-958"** = **9:56–9:58 AM EDT** — the time window R353.5 performed in. Roughly a 2-minute take, recorded into R354's archive.
3. **R399.5 chain** = R399.5 was recorded into R399 (the slot). R399.5 may not be in the schedule data at all (`.5` class).
4. **"Fake" vs "different routine"** = duration is the rule:
   - `<30s` = clearly noise (scratch, immediate stop)
   - `30s – ~1m15s` = junk / partial / "fake" — operator hit Next, big pause, stop/restart in the same slot
   - `>1m15s` (firm at `>1m30s`) = real routine; "there will never be a 2.5-minute blank recording"
   - The R405 "fake 40s" sits in the 30s–1m15s junk band, not the >1m30s real-routine band.
5. **R379 / "longest wins"** = a general rule, not a one-off. Among real-length takes (>~1m15s), longest beats newest. R379 was a stop-restart; the longest take was the real one. The heuristic memory has been updated to reflect this as the meta-tiebreaker.

### Proposed approach (pending answers)

Once questions are answered, the corrective actions are all of one of these types:
- **Re-attribute video** in DB: change `routine_id` on `media_packages` rows (additive; no DELETEs)
- **Re-attribute EXIF / photo windows**: shift `video_start_timestamp` / `video_end_timestamp` references on the affected routines
- **Move (not delete) archive content** on disk: rename `_archive/v1/` filenames to reflect actual routine identity, leave files in place

NONE of this should run live during UDC Toronto. Stage queries, dry-run results, get operator sign-off per row, then execute one routine at a time.

---

## Order of operations next session

1. **Issue A first.** Confirmed by operator today as a real bug ("prompts to advance are glitchy, i had recorded over 354 and when i said advance to next it jumped to 356"). Investigation is now: trace why modal/advance disagreed for R354 — operator pressed Advance expecting R355, got R356. Likely the modal showed R355 but `advanceToNext` used a different next-visible computation. Read `recording.ts:597-647` + `state.ts:advanceToNext` and find the divergence.
2. **Data correction list above** — only after the five clarifying questions are answered, and only post-show.
3. **Issue B after.** Net-new feature, no live regression, can wait for clean cycle.

## Cross-references
- `CURRENT_WORK.md` — item 2 in "Open investigations"
- `.claude-crash-transcript.md` — Section B "Recording slot flow"
- `docs/plans/2026-04-25-day2-fix-list-v2.md` — items 9 (held), 26–29 (wave 4 group)
