# Implementation Plan: Wireless Tablet Display

Spec: `docs/superpowers/specs/2026-04-03-wifi-tablet-display-design.md`

## Phase 1: Electron Backend (types, service, IPC, preload)

### Task 1.1: Add types and IPC channels to `src/shared/types.ts`

**File:** `src/shared/types.ts`

1. Add `wifiDisplay` section to `AppSettings` interface (after `tether` block, ~line 271):
```typescript
wifiDisplay: {
  binaryPath: string | null
  monitorIndex: number | null
  bitrate: number
  fps: number
  clientIp: string | null
  videoPort: number
  touchPort: number
  autoStart: boolean
}
```

2. Add defaults to `DEFAULT_SETTINGS` (after `tether` block, ~line 671):
```typescript
wifiDisplay: {
  binaryPath: null,
  monitorIndex: null,
  bitrate: 3000,
  fps: 30,
  clientIp: null,
  videoPort: 5000,
  touchPort: 5001,
  autoStart: false,
},
```

3. Add IPC channels to `IPC_CHANNELS` (after TETHER block, ~line 417):
```typescript
// Wifi Display
WIFI_DISPLAY_GET_MONITORS: 'wifi-display:get-monitors',
WIFI_DISPLAY_START: 'wifi-display:start',
WIFI_DISPLAY_STOP: 'wifi-display:stop',
WIFI_DISPLAY_STATUS: 'wifi-display:status',
WIFI_DISPLAY_SET_MONITOR: 'wifi-display:set-monitor',
```

4. Add `'tablet'` to `WSIdentifyMessage.client` union (~line 560):
```typescript
client: 'overlay' | 'streamdeck' | 'tablet'
```

5. Add `WifiDisplayState` interface:
```typescript
export interface WifiDisplayState {
  running: boolean
  monitorIndex: number | null
}
```

6. Add `MonitorInfo` interface:
```typescript
export interface MonitorInfo {
  id: number
  label: string
  width: number
  height: number
  x: number
  y: number
}
```

### Task 1.2: Create `src/main/services/wifiDisplay.ts`

**New file.** Pattern mirrors FFmpeg process management.

```typescript
// Key exports:
// getMonitors(): MonitorInfo[] — wraps screen.getAllDisplays()
// start(): Promise<void> — spawns wifi-display-server.exe
// stop(): Promise<void> — SIGTERM then 5s timeout → SIGKILL
// getStatus(): WifiDisplayState
// killOrphanedProcess(): void — called on startup
// cleanup(): void — called on before-quit
```

Implementation details:
- Use `child_process.spawn` with `stdio: ['pipe', 'pipe', 'pipe']` and `windowsHide: true`
- PID file: `path.join(app.getPath('userData'), 'wifi-display.pid')`
- Parse stderr for tracing output (Rust `tracing` crate format)
- On child process `exit` event: update state, delete PID file, log exit code
- `start()` validates: binary path exists, monitorIndex is set
- `stop()`: `process.kill(pid, 'SIGTERM')`, setTimeout 5s → `process.kill(pid, 'SIGKILL')`
- `killOrphanedProcess()`: read PID file, check if process alive, kill if so
- `getMonitors()`: `screen.getAllDisplays().map(d => ({ id: d.id, label: d.label, width: d.size.width, height: d.size.height, x: d.bounds.x, y: d.bounds.y }))`

### Task 1.3: Register IPC handlers in `src/main/ipc.ts`

Add to `registerAllHandlers()`:

```typescript
import * as wifiDisplay from './services/wifiDisplay'

// --- Wifi Display ---
safeHandle(IPC_CHANNELS.WIFI_DISPLAY_GET_MONITORS, () => {
  return wifiDisplay.getMonitors()
})
safeHandle(IPC_CHANNELS.WIFI_DISPLAY_START, async () => {
  await wifiDisplay.start()
  return wifiDisplay.getStatus()
})
safeHandle(IPC_CHANNELS.WIFI_DISPLAY_STOP, async () => {
  await wifiDisplay.stop()
  return wifiDisplay.getStatus()
})
safeHandle(IPC_CHANNELS.WIFI_DISPLAY_STATUS, () => {
  return wifiDisplay.getStatus()
})
safeHandle(IPC_CHANNELS.WIFI_DISPLAY_SET_MONITOR, (monitorIndex: unknown) => {
  const s = settings.getSettings()
  settings.setSettings({ wifiDisplay: { ...s.wifiDisplay, monitorIndex: monitorIndex as number } })
  return { ok: true }
})
```

