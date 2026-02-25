# CompSync Media — v2 Changelist

**Created:** Feb 12, 2026 (from field testing on competition machine)
**Updated:** Feb 12, 2026 (analysis + decisions)
**Status:** READY TO IMPLEMENT

---

## Bugs

### 1. Stream button shows "LIVE" even when stream failed
- **Decision:** Button needs real status feedback — wasn't wired up properly
- **Files:** `src/main/services/obs.ts` (startStream, StreamStateChanged handler), `src/renderer/components/Controls.tsx` (stream button)
- **Fix:** Handle `startStream()` rejection, ensure `StreamStateChanged` event with failure state resets `isStreaming` to false. Show error feedback in UI.

### 2. Always On Top doesn't work
- **Decision:** Fix it — Settings saves the value but never calls the IPC handler
- **Files:** `src/main/index.ts:94-98` (startup apply), `src/main/ipc.ts` (APP_TOGGLE_ALWAYS_ON_TOP handler), `src/renderer/components/Settings.tsx:399` (toggle)
- **Fix:** After `settingsSet(draft)` in `handleSave()`, call `window.api.toggleAlwaysOnTop(draft.behavior.alwaysOnTop)` if value changed. Also audit other settings for similar disconnect.

### 3. NSIS installer false "app already running" warning
- **File:** `package.json:71-76` (nsis config)
- **Fix:** Add `"warningOnOtherInstanceRunning": false` to nsis section. One-liner.

---

## UI Changes

### 4. Rename "Encode Now" → "Process Video"
- **File:** `src/renderer/components/RightPanel.tsx` (button label)
- **Fix:** Rename button text. Triggers `ffmpegEncodeAll()` which splits audio tracks via FFmpeg.

### 5. Top button bar — single row
- **Files:** `src/renderer/components/Header.tsx`, `src/renderer/components/RightPanel.tsx`
- **Fix:** Merge all action buttons into one row in Header: LOAD COMP, SETTINGS, IMPORT PHOTOS, PROCESS VIDEO. Remove button duplicates from RightPanel header.

### 6. App scaling — mouse wheel zoom
- **Decision:** Ctrl+mouse wheel zoom, app-wide
- **Files:** `src/main/index.ts` (createWindow), possibly renderer for zoom level display
- **Fix:** Add `webContents.on('zoom-changed')` handler, persist zoom level in settings. Ctrl+scroll = zoom in/out. Start at ~125-150% default. Persist between sessions.

### 7. Output directory visible on main screen
- **Decision:** Show on main UI, clickable to open in Explorer, with button to change it
- **Files:** `src/renderer/components/RightPanel.tsx` (stats bar area), `src/renderer/store/useStore.ts`
- **Fix:** Add output dir display in RightPanel stats bar or below table. Click opens folder. Small "change" button triggers browse dialog.

### 8. Lower third: numerical auto-hide setting
- **File:** `src/renderer/components/Settings.tsx:370-380`
- **Fix:** Replace `<select>` dropdown with `<input type="number" min="0">` (0 = never auto-hide).

---

## Features

### 9. Lower third overlay — tenant logo + instructions
- **Decision:** Tenant logo from CompSync online (stored in tenant record). Show overlay URL instructions in Settings. Easy copy/link.
- **Files:** `src/main/services/lowerThird.ts` (overlay HTML, /overlay endpoint), `src/shared/types.ts` (LowerThirdData), `src/renderer/components/Settings.tsx` (overlay URL section)
- **Fix:**
  - Add `logoUrl` field to `LowerThirdData`
  - Fetch tenant logo from CompSync API or settings
  - Update overlay HTML to display logo
  - In Settings: make overlay URL copyable with one click, add instructions text ("Add this URL as a Browser Source in OBS, 1920x1080")
  - Overlay shows: tenant logo, routine title, studio name, entry #

### 10. NDI live preview in left panel
- **Decision:** Use NDI for real-time preview (not OBS screenshots)
- **Files:** `src/renderer/components/LeftPanel.tsx` (new preview component), `src/main/services/obs.ts` or new `ndi.ts` service
- **Investigation needed:**
  - `grandiose` npm package (Node.js NDI bindings) — check Electron compatibility
  - OBS NDI plugin must be installed on competition machines
  - NDI Runtime must be available (bundle or require install)
  - Render NDI frames in an `<canvas>` or `<video>` element via IPC
- **Fallback:** If NDI is too complex for this pass, use `GetSourceScreenshot` at 2fps as interim solution

### 11. Competition CSV export — test data ready
- **Decision:** Prepared Blue Mountain Spring Glow 2026 export from schedule_rows v3
- **Test file:** `test-data/GLOW_Blue_Mountain_Spring_2026.csv`
- **Stats:** 568 routines, 4 days (Apr 23-26), Glow tenant
- **CSV columns match schedule.ts CSVRow interface exactly:**
  - tenant_id, competition_id, entry_id, entry_number, routine_title, dancers, studio_name, studio_code, category, classification, age_group, size_category, duration_minutes, scheduled_day, position
- **No code changes needed** — CSV already works with existing parser

### 12. Recording format — make it functional
- **Decision:** App should set OBS recording format via WebSocket
- **Files:** `src/main/services/obs.ts` (connect or new setRecordingFormat method), `src/main/ipc.ts` (settings handler)
- **Fix:** On settings save (or OBS connect), call `SetProfileParameter` or `SetOutputSettings` to apply the format in OBS. Need to verify correct OBS WebSocket API call for this.

### 13. Audio Track Mapping + Audio Input Mapping — unify
- **Decision:** May need to unify into a single section
- **Files:** `src/renderer/components/Settings.tsx:159-224` (both sections)
- **Current state:**
  - Track Mapping = which OBS recording track → which role (for FFmpeg splitting)
  - Input Mapping = which OBS audio source → which meter display role
- **Fix:** Design a unified "Audio Configuration" section that maps: OBS source → role → track number. Single table instead of two separate sections.

### 14. Hotkey capture UX
- **File:** `src/renderer/components/Settings.tsx:316-352`
- **Fix:** Replace `<input type="text">` with key capture widget. On focus: "Press a key...", listen for `keydown`, capture `e.key` + modifiers (Ctrl/Shift/Alt). Display human-readable name. Escape to cancel.

---

## Priority Order

1. **Test data** (#11) — DONE, CSV ready in test-data/
2. **Bugs** (#1, #2, #3) — quick wins
3. **UI changes** (#4, #5, #6, #7, #8) — layout pass
4. **Settings fixes** (#12, #13, #14) — functional settings
5. **Lower third** (#9) — overlay enhancement
6. **NDI preview** (#10) — biggest investigation item
