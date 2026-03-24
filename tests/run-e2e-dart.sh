#!/bin/bash
# Run E2E pipeline test against CompSync Media on DART
#
# Usage:
#   ./tests/run-e2e-dart.sh [--routines N] [--record-sec N] [--skip-upload] [--loop N]
#
# Sets up SSH tunnels to DART, then runs the test script locally.

set -euo pipefail

DART_HOST="dart"
DART_LOG="/mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log"
LOCAL_WS_PORT=19877
LOCAL_OVERLAY_PORT=19876
LOOP_COUNT=1
EXTRA_ARGS=()

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --loop) LOOP_COUNT="$2"; shift 2 ;;
    *) EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# Check DART is reachable
if ! ssh -o ConnectTimeout=3 -o BatchMode=yes "$DART_HOST" true 2>/dev/null; then
  echo "ERROR: Cannot reach DART via SSH"
  exit 1
fi

# Check if app is running
if ! ssh "$DART_HOST" 'cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c "tasklist"' 2>/dev/null | grep -q "CompSync"; then
  echo "ERROR: CompSync Media is not running on DART"
  exit 1
fi

# Set up SSH tunnels (background, auto-cleanup)
echo "Setting up SSH tunnels to DART..."
ssh -4 -N -L ${LOCAL_WS_PORT}:127.0.0.1:9877 -L ${LOCAL_OVERLAY_PORT}:127.0.0.1:9876 "$DART_HOST" &
SSH_PID=$!
trap "kill $SSH_PID 2>/dev/null; wait $SSH_PID 2>/dev/null" EXIT
sleep 2

# Verify tunnels
if ! nc -z localhost $LOCAL_WS_PORT 2>/dev/null; then
  echo "ERROR: SSH tunnel for WS hub (port $LOCAL_WS_PORT) failed"
  exit 1
fi
echo "Tunnels ready: WS=$LOCAL_WS_PORT, Overlay=$LOCAL_OVERLAY_PORT"

# Sync log file to local tmp for monitoring
LOCAL_LOG="/tmp/compsync-main.log"
ssh "$DART_HOST" "cat '$DART_LOG'" > "$LOCAL_LOG" 2>/dev/null || true

# Start log sync in background
(while true; do
  ssh "$DART_HOST" "cat '$DART_LOG'" > "$LOCAL_LOG" 2>/dev/null || true
  sleep 3
done) &
LOG_SYNC_PID=$!
trap "kill $SSH_PID $LOG_SYNC_PID 2>/dev/null; wait $SSH_PID $LOG_SYNC_PID 2>/dev/null" EXIT

echo ""

# Run tests
cd "$(dirname "$0")/.."
PASS_TOTAL=0
FAIL_TOTAL=0

for i in $(seq 1 $LOOP_COUNT); do
  if [[ $LOOP_COUNT -gt 1 ]]; then
    echo "=========================================="
    echo "  Loop $i / $LOOP_COUNT"
    echo "=========================================="
  fi

  node tests/e2e-pipeline.mjs \
    --host localhost \
    --log-path "$LOCAL_LOG" \
    "${EXTRA_ARGS[@]}" \
    2>&1 | sed "s/localhost:19877/DART:9877/g; s/localhost:19876/DART:9876/g"

  EXIT_CODE=${PIPESTATUS[0]}
  if [[ $EXIT_CODE -eq 0 ]]; then
    ((PASS_TOTAL++)) || true
  else
    ((FAIL_TOTAL++)) || true
  fi

  if [[ $LOOP_COUNT -gt 1 ]] && [[ $i -lt $LOOP_COUNT ]]; then
    echo ""
    echo "Pausing 10s before next loop..."
    sleep 10
  fi
done

if [[ $LOOP_COUNT -gt 1 ]]; then
  echo ""
  echo "=========================================="
  echo "  LOOP SUMMARY: $PASS_TOTAL passed, $FAIL_TOTAL failed out of $LOOP_COUNT runs"
  echo "=========================================="
fi

exit $FAIL_TOTAL
