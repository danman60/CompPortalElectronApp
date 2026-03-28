# Flow 04: Upload Management — Cancel, Retry, Re-record Cleanup

## Purpose
Test upload cancel/retry per-routine, pause/resume global, re-record state cleanup, 5GB file size guard, job queue persistence across restart.

**DEPENDS_ON:** Flow 02 (at least one routine has been through the pipeline)

---

## Step 1: Verify job queue state

```bash
ssh dart "python3 -c \"
import json
from collections import Counter
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json') as f:
    jobs = json.load(f)
counts = Counter(j['status'] for j in jobs)
print(f'Total jobs: {len(jobs)}')
for status, count in sorted(counts.items()):
    print(f'  {status}: {count}')
\""
```
Note counts for comparison after tests.

---

## Step 2: Test cancel on uploading routine

### 2a: Find or create an uploading routine
If no routine is currently uploading, trigger one:
```bash
# Find an encoded routine
ENCODED_ID=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['status'] == 'encoded':
        print(r['id'])
        break
\"")
```

If found, trigger upload via WS (uploadRoutine IPC).

### 2b: Verify cancel resets status
After cancel (via UI cancel button or `uploadStop` IPC):
```bash
ssh dart 'grep "Upload paused\|cancelled" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3'
```

Check state:
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['status'] == 'uploading':
        print(f'FAIL: {r[\"routineTitle\"]} still uploading')
\"" || echo 'PASS: no routines stuck at uploading'
```
**ASSERT:** No routines with status "uploading" after cancel

### 2c: Verify cancelled jobs in queue
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json') as f:
    jobs = json.load(f)
cancelled = [j for j in jobs if j['status'] == 'cancelled']
print(f'Cancelled jobs: {len(cancelled)}')
\""
```

---

## Step 3: Test retry on failed routine

### 3a: Find a failed routine (or simulate one)
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['status'] == 'failed' or r.get('error'):
        print(f'{r[\"routineTitle\"]}: status={r[\"status\"]} error={r.get(\"error\",\"\")[:80]}')
\""
```

### 3b: Retry via uploadRoutine
If a failed/encoded routine with error exists:
```bash
ssh dart 'grep "enqueued upload job" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -5'
```
**ASSERT:** New upload jobs created for the routine

---

## Step 4: Test re-record cleanup

### 4a: Find an uploaded routine to re-record
```bash
UPLOADED_ROUTINE=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['status'] == 'uploaded' and r.get('encodedFiles'):
        print(r['routineTitle'])
        break
\"")
echo "Re-record target: $UPLOADED_ROUTINE"
```

### 4b: Record the routine again (via WS toggleRecord)
This triggers the archive + cleanup flow.

### 4c: Verify old files archived
```bash
ssh dart 'grep "Archived existing files\|old upload jobs" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3'
```
**ASSERT:** "Archived existing files" + "cleared N old upload jobs"

### 4d: Verify state reset
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['routineTitle'] == '$UPLOADED_ROUTINE':
        print(f'Status: {r[\"status\"]}')
        print(f'Photos: {r.get(\"photos\",\"cleared\")}')
        print(f'EncodedFiles: {r.get(\"encodedFiles\",\"cleared\")}')
        print(f'Error: {r.get(\"error\",\"cleared\")}')
        break
\""
```
**ASSERT:** photos=None/cleared, encodedFiles=None/cleared, error=None/cleared

### 4e: Verify old upload jobs cancelled
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json') as f:
    jobs = json.load(f)
for j in jobs:
    if j.get('routineId','') == 'ROUTINE_ID' and j['status'] == 'cancelled':
        print(f'Old job cancelled: {j[\"id\"][:8]}')
\""
```

---

## Step 5: Test 5GB file size guard

### 5a: Check for any oversized files
```bash
ssh dart 'grep "File too large" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -5'
```
If found: **PASS** — guard is working, files over 5GB are rejected.

### 5b: Verify failed job has correct error message
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json') as f:
    jobs = json.load(f)
for j in jobs:
    err = j.get('payload',{}).get('error','') or j.get('error','')
    if '5GB' in str(err) or 'too large' in str(err):
        print(f'PASS: {j[\"id\"][:8]} — {err[:80]}')
\""
```

---

## Step 6: Test job queue persistence across restart

### 6a: Note current queue state
```bash
BEFORE_COUNT=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json') as f:
    print(len(json.load(f)))
\"")
echo "Jobs before restart: $BEFORE_COUNT"
```

### 6b: Kill and restart app
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
sleep 3
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
sleep 10
```

### 6c: Verify jobs restored
```bash
AFTER_COUNT=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json') as f:
    print(len(json.load(f)))
\"")
echo "Jobs after restart: $AFTER_COUNT"
```
**ASSERT:** AFTER_COUNT >= BEFORE_COUNT (done jobs may have been pruned)

### 6d: Verify running jobs reset to pending
```bash
ssh dart 'grep "jobs resumed\|running.*pending" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3'
```
**ASSERT:** Any previously-running jobs were reset to pending

---

## Results
- [ ] Cancel resets uploading routine to encoded
- [ ] Cancel clears upload progress
- [ ] Cancelled jobs marked in queue
- [ ] Retry creates new upload jobs
- [ ] Re-record archives old files
- [ ] Re-record clears old upload jobs
- [ ] Re-record resets photos/encodedFiles/error in state
- [ ] 5GB file size guard rejects oversized files
- [ ] Job queue persists across restart
- [ ] Running jobs reset to pending on restart
