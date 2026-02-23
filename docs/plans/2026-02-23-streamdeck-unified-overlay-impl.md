# Stream Deck + Unified Overlay — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a WebSocket hub to CompSync Media that powers both a unified OBS overlay (4 toggleable elements) and an Elgato Stream Deck hardware plugin with 12 actions.

**Architecture:** The Electron app gains a WebSocket server (port 9877) that broadcasts state to two client types: an OBS browser source overlay (served via HTTP on port 9876) and a Stream Deck plugin (separate Node.js project). Commands flow back from the SD plugin through the same WebSocket. The existing polling-based `lowerThird.ts` is replaced by `overlay.ts` (HTTP) + `wsHub.ts` (WebSocket).

**Tech Stack:** Electron 33, TypeScript, `ws` (WebSocket), Express (HTTP overlay server), `@elgato/streamdeck` v2 SDK, Rollup (plugin bundler)

---

## Phase 1: Electron App — WebSocket Hub + Unified Overlay (Tasks 1-7)

### Task 1: Add `ws` dependency

**Files:**
- Modify: `package.json`

**Step 1: Install ws and its types**

Run:
```bash
cd D:/ClaudeCode/CompSyncElectronApp
npm install ws
npm install -D @types/ws
```

**Step 2: Verify installation**

Run: `node -e "require('ws'); console.log('ws OK')"`
Expected: `ws OK`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add ws for WebSocket hub"
```

---

### Task 2: Add overlay types to shared/types.ts

**Files:**
- Modify: `src/shared/types.ts:150-261`

**Step 1: Add new types after `LowerThirdData` (line 261)**

Add these types at the end of the file, before `DEFAULT_SETTINGS`:

```typescript
// --- Overlay ---

export interface OverlayElementState {
  visible: boolean
}

export interface OverlayCounterState extends OverlayElementState {
  current: number       // 1-based position in filtered list
  total: number         // total routine count
  entryNumber: string   // display entry number
}

export interface OverlayLogoState extends OverlayElementState {
  url: string           // logo image URL or base64 data URI
}

export interface OverlayLowerThirdState extends OverlayElementState {
  entryNumber: string
  routineTitle: string
  dancers: string
  studioName: string
  category: string
  autoHideSeconds: number
}

export interface OverlayState {
  counter: OverlayCounterState
  clock: OverlayElementState   // time rendered client-side
  logo: OverlayLogoState
  lowerThird: OverlayLowerThirdState
}

// --- WebSocket Hub ---

export interface WSStateMessage {
  type: 'state'
  routine: {
    entryNumber: string
    routineTitle: string
    dancers: string
    studioName: string
    category: string
  } | null
  nextRoutine: {
    entryNumber: string
    routineTitle: string
  } | null
  index: number
  total: number
  recording: { active: boolean; elapsed: number }
  streaming: boolean
  skippedCount: number
  overlay: OverlayState
}

export interface WSCommandMessage {
  type: 'command'
  action: 'nextFull' | 'nextRoutine' | 'prev' | 'skip'
    | 'toggleRecord' | 'toggleStream' | 'saveReplay'
    | 'toggleOverlay'
  element?: 'counter' | 'clock' | 'logo' | 'lowerThird'
}

export interface WSIdentifyMessage {
  type: 'identify'
  client: 'overlay' | 'streamdeck'
}

export type WSMessage = WSStateMessage | WSCommandMessage | WSIdentifyMessage
```

**Step 2: Add overlay IPC channels to `IPC_CHANNELS` (after LT channels, line ~210)**

Replace the existing Lower Third channels block:

```typescript
  // Overlay (replaces Lower Third)
  OVERLAY_TOGGLE: 'overlay:toggle',          // (element: string) => OverlayState
  OVERLAY_FIRE_LT: 'overlay:fire-lt',        // () => void
  OVERLAY_HIDE_LT: 'overlay:hide-lt',        // () => void
  OVERLAY_GET_STATE: 'overlay:get-state',     // () => OverlayState
  OVERLAY_AUTO_FIRE_TOGGLE: 'overlay:auto-fire-toggle', // () => boolean

  // Keep old LT channels as aliases for backward compat during migration
  LT_FIRE: 'lt:fire',
  LT_HIDE: 'lt:hide',
  LT_AUTO_FIRE_TOGGLE: 'lt:auto-fire-toggle',
  LT_AUTO_FIRE_STATE: 'lt:auto-fire-state',
```

**Step 3: Add overlay settings to AppSettings (modify `lowerThird` section, line ~136)**

Replace the `lowerThird` settings key:

```typescript
  overlay: {
    autoHideSeconds: number // 0 = never
    overlayUrl: string
    logoUrl: string         // client logo URL
    defaultCounter: boolean // show counter on startup
    defaultClock: boolean   // show clock on startup
    defaultLogo: boolean    // show logo on startup
  }
```

**Step 4: Update DEFAULT_SETTINGS to match (line ~306)**

Replace the `lowerThird` key in defaults:

```typescript
  overlay: {
    autoHideSeconds: 8,
    overlayUrl: 'http://localhost:9876/overlay',
    logoUrl: '',
    defaultCounter: true,
    defaultClock: false,
    defaultLogo: true,
  },
```

**Step 5: Add RECORDING_NEXT_FULL to IPC channels (after RECORDING_UNSKIP, line ~170)**

```typescript
  RECORDING_NEXT_FULL: 'recording:next-full',
```

**Step 6: Commit**

```bash
git add src/shared/types.ts
git commit -m "types: add overlay, WebSocket hub, and Stream Deck types"
```

---

### Task 3: Create overlay.ts (replaces lowerThird.ts)

**Files:**
- Create: `src/main/services/overlay.ts`
- Delete (later): `src/main/services/lowerThird.ts` (keep until wired up)

**Step 1: Create the overlay service**

Create `src/main/services/overlay.ts`:

```typescript
import express from 'express'
import http from 'http'
import { OverlayState } from '../../shared/types'
import { getSettings } from './settings'
import { logger } from '../logger'

const PORT = 9876
let server: http.Server | null = null
let autoHideTimer: NodeJS.Timeout | null = null

// Overlay state — each element independently toggled
let overlayState: OverlayState = {
  counter: { visible: true, current: 0, total: 0, entryNumber: '' },
  clock: { visible: false },
  logo: { visible: true, url: '' },
  lowerThird: {
    visible: false,
    entryNumber: '',
    routineTitle: '',
    dancers: '',
    studioName: '',
    category: '',
    autoHideSeconds: 8,
  },
}

// Callback for state changes (wsHub subscribes to this)
let onStateChange: (() => void) | null = null

export function setOnStateChange(cb: () => void): void {
  onStateChange = cb
}

function notifyChange(): void {
  if (onStateChange) onStateChange()
}

export function getOverlayState(): OverlayState {
  return overlayState
}

export function toggleElement(element: 'counter' | 'clock' | 'logo' | 'lowerThird'): OverlayState {
  const el = overlayState[element]
  el.visible = !el.visible
  logger.app.info(`Overlay ${element}: ${el.visible ? 'ON' : 'OFF'}`)
  notifyChange()
  return overlayState
}

export function updateRoutineData(data: {
  entryNumber: string
  routineTitle: string
  dancers: string
  studioName: string
  category: string
  current: number
  total: number
}): void {
  overlayState.counter.entryNumber = data.entryNumber
  overlayState.counter.current = data.current
  overlayState.counter.total = data.total

  overlayState.lowerThird.entryNumber = data.entryNumber
  overlayState.lowerThird.routineTitle = data.routineTitle
  overlayState.lowerThird.dancers = data.dancers
  overlayState.lowerThird.studioName = data.studioName
  overlayState.lowerThird.category = data.category

  notifyChange()
}

