# MTP/PTP Camera Tethering — Implementation Plan

## Goal
Enable automatic photo transfer from USB-connected cameras using MTP/PTP protocol on Windows, without requiring the user to install separate tethering software or set the camera to mass storage mode.

## Why MTP/PTP
Most modern cameras (2018+) default to MTP/PTP mode over USB. Mass storage mode is being removed from newer models. The current folder-watch approach only works when the camera mounts as a drive letter, which many cameras no longer do.

## Architecture

```
Camera (USB, MTP/PTP mode)
    |
    v
WPD Helper (C#/.NET subprocess)
    |  - Uses Windows Portable Devices COM API
    |  - Watches for new items via WPD events
    |  - Copies new photos to a staging folder
    |  - Writes metadata JSON per photo (filename, capture time, camera model)
    |
    v
Staging Folder (local NTFS)
    |
    v
Existing tether.ts (chokidar watcher)
    |  - Reads EXIF from staged photos
    |  - Matches to routines by capture time
    |  - Thumbnails, uploads, etc.
```

## Components

### 1. WPD Helper — C#/.NET Console App (`tools/wpd-helper/`)

A small C# console app that bridges Windows Portable Devices API to the filesystem.

**Why C#:** WPD is a COM API. C# has first-class COM interop. No Node.js library exists for WPD. PowerShell could work but is slow for continuous monitoring. C# compiles to a single exe via `dotnet publish --self-contained`.

**Responsibilities:**
- Enumerate connected MTP/PTP devices
- Register for WPD device events (ObjectAdded)
- When a new photo is captured on the camera:
  - Download it from the device to a staging folder
  - Write a sidecar `.json` with: `{ filename, deviceName, captureTime (from WPD metadata), transferredAt }`
- Output status/progress to stdout as JSON lines (for Electron to read)
- Accept commands on stdin: `LIST_DEVICES`, `WATCH <deviceId> <stagingDir>`, `STOP`, `QUIT`

**WPD API Surface:**
```csharp
// Core COM interfaces needed:
PortableDeviceManager     // enumerate devices
PortableDevice            // open device connection
PortableDeviceContent     // browse/download objects
PortableDeviceProperties  // read metadata (capture time, dimensions)
IPortableDeviceEvents     // subscribe to ObjectAdded events
```

**Event Flow:**
```
WPD ObjectAdded event fires
  → Read object properties (type, date, size)
  → If image type (JPEG, RAW):
    → Transfer object data to staging folder
    → Write sidecar JSON
    → Print JSON line to stdout: { "event": "photo", "path": "staging/DSC_1234.jpg", "captureTime": "..." }
```

**Build:**
```bash
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
# Output: wpd-helper.exe (~30MB self-contained, or ~500KB framework-dependent)
```

### 2. WPD Manager in Electron (`src/main/services/wpdBridge.ts`)

Node.js service that spawns and manages the WPD helper subprocess.

```typescript
interface WPDDevice {
  id: string
  name: string        // "Canon EOS R6", "Nikon Z6 III"
  manufacturer: string
}

interface WPDPhotoEvent {
  event: 'photo'
  path: string         // path in staging folder
  captureTime: string  // ISO from WPD metadata
  deviceName: string
}

class WPDBridge {
  private proc: ChildProcess | null = null
  private stagingDir: string

  start(): void
    // Spawn wpd-helper.exe
    // Set up stdout line reader for JSON events
    // On 'photo' event: forward to tether service

  listDevices(): Promise<WPDDevice[]>
    // Send LIST_DEVICES to stdin, read response

  watchDevice(deviceId: string): void
    // Send WATCH command with staging dir

  stop(): void
    // Send STOP, then QUIT
}
```

### 3. Modify `src/main/services/tether.ts`

Add a second tether source mode:

```typescript
type TetherSource = 'folder-watch' | 'wpd-mtp'

// When source is 'wpd-mtp':
//   - wpdBridge.start() spawns the helper
//   - wpdBridge watches for photo events
//   - Photos land in staging dir
//   - Existing chokidar watcher picks them up from staging dir
//   - OR: wpdBridge directly calls the photo processing pipeline
```

