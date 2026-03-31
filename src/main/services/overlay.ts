import express from 'express'
import http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { OverlayState, OverlayLayout, DEFAULT_LAYOUT, TickerState, StartingSoonState, AnimationConfig } from '../../shared/types'
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
    animation: 'random',
    showEntryNumber: true,
    showRoutineTitle: true,
    showDancers: true,
    showStudioName: true,
    showCategory: true,
  },
  ticker: {
    visible: false,
    text: '',
    speed: 60,
    backgroundColor: '#1e1e2e',
    textColor: '#e0e0f0',
  },
  startingSoon: {
    visible: false,
    title: 'Starting Soon',
    subtitle: '',
    showCountdown: false,
    countdownTarget: '',
  },
  animConfig: {
    animationDuration: 0.5,
    animationEasing: 'ease',
    autoHideSeconds: 8,
  },
}

let overlayLayout: OverlayLayout = { ...DEFAULT_LAYOUT }

let onStateChange: (() => void) | null = null

export function setOnStateChange(cb: () => void): void {
  onStateChange = cb
}

function notifyChange(): void {
  if (onStateChange) onStateChange()
}

// --- Overlay config persistence ---
let _autoFireEnabled = false

export function setAutoFirePersisted(enabled: boolean): void {
  _autoFireEnabled = enabled
  saveOverlayConfig()
}

export function getAutoFirePersisted(): boolean {
  return _autoFireEnabled
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'overlay-config.json')
}

function saveOverlayConfig(): void {
  try {
    const config = {
      animConfig: overlayState.animConfig,
      ticker: {
        ...overlayState.ticker,
        visible: false,  // don't restore visible — always start hidden
      },
      startingSoon: {
        ...overlayState.startingSoon,
        visible: false,       // don't restore visible
        countdownTarget: '',  // don't restore countdown target
      },
      animation: overlayState.lowerThird.animation,
      autoFireEnabled: _autoFireEnabled,
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
  } catch (_err) { /* ignore persistence errors */ }
}

function loadOverlayConfig(): void {
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      if (config.animConfig) {
        overlayState.animConfig = { ...overlayState.animConfig, ...config.animConfig }
      }
      if (config.ticker) {
        overlayState.ticker = { ...overlayState.ticker, ...config.ticker, visible: false }
      }
      if (config.startingSoon) {
        overlayState.startingSoon = { ...overlayState.startingSoon, ...config.startingSoon, visible: false }
      }
      if (config.animation) {
        overlayState.lowerThird.animation = config.animation
      }
      if (typeof config.autoFireEnabled === 'boolean') {
        _autoFireEnabled = config.autoFireEnabled
      }
      logger.app.info('Overlay config loaded from disk')
    }
  } catch (_err) { /* ignore load errors */ }
}

export function getOverlayState(): OverlayState {
  return overlayState
}

export function toggleElement(element: 'counter' | 'clock' | 'logo' | 'lowerThird'): OverlayState {
  const el = overlayState[element]
  el.visible = !el.visible

  // Cancel auto-hide timer when toggling lower third off
  if (element === 'lowerThird' && !el.visible && autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }

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
  overlayState.lowerThird.animation = settings.overlay?.animation ?? 'random'
  overlayState.lowerThird.showEntryNumber = settings.overlay?.showEntryNumber ?? true
  overlayState.lowerThird.showRoutineTitle = settings.overlay?.showRoutineTitle ?? true
  overlayState.lowerThird.showDancers = settings.overlay?.showDancers ?? true
  overlayState.lowerThird.showStudioName = settings.overlay?.showStudioName ?? true
  overlayState.lowerThird.showCategory = settings.overlay?.showCategory ?? true
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

export function updateLayout(layout: OverlayLayout): void {
  overlayLayout = { ...layout }
  // Persist to settings file
  try {
    const layoutPath = path.join(app.getPath('userData'), 'overlay-layout.json')
    fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2))
  } catch (_err) { /* ignore persistence errors */ }
  logger.app.info('Overlay layout updated')
  notifyChange()
}

