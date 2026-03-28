# Flow 05: Overlay System

## Purpose
Test overlay toggle, fire/hide lower third, layout positioning via WS, animation, auto-hide timer.

**DEPENDS_ON:** Flow 01 (app running)

---

## Step 1: Verify overlay server responds

```bash
ssh dart 'curl -s -o /dev/null -w "%{http_code}" http://localhost:9876/overlay'
```
**ASSERT:** 200

```bash
ssh dart 'curl -s http://localhost:9876/current | python3 -m json.tool'
```
**ASSERT:** Valid JSON with fields: entryNumber, routineName, dancers, studioName, category, logoUrl, visible

## Step 2: Toggle each overlay element

### 2a: Toggle counter
```bash
ssh dart 'node -e "
const ws=new(require(\"ws\"))(\"ws://localhost:9877\");
ws.on(\"open\",()=>{
  ws.send(JSON.stringify({type:\"identify\",client:\"test\"}));
  setTimeout(()=>{
    ws.send(JSON.stringify({type:\"command\",action:\"toggleOverlay\",element:\"counter\"}));
    setTimeout(()=>ws.close(),1000);
  },500);
});
ws.on(\"message\",d=>{const m=JSON.parse(d.toString());if(m.overlay)console.log(\"counter:\"+m.overlay.counter.visible)});
"'
```
**ASSERT:** counter visibility toggled

Repeat for: `clock`, `logo`, `lowerThird`

### 2b: Verify toggle logged
```bash
ssh dart 'grep "Overlay.*ON\|Overlay.*OFF" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -8'
```
**ASSERT:** Each toggle logged with element name and new state

## Step 3: Fire lower third

### 3a: Ensure a routine is selected (has data to display)
```bash
ssh dart 'curl -s http://localhost:9876/current | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get(\"entryNumber\",\"NONE\"))"'
```
If "NONE", select a routine first.

### 3b: Fire LT
```bash
ssh dart 'grep -c "lower third fired" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log' > /tmp/lt_count_before
```

Fire via WS (using toggleOverlay on lowerThird to make visible):
```bash
ssh dart 'node -e "
const ws=new(require(\"ws\"))(\"ws://localhost:9877\");
ws.on(\"open\",()=>{
  ws.send(JSON.stringify({type:\"identify\",client:\"test\"}));
  setTimeout(()=>ws.close(),2000);
});
ws.on(\"message\",d=>{
  const m=JSON.parse(d.toString());
  if(m.overlay) console.log(\"LT visible:\"+m.overlay.lowerThird.visible+\" entry:\"+m.overlay.lowerThird.entryNumber+\" title:\"+m.overlay.lowerThird.routineTitle);
});
"'
```

### 3c: Verify LT has routine data
```bash
ssh dart 'grep "lower third fired" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** "Overlay lower third fired"

### 3d: Wait for auto-hide (default 8s)
```bash
sleep 10
ssh dart 'grep "lower third hidden" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** "Overlay lower third hidden" (auto-hide after configured seconds)

## Step 4: Verify overlay HTML content

```bash
ssh dart 'curl -s http://localhost:9876/overlay | grep -o "position: absolute[^;]*" | head -10'
```
**ASSERT:** Contains position styles for counter, clock, logo, lower-third elements

## Step 5: Test layout positioning via WS

The overlay HTML applies layout from `state.overlayLayout` on each state broadcast.

### 5a: Get current layout from WS state
```bash
ssh dart 'node -e "
const ws=new(require(\"ws\"))(\"ws://localhost:9877\");
ws.on(\"open\",()=>{
  ws.send(JSON.stringify({type:\"identify\",client:\"test\"}));
  setTimeout(()=>ws.close(),1000);
});
ws.on(\"message\",d=>{
  const m=JSON.parse(d.toString());
  if(m.overlayLayout) console.log(JSON.stringify(m.overlayLayout,null,2));
});
"'
```
**ASSERT:** Returns layout with counter, clock, logo, lowerThird positions (x/y percentages)

### 5b: Verify layout values are in valid range
All x/y values should be 0-100 (percentages).

## Step 6: Verify overlay elements in HTML use layout positions

```bash
ssh dart 'curl -s http://localhost:9876/overlay | grep -oP "left: \d+(\.\d+)?%" | head -5'
```
**ASSERT:** Positions match the layout values (not hardcoded px values)

---

## Results
- [ ] Overlay HTTP returns 200
- [ ] /current endpoint returns routine JSON
- [ ] Counter toggle works
- [ ] Clock toggle works
- [ ] Logo toggle works
- [ ] LowerThird toggle works
- [ ] Fire LT logs correctly
- [ ] LT displays routine data (entry, title, dancers)
- [ ] Auto-hide fires after configured seconds
- [ ] Layout positions sent via WS state
- [ ] Overlay HTML uses percentage-based positions
