#!/usr/bin/env bash
#
# exif-bookmark before/after + correctness proof orchestrator.
#
# Proves the per-(serial,subfolder) filename pre-read bookmark by running the
# SAME real-module harness (real photos.ts import + dedup + state, only the
# genuine I/O boundaries aliased) against the identical on-disk fixture in two
# variants:
#
#   RUN A (UNPATCHED): filename pre-skip + advance DISABLED (orphan +
#     photo-tier KEPT). Expected: every old-below-bookmark file on the serial
#     card is EXIF-opened (reproduces "reads all files" slowness); zero new
#     photos dropped.
#   RUN B (PATCHED, working tree): pre-skip ACTIVE. Expected: old-below-
#     bookmark-outside-band files NOT opened (speed win); EVERY genuinely-new
#     photo still imported across every scenario (the data-loss guard).
#
# THE GATING ASSERTION (both runs, both TZ variants): count of genuinely-new
# photos that failed to import == 0. Opposite open-counts A vs B = speed
# proof; zero-dropped everywhere = safety proof. If B drops any new photo the
# proof FAILS and we do NOT claim success.
#
# Faithfulness:
#  - harness esbuild-bundles the ACTUAL src/main/services/photos.ts +
#    state.ts (same bundler electron-vite uses) => the dedup logic exercised
#    is byte-identical to app.asar.
#  - Only true I/O boundaries aliased: electron (fs/window), volumeSerial (the
#    `vol F:` Windows cmd, unavailable on Linux), recording.broadcastFullState
#    (renderer IPC push). EXIF read (getPhotoCaptureTime/ExifReader), the
#    cursor, DB-dedup, ±30s window match, and the new pre-skip are REAL.
#  - EXIF JPEGs are genuine files the REAL ExifReader parses (no EXIF mock).
#  - UNPATCHED is produced by disabling ONLY the 2 pre-skip regions in
#    photos.ts (anchored, unique-match-or-abort). ffmpeg.ts/jobQueue.ts/
#    upload.ts are never touched and are re-verified each toggle.

set -u
ROOT="/home/danman60/projects/CompSyncElectronApp"
HD="$ROOT/tests/exif-bookmark"
OUT="$HD/results"
PHOTOS="$ROOT/src/main/services/photos.ts"
export EB_PHOTOS_SNAP="/tmp/cse-eb-photos-patched.ts"
export EB_UD="/tmp/cse-exif-bookmark-ud"
export EB_CARD="/tmp/cse-exif-bookmark-card"

mkdir -p "$OUT"
cd "$ROOT" || { echo "cannot cd $ROOT"; exit 2; }
log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Guards: the delta must be present (PATCHED tree); orphan + photo-tier intact.
if ! grep -q "if (filenamePreSkipEnabled && partitionedPaths.length > 0) {" "$PHOTOS"; then
  log "ABORT: filename pre-skip not present in photos.ts — nothing to prove"; exit 2
fi
if ! grep -q "resumableStatuses" "$ROOT/src/main/services/ffmpeg.ts"; then
  log "ABORT: orphan fix (resumableStatuses) missing from ffmpeg.ts"; exit 2
fi
if ! grep -q "hasOutstandingVideoWork" "$ROOT/src/main/services/jobQueue.ts"; then
  log "ABORT: photo-tier fix missing from jobQueue.ts"; exit 2
fi

# Byte-exact snapshot so `toggle apply` restores PATCHED perfectly.
cp -f "$PHOTOS" "$EB_PHOTOS_SNAP"

run_once() {
  local label="$1"  # patched | unpatched   ($2 = tzskew flag 0|1)
  local tzskew="$2"
  export EB_TZSKEW="$tzskew"
  log "fixture ($label, tzskew=$tzskew)"
  node "$HD/make-fixture.mjs" > "$OUT/fixture-$label.log" 2>&1 || {
    log "FIXTURE GEN FAILED ($label) — see $OUT/fixture-$label.log"; return 1; }
  log "build harness ($label)"
  node "$HD/build-harness.mjs" > "$OUT/build-harness-$label.log" 2>&1 || {
    log "HARNESS BUILD FAILED ($label) — see $OUT/build-harness-$label.log"; return 1; }
  log "run harness ($label)"
  node "$HD/.build/harness.cjs" > "$OUT/run-$label.json" 2> "$OUT/run-$label.stderr" || {
    log "HARNESS RUN FAILED ($label) — see $OUT/run-$label.stderr"; return 1; }
  return 0
}