### Task 1.4: Add preload API methods in `src/preload/index.ts`

Add after tether section:

```typescript
// Wifi Display
wifiDisplayGetMonitors: () => ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_GET_MONITORS),
wifiDisplayStart: () => ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_START),
wifiDisplayStop: () => ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_STOP),
wifiDisplayStatus: () => ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_STATUS),
wifiDisplaySetMonitor: (monitorIndex: number) =>
  ipcRenderer.invoke(IPC_CHANNELS.WIFI_DISPLAY_SET_MONITOR, monitorIndex),
```

### Task 1.5: Wire into main process lifecycle in `src/main/index.ts`

1. Add import: `import * as wifiDisplay from './services/wifiDisplay'`
2. After `ffmpegService.killOrphanedProcess()` (~line 151), add: `wifiDisplay.killOrphanedProcess()`
3. After tether auto-start block (~line 200), add auto-start for wifi display:
```typescript
const wdSettings = getSettings().wifiDisplay
if (wdSettings?.autoStart && wdSettings.binaryPath && wdSettings.monitorIndex !== null) {
  wifiDisplay.start().then(() => {
    logger.app.info('Auto-started wifi display streaming')
  }).catch((err: Error) => {
    logger.app.warn(`Auto-start wifi display failed: ${err.message}`)
  })
}
```
4. In the `before-quit` handler (if one exists, or add one): `wifiDisplay.cleanup()`

## Phase 2: Electron Frontend (store, settings UI, header button)

### Task 2.1: Add wifi display state to Zustand store

**File:** `src/renderer/store/useStore.ts`

1. Import `WifiDisplayState` from types
2. Add to `AppStore` interface:
```typescript
wifiDisplayState: WifiDisplayState
setWifiDisplayState: (state: WifiDisplayState) => void
```
3. Add default state:
```typescript
wifiDisplayState: { running: false, monitorIndex: null },
setWifiDisplayState: (state) => set({ wifiDisplayState: state }),
```

### Task 2.2: Add Tablet Display section to Settings panel

**File:** `src/renderer/components/Settings.tsx`

Add a new collapsible section "Tablet Display" with:
- Binary path input + Browse button (uses `settingsBrowseFile` with `.exe` filter)
- Monitor dropdown (calls `wifiDisplayGetMonitors()` to populate, shows label + resolution)
- Bitrate number input (default 3000)
- FPS select (15/24/30/60)
- Client IP text input (optional)
- Video port / Touch port number inputs
- Auto-start checkbox
- Connection info: display the machine's IP addresses + configured ports (read-only)

Follow the same pattern as the existing FFmpeg and Tether settings sections.

### Task 2.3: Add Tablet button to Header

**File:** `src/renderer/components/Header.tsx`

Add a "Tablet" button in the action bar (after Recovery, before pause controls):
- Icon: tablet/monitor icon or "📱"
- Shows green dot when streaming is active, gray when stopped
- Click behavior:
  - If `wifiDisplay.binaryPath` is null or `monitorIndex` is null: open Settings panel
  - Otherwise: toggle start/stop via `wifiDisplayStart()` / `wifiDisplayStop()`
- Fetch initial status on mount via `wifiDisplayStatus()`

## Phase 3: Android App (CSController)

### Task 3.1: Scaffold Android project

**Location:** `/home/danman60/projects/CSController/`

Create new Android project:
- Package: `com.compsync.controller`
- Min SDK 26, Target SDK 34
- Jetpack Compose + Material3
- Dependencies: OkHttp (WebSocket), kotlinx-serialization

Project structure:
```
app/src/main/java/com/compsync/controller/
├── MainActivity.kt
├── network/
│   ├── UdpReceiver.kt      (copy from WifiDisplay, unchanged)
│   ├── TouchSender.kt      (copy from WifiDisplay, unchanged)
│   └── WsController.kt     (NEW — WebSocket client for wsHub)
├── codec/
│   └── VideoDecoder.kt     (copy from WifiDisplay, unchanged)
└── ui/
    ├── ConnectionScreen.kt  (modified — add CS branding)
    ├── DisplayScreen.kt     (NEW — video + status + buttons)
    └── theme/
        └── Theme.kt
```

