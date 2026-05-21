#!/usr/bin/env node
/**
 * exif-bookmark change isolator — toggles ONLY the per-(serial,subfolder)
 * filename pre-read bookmark delta in photos.ts. The orphan-resume fix
 * (ffmpeg.ts) and photo-tier fix (jobQueue.ts/upload.ts) are NEVER touched.
 *
 * The delta is two byte-exact regions in src/main/services/photos.ts:
 *   R1  the pre-skip if/else-if chain (the actual filename-skip work)
 *   R2  the post-import bookmark-advance block
 * The state.ts API additions stay present in BOTH variants (harmless when
 * unused; the harness build-detect keys off behavior, not their existence) so
 * the file still compiles and the ONLY behavioral difference is "does the
 * import pre-skip + advance the filename bookmark or not". UNPATCHED == today's
 * behavior: full read, EXIF cursor is the sole import-side gate.
 *
 *   revert -> UNPATCHED (pre-skip + advance disabled; orphan+photo-tier kept)
 *   apply  -> PATCHED   (restore byte-exact from the snapshot)
 *
 * Each replacement must match EXACTLY ONCE or the script aborts (no silent
 * partial toggle => no unfaithful run). `apply` restores from a byte-exact
 * snapshot taken by run-harness.sh before the first revert.
 */
import fs from 'node:fs'

const ROOT = '/home/danman60/projects/CompSyncElectronApp'
const PHOTOS = `${ROOT}/src/main/services/photos.ts`
const SNAP = process.env.EB_PHOTOS_SNAP || '/tmp/cse-eb-photos-patched.ts'

const mode = process.argv[2]
if (mode !== 'apply' && mode !== 'revert') {
  console.error('usage: toggle-patch.mjs <apply|revert>')
  process.exit(2)
}

function readPhotos() { return fs.readFileSync(PHOTOS, 'utf8') }
function writePhotos(s) { fs.writeFileSync(PHOTOS, s) }

if (mode === 'apply') {
  if (!fs.existsSync(SNAP)) {
    console.error(`apply: snapshot ${SNAP} missing — cannot restore PATCHED`)
    process.exit(2)
  }
  fs.copyFileSync(SNAP, PHOTOS)
  const s = readPhotos()
  if (!s.includes('if (filenamePreSkipEnabled && partitionedPaths.length > 0) {')) {
    console.error('apply: restored file missing pre-skip block — snapshot bad')
    process.exit(2)
  }
  console.log('PATCHED restored from snapshot (byte-exact).')
  process.exit(0)
}

// ---- revert: produce UNPATCHED ----------------------------------------------
let src = readPhotos()

// photos.ts on the operator's Windows-checkout tree uses CRLF line endings.
// All anchor strings below are authored with LF; to match either EOL we
// detect the file's dominant EOL and rewrite anchors + replacements to use
// it. We preserve the file's EOL on write (no accidental CRLF<->LF churn,
// which would also corrupt the orphan/photo-tier diff). `apply` restores the
// PATCHED file byte-exact from the snapshot, so EOL there is preserved
// regardless.
const EOL = src.includes('\r\n') ? '\r\n' : '\n'
const toEOL = (s) => (EOL === '\n' ? s : s.replace(/\n/g, EOL))