# ---- RUN B: PATCHED (current working tree), normal cursor ------------------
log "=== RUN B: PATCHED (pre-skip active) ==="
run_once "patched" 0; PB=$?
if [ $PB -ne 0 ]; then exit 2; fi
node "$HD/check-verdict.mjs" patched "$OUT/run-patched.json" | tee "$OUT/verdict-patched.txt"
B_RC=${PIPESTATUS[0]}

# ---- RUN B-TZ: PATCHED, TZ-SKEWED cursor (data-loss-under-TZ guard) --------
log "=== RUN B-TZ: PATCHED, TZ-SKEWED cursor (+5h) ==="
run_once "patched-tzskew" 1; PBT=$?
if [ $PBT -ne 0 ]; then exit 2; fi
node "$HD/check-verdict.mjs" patched "$OUT/run-patched-tzskew.json" | tee "$OUT/verdict-patched-tzskew.txt"
BT_RC=${PIPESTATUS[0]}

# ---- RUN A: UNPATCHED (disable pre-skip; orphan+photo-tier kept) -----------
log "=== RUN A: UNPATCHED (pre-skip disabled) ==="
node "$HD/toggle-patch.mjs" revert > "$OUT/toggle-revert.log" 2>&1 || {
  log "TOGGLE REVERT FAILED — see $OUT/toggle-revert.log"; cat "$OUT/toggle-revert.log"; exit 2; }
if grep -q "Re-group the post-allowlist path list by (volume serial" "$PHOTOS"; then
  log "ABORT: pre-skip work still present after revert"; exit 2
fi
if ! grep -q "resumableStatuses" "$ROOT/src/main/services/ffmpeg.ts"; then
  log "ABORT: orphan fix vanished during revert"; exit 2
fi
run_once "unpatched" 0; PA=$?
if [ $PA -ne 0 ]; then
  node "$HD/toggle-patch.mjs" apply > "$OUT/toggle-apply.log" 2>&1
  exit 2
fi
node "$HD/check-verdict.mjs" unpatched "$OUT/run-unpatched.json" | tee "$OUT/verdict-unpatched.txt"
A_RC=${PIPESTATUS[0]}

# ---- RESTORE PATCHED -------------------------------------------------------
log "=== restore PATCHED working tree ==="
node "$HD/toggle-patch.mjs" apply > "$OUT/toggle-apply.log" 2>&1 || {
  log "TOGGLE APPLY FAILED — see $OUT/toggle-apply.log"; cat "$OUT/toggle-apply.log"; exit 2; }
if ! grep -q "if (filenamePreSkipEnabled && partitionedPaths.length > 0) {" "$PHOTOS"; then
  log "CRITICAL: PATCHED restore failed"; exit 2
fi
if ! diff -q "$EB_PHOTOS_SNAP" "$PHOTOS" >/dev/null 2>&1; then
  log "CRITICAL: photos.ts not byte-exact after restore"; exit 2
fi
log "restore OK (photos.ts byte-exact to PATCHED snapshot)"

