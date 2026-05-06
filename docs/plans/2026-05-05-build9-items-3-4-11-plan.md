# Build #9 — Plan for items #3, #4, #11

**Date:** 2026-05-05 EDT
**Branch:** `feat/ui-redesign-pass1` (uncommitted feature work already on it)
**Scope:** Three items from the build9 fix list: Move-after-routine button, Unified event log, Server-side chat pin design.

Items #15 (operator-app parity), #7 (frame-perfect slow zoom), #16 (longer stinger) are handled elsewhere or obsoleted — marked done in `2026-05-03-build9-fix-list.md`.

---

## #3 — "Move after routine X" button on routine row

### Context

Drag-and-drop reorder already works (RoutineTable.tsx:799-829). It writes to `competition.displayOrder?: string[]` via `window.api.stateSetDisplayOrder(routineIds)` (preload:170). Order is **local only** — not synced to CompPortal. Routine `id` field is uuid; user-facing label is `entry_number` / routine number.

Operator complaint: drag-drop is fine for nudging a routine 2-3 rows, but jumping a routine across 200 rows requires either holding the cursor on edge-scroll or scrolling first then dragging. A button-driven move handles long jumps cleanly.

### Design

Per-row "Move…" button (or repurposed kebab menu entry) opens a small popover anchored to that row. Popover contents:

- Search/filter input (type-to-narrow target list — same existing routine filter logic available in RoutineTable).
- Scrollable list of all *other* routines, each rendered as `R{number} — {studioName} · {dancers}` (same density as the table row).
- Click target row → splice the source routine **after** that target → call `stateSetDisplayOrder(newOrder)` → close popover.
- Esc / click-outside closes without changes.
- Keyboard: ↑/↓ navigate, Enter commits.

Reuse the existing `ReassignPopover` component as the structural reference (already does anchored popover + filter + commit). Don't merge into it — that one is for in-flight take reassignment; this is a pure reorder.

### Code touchpoints

- `src/renderer/components/RoutineTable.tsx` — add row-level button (next to existing drag handle column or in kebab menu), wire to a new `MoveAfterPopover` component. Reuse the `reorderRoutine` helper logic but parameterize as `moveAfter(sourceId, targetId)` (target index = idx_of(target) + 1, then splice source).
- `src/renderer/components/MoveAfterPopover.tsx` — NEW. Modeled on `ReassignPopover.tsx`. Module-level `requestMoveAfter({ sourceRoutine })` so RoutineTable can fire it.
- `src/renderer/styles/table.css` — small button + popover styles. Match existing kebab/icon button density.
- No main-process changes — `stateSetDisplayOrder` IPC already exists.

### Open questions (need operator answer before coding)

- **A.** Where does the button live: separate icon column, kebab menu on the row, or merged into the existing drag-handle cell?
- **B.** Does "Move after" need a sibling "Move before"? Or always after, with target picking compensating?
- **C.** Should the popover support choosing between `before` / `after` the target inline (radio at top), or always after?

### Effort

~45-90 min once design Qs answered. No backend, no schema, no DART.

---

## #4 — Unified event log window

### Context

Backend infra **already exists**:
- `src/main/services/events.ts` — `emit(kind, data)` writes JSONL to `events.log` AND keeps a 2000-entry in-memory ring buffer.
- `getRecent(limit, kindFilter)` and `getKinds()` exposed.
- HTTP endpoint `/debug/events` already serves the ring (debugServer.ts:294).
- ~30+ emit sites across services covering: `drive.detected`, `drive.clockMismatch`, `drive.missingPhotos`, `import.requested/started/finished/failed`, `import.exif.progress`, `import.match.summary`, `queue.enqueued/status`, `recording.archived`, `audio.flatline.warning`, `offsetDetector.decision`, `chat.message.received/backfill.ok`, `debugServer.*`, `perfWorker.*`.

What's missing:
- **Renderer-side stream.** Today the renderer sees only ad-hoc IPC channels per concern (PHOTOS_PROGRESS, etc) — there's no firehose IPC of `events.emit` calls. The event log UI needs that firehose.
- **UI panel.** No dedicated event-log component — toast soup is the current surface.
- **Toast retirement.** AutoToggleToast, ReconcileToast, OffsetConfirmToast, MissingPhotosToast, StartupToast, ImportSummaryToast, AudioAuditBanner pass toast, DriveAlert clockMismatchToast, "Import complete" — all routed from explicit IPC channels, not from `events.emit`. Decision needed per toast: route into log only, log + keep dismissable banner, or stay as-is (e.g., StartupToast is genuinely modal-ish).

