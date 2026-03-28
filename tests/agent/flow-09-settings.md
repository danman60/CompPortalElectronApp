# Flow 09: Settings Verification

## Purpose
Verify all settings groups render, save, and take effect. Code review + state file verification.

**DEPENDS_ON:** Flow 01 (app running)

---

## Step 1: Read current settings from state

```bash
ssh dart "node -e \"
const ws=new(require('ws'))('ws://localhost:9877');
ws.on('open',()=>{ws.send(JSON.stringify({type:'identify',client:'test'}));setTimeout(()=>ws.close(),500)});
\"" 2>/dev/null
# Settings are stored on disk, not broadcast via WS. Check the settings file:
ssh dart 'cat /mnt/c/Users/User/AppData/Roaming/compsync-media/settings.json 2>/dev/null || echo "No settings file — using defaults"'
```

## Step 2: Verify all settings groups exist in code

### 2a: Competition Setup
```bash
grep -c "judgeCount" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** > 0 (judge count selector exists)

### 2b: Audio Configuration
```bash
grep -c "audioTrackMapping\|audioInputMapping" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** > 0

### 2c: File Naming
```bash
grep -c "fileNaming\|outputDirectory\|pattern" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** > 0

### 2d: FFmpeg Processing
```bash
grep -c "processingMode" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** > 0

### 2e: Judge Resolution (NEW)
```bash
grep -c "judgeResolution" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** > 0 — dropdown with same/720p/480p options

### 2f: NVENC Hardware Encoding (NEW)
```bash
grep -c "useHardwareEncoding\|NVENC" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** > 0 — toggle switch

### 2g: OBS Connection
```bash
grep -c "obs.*url\|obs.*password\|recordingFormat" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** > 0

### 2h: Overlay URL (NEW)
```bash
grep -c "localhost:9876/overlay" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** > 0 — read-only URL with copy button

### 2i: Global Hotkeys
```bash
grep -c "toggleRecording\|nextRoutine\|fireLowerThird\|saveReplay" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** >= 4

### 2j: Behavior Toggles
```bash
grep -c "autoRecordOnNext\|autoUploadAfterEncoding\|autoEncodeRecordings\|syncLowerThird\|confirmBeforeOverwrite\|alwaysOnTop" ~/projects/CompSyncElectronApp/src/renderer/components/Settings.tsx
```
**ASSERT:** >= 6

## Step 3: Verify FFmpeg settings affect encoding

### 3a: Smart encode uses settings
```bash
grep "judgeResolution\|useHardwareEncoding\|h264_nvenc\|libx264" ~/projects/CompSyncElectronApp/src/main/services/ffmpeg.ts | head -10
```
**ASSERT:** `runSmartEncode` reads judgeResolution and useHardwareEncoding from settings

### 3b: Judge resolution creates separate temp video
```bash
grep "tempJudgeVideo\|judge.*scale\|854:480\|1280:720" ~/projects/CompSyncElectronApp/src/main/services/ffmpeg.ts | head -5
```
**ASSERT:** Scale filter applied for 720p (1280:720) and 480p (854:480)

### 3c: NVENC uses correct encoder
```bash
grep "h264_nvenc.*preset.*p4\|rc.*vbr\|cq.*23" ~/projects/CompSyncElectronApp/src/main/services/ffmpeg.ts
```
**ASSERT:** NVENC args: `-c:v h264_nvenc -preset p4 -rc vbr -cq 23`

## Step 4: Verify settings persistence

### 4a: Default values exist
```bash
grep -A5 "DEFAULT_SETTINGS\|defaultSettings" ~/projects/CompSyncElectronApp/src/shared/types.ts | head -20
```
**ASSERT:** All new settings have defaults (judgeResolution: 'same', useHardwareEncoding: false)

### 4b: Settings saved to disk
```bash
grep "settingsPath\|writeFileSync\|settings.*json" ~/projects/CompSyncElectronApp/src/main/services/settings.ts | head -5
```
**ASSERT:** Settings persisted to JSON file

---

## Results
- [ ] Competition Setup (judge count)
- [ ] Audio Configuration (track mapping grid)
- [ ] File Naming (pattern, output dir, preview)
- [ ] FFmpeg Processing Mode (copy/smart/720p/1080p)
- [ ] Judge Resolution (same/720p/480p) — NEW
- [ ] NVENC toggle — NEW
- [ ] CPU Priority
- [ ] OBS Connection (URL, password, format)
- [ ] Overlay URL with Copy button — NEW
- [ ] Global Hotkeys (4 hotkey inputs)
- [ ] Behavior Toggles (6 toggles)
- [ ] Settings persist across restart
- [ ] FFmpeg respects judge resolution setting
- [ ] FFmpeg respects NVENC setting
