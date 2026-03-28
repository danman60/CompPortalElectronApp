# Flow 08: Scale Stress Test — 700 Routines

## Purpose
Verify the app doesn't freeze or degrade at competition scale (700 routines, 2800 upload jobs, 500 photos).

**DEPENDS_ON:** Flow 01 (app running)

---

## Step 1: Measure baseline performance

### 1a: Current routine count
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
print(len(state['competition']['routines']))
\""
```

### 1b: WS state message size
```bash
ssh dart "node -e \"
const ws=new(require('ws'))('ws://localhost:9877');
ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>ws.close(),1000)});
ws.on('message',d=>{console.log('Size: '+d.toString().length+' bytes')});
\""
```
Note size for comparison.

### 1c: State file size
```bash
ssh dart 'wc -c /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json'
```

---

## Step 2: Simulate 700 routines (synthetic)

### 2a: Generate synthetic state file
```bash
ssh dart "python3 -c \"
import json, uuid, random
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)

# Keep first 20 real routines, add 680 synthetic
real = state['competition']['routines'][:20]
studios = ['FVR','DMA','JAZ','XPR','NRG','STR','ARC','BLZ','KDZ','PRF']
categories = ['Jazz','Lyrical','Contemporary','Tap','Ballet','Hip Hop','Musical Theatre','Open']
ages = ['Mini','Junior','Intermediate','Senior']
statuses = ['pending']*400 + ['recorded']*50 + ['encoded']*50 + ['uploaded']*100 + ['confirmed']*80

for i in range(680):
    real.append({
        'id': str(uuid.uuid4()),
        'entryNumber': str(200+i),
        'routineTitle': f'Synthetic Routine {200+i}',
        'dancers': f'Dancer A, Dancer B',
        'studioName': f'Studio {studios[i%10]}',
        'studioCode': studios[i%10],
        'category': categories[i%8],
        'classification': 'Competitive',
        'ageGroup': ages[i%4],
        'sizeCategory': 'Solo',
        'durationMinutes': 3,
        'scheduledDay': '2026-05-07',
        'position': 21+i,
        'status': statuses[i],
    })

state['competition']['routines'] = real
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state-scale.json','w') as f:
    json.dump(state, f)
print(f'Generated {len(real)} routines')
\""
```

### 2b: Load synthetic state (requires app restart)
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
sleep 2
ssh dart 'cp /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state-real.json'
ssh dart 'cp /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state-scale.json /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json'
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
sleep 15
```

---

## Step 3: Measure at-scale performance

### 3a: App startup time
```bash
ssh dart 'grep -E "App starting|Startup complete" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -2'
```
Calculate time delta. **ASSERT:** < 5 seconds startup

### 3b: WS state message size at 700 routines
```bash
ssh dart "node -e \"
const ws=new(require('ws'))('ws://localhost:9877');
ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>ws.close(),1000)});
ws.on('message',d=>{console.log('Size: '+d.toString().length+' bytes')});
\""
```
**ASSERT:** Size should be small (not the full 700 routines — delta broadcasts used). If > 100KB, the full-broadcast optimization hasn't landed.

### 3c: State file size
```bash
ssh dart 'wc -c /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json'
```
**ASSERT:** < 2MB for 700 routines

### 3d: Advance through routines rapidly (10 nextRoutine in 2 seconds)
```bash
START=$(date +%s%N)
for i in $(seq 1 10); do
  ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'nextRoutine'}));setTimeout(()=>ws.close(),200)},100)});\""
done
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "10 advances in ${ELAPSED}ms"
```
**ASSERT:** < 5000ms total (should be < 2000ms with cached counts)

### 3e: Skip count is accurate
```bash
ssh dart "node -e \"
const ws=new(require('ws'))('ws://localhost:9877');
ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>ws.close(),500)});
ws.on('message',d=>{const m=JSON.parse(d.toString());console.log('total:'+m.total+' skipped:'+m.skippedCount)});
\""
```
**ASSERT:** total + skipped = 700

---

## Step 4: Simulate 2800 upload jobs

### 4a: Generate synthetic job queue
```bash
ssh dart "python3 -c \"
import json, uuid
jobs = []
for i in range(2800):
    jobs.append({
        'id': str(uuid.uuid4()),
        'type': 'upload',
        'routineId': str(uuid.uuid4()),
        'status': ['done','done','done','pending'][i%4],
        'attempts': 1,
        'maxAttempts': 3,
        'createdAt': '2026-03-28T10:00:00.000Z',
        'payload': {'objectName': f'file_{i}.mp4', 'routineId': 'xxx'}
    })
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue-scale.json','w') as f:
    json.dump(jobs, f)
print(f'Generated {len(jobs)} jobs')
\""
```

### 4b: Test getByRoutine performance (code review)
```bash
grep "routineIndex\|Map<string" ~/projects/CompSyncElectronApp/src/main/services/jobQueue.ts
```
**ASSERT:** Uses Map index for O(1) routine lookups, not O(n) filter

---

## Step 5: Restore original state

```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
sleep 2
ssh dart 'cp /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state-real.json /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json'
ssh dart 'rm /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state-scale.json /mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue-scale.json 2>/dev/null'
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
sleep 10
```

---

## Results
- [ ] App starts in < 5s with 700 routines
- [ ] WS state message is reasonable size (< 50KB)
- [ ] State file < 2MB
- [ ] 10 rapid advances complete in < 5s
- [ ] Skip/active counts are accurate
- [ ] Job queue uses Map index for O(1) lookups
- [ ] Original state restored cleanly