### Design

**Layer 1 — main → renderer event firehose.**
- New IPC channel `IPC_CHANNELS.EVENT_STREAM` broadcast.
- Tap into `events.emit` in events.ts: after the existing ring/file write, also `BrowserWindow.getAllWindows().forEach(w => w.webContents.send(IPC_CHANNELS.EVENT_STREAM, record))` (best-effort, no throw).
- Preload exposes `onEvent(cb)` returning unsubscribe.

**Layer 2 — renderer event store.**
- Zustand slice in `useStore.ts`: `events: EventRecord[]` (last 500), plus `eventLogVisible: boolean`.
- Subscribe once at App mount. Initial backfill via `window.api.eventsGetRecent(500)` IPC call so the panel doesn't open empty mid-session.

**Layer 3 — `EventLogPanel.tsx` component (operator-corrected sizing 2026-05-05).**

**Sizing constraint.** EventLogPanel mounts as a third column in `.left-panel-top`, **same width as the existing `.record-col` (Record Panel — Controls.tsx)**. New ratio:

```
.current-routine-col  : flex 3   (was flex 2 — currently dominant column, becomes 3/5)
.record-col           : flex 1   (unchanged — 1/5)
.event-log-col        : flex 1   (NEW — 1/5)
.left-panel-top-meters: fixed    (unchanged — vertical meters)
```

Net: Current Routine drops from 2/3 to 3/5 of the non-meters width; Record + Event Log each take 1/5.

**Visual design — must be UI-beautiful.** This is a primary always-visible surface during a show, sitting next to Current Routine. Treat it as a hero panel, not a debug dump.
- Header bar matching the existing Controls panel header style — same height, same gradient/treatment, label "Activity" or "Event Log".
- Body: vertical scrolling list of event cards (NOT bare table rows). Each card:
  - Left edge color stripe (severity: green=ok, amber=warning, red=error, blue=info, neutral=default).
  - Top line: bold short label (e.g., "Photos imported", "Drive removed", "Encode complete") — derived from a `formatEvent(record)` registry that maps kind → human label.
  - Sub-line: data summary (e.g., "147 matched · 3 unmatched · folder=…/SD-CAM2") — single line, truncate with ellipsis, full text on hover.
  - Right side: small relative time (`now`, `12s`, `4m`, `2h`).
  - Hover state lifts subtly; click expands to show raw JSON inline.
