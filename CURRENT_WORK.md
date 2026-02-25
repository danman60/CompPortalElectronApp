# Next Build — v2.4.2

## Fixed (ready to build)

1. **Lower third empty when routine is active** — `syncOverlayFromCurrent()` added to `broadcastFullState()` so overlay data syncs on all state changes
2. **Clock position** — Moved from bottom-left to just under routine # counter (`top:130px; right:40px`)
3. **AudioMeters crash on load** (v2.4.1) — Added `audioMeters` to Zustand store with safe default
4. **`require is not defined`** (v2.4.1) — Replaced runtime `require()` with ESM import in useStore.ts
5. **Jump during recording** — Blocked routine clicks while OBS is recording + `not-allowed` cursor
6. **Recording attributed to wrong routine** — `activeRecordingRoutineId` tracks which routine started recording, used on stop instead of current pointer
7. **Encoding shows "Encoded" prematurely** — Added `'queued'` RoutineStatus. Second job gets 'queued' until ffmpeg actually starts it, then transitions to 'encoding'
8. **Media folder structure** — Now uses `Tenant/CompName/Entry#` subfolder structure when loaded via share code

## Known behavior (not bugs)

- **Each split file is same size as source** — Copy mode (`-c copy`) duplicates video into each output. A 4-min 1080p recording = ~450MB per file × 4 files. This is expected since each judge needs video+audio for playback. Re-encode mode (720p/1080p) would compress but is much slower.