### Task 3.2: Copy and adapt network/codec from WifiDisplay

Copy these files from `~/projects/WifiDisplay/android/app/src/main/java/com/wifidisplay/`:
- `network/UdpReceiver.kt` → update package to `com.compsync.controller.network`
- `network/TouchSender.kt` → update package
- `codec/VideoDecoder.kt` → update package

No logic changes — just package rename.

### Task 3.3: Create WsController.kt

**New file:** WebSocket client that connects to wsHub.

```kotlin
// Connects to ws://<host>:9877
// Sends: { "type": "identify", "client": "tablet" }
// Sends commands: { "type": "command", "action": "nextRoutine" }
// Receives state broadcasts, parses into CompSyncState data class
// Auto-reconnect with exponential backoff (1s → 30s max)
// Exposes: StateFlow<CompSyncState> for UI observation
// Exposes: fun sendCommand(action: String, element: String? = null)
```

`CompSyncState` data class:
```kotlin
data class CompSyncState(
    val connected: Boolean = false,
    val entryNumber: String = "",
    val routineTitle: String = "",
    val isRecording: Boolean = false,
    val recordTimeSec: Int = 0,
    val isStreaming: Boolean = false,
    val obsConnected: Boolean = false,
    val isSkipped: Boolean = false,
    val lowerThirdVisible: Boolean = false,
    val counterVisible: Boolean = false,
    val clockVisible: Boolean = false,
    val logoVisible: Boolean = false,
)
```

### Task 3.4: Create ConnectionScreen.kt

Modified from WifiDisplay's ConnectionScreen:
- CS branding (CompSync Controller title)
- IP address input, saved to SharedPreferences
- Video port input (default 5000)
- Touch port input (default 5001)
- WS port input (default 9877)
- Connect button → navigates to DisplayScreen
- Shows last-used connection info

### Task 3.5: Create DisplayScreen.kt

**New file.** Main screen with three zones:

1. **Video area** (weight ~0.75 of screen height):
   - `AndroidView` wrapping `SurfaceView` for H.264 decode
   - Touch events → `TouchSender` (normalized coords over UDP)
   - Black background, aspect-fit with letterboxing

2. **Status strip** (fixed height ~40dp):
   - Row: entry number + routine title (left), recording indicator + timer (right)
   - Dark background, white text
   - Updates from `WsController.state` StateFlow

3. **Button grid** (weight ~0.25 of screen height):
   - 3 rows x 4 columns grid (last row has 3 buttons + status)
   - Row 1: Prev | Next | Next Full | (empty or wider Next Full)
   - Row 2: Rec | Skip | Stream | Replay
   - Row 3: L3rd | Counter | Clock | Logo
   - Each button: colored background based on state (red=recording, green=active, gray=idle)
   - Tap → `WsController.sendCommand(action, element?)`
   - Haptic feedback on tap

### Task 3.6: Wire up MainActivity.kt

- Navigation: ConnectionScreen → DisplayScreen
- Pass host/ports as nav args
- Handle lifecycle: stop video decoder on pause, reconnect WebSocket on resume
- Full-screen immersive mode (hide system bars)
- Keep screen on (`FLAG_KEEP_SCREEN_ON`)

## Phase 4: Build & Verify

### Task 4.1: Build Electron app
- `npm run build` in CompSyncElectronApp
- Verify `tsc` passes with no type errors
- Verify new IPC channels work (start/stop with a dummy binary path)

### Task 4.2: Build Rust streaming server on DART
- `cd ~/projects/WifiDisplay/server && cargo build --release`
- Binary at `target/release/wifi-display-server.exe`
- Verify it runs: `wifi-display-server.exe --help`

### Task 4.3: Build Android APK
- `cd ~/projects/CSController && ./gradlew assembleDebug`
- APK at `app/build/outputs/apk/debug/app-debug.apk`
- Sideload to tablet

### Task 4.4: End-to-end test
- Set wifi-display-server.exe path in CS settings
- Select virtual monitor in dropdown
- Click Tablet button → verify server process starts
- Open CSController on tablet → enter DART IP
- Verify video stream appears
- Tap buttons → verify CS responds
- Click stop → verify server process dies
- Quit CS → verify server process killed
