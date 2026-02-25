# Stream Deck Integration + Unified Overlay — Design Document

**Date:** 2026-02-23
**Status:** Approved
**Version:** CompSync Media v2.3.0

---

## Summary

Two related features for live competition production:

1. **Unified Overlay** — Single full-screen OBS browser source with 4 independently toggleable elements (entry counter, client logo, time of day, lower third), replacing the current lower-third-only system.
2. **Stream Deck Plugin** — Elgato Stream Deck plugin for hardware button control of the CompSync workflow, with live state displayed on buttons.

---

## Architecture

```
Stream Deck Hardware
    ↕ USB
Stream Deck Desktop App
    ↕ SDK WebSocket (managed by @elgato/streamdeck)
CompSync SD Plugin (Node.js process)
    ↕ WebSocket (port 9877)
CompSync Electron App ← WebSocket Hub (wsHub.ts)
    ↕ WebSocket (port 9877, same hub)
OBS Browser Source (http://localhost:9876/overlay)
```

### Port Allocation

| Port | Protocol | Purpose |
|------|----------|---------|
| 9876 | HTTP | Serves overlay HTML page (OBS browser source URL) |
| 9877 | WebSocket | Hub for both SD plugin and overlay page |

### WebSocket Hub

Single WebSocket server on port 9877 serves two client types:

- **overlay** — The OBS browser source page. Receives state broadcasts, renders elements.
- **streamdeck** — The SD plugin. Receives state broadcasts (for button display), sends commands.

Clients identify themselves on connection:
```json
{ "type": "identify", "client": "overlay" }
{ "type": "identify", "client": "streamdeck" }
```

---

## Unified Overlay

### Elements

| Element | ID | Position | Content | Default State |
|---------|----|----------|---------|---------------|
| Entry Counter | `counter` | Top-right | `#101 / 48` with advance animation | ON |
| Client Logo | `logo` | Top-left | Tenant logo image from settings | ON |
| Time of Day | `clock` | Bottom-left | `2:47 PM` (live, updates every second) | OFF |
| Lower Third | `lowerThird` | Bottom-left (above clock) | Entry #, routine name, dancers, studio, category | OFF (fired on cue) |

### Overlay HTML

- Full 1920×1080 transparent canvas
- OBS Browser Source URL: `http://localhost:9876/overlay`
- Connects to `ws://localhost:9877` on load, identifies as `"overlay"`
- Each element is a positioned `<div>` with CSS transitions (fade/slide)
- Clock element updates via `setInterval` locally (not from server)
- Lower third auto-hide timer handled client-side after server sends `visible: true` + `autoHideSeconds`
- Reconnects automatically if WebSocket drops

### Overlay State Object

```typescript
interface OverlayState {
  counter: {
    visible: boolean
    current: number      // e.g., 5
    total: number        // e.g., 48
    entryNumber: string  // e.g., "101"
  }
  logo: {
    visible: boolean
    url: string          // Logo image URL or base64
  }
  clock: {
    visible: boolean
    // Time rendered client-side
  }
  lowerThird: {
    visible: boolean
    entryNumber: string
    routineTitle: string
    dancers: string
    studioName: string
    category: string
    autoHideSeconds: number  // 0 = manual hide
  }
}
```

### Replaces

Current `lowerThird.ts` (HTTP polling server with `/overlay`, `/current`, `/hide-now` endpoints) is replaced by:

- `overlay.ts` — HTTP server on 9876 serving overlay HTML + static assets, overlay state management
- `wsHub.ts` — WebSocket server on 9877 for real-time communication

---

## Stream Deck Plugin

### Buttons (12 actions)

**Row 1 — Workflow:**

| # | Action UUID | Name | Function | Live Display |
|---|------------|------|----------|-------------|
| 1 | `com.compsync.streamdeck.next-full` | NEXT | Full pipeline: advance + record + 5s + fire overlay + counter | Next routine # + name |
| 2 | `com.compsync.streamdeck.next-routine` | Next Routine | Plain advance only | Current routine # |
| 3 | `com.compsync.streamdeck.prev` | Prev | Previous routine | Previous routine # |
| 4 | `com.compsync.streamdeck.skip` | Skip | Skip/unskip current | Skipped count |