export function loadPersistedLayout(): void {
  try {
    const layoutPath = path.join(app.getPath('userData'), 'overlay-layout.json')
    if (fs.existsSync(layoutPath)) {
      const data = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'))
      overlayLayout = { ...DEFAULT_LAYOUT, ...data }
      logger.app.info('Overlay layout loaded from disk')
    }
  } catch (_err) { /* ignore load errors */ }
}

export function getLayout(): OverlayLayout {
  return overlayLayout
}

export function initDefaults(): void {
  loadPersistedLayout()
  loadOverlayConfig()
  const settings = getSettings()
  if (settings.overlay) {
    overlayState.counter.visible = settings.overlay.defaultCounter ?? true
    overlayState.clock.visible = settings.overlay.defaultClock ?? false
    overlayState.logo.visible = settings.overlay.defaultLogo ?? true
    overlayState.logo.url = settings.overlay.logoUrl ?? ''
    overlayState.lowerThird.animation = settings.overlay.animation ?? 'random'
    overlayState.lowerThird.showEntryNumber = settings.overlay.showEntryNumber ?? true
    overlayState.lowerThird.showRoutineTitle = settings.overlay.showRoutineTitle ?? true
    overlayState.lowerThird.showDancers = settings.overlay.showDancers ?? true
    overlayState.lowerThird.showStudioName = settings.overlay.showStudioName ?? true
    overlayState.lowerThird.showCategory = settings.overlay.showCategory ?? true
    overlayState.animConfig.autoHideSeconds = settings.overlay.autoHideSeconds ?? 8
  }
}

// --- Ticker ---

export function setTicker(updates: Partial<TickerState>): void {
  overlayState.ticker = { ...overlayState.ticker, ...updates }
  saveOverlayConfig()
  logger.app.info(`Ticker updated: visible=${overlayState.ticker.visible}`)
  notifyChange()
}

// --- Starting Soon ---

export function setStartingSoon(updates: Partial<StartingSoonState>): void {
  overlayState.startingSoon = { ...overlayState.startingSoon, ...updates }
  saveOverlayConfig()
  logger.app.info(`Starting soon updated: visible=${overlayState.startingSoon.visible}`)
  notifyChange()
}

// --- Animation Config ---

export function setAnimationType(animation: string): void {
  overlayState.lowerThird.animation = animation as any
  saveOverlayConfig()
  logger.app.info(`Animation type set: ${animation}`)
}

export function setAnimationConfig(updates: Partial<AnimationConfig> & { animation?: string }): void {
  const { animation, ...configUpdates } = updates
  overlayState.animConfig = { ...overlayState.animConfig, ...configUpdates }
  // Sync autoHideSeconds to lowerThird state
  if (configUpdates.autoHideSeconds !== undefined) {
    overlayState.lowerThird.autoHideSeconds = configUpdates.autoHideSeconds
  }
  // Sync animation type to lowerThird state
  if (animation !== undefined) {
    overlayState.lowerThird.animation = animation as any
  }
  saveOverlayConfig()
  logger.app.info('Animation config updated')
  notifyChange()
}

