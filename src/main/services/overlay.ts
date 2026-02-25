import express from 'express'
import http from 'http'
import { OverlayState } from '../../shared/types'
import { getSettings } from './settings'
import { logger } from '../logger'

const PORT = 9876
let server: http.Server | null = null
let autoHideTimer: NodeJS.Timeout | null = null

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

export function startServer(): void {
  if (server) return
  initDefaults()
  const app = express()

  app.get('/overlay', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(buildOverlayHTML())
  })

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
    font-size: 48px; font-weight: 800; color: #e0e0f0; line-height: 1;
  }
  .counter-number::before { content: '#'; opacity: 0.4; font-size: 28px; }
  .counter-label { font-size: 13px; color: #9090b0; margin-top: 4px; letter-spacing: 0.5px; }
  .counter.advance .counter-number { animation: counterPop 0.5s ease; }
  @keyframes counterPop {
    0% { transform: scale(1); }
    40% { transform: scale(1.25); color: #667eea; }
    100% { transform: scale(1); }
  }
  .logo {
    position: absolute; top: 30px; left: 40px;
    opacity: 0; transition: opacity 0.4s ease;
  }
  .logo.visible { opacity: 1; }
  .logo img { max-height: 60px; max-width: 200px; border-radius: 6px; }
  .clock {
    position: absolute; top: 130px; right: 40px;
    opacity: 0; transition: opacity 0.4s ease;
  }
  .clock.visible { opacity: 1; }
  .clock-box {
    background: rgba(30, 30, 46, 0.85);
    border: 1px solid rgba(102, 126, 234, 0.3);
    border-radius: 8px; padding: 8px 16px;
    backdrop-filter: blur(8px);
    text-align: center; min-width: 120px;
  }
  .clock-time {
    font-size: 22px; font-weight: 600; color: #c0c0e0;
    font-variant-numeric: tabular-nums;
  }
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
<div class="counter" id="counter">
  <div class="counter-box">
    <div class="counter-number" id="counterNumber"></div>
    <div class="counter-label" id="counterLabel"></div>
  </div>
</div>
<div class="logo" id="logo"><img id="logoImg" src="" alt="" /></div>
<div class="clock" id="clock"><div class="clock-box"><div class="clock-time" id="clockTime"></div></div></div>
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
    const counterEl = document.getElementById('counter');
    const counterNum = document.getElementById('counterNumber');
    const counterLabel = document.getElementById('counterLabel');
    if (o.counter.visible) {
      counterEl.classList.add('visible');
      if (o.counter.entryNumber !== lastCounterEntry && lastCounterEntry !== '') {
        counterEl.classList.remove('advance');
        void counterEl.offsetWidth;
        counterEl.classList.add('advance');
      }
      lastCounterEntry = o.counter.entryNumber;
      counterNum.textContent = o.counter.entryNumber;
      counterLabel.textContent = o.counter.current + ' / ' + o.counter.total;
    } else {
      counterEl.classList.remove('visible');
    }
    const logoEl = document.getElementById('logo');
    const logoImg = document.getElementById('logoImg');
    if (o.logo.visible && o.logo.url) {
      logoEl.classList.add('visible');
      logoImg.src = o.logo.url;
    } else {
      logoEl.classList.remove('visible');
    }
    const clockEl = document.getElementById('clock');
    if (o.clock.visible) clockEl.classList.add('visible');
    else clockEl.classList.remove('visible');
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
  connect();
</script>
</body>
</html>`
}
