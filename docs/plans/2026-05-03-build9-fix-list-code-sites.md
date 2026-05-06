# Build #9 fix list — code site map (captured 2026-05-04 00:00 EDT)

Companion to `2026-05-03-build9-fix-list.md`. For each item, primary file:line locations.

## CompSyncElectronApp items

### 2. Simplify hash matching of photos
- `src/main/services/photos.ts:1000` — seenHashes init
- `src/main/services/photos.ts:1011-1012` — seenHashes.add() from routine.photos[].sourceHash
- `src/main/services/photos.ts:1323` — dedup decision

### 3. "Move after routine X" button on routine row
- `src/renderer/components/RoutineTable.tsx:772-802` — reorderRoutine() + drag-drop handler
- `src/renderer/components/RoutineTable.tsx:1013-1027` — row action button area (where Cancel/View live)

### 4. Unified event log window (replaces toasts)
- `src/renderer/components/DriveAlert.tsx:117` — DriveAlert (PHOTOS_PROGRESS feed)
- `src/renderer/components/AudioAuditBanner.tsx:61` — AudioAuditBanner
- `src/renderer/components/Header.tsx:424` — ImportPill
- + OverlayControls upload-progress events

### 5. Jump-to instead of filter
- `src/renderer/components/RoutineTable.tsx:725-736` — search builds searchMatchIds (no filter)
- `src/renderer/components/RoutineTable.tsx:662-671` — searchQuery effect, scrolls first match into view

### 6. Judge-backup-audio reminder on first routine of session
- `src/renderer/components/RoutineTable.tsx:378-488` — buildGroupedList() session divider logic
- `src/renderer/components/RoutineTable.tsx:411-412` — divider creation (gapMinutes, idleStart/End)
- `src/renderer/components/RoutineTable.tsx:582` — currentRoutine state hook

### 7. Frame-perfect slow zoom + more transitions
- `src/main/services/slowZoom.ts:1-120` — slow zoom module (33ms tick)
- `src/main/services/wsHub.ts:264-292` — cycleTransition case

### 8. Crash blur zoom transition wide↔tight
- `src/main/services/slowZoom.ts:17-25` — scene/source constants
- `src/main/services/wsHub.ts:264-292` — transition cycle / setCurrentTransitionByName path

### 10. "Import complete" toast → event log
- `src/main/services/photos.ts:2110-2112` — logger.photos.info("Import complete: ...")
- `src/main/services/photos.ts:2100-2108` — PHOTOS_PROGRESS 'done' stage IPC

### 11. Server-side chat pin vs local
- `src/renderer/components/OverlayControls.tsx:375-382` — togglePin() / chatUnpin() / chatPin() IPC
- `src/main/services/overlay.ts:575-591` — chat-fire handler
- `src/renderer/components/OverlayControls.tsx:347` — chatGetPinned() poll

### 12. LT center-up position / editable
- `src/shared/types.ts:1190` — DEFAULT_LAYOUT lowerThird (x:2, y:82)
- `src/main/services/overlay.ts:970` — `.lower-third` CSS positioning
- `src/main/services/overlay.ts:701-724` — updateLayout() / getLayout()

### 13. Ticker app↔SD sync BUG (build #8b regression)
- `streamdeck-plugin/src/actions/overlay-toggle.ts:58-69` — OverlayTickerAction watches state.overlay.ticker.visible
- `streamdeck-plugin/src/connection.ts:27` — AppState.overlay.ticker shape
- `src/main/services/wsHub.ts:95` — broadcastState() (where main publishes overlay state)

### 14. Duplicate record-status button — remove
- `src/renderer/components/Controls.tsx:136` — primary record-cta button (RECORD/STOP RECORDING)
- `src/renderer/components/Controls.tsx:153-159` — secondary "record" class button (Record/Stop Rec)
- Both call handleToggleRecord() — pick one, remove the other

### 16. Longer full-screen stinger w/ studio logo
- `src/shared/types.ts:1200` — DEFAULT_SETTINGS transitionCycleOrder (includes 'UDC Stinger')
- `src/main/services/wsHub.ts:271-290` — cycleTransition resolves stinger by name
- Stinger video asset is OBS-side, not in this tree

### 17. Keep pushing LT/counter motion
- `src/main/services/overlay.ts:1730` — LT_ANIMS array (9 variants)
- `src/main/services/overlay.ts:926-931` — counter @keyframes counterPop
- `src/main/services/overlay.ts:979-1000+` — LT animation definitions

### 18. Looping UDC logo animation
- `src/main/services/overlay.ts:1200-1216` — `.ss-logo` animation classes (pulse, float, spin, breathing, glow — most already infinite)
- `src/main/services/overlay.ts:1219-1240` — @keyframes ss-logo-*
- `src/main/services/overlay.ts:2246-2266` — animation duration scaling via `--ss-logo-anim-dur`

### 19. Tablet auto-refresh on display freeze
- `src/main/services/wifiDisplay.ts:404-412` — childProc.stderr listener (where capture-error fires)
- `src/main/services/wifiDisplay.ts:423-439` — childProc 'exit' handler with auto-restart logic
- `src/main/services/wifiDisplay.ts:435-439` — restart guard (MAX_UNEXPECTED_EXIT_RESTARTS=3)

## External repo items

### 1. Admin dash full operational parity + "Starting soon"
- `CompPortal/src/app/dashboard/admin/livestream/page.tsx:115` — currentRoutine machine snapshot
- `CompPortal/src/app/dashboard/admin/livestream/page.tsx:1359-1368` — snapshot display
- Missing: "what's next", "Starting soon" indicator
- Note: `StartingSoonState` / `StartingSoonLayout` / `StartingSoonPreset` already exist in CSE `src/shared/types.ts` (overlay-side types) — not the same as admin-dash component

### 9. Tablet button layout (top row + cycle trans, no logo)
- `CSController/app/src/main/java/com/compsync/controller/ui/DisplayScreen.kt:40-46` — DisplayScreen composable
- `CSController/app/src/main/java/com/compsync/controller/ui/DisplayScreen.kt:61-70` — Column layout

### 15. Operator app full parity (ticker edit, program preview)
- Same `CSController/.../DisplayScreen.kt` — currently consumes wsController state but doesn't expose ticker editing or program preview surface
