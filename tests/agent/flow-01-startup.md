# Flow 01: Startup & Connection

## Purpose
Verify app launches cleanly, connects to OBS, loads competition, restores state, starts all services.

---

## Step 1: Kill any existing instance
```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "taskkill /IM \"CompSync Media.exe\" /F" 2>&1'
```
Wait 3s.

## Step 2: Clear log for clean test
```bash
ssh dart 'echo "" > /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```

## Step 3: Launch app
```bash
ssh dart 'powershell.exe -Command "Start-Process \"C:\\Program Files\\CompSync Media\\CompSync Media.exe\""'
```
Wait 10s for full startup.

## Step 4: Verify startup sequence in logs

### 4a: App version logged
```bash
ssh dart 'grep "App starting" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Contains "App starting, version: 2.5.0" (or current version)

### 4b: State loaded
```bash
ssh dart 'grep "State loaded" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Contains "State loaded from" path

### 4c: OBS connected
```bash
ssh dart 'grep "OBS.*Connected" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Contains "Connected in" with ms timing
**ON_FAILURE:** Check if OBS is running. `ssh dart '/mnt/c/Windows/System32/cmd.exe /c "tasklist /FI \"IMAGENAME eq obs64.exe\" /NH" 2>&1'`

### 4d: Share code resolved
```bash
ssh dart 'grep "Share code resolved" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Contains competition name "EMPWR Dance"

### 4e: FFmpeg available
```bash
ssh dart 'grep "FFmpeg available" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Contains "ffmpeg version"

### 4f: System monitor started
```bash
ssh dart 'grep "System monitor started" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Contains "5s interval"

### 4g: WS hub and overlay server
```bash
ssh dart 'grep -E "WebSocket hub|Overlay server" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Both "WebSocket hub listening on ws://localhost:9877" and "Overlay server running on http://127.0.0.1:9876"

### 4h: Hotkeys registered
```bash
ssh dart 'grep "hotkeys registered" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Contains hotkey list

### 4i: Drive monitor started
```bash
ssh dart 'grep "Drive monitor" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Contains "Drive monitor started"

### 4j: Startup complete
```bash
ssh dart 'grep "Startup complete" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log'
```
**ASSERT:** Present. Note any resumed jobs count.

## Step 5: Verify state file integrity
```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
comp = state.get('competition', {})
print(f'Competition: {comp.get(\"name\",\"MISSING\")}')
print(f'Routines: {len(comp.get(\"routines\",[]))}')
print(f'Current: {state.get(\"currentRoutineId\",\"none\")[:8]}')
\""
```
**ASSERT:** Competition name present, routine count > 0

## Step 6: Verify WS hub accepts connections
```bash
ssh dart 'node -e "
const ws=new(require(\"ws\"))(\"ws://localhost:9877\");
ws.on(\"open\",()=>{
  ws.send(JSON.stringify({type:\"identify\",client:\"test\"}));
  setTimeout(()=>ws.close(),500);
});
ws.on(\"message\",d=>{
  const msg=JSON.parse(d.toString());
  console.log(\"type:\"+msg.type+\" total:\"+msg.total+\" recording:\"+msg.recording?.active);
});
ws.on(\"error\",e=>console.log(\"ERROR:\"+e.message));
"'
```
**ASSERT:** Receives state message with `type:state`, `total:` > 0

## Step 7: Verify overlay HTTP endpoint
```bash
ssh dart 'curl -s -o /dev/null -w "%{http_code}" http://localhost:9876/overlay'
```
**ASSERT:** Returns 200

```bash
ssh dart 'curl -s http://localhost:9876/current'
```
**ASSERT:** Returns valid JSON with `entryNumber`, `routineName` fields

---

## Results
- [ ] App version logged
- [ ] State restored
- [ ] OBS connected
- [ ] Competition loaded via share code
- [ ] FFmpeg validated
- [ ] System monitor active
- [ ] WS hub accepting connections
- [ ] Overlay server responding
- [ ] Hotkeys registered
- [ ] Drive monitor active
- [ ] Startup complete with no errors