- Sticky filter chips row at top: `All · Imports · Drives · Encode · Upload · Audio · Chat · Errors`. Multi-select. Active chip filled, inactive outlined. State persisted.
- Empty state: pleasant illustration / muted text "No events yet" — not a blank box.
- Auto-scroll to bottom on new event UNLESS operator scrolled up — then show floating "↓ N new" pill at bottom.
- Severity stripe colors match the existing app palette (lift values from `.startup-toast`, `.audio-audit-banner`, etc — don't introduce new accent colors).
- Animate new event entry: 200ms fade-in + slight slide-down so the operator's eye catches it without being disruptive.
- Density: ~6-8 visible cards at the panel's natural height. Not too dense, not too sparse.
- No filter chip can hide critical errors — `errors` filter chip is non-suppressible (always shows red regardless of other chip state) per spec intent (operator must always see errors).

**Layer 4 — toast cleanup.**
Per toast, choose one of:
- **Retire entirely** — fully expressible as event log entries: `ReconcileToast`, "Import complete" toast, `AutoToggleToast`, "Tablet auto-refresh" notifications (#19).
- **Keep, also log** — operator-attention items still need a banner: `MissingPhotosToast` (action button), `OffsetConfirmToast` (accept/skip), `StartupToast` (FirstRun gate), `AudioAuditBanner` warn/error variants (still need persistent banner on real fail).
- **Already a banner** — `DriveAlert.clockMismatchToast` stays as-is (corner toast per existing 2026-04-19 spec).

This separation keeps the principle of **never block the start of a recording** intact while removing transient noise that overlaps the Current Routine card.

### Code touchpoints

- `src/main/services/events.ts` — add `subscribeToEmit(cb)` exporting fanout, OR import `BrowserWindow` directly (former is cleaner; events.ts has no electron imports today).
- `src/main/index.ts` — wire the BrowserWindow fanout subscriber once main window is ready.
- `src/main/ipc.ts` — `EVENTS_GET_RECENT` handler (calls `events.getRecent`).
- `src/preload/index.ts` — `onEvent(cb)` + `eventsGetRecent(limit, kind?)`.
- `src/shared/types.ts` — `EventRecord` shape, `IPC_CHANNELS.EVENT_STREAM`.
- `src/renderer/store/useStore.ts` — `events`, `eventLogVisible`, setters, `MAX_EVENTS_IN_RENDERER = 500`.
- `src/renderer/components/EventLogPanel.tsx` — NEW.
- `src/renderer/styles/event-log.css` — NEW.
- `src/renderer/App.tsx` — mount `<EventLogPanel />`, subscribe + backfill at startup, retire/route the listed toasts.

### Open questions (operator design Qs A-E from the fix list, restated concretely)

- **A. Default visibility on launch:** open / collapsed-ticker / fully hidden?
- **B. Persistence beyond session:** events.log already disk-resident; should the renderer panel show only since-app-started, OR support "load yesterday" for incident review?
- **C. Anchor point:** top-left fixed (per spec), OR a floating window the operator can drag? Top-left dock is simpler and matches operator's stated preference; floating-window adds drag bookkeeping.
- **D. Toast retirement granularity:** confirm the "Retire entirely / Keep banner / Already a banner" partition above, or override per-toast.
- **E. Severity coloring:** keep kind-suffix-based mapping (`.failed/.warning/.error`), or add a per-event explicit severity field at emit sites? Kind-suffix is zero-migration; explicit field is cleaner long-term but ~30 emit-site touch.

### Effort

~3-5 hours: ~30 min wiring fanout + IPC, ~90 min EventLogPanel UI, ~90 min toast cleanup + retire/route decisions, ~30 min event formatters, ~30 min styles + persistence. No DART, no schema migration.

---

## #11 — Two pin destinations: Burn-into-video vs Livestream-only

### Context (operator-corrected 2026-05-05)

**Today's pin behavior burns the pinned message INTO the recorded video.** Pin click → `onMessagePinned` → LT-style overlay broadcast → OBS scene composites it → encoded video bakes it in permanently. That's the only path; once a message is pinned, the studios get it on their judge/archive video.

**Operator wants two distinct destinations:**

1. **Pin → Video** (current behavior, kept): LT overlay through OBS, baked into the recording. The studio's judge/archive video shows it.
2. **Pin → Livestream-only** (NEW): overlays on the CompPortal livestream player ONLY. Composited at the viewer's browser, on top of the video stream. Never enters OBS, never burns into the recording. Online viewers see it; the studio's archive video does not.

Both options must be available — a message can be sent to one, the other, or both, per pin click.

The chat **messages** themselves are already server-authoritative (Supabase Realtime + `/api/livestream/chat` REST backfill). What's missing is a separate "livestream pin" channel that CompPortal's livestream player listens to and overlays client-side.

CompPortal-2 (sibling session) currently brings `/dashboard/admin/livestream` to feature parity. The livestream-pin overlay layer is the natural pair to that work.

### Design

#### CompPortal side (sibling session)

- New table or row column: `livestream_pinned_messages` — message id, pinned_at, pinned_by, expires_at?. Or a column on the chat row: `livestream_pinned_at: timestamptz | null` (lighter, recommended).
- New plugin-token endpoints:
  - `POST /api/plugin/chat/{id}/livestream-pin`
  - `DELETE /api/plugin/chat/{id}/livestream-pin`
- Realtime broadcast on UPDATE so the livestream player sees pin changes within ~200ms.
- Livestream player overlays the pinned message client-side (CSS-positioned banner, NOT in the video stream). Style matches the LT banner aesthetic but lives in browser DOM.
- Multiple pins allowed — same `MAX_PINNED = 10` cap as in CSE.

#### CSE side

- Chat panel pin button becomes a 2-way control. Two clean options:
  - **Option α (split button):** two icon buttons per message — `▶📹` (burn-into-video) and `▶🌐` (livestream-only). Each toggles independently. Visual states: outlined (off) / filled (on). Clear at a glance.
  - **Option β (chord menu):** single pin button → small popover with two checkboxes: "Burn into recording" / "Livestream only". Operator picks one or both, hit Enter or click pin. More clicks but cleaner row UI.
  - **Recommendation: α** — two icon buttons. Lower friction, faster, visual state is unambiguous mid-show. Chord menus add latency to a pin click during live operation.
- Existing `chatPin` IPC stays for the burn-into-video path. New `chatLivestreamPin` IPC for the livestream-only path.
- `chatBridge.ts` extension:
  - `livestreamPinMessage(id)` — POST to CompPortal endpoint. Does NOT call `onMessagePinned` (that's the OBS-burn path). Best-effort with retry.
  - `livestreamUnpinMessage(id)` — DELETE.
  - On startup: backfill `livestream_pinned_at` from CompPortal so the chat panel reflects current livestream-pin state across CSE restarts.
  - Subscribe to chat row UPDATEs over realtime to mirror livestream-pin state changes (so multi-CSE / admin-dash changes converge).

#### Visual distinction in the chat panel

- A chat row can be pinned to neither, video, livestream, or both. Render two small badges on the row: 📹 (video-pinned) and 🌐 (livestream-pinned). Different colors. Clicking the corresponding button toggles only that destination.
- Pinned-section header in `PanelChat.tsx` splits into "Pinned to video" and "Pinned to livestream" sub-lists for clarity (or one merged list with badges). Recommend split sub-lists — operator can see at a glance what's bleeding into recordings vs. just on stream.

### Code touchpoints

**CompPortal repo (sibling session):**
- Migration: `livestream_pinned_at timestamptz | null` on chat row.
- Plugin-auth POST/DELETE endpoints.
- Livestream player: subscribe to chat row UPDATE realtime; overlay component composited over the player.

**CSE:**
- `src/main/services/chatBridge.ts` — `livestreamPinMessage(id)`, `livestreamUnpinMessage(id)`, `getLivestreamPinned()`. Realtime UPDATE handler for the new column. Chat backfill includes the new column.
- `src/main/ipc.ts` — `CHAT_LIVESTREAM_PIN` / `CHAT_LIVESTREAM_UNPIN` channels.
- `src/preload/index.ts` — `chatLivestreamPin(id)` / `chatLivestreamUnpin(id)`.
- `src/shared/types.ts` — `PinnedChatMessage` extends with destination flags, OR keep as-is and add `LivestreamPinnedMessage` separate type. Recommend separate typed list to keep destinations cleanly distinct.
- `src/renderer/store/useStore.ts` — `chat.livestreamPinned` slice (parallel to existing `chat.pinned`).
- `src/renderer/components/PanelChat.tsx` + `ChatPanel.tsx` — two pin buttons per row, two sub-lists in the pinned header.

### Open questions

- **A.** Confirm two-icon-button UI (α) vs chord menu (β).
- **B.** Pinned-section header: split sub-lists ("Pinned to video" / "Pinned to livestream") or merged with badges?
- **C.** Does the livestream-pin overlay design match CSE's LT banner styling, or is it its own visual treatment? (CompPortal-2's call.)
- **D.** Cap behavior: independent caps (10 video-pinned + 10 livestream-pinned) or shared 10-total? Recommend independent.
- **E.** Order of CompPortal vs CSE work: CompPortal endpoints + livestream player first (sibling session), then CSE wires to them. Or define the contract now, both sides implement in parallel.

### Effort

CSE side: ~3-4 hours (new IPC channels, chatBridge extension, realtime UPDATE handler, chat-panel UI for two pin buttons + split sub-lists, store slice).
Cross-session coordination: contract handoff via INBOX.md to CompPortal-2.
Net: ready when contract is locked with sibling session.

---

## Suggested implementation order

If operator answers design Qs in batch and gives go:

1. **#3 first** — smallest, no cross-session, no DART. Quick UX win the operator already wants.
2. **#4 second** — substantial but self-contained. Removes toast soup, gives the operator a single place to watch the system. After landing, operator can use it to pre-flight #11 (chat events flow through the same panel).
3. **#11 third** — coordinate with CompPortal-2 for the API contract. Implementation in CSE is small once contract is locked.

---

## Out-of-scope reminders

- Don't touch `/dashboard/admin/livestream` parity — CompPortal-2 owns it.
- Don't combine any of these with the build8m DART cutover — separate gated action.
- Don't auto-commit — operator gates push per current branch state.