export function fireLowerThird(): void {
  overlayState.lowerThird.visible = true
  const settings = getSettings()
  const seconds = settings.overlay?.autoHideSeconds ?? 8
  overlayState.lowerThird.autoHideSeconds = seconds
  logger.app.info('Overlay lower third fired')

  if (autoHideTimer) clearTimeout(autoHideTimer)
  if (seconds > 0) {
    autoHideTimer = setTimeout(() => {
      hideLowerThird()
      autoHideTimer = null
    }, seconds * 1000)
  }

  notifyChange()
}

export function hideLowerThird(): void {
  overlayState.lowerThird.visible = false
  if (autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }
  logger.app.info('Overlay lower third hidden')
  notifyChange()
}

export function setLogoUrl(url: string): void {
  overlayState.logo.url = url
}

export function initDefaults(): void {
  const settings = getSettings()
  if (settings.overlay) {
    overlayState.counter.visible = settings.overlay.defaultCounter ?? true
    overlayState.clock.visible = settings.overlay.defaultClock ?? false
    overlayState.logo.visible = settings.overlay.defaultLogo ?? true
    overlayState.logo.url = settings.overlay.logoUrl ?? ''
  }
}

// --- HTTP server (serves overlay HTML page) ---

export function startServer(): void {
  if (server) return

  initDefaults()

  const app = express()

  // Serve overlay HTML
  app.get('/overlay', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(buildOverlayHTML())
  })

  // Legacy compat endpoints (can remove later)
  app.get('/current', (_req, res) => {
    res.json({
      entryNumber: overlayState.lowerThird.entryNumber,
      routineName: overlayState.lowerThird.routineTitle,
      dancers: overlayState.lowerThird.dancers.split(',').map(d => d.trim()).filter(Boolean),
      studioName: overlayState.lowerThird.studioName,
      category: overlayState.lowerThird.category,
      logoUrl: overlayState.logo.url,
      visible: overlayState.lowerThird.visible,
    })
  })

  server = app.listen(PORT, () => {
    logger.app.info(`Overlay server running on http://localhost:${PORT}`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.app.warn(`Overlay port ${PORT} already in use`)
    } else {
      logger.app.error(`Overlay server error: ${err.message}`)
    }
    server = null
  })
}

export function stopServer(): void {
  if (server) {
    server.close()
    server = null
    logger.app.info('Overlay server stopped')
  }
}

function buildOverlayHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent; overflow: hidden;
    width: 1920px; height: 1080px;
    font-family: -apple-system, 'Segoe UI', sans-serif;
  }

  /* --- Entry Counter (top-right) --- */
  .counter {
    position: absolute; top: 30px; right: 40px;
    opacity: 0; transform: translateY(-10px);
    transition: opacity 0.4s ease, transform 0.4s ease;
  }
  .counter.visible { opacity: 1; transform: translateY(0); }
  .counter-box {
    background: rgba(30, 30, 46, 0.88);
    border: 1px solid rgba(102, 126, 234, 0.5);
    border-radius: 10px; padding: 12px 20px;
    backdrop-filter: blur(10px);
    text-align: center; min-width: 120px;
  }
  .counter-number {
    font-size: 48px; font-weight: 800; color: #e0e0f0;
    line-height: 1;
  }
  .counter-number::before { content: '#'; opacity: 0.4; font-size: 28px; }
  .counter-label {
    font-size: 13px; color: #9090b0; margin-top: 4px;
    letter-spacing: 0.5px;
  }
  .counter.advance .counter-number {
    animation: counterPop 0.5s ease;
  }
  @keyframes counterPop {
    0% { transform: scale(1); }
    40% { transform: scale(1.25); color: #667eea; }
    100% { transform: scale(1); }
  }

  /* --- Client Logo (top-left) --- */
  .logo {
    position: absolute; top: 30px; left: 40px;
    opacity: 0; transition: opacity 0.4s ease;
  }
  .logo.visible { opacity: 1; }
  .logo img {
    max-height: 60px; max-width: 200px; border-radius: 6px;
  }

  /* --- Time of Day (bottom-left, below lower third) --- */
  .clock {
    position: absolute; bottom: 30px; left: 40px;
    opacity: 0; transition: opacity 0.4s ease;
  }
  .clock.visible { opacity: 1; }
  .clock-box {
    background: rgba(30, 30, 46, 0.85);
    border: 1px solid rgba(102, 126, 234, 0.3);
    border-radius: 8px; padding: 8px 16px;
    backdrop-filter: blur(8px);
  }
  .clock-time {
    font-size: 22px; font-weight: 600; color: #c0c0e0;
    font-variant-numeric: tabular-nums;
  }

  /* --- Lower Third (bottom-left, above clock) --- */
  .lower-third {
    position: absolute; bottom: 90px; left: 40px;
    opacity: 0; transform: translateY(20px);
    transition: opacity 0.5s ease, transform 0.5s ease;
  }
  .lower-third.visible { opacity: 1; transform: translateY(0); }
  .lt-card {
    background: rgba(30, 30, 46, 0.92);
    border: 1px solid rgba(102, 126, 234, 0.4);
    border-radius: 8px; padding: 16px 24px;
    backdrop-filter: blur(10px); min-width: 400px;
  }
  .lt-top { display: flex; align-items: center; gap: 12px; }
  .lt-number {
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: white; font-weight: 700; font-size: 24px;
    padding: 4px 12px; border-radius: 6px; flex-shrink: 0;
  }
  .lt-number::before { content: '#'; opacity: 0.6; font-size: 16px; }
  .lt-title { font-size: 22px; font-weight: 700; color: #e0e0f0; }
  .lt-dancers { font-size: 14px; color: #a5b4fc; margin-top: 4px; }
  .lt-meta { font-size: 12px; color: #9090b0; margin-top: 6px; }
</style>
</head>
<body>

<!-- Entry Counter -->
<div class="counter" id="counter">
  <div class="counter-box">
    <div class="counter-number" id="counterNumber"></div>
    <div class="counter-label" id="counterLabel"></div>
  </div>
</div>

<!-- Client Logo -->
<div class="logo" id="logo">
  <img id="logoImg" src="" alt="" />
</div>

<!-- Clock -->
<div class="clock" id="clock">
  <div class="clock-box">
    <div class="clock-time" id="clockTime"></div>
  </div>
</div>

<!-- Lower Third -->
<div class="lower-third" id="lt">
  <div class="lt-card">
    <div class="lt-top">
      <div class="lt-number" id="ltNumber"></div>
      <div>
        <div class="lt-title" id="ltTitle"></div>
        <div class="lt-dancers" id="ltDancers"></div>
      </div>
    </div>
    <div class="lt-meta" id="ltMeta"></div>
  </div>
</div>

<script>
  const WS_URL = 'ws://localhost:9877';
  let ws = null;
  let reconnectDelay = 1000;
  let lastCounterEntry = '';

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'identify', client: 'overlay' }));
      reconnectDelay = 1000;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') applyState(msg);
      } catch {}
    };

    ws.onclose = () => {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    ws.onerror = () => ws.close();
  }

  function applyState(state) {
    const o = state.overlay;

    // Counter
    const counterEl = document.getElementById('counter');
    const counterNum = document.getElementById('counterNumber');
    const counterLabel = document.getElementById('counterLabel');
    if (o.counter.visible) {
      counterEl.classList.add('visible');
      // Animate on entry change
      if (o.counter.entryNumber !== lastCounterEntry && lastCounterEntry !== '') {
        counterEl.classList.remove('advance');
        void counterEl.offsetWidth; // force reflow
        counterEl.classList.add('advance');
      }
      lastCounterEntry = o.counter.entryNumber;
      counterNum.textContent = o.counter.entryNumber;
      counterLabel.textContent = o.counter.current + ' / ' + o.counter.total;
    } else {
      counterEl.classList.remove('visible');
    }

    // Logo
    const logoEl = document.getElementById('logo');
    const logoImg = document.getElementById('logoImg');
    if (o.logo.visible && o.logo.url) {
      logoEl.classList.add('visible');
      logoImg.src = o.logo.url;
    } else {
      logoEl.classList.remove('visible');
    }

    // Clock (visibility only — time updated locally)
    const clockEl = document.getElementById('clock');
    if (o.clock.visible) {
      clockEl.classList.add('visible');
    } else {
      clockEl.classList.remove('visible');
    }

    // Lower Third
    const ltEl = document.getElementById('lt');
    if (o.lowerThird.visible) {
      ltEl.classList.add('visible');
      document.getElementById('ltNumber').textContent = o.lowerThird.entryNumber;
      document.getElementById('ltTitle').textContent = o.lowerThird.routineTitle;
      document.getElementById('ltDancers').textContent = o.lowerThird.dancers;
      document.getElementById('ltMeta').textContent =
        o.lowerThird.studioName + ' \\u2014 ' + o.lowerThird.category;
    } else {
      ltEl.classList.remove('visible');
    }
  }

  // Live clock (updates locally every second)
  function updateClock() {
    const now = new Date();
    const h = now.getHours();
    const m = String(now.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    document.getElementById('clockTime').textContent = h12 + ':' + m + ' ' + ampm;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // Connect
  connect();
</script>
</body>
</html>`;
}
```

**Step 2: Commit**

```bash
git add src/main/services/overlay.ts
git commit -m "feat: add unified overlay service with 4 toggleable elements"
```

---

### Task 4: Create wsHub.ts (WebSocket server)

**Files:**
- Create: `src/main/services/wsHub.ts`

**Step 1: Create the WebSocket hub**

Create `src/main/services/wsHub.ts`:

```typescript
import { WebSocketServer, WebSocket } from 'ws'
import * as obs from './obs'
import * as stateService from './state'
import * as overlay from './overlay'
import * as recording from './recording'
import { getSettings } from './settings'
import { WSCommandMessage, WSStateMessage } from '../../shared/types'
import { logger } from '../logger'

const PORT = 9877
let wss: WebSocketServer | null = null

interface TaggedSocket extends WebSocket {
  clientType?: 'overlay' | 'streamdeck'
  isAlive?: boolean
}

const clients = new Set<TaggedSocket>()
let heartbeatInterval: NodeJS.Timeout | null = null

export function start(): void {
  if (wss) return

  wss = new WebSocketServer({ port: PORT })

  wss.on('listening', () => {
    logger.app.info(`WebSocket hub listening on ws://localhost:${PORT}`)
  })

  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.app.warn(`WebSocket hub port ${PORT} already in use`)
    } else {
      logger.app.error(`WebSocket hub error: ${err.message}`)
    }
  })

  wss.on('connection', (ws: TaggedSocket) => {
    ws.isAlive = true
    clients.add(ws)
    logger.app.info(`WebSocket client connected (total: ${clients.size})`)

    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        handleMessage(ws, msg)
      } catch (err) {
        logger.app.warn('Invalid WebSocket message:', raw.toString().slice(0, 200))
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
      logger.app.info(`WebSocket client disconnected (total: ${clients.size})`)
    })

    ws.on('error', (err) => {
      logger.app.warn('WebSocket client error:', err.message)
      clients.delete(ws)
    })
  })

  // Heartbeat to detect dead connections
  heartbeatInterval = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate()
        clients.delete(ws)
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, 30000)

  // Subscribe to overlay state changes
  overlay.setOnStateChange(() => broadcastState())
}

