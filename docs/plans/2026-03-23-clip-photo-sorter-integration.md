# CLIP Photo Verification & Re-Sort — Integration Plan

## Date: 2026-03-23

---

## Reframing: CLIP as Verification Layer, Not Primary Sort

The existing time-matching algorithm in `photos.ts` is the primary sort mechanism. It works well when:
- Camera clocks are reasonably accurate
- Recording windows exist for each routine
- Photos have EXIF timestamps

CLIP fills the gaps where time matching breaks down:

| Scenario | Time Matcher | CLIP Role |
|----------|-------------|-----------|
| Normal import (good EXIF, good clocks) | Primary. Exact/gap matches. | **Verify**: confirm photos in each routine actually look like the same performer |
| Camera clock drift mid-day | Offset detection handles early routines, but drift causes late-day mismatches | **Rescue**: re-assign unmatched/ambiguous photos by visual similarity to existing groups |
| No EXIF / wrong camera date | Completely fails — everything unmatched | **Full re-sort**: CLIP becomes primary, groups by visual change detection |
| Post-import correction | N/A — photos already in folders | **Re-sort tool**: user points at a folder, CLIP re-groups and lets them reassign |

---

## Architecture: Runs Locally In-App

No Python. No Firmament. No SSH. Pure Node.js inside Electron.

**Library: `@huggingface/transformers`** (Transformers.js)
- Runs CLIP via ONNX Runtime in Node.js
- Handles model download + caching automatically (~350MB for ViT-B/32)
- Already used by thousands of Electron apps
- CPU-only is fine — operator laptops don't have CUDA
- Performance: ~150ms/image on modern laptop CPU. 843 photos sampled at every 5th = 169 embeddings = ~25 seconds.

**Model: `Xenova/clip-vit-base-patch32`** (ONNX-optimized)
- Smaller than ViT-L/14 (350MB vs 900MB), still sufficient for change detection
- Cosine similarity thresholds shift slightly (0.80 instead of 0.85) but the same algorithm works

**`sharp`** (already bundled) handles image preprocessing — resize to 224x224 before feeding to CLIP.

---

## Integration Points with Existing Code

### 1. Post-Import Verification (Automatic)

After `importPhotos()` in `photos.ts` completes its time matching, CLIP runs a verification pass:

```
importPhotos() runs
  ├── Exact matches (high confidence) → CLIP spot-checks boundaries
  ├── Gap matches → CLIP verifies each one belongs
  ├── Ambiguous matches → CLIP compares to neighboring routines, upgrades or reassigns
  └── Unmatched photos → CLIP compares to all routine groups, attempts rescue
```

The verification mutates `PhotoMatch.confidence`:
- `gap` + CLIP confirms → stays `gap` (or upgrades to `exact`)
- `gap` + CLIP says wrong group → downgrades to `ambiguous`, suggests correct group
- `unmatched` + CLIP finds a match → upgrades to `gap` with suggested routine

New field on PhotoMatch: `clipSuggestion?: { routineId: string; similarity: number }`

### 2. Manual Re-Sort Tool (On-Demand)

User triggers from UI when:
- Time matching produced too many unmatched photos
- They know the camera clock was wrong
- They want to re-sort an already-imported folder

This runs the full spec algorithm (coarse scan → binary refine → preview transitions → confirm → move).

### 3. Boundary Verification (Lightweight)

Between adjacent routines, CLIP checks whether the last N photos of routine A look like the first N photos of routine B. If they're visually similar, flags a potential mis-split for user review.

---

## New Service: `src/main/services/clipVerify.ts`

```typescript
// --- Public API ---

/** Run after importPhotos(). Returns verification results. */
export async function verifyImport(
  matches: PhotoMatch[],
  routines: Routine[],
  options?: { skipExact?: boolean }
): Promise<VerificationResult>

/** Full visual re-sort of a flat photo folder. */
export async function analyzeFolder(
  folderPath: string,
  params: ClipSortParams
): Promise<ClipSortResult>

/** Execute a confirmed re-sort (copy/move into numbered folders). */
export async function executeSort(
  result: ClipSortResult,
  params: ExecuteSortParams
): Promise<void>

/** Cancel an in-progress analysis. */
export function cancel(): void

// --- Internal ---

/** Lazy-load CLIP model on first use. */
async function ensureModel(): Promise<void>

/** Compute normalized embedding for a single image. */
async function getEmbedding(imagePath: string): Promise<Float32Array>

/** Cosine similarity between two normalized embeddings. */
function cosineSim(a: Float32Array, b: Float32Array): number

/** Build a "visual fingerprint" for a routine group (mean embedding). */
async function groupFingerprint(photoPaths: string[]): Promise<Float32Array>
```

### Model Lifecycle
- Model loaded lazily on first CLIP operation (not at app startup — saves 350MB memory when unused)
- Stays loaded in memory for duration of the import session
- Unloaded after 5 minutes of inactivity (timer reset on each operation)
- Progress events for initial model download: `CLIP_MODEL_PROGRESS`

