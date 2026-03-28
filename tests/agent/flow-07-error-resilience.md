# Flow 07: Error Resilience

## Purpose
Test crash recovery, OBS disconnect handling, file system errors, corrupt state recovery.

**DEPENDS_ON:** Flow 01 (app running)

---

## Step 1: Crash recovery — kill app mid-operation

### 1a: Start a recording
```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'toggleRecord'}));setTimeout(()=>ws.close(),1000)},500)});\""
```
Wait 3s, verify recording started.

### 1b: Kill app forcefully (simulating crash)
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
```

### 1c: Check for orphaned FFmpeg processes
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "tasklist /FI \"IMAGENAME eq ffmpeg.exe\" /NH" 2>&1'
```
Note if any ffmpeg.exe running.

### 1d: Restart app
```bash
sleep 3
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
sleep 10
```

### 1e: Verify crash recovery
```bash
ssh dart 'grep -E "Crash recovery|jobs resumed|orphaned|killed.*FFmpeg" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -5'
```
**ASSERT:** "Crash recovery" logged. Any orphaned FFmpeg killed. Running jobs reset to pending.

### 1f: Verify OBS MKV file preserved
The recording that was interrupted should have produced a partial MKV (OBS saves on crash).
```bash
ssh dart 'grep "RecordStateChanged.*STARTED" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
Check that the MKV path exists:
```bash
# Extract path and check
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "dir \"C:\Users\User\OneDrive\Desktop\OBSOutputter\*.mkv\" /b /o-d" 2>&1' | head -3
```

---

## Step 2: OBS disconnect during idle

### 2a: Simulate OBS disconnect
```bash
# Kill OBS
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM obs64.exe /F" 2>&1'
sleep 3
```

### 2b: Verify disconnect logged
```bash
ssh dart 'grep "OBS.*Disconnected\|OBS.*error" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3'
```
**ASSERT:** Disconnect logged

### 2c: Verify app doesn't crash
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "tasklist /FI \"IMAGENAME eq CompSync Media.exe\" /NH" 2>&1'
```
**ASSERT:** App still running

### 2d: Restart OBS and verify reconnect
```bash
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe\""'
sleep 10
ssh dart 'grep "OBS.*Connected" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Reconnected (if auto-reconnect is implemented)

---

## Step 3: State file corruption recovery

### 3a: Backup current state
```bash
ssh dart 'cp /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json.bak'
```

### 3b: Corrupt the state file
```bash
ssh dart 'echo "{invalid json" > /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json'
```

### 3c: Restart app
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
sleep 3
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
sleep 10
```

### 3d: Verify app starts with fresh state
```bash
ssh dart 'grep -E "State.*error\|State.*corrupt\|fresh" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3'
```
**ASSERT:** App handles corrupt state gracefully (fresh start or error logged)

### 3e: Restore backup
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
sleep 2
ssh dart 'cp /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json.bak /mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json'
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
sleep 10
```

---

## Step 4: Job queue corruption recovery

### 4a: Corrupt job queue
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
sleep 2
ssh dart 'echo "[]" > /mnt/c/Users/User/AppData/Roaming/compsync-media/job-queue.json'
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
sleep 10
```

### 4b: Verify app starts cleanly
```bash
ssh dart 'grep "Job queue.*loaded\|Job queue.*error" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3'
```
**ASSERT:** "loaded 0 jobs" — empty queue is valid

---

## Step 5: 15-minute recording limit

### 5a: Verify limit exists in code (code review)
```bash
grep "MAX_RECORD_SECONDS" ~/projects/CompSyncElectronApp/src/main/services/obs.ts
```
**ASSERT:** `15 * 60` = 900 seconds

### 5b: Verify timer logic
```bash
grep -A3 "MAX_RECORD_SECONDS" ~/projects/CompSyncElectronApp/src/main/services/obs.ts
```
**ASSERT:** Calls `stopRecord()` when `recordTimeSec >= MAX_RECORD_SECONDS`

---

## Step 6: Port conflict handling

### 6a: Verify EADDRINUSE handling for overlay (9876) and WS hub (9877)
```bash
grep -A3 "EADDRINUSE" ~/projects/CompSyncElectronApp/src/main/services/overlay.ts ~/projects/CompSyncElectronApp/src/main/services/wsHub.ts
```
**ASSERT:** Error is caught and logged, app doesn't crash

---

## Results
- [ ] App recovers from force-kill
- [ ] Orphaned FFmpeg processes cleaned up
- [ ] Running jobs reset to pending on restart
- [ ] MKV files preserved after crash
- [ ] OBS disconnect handled gracefully
- [ ] App survives OBS restart
- [ ] Corrupt state file doesn't crash app
- [ ] Corrupt job queue doesn't crash app
- [ ] 15-min recording limit implemented
- [ ] Port conflicts handled gracefully