export function stop(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
  for (const ws of clients) {
    ws.close()
  }
  clients.clear()
  if (wss) {
    wss.close()
    wss = null
    logger.app.info('WebSocket hub stopped')
  }
}

function handleMessage(ws: TaggedSocket, msg: Record<string, unknown>): void {
  if (msg.type === 'identify') {
    ws.clientType = msg.client as 'overlay' | 'streamdeck'
    logger.app.info(`WebSocket client identified as: ${ws.clientType}`)
    // Send full state immediately on identify
    const state = buildStateMessage()
    ws.send(JSON.stringify(state))
    return
  }

  if (msg.type === 'command') {
    handleCommand(msg as unknown as WSCommandMessage)
  }
}

async function handleCommand(cmd: WSCommandMessage): Promise<void> {
  logger.app.info(`WebSocket command: ${cmd.action}${cmd.element ? ' ' + cmd.element : ''}`)

  const obsState = obs.getState()

  switch (cmd.action) {
    case 'nextFull':
      await recording.nextFull()
      break
    case 'nextRoutine':
      await recording.next()
      break
    case 'prev':
      await recording.prev()
      break
    case 'skip': {
      const current = stateService.getCurrentRoutine()
      if (current) {
        if (current.status === 'skipped') {
          stateService.unskipRoutine(current.id)
        } else {
          stateService.skipRoutine(current.id)
        }
        recording.broadcastFullState()
      }
      break
    }
    case 'toggleRecord':
      if (obsState.connectionStatus === 'connected') {
        if (obsState.isRecording) await obs.stopRecord()
        else await obs.startRecord()
      }
      break
    case 'toggleStream':
      if (obsState.connectionStatus === 'connected') {
        if (obsState.isStreaming) await obs.stopStream()
        else await obs.startStream()
      }
      break
    case 'saveReplay':
      if (obsState.connectionStatus === 'connected') {
        await obs.saveReplay()
      }
      break
    case 'toggleOverlay':
      if (cmd.element) {
        overlay.toggleElement(cmd.element)
      }
      break
  }

  // Broadcast updated state after any command
  broadcastState()
}

function buildStateMessage(): WSStateMessage {
  const comp = stateService.getCompetition()
  const current = stateService.getCurrentRoutine()
  const next = stateService.getNextRoutine()
  const obsState = obs.getState()
  const overlayState = overlay.getOverlayState()

  const skippedCount = comp
    ? comp.routines.filter(r => r.status === 'skipped').length
    : 0

  return {
    type: 'state',
    routine: current
      ? {
          entryNumber: current.entryNumber,
          routineTitle: current.routineTitle,
          dancers: current.dancers,
          studioName: current.studioName,
          category: `${current.ageGroup} ${current.category}`,
        }
      : null,
    nextRoutine: next
      ? {
          entryNumber: next.entryNumber,
          routineTitle: next.routineTitle,
        }
      : null,
    index: stateService.getCurrentRoutineIndex(),
    total: comp ? comp.routines.filter(r => r.status !== 'skipped').length : 0,
    recording: {
      active: obsState.isRecording,
      elapsed: obsState.recordTimeSec,
    },
    streaming: obsState.isStreaming,
    skippedCount,
    overlay: overlayState,
  }
}