### Embedding Cache
- In-memory `Map<string, Float32Array>` keyed by file path
- Avoids recomputing if same photo appears in multiple operations
- Cleared when model is unloaded

---

## Types: `src/shared/types.ts` Additions

```typescript
// --- CLIP Verification ---

export interface ClipSuggestion {
  routineId: string
  similarity: number
}

// Extend PhotoMatch:
//   clipSuggestion?: ClipSuggestion
//   clipVerified?: boolean  // true = CLIP confirmed this assignment

export interface ClipSortParams {
  sampleRate: number        // default 5
  threshold: number         // default 0.80
  expectedGroups?: number
}

export interface ClipSortTransition {
  index: number
  similarity: number
  confidence: 'high' | 'medium'
  beforePath: string        // for thumbnail preview
  afterPath: string
}

export interface ClipSortResult {
  transitions: ClipSortTransition[]
  groups: [number, number][]   // [startIdx, endIdx]
  totalPhotos: number
  photoPaths: string[]         // ordered file paths
  embeddingsComputed: number
}

export interface ExecuteSortParams {
  destDir: string
  startNum: number
  mode: 'copy' | 'move'
}

export interface VerificationResult {
  verified: number              // photos confirmed in correct group
  reassigned: number            // photos suggested for different group
  rescued: number               // unmatched photos now assigned
  stillUnmatched: number        // couldn't find a visual match
  suggestions: Array<{
    filePath: string
    currentRoutineId?: string
    suggestedRoutineId: string
    similarity: number
  }>
}

// IPC channels:
CLIP_VERIFY_IMPORT = 'clip:verify-import'
CLIP_ANALYZE_FOLDER = 'clip:analyze-folder'
CLIP_EXECUTE_SORT = 'clip:execute-sort'
CLIP_CANCEL = 'clip:cancel'
CLIP_PROGRESS = 'clip:progress'          // progress events (renderer listens)
CLIP_MODEL_PROGRESS = 'clip:model-progress'  // model download progress
```

---

## IPC Handlers: `src/main/ipc.ts`

```typescript
safeHandle(IPC_CHANNELS.CLIP_VERIFY_IMPORT, (_, matches, routines, opts) =>
  clipVerify.verifyImport(matches, routines, opts))
safeHandle(IPC_CHANNELS.CLIP_ANALYZE_FOLDER, (_, folderPath, params) =>
  clipVerify.analyzeFolder(folderPath, params))
safeHandle(IPC_CHANNELS.CLIP_EXECUTE_SORT, (_, result, params) =>
  clipVerify.executeSort(result, params))
safeHandle(IPC_CHANNELS.CLIP_CANCEL, () => clipVerify.cancel())
```

---

## Preload: `src/preload/index.ts`

```typescript
clipVerifyImport: (matches, routines, opts?) => ipcRenderer.invoke('clip:verify-import', matches, routines, opts),
clipAnalyzeFolder: (folderPath, params) => ipcRenderer.invoke('clip:analyze-folder', folderPath, params),
clipExecuteSort: (result, params) => ipcRenderer.invoke('clip:execute-sort', result, params),
clipCancel: () => ipcRenderer.invoke('clip:cancel'),
```

---

## UI Changes

### A. Verification Badge on Import Results

After `importPhotos()` + `verifyImport()`, the photo import results panel shows:
- Green check on photos CLIP confirmed
- Yellow warning on photos CLIP thinks are in the wrong routine (with "Move to Routine X?" action)
- Orange rescue icon on previously-unmatched photos CLIP found a home for
- Red X on still-unmatched photos

This is a non-blocking enhancement to the existing import flow — the import still works exactly as before, CLIP just annotates the results.

### B. Re-Sort Panel (New)

Accessible from: Settings or a dedicated button ("Sort Photos by Subject").

Minimal UI — follows the same pattern as the spec's Section 6:

**Step 1: Setup**
- Source folder picker (reuses `browseForFolder()`)
- Destination folder picker
- Starting routine number (default: from loaded schedule)
- Expected groups input (optional)
- Sensitivity slider (0.70 – 0.95)
- Copy vs Move toggle

**Step 2: Progress**
- Phase indicator + progress bar
- "Downloading model..." (first time only)
- "Computing embeddings 45/169..."
- "Refining transitions..."
- Cancel button

**Step 3: Transition Review**
- Side-by-side thumbnails (last photo of group N / first of group N+1)
- Similarity score + confidence badge
- Adjust buttons (shift boundary +/- 1 frame)
- Accept/reject per transition

**Step 4: Confirm & Execute**
- Summary: "5 groups, 843 photos, routines 87-91"
- Confirm button → copies/moves files
- Progress bar for file operations

### Files:
- `src/renderer/components/PhotoSorter.tsx` — re-sort panel
- `src/renderer/components/TransitionPreview.tsx` — before/after viewer
- `src/renderer/styles/photo-sorter.css`
- Edit `src/renderer/store/useStore.ts` — add clipVerify state slice

