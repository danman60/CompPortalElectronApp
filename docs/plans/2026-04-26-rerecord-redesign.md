# Re-record / Take-management Redesign — Design Reference

**Status: DEFERRED. Design captured 2026-04-26 during UDC Toronto Day 3 between routines. Implementation TBD post-event.**

This is a frozen design reference — not an implementation plan. When ready to build, branch off this doc to a phase plan in `.planning/phases/` (or equivalent) and resolve the open implementation questions in §10.

---

## 1. Why this change

Current re-record flow has two confirmation gates that the operator finds confusing:

1. **Pre-record dialog** — native OS dialog ("Already has recording. Continue?") with default = Cancel, which feels backwards.
2. **Post-stop "Advance vs Archive" modal** — semantically framed around the new take's destination, which is the opposite of how operators think. Operators think about the take they just made, not where the file goes. The "Advance" branch silently moves the new `.mkv` into the **next** routine's folder, producing the "wait, my latest recording disappeared from this slot" experience.

Battlefield observation (Day 3): operators want the latest take to land in the slot they pressed RECORD on, every time, and want decisions about prior takes to be deferred and non-blocking.

---

## 2. Hard rules / invariants

These are non-negotiable. Every code path must respect them.

1. **Latest take is canonical for the slot it was recorded in.** Always lands in the current routine's folder. No auto-folder-move between routines.
2. **A take's recorded time window is IMMUTABLE.** Start/stop timestamps are never modified. Routine number, slot label, title, and metadata can change; the take's recorded `[start_ts, end_ts]` cannot.
3. **Time window = canonical truth for photo-routine matching.** A take's window defines which photos belong to it via EXIF.
4. **No photo, take, or `.mkv` is ever deleted.** Every operation is additive or a rename/relink. Discard means archive-to-disc, not delete. R2 photo objects persist regardless of routine-layer changes.
5. **Photos are matched additively.** When time windows shift due to a re-record, photos relink (or unlink) — they are never deleted from `media_photos` or R2. An unmatched photo stays in the pool, ready to relink later if offset adjustments cause it to match.
6. **Eager R2 preserve.** The moment re-record starts, prior R2 objects are copied to a holding path before the new take's upload can overwrite the canonical keys. Operator can take their time deciding fate.
7. **Cascade max 1.** Re-assigning a displaced take to an occupied slot causes the existing take on that slot to **auto-stash as an extra of that slot** without prompting. No second confirmation. No infinite cascade.
8. **The operator is never pressured to decide during a live recording.** Modals are non-blocking. Auto-stash on countdown handles deferred decisions.

---

## 3. Take lifecycle

### 3.1 Take duration buckets

