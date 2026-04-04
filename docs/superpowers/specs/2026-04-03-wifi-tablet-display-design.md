# Wireless Tablet Display for CompSync

## Overview

Integrate the WifiDisplay streaming server into CompSync Electron as a managed feature, and build a new Android app (CSController) that combines the video stream with CompSync control buttons.

**Production workflow:**
1. Open CompSync on DART
2. Click "Tablet" button → pick which monitor to stream (one-time setup)
3. Toggle streaming on → wifi-display-server.exe starts as child process
4. User manually sets OBS to fullscreen-project onto the virtual monitor
5. Open CSController on Android tablet → enter DART IP
6. Tablet shows OBS output (touch for scene switching) + 11 CS control buttons

## Architecture

```
DART (Windows)
├── CompSync Electron
│   ├── wifiDisplay service (NEW)
│   │   ├── Enumerate monitors via Electron screen API
│   │   ├── Spawn/kill wifi-display-server.exe as child process
│   │   └── Expose start/stop/status/config via IPC
│   └── wsHub (EXISTING, port 9877)
│       └── Accepts commands from StreamDeck AND CSController
│
├── wifi-display-server.exe (external binary, spawned by CS)
│   ├── Captures target monitor (Desktop Duplication API)
│   ├── H.264 encode (OpenH264)
│   ├── UDP :5000 → video frames to tablet
│   └── UDP :5001 ← touch input from tablet → Windows SendInput
│
├── Virtual Display Driver (bundled with CS installer, always-on after install)
└── VDDControl.exe (bundled, for driver install/config)

Android Tablet
└── CSController App (NEW)
    ├── Video area (~80%) — H.264 decode via MediaCodec, touch → UDP :5001
    ├── Status strip — routine name, entry #, recording timer
    └── Button bar (~20%) — 11 CS buttons → WebSocket :9877
```

## CompSync Electron Changes

### New Service: `src/main/services/wifiDisplay.ts`

**Responsibilities:**
- `getMonitors()` — wraps `screen.getAllDisplays()`, returns list with label, resolution, bounds, id
- `start()` — spawns `wifi-display-server.exe` with saved config as CLI args
- `stop()` — kills child process gracefully
- `getStatus()` — returns { running, pid }
- PID file at `app.userData/wifi-display.pid` for orphan cleanup on startup (same pattern as FFmpeg)
- Kill process on `app.on('before-quit')`

**Process spawning** (mirrors FFmpeg pattern):
```
spawn(binaryPath, [
  '--monitor-index', monitorIndex,
  '--bitrate', bitrate,
  '--fps', fps,
  '--video-port', videoPort,
  '--touch-port', touchPort,
  ...(clientIp ? ['--client', clientIp] : [])
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
```

Parse stderr for status/stats logging (Rust server uses `tracing` crate, outputs to stderr).

**Error handling:**
- `start()` validates binary exists at path before spawning, returns error if missing
- Version check: `spawn(binaryPath, ['--help'])` to verify binary is valid before real start
- On spawn failure (ENOENT, EACCES): return descriptive error to renderer via IPC
- On process crash (unexpected exit): log error, set status to stopped, notify renderer
- No auto-restart — user re-clicks the button

**Graceful shutdown:**
- `stop()` sends SIGTERM to child process
- 5s timeout → SIGKILL if still running (mirrors FFmpeg shutdown pattern)
- PID file deleted on clean stop

### Settings Additions

Added to `AppSettings` in `src/shared/types.ts`:

```typescript
wifiDisplay: {
  binaryPath: string | null      // path to wifi-display-server.exe
  monitorIndex: number | null     // null = not configured
  bitrate: number                 // kbps, default 3000
  fps: number                     // default 30
  clientIp: string | null         // null = broadcast
  videoPort: number               // default 5000
  touchPort: number               // default 5001
  autoStart: boolean              // start streaming on app launch
}
```

**Default values** (added to `DEFAULT_SETTINGS`):
```typescript
wifiDisplay: {
  binaryPath: null,
  monitorIndex: null,
  bitrate: 3000,
  fps: 30,
  clientIp: null,
  videoPort: 5000,
  touchPort: 5001,
  autoStart: false
}
```

### New IPC Channels

String values follow existing colon-delimited convention:

| Constant | String Value | Direction | Purpose |
|----------|-------------|-----------|---------|
| `WIFI_DISPLAY_GET_MONITORS` | `wifi-display:get-monitors` | invoke | Returns display list |
| `WIFI_DISPLAY_START` | `wifi-display:start` | invoke | Start streaming server |
| `WIFI_DISPLAY_STOP` | `wifi-display:stop` | invoke | Stop streaming server |
| `WIFI_DISPLAY_STATUS` | `wifi-display:status` | invoke | Get running/stopped + pid |
| `WIFI_DISPLAY_SET_MONITOR` | `wifi-display:set-monitor` | invoke | Save monitor selection to settings |

### UI Changes

**Header:** New "Tablet" button with green/gray status dot.
- Unconfigured: opens Settings to wifi display section
- Configured: toggles streaming on/off

**Settings panel:** New "Tablet Display" section:
- Binary path (file browse)
- Monitor dropdown (populated from `getMonitors()`)
- Bitrate slider (1000-10000 kbps)
- FPS dropdown (15/24/30/60)
- Client IP field (optional, blank = broadcast)
- Port fields (video/touch)
- Auto-start checkbox
- Connection info display: shows DART IP + ports for tablet setup

