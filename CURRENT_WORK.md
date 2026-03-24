# Current Work - CompSync Electron App

## Last Session Summary
CS-CLIP session (2026-03-24): Built full CLIP photo sorter — backend service with ONNX CLIP inference + IPC wiring, and UI with 5-screen state machine. Both committed and pushed.

## What Changed (2026-03-24 CS-CLIP session)

**Backend (commit `9c07751`):**
- `src/main/services/clipVerify.ts` — 6 public functions: verifyImport, analyzeFolder, executeSort, cancel + lazy model loading, embedding cache, cosine similarity
- 4 CLIP IPC handlers wired in `ipc.ts`
- 4 CLIP API methods added to preload
- `asarUnpack` updated for transformers + onnxruntime

**UI (commit `a2bd4bc`):**
- `src/renderer/components/PhotoSorter.tsx` — 5-screen state machine (setup -> analyzing -> review -> executing -> done/error)
- `src/renderer/components/TransitionPreview.tsx` — confidence-badged transition cards
- `src/renderer/styles/photo-sorter.css` — dark theme modal matching app palette
- Zustand `photoSort` state slice with progress tracking in `useStore.ts`
- "Sort Photos by Subject" button added to LeftPanel
- `App.tsx` updated with PhotoSorter integration

## Build Status
PASSING — `npm run build` clean

## Known Bugs & Issues
None identified — needs real-world testing.

## Next Steps (priority order)
1. Test CLIP model loading in packaged Electron (ONNX runtime in asar)
2. Wire verification into existing `importPhotos()` flow
3. End-to-end test with real competition photos on FIRMAMENT
4. Test confidence thresholds with edge cases (similar routines, group shots)
5. Package and deploy to FIRMAMENT for user testing

## Gotchas for Next Session
- Uses `@huggingface/transformers` (Transformers.js) for local CLIP inference — no Python needed
- Model is `Xenova/clip-vit-base-patch32` (~350MB, downloads on first use)
- CLIP is a verification/rescue layer on top of existing EXIF time matching, NOT a replacement
- `onnxruntime-node` needs `asarUnpack` in electron-builder config (already configured)
- Integration plan at `docs/plans/2026-03-23-clip-photo-sorter-integration.md`
