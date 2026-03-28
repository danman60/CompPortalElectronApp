# Common Test Utilities — CompSync Media

## SSH Commands

```bash
# Start app
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'

# Kill app
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'

# Read last N log lines
ssh dart 'tail -N /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'

# Grep log for pattern
ssh dart 'grep -i "PATTERN" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -20'

# Read state file
ssh dart 'cat /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json'

# Read job queue
ssh dart 'cat /mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json'

# Check if app is running
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "tasklist /FI \"IMAGENAME eq CompSync Media.exe\" /NH" 2>&1'

# List files in routine dir
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "dir \"C:\\Users\\User\\OneDrive\\Desktop\\OBSOutputter\\EMPWR Dance - St. Catharines #2\" /b" 2>&1'
```

## WebSocket Commands

Send via node one-liner on DART:
```bash
ssh dart 'node -e "
const ws=new(require(\"ws\"))(\"ws://localhost:9877\");
ws.on(\"open\",()=>{
  ws.send(JSON.stringify({type:\"identify\",client:\"test\"}));
  setTimeout(()=>{
    ws.send(JSON.stringify(COMMAND_HERE));
    setTimeout(()=>ws.close(),2000);
  },500);
});
ws.on(\"message\",d=>console.log(d.toString().slice(0,500)));
"'
```

**Commands:**
| Action | JSON |
|--------|------|
| Next routine | `{"type":"command","action":"nextRoutine"}` |
| Full next (stop+advance+record+LT) | `{"type":"command","action":"nextFull"}` |
| Previous | `{"type":"command","action":"prev"}` |
| Toggle record | `{"type":"command","action":"toggleRecord"}` |
| Toggle stream | `{"type":"command","action":"toggleStream"}` |
| Save replay | `{"type":"command","action":"saveReplay"}` |
| Skip/unskip current | `{"type":"command","action":"skip"}` |
| Toggle overlay element | `{"type":"command","action":"toggleOverlay","element":"counter"}` |
| Load share code | `{"type":"command","action":"loadShareCode","shareCode":"EMPWR-STCATH-2"}` |

## State JSON Parsing

```bash
# Get routine by title
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if 'TITLE' in r['routineTitle'].upper():
        print(json.dumps({k: r.get(k) for k in ['routineTitle','status','recordingStartedAt','recordingStoppedAt','encodedFiles','photos','error']}, indent=2))
\""

# Get all recorded routines with timestamps
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r.get('recordingStartedAt'):
        print(f\\\"{r['status']:12s} {r['routineTitle'][:25]:25s} {r['recordingStartedAt'][:19]} photos={len(r.get('photos',[]))}\\\")
\""

# Count routines by status
ssh dart "python3 -c \"
import json
from collections import Counter
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
counts = Counter(r['status'] for r in state['competition']['routines'])
for status, count in sorted(counts.items()):
    print(f'{status}: {count}')
\""
```

## Job Queue Parsing

```bash
# List jobs with status
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json') as f:
    jobs = json.load(f)
for j in jobs:
    p = j.get('payload',{})
    print(f\\\"{j['status']:10s} {j['type']:8s} {p.get('objectName','?'):25s} attempts={j.get('attempts',0)}\\\")
\""
```

## Log Patterns to Grep

| Pattern | Meaning |
|---------|---------|
| `OBS.*Connected` | OBS connection established |
| `Share code resolved` | Competition loaded |
| `recording → recorded` | Recording stopped successfully |
| `encoding → encoded` | FFmpeg completed |
| `encoded → uploading` | Upload started |
| `uploading → uploaded` | All files uploaded + complete |
| `Upload failed` | Upload error (check message) |
| `FFmpeg.*error\|FFmpeg.*failed` | Encoding error |
| `EBUSY\|EPERM\|ENOENT` | File system errors |
| `Import complete:` | Photo import result |
| `Clock offset detected` | Photo clock sync info |
| `Camera drive detected` | SD card inserted |
| `Overlay lower third fired` | LT triggered |

## Verification Assertions

```bash
# Assert log contains pattern (within last N lines)
RESULT=$(ssh dart "grep -c 'PATTERN' /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log" 2>/dev/null)
if [ "$RESULT" -gt 0 ]; then echo "PASS"; else echo "FAIL: pattern not found"; fi

# Assert routine status
STATUS=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if 'TITLE' in r['routineTitle'].upper():
        print(r['status'])
        break
\"" 2>/dev/null)
if [ "$STATUS" = "EXPECTED" ]; then echo "PASS"; else echo "FAIL: got $STATUS"; fi

# Assert file exists on DART
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "if exist \"PATH\" (echo EXISTS) else (echo MISSING)" 2>&1'
```

## Build & Deploy Cycle

```bash
# 1. Kill app
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
sleep 3

# 2. Build
cd ~/projects/CompSyncElectronApp && npm run dist 2>&1 | tail -3

# 3. Deploy
scp -r release/win-unpacked/* 'dart:/mnt/c/Program Files/CompSync Media/'

# 4. Start app
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
sleep 8
```
