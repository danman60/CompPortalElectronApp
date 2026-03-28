# Flow 06: WebSocket Hub Commands

## Purpose
Test all WS commands that Stream Deck / remote clients can send. Verify state broadcasts after each.

**DEPENDS_ON:** Flow 01 (app running)

---

## Helper: Send WS command and capture state response

```bash
WS_CMD='{"type":"command","action":"ACTION_HERE"}'
ssh dart "node -e \"
const ws=new(require('ws'))('ws://localhost:9877');
let stateCount=0;
ws.on('open',()=>{
  ws.send(JSON.stringify({type:'identify',client:'test'}));
  setTimeout(()=>{
    ws.send(JSON.stringify($WS_CMD));
    setTimeout(()=>ws.close(),2000);
  },500);
});
ws.on('message',d=>{
  stateCount++;
  if(stateCount<=2){
    const m=JSON.parse(d.toString());
    console.log('STATE idx:'+m.index+' total:'+m.total+' rec:'+m.recording?.active+' stream:'+m.streaming);
    if(m.routine)console.log('ROUTINE:'+m.routine.entryNumber+' '+m.routine.routineTitle);
  }
});
\""
```

---

## Step 1: nextRoutine

```bash
# Record index before
BEFORE_IDX=$(ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>ws.close(),500)});ws.on('message',d=>{console.log(JSON.parse(d.toString()).index)});\"")

# Send nextRoutine
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'nextRoutine'}));setTimeout(()=>ws.close(),1000)},500)});\""

sleep 2

# Check index after
AFTER_IDX=$(ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>ws.close(),500)});ws.on('message',d=>{console.log(JSON.parse(d.toString()).index)});\"")

echo "Index: $BEFORE_IDX → $AFTER_IDX"
```
**ASSERT:** AFTER_IDX = BEFORE_IDX + 1 (or wrapped to 0)

## Step 2: prev

Same pattern, assert index decremented.

## Step 3: skip

```bash
# Send skip
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'skip'}));setTimeout(()=>ws.close(),1000)},500)});ws.on('message',d=>{const m=JSON.parse(d.toString());console.log('skipped:'+m.skippedCount)});\""
```
**ASSERT:** skippedCount changed

### Unskip (send skip again on same routine)
**ASSERT:** skippedCount decremented back

## Step 4: toggleRecord

```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'toggleRecord'}));setTimeout(()=>ws.close(),2000)},500)});ws.on('message',d=>{const m=JSON.parse(d.toString());console.log('recording:'+m.recording?.active)});\""
```
Wait 3s, check `recording:true` in state.

Stop recording:
```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'toggleRecord'}));setTimeout(()=>ws.close(),2000)},500)});\""
```
Wait 5s, check `recording:false`.

## Step 5: toggleOverlay elements

For each element (counter, clock, logo, lowerThird):
```bash
ELEMENT="counter"
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'toggleOverlay',element:'$ELEMENT'}));setTimeout(()=>ws.close(),1000)},500)});ws.on('message',d=>{const m=JSON.parse(d.toString());if(m.overlay)console.log('$ELEMENT:'+m.overlay.$ELEMENT.visible)});\""
```
**ASSERT:** Visibility toggled for each element

## Step 6: nextFull

This is the production workflow: stop recording + advance + start recording + fire LT.

```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'nextFull'}));setTimeout(()=>ws.close(),5000)},500)});ws.on('message',d=>{const m=JSON.parse(d.toString());console.log('idx:'+m.index+' rec:'+m.recording?.active+' lt:'+m.overlay?.lowerThird?.visible)});\""
```
Wait 8s. Check:
- Index advanced
- Recording started (if autoRecordOnNext)
- LT fired (visible=true)

Then stop recording:
```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>{ws.send(JSON.stringify({type:'command',action:'toggleRecord'}));setTimeout(()=>ws.close(),2000)},500)});\""
```

## Step 7: Verify state broadcast contains all required fields

```bash
ssh dart "node -e \"const ws=new(require('ws'))('ws://localhost:9877');ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>ws.close(),1000)});ws.on('message',d=>{const m=JSON.parse(d.toString());const keys=Object.keys(m);console.log('Keys:'+keys.join(','));console.log('Has overlay:'+!!m.overlay);console.log('Has overlayLayout:'+!!m.overlayLayout)});\""
```
**ASSERT:** Keys include: type, routine, nextRoutine, index, total, recording, streaming, skippedCount, overlay, overlayLayout

## Step 8: Verify identify message sends immediate state

```bash
ssh dart "node -e \"
let firstMsg=true;
const ws=new(require('ws'))('ws://localhost:9877');
ws.on('open',()=>{
  ws.send(JSON.stringify({type:'identify',client:'test'}));
});
ws.on('message',d=>{
  if(firstMsg){
    firstMsg=false;
    const m=JSON.parse(d.toString());
    console.log('First message type:'+m.type);
    console.log('Has data:'+(m.total>0));
    ws.close();
  }
});
\""
```
**ASSERT:** First message after identify is a full state message

---

## Results
- [ ] nextRoutine advances index
- [ ] prev decrements index
- [ ] skip toggles skipped status
- [ ] toggleRecord starts/stops recording
- [ ] toggleOverlay works for all 4 elements
- [ ] nextFull runs full pipeline (advance + record + LT)
- [ ] State broadcast contains all required fields
- [ ] identify triggers immediate state response
