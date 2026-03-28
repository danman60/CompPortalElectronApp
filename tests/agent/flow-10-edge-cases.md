# Flow 10: Edge Cases

## Purpose
Test boundary conditions: re-record uploaded routine, skip during recording, simultaneous encode+upload, recording time limit, empty competition, dedup on re-import.

**DEPENDS_ON:** Flow 01 (app running)

---

## Step 1: Re-record an already-uploaded routine

### 1a: Find uploaded routine
```bash
UPLOADED=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['status'] == 'uploaded' and r.get('encodedFiles'):
        print(r['routineTitle'])
        break
\"")
echo "Re-record target: $UPLOADED"
```
**ON_FAILURE:** No uploaded routines — skip this step

### 1b: Navigate to it and start recording
```bash
# Via WS, advance until we reach the target, then toggleRecord
```

### 1c: Verify archive created
```bash
ssh dart "grep 'Archived existing files\|cleared.*old upload jobs' /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3"
```
**ASSERT:** Files archived to `_archive/vN`, old upload jobs cleared

### 1d: Verify state cleaned
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    if r['routineTitle'] == '$UPLOADED':
        assert r.get('photos') is None or r.get('photos') == [], f'Photos not cleared: {r.get(\"photos\")}'
        assert r.get('encodedFiles') is None or r.get('encodedFiles') == [], f'EncodedFiles not cleared'
        assert r.get('error') is None, f'Error not cleared: {r.get(\"error\")}'
        print(f'PASS: state cleaned, status={r[\"status\"]}')
        break
\""
```

### 1e: Stop recording, verify full pipeline runs fresh
```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'toggleRecord'}));setTimeout(()=>ws.close(),2000)},500)});\""
```
Wait 30s for encode+upload.

### 1f: Verify new upload completes (not skipped by dedup)
```bash
ssh dart "grep 'Uploaded.*$UPLOADED\|All uploads complete' /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3"
```
**ASSERT:** Files uploaded (not skipped as "already done")

---

## Step 2: Skip current routine while recording

### 2a: Start recording on a routine
```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'toggleRecord'}));setTimeout(()=>ws.close(),1000)},500)});\""
```
Wait 3s.

### 2b: Skip the routine
```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'skip'}));setTimeout(()=>ws.close(),2000)},500)});ws.on('message',d=>{const m=JSON.parse(d.toString());console.log('rec:'+m.recording?.active+' skipped:'+m.skippedCount)});\""
```

### 2c: Check what happened
```bash
ssh dart 'grep -E "skip|recording.*→" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -5'
```
**ASSERT:** Recording should either continue (skip only affects future advancing) or stop gracefully. App should NOT crash.

### 2d: Stop recording and unskip
```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'toggleRecord'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'skip'}));setTimeout(()=>ws.close(),1000)},1000)},500)});\""
```

---

## Step 3: Simultaneous encode and upload

### 3a: Verify encode doesn't block upload
Record two routines back-to-back. The first should be encoding while the second is also being processed.

```bash
ssh dart 'grep -E "encoding|uploading|encoded|uploaded" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -20'
```
**ASSERT:** Encoding and uploading can happen for different routines simultaneously. The job queues are independent (encode queue vs upload queue).

---

## Step 4: nextFull at end of competition

### 4a: Navigate to last routine
```bash
LAST_ID=$(ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
visible = [r for r in state['competition']['routines'] if r['status'] != 'skipped']
print(visible[-1]['id'])
\"")
```

### 4b: Send nextRoutine at the end
```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'nextRoutine'}));setTimeout(()=>ws.close(),1000)},500)});ws.on('message',d=>{const m=JSON.parse(d.toString());console.log('idx:'+m.index+' total:'+m.total)});\""
```
**ASSERT:** Should not crash. Either wraps to first routine or stays at last.

---

## Step 5: Double-click protection (navBusy guard)

### 5a: Send two nextRoutine commands rapidly
```bash
ssh dart "node -e \"
const ws=new(require('ws'))('ws://localhost:9877');
ws.on('open',()=>{
  ws.send(JSON.stringify({type:'identify',client:'test'}));
  setTimeout(()=>{
    ws.send(JSON.stringify({type:'command',action:'nextRoutine'}));
    ws.send(JSON.stringify({type:'command',action:'nextRoutine'}));
    setTimeout(()=>ws.close(),2000);
  },500);
});
let msgCount=0;
ws.on('message',d=>{
  msgCount++;
  const m=JSON.parse(d.toString());
  console.log('msg'+msgCount+' idx:'+m.index);
});
\""
```
**ASSERT:** Index should advance by exactly 1 (not 2). navBusy guard prevents double-advance.

---

## Step 6: Photo import deduplication

### 6a: Import same photos twice
```bash
# First import
ssh dart 'grep "Import complete:" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
Note matched count.

### 6b: Re-import same folder
The second import should not create duplicate photo files in the routine directory.

```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    photos = r.get('photos', [])
    if len(photos) > 0:
        paths = [p['filePath'] for p in photos]
        dupes = len(paths) - len(set(paths))
        if dupes > 0:
            print(f'FAIL: {r[\"routineTitle\"]} has {dupes} duplicate photos')
        else:
            print(f'PASS: {r[\"routineTitle\"]} — {len(photos)} photos, no dupes')
\""
```
**ASSERT:** No duplicate file paths in any routine's photos array

---

## Step 7: Empty output directory

### 7a: Check behavior when outputDirectory is not set
```bash
grep "No output directory configured" ~/projects/CompSyncElectronApp/src/main/services/recording.ts || \
grep "outputDirectory" ~/projects/CompSyncElectronApp/src/main/services/recording.ts | head -5
```
**ASSERT:** App handles empty outputDirectory gracefully (uses default or warns)

---

## Results
- [ ] Re-record clears old state and uploads fresh
- [ ] Skip during recording doesn't crash
- [ ] Encode and upload run simultaneously for different routines
- [ ] nextRoutine at end of competition doesn't crash
- [ ] navBusy prevents double-advance
- [ ] Photo re-import doesn't create duplicates
- [ ] Empty output directory handled