export function broadcastState(): void {
  if (clients.size === 0) return
  const msg = JSON.stringify(buildStateMessage())
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  }
}
```

**Step 2: Commit**

```bash
git add src/main/services/wsHub.ts
git commit -m "feat: add WebSocket hub for overlay + Stream Deck communication"
```

---

### Task 5: Add nextFull() to recording.ts

**Files:**
- Modify: `src/main/services/recording.ts:176-223`

**Step 1: Add the nextFull() function after the existing `next()` function (line ~223)**

Add this function. It imports `overlay` instead of `lowerThird`:

```typescript
export async function nextFull(): Promise<void> {
  const settings = getSettings()
  const obsState = obs.getState()

  // 1. Stop recording if active
  if (obsState.isRecording && obsState.connectionStatus === 'connected') {
    try {
      await obs.stopRecord()
    } catch (err) {
      logger.app.error('nextFull: stop recording failed:', err instanceof Error ? err.message : err)
    }
  }

  // 2. Advance to next routine
  const nextRoutine = state.advanceToNext()
  if (!nextRoutine) {
    logger.app.info('nextFull: no more routines')
    return
  }

  // 3. Update overlay data
  const comp = state.getCompetition()
  const visibleCount = comp ? comp.routines.filter(r => r.status !== 'skipped').length : 0
  overlay.updateRoutineData({
    entryNumber: nextRoutine.entryNumber,
    routineTitle: nextRoutine.routineTitle,
    dancers: nextRoutine.dancers,
    studioName: nextRoutine.studioName,
    category: `${nextRoutine.ageGroup} ${nextRoutine.category}`,
    current: state.getCurrentRoutineIndex() + 1,
    total: visibleCount,
  })

  // 4. Start recording
  if (obsState.connectionStatus === 'connected') {
    try {
      await obs.startRecord()
    } catch (err) {
      logger.app.error('nextFull: start recording failed:', err instanceof Error ? err.message : err)
    }
  }

  // 5. Schedule lower third fire after delay (5 seconds)
  setTimeout(() => {
    overlay.fireLowerThird()
  }, 5000)

  broadcastFullState()
  logger.app.info(`nextFull: advanced to #${nextRoutine.entryNumber} "${nextRoutine.routineTitle}"`)
}
```

**Step 2: Add overlay import at top of file (line ~6)**

Add after the `lowerThird` import:

```typescript
import * as overlay from './overlay'
```

**Step 3: Commit**

```bash
git add src/main/services/recording.ts
git commit -m "feat: add nextFull() automated pipeline (advance+record+overlay)"
```

---

### Task 6: Wire up overlay + wsHub in ipc.ts and index.ts

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Update ipc.ts imports (line 1-15)**

Replace `lowerThird` import with `overlay`:

```typescript
import * as overlay from './services/overlay'
```

Add import for wsHub:

```typescript
import * as wsHub from './services/wsHub'
```

**Step 2: Replace LT handler block (ipc.ts lines 275-295) with overlay handlers**

```typescript
  // --- Overlay (replaces Lower Third) ---
  safeHandle(IPC_CHANNELS.OVERLAY_TOGGLE, (element: unknown) => {
    logIPC(IPC_CHANNELS.OVERLAY_TOGGLE, { element })
    return overlay.toggleElement(element as 'counter' | 'clock' | 'logo' | 'lowerThird')
  })

  safeHandle(IPC_CHANNELS.OVERLAY_FIRE_LT, () => {
    logIPC(IPC_CHANNELS.OVERLAY_FIRE_LT)
    overlay.fireLowerThird()
  })

  safeHandle(IPC_CHANNELS.OVERLAY_HIDE_LT, () => {
    logIPC(IPC_CHANNELS.OVERLAY_HIDE_LT)
    overlay.hideLowerThird()
  })

  safeHandle(IPC_CHANNELS.OVERLAY_GET_STATE, () => {
    return overlay.getOverlayState()
  })

  safeHandle(IPC_CHANNELS.OVERLAY_AUTO_FIRE_TOGGLE, () => {
    const newState = !recording.getAutoFire()
    recording.setAutoFire(newState)
    return newState
  })

  // Legacy LT compat — redirect to overlay
  safeHandle(IPC_CHANNELS.LT_FIRE, () => {
    overlay.fireLowerThird()
  })

  safeHandle(IPC_CHANNELS.LT_HIDE, () => {
    overlay.hideLowerThird()
  })

  safeHandle(IPC_CHANNELS.LT_AUTO_FIRE_TOGGLE, () => {
    const newState = !recording.getAutoFire()
    recording.setAutoFire(newState)
    return newState
  })
```

**Step 3: Add RECORDING_NEXT_FULL handler (after RECORDING_UNSKIP, ipc.ts ~line 106)**

```typescript
  safeHandle(IPC_CHANNELS.RECORDING_NEXT_FULL, async () => {
    logIPC(IPC_CHANNELS.RECORDING_NEXT_FULL)
    await recording.nextFull()
  })
```

**Step 4: Update index.ts — replace lowerThird with overlay + wsHub**

Replace line 9:
```typescript
import * as overlay from './services/overlay'
import * as wsHub from './services/wsHub'
```

Replace line 141 (`lowerThird.startServer()`):
```typescript
  overlay.startServer()
  wsHub.start()
```

Replace line 159 (`lowerThird.stopServer()`):
```typescript
  wsHub.stop()
  overlay.stopServer()
```

**Step 5: Update preload/index.ts — add overlay methods (line ~57-61)**

Replace the LT methods section:

```typescript
  // Overlay
  overlayToggle: (element: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_TOGGLE, element),
  overlayFireLT: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_FIRE_LT),
  overlayHideLT: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_HIDE_LT),
  overlayGetState: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_GET_STATE),
  overlayAutoFireToggle: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_AUTO_FIRE_TOGGLE),

  // Legacy LT (keep for now)
  ltFire: () => ipcRenderer.invoke(IPC_CHANNELS.LT_FIRE),
  ltHide: () => ipcRenderer.invoke(IPC_CHANNELS.LT_HIDE),
  ltAutoFireToggle: () => ipcRenderer.invoke(IPC_CHANNELS.LT_AUTO_FIRE_TOGGLE),
```

**Step 6: Commit**

```bash
git add src/main/ipc.ts src/main/index.ts src/preload/index.ts
git commit -m "feat: wire overlay + wsHub into app lifecycle"
```

---

### Task 7: Update OverlayControls UI + hook up wsHub broadcasts

**Files:**
- Modify: `src/renderer/components/LowerThirdControls.tsx` → rename to `OverlayControls.tsx`
- Modify: `src/main/services/recording.ts` (existing `next()` — update overlay data on advance)
- Modify: `src/main/services/hotkeys.ts` (update import)

**Step 1: Create `OverlayControls.tsx` (replaces `LowerThirdControls.tsx`)**

Create `src/renderer/components/OverlayControls.tsx`:

```tsx
import React, { useState, useEffect } from 'react'

interface OverlayToggles {
  counter: boolean
  clock: boolean
  logo: boolean
  lowerThird: boolean
}