// R1: the entire pre-skip if/else-if chain. Anchor: from the `if
// (filenamePreSkipEnabled && partitionedPaths.length > 0) {` line through the
// closing `  }` immediately before the blank line + `// Retired by build9o:`
// comment. We capture greedily but bounded by that unique trailing comment.
const R1_START = '  if (filenamePreSkipEnabled && partitionedPaths.length > 0) {'
const R1_END_ANCHOR = toEOL('\n\n  // Retired by build9o: skippedByFilenameDedup (no longer used as a dedup')
const i1 = src.indexOf(R1_START)
const i1end = src.indexOf(R1_END_ANCHOR)
if (i1 < 0 || i1end < 0 || i1end <= i1) {
  console.error('revert R1: pre-skip block anchors not found / out of order — aborting (no partial toggle)')
  process.exit(2)
}
// Sanity: the start anchor must appear exactly once.
if (src.indexOf(R1_START, i1 + 1) !== -1) {
  console.error('revert R1: pre-skip start anchor not unique — aborting')
  process.exit(2)
}
const r1Block = src.slice(i1, i1end)
// UNPATCHED replacement: declarations (BAND/enabled/skipped/groups) already
// live ABOVE this block, so we only need an inert no-op that references them
// (prevents unused-var) and reproduces TODAY's behavior (no pre-skip at all).
const r1Replacement = toEOL(
`  if (filenamePreSkipEnabled && partitionedPaths.length > 0) {
    // [UNPATCHED] filename pre-read bookmark DISABLED — every file flows to
    // the EXIF read loop exactly as before this change. References kept so
    // the surrounding declarations are not unused.
    void BOUNDARY_REREAD_BAND
    void skippedByFilenameBookmark
    void preSkipEligibleGroups
    void preSkipRolloverGroups
  }`)
src = src.slice(0, i1) + r1Replacement + src.slice(i1end)

// R2: the post-import bookmark-advance block. Replace its body with a no-op.
const R2_START = toEOL('    if (filenamePreSkipEnabled) {\n      interface BmMax')
const R2_END = toEOL('\n    }\n  }\n\n  // ── Distribution-sanity validator ──')
const j1 = src.indexOf(R2_START)
if (j1 < 0) {
  console.error('revert R2: advance block start anchor not found — aborting')
  process.exit(2)
}
const j2 = src.indexOf(R2_END, j1)
if (j2 < 0) {
  console.error('revert R2: advance block end anchor not found — aborting')
  process.exit(2)
}
if (src.indexOf(R2_START, j1 + 1) !== -1) {
  console.error('revert R2: advance start anchor not unique — aborting')
  process.exit(2)
}
// Replace from the `if (filenamePreSkipEnabled) {` up to and including the
// matching `}` (the chars right before `\n  }\n\n  // ── Distribution...`).
const r2Replacement = toEOL(
`    if (filenamePreSkipEnabled) {
      // [UNPATCHED] filename-bookmark advance DISABLED.
    }`)
// j2 points at the start of `<EOL>    }<EOL>  }<EOL><EOL>  // ── Distribution
// ...`. The block we replace is [j1 .. j2 + len('<EOL>    }')] i.e. include
// the block's own closing brace line.
const closeLen = toEOL('\n    }').length
src = src.slice(0, j1) + r2Replacement + src.slice(j2 + closeLen)

// Faithfulness gates: pre-skip work gone, orphan + photo-tier untouched.
if (src.includes('Re-group the post-allowlist path list by (volume serial')) {
  console.error('revert: pre-skip work still present after R1 — aborting')
  process.exit(2)
}
if (src.includes('const bmMax = new Map<string, BmMax>()')) {
  console.error('revert: bookmark-advance work still present after R2 — aborting')
  process.exit(2)
}
writePhotos(src)

// Independent verification on the orphan + photo-tier sibling files.
const ff = fs.readFileSync(`${ROOT}/src/main/services/ffmpeg.ts`, 'utf8')
if (!ff.includes('resumableStatuses')) {
  console.error('revert: orphan fix (resumableStatuses) missing from ffmpeg.ts — aborting')
  process.exit(2)
}
const jq = fs.readFileSync(`${ROOT}/src/main/services/jobQueue.ts`, 'utf8')
if (!jq.includes('hasOutstandingVideoWork')) {
  console.error('revert: photo-tier fix missing from jobQueue.ts — aborting')
  process.exit(2)
}
console.log('UNPATCHED produced (filename pre-skip + advance disabled; orphan + photo-tier intact).')
process.exit(0)