The cleanest integration: WPD helper dumps photos to a staging folder, existing chokidar watcher processes them. This means tether.ts needs zero changes to its matching/processing logic — only the source of files changes.

### 4. UI Changes

In Settings or DriveAlert:
- When a camera is detected via MTP (not as a drive letter), show "MTP Camera Detected: Canon EOS R6"
- Offer "Watch Live (MTP)" button
- Status in tether status bar: "TETHERED (MTP)" vs "TETHERED (USB Drive)"

### 5. Device Detection

The WPD helper should also support a `MONITOR` mode that watches for device connect/disconnect:
```
stdout: { "event": "device-connected", "id": "...", "name": "Canon EOS R6" }
stdout: { "event": "device-disconnected", "id": "..." }
```

Electron can use this to auto-prompt the user when a camera is plugged in.

## Camera Compatibility

WPD/MTP works with virtually all modern cameras:
- Canon EOS (all DSLR + R mirrorless)
- Nikon (all DSLR + Z mirrorless)
- Sony Alpha (all)
- Fujifilm X/GFX
- Panasonic Lumix S/G
- Olympus/OM System

The WPD ObjectAdded event fires when the camera writes a new photo to its card while connected. This is PTP's "ObjectAdded" event, which most cameras support in their default USB mode.

**Known limitations:**
- Some cameras require "PC Remote" or "Tethered" mode in their menu for events to fire
- Some cameras (older Sony) only support MTP browsing, not event-driven capture notification
- RAW+JPEG: both files trigger separate events
- Burst shooting: events fire per frame but transfer is sequential (may queue)

## File Structure

```
tools/
  wpd-helper/
    Program.cs          — entry point, stdin/stdout JSON protocol
    WpdMonitor.cs       — device enumeration and event subscription
    WpdTransfer.cs      — file download from device to staging
    wpd-helper.csproj   — .NET 8.0 project file
```

## Build & Bundle

- The wpd-helper.exe gets built separately (dotnet publish)
- Bundled in the Electron app's `resources/` directory
- Electron spawns it from `path.join(process.resourcesPath, 'wpd-helper.exe')`
- Framework-dependent build (~500KB) if .NET 8 runtime is guaranteed on target
- Self-contained build (~30MB) if we want zero dependencies

**Recommendation:** Framework-dependent for now. .NET 8 runtime is small and the target machine (DART) already has .NET. For distribution to other users later, switch to self-contained.

## Implementation Order

1. **WPD Helper MVP** — C# app that lists devices, watches one, downloads new photos to staging folder
2. **WPD Bridge** — Node.js subprocess manager in Electron
3. **Integration** — Connect WPD bridge output to existing tether pipeline
4. **Device Detection UI** — Auto-detect MTP cameras, prompt user
5. **Polish** — Error handling, reconnection, multi-camera support

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| WPD ObjectAdded not supported by camera | Fall back to polling: periodically enumerate new objects |
| Transfer speed bottleneck during burst | Queue transfers, process in order, show queue depth in UI |
| Camera disconnects mid-transfer | WPD helper catches COM exceptions, reports to Electron |
| .NET not installed on target | Self-contained publish option |
| Helper process crashes | Electron detects exit, auto-restarts with backoff |

## Testing

- Canon EOS camera on DART via USB
- Verify ObjectAdded events fire on capture
- Verify JPEG transfers to staging folder
- Verify tether.ts picks up and processes the photo
- Verify clock offset from WPD metadata vs EXIF vs system time
- Burst shooting: 10 rapid captures, verify all transfer
- Long session: 4+ hours continuous, verify no memory leak in helper

## Estimated Effort

| Component | Effort |
|-----------|--------|
| WPD Helper C# app | 4-6 hours |
| WPD Bridge (Node.js) | 2-3 hours |
| Tether integration | 1-2 hours |
| UI changes | 1-2 hours |
| Testing & polish | 2-3 hours |
| **Total** | **10-16 hours** |