export default function OverlayControls(): React.ReactElement {
  const [autoFire, setAutoFire] = useState(false)
  const [toggles, setToggles] = useState<OverlayToggles>({
    counter: true, clock: false, logo: true, lowerThird: false,
  })

  useEffect(() => {
    // Load initial overlay state
    window.api.overlayGetState().then((state: any) => {
      if (state) {
        setToggles({
          counter: state.counter?.visible ?? true,
          clock: state.clock?.visible ?? false,
          logo: state.logo?.visible ?? true,
          lowerThird: state.lowerThird?.visible ?? false,
        })
      }
    })
  }, [])

  async function handleToggle(element: keyof OverlayToggles): Promise<void> {
    const result = await window.api.overlayToggle(element) as any
    if (result) {
      setToggles({
        counter: result.counter?.visible ?? toggles.counter,
        clock: result.clock?.visible ?? toggles.clock,
        logo: result.logo?.visible ?? toggles.logo,
        lowerThird: result.lowerThird?.visible ?? toggles.lowerThird,
      })
    }
  }

  async function handleAutoFireToggle(): Promise<void> {
    const newState = await window.api.overlayAutoFireToggle()
    setAutoFire(newState as boolean)
  }

  const toggleBtn = (label: string, element: keyof OverlayToggles) => (
    <button
      style={{
        padding: '4px 8px',
        background: toggles[element] ? 'rgba(34,197,94,0.15)' : 'var(--bg-secondary)',
        border: `1px solid ${toggles[element] ? 'var(--success)' : 'var(--border)'}`,
        borderRadius: '4px',
        color: toggles[element] ? 'var(--success)' : 'var(--text-secondary)',
        fontSize: '9px',
        fontWeight: toggles[element] ? 600 : 400,
        transition: 'all 0.15s',
      }}
      onClick={() => handleToggle(element)}
    >
      {label}
    </button>
  )

  return (
    <div className="section">
      <div className="section-title">Overlay</div>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
        {toggleBtn('Counter', 'counter')}
        {toggleBtn('Clock', 'clock')}
        {toggleBtn('Logo', 'logo')}
        <span style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 2px' }} />
        <button
          style={{
            padding: '4px 8px',
            background: autoFire ? 'rgba(34,197,94,0.15)' : 'var(--bg-secondary)',
            border: `1px solid ${autoFire ? 'var(--success)' : 'var(--border)'}`,
            borderRadius: '4px',
            color: autoFire ? 'var(--success)' : 'var(--text-secondary)',
            fontSize: '9px', fontWeight: autoFire ? 600 : 400,
            transition: 'all 0.15s',
          }}
          onClick={handleAutoFireToggle}
        >
          Auto {autoFire ? 'ON' : 'OFF'}
        </button>
        <button
          style={{
            padding: '4px 8px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            color: 'var(--text-primary)',
            fontSize: '9px',
            transition: 'all 0.15s',
          }}
          onClick={() => window.api.overlayFireLT()}
        >
          Fire LT
        </button>
        <button
          style={{
            padding: '4px 8px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            color: 'var(--text-primary)',
            fontSize: '9px',
            transition: 'all 0.15s',
          }}
          onClick={() => window.api.overlayHideLT()}
        >
          Hide LT
        </button>
      </div>
    </div>
  )
}
```

**Step 2: Update the parent component that imports LowerThirdControls**

Search for `LowerThirdControls` import in `LeftPanel.tsx` (or wherever it's used) and replace with:

```typescript
import OverlayControls from './OverlayControls'
// and in JSX: <OverlayControls /> instead of <LowerThirdControls />
```

**Step 3: Update hotkeys.ts — replace lowerThird import with overlay (line 4)**

```typescript
import * as overlay from './overlay'
```

Replace lines 32-38 (the fireLowerThird handler body):

```typescript
  registerKey(settings.hotkeys.fireLowerThird, 'Fire Lower Third', () => {
    overlay.fireLowerThird()
  })
```

**Step 4: Update recording.ts `next()` — sync overlay data on advance (lines 197-206)**

Replace the `syncLowerThird` block:

```typescript
  // Update overlay data
  if (settings.behavior.syncLowerThird) {
    const comp = state.getCompetition()
    const visibleCount = comp ? comp.routines.filter(r => r.status !== 'skipped').length : 0
    overlay.updateRoutineData({
      entryNumber: nextRoutine.entryNumber,
      routineTitle: nextRoutine.routineTitle,
      dancers: nextRoutine.dancers,
      studioName: nextRoutine.studioName,
      category: `${nextRoutine.ageGroup} ${nextRoutine.category}`,
      current: state.getCurrentRoutineIndex() + 1,
      total: visibleCount,
    })
  }
```

Replace the `autoFire` block (lines 209-211) to use overlay:

```typescript
  if (autoFireEnabled) {
    scheduleAutoFire()
  }
```

And update `scheduleAutoFire` function (lines 30-43) to use overlay:

```typescript
function scheduleAutoFire(): void {
  if (!autoFireEnabled) return
  if (autoFireTimer) clearTimeout(autoFireTimer)
  autoFireTimer = setTimeout(() => {
    overlay.fireLowerThird()
    autoFireTimer = null
    logger.app.info('Overlay lower third auto-fired (3s delay)')
  }, 3000)
}
```

**Step 5: Wire wsHub.broadcastState() into recording.broadcastFullState()**

At the bottom of `recording.ts`, after `sendToRenderer(...)` in `broadcastFullState()`:

```typescript
import * as wsHub from './wsHub'
```

Add to `broadcastFullState()`:

```typescript
function broadcastFullState(): void {
  const competition = state.getCompetition()
  const current = state.getCurrentRoutine()
  const nextR = state.getNextRoutine()

  sendToRenderer(IPC_CHANNELS.STATE_UPDATE, {
    competition,
    currentRoutine: current,
    nextRoutine: nextR,
    currentIndex: state.getCurrentRoutineIndex(),
  })

  // Broadcast to WebSocket clients (Stream Deck + overlay)
  wsHub.broadcastState()
}
```

**Step 6: Delete old lowerThird.ts**

```bash
rm src/main/services/lowerThird.ts
```

**Step 7: Build and verify**

Run: `npm run build`
Expected: No TypeScript errors, clean build.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: replace lower third with unified overlay controls + wsHub wiring"
```

---

## Phase 2: Stream Deck Plugin (Tasks 8-12)

### Task 8: Scaffold Stream Deck plugin project

**Files:**
- Create: `streamdeck-plugin/` directory structure

**Step 1: Create plugin directory structure**

```bash
cd D:/ClaudeCode/CompSyncElectronApp
mkdir -p streamdeck-plugin/com.compsync.streamdeck.sdPlugin/imgs/actions
mkdir -p streamdeck-plugin/src/actions
```

**Step 2: Create package.json**

Create `streamdeck-plugin/package.json`:

```json
{
  "name": "compsync-streamdeck",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "rollup -c",
    "watch": "rollup -c -w"
  },
  "dependencies": {
    "@elgato/streamdeck": "^2.0.1",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@rollup/plugin-node-resolve": "^15.2.3",
    "@rollup/plugin-typescript": "^11.1.6",
    "@types/ws": "^8.5.10",
    "rollup": "^4.9.0",
    "tslib": "^2.6.2",
    "typescript": "^5.3.3"
  }
}
```

**Step 3: Create tsconfig.json**

Create `streamdeck-plugin/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "com.compsync.streamdeck.sdPlugin/bin",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "experimentalDecorators": true
  },
  "include": ["src/**/*.ts"]
}
```

**Step 4: Create rollup.config.mjs**

Create `streamdeck-plugin/rollup.config.mjs`:

```javascript
import resolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

export default {
  input: 'src/plugin.ts',
  output: {
    file: 'com.compsync.streamdeck.sdPlugin/bin/plugin.js',
    format: 'es',
    sourcemap: true,
  },
  plugins: [
    resolve(),
    typescript(),
  ],
}
```

**Step 5: Create manifest.json**

Create `streamdeck-plugin/com.compsync.streamdeck.sdPlugin/manifest.json`:

```json
{
  "UUID": "com.compsync.streamdeck",
  "Name": "CompSync Media",
  "Version": "1.0.0.0",
  "Author": "Stream Stage",
  "Description": "Control CompSync Media competition workflow from Stream Deck",
  "Icon": "imgs/plugin-icon",
  "CodePath": "bin/plugin.js",
  "SDKVersion": 2,
  "Software": {
    "MinimumVersion": "6.5"
  },
  "OS": [
    { "Platform": "windows", "MinimumVersion": "10" }
  ],
  "Nodejs": {
    "Version": "20",
    "Debug": "enabled"
  },
  "ApplicationsToMonitor": {
    "windows": ["CompSync Media.exe"]
  },
  "Actions": [
    {
      "UUID": "com.compsync.streamdeck.next-full",
      "Name": "NEXT",
      "Tooltip": "Full pipeline: advance + record + overlay",
      "Icon": "imgs/actions/next-full",
      "Controllers": ["Keypad"],
      "States": [{ "Image": "imgs/actions/next-full", "Title": "NEXT" }]
    },
    {
      "UUID": "com.compsync.streamdeck.next-routine",
      "Name": "Next Routine",
      "Tooltip": "Advance to next routine (no auto-actions)",
      "Icon": "imgs/actions/next-routine",
      "Controllers": ["Keypad"],
      "States": [{ "Image": "imgs/actions/next-routine", "Title": "Next" }]
    },
    {
      "UUID": "com.compsync.streamdeck.prev",
      "Name": "Prev",
      "Tooltip": "Go to previous routine",
      "Icon": "imgs/actions/prev",
      "Controllers": ["Keypad"],
      "States": [{ "Image": "imgs/actions/prev", "Title": "Prev" }]
    },
    {
      "UUID": "com.compsync.streamdeck.skip",
      "Name": "Skip",
      "Tooltip": "Skip or unskip current routine",
      "Icon": "imgs/actions/skip",
      "Controllers": ["Keypad"],
      "States": [{ "Image": "imgs/actions/skip", "Title": "Skip" }]
    },
    {
      "UUID": "com.compsync.streamdeck.record",
      "Name": "Record",
      "Tooltip": "Toggle OBS recording",
      "Icon": "imgs/actions/record",
      "Controllers": ["Keypad"],
      "States": [
        { "Image": "imgs/actions/record", "Title": "REC" },
        { "Image": "imgs/actions/record-active", "Title": "STOP" }
      ]
    },
    {
      "UUID": "com.compsync.streamdeck.stream",
      "Name": "Stream",
      "Tooltip": "Toggle OBS streaming",
      "Icon": "imgs/actions/stream",
      "Controllers": ["Keypad"],
      "States": [
        { "Image": "imgs/actions/stream", "Title": "OFF" },
        { "Image": "imgs/actions/stream-active", "Title": "LIVE" }
      ]
    },
    {
      "UUID": "com.compsync.streamdeck.save-replay",
      "Name": "Save Replay",
      "Tooltip": "Save OBS replay buffer",
      "Icon": "imgs/actions/replay",
      "Controllers": ["Keypad"],
      "States": [{ "Image": "imgs/actions/replay", "Title": "Replay" }]
    },
    {
      "UUID": "com.compsync.streamdeck.overlay-lower-third",
      "Name": "Lower Third",
      "Tooltip": "Fire or hide lower third overlay",
      "Icon": "imgs/actions/lower-third",
      "Controllers": ["Keypad"],
      "States": [
        { "Image": "imgs/actions/lower-third", "Title": "LT" },
        { "Image": "imgs/actions/lower-third-active", "Title": "LT" }
      ]
    },
    {
      "UUID": "com.compsync.streamdeck.overlay-counter",
      "Name": "Counter",
      "Tooltip": "Toggle entry counter overlay",
      "Icon": "imgs/actions/counter",
      "Controllers": ["Keypad"],
      "States": [
        { "Image": "imgs/actions/counter", "Title": "CTR" },
        { "Image": "imgs/actions/counter-active", "Title": "CTR" }
      ]
    },
    {
      "UUID": "com.compsync.streamdeck.overlay-clock",
      "Name": "Clock",
      "Tooltip": "Toggle time of day overlay",
      "Icon": "imgs/actions/clock",
      "Controllers": ["Keypad"],
      "States": [
        { "Image": "imgs/actions/clock", "Title": "CLK" },
        { "Image": "imgs/actions/clock-active", "Title": "CLK" }
      ]
    },
    {
      "UUID": "com.compsync.streamdeck.overlay-logo",
      "Name": "Logo",
      "Tooltip": "Toggle client logo overlay",
      "Icon": "imgs/actions/logo",
      "Controllers": ["Keypad"],
      "States": [
        { "Image": "imgs/actions/logo", "Title": "LOGO" },
        { "Image": "imgs/actions/logo-active", "Title": "LOGO" }
      ]
    }
  ]
}
```

**Step 6: Commit**

```bash
git add streamdeck-plugin/
git commit -m "feat: scaffold Stream Deck plugin project"
```

---

### Task 9: Create plugin connection module

**Files:**
- Create: `streamdeck-plugin/src/connection.ts`

**Step 1: Create the WebSocket client to Electron app**

Create `streamdeck-plugin/src/connection.ts`:

```typescript
import WebSocket from 'ws'

export interface AppState {
  routine: {
    entryNumber: string
    routineTitle: string
    dancers: string
    studioName: string
    category: string
  } | null
  nextRoutine: {
    entryNumber: string
    routineTitle: string
  } | null
  index: number
  total: number
  recording: { active: boolean; elapsed: number }
  streaming: boolean
  skippedCount: number
  overlay: {
    counter: { visible: boolean; current: number; total: number; entryNumber: string }
    clock: { visible: boolean }
    logo: { visible: boolean; url: string }
    lowerThird: { visible: boolean }
  }
}

type StateCallback = (state: AppState) => void

const WS_URL = 'ws://localhost:9877'
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let stateCallbacks: StateCallback[] = []
let currentState: AppState | null = null
let connected = false

export function onState(cb: StateCallback): void {
  stateCallbacks.push(cb)
  // Send current state immediately if available
  if (currentState) cb(currentState)
}

export function isConnected(): boolean {
  return connected
}

export function getState(): AppState | null {
  return currentState
}

export function sendCommand(action: string, element?: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const msg: Record<string, string> = { type: 'command', action }
  if (element) msg.element = element
  ws.send(JSON.stringify(msg))
}

export function connect(): void {
  if (ws) return

  try {
    ws = new WebSocket(WS_URL)
  } catch {
    scheduleReconnect()
    return
  }

  ws.on('open', () => {
    connected = true
    reconnectDelay = 1000
    ws!.send(JSON.stringify({ type: 'identify', client: 'streamdeck' }))
    console.log('[CompSync] Connected to Electron app')
  })

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'state') {
        currentState = msg as AppState
        for (const cb of stateCallbacks) cb(currentState)
      }
    } catch {}
  })

  ws.on('close', () => {
    connected = false
    ws = null
    console.log('[CompSync] Disconnected from Electron app')
    scheduleReconnect()
  })

  ws.on('error', () => {
    connected = false
    ws?.close()
    ws = null
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 30000)
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  connected = false
}
```

**Step 2: Commit**

```bash
git add streamdeck-plugin/src/connection.ts
git commit -m "feat: SD plugin WebSocket client for Electron app"
```

---

### Task 10: Create SVG renderer for dynamic button images

**Files:**
- Create: `streamdeck-plugin/src/svg.ts`

**Step 1: Create SVG rendering utilities**

Create `streamdeck-plugin/src/svg.ts`:

```typescript
// Generate SVG strings for dynamic Stream Deck button images (144x144)

function wrap(inner: string, bg = '#1e1e2e'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${bg}"/>
    ${inner}
  </svg>`
}

export function nextFull(entryNumber: string | null, connected: boolean): string {
  if (!connected) {
    return wrap(`<text x="72" y="82" text-anchor="middle" fill="#555" font-size="16" font-family="sans-serif">OFFLINE</text>`, '#111')
  }
  const num = entryNumber || '—'
  return wrap(`
    <text x="72" y="56" text-anchor="middle" fill="#667eea" font-size="14" font-family="sans-serif">NEXT</text>
    <text x="72" y="90" text-anchor="middle" fill="#e0e0f0" font-size="32" font-weight="bold" font-family="sans-serif">#${num}</text>
    <text x="72" y="116" text-anchor="middle" fill="#667eea" font-size="12" font-family="sans-serif">▶ FULL</text>
  `, '#1a1a2e')
}

export function nextRoutine(entryNumber: string | null): string {
  const num = entryNumber || '—'
  return wrap(`
    <text x="72" y="50" text-anchor="middle" fill="#9090b0" font-size="12" font-family="sans-serif">CURRENT</text>
    <text x="72" y="88" text-anchor="middle" fill="#e0e0f0" font-size="36" font-weight="bold" font-family="sans-serif">#${num}</text>
  `)
}