**Row 2 — OBS:**

| # | Action UUID | Name | Function | Live Display |
|---|------------|------|----------|-------------|
| 5 | `com.compsync.streamdeck.record` | Record | Toggle OBS recording | `●2:07` (red) / `REC` (gray) |
| 6 | `com.compsync.streamdeck.stream` | Stream | Toggle OBS streaming | `LIVE` (red) / `OFF` (gray) |
| 7 | `com.compsync.streamdeck.save-replay` | Save Replay | Save OBS replay buffer | Flash ✓ on press |
| 8 | *(open slot — future use)* | — | — | — |

**Row 3 — Overlay Toggles:**

| # | Action UUID | Name | Function | Live Display |
|---|------------|------|----------|-------------|
| 9 | `com.compsync.streamdeck.overlay-lower-third` | Lower Third | Fire / hide lower third | ON (green) / OFF (gray) |
| 10 | `com.compsync.streamdeck.overlay-counter` | Counter | Toggle entry counter | ON / OFF |
| 11 | `com.compsync.streamdeck.overlay-clock` | Clock | Toggle time of day | ON / OFF |
| 12 | `com.compsync.streamdeck.overlay-logo` | Logo | Toggle client logo | ON / OFF |

### Plugin Architecture

```
streamdeck-plugin/
├── com.compsync.streamdeck.sdPlugin/
│   ├── manifest.json          # Plugin metadata + 12 actions
│   ├── bin/                   # Compiled JS (rollup output)
│   └── imgs/
│       ├── plugin-icon.png    # 144×144 plugin icon
│       └── actions/           # Per-action icons (20×20 + 40×40)
├── src/
│   ├── plugin.ts              # Entry: register all actions, connect
│   ├── connection.ts          # WebSocket client to Electron (port 9877)
│   ├── state.ts               # Shared state singleton, event emitter
│   └── actions/
│       ├── next-full.ts
│       ├── next-routine.ts
│       ├── prev.ts
│       ├── skip.ts
│       ├── record.ts
│       ├── stream.ts
│       ├── save-replay.ts
│       └── overlay-toggle.ts  # Single class for all 4 overlay toggles
├── package.json
├── rollup.config.mjs
└── tsconfig.json
```

### Dynamic Button Rendering

Buttons update via `setTitle()` and `setImage()` (SVG strings) when state arrives:

- **NEXT**: `#102 ▶` (green) or `END` (gray) if last routine
- **Next Routine**: `#101` (current entry number)
- **Record**: `●2:07` (red background) or `REC` (dark background)
- **Stream**: `LIVE` (red) or `OFF` (gray)
- **Overlay toggles**: Green dot when ON, gray when OFF

SVG rendering in plugin via template strings — no external image dependencies for dynamic content.

### Application Monitoring

Plugin monitors `CompSyncElectronApp.exe` via manifest:
```json
"ApplicationsToMonitor": {
  "windows": ["CompSync Media.exe"]
}
```

When app not running: all buttons show disabled state (dimmed icons).

---

## WebSocket Protocol

### State Broadcast (Electron → all clients)

Sent on every state change (routine navigation, recording toggle, overlay toggle):

```json
{
  "type": "state",
  "routine": {
    "entryNumber": "101",
    "routineTitle": "Jazz Solo",
    "dancers": "Alice Smith",
    "studioName": "Studio X",
    "category": "Junior Jazz Solo"
  },
  "nextRoutine": {
    "entryNumber": "102",
    "routineTitle": "Lyrical Duet"
  },
  "index": 5,
  "total": 48,
  "recording": { "active": true, "elapsed": 127 },
  "streaming": false,
  "skippedCount": 2,
  "overlay": {
    "counter": { "visible": true, "current": 5, "total": 48, "entryNumber": "101" },
    "clock": { "visible": true },
    "logo": { "visible": true, "url": "https://..." },
    "lowerThird": {
      "visible": false,
      "entryNumber": "101",
      "routineTitle": "Jazz Solo",
      "dancers": "Alice Smith",
      "studioName": "Studio X",
      "category": "Junior Jazz Solo",
      "autoHideSeconds": 8
    }
  }
}
```

