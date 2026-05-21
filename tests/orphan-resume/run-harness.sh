#!/usr/bin/env bash
#
# Orphan-resume before/after proof harness — orchestrator.
#
# Proves the restart-orphan fix by running the REAL packaged boot recovery
# twice against an identical synthetic post-restart fixture:
#
#   RUN A (UNPATCHED): src/main/services/ffmpeg.ts fix reverted, rebuilt.
#     Expected: only the 2 'recorded' resume; 3 queued + 2 encoding ORPHAN
#     (reproduces today's live failure — encoder idle on a queued backlog).
#
#   RUN B (PATCHED): fix in place, rebuilt.
#     Expected: all 7 non-terminal recorded/queued/encoding resume; encoded
#     and uploading get NO encode job; no double-enqueue.
#
# Opposite results on the identical fixture = proof.
#
# Faithfulness notes:
#  - electron-vite build => out/main/index.js is the EXACT bundle
#    electron-builder packs into app.asar. We execute it with the Linux
#    Electron binary because the orphan bug is pure JS app-state + boot
#    logic (OS/GPU independent — stated in the task). A Windows app.asar is
#    also built (the DART-bound artifact) and hashed, but cannot be executed
#    on this Linux box; running the identical bundle under Linux Electron is
#    the faithful local exercise of the same code path.
#  - Network is limited to resolveShareCode("TEST2026") — the public
#    read-only GET every real launch makes. NOT DART, no DB write. The
#    fixture's competitionId deliberately != any real TEST2026 competition,
#    so setCompetition()'s by-id merge is skipped and fixture statuses
#    survive verbatim into resumeRecordedRoutines().
#  - Isolated --user-data-dir; the operator's real state is never touched.
#
# Exit 0 only if A reproduces the orphan AND B recovers all. Else non-zero.

set -u
ROOT="/home/danman60/projects/CompSyncElectronApp"
HD="$ROOT/tests/orphan-resume"
UD="/tmp/cse-orphan-test"
OUT="$HD/results"
DBG_PORT=9234
BOOT_WAIT_SECS=90

mkdir -p "$OUT"
cd "$ROOT" || { echo "cannot cd $ROOT"; exit 2; }

ELECTRON_BIN="$ROOT/node_modules/.bin/electron"
MAIN_BUNDLE="$ROOT/out/main/index.js"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

build_bundle() {
  log "build: npm run build (electron-vite)"
  npm run build > "$OUT/build-$1.log" 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then log "BUILD FAILED ($1) rc=$rc — see $OUT/build-$1.log"; return 1; fi
  if [ ! -f "$MAIN_BUNDLE" ]; then log "BUILD produced no $MAIN_BUNDLE"; return 1; fi
  return 0
}

# Run the packaged boot once; capture queue/state/log into the isolated UD.
# $1 = label (unpatched|patched)
run_app_once() {
  local label="$1"
  log "fixture: regenerating ($label)"
  CSE_UD="$UD" node "$HD/make-fixture.mjs" > "$OUT/fixture-$label.log" 2>&1 || {
    log "FIXTURE GEN FAILED ($label) — see $OUT/fixture-$label.log"; return 1; }

  log "launch: xvfb electron (label=$label, userData=$UD, dbg=$DBG_PORT)"
  # --no-sandbox: required for Electron under xvfb on this box (chrome-sandbox
  # not setuid-root). Harness-spawned, isolated UD — not a user-facing app.
  xvfb-run -a "$ELECTRON_BIN" "$MAIN_BUNDLE" \
    --no-sandbox \
    --user-data-dir="$UD" \
    --remote-debugging-port=$DBG_PORT \
    > "$OUT/app-$label.log" 2>&1 &
  local app_pid=$!

  # Completion signal = the resume pass finished (it logs once recovery runs).
  # Recovery is gated behind resolveShareCode; index.ts also logs the resume
  # outcome line. Poll the app's own main.log (PRIMARY signal), bounded.
  local waited=0
  local done=0
  while [ $waited -lt $BOOT_WAIT_SECS ]; do
    if [ -f "$UD/logs/main.log" ]; then
      if grep -qE "Resumed [0-9]+ recorded routine|Resume recorded: queued|resumeRecordedRoutines failed|autoEncodeRecordings" "$UD/logs/main.log" 2>/dev/null; then
        # give the queue debounced save (500ms) + flush a moment to land
        sleep 3
        done=1
        break
      fi
      # also accept: recovery block clearly ran (uploading reconcile / autoresume)
      if grep -qE "Auto-resume:|Boot: waking upload|Reset orphaned 'uploading'|Share code resolve failed|Startup schedule refetch failed" "$UD/logs/main.log" 2>/dev/null; then
        sleep 5
        # one more grep for the resume line specifically before declaring done
        if grep -qE "Resume recorded: queued|Resumed [0-9]+ recorded routine|resumeRecordedRoutines failed" "$UD/logs/main.log" 2>/dev/null; then
          sleep 2; done=1; break
        fi
      fi
    fi
    sleep 2
    waited=$((waited+2))
  done

  # Harness owns this electron process (isolated UD, debug port we chose) —
  # terminate it. This is NOT a user-facing app and NOT on DART.
  kill -TERM "$app_pid" 2>/dev/null
  sleep 2
  kill -KILL "$app_pid" 2>/dev/null
  pkill -KILL -f "remote-debugging-port=$DBG_PORT" 2>/dev/null
  wait "$app_pid" 2>/dev/null

  # snapshot the primary-source files for the record
  cp -f "$UD/job-queue.json"        "$OUT/job-queue-$label.json"      2>/dev/null || echo "[]" > "$OUT/job-queue-$label.json"
  cp -f "$UD/compsync-state.json"   "$OUT/state-$label.json"          2>/dev/null
  cp -f "$UD/logs/main.log"         "$OUT/mainlog-$label.log"         2>/dev/null

  if [ $done -ne 1 ]; then
    log "WARN ($label): resume log signal not seen within ${BOOT_WAIT_SECS}s — verdict reader will judge from on-disk primary source anyway"
  fi
  return 0
}