export function prev(entryNumber: string | null): string {
  const num = entryNumber || '—'
  return wrap(`
    <text x="72" y="56" text-anchor="middle" fill="#9090b0" font-size="12" font-family="sans-serif">PREV</text>
    <text x="72" y="92" text-anchor="middle" fill="#c0c0d0" font-size="28" font-family="sans-serif">#${num}</text>
  `)
}

export function record(active: boolean, elapsed: number): string {
  if (active) {
    const mins = Math.floor(elapsed / 60)
    const secs = String(Math.floor(elapsed % 60)).padStart(2, '0')
    return wrap(`
      <circle cx="72" cy="52" r="12" fill="#ef4444"/>
      <text x="72" y="100" text-anchor="middle" fill="#ef4444" font-size="24" font-weight="bold" font-family="monospace">${mins}:${secs}</text>
    `, '#2a1a1a')
  }
  return wrap(`
    <circle cx="72" cy="60" r="16" fill="none" stroke="#666" stroke-width="2"/>
    <circle cx="72" cy="60" r="8" fill="#666"/>
    <text x="72" y="108" text-anchor="middle" fill="#888" font-size="16" font-family="sans-serif">REC</text>
  `)
}

export function stream(active: boolean): string {
  if (active) {
    return wrap(`
      <text x="72" y="80" text-anchor="middle" fill="#ef4444" font-size="28" font-weight="bold" font-family="sans-serif">LIVE</text>
      <circle cx="72" cy="108" r="4" fill="#ef4444"/>
    `, '#2a1a1a')
  }
  return wrap(`
    <text x="72" y="80" text-anchor="middle" fill="#666" font-size="24" font-family="sans-serif">OFF</text>
  `)
}

export function replay(flash: boolean): string {
  const color = flash ? '#22c55e' : '#888'
  return wrap(`
    <text x="72" y="80" text-anchor="middle" fill="${color}" font-size="32" font-family="sans-serif">⟲</text>
    <text x="72" y="112" text-anchor="middle" fill="${color}" font-size="12" font-family="sans-serif">REPLAY</text>
  `)
}

export function skip(count: number): string {
  return wrap(`
    <text x="72" y="72" text-anchor="middle" fill="#f59e0b" font-size="28" font-family="sans-serif">⏭</text>
    <text x="72" y="108" text-anchor="middle" fill="#9090b0" font-size="14" font-family="sans-serif">${count} skipped</text>
  `)
}

export function overlayToggle(label: string, active: boolean): string {
  const color = active ? '#22c55e' : '#666'
  const bg = active ? '#1a2a1a' : '#1e1e2e'
  return wrap(`
    <circle cx="72" cy="54" r="8" fill="${color}"/>
    <text x="72" y="100" text-anchor="middle" fill="${color}" font-size="16" font-weight="${active ? 'bold' : 'normal'}" font-family="sans-serif">${label}</text>
  `, bg)
}
```

**Step 2: Commit**

```bash
git add streamdeck-plugin/src/svg.ts
git commit -m "feat: SD plugin SVG renderer for dynamic button images"
```

---

### Task 11: Create action classes

**Files:**
- Create: `streamdeck-plugin/src/actions/next-full.ts`
- Create: `streamdeck-plugin/src/actions/next-routine.ts`
- Create: `streamdeck-plugin/src/actions/prev.ts`
- Create: `streamdeck-plugin/src/actions/skip.ts`
- Create: `streamdeck-plugin/src/actions/record.ts`
- Create: `streamdeck-plugin/src/actions/stream.ts`
- Create: `streamdeck-plugin/src/actions/save-replay.ts`
- Create: `streamdeck-plugin/src/actions/overlay-toggle.ts`

**Step 1: Create all action files**

Create `streamdeck-plugin/src/actions/next-full.ts`:

```typescript
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.next-full' })
export class NextFullAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const num = state.nextRoutine?.entryNumber ?? null
      const img = svg.nextFull(num, conn.isConnected())
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('nextFull')
    await ev.action.showOk()
  }
}
```

Create `streamdeck-plugin/src/actions/next-routine.ts`:

```typescript
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.next-routine' })
export class NextRoutineAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const num = state.routine?.entryNumber ?? null
      const img = svg.nextRoutine(num)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('nextRoutine')
    await ev.action.showOk()
  }
}
```

Create `streamdeck-plugin/src/actions/prev.ts`:

```typescript
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.prev' })
export class PrevAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      // Show the entry before current (index-1) — we don't have it easily, show "Prev"
      const img = svg.prev(state.index > 0 ? String(state.index) : null)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('prev')
    await ev.action.showOk()
  }
}
```

Create `streamdeck-plugin/src/actions/skip.ts`:

```typescript
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.skip' })
export class SkipAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.skip(state.skippedCount)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('skip')
    await ev.action.showOk()
  }
}
```

Create `streamdeck-plugin/src/actions/record.ts`:

```typescript
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.record' })
export class RecordAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.record(state.recording.active, state.recording.elapsed)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
      await ev.action.setState(state.recording.active ? 1 : 0)
    })
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleRecord')
  }
}
```

Create `streamdeck-plugin/src/actions/stream.ts`:

```typescript
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.stream' })
export class StreamAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.stream(state.streaming)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
      await ev.action.setState(state.streaming ? 1 : 0)
    })
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleStream')
  }
}
```

Create `streamdeck-plugin/src/actions/save-replay.ts`:

```typescript
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.save-replay' })
export class SaveReplayAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const img = svg.replay(false)
    await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('saveReplay')
    // Flash green
    const flashImg = svg.replay(true)
    await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(flashImg).toString('base64')}`)
    await ev.action.showOk()
    setTimeout(async () => {
      const normalImg = svg.replay(false)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(normalImg).toString('base64')}`)
    }, 1500)
  }
}
```

Create `streamdeck-plugin/src/actions/overlay-toggle.ts`:

```typescript
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

// One class per overlay element — 4 instances

@action({ UUID: 'com.compsync.streamdeck.overlay-lower-third' })
export class OverlayLowerThirdAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.overlayToggle('LT', state.overlay.lowerThird.visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
      await ev.action.setState(state.overlay.lowerThird.visible ? 1 : 0)
    })
  }
  override async onKeyDown(): Promise<void> {
    conn.sendCommand('toggleOverlay', 'lowerThird')
  }
}

@action({ UUID: 'com.compsync.streamdeck.overlay-counter' })
export class OverlayCounterAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.overlayToggle('CTR', state.overlay.counter.visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
      await ev.action.setState(state.overlay.counter.visible ? 1 : 0)
    })
  }
  override async onKeyDown(): Promise<void> {
    conn.sendCommand('toggleOverlay', 'counter')
  }
}

@action({ UUID: 'com.compsync.streamdeck.overlay-clock' })
export class OverlayClockAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.overlayToggle('CLK', state.overlay.clock.visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
      await ev.action.setState(state.overlay.clock.visible ? 1 : 0)
    })
  }
  override async onKeyDown(): Promise<void> {
    conn.sendCommand('toggleOverlay', 'clock')
  }
}

@action({ UUID: 'com.compsync.streamdeck.overlay-logo' })
export class OverlayLogoAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.overlayToggle('LOGO', state.overlay.logo.visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
      await ev.action.setState(state.overlay.logo.visible ? 1 : 0)
    })
  }
  override async onKeyDown(): Promise<void> {
    conn.sendCommand('toggleOverlay', 'logo')
  }
}
```

**Step 2: Commit**

```bash
git add streamdeck-plugin/src/actions/
git commit -m "feat: SD plugin action classes for all 12 buttons"
```

---

### Task 12: Create plugin entry point + build

**Files:**
- Create: `streamdeck-plugin/src/plugin.ts`

**Step 1: Create plugin.ts entry point**

Create `streamdeck-plugin/src/plugin.ts`:

```typescript
import streamDeck from '@elgato/streamdeck'
import * as conn from './connection'

