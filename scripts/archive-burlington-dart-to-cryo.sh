#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--run" ]]; then
  echo "Refusing to start transfer without --run."
  echo "This pulls DART Burlington output to FIRMAMENT CryoStorage and does not delete source files."
  exit 2
fi

remote=":sftp,host=100.90.103.121,user=User,key_file=/home/danman60/.ssh/id_ed25519_spyballoon,shell_type=powershell:/C:/Users/User/OneDrive/Desktop/TesterOutput/UDC Burlington 2026"
destination="/mnt/firmament/CryoStorage/UDC Burlington 2026"
log_root="/mnt/firmament/CryoStorage/_transfer_logs"
run_id=$(TZ='America/New_York' date '+%Y%m%d-%H%M%S')
log_file="$log_root/UDC_Burlington_2026_rclone_$run_id.log"
summary_file="$log_root/UDC_Burlington_2026_summary_$run_id.json"

mkdir -p "$destination" "$log_root"

started_edt=$(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')
source_before=$(rclone size "$remote" --sftp-disable-hashcheck --json)
dest_before=$(rclone size "$destination" --json)

rclone copy "$remote" "$destination" \
  --sftp-disable-hashcheck \
  --create-empty-src-dirs \
  --transfers 4 \
  --checkers 16 \
  --retries 3 \
  --low-level-retries 20 \
  --timeout 1m \
  --contimeout 30s \
  --stats 60s \
  --stats-one-line \
  --log-file "$log_file" \
  --log-level INFO

source_after=$(rclone size "$remote" --sftp-disable-hashcheck --json)
dest_after=$(rclone size "$destination" --json)
finished_edt=$(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')

python3 - "$summary_file" "$started_edt" "$finished_edt" "$remote" "$destination" "$log_file" "$source_before" "$dest_before" "$source_after" "$dest_after" <<'PY'
import json
import sys

summary_file, started, finished, source, destination, log_file, source_before, dest_before, source_after, dest_after = sys.argv[1:]
source_before = json.loads(source_before)
dest_before = json.loads(dest_before)
source_after = json.loads(source_after)
dest_after = json.loads(dest_after)
verified = (
    source_after.get("count") == dest_after.get("count")
    and source_after.get("bytes") == dest_after.get("bytes")
    and source_after.get("sizeless", 0) == 0
)
summary = {
    "started_edt": started,
    "finished_edt": finished,
    "source": source,
    "destination": destination,
    "log_file": log_file,
    "source_before": source_before,
    "destination_before": dest_before,
    "source_after": source_after,
    "destination_after": dest_after,
    "verified_counts_and_bytes": verified,
    "source_deleted": False,
}
with open(summary_file, "w", encoding="utf-8") as f:
    json.dump(summary, f, indent=2)
print(f"SUMMARY: {summary_file}")
print(f"LOG: {log_file}")
print(f"VERIFIED_COUNTS_AND_BYTES: {verified}")
if not verified:
    sys.exit(20)
PY