### Commands (SD plugin → Electron)

```json
{ "type": "command", "action": "nextFull" }
{ "type": "command", "action": "nextRoutine" }
{ "type": "command", "action": "prev" }
{ "type": "command", "action": "skip" }
{ "type": "command", "action": "toggleRecord" }
{ "type": "command", "action": "toggleStream" }
{ "type": "command", "action": "saveReplay" }
{ "type": "command", "action": "toggleOverlay", "element": "lowerThird" }
{ "type": "command", "action": "toggleOverlay", "element": "counter" }
{ "type": "command", "action": "toggleOverlay", "element": "clock" }
{ "type": "command", "action": "toggleOverlay", "element": "logo" }
```

### Connection Lifecycle

1. Client connects to `ws://localhost:9877`
2. Client sends `{ "type": "identify", "client": "overlay"|"streamdeck" }`
3. Server sends full state immediately
4. Server broadcasts state on every change
5. Client reconnects with exponential backoff on disconnect (1s, 2s, 4s, max 30s)

---

## Electron App Changes

### New Files

| File | Purpose |
|------|---------|
| `src/main/services/wsHub.ts` | WebSocket server (port 9877), client registry, broadcast, command dispatch |
| `src/main/services/overlay.ts` | HTTP server (port 9876), overlay state management, element toggle functions |
| `src/main/services/overlayHtml.ts` | Overlay HTML template (inline, no external files) |

### Modified Files

| File | Change |
|------|--------|
| `src/main/ipc.ts` | Import + initialize wsHub and overlay; add overlay toggle IPC channels |
| `src/main/services/recording.ts` | Add `nextFull()` — automated pipeline (advance + record + delay + fire overlay + update counter) |
| `src/main/services/state.ts` | Add onChange callback hook for wsHub to subscribe to |
| `src/shared/types.ts` | Add overlay IPC channels, OverlayState type, WebSocket message types |
| `src/renderer/components/LowerThirdControls.tsx` → `OverlayControls.tsx` | 4 toggle buttons (counter, clock, logo, lower third) + fire/hide |

### Removed Files

| File | Reason |
|------|--------|
| `src/main/services/lowerThird.ts` | Replaced by overlay.ts + wsHub.ts |

---

## NEXT Button Pipeline (Full Sequence)

The "NEXT" button (field request #10) executes this automated sequence:

```
1. If recording → stop recording (wait for OBS confirmation)
2. Advance to next routine (state.advanceToNext())
3. Start recording new routine (obs.startRecord())
4. Update overlay counter (increment, animate)
5. Wait 5 seconds (configurable in settings)
6. Fire lower third overlay (with auto-hide timer)
7. Broadcast full state to all WebSocket clients
```

This is exposed as `recording.nextFull()` and callable from:
- Stream Deck "NEXT" button
- Future keyboard hotkey (configurable)
- UI button (if added)

---

## Installation & Usage

### First-Time Setup

1. Install Stream Deck desktop app (if not already)
2. Install `@elgato/cli` globally: `npm install -g @elgato/cli`
3. Build plugin: `cd streamdeck-plugin && npm install && npm run build`
4. Pack: `streamdeck pack com.compsync.streamdeck.sdPlugin`
5. Double-click `com.compsync.streamdeck.streamDeckPlugin` → installs into SD app
6. Drag 12 actions onto Stream Deck buttons in desired layout
7. In OBS: Add Browser Source → URL: `http://localhost:9876/overlay` → 1920×1080

### During Production

1. Launch CompSync Electron App
2. Load competition schedule
3. Stream Deck auto-connects (plugin detects app via ApplicationsToMonitor)
4. OBS overlay auto-connects (browser source WebSocket)
5. Press NEXT on Stream Deck to run full pipeline

---

## Not Included (YAGNI)

- Stream Deck+ encoder/dial support
- Property Inspector UI (no per-button settings)
- Elgato Marketplace distribution
- Profile auto-import/sync
- Multi-page Stream Deck profiles
- Touch bar layouts
- Custom overlay themes/skins (single hardcoded style)