import { NextFullAction } from './actions/next-full'
import { NextRoutineAction } from './actions/next-routine'
import { PrevAction } from './actions/prev'
import { SkipAction } from './actions/skip'
import { RecordAction } from './actions/record'
import { StreamAction } from './actions/stream'
import { SaveReplayAction } from './actions/save-replay'
import {
  OverlayLowerThirdAction,
  OverlayCounterAction,
  OverlayClockAction,
  OverlayLogoAction,
} from './actions/overlay-toggle'

// Register all actions
streamDeck.actions.registerAction(new NextFullAction())
streamDeck.actions.registerAction(new NextRoutineAction())
streamDeck.actions.registerAction(new PrevAction())
streamDeck.actions.registerAction(new SkipAction())
streamDeck.actions.registerAction(new RecordAction())
streamDeck.actions.registerAction(new StreamAction())
streamDeck.actions.registerAction(new SaveReplayAction())
streamDeck.actions.registerAction(new OverlayLowerThirdAction())
streamDeck.actions.registerAction(new OverlayCounterAction())
streamDeck.actions.registerAction(new OverlayClockAction())
streamDeck.actions.registerAction(new OverlayLogoAction())

// Connect to CompSync Electron App
conn.connect()

// Connect to Stream Deck
streamDeck.connect()
```

**Step 2: Install dependencies**

Run:
```bash
cd D:/ClaudeCode/CompSyncElectronApp/streamdeck-plugin
npm install
```

**Step 3: Build the plugin**

Run: `npm run build`
Expected: `com.compsync.streamdeck.sdPlugin/bin/plugin.js` created without errors.

**Step 4: Commit**

```bash
cd D:/ClaudeCode/CompSyncElectronApp
git add streamdeck-plugin/
git commit -m "feat: SD plugin entry point + first successful build"
```

---

## Phase 3: Integration Testing (Tasks 13-14)

### Task 13: Build Electron app with all changes

**Step 1: Build the Electron app**

Run:
```bash
cd D:/ClaudeCode/CompSyncElectronApp
npm run build
```

Expected: Clean build, no TypeScript errors.

**Step 2: Fix any type errors**

Common issues to watch for:
- `overlay` settings key not matching old `lowerThird` references in settings.ts `DEFAULT_SETTINGS`
- Missing `overlayToggle` / `overlayFireLT` / `overlayHideLT` / `overlayAutoFireToggle` / `overlayGetState` in `window.api` type declaration (`src/renderer/types.d.ts`)
- Import cycles between recording.ts ↔ wsHub.ts (if circular, use lazy import or callback pattern)

**Step 3: Verify WebSocket server starts**

Run the app in dev mode: `npm run dev`
- Check console for: `WebSocket hub listening on ws://localhost:9877`
- Check console for: `Overlay server running on http://localhost:9876`

**Step 4: Test overlay page**

Open `http://localhost:9876/overlay` in a browser.
Expected: Transparent page with counter visible in top-right. Clock hidden. Lower third hidden.

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration fixes for overlay + wsHub"
```

---

### Task 14: Create placeholder icon PNGs for Stream Deck

**Files:**
- Create: SVG-based placeholder icons in `streamdeck-plugin/com.compsync.streamdeck.sdPlugin/imgs/`

**Step 1: Create minimal placeholder icons**

The Stream Deck requires PNG icons at specific sizes. For now, create simple SVG-rendered placeholders. Each action needs a 20×20 and 40×40 icon (the SDK auto-scales, so 144×144 works too).

Create a simple Node.js script to generate placeholder PNGs, OR use the SVG directly (Stream Deck SDK accepts SVG paths as icon references — it looks for `{name}.png` or `{name}@2x.png`).

For initial testing, create 1×1 transparent PNGs as placeholders:

```bash
cd D:/ClaudeCode/CompSyncElectronApp/streamdeck-plugin/com.compsync.streamdeck.sdPlugin/imgs

# Create minimal valid PNG files (1x1 transparent) as placeholders
# These will be replaced with real icons later
node -e "
const fs = require('fs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const names = ['plugin-icon', 'actions/next-full', 'actions/next-routine', 'actions/prev', 'actions/skip', 'actions/record', 'actions/record-active', 'actions/stream', 'actions/stream-active', 'actions/replay', 'actions/lower-third', 'actions/lower-third-active', 'actions/counter', 'actions/counter-active', 'actions/clock', 'actions/clock-active', 'actions/logo', 'actions/logo-active'];
for (const name of names) {
  fs.writeFileSync(name + '.png', png);
  console.log('Created: ' + name + '.png');
}
"
```

**Step 2: Commit**

```bash
cd D:/ClaudeCode/CompSyncElectronApp
git add streamdeck-plugin/com.compsync.streamdeck.sdPlugin/imgs/
git commit -m "feat: placeholder icons for Stream Deck plugin"
```

---

## Phase 4: Final Wiring + Version Bump (Task 15)

### Task 15: Version bump, settings migration, cleanup

**Files:**
- Modify: `package.json` (version → 2.3.0)
- Modify: `src/main/services/settings.ts` (migrate `lowerThird` → `overlay` key)
- Delete: `src/main/services/lowerThird.ts`
- Delete: `src/renderer/components/LowerThirdControls.tsx`

**Step 1: Bump version**

In `package.json`, change `"version": "2.2.0"` to `"version": "2.3.0"`.

**Step 2: Add settings migration in settings.ts**

In `getSettings()` or wherever settings are loaded, add a migration that converts old `lowerThird` key to `overlay`:

```typescript
// After loading settings, check for legacy lowerThird key
if ((loaded as any).lowerThird && !loaded.overlay) {
  const lt = (loaded as any).lowerThird
  loaded.overlay = {
    autoHideSeconds: lt.autoHideSeconds ?? 8,
    overlayUrl: lt.overlayUrl ?? 'http://localhost:9876/overlay',
    logoUrl: '',
    defaultCounter: true,
    defaultClock: false,
    defaultLogo: true,
  }
  delete (loaded as any).lowerThird
  // Save migrated settings
  store.set('settings', loaded)
}
```

**Step 3: Delete old files**

```bash
rm src/main/services/lowerThird.ts
rm src/renderer/components/LowerThirdControls.tsx
```

**Step 4: Final build**

Run: `npm run build`
Expected: Clean build.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: v2.3.0 — Stream Deck plugin + unified overlay

- WebSocket hub (port 9877) for SD + overlay communication
- Unified overlay with 4 toggleable elements (counter, clock, logo, lower third)
- Stream Deck plugin with 12 actions (workflow, OBS, overlay toggles)
- NEXT button: full automated pipeline (advance + record + 5s + overlay)
- Settings migration from lowerThird to overlay"
```

---

## Summary

| Phase | Tasks | What It Delivers |
|-------|-------|-----------------|
| 1 (Electron) | 1-7 | WebSocket hub, unified overlay, nextFull(), overlay controls UI |
| 2 (SD Plugin) | 8-12 | Full Stream Deck plugin with 12 actions + dynamic SVG buttons |
| 3 (Integration) | 13-14 | Build verification, placeholder icons |
| 4 (Cleanup) | 15 | Version bump, settings migration, old file removal |

**Total new files:** 14 (7 Electron, 7 SD plugin)
**Modified files:** 7 (types, ipc, index, recording, hotkeys, preload, settings)
**Deleted files:** 2 (lowerThird.ts, LowerThirdControls.tsx)