# ---- PROOF JUDGEMENT -------------------------------------------------------
echo ""
echo "================ EXIF-BOOKMARK PROOF ================"
echo "RUN A (unpatched)        verdict exit: $A_RC  (0 = no pre-skip: all old files opened, 0 new dropped)"
echo "RUN B (patched)          verdict exit: $B_RC  (0 = pre-skip active, opens dropped, 0 new dropped)"
echo "RUN B-TZ (patched +5h)   verdict exit: $BT_RC (0 = TZ-skewed cursor still drops 0 new)"
echo ""
NEW_A=$(node -e "console.log((require('$OUT/run-unpatched.json').assertions||{}).newPhotosDroppedTotal)" 2>/dev/null)
NEW_B=$(node -e "console.log((require('$OUT/run-patched.json').assertions||{}).newPhotosDroppedTotal)" 2>/dev/null)
NEW_BT=$(node -e "console.log((require('$OUT/run-patched-tzskew.json').assertions||{}).newPhotosDroppedTotal)" 2>/dev/null)
OPN_A=$(node -e "console.log((require('$OUT/run-unpatched.json').assertions||{}).serialCardOpenedCount)" 2>/dev/null)
OPN_B=$(node -e "console.log((require('$OUT/run-patched.json').assertions||{}).serialCardOpenedCount)" 2>/dev/null)
# Sum of genuinely-NEW photos imported across all subfolders. THIS is the
# safety equality that must hold A==B: the pre-skip must never change which
# NEW photos get imported. Total copies legitimately DIFFER (B correctly skips
# re-importing already-old files below the bookmark — the whole point of the
# optimization; the fixture seeds the EXIF cursor LOW on purpose so the
# FILENAME layer, not the cursor, does the skipping, which means UNPATCHED
# re-copies those 14 old files and PATCHED does not — an expected, correct
# difference, NOT a data-loss signal).
sumNewImported() {
  node -e "const ps=(require('$1').perSubfolder)||{};let n=0;for(const k in ps)n+=ps[k].newImported||0;console.log(n)" 2>/dev/null
}
NEWIMP_A=$(sumNewImported "$OUT/run-unpatched.json")
NEWIMP_B=$(sumNewImported "$OUT/run-patched.json")
NEWIMP_BT=$(sumNewImported "$OUT/run-patched-tzskew.json")
echo "GATING: new-photos-dropped  A=$NEW_A  B=$NEW_B  B-TZ=$NEW_BT  (ALL must be 0)"
echo "SPEED:  serial-card EXIF opens  A(unpatched)=$OPN_A  B(patched)=$OPN_B  (B must be < A)"
echo "SAME NEW-PHOTO SET: new-photos-imported  A=$NEWIMP_A  B=$NEWIMP_B  B-TZ=$NEWIMP_BT  (A==B==B-TZ, >0 — pre-skip never changes which NEW photos import)"
echo ""
# Speed proof = B opened strictly fewer than A. Safety proof = the genuinely-
# NEW photo import count is IDENTICAL across A, B, B-TZ AND zero new photos
# dropped in every variant.
SPEED_OK=$(node -e "process.stdout.write(((+'$OPN_B') < (+'$OPN_A')) ? '1':'0')" 2>/dev/null)
SAMENEW_OK=$(node -e "process.stdout.write(('$NEWIMP_A'==='$NEWIMP_B' && '$NEWIMP_B'==='$NEWIMP_BT' && (+'$NEWIMP_B')>0) ? '1':'0')" 2>/dev/null)
echo "SPEED_OK=$SPEED_OK  SAMENEW_OK=$SAMENEW_OK"
echo ""
if [ "${A_RC:-1}" -eq 0 ] && [ "${B_RC:-1}" -eq 0 ] && [ "${BT_RC:-1}" -eq 0 ] \
   && [ "$NEW_A" = "0" ] && [ "$NEW_B" = "0" ] && [ "$NEW_BT" = "0" ] \
   && [ "$SPEED_OK" = "1" ] && [ "$SAMENEW_OK" = "1" ]; then
  echo "RESULT: PROOF ESTABLISHED — A reads all ($OPN_A opens), B pre-skips ($OPN_B opens, fewer), IDENTICAL new-photo import set ($NEWIMP_B in A, B, B-TZ), ZERO new photos dropped in any scenario incl. TZ-skew. Safety + speed both proven."
  exit 0
else
  echo "RESULT: PROOF NOT ESTABLISHED — inspect verdict-*.txt / run-*.json. If ANY run dropped a new photo, or B did not open fewer than A, or the NEW-photo import set differs across A/B/B-TZ, the change is WRONG; do NOT claim success."
  exit 1
fi
