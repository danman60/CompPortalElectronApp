# Flow 02: Recording Pipeline — Full Lifecycle

## Purpose
Test the complete pipeline: select routine → record → stop → MKV move → FFmpeg encode → auto-upload → CompPortal confirmation. Verify state at every transition.

**DEPENDS_ON:** Flow 01 (app running, OBS connected, competition loaded)

---

## Step 1: Select a test routine

Pick a routine that has NOT been recorded yet (status=pending).

```bash
TEST_ROUTINE=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['status'] == 'pending' and r['entryNumber']:
        print(r['routineTitle'])
        break
\"")
echo "Test routine: $TEST_ROUTINE"
```

Navigate to the routine via WS:
```bash
ROUTINE_ID=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['routineTitle'] == '$TEST_ROUTINE':
        print(r['id'])
        break
\"")
```

Jump to it via IPC (WS doesn't have jump-to, use state file check instead — the test runner should click the routine row in the UI, or we accept whatever routine is current).

## Step 2: Verify pre-record state
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['routineTitle'] == '$TEST_ROUTINE':
        assert r['status'] == 'pending', f'Expected pending, got {r[\"status\"]}'
        assert r.get('recordingStartedAt') is None
        assert r.get('encodedFiles') is None
        print('PASS: routine is pending with no recording data')
        break
\""
```

## Step 3: Start recording via WS
```bash
BEFORE_TIME=$(date -u +%Y-%m-%dT%H:%M:%S)
ssh dart 'node -e "
const ws=new(require(\"ws\"))(\"ws://localhost:9877\");
ws.on(\"open\",()=>{
  ws.send(JSON.stringify({type:\"identify\",client:\"test\"}));
  setTimeout(()=>{
    ws.send(JSON.stringify({type:\"command\",action:\"toggleRecord\"}));
    setTimeout(()=>ws.close(),2000);
  },500);
});
"'
```
Wait 3s.

### Verify: OBS recording started
```bash
ssh dart 'grep "RecordStateChanged.*STARTED" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Contains "OBS_WEBSOCKET_OUTPUT_STARTED" with MKV path

### Verify: Routine status = recording
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
current_id = state.get('currentRoutineId')
for r in state['competition']['routines']:
    if r['id'] == current_id:
        print(f'Status: {r[\"status\"]}')
        print(f'Started: {r.get(\"recordingStartedAt\",\"MISSING\")}')
        break
\""
```
**ASSERT:** status = "recording", recordingStartedAt is set

## Step 4: Record for 15 seconds
```bash
sleep 15
```

## Step 5: Stop recording via WS
```bash
ssh dart 'node -e "
const ws=new(require(\"ws\"))(\"ws://localhost:9877\");
ws.on(\"open\",()=>{
  ws.send(JSON.stringify({type:\"identify\",client:\"test\"}));
  setTimeout(()=>{
    ws.send(JSON.stringify({type:\"command\",action:\"toggleRecord\"}));
    setTimeout(()=>ws.close(),2000);
  },500);
});
"'
```
Wait 5s for file processing.

### Verify: Recording stopped
```bash
ssh dart 'grep "RecordStateChanged.*STOPPED" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Contains "OBS_WEBSOCKET_OUTPUT_STOPPED"

### Verify: MKV moved to routine directory
```bash
ssh dart 'grep "Moved:.*mkv" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Shows source → destination path with file size

### Verify: Status = recorded
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
current_id = state.get('currentRoutineId')
for r in state['competition']['routines']:
    if r['id'] == current_id:
        print(f'Status: {r[\"status\"]}')
        print(f'Stopped: {r.get(\"recordingStoppedAt\",\"MISSING\")}')
        print(f'OutputPath: {r.get(\"outputPath\",\"MISSING\")}')
        break
\""
```
**ASSERT:** status in ("recorded", "queued", "encoding", "encoded") — may have already auto-advanced

## Step 6: Verify FFmpeg encoding (auto-encode should trigger)

Wait up to 30s for encoding:
```bash
for i in $(seq 1 6); do
  STATUS=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
current_id = state.get('currentRoutineId')
for r in state['competition']['routines']:
    if r['id'] == current_id:
        print(r['status'])
        break
\"")
  echo "Attempt $i: status=$STATUS"
  if [ "$STATUS" = "encoded" ] || [ "$STATUS" = "uploading" ] || [ "$STATUS" = "uploaded" ]; then break; fi
  sleep 5
done
```

### Verify: FFmpeg log shows completion
```bash
ssh dart 'grep "Encoding complete" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** "Encoding complete for routine"

### Verify: Encoded files exist in state
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
current_id = state.get('currentRoutineId')
for r in state['competition']['routines']:
    if r['id'] == current_id:
        files = r.get('encodedFiles', [])
        print(f'Encoded files: {len(files)}')
        for f in files:
            print(f'  {f[\"role\"]}: {f[\"filePath\"][-40:]}')
        break
\""
```
**ASSERT:** At least 2 files (performance + 1 judge). Roles include "performance".

### Verify: Output MP4 files exist on disk
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
current_id = state.get('currentRoutineId')
for r in state['competition']['routines']:
    if r['id'] == current_id:
        for f in r.get('encodedFiles', []):
            print(f['filePath'])
        break
\"" | while read fp; do
  ssh dart "/mnt/c/Windows/System32/cmd.exe /c \"if exist \\\"$fp\\\" (echo EXISTS: $fp) else (echo MISSING: $fp)\"" 2>/dev/null
done
```
**ASSERT:** All files exist

## Step 7: Verify auto-upload triggered

Wait up to 60s for upload completion:
```bash
for i in $(seq 1 12); do
  STATUS=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
current_id = state.get('currentRoutineId')
for r in state['competition']['routines']:
    if r['id'] == current_id:
        print(r['status'])
        break
\"")
  echo "Attempt $i: status=$STATUS"
  if [ "$STATUS" = "uploaded" ] || [ "$STATUS" = "confirmed" ]; then break; fi
  sleep 5
done
```

### Verify: Upload jobs completed
```bash
ssh dart 'grep "All uploads complete" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Present

### Verify: Plugin complete succeeded
```bash
ssh dart 'grep "Plugin complete success" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Present

### Verify: Status = uploaded
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
current_id = state.get('currentRoutineId')
for r in state['competition']['routines']:
    if r['id'] == current_id:
        assert r['status'] == 'uploaded', f'Expected uploaded, got {r[\"status\"]}'
        print('PASS: routine uploaded')
        break
\""
```

## Step 8: Verify original MKV preserved
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
current_id = state.get('currentRoutineId')
for r in state['competition']['routines']:
    if r['id'] == current_id:
        print(r.get('outputPath',''))
        break
\"" | while read fp; do
  ssh dart "/mnt/c/Windows/System32/cmd.exe /c \"if exist \\\"$fp\\\" (echo PASS: MKV preserved) else (echo FAIL: MKV deleted)\"" 2>/dev/null
done
```
**ASSERT:** MKV file still exists

## Step 9: Verify on CompPortal (Supabase)
```sql
-- Check if media was registered
SELECT id, entry_id, status, video_performance_path, video_judge1_path
FROM compsync.media_packages
WHERE entry_id = 'ROUTINE_UUID'
ORDER BY created_at DESC LIMIT 1;
```
**ASSERT:** Row exists with video paths populated

---

## Results
- [ ] Routine starts at pending
- [ ] Recording starts via WS command
- [ ] OBS confirms recording started
- [ ] State shows recording status + timestamp
- [ ] Recording stops via WS command
- [ ] MKV moved to routine directory
- [ ] State shows recorded status + timestamps + outputPath
- [ ] FFmpeg auto-encodes (status: encoding → encoded)
- [ ] Encoded files listed in state with correct roles
- [ ] MP4 files exist on disk
- [ ] Auto-upload triggers (status: uploading)
- [ ] All upload jobs complete
- [ ] Plugin/complete call succeeds
- [ ] Status reaches uploaded
- [ ] Original MKV preserved
- [ ] Media registered on CompPortal