### Renderer Store

New state in Zustand store:
```typescript
wifiDisplayState: {
  running: boolean
  monitorIndex: number | null
}
```

Updated via IPC on start/stop.

## Android App: CSController

### Project Structure

New project: `CSController/` (Kotlin, Jetpack Compose, min SDK 26)

Reuses from WifiDisplay repo:
- `UdpReceiver.kt` — packet reassembly
- `VideoDecoder.kt` — MediaCodec H.264 decode to SurfaceView
- `TouchSender.kt` — normalized touch coords over UDP

New code:
- `WsController.kt` — WebSocket client to wsHub (port 9877)
- `ConnectionScreen.kt` — IP entry, saved to SharedPreferences
- `DisplayScreen.kt` — video + status strip + button bar

### Screen Layout

```
┌──────────────────────────────────┐
│                                  │
│        H.264 Video Stream        │
│     (SurfaceView, aspect-fit,    │
│      black letterbox if needed)  │
│                                  │
│   Touch anywhere = UDP to DART   │
│   (OBS scene switching via       │
│    Windows SendInput injection)  │
│                                  │
├──────────────────────────────────┤
│ #42 IN A SPIN          ●REC 2:31│  ← status strip
├────────┬────────┬────────────────┤
│ ◄ Prev │ Next ▶ │  Next Full ▶▶  │
├────────┼────────┼───────┬────────┤
│ ● Rec  │  Skip  │Stream │Replay  │
├────────┼────────┼───────┼────────┤
│  L3rd  │Counter │ Clock │  Logo  │
└────────┴────────┴───────┴────────┘
```

### Button Definitions

All 11 buttons send commands via WebSocket using the existing wsHub protocol:

| Button | wsHub Command | Visual State |
|--------|--------------|--------------|
| Prev | `prev` | — |
| Next | `nextRoutine` | — |
| Next Full | `nextFull` | — |
| Rec | `toggleRecord` | Red when recording |
| Skip | `skip` | Orange when skipped |
| Stream | `toggleStream` | Green when streaming |
| Replay | `saveReplay` | Flash on tap |
| L3rd | `toggleOverlay` element:`lowerThird` | Green when visible |
| Counter | `toggleOverlay` element:`counter` | Green when visible |
| Clock | `toggleOverlay` element:`clock` | Green when visible |
| Logo | `toggleOverlay` element:`logo` | Green when visible |

### Status Strip

Populated from wsHub state broadcasts (same payload StreamDeck receives):
- Current routine: entry number + title
- Recording state: dot + timer
- OBS connection: indicator

### WebSocket Protocol

Connects to `ws://<host>:9877` using existing protocol:
```json
// Identify
{ "type": "identify", "client": "tablet" }

// Send command
{ "type": "command", "action": "nextRoutine" }
{ "type": "command", "action": "toggleOverlay", "element": "lowerThird" }

// Receives state broadcasts (same as StreamDeck)
{ "type": "state", "data": { ... } }
```

**wsHub change required:** Add `'tablet'` to the `WSIdentifyMessage` client union type in `types.ts` (currently `'overlay' | 'streamdeck'`). No handler logic changes — tablet uses the same command protocol as streamdeck.

### State Broadcast Fields Used by CSController

From the existing `WSStateMessage` data payload:
- `currentRoutine.entryNumber` + `currentRoutine.routineTitle` → status strip text
- `obs.isRecording` + `obs.recordTimeSec` → recording indicator + timer
- `obs.isStreaming` → Stream button green state
- `obs.connectionStatus` → OBS connection indicator
- `overlay.lowerThird.visible` → L3rd button state
- `overlay.counter.visible` → Counter button state
- `overlay.clock.visible` → Clock button state
- `overlay.logo.visible` → Logo button state
- `currentRoutine.skipped` → Skip button orange state

## Binary & Driver Management

### wifi-display-server.exe
Path configured in Settings (like FFmpeg custom path). User points it at wherever the built binary lives on DART. No bundling for now.

### Virtual Display Driver (VDD)
The VDD kernel driver + VDDControl.exe must be bundled with the CompSync installer (electron-builder NSIS). The driver creates the virtual monitor that OBS projects to and the streaming server captures.

**Install flow:**
- CS installer includes VDD files + `driver-setup.exe` in resources
- Installer runs `driver-setup.exe` as part of NSIS postinstall (requires admin/elevation)
- VDDControl.exe bundled in resources for user to configure virtual display resolution if needed
- Driver persists across reboots — install is one-time

**CS can detect if VDD is installed** by checking if any display from `screen.getAllDisplays()` matches known VDD characteristics (or by checking registry/device manager programmatically). If not installed, the Tablet Display settings section shows "Virtual Display Driver not installed" with an Install button that runs the bundled `driver-setup.exe`.

## APK Delivery

CSController APK is sideloaded onto the Android tablet. Built locally, transferred via USB or shared folder. No Play Store for now.

## Scope Exclusions

- No runtime VDD create/destroy from CS UI — driver installed once via installer, configured via VDDControl
- No OBS projector automation — user sets this manually in OBS
- No auto-discovery/mDNS — manual IP entry on tablet
- No multi-client — one tablet at a time
- No audio streaming — video only
- No QR code pairing (nice-to-have for later)
