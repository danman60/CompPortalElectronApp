# Flow 03: Photo Import from SD Card

## Purpose
Test photo import: SD card detection, recursive DCIM scan, EXIF timestamp reading, clock offset detection, routine matching, file copy to routine dir, state update, auto-upload of photos.

**DEPENDS_ON:** Flow 02 (at least one routine has been recorded with timestamps)

---

## Step 1: Verify SD card is accessible

```bash
ssh dart '/mnt/c/Windows/System32/cmd.exe /c "dir D:\DCIM /s /b 2>nul || dir E:\DCIM /s /b 2>nul || dir F:\DCIM /s /b 2>nul"' 2>/dev/null | head -20
```
**ASSERT:** At least 1 JPG file found. Note the drive letter.
**ON_FAILURE:** SD card not inserted — SKIP this flow

## Step 2: Check drive detection in logs

```bash
ssh dart 'grep "Camera drive detected" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3'
```
**ASSERT:** Shows drive letter, label, photo count, "DCIM"

## Step 3: Count photos before import

```bash
PHOTO_COUNT=$(ssh dart '/mnt/c/Windows/System32/cmd.exe /c "dir D:\DCIM\*.jpg /s /b 2>nul | find /c /v \"\""' 2>/dev/null | tr -d '\r')
echo "Photos on SD: $PHOTO_COUNT"
```

## Step 4: Record which routines have recording windows

```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
windows = []
for r in state['competition']['routines']:
    if r.get('recordingStartedAt') and r.get('recordingStoppedAt'):
        windows.append(f\\\"{r['entryNumber']:>5s} {r['routineTitle'][:25]:25s} {r['recordingStartedAt'][:19]} → {r['recordingStoppedAt'][:19]}\\\")
print(f'Recording windows: {len(windows)}')
for w in windows: print(f'  {w}')
\""
```

## Step 5: Trigger photo import via WS/IPC

The photo import is triggered by the Photos button (IPC `photos:browse` → `photos:import`). Since we can't click UI from SSH, we check if the DriveAlert auto-detected and imported, OR we read logs for any recent import.

If no recent import, we need to trigger via a workaround — check logs:
```bash
ssh dart 'grep "photos:import" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -3'
```

If no import logged, the test runner should note: "Photo import requires UI interaction (Photos button or SD card dismiss). Mark as MANUAL TEST."

## Step 6: Verify recursive scan found photos

```bash
ssh dart 'grep "Found.*JPEG files" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Count matches SD card photo count. If count is 0, the scan failed (non-recursive bug).

## Step 7: Verify EXIF timestamps read

```bash
ssh dart 'grep "photos have EXIF timestamps" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Format "N/N photos have EXIF timestamps" — first N should equal or be close to total

## Step 8: Verify clock offset detection

```bash
ssh dart 'grep "Clock offset detected\|No clock offset needed" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Present. Note offset value and direction. If cameras were synced, offset should be < 5s.

## Step 9: Verify per-photo matching detail

```bash
ssh dart 'grep -E "EXACT match|GAP match|UNMATCHED" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -20'
```
**ASSERT:** Each photo has a log line showing:
- Filename
- EXIF timestamp
- Adjusted timestamp (after offset)
- Match result (EXACT/GAP/UNMATCHED)
- For unmatched: nearest window and distance

## Step 10: Verify import summary

```bash
ssh dart 'grep "Import complete:" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
**ASSERT:** Shows matched count, unmatched count, offset

## Step 11: Verify photos copied to routine directories

```bash
ssh dart "python3 -c \"
import json, os
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    photos = r.get('photos', [])
    if photos:
        print(f'{r[\"routineTitle\"]}: {len(photos)} photos')
        for p in photos[:3]:
            print(f'  {p[\"confidence\"]} — {p[\"filePath\"][-50:]}')
\""
```
**ASSERT:** At least one routine has photos array populated with filePath, confidence, matchedRoutineId

## Step 12: Verify photo files exist on disk

```bash
ssh dart "python3 -c \"
import json
with open('/mnt/c/Users/User/AppData/Roaming/compsync-media/compsync-state.json') as f:
    state = json.load(f)
for r in state['competition']['routines']:
    for p in r.get('photos', []):
        print(p['filePath'])
\"" | head -10 | while read fp; do
  ssh dart "/mnt/c/Windows/System32/cmd.exe /c \"if exist \\\"$fp\\\" (echo EXISTS) else (echo MISSING: $fp)\"" 2>/dev/null
done
```
**ASSERT:** All photo files exist at their state-recorded paths

## Step 13: Verify auto-upload of photos (if auto-upload ON)

```bash
ssh dart 'grep "enqueued upload job.*photo\|Upload.*photo.*jpg" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -10'
```
**ASSERT:** Photo upload jobs enqueued after import (if autoUploadAfterEncoding is enabled)

## Step 14: Verify state broadcast happened

```bash
ssh dart 'grep "STATE_ROUTINE_UPDATE\|broadcastFullState\|Routine.*→.*uploaded" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -5'
```
**ASSERT:** State changes were broadcast to renderer

---

## Edge Cases to Test

### EC1: Re-import same photos
Run import again with same SD card. Should NOT duplicate photos.
```bash
ssh dart 'grep "Import complete" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -2'
```
Compare matched counts — second import should match same photos, not create duplicates.

### EC2: Import with no recording windows
If a fresh competition with 0 recorded routines, all photos should be "unmatched".

### EC3: Camera clock way off (>5 min)
The offset algorithm should still find the right offset if at least some photos overlap with recording windows.

### EC4: Empty DCIM folder
```bash
ssh dart 'grep "Found 0 JPEG" /mnt/c/Users/User/AppData/Roaming/compsync-media/logs/main.log | tail -1'
```
Should log "Found 0 JPEG files" and return gracefully.

---

## Results
- [ ] SD card detected with correct photo count
- [ ] Recursive scan found photos in subdirectories
- [ ] EXIF timestamps read successfully
- [ ] Clock offset detected (or correctly zero)
- [ ] Per-photo matching logged with detail
- [ ] Matched photos copied to routine directories
- [ ] Photos array updated in state
- [ ] Photo files exist on disk
- [ ] Auto-upload triggered (if enabled)
- [ ] State broadcast sent to renderer
- [ ] No duplicate photos on re-import