---

## Dependency: `@huggingface/transformers`

```bash
npm install @huggingface/transformers
```

- ~5MB package, downloads models on first use
- Models cached in `~/.cache/huggingface/` (or app userData)
- electron-builder: add to `asarUnpack` if native ONNX runtime bindings need it

electron-builder config addition:
```json
"asarUnpack": [
  "node_modules/@huggingface/transformers/**/*",
  "node_modules/onnxruntime-node/**/*"
]
```

---

## Integration with Existing `importPhotos()` Flow

The key change to `photos.ts` is minimal — after the existing matching completes, optionally call CLIP verification:

```typescript
// At end of importPhotos(), after matchPhotosToRoutines():

if (settings.clipVerificationEnabled) {  // default: true
  sendToRenderer(IPC_CHANNELS.PHOTOS_PROGRESS, {
    stage: 'clip-verify', total: matches.length, current: 0
  })
  const verification = await clipVerify.verifyImport(matches, routines)
  // Apply suggestions to matches (user can review/accept in UI)
  result.clipVerification = verification
}
```

The existing flow is untouched. CLIP is additive. If the user turns it off or it fails, everything works exactly as before.

---

## Performance Estimates (Local CPU)

Using `clip-vit-base-patch32` via ONNX Runtime:

| Scenario | Photos | Embeddings | Est. Time | Memory |
|----------|--------|-----------|-----------|--------|
| Small import (100 photos) | 100 | 20 sampled + 10 refine | ~5s | ~400MB |
| Typical day (843 photos) | 843 | 169 + 50 | ~25s | ~400MB |
| Full day (5,000 photos) | 5000 | 1000 + 200 | ~3 min | ~400MB |
| Monster day (20,000 photos) | 20000 | 4000 + 400 | ~11 min | ~400MB |

Memory is bounded — one image processed at a time, only embeddings (768 floats each) accumulate.

For verification-only (post-import), much faster — only need to compute embeddings for boundary photos + unmatched photos, not the full coarse scan.

---

## File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `src/main/services/clipVerify.ts` | **Create** | CLIP model loading, embedding, verification, re-sort |
| `src/shared/types.ts` | Edit | ClipSuggestion, ClipSortParams, VerificationResult, IPC channels |
| `src/main/services/photos.ts` | Edit | Call clipVerify.verifyImport() after matching (opt-in) |
| `src/main/ipc.ts` | Edit | Register 4 CLIP handlers |
| `src/preload/index.ts` | Edit | Expose 4 CLIP methods |
| `src/renderer/components/PhotoSorter.tsx` | **Create** | Re-sort panel UI |
| `src/renderer/components/TransitionPreview.tsx` | **Create** | Side-by-side transition viewer |
| `src/renderer/styles/photo-sorter.css` | **Create** | Styles |
| `src/renderer/store/useStore.ts` | Edit | Add clipVerify + photoSort state |
| `src/renderer/App.tsx` | Edit | Route/render PhotoSorter panel |
| `src/renderer/components/LeftPanel.tsx` | Edit | Add nav entry for re-sort |
| `src/main/services/settings.ts` | Edit | Add `clipVerificationEnabled` setting |
| `package.json` | Edit | Add `@huggingface/transformers` dependency |
| `electron-builder` config in package.json | Edit | asarUnpack for ONNX runtime |

---

## Implementation Order

1. **`@huggingface/transformers` spike** — Confirm CLIP model loads and produces embeddings in Electron main process. Test with 10 images. Validate ONNX runtime works in packaged app.

2. **`clipVerify.ts` core** — Model loading, embedding computation, cosine similarity. Unit-testable functions.

3. **Verification flow** — `verifyImport()` that takes existing PhotoMatch results and annotates them. Wire into `photos.ts` import flow.

4. **Re-sort algorithm** — `analyzeFolder()` implementing coarse scan + binary refinement from the spec.

5. **IPC + preload wiring** — Standard pattern, mechanical.

6. **UI: verification badges** — Annotate existing import results panel.

7. **UI: re-sort panel** — Setup → progress → transition review → execute.

8. **Settings toggle** — `clipVerificationEnabled` in Settings panel.

9. **electron-builder packaging** — Ensure ONNX runtime + model caching work in packaged .exe.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| ONNX runtime native binding fails in packaged Electron | Spike this first (step 1). Fall back to WASM runtime if needed (slower but no native deps). |
| 350MB model download on first use feels slow | Show download progress bar. Cache in userData so it persists across updates. |
| Memory pressure on 8GB laptops | Model is ~400MB resident. Unload after 5min idle. Process one image at a time. |
| ViT-B/32 less accurate than ViT-L/14 | For change detection (not recognition), B/32 is sufficient. Threshold tuned lower (0.80). Can upgrade to L/14 later if needed. |
| Camera raw formats (.CR2, .NEF) | Phase 1: JPEG only (95% of competition photos). `sharp` can convert common raws if needed later. |