# ---- RUN A: UNPATCHED ------------------------------------------------------
log "=== RUN A: UNPATCHED (revert ffmpeg.ts fix, rebuild) ==="
git stash push -- src/main/services/ffmpeg.ts > "$OUT/stash-a.log" 2>&1
STASHED=0
if grep -q "Saved working directory" "$OUT/stash-a.log"; then STASHED=1; fi
if ! grep -q "Saved working directory\|No local changes" "$OUT/stash-a.log"; then
  log "ABORT: could not stash ffmpeg.ts cleanly — see $OUT/stash-a.log"
  exit 2
fi
if [ $STASHED -eq 0 ]; then
  log "ABORT: ffmpeg.ts had no changes to stash — fix not present, cannot do before/after"
  exit 2
fi

build_bundle "unpatched"; BR=$?
if [ $BR -ne 0 ]; then git stash pop > "$OUT/stash-pop-a.log" 2>&1; exit 2; fi
run_app_once "unpatched"
node "$HD/check-verdict.mjs" unpatched "$UD" | tee "$OUT/verdict-unpatched.txt"
A_RC=${PIPESTATUS[0]}

# restore the fix
git stash pop > "$OUT/stash-pop-a.log" 2>&1
if ! git diff --quiet src/main/services/ffmpeg.ts; then
  log "fix restored (ffmpeg.ts modified again)"
else
  log "ABORT: stash pop did not restore ffmpeg.ts fix — see $OUT/stash-pop-a.log"
  exit 2
fi

# ---- RUN B: PATCHED --------------------------------------------------------
log "=== RUN B: PATCHED (fix in place, rebuild) ==="
build_bundle "patched"; BR=$?
if [ $BR -ne 0 ]; then exit 2; fi
run_app_once "patched"
node "$HD/check-verdict.mjs" patched "$UD" | tee "$OUT/verdict-patched.txt"
B_RC=${PIPESTATUS[0]}

# ---- PROOF JUDGEMENT -------------------------------------------------------
echo ""
echo "================ BEFORE/AFTER PROOF ================"
echo "RUN A (unpatched) verdict exit: $A_RC  (0 = matched unpatched expectation: only recorded resume, queued/encoding orphaned)"
echo "RUN B (patched)   verdict exit: $B_RC  (0 = matched patched expectation: all 7 resume, encoded/uploading excluded)"
echo ""
if [ "$A_RC" -eq 0 ] && [ "$B_RC" -eq 0 ]; then
  echo "RESULT: PROOF ESTABLISHED — A reproduces the orphan, B recovers all. Opposite outcomes on identical fixture."
  exit 0
else
  echo "RESULT: PROOF NOT ESTABLISHED — see verdict-*.txt. If A did not reproduce the orphan, the harness is not faithful (do not claim success)."
  exit 1
fi