- **Sub-5s take** (< 5 seconds): silent **auto-discard**. `.mkv` archived to disc. No app-state change. No modal. The slot stays exactly as it was — including any prior take that would have been displaced (the displacement effectively never happened from the app's POV).
- **≥5s take**: real take, enters the normal flow. If a prior take was displaced, the post-record decision modal fires.

### 3.2 Removed: auto-encode pick-longest guard

The current `recording.ts:776-786` guard (skip auto-encode if new take is shorter than archived prior) is **removed**. Latest is always promoted; the post-record modal handles operator regret. The sub-5s threshold replaces this guard for the only realistic accident case.

### 3.3 Discard archive location

All discarded `.mkv` files (sub-5s noise + operator-discarded takes) go to a **single shared per-comp folder**. Filenames are unique (timestamp + entry_number + take_id) so collisions are impossible. Single location simplifies post-event cleanup and forensic recovery.

---

## 4. UI elements

### 4.1 Pre-record toast

- **Trigger**: operator presses RECORD on a slot that already has media.
- **Behavior**: non-blocking. Recording starts immediately. Toast is purely informational.
- **Wording**: *"Recording already exists for this routine, record again? Nothing is overwritten and you'll be asked to decide what goes where upon stopping."*
- **Auto-dismiss**: 5 seconds with visible countdown.
- **No buttons** — informational only.

### 4.2 Post-record decision modal

- **Trigger**: operator stops recording (Stop button or Next button) AND a prior take was displaced.
- **Trigger gating**: only fires for takes ≥ 5s. Sub-5s takes never trigger this modal.
- **Behavior**: non-blocking. Operator can ignore it and start the next recording.
- **Auto-stash on timeout**: 30-second countdown. If untouched, displaced take auto-stashes as an extra at the bottom of the schedule.
- **Content**: shows the displaced take's:
  - Duration
  - 12-hour clock time when recorded
  - Relative time ("15 minutes ago")
- **Actions**: three buttons:
  - **Re-assign** → opens re-assign picker (§4.3)
  - **Discard** → archive `.mkv` to per-comp discard folder; no DB row created
  - **Stash as extra** → create extra entry at bottom of schedule with displaced take's video + photos (matched via immutable time window)

### 4.3 Re-assign picker

Used both from the post-record modal AND from the row inspector dropdown (§4.4) for any take.

- **Input**: free-text entry number with type-to-complete. Autocomplete searches by **routine title AND entry number**.
- **Notes field**: operator can enter notes inline at re-assign time.
- **Target slot resolution**:
  - **Number doesn't exist in schedule** → auto-create extra routine for that slot (e.g., `538.5`), notify operator. The displaced take becomes the canonical take of that new extra.
  - **Number exists, slot is empty** → straightforward re-assignment.
  - **Number exists, slot has media** → modal shows the existing media (duration, 12h time, "X minutes ago"). Operator picks from a sub-dropdown:
    - **Assign as top promoted take** — existing take cascades to extra of that slot (cascade max 1, automatic, no further prompting)
    - **Discard** — archive `.mkv`; the displaced take is just gone from app state
    - **Add as extra of that slot** — displaced take becomes a sibling extra of the target slot, no promotion, original take stays canonical

### 4.4 RoutineTable row — expandable inspector

- **Every routine row** gets a small expand arrow.
- **Click expands** the row to show:
  - The routine's video(s) (promoted take + any sibling takes)
  - The routine's photos (linked via EXIF time-window match)
  - Reassign actions for any take (uses §4.3 re-assign picker)
  - Existing notes for any take
- **Sibling takes** (extras tied to the slot via cascade) surface here as nested rows beneath the promoted take.
- **Visual indicator**: presence of siblings should be discoverable at a glance (e.g., the arrow could indicate count, or a small "+N" near the routine number — exact UX TBD at plan time).

### 4.5 Stashed extras (existing feature, augmented)

Extras already live at the bottom of the schedule. New requirements:

- **Edit button** on each stashed extra — opens a form with **title + entry number + notes** fields.
- **Full upload pipeline** — stashed extras get encoded videos, EXIF-matched photos linked to their immutable time window, and full R2 upload. Treated as first-class routines at the take/photo layer.
- **Promotion to a planned slot**: operator types the target entry number in the Edit form. Same auto-create / cascade logic as §4.3.

### 4.6 CompPortal CD dashboard (out of Electron scope, flagged)

The CD dashboard in CompPortal needs a **stashed-routines modal** that surfaces:
- All stashed extras for a comp
- Their entry numbers, titles, notes
- Status (whether they've been promoted to a planned slot or still need data entry)

This is not part of the Electron change. It's a CompPortal-side requirement that should be planned alongside.

---

## 5. Live-recording edge case

If the operator interacts with the post-record modal **while a new routine is actively being recorded** (because the modal is non-blocking and lives during the next take's first 30s), and the operator types the currently-recording slot's entry number into the re-assign picker:

- **Treat it as "add as extra of that slot"** (option c from §4.3). Non-destructive, no waiting, no overwrite of the live take. The displaced take becomes a sibling extra of the live slot.
- The operator is never blocked; the live recording is never touched.

This is consistent with the rule that the operator is never pressured to decide during a live recording.

---

## 6. State transitions

### 6.1 On RECORD pressed (slot has prior media)

| Step | Action |
|---|---|
| 1 | Pre-record toast appears (5s countdown). Recording starts immediately. No blocking. |
| 2 | Eager R2 preserve: prior R2 objects copy to holding path (e.g. `…/<entry_id>/_versions/<take_id>/performance.mp4`). Holding path schema TBD at plan time. |
| 3 | New take's `.mkv` writes to current routine folder as canonical. |
| 4 | Prior take's `.mkv` and encoded files move to per-comp discard archive folder (or stay accessible — TBD at plan time, see §10). |
| 5 | Prior take metadata (duration, time window, R2 holding path) retained in app state for the post-record modal. |

### 6.2 On STOP or NEXT (with displaced take)

| Step | Action |
|---|---|
| 1 | If take duration < 5s: silent auto-discard. `.mkv` to discard folder. No state change. END. |
| 2 | If take duration ≥ 5s and a prior take was displaced: post-record modal fires (non-blocking, 30s countdown). |
| 3a | Operator picks **Re-assign**: re-assign picker (§4.3) handles target slot resolution. |
| 3b | Operator picks **Discard**: prior take's `.mkv` already in discard folder. No DB row created for the prior take. R2 holding path objects can be cleaned up at end-of-comp (TBD). |
| 3c | Operator picks **Stash as extra**: extra entry created at bottom of schedule. Displaced take's video promoted onto that extra. Photos relink to extra via immutable time window. |
| 3d | 30s timeout, no operator action: auto-stash as extra (same as 3c). |

### 6.3 On photo ingest after a re-record

- Photos are EXIF-matched to whichever take's immutable time window covers their capture timestamp.
- A slot's "current photos" = photos matched to the **promoted take's** time window.
- A sibling extra's photos = photos matched to that take's immutable time window.
- A photo can only be linked to ONE take at a time. If time windows shift (re-assignment changes which take is promoted on a slot), the matcher re-runs and relinks. **Photos themselves are never deleted.**

---

## 7. Schema implications

This redesign moves the data model from **1 slot : 1 media_package** to **1 slot : N takes (1 promoted + N siblings)**. The exact schema change is TBD at plan time. Possibilities:

- **Option A**: New `takes` table, FK to `competition_entries`. `media_packages` becomes a view or a denormalized cache of the promoted take.
- **Option B**: Add `parent_entry_id` and `is_promoted` columns to `media_packages` / `competition_entries`. Sibling takes are extra entries with `parent_entry_id` set.
- **Option C**: Keep `media_packages` 1:1, but extras are first-class `competition_entries` rows tagged with `parent_entry_id`. Each take is its own entry; the parent slot just points to its "promoted" child.

Option C is closest to the existing "extras at bottom of schedule" feature and probably has the smallest blast radius. To be decided at plan time.

---

## 8. Out of scope (future)

- **CompPortal CD dashboard stashed-routines modal** — requires a separate CompPortal-side phase.
- **Sub-routine creation on-the-fly with `538.5` syntax + CD warning** — a future enhancement on top of the base re-assign picker. Base picker creates a generic extra; the `.5` semantics are a downstream improvement.
- **Bulk promotion of extras** — e.g., select multiple stashed extras and promote them in one action.
- **Cross-comp re-assignment** — only same-comp re-assign is in scope. Don't allow operator to re-assign a take into a different competition.

---

## 9. Phasing recommendation

When ready to plan, suggest splitting into phases:

**Phase 1 — Kill the confusion (lowest risk, biggest UX win)**
- Remove the post-stop "Advance vs Archive" modal entirely.
- Reword the pre-record dialog to the new reassuring toast (§4.1).
- Sub-5s auto-discard.
- Auto-encode pick-longest guard removed.
- Latest take always lands in current routine folder, prior files archive in place (close to current archive behavior, just minus the misroute branch).
- **No new schema work yet.** Single-take-per-slot model preserved. This phase is pure UX cleanup.

**Phase 2 — The new modal + take siblings**
- Post-record decision modal (§4.2).
- Re-assign picker (§4.3) — basic version, only handles "discard" and "stash as extra" actions.
- Schema work for sibling takes (§7).
- Stashed extras get the Edit button (§4.5).
- Eager R2 preserve.

**Phase 3 — Full inspector + cascade**
- RoutineTable row inspector (§4.4).
- Re-assign picker's "assign as top promoted" with cascade.
- Photo relink-on-window-shift logic.
- CompPortal CD dashboard stashed-routines modal.

This gives the operator immediate relief from the confusing modal flow in Phase 1, then layers the smarter triage on top.

---

## 10. Open implementation questions for plan-phase

These were not settled in the discussion. To resolve when scoping the phase plan:

1. **Schema choice** — A vs B vs C from §7.
2. **R2 holding path schema** — exact path pattern for `_versions/<take_id>/`. Lifecycle (when do holding-path objects get cleaned up — end of comp? never? operator action?).
3. **Discard folder name and location** — confirmed single shared per-comp folder, but exact path TBD (e.g., `<compDir>/_discarded/`).
4. **Filename uniqueness scheme** — operator confirmed unique filenames will prevent collisions. Format TBD: probably `<entry_number>_<recording_iso_ts>_<take_id>.mkv`.
5. **Modal countdown UX details** — visible progress bar or numeric countdown? Does hover pause the timer?
6. **Sibling take rendering in expanded row** — exact layout, controls placement, video previews vs paths only.
7. **Race conditions** — operator interacts with modal exactly as countdown hits 0; live recording stops mid-modal-open; etc.
8. **Photo re-match performance** — relinking photos on every window shift could be expensive at scale. May need batched re-match or async.
9. **Stream Deck plugin implications** — does the plugin need to know about take siblings? About the pre-record toast? About the post-record modal?
10. **Telemetry / events** — what new events are emitted for analytics / debugging (`take.displaced`, `take.stashed`, `take.reassigned`, `take.discarded`, `take.cascaded`)?

---

## 11. Differences from current behavior (quick reference)

| Aspect | Today | After redesign |
|---|---|---|
| Pre-record gate | Native OS dialog, blocks RECORD, default Cancel | Non-blocking toast, 5s, no buttons |
| Post-stop modal | "Advance vs Archive" — confuses operator | "Where does the displaced take go?" — clear three actions |
| Latest take destination | Sometimes new routine folder (Advance) | Always current routine folder |
| Modal blocking | Blocking | Non-blocking with auto-stash on 30s timeout |
| Sub-5s takes | Treated as real takes | Silent auto-discard |
| Pick-longest guard | Skips encode if new < archived | Removed |
| File archive location | `<routineDir>/_archive/vN/` per routine | Single per-comp discard folder |
| Folder auto-move on advance | Yes (silent) | No, ever |
| Time window mutability | Implicitly mutable on re-record (new window replaces old) | **Immutable** — every take owns its window forever |
| Photo handling on re-record | State `photos: undefined` (cleared) | Relinked via immutable time window; never deleted |
| Slot : take cardinality | 1 : 1 | 1 : N (1 promoted + N siblings) |
| Re-assignment workflow | None (only "advance" or "archive") | Full picker w/ title+number+notes; available from modal AND row inspector |
| Visibility of siblings | None | Expandable row inspector on every routine |
| Operator regret recovery | Limited (manual file move) | Full reassignment from row inspector at any time |
| R2 overwrite at re-record | New upload overwrites canonical keys | Eager preserve to holding path; canonical keys only updated on operator decision |

---

*End of design reference. Implementation deferred. Resume at `docs/plans/<YYYY-MM-DD>-rerecord-redesign-phase1.md` (etc.) when ready to plan/build.*
