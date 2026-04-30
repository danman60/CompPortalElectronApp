# Current Work — CompSyncElectronApp

**Status: 2026-04-30 ~18:34 EDT (Thursday). Burlington TOMORROW (2026-05-01). UI redesign iter-9 shipped to DART.**

---

## Branches + deploy state

- **Working tree branch:** `feat/ui-redesign-pass1` (HEAD `9c81951` — iter-9, pushed)
- **Master:** clean, last commit `7a0baf8` — Burlington-safe, no UI redesign on it
- **DART live asar:** iter-9 build = `132,269,978` bytes (built 2026-04-30 ~16:00 EDT, swapped via scheduled task `LaunchCompSyncMedia`)
- **DART backup:** `app.asar.bak` = pre-iter-9 (`132,262,825`, 2026-04-30 08:47 EDT)
- **Rollback tags:** `pre-ui-redesign-2026-04-29` at master `023b99e`; `v2.7.0-stable` at `11b97af`

Master rollback for ANY UI issue: `git checkout master` on working tree, rebuild + scp + swap. Master has none of the iter-1 → iter-9 redesign changes.

---

## What iter-9 shipped (commit `9c81951` on feat/ui-redesign-pass1)

**Right rail consolidation:**
- Single GRAPHICS card replaces the 4-card cluster (SHOW MODULES + OVERLAY & LOWER THIRD + LIVE CHAT + CHAT AS ADMIN). All four sub-surfaces still visible — no tabs.
- Entry Counter / Clock / Logo row split out from `OverlayControls` into its own `OverlayLayerToggles` module-row sitting between STARTING SOON and OVERLAY & LOWER THIRD. Edit buttons grid-aligned across Ticker / Starting Soon / Layer-Toggles via `grid-template-columns: 1fr auto auto` on `.oc-module-header`.
- Entry Counter row got an "Off" action button (red-tinted) that turns Counter+Clock+Logo all off in one click.
- "Cnt"/"Clk" labels expanded to "Entry Counter" / "Clock" / "Logo" (full text).
- Fire LT button toggles to "Hide LT" (red-orange gradient) when LT is live; standalone Hide button removed. State syncs via the existing 2s `overlayGetState` poll.
- Ticker now has explicit Edit button (was click-to-expand on header). "Edit Scene" → "Edit" on Starting Soon.

**Header:**
- File/Edit/View/Window/Help menu chrome killed via `Menu.setApplicationMenu(null)` in `src/main/index.ts`.
- Right action cluster (ActionBar + Overlay + Settings) protected with `flex-shrink: 0` so OBS stats spawning never pushes them off screen.
- Brand + SystemMonitor + meta-stats compacted with `overflow: hidden`; meter bars 38→28px, label/value tightened — Disk + REM no longer clip.
- ENCODE / UPLOAD pause buttons hidden when nothing is encoding/uploading/paused (was always-rendered + disabled).

**Layout alignment:**
- Schedule header strip removed; search input inlined in the Routine column `<th>` (className `th-routine-search`). ~40px vertical saved.
- RECORD section in `.topband-controls` width-locked to **360px** so its left edge aligns with the GRAPHICS card directly below it. Buttons in `.control-row` now wrap (`flex-wrap: wrap` + `flex: 1 1 auto`).
- `.show-rail-scroll` + `.graphics-card` + `.graphics-sub-chat` flex chain so chat strip absorbs the empty space below CHAT AS ADMIN.

**Bidirectional scratch sync:**
- CSE (`state.setCompetition`): on schedule-load, server-side `routine.status === 'scratched'` from CompPortal merges into local state. **One-way set** — never auto-clears. Local persisted state still wins for non-scratch fields (recording state, photos, etc.).
- CompPortal (`f84a6730` on main, deployed via Vercel): `/api/plugin/schedule/[competitionId]` now selects + returns `scratched_at` and `scratched_reason` and sets `status: 'scratched'` when scratched_at is non-null. Required for CSE merge to see server scratch.

---

## Burlington UDC 2026 — production data state

- Competition ID: `ab9a6076-8133-4d30-a782-770eaaac5e1c`
- Tenant: `00000000-0000-0000-0000-000000000004`
- Share code: `UDC-BURLINGTON`
- Date: 2026-05-01 to 2026-05-03

**Scratched today (via direct Supabase PATCH at 17:32 UTC = 13:32 EDT):**
| # | Title | Studio | Entry ID |
|---|---|---|---|
| 108 | BEFORE MORNING | JJ Dance Arts | `9eb82c00-8844-4b93-a777-0850d157b6f0` |
| 244 | TIRED | JJ Dance Arts | `c153a641-8634-4f01-ada9-16bf524916e7` |
| 483 | ROLLERCOASTERS | JJ Dance Arts | `1c647de0-0838-4e9a-8613-d53e112a8b58` |

To pick these up in CSE: load Burlington schedule with new asar — server scratch merges into local state automatically.

---

## Tooling discovered this session

- **Renderer screenshot via debug endpoint:** `POST http://127.0.0.1:8765/debug/test/capture-renderer` with `{outputPath, dismissModals: true}`. Requires `behavior.testHooksEnabled: true` (currently on for DART). Use `dismissModals` to click through Camera Clock Check / acknowledgement modals before capture. Pull file back with `scp dart:<path>`.
- **Screenshot path that works on locked desktop sessions** (where System.Drawing.CopyFromScreen returns blank): use the Electron debug capture above instead.
- **Launch from SSH**: `Start-ScheduledTask -TaskName 'LaunchCompSyncMedia'` attaches to user session, unlike SSH Start-Process which lands in Session 0.

---

## Deferred / potential next iterations

- Audit MKV preservation paths exhaustively (initial scan: only 2 unlinks of `outputPath` in `recording.ts`, both copy-then-unlink for cross-drive moves; archive flow uses `_archive/v{N}/` rename — never delete-without-backup).
- Update CSE memory entry to record the Stop-Process-OK rule scope (only when not in show mode), per operator clarification this session.
- Possibly merge feat/ui-redesign-pass1 → master once verified at Burlington.

---

## Iter history (feat/ui-redesign-pass1)

| Commit | What |
|---|---|
| `828f3d0` | iter-1: audio meters 12px → 22px wide, stats numbers 16px → 22px |
| `6e20484` | iter-2: stats become inline strip below meta row |
| `201ba2a` | iter-3: top row merges — meters into RECORD cell, OBS pill deduped, controls compacted |
| `000a57f` | iter-3.2: SystemMonitor strict no-wrap |
| `73f0503` | iter-8: single-strip top merge — stats inside meta row, abbreviated labels |
| `9c81951` | **iter-9: GRAPHICS card merge + RECORD/GRAPHICS column alignment + scratch sync (this session)** |
