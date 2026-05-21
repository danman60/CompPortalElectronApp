#!/usr/bin/env bash
#
# Photo-tier before/after proof orchestrator.
#
# Proves the upload-priority change by running the SAME real-module harness
# (real jobQueue.getNext + real enqueueRoundRobin tagging, only the I/O
# boundary aliased) twice against the identical fixture:
#
#   RUN B (PATCHED, current working tree): tier tags applied; getNext
#     withholds remaining photos behind video work; bounded re-check; no
#     deadlock; missing-tier => priority.
#   RUN A (UNPATCHED, photo-tier delta reverted, orphan fix KEPT): no gate —
#     photos handed out while encode work pending (today's starvation).
#
# Opposite outcomes on the identical fixture = proof.
#
# Faithfulness:
#  - harness bundles the ACTUAL src/main/services/jobQueue.ts + upload.ts via
#    esbuild (the SAME bundler electron-vite uses, v0.21.5) => the tier logic
#    exercised is byte-identical to what app.asar runs.
#  - ONLY two genuine I/O boundaries are aliased (electron filesystem/window;
#    schedule = the network share-code GET). enqueue/getNext/tier math are the
#    real source, never mocked.
#  - UNPATCHED is produced by reverse-applying ONLY the 5 photo-tier string
#    edits to upload.ts (preserving pre-existing unrelated session work) +
#    `git checkout HEAD` on jobQueue.ts (clean at HEAD). The orphan-resume fix
#    in ffmpeg.ts is NEVER touched by this harness.

set -u
ROOT="/home/danman60/projects/CompSyncElectronApp"
HD="$ROOT/tests/photo-tier"
OUT="$HD/results"
JOBQ="$ROOT/src/main/services/jobQueue.ts"
JOBQ_SNAP="/tmp/cse-pt-jobqueue-patched.ts"

mkdir -p "$OUT"
cd "$ROOT" || { echo "cannot cd $ROOT"; exit 2; }
log() { echo "[$(date '+%H:%M:%S')] $*"; }

run_once() {
  local label="$1"   # patched | unpatched
  log "build harness ($label)"
  node "$HD/build-harness.mjs" > "$OUT/build-harness-$label.log" 2>&1 || {
    log "HARNESS BUILD FAILED ($label) — see $OUT/build-harness-$label.log"; return 1; }
  log "run harness ($label)"
  node "$HD/.build/harness.cjs" > "$OUT/run-$label.json" 2> "$OUT/run-$label.stderr" || {
    log "HARNESS RUN FAILED ($label) — see $OUT/run-$label.stderr"; return 1; }
  return 0
}

# Guard: photo-tier delta must currently be present (PATCHED working tree).
if ! grep -q "hasOutstandingVideoWork" "$JOBQ"; then
  log "ABORT: photo-tier change not present in jobQueue.ts — nothing to prove"
  exit 2
fi
if ! grep -q "resumableStatuses" "$ROOT/src/main/services/ffmpeg.ts"; then
  log "ABORT: orphan-resume fix (resumableStatuses) missing from ffmpeg.ts — refusing to run"
  exit 2
fi

# Snapshot the PATCHED jobQueue.ts so `toggle apply` can restore it byte-exact.
cp -f "$JOBQ" "$JOBQ_SNAP"

# ---- RUN B: PATCHED (current state) ----------------------------------------
log "=== RUN B: PATCHED ==="
run_once "patched"; PB=$?
if [ $PB -ne 0 ]; then exit 2; fi
node "$HD/check-verdict.mjs" patched "$OUT/run-patched.json" | tee "$OUT/verdict-patched.txt"
B_RC=${PIPESTATUS[0]}

# ---- RUN A: UNPATCHED (revert photo-tier delta only) -----------------------
log "=== RUN A: UNPATCHED (revert photo-tier delta; orphan fix kept) ==="
node "$HD/toggle-patch.mjs" revert > "$OUT/toggle-revert.log" 2>&1 || {
  log "TOGGLE REVERT FAILED — see $OUT/toggle-revert.log"; cat "$OUT/toggle-revert.log"; exit 2; }
# Faithfulness gates: photo-tier gone, orphan fix still here.
if grep -q "hasOutstandingVideoWork\|photoTier" "$JOBQ"; then
  log "ABORT: jobQueue.ts still has photo-tier code after revert"; exit 2
fi
if ! grep -q "resumableStatuses" "$ROOT/src/main/services/ffmpeg.ts"; then
  log "ABORT: orphan fix vanished during revert — refusing to continue"; exit 2
fi
run_once "unpatched"; PA=$?
node "$HD/check-verdict.mjs" unpatched "$OUT/run-unpatched.json" | tee "$OUT/verdict-unpatched.txt"
A_RC=${PIPESTATUS[0]}

# ---- RESTORE PATCHED -------------------------------------------------------
log "=== restore PATCHED working tree ==="
PT_JOBQ_STASH="$JOBQ_SNAP" node "$HD/toggle-patch.mjs" apply > "$OUT/toggle-apply.log" 2>&1 || {
  log "TOGGLE APPLY FAILED — see $OUT/toggle-apply.log"; cat "$OUT/toggle-apply.log"; exit 2; }
if ! grep -q "hasOutstandingVideoWork" "$JOBQ"; then
  log "CRITICAL: PATCHED restore failed — jobQueue.ts missing photo-tier code"; exit 2
fi
if ! grep -q "photoTier" "$ROOT/src/main/services/upload.ts"; then
  log "CRITICAL: PATCHED restore failed — upload.ts missing photo-tier code"; exit 2
fi
log "restore OK (working tree back to PATCHED)"

# ---- PROOF JUDGEMENT -------------------------------------------------------
echo ""
echo "================ BEFORE/AFTER PROOF ================"
echo "RUN A (unpatched) verdict exit: $A_RC  (0 = starvation reproduced: photos dispatched while encode work pending)"
echo "RUN B (patched)   verdict exit: $B_RC  (0 = gate holds, no deadlock, no busy-spin, missing-tier=priority)"
echo ""
if [ "${A_RC:-1}" -eq 0 ] && [ "${B_RC:-1}" -eq 0 ]; then
  echo "RESULT: PROOF ESTABLISHED — A reproduces starvation, B fixes it. Opposite outcomes on identical fixture."
  exit 0
else
  echo "RESULT: PROOF NOT ESTABLISHED — inspect verdict-*.txt / run-*.json. If A did not reproduce starvation the harness is unfaithful (do NOT claim success)."
  exit 1
fi