export function startServer(): void {
  if (server) return
  initDefaults()
  const app = express()

  app.get('/overlay', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
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

  const host = process.env.COMPSYNC_BIND_HOST || '127.0.0.1'
  server = app.listen(PORT, host, () => {
    logger.app.info(`Overlay server running on http://${host}:${PORT}`)
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
  :root {
    --anim-dur: 0.5s;
    --anim-ease: ease;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent; overflow: hidden;
    width: 1920px; height: 1080px;
    font-family: -apple-system, 'Segoe UI', sans-serif;
  }
  .counter {
    position: absolute; left: ${overlayLayout.counter.x}%; top: ${overlayLayout.counter.y}%;
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
    position: absolute; left: ${overlayLayout.logo.x}%; top: ${overlayLayout.logo.y}%;
    opacity: 0; transition: opacity 0.4s ease;
  }
  .logo.visible { opacity: 1; }
  .logo img { max-height: 60px; max-width: 200px; border-radius: 6px; }
  .clock {
    position: absolute; left: ${overlayLayout.clock.x}%; top: ${overlayLayout.clock.y}%;
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
    font-size: 20px; font-weight: 600; color: #c0c0e0;
    font-variant-numeric: tabular-nums;
  }
  .clock-date {
    font-size: 11px; color: #9090b0; margin-top: 2px;
  }
  .lower-third {
    position: absolute; left: ${overlayLayout.lowerThird.x}%; top: ${overlayLayout.lowerThird.y}%;
    opacity: 0;
    transition: opacity var(--anim-dur) var(--anim-ease), transform var(--anim-dur) var(--anim-ease), filter var(--anim-dur) var(--anim-ease);
  }
  .lower-third.visible { opacity: 1; }

  /* ── Animation variants ── */

  /* Slide */
  .lower-third.anim-slide { transform: translateX(-100px); }
  .lower-third.anim-slide.visible { transform: translateX(0); transition: opacity calc(var(--anim-dur) * 0.6) ease, transform var(--anim-dur) cubic-bezier(0.22, 1, 0.36, 1); }

  /* Fade */
  .lower-third.anim-fade { transform: none; }

  /* Zoom */
  .lower-third.anim-zoom { transform: scale(0.3); }
  .lower-third.anim-zoom.visible { transform: scale(1); transition: opacity calc(var(--anim-dur) * 0.5) ease, transform var(--anim-dur) cubic-bezier(0.34, 1.56, 0.64, 1); }

  /* Rise */
  .lower-third.anim-rise { transform: translateY(60px); }
  .lower-third.anim-rise.visible { transform: translateY(0); transition: opacity calc(var(--anim-dur) * 0.5) ease, transform var(--anim-dur) cubic-bezier(0.22, 1, 0.36, 1); }

  /* Typewriter — JS-driven character reveal */
  .lower-third.anim-typewriter { transform: none; }
  .lower-third.anim-typewriter .lt-cursor {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: #667eea;
    margin-left: 2px;
    vertical-align: text-bottom;
    animation: cursor-blink 0.6s step-end infinite;
  }
  @keyframes cursor-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  /* Bounce — drop in from top */
  .lower-third.anim-bounce { transform: translateY(-80px); }
  .lower-third.anim-bounce.visible { transform: translateY(0); transition: opacity calc(var(--anim-dur) * 0.3) ease, transform var(--anim-dur) cubic-bezier(0.34, 1.56, 0.64, 1); }

  /* Split — expand from center */
  .lower-third.anim-split { transform: scaleX(0); transform-origin: center; }
  .lower-third.anim-split.visible { transform: scaleX(1); transition: opacity calc(var(--anim-dur) * 0.4) ease, transform var(--anim-dur) cubic-bezier(0.22, 1, 0.36, 1); }

  /* Blur — focus in */
  .lower-third.anim-blur { filter: blur(20px); transform: scale(1.1); }
  .lower-third.anim-blur.visible { filter: blur(0px); transform: scale(1); }

  /* Sparkle */
  .lower-third.anim-sparkle {
    transform: scale(0.9);
    filter: brightness(1.8) drop-shadow(0 0 0px rgba(255,215,0,0));
  }
  .lower-third.anim-sparkle.visible {
    transform: scale(1);
    filter: brightness(1) drop-shadow(0 0 12px rgba(255,215,0,0.35));
    transition: opacity calc(var(--anim-dur) * 0.5) ease,
                transform var(--anim-dur) cubic-bezier(0.34, 1.56, 0.64, 1),
                filter calc(var(--anim-dur) * 1.2) ease;
  }

  .lt-card {
    background: rgba(30, 30, 46, 0.92);
    border: 1px solid rgba(102, 126, 234, 0.4);
    border-radius: 10px; padding: 20px 30px;
    backdrop-filter: blur(10px); min-width: 500px;
  }
  .lt-top { display: flex; align-items: center; gap: 16px; }
  .lt-number {
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: white; font-weight: 700; font-size: 36px;
    padding: 6px 16px; border-radius: 8px; flex-shrink: 0;
  }
  .lt-number::before { content: '#'; opacity: 0.6; font-size: 22px; }
  .lt-title { font-size: 33px; font-weight: 700; color: #e0e0f0; }
  .lt-dancers { font-size: 21px; color: #a5b4fc; margin-top: 4px; }
  .lt-meta { font-size: 18px; color: #9090b0; margin-top: 8px; }

  /* ── Starting Soon Scene ── */
  .starting-soon {
    position: absolute;
    top: 0; left: 0; width: 100%; height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(30, 30, 46, 0.95);
    opacity: 0;
    transition: opacity 0.8s ease;
    z-index: 50;
    text-align: center;
  }
  .starting-soon.visible { opacity: 1; }
  .ss-title {
    font-size: 72px;
    font-weight: 700;
    color: #e0e0f0;
    letter-spacing: 2px;
    margin-bottom: 16px;
  }
  .ss-subtitle {
    font-size: 28px;
    font-weight: 400;
    color: #e0e0f0;
    opacity: 0.8;
    margin-bottom: 40px;
  }
  .ss-countdown {
    font-size: 96px;
    font-weight: 300;
    color: #667eea;
    font-variant-numeric: tabular-nums;
    letter-spacing: 4px;
    opacity: 0;
    transition: opacity 0.5s ease;
  }
  .ss-countdown.active { opacity: 1; }
  .ss-accent-line {
    width: 120px;
    height: 4px;
    background: #667eea;
    border-radius: 2px;
    margin: 24px auto;
  }

  /* ── Ticker / Crawl ── */
  .ticker-bar {
    position: absolute;
    bottom: 0; left: 0;
    width: 100%;
    height: 40px;
    overflow: hidden;
    opacity: 0;
    transition: opacity 0.4s ease;
    display: flex;
    align-items: center;
    z-index: 40;
  }
  .ticker-bar.visible { opacity: 1; }
  .ticker-text {
    position: absolute;
    white-space: nowrap;
    font-size: 18px;
    font-weight: 500;
    animation: ticker-scroll linear infinite;
    animation-play-state: paused;
  }
  .ticker-bar.visible .ticker-text {
    animation-play-state: running;
  }
  @keyframes ticker-scroll {
    0% { transform: translateX(100vw); }
    100% { transform: translateX(-100%); }
  }
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
<div class="clock" id="clock"><div class="clock-box"><div class="clock-time" id="clockTime"></div><div class="clock-date" id="clockDate"></div></div></div>

<div id="ticker" class="ticker-bar">
  <span id="ticker-text" class="ticker-text"></span>
</div>

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

<div id="starting-soon" class="starting-soon">
  <div class="ss-title" id="ss-title"></div>
  <div class="ss-accent-line" id="ss-accent"></div>
  <div class="ss-subtitle" id="ss-subtitle"></div>
  <div class="ss-countdown" id="ss-countdown"></div>
</div>

<script>
  const WS_URL = 'ws://localhost:9877';
  const LT_ANIMS = ['anim-slide','anim-zoom','anim-fade','anim-rise','anim-sparkle','anim-typewriter','anim-bounce','anim-split','anim-blur'];
  let ws = null;
  let reconnectDelay = 1000;
  let lastCounterEntry = '';
  let currentAnim = '';
  let typewriterTimer = null;
  let countdownInterval = null;

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

  function clearTypewriter() {
    if (typewriterTimer) { clearInterval(typewriterTimer); typewriterTimer = null; }
    var cursors = document.querySelectorAll('.lt-cursor');
    cursors.forEach(function(c) { c.remove(); });
  }

  function applyState(state) {
    const o = state.overlay;
    if (state.overlayLayout) {
      var L = state.overlayLayout;
      var ce = document.getElementById('counter');
      ce.style.left = L.counter.x + '%'; ce.style.top = L.counter.y + '%'; ce.style.right = 'auto';
      var le = document.getElementById('logo');
      le.style.left = L.logo.x + '%'; le.style.top = L.logo.y + '%';
      var ke = document.getElementById('clock');
      ke.style.left = L.clock.x + '%'; ke.style.top = L.clock.y + '%'; ke.style.right = 'auto';
      var te = document.getElementById('lt');
      te.style.left = L.lowerThird.x + '%'; te.style.top = L.lowerThird.y + '%'; te.style.bottom = 'auto';
    }
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
      counterLabel.textContent = o.counter.entryNumber;
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

    // Clear typewriter before applying new state
    clearTypewriter();

    // Animation timing from animConfig
    var durVal = (o.animConfig && o.animConfig.animationDuration) || 0.5;
    var dur = durVal + 's';
    var easingMap = { ease:'ease', 'ease-in':'ease-in', 'ease-out':'ease-out', 'ease-in-out':'ease-in-out', linear:'linear', bounce:'cubic-bezier(0.34,1.56,0.64,1)', elastic:'cubic-bezier(0.68,-0.55,0.27,1.55)' };
    var ease = easingMap[(o.animConfig && o.animConfig.animationEasing)] || 'ease';

    const ltEl = document.getElementById('lt');
    ltEl.style.setProperty('--anim-dur', dur);
    ltEl.style.setProperty('--anim-ease', ease);

    if (o.lowerThird.visible) {
      if (!currentAnim) {
        var anim = o.lowerThird.animation || 'random';
        if (anim === 'random') {
          currentAnim = LT_ANIMS[Math.floor(Math.random() * LT_ANIMS.length)];
        } else {
          currentAnim = 'anim-' + anim;
        }
        LT_ANIMS.forEach(a => ltEl.classList.remove(a));
        ltEl.classList.add(currentAnim);
      }

      // Set text (typewriter overrides when visible)
      var ltTitle = document.getElementById('ltTitle');
      var ltDancers = document.getElementById('ltDancers');
      if (currentAnim !== 'anim-typewriter') {
        ltTitle.textContent = o.lowerThird.routineTitle;
        ltDancers.textContent = o.lowerThird.dancers;
      }

      requestAnimationFrame(function() {
        ltEl.classList.add('visible');

        // Typewriter: character-by-character reveal
        if (currentAnim === 'anim-typewriter') {
          var fullTitle = o.lowerThird.routineTitle || '';
          var fullDancers = o.lowerThird.dancers || '';
          var total = fullTitle.length + fullDancers.length;
          if (total === 0) { ltTitle.textContent = ''; ltDancers.textContent = ''; return; }

          ltTitle.textContent = '';
          ltDancers.textContent = '';
          var charDelay = Math.max(20, (durVal * 1000) / total);
          var idx = 0;

          var cursor = document.createElement('span');
          cursor.className = 'lt-cursor';
          ltTitle.appendChild(cursor);

          typewriterTimer = setInterval(function() {
            if (idx < fullTitle.length) {
              ltTitle.textContent = fullTitle.substring(0, idx + 1);
              ltTitle.appendChild(cursor);
            } else {
              ltTitle.textContent = fullTitle;
              var si = idx - fullTitle.length;
              ltDancers.textContent = fullDancers.substring(0, si + 1);
              ltDancers.appendChild(cursor);
            }
            idx++;
            if (idx >= total) {
              clearInterval(typewriterTimer);
              typewriterTimer = null;
              ltTitle.textContent = fullTitle;
              ltDancers.textContent = fullDancers;
              setTimeout(function() { cursor.remove(); }, 800);
            }
          }, charDelay);
        }
      });

      var ltNum = document.getElementById('ltNumber');
      var ltMeta = document.getElementById('ltMeta');
      ltNum.textContent = o.lowerThird.entryNumber;
      ltNum.style.display = o.lowerThird.showEntryNumber === false ? 'none' : '';
      if (currentAnim !== 'anim-typewriter') {
        ltTitle.style.display = o.lowerThird.showRoutineTitle === false ? 'none' : '';
        ltDancers.style.display = o.lowerThird.showDancers === false ? 'none' : '';
      }
      var metaParts = [];
      if (o.lowerThird.showStudioName !== false) metaParts.push(o.lowerThird.studioName);
      if (o.lowerThird.showCategory !== false) metaParts.push(o.lowerThird.category);
      ltMeta.textContent = metaParts.filter(Boolean).join(' \\u2014 ');
      ltMeta.style.display = metaParts.length === 0 ? 'none' : '';
    } else {
      ltEl.classList.remove('visible');
      if (currentAnim) {
        setTimeout(() => { ltEl.classList.remove(currentAnim); currentAnim = ''; }, 600);
      }
    }

    // Ticker
    if (o.ticker) {
      var tickerEl = document.getElementById('ticker');
      var tickerText = document.getElementById('ticker-text');
      tickerText.textContent = o.ticker.text || '';
      tickerEl.style.background = o.ticker.backgroundColor || '#1e1e2e';
      tickerText.style.color = o.ticker.textColor || '#e0e0f0';
      var speed = o.ticker.speed || 60;
      var duration = Math.max(10, 1920 / speed * 2);
      tickerText.style.animationDuration = duration + 's';
      tickerEl.classList.toggle('visible', o.ticker.visible);
    }

    // Starting Soon
    if (o.startingSoon) {
      applyStartingSoon(o.startingSoon);
    }
  }

  function applyStartingSoon(ss) {
    var ssEl = document.getElementById('starting-soon');
    var ssTitleEl = document.getElementById('ss-title');
    var ssSubEl = document.getElementById('ss-subtitle');
    var ssCountEl = document.getElementById('ss-countdown');

    if (!ss) { ssEl.classList.remove('visible'); return; }

    ssTitleEl.textContent = ss.title || '';
    ssSubEl.textContent = ss.subtitle || '';

    if (ss.visible) {
      ssEl.classList.add('visible');
    } else {
      ssEl.classList.remove('visible');
    }

    // Countdown
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (ss.visible && ss.showCountdown && ss.countdownTarget) {
      ssCountEl.classList.add('active');
      function updateCountdown() {
        var target = new Date(ss.countdownTarget).getTime();
        var now = Date.now();
        var diff = Math.max(0, target - now);
        if (diff <= 0) {
          ssCountEl.textContent = '00:00';
          if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
          return;
        }
        var h = Math.floor(diff / 3600000);
        var m = Math.floor((diff % 3600000) / 60000);
        var s = Math.floor((diff % 60000) / 1000);
        if (h > 0) {
          ssCountEl.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        } else {
          ssCountEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        }
      }
      updateCountdown();
      countdownInterval = setInterval(updateCountdown, 1000);
    } else {
      ssCountEl.classList.remove('active');
      ssCountEl.textContent = '';
    }
  }

  function updateClock() {
    const now = new Date();
    const h = now.getHours();
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    document.getElementById('clockTime').textContent = h12 + ':' + m + ':' + s + ' ' + ampm;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    document.getElementById('clockDate').textContent = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate();
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ── Preview mode ──
  var isPreview = new URLSearchParams(window.location.search).has('preview');
  var previewOverrides = {}; // element -> boolean (true=visible, false=hidden)

  if (isPreview) {
    // Force all elements visible on first load
    ['counter', 'clock', 'logo', 'lt'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('visible');
    });
    // Set placeholder content so elements are visible
    var cn = document.getElementById('counterNumber');
    var cl = document.getElementById('counterLabel');
    if (cn && !cn.textContent) cn.textContent = '1';
    if (cl && !cl.textContent) cl.textContent = '1';
    var ct = document.getElementById('clockTime');
    if (ct && !ct.textContent) updateClock();
    var ltT = document.getElementById('ltTitle');
    var ltD = document.getElementById('ltDancers');
    var ltN = document.getElementById('ltNumber');
    if (ltT && !ltT.textContent) ltT.textContent = 'Routine Title';
    if (ltD && !ltD.textContent) ltD.textContent = 'Dancer Names';
    if (ltN && !ltN.textContent) ltN.textContent = '1';
    // Track initial preview state
    previewOverrides = { counter: true, clock: true, logo: true, lt: true };
  }

  // Listen for postMessage from parent (VisualEditor)
  window.addEventListener('message', function(event) {
    if (!event.data || event.data.type !== 'preview-toggle') return;
    var elMap = { counter: 'counter', clock: 'clock', logo: 'logo', lowerThird: 'lt' };
    var elId = elMap[event.data.element];
    if (!elId) return;
    var el = document.getElementById(elId);
    if (!el) return;
    previewOverrides[elId] = event.data.visible;
    if (event.data.visible) {
      el.classList.add('visible');
    } else {
      el.classList.remove('visible');
    }
  });

  // Wrap applyState to respect preview overrides
  var _origApplyState = applyState;
  applyState = function(state) {
    _origApplyState(state);
    if (isPreview) {
      Object.keys(previewOverrides).forEach(function(elId) {
        var el = document.getElementById(elId);
        if (!el) return;
        if (previewOverrides[elId]) {
          el.classList.add('visible');
        } else {
          el.classList.remove('visible');
        }
      });
    }
  };

  connect();
</script>
</body>
</html>`
}
