import express from 'express'
import http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { OverlayState, OverlayLayout, DEFAULT_LAYOUT, TickerState, StartingSoonState, AnimationConfig, StartingSoonConfig, StartingSoonPreset, StartingSoonLayout, GradientConfig, SSElementPosition, TimeDateConfig, CountdownStyleConfig, VideoPlaylistConfig, PhotoSlideshowConfig, SocialBarConfig, SponsorCarouselConfig, VisualizerConfig, EventInfoConfig } from '../../shared/types'
import { getSettings } from './settings'
import { logger } from '../logger'
import { setupMediaRoutes, setVideoFolder, setPhotoFolder, setSponsorFolder } from './startingSoonMedia'

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

// --- Starting Soon Config State ---
const defaultSSConfig: StartingSoonConfig = {
  gradient: {
    preset: 'midnight-pulse',
    speed: 5,
    angle: 45,
  },
  layout: {
    logo: { x: 85, y: 5, width: 10, height: 8, visible: true },
    title: { x: 50, y: 30, width: 40, height: 10, visible: true },
    subtitle: { x: 50, y: 42, width: 40, height: 8, visible: true },
    countdown: { x: 50, y: 55, width: 20, height: 15, visible: true },
    timeDate: { x: 95, y: 2, width: 5, height: 5, visible: true },
    videoPlaylist: { x: 5, y: 55, width: 30, height: 30, visible: false },
    photoSlideshow: { x: 40, y: 55, width: 30, height: 30, visible: false },
    ticker: { x: 50, y: 95, width: 40, height: 3, visible: false },
    socialBar: { x: 50, y: 85, width: 40, height: 5, visible: false },
    sponsorCarousel: { x: 50, y: 2, width: 40, height: 4, visible: false },
    visualizer: { x: 10, y: 70, width: 20, height: 20, visible: false },
    eventCard: { x: 5, y: 5, width: 20, height: 20, visible: false },
    upNext: { x: 5, y: 30, width: 30, height: 50, visible: false },
    pinnedChat: { x: 65, y: 30, width: 30, height: 40, visible: false },
  },
  title: 'Starting Soon',
  titleFontSize: 72,
  titleColor: '#ffffff',
  titleFont: '',
  subtitle: '',
  subtitleFontSize: 36,
  subtitleColor: '#cccccc',
  subtitleFont: '',
  showCountdown: true,
  countdownTarget: '',
  countdownStyle: {
    fontSize: 64,
    color: '#ff4444',
    fontWeight: 700,
    showLabels: true,
  },
  timeDate: {
    enabled: true,
    format: '12h',
    showDate: false,
    showSeconds: true,
    fontSize: 24,
    color: '#ffffff',
  },
  videoPlaylist: {
    enabled: false,
    folderPath: '',
    fileList: [],
    loop: true,
    muted: false,
    shuffled: false,
  },
  photoSlideshow: {
    enabled: false,
    folderPath: '',
    fileList: [],
    intervalSeconds: 5,
    transitionType: 'crossfade',
    transitionDuration: 1000,
  },
  socialBar: {
    enabled: false,
    handles: [],
    position: 'bottom',
    style: 'icons-and-text',
  },
  sponsorCarousel: {
    enabled: false,
    folderPath: '',
    logoFiles: [],
    intervalSeconds: 3,
    transitionType: 'fade',
  },
  visualizer: {
    enabled: false,
    barCount: 32,
    colorStart: '#ff4444',
    colorEnd: '#ffaa00',
    style: 'bars',
  },
  eventInfo: {
    enabled: false,
    showCompetitionName: true,
    showVenue: true,
    showDate: true,
    customFields: [],
  },
  upNext: {
    enabled: false,
    count: 5,
    showDancers: true,
    showStudio: true,
    showCategory: false,
  },
  pinnedChat: {
    enabled: false,
    maxVisible: 3,
    rotateIntervalSec: 8,
    showTimestamps: false,
  },
  tickerEnabled: false,
}

let startingSoonConfig: StartingSoonConfig = { ...defaultSSConfig }
let ssPresets: StartingSoonPreset[] = []

let onStateChange: (() => void) | null = null

export function setOnStateChange(cb: () => void): void {
  onStateChange = cb
}

function notifyChange(): void {
  if (onStateChange) onStateChange()
}

// --- Starting Soon Config Persistence ---

function getSSConfigPath(): string {
  return path.join(app.getPath('userData'), 'starting-soon-config.json')
}

function getSSPresetsPath(): string {
  return path.join(app.getPath('userData'), 'starting-soon-presets.json')
}

function saveSSConfig(): void {
  try {
    const config = {
      ...startingSoonConfig,
      countdownTarget: '', // don't persist countdown target
    }
    fs.writeFileSync(getSSConfigPath(), JSON.stringify(config, null, 2))
  } catch (_err) { /* ignore persistence errors */ }
}

function loadSSConfig(): void {
  try {
    const configPath = getSSConfigPath()
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      startingSoonConfig = { ...defaultSSConfig, ...data }
      logger.app.info('Starting soon config loaded from disk')
    } else {
      // Create default config file on first load
      saveSSConfig()
      logger.app.info('Starting soon config initialized with defaults')
    }
  } catch (_err) { /* ignore load errors */ }
}

function saveSSPresets(): void {
  try {
    fs.writeFileSync(getSSPresetsPath(), JSON.stringify(ssPresets, null, 2))
  } catch (_err) { /* ignore persistence errors */ }
}

function loadSSPresets(): void {
  try {
    const presetsPath = getSSPresetsPath()
    if (fs.existsSync(presetsPath)) {
      const data = JSON.parse(fs.readFileSync(presetsPath, 'utf-8'))
      if (Array.isArray(data)) {
        ssPresets = data
        logger.app.info(`Loaded ${ssPresets.length} starting soon presets`)
      }
    }
  } catch (_err) { /* ignore load errors */ }
}

function seedDefaultPresets(): void {
  const makeConfig = (overrides: Partial<StartingSoonConfig>): StartingSoonConfig => ({
    ...defaultSSConfig,
    ...overrides,
    layout: { ...defaultSSConfig.layout, ...(overrides.layout || {}) },
    gradient: { ...defaultSSConfig.gradient, ...(overrides.gradient || {}) },
    countdownStyle: { ...defaultSSConfig.countdownStyle, ...(overrides.countdownStyle || {}) },
    timeDate: { ...defaultSSConfig.timeDate, ...(overrides.timeDate || {}) },
    socialBar: { ...defaultSSConfig.socialBar, ...(overrides.socialBar || {}) },
    sponsorCarousel: { ...defaultSSConfig.sponsorCarousel, ...(overrides.sponsorCarousel || {}) },
    visualizer: { ...defaultSSConfig.visualizer, ...(overrides.visualizer || {}) },
    eventInfo: { ...defaultSSConfig.eventInfo, ...(overrides.eventInfo || {}) },
    videoPlaylist: { ...defaultSSConfig.videoPlaylist, ...(overrides.videoPlaylist || {}) },
    photoSlideshow: { ...defaultSSConfig.photoSlideshow, ...(overrides.photoSlideshow || {}) },
    upNext: { ...defaultSSConfig.upNext, ...(overrides.upNext || {}) },
  })

  ssPresets = [
    {
      id: 'default-dark-elegant',
      name: 'Dark Elegant',
      createdAt: new Date().toISOString(),
      config: makeConfig({
        gradient: { preset: 'midnight-pulse', speed: 3, angle: 45 },
        title: 'Starting Soon',
        titleFontSize: 72,
        titleColor: '#ffffff',
        titleFont: 'Playfair Display',
        subtitle: '',
        subtitleFontSize: 24,
        subtitleColor: '#cccccc',
        subtitleFont: '',
        showCountdown: true,
        countdownStyle: { fontSize: 96, color: '#ffffff', fontWeight: 700, showLabels: true },
        layout: {
          ...defaultSSConfig.layout,
          logo: { ...defaultSSConfig.layout.logo, visible: true },
          title: { ...defaultSSConfig.layout.title, visible: true },
          subtitle: { ...defaultSSConfig.layout.subtitle, visible: false },
          countdown: { ...defaultSSConfig.layout.countdown, visible: true },
          timeDate: { ...defaultSSConfig.layout.timeDate, visible: false },
          ticker: { ...defaultSSConfig.layout.ticker, visible: false },
          socialBar: { ...defaultSSConfig.layout.socialBar, visible: false },
          sponsorCarousel: { ...defaultSSConfig.layout.sponsorCarousel, visible: false },
          visualizer: { ...defaultSSConfig.layout.visualizer, visible: false },
          eventCard: { ...defaultSSConfig.layout.eventCard, visible: false },
          videoPlaylist: { ...defaultSSConfig.layout.videoPlaylist, visible: false },
          photoSlideshow: { ...defaultSSConfig.layout.photoSlideshow, visible: false },
          upNext: { ...defaultSSConfig.layout.upNext, visible: false },
        },
        tickerEnabled: false,
      }),
    },
    {
      id: 'default-bright-fun',
      name: 'Bright & Fun',
      createdAt: new Date().toISOString(),
      config: makeConfig({
        gradient: { preset: 'sunset-drift', speed: 5, angle: 135 },
        title: 'Starting Soon!',
        titleFontSize: 84,
        titleColor: '#ffffff',
        titleFont: 'Poppins',
        subtitle: 'Get ready for the show',
        subtitleFontSize: 36,
        subtitleColor: '#ffffff',
        subtitleFont: '',
        showCountdown: true,
        countdownStyle: { fontSize: 72, color: '#ffffff', fontWeight: 700, showLabels: true },
        timeDate: { enabled: true, format: '12h', showDate: true, showSeconds: false, fontSize: 24, color: '#ffffff' },
        socialBar: { enabled: true, handles: [], position: 'bottom', style: 'icons-and-text' },
        tickerEnabled: true,
        layout: {
          ...defaultSSConfig.layout,
          logo: { ...defaultSSConfig.layout.logo, visible: true },
          title: { ...defaultSSConfig.layout.title, visible: true },
          subtitle: { ...defaultSSConfig.layout.subtitle, visible: true },
          countdown: { ...defaultSSConfig.layout.countdown, visible: true },
          timeDate: { ...defaultSSConfig.layout.timeDate, visible: true },
          ticker: { ...defaultSSConfig.layout.ticker, visible: true },
          socialBar: { ...defaultSSConfig.layout.socialBar, visible: true },
          sponsorCarousel: { ...defaultSSConfig.layout.sponsorCarousel, visible: false },
          visualizer: { ...defaultSSConfig.layout.visualizer, visible: false },
          eventCard: { ...defaultSSConfig.layout.eventCard, visible: false },
          videoPlaylist: { ...defaultSSConfig.layout.videoPlaylist, visible: false },
          photoSlideshow: { ...defaultSSConfig.layout.photoSlideshow, visible: false },
        },
      }),
    },
    {
      id: 'default-minimal',
      name: 'Minimal',
      createdAt: new Date().toISOString(),
      config: makeConfig({
        gradient: { preset: 'monochrome-shift', speed: 2, angle: 45 },
        title: 'Starting Soon',
        titleFontSize: 48,
        titleColor: '#ffffff',
        titleFont: 'Inter',
        subtitle: '',
        subtitleFontSize: 24,
        subtitleColor: '#cccccc',
        subtitleFont: '',
        showCountdown: true,
        countdownStyle: { fontSize: 64, color: '#ffffff', fontWeight: 300, showLabels: false },
        layout: {
          ...defaultSSConfig.layout,
          logo: { ...defaultSSConfig.layout.logo, visible: false },
          title: { ...defaultSSConfig.layout.title, visible: true },
          subtitle: { ...defaultSSConfig.layout.subtitle, visible: false },
          countdown: { ...defaultSSConfig.layout.countdown, visible: true },
          timeDate: { ...defaultSSConfig.layout.timeDate, visible: false },
          ticker: { ...defaultSSConfig.layout.ticker, visible: false },
          socialBar: { ...defaultSSConfig.layout.socialBar, visible: false },
          sponsorCarousel: { ...defaultSSConfig.layout.sponsorCarousel, visible: false },
          visualizer: { ...defaultSSConfig.layout.visualizer, visible: false },
          eventCard: { ...defaultSSConfig.layout.eventCard, visible: false },
          videoPlaylist: { ...defaultSSConfig.layout.videoPlaylist, visible: false },
          photoSlideshow: { ...defaultSSConfig.layout.photoSlideshow, visible: false },
          upNext: { ...defaultSSConfig.layout.upNext, visible: false },
        },
        tickerEnabled: false,
      }),
    },
  ]
  saveSSPresets()
  logger.app.info('Seeded 3 default starting soon presets')
}

// --- Starting Soon Config Accessors ---

export function getSSConfig(): StartingSoonConfig {
  return { ...startingSoonConfig }
}

export function setSSConfig(updates: Partial<StartingSoonConfig>): StartingSoonConfig {
  startingSoonConfig = { ...startingSoonConfig, ...updates }
  saveSSConfig()
  // Update media folder paths when they change
  if (startingSoonConfig.videoPlaylist?.folderPath) {
    setVideoFolder(startingSoonConfig.videoPlaylist.folderPath)
  }
  if (startingSoonConfig.photoSlideshow?.folderPath) {
    setPhotoFolder(startingSoonConfig.photoSlideshow.folderPath)
  }
  if (startingSoonConfig.sponsorCarousel?.folderPath) {
    setSponsorFolder(startingSoonConfig.sponsorCarousel.folderPath)
  }
  logger.app.info('Starting soon config updated')
  notifyChange()
  return getSSConfig()
}

export function getSSPresets(): StartingSoonPreset[] {
  return [...ssPresets]
}

export function saveSSPreset(preset: StartingSoonPreset): StartingSoonPreset[] {
  // Check if preset with same name exists
  const existingIndex = ssPresets.findIndex(p => p.name === preset.name)
  if (existingIndex >= 0) {
    ssPresets[existingIndex] = preset
  } else {
    ssPresets.push(preset)
  }
  saveSSPresets()
  logger.app.info(`Starting soon preset saved: ${preset.name}`)
  return getSSPresets()
}

export function deleteSSPreset(id: string): StartingSoonPreset[] {
  const index = ssPresets.findIndex(p => p.id === id)
  if (index >= 0) {
    ssPresets.splice(index, 1)
    saveSSPresets()
    logger.app.info(`Starting soon preset deleted: ${id}`)
  }
  return getSSPresets()
}

export function loadSSPreset(id: string): StartingSoonConfig | null {
  const preset = ssPresets.find(p => p.id === id)
  if (preset) {
    startingSoonConfig = { ...preset.config }
    saveSSConfig()
    logger.app.info(`Starting soon preset loaded: ${preset.name}`)
    notifyChange()
    return getSSConfig()
  }
  return null
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
  // Attach current ssConfig to startingSoon for overlay iframe rendering
  return {
    ...overlayState,
    startingSoon: {
      ...overlayState.startingSoon,
      config: startingSoonConfig,
    },
  }
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
  logger.app.info(`Overlay: routine data updated → #${data.entryNumber} "${data.routineTitle}"`)
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
  loadSSConfig()
  loadSSPresets()
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
  // Initialize media folders from persisted SS config
  if (startingSoonConfig.videoPlaylist?.folderPath) {
    setVideoFolder(startingSoonConfig.videoPlaylist.folderPath)
  }
  if (startingSoonConfig.photoSlideshow?.folderPath) {
    setPhotoFolder(startingSoonConfig.photoSlideshow.folderPath)
  }
  if (startingSoonConfig.sponsorCarousel?.folderPath) {
    setSponsorFolder(startingSoonConfig.sponsorCarousel.folderPath)
  }
  // Seed default presets on first run
  if (ssPresets.length === 0) {
    seedDefaultPresets()
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

  // Starting Soon media routes (video/photo serving)
  setupMediaRoutes(app)

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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Roboto:wght@400;700&family=Poppins:wght@400;700&family=Montserrat:wght@400;700&family=Playfair+Display:wght@400;700&family=Bebas+Neue&family=Oswald:wght@400;700&family=Lato:wght@400;700&family=Open+Sans:wght@400;700&family=Raleway:wght@400;700&family=Anton&family=Archivo+Black&family=Space+Grotesk:wght@400;700&family=DM+Sans:wght@400;700&display=swap" rel="stylesheet">
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
    background: rgba(30, 30, 46, 0.95);
    opacity: 0;
    transition: opacity 0.8s ease;
    z-index: 50;
  }
  .starting-soon.visible { opacity: 1; }
  .ss-title {
    position: absolute;
    display: none;
    font-weight: 700;
    color: #e0e0f0;
    letter-spacing: 2px;
    text-align: center;
    white-space: nowrap;
    transform: translate(-50%, -50%);
  }
  .ss-subtitle {
    position: absolute;
    display: none;
    font-weight: 400;
    color: #e0e0f0;
    opacity: 0.8;
    text-align: center;
    white-space: nowrap;
    transform: translate(-50%, -50%);
  }
  .ss-countdown {
    position: absolute;
    display: none;
    font-weight: 300;
    color: #667eea;
    font-variant-numeric: tabular-nums;
    letter-spacing: 4px;
    text-align: center;
    white-space: nowrap;
    transform: translate(-50%, -50%);
  }
  .ss-accent-line {
    display: none;
  }
  .ss-logo {
    position: absolute;
    display: none;
  }
  .ss-logo img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .ss-time-date {
    position: absolute;
    display: none;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* ── Gradient Background ── */
  .ss-gradient-bg {
    position: absolute;
    inset: 0;
    z-index: 0;
    background-size: 400% 400%;
    animation: gradient-shift var(--gradient-speed, 15s) ease infinite;
  }
  @keyframes gradient-shift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  .starting-soon > *:not(.ss-gradient-bg) { position: relative; z-index: 1; }

  /* ── Video Playlist Window ── */
  .ss-video-window {
    position: absolute;
    overflow: hidden;
    z-index: 1;
  }
  .ss-video-window.ss-placeholder {
    border: 2px dashed rgba(102, 126, 234, 0.5);
    background: rgba(15, 15, 25, 0.55);
    display: flex !important;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
  }
  .ss-video-window.ss-placeholder video { display: none; }
  .ss-placeholder-label {
    font-size: 16px;
    font-weight: 500;
    color: rgba(200, 210, 255, 0.7);
    letter-spacing: 0.5px;
    text-align: center;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ss-placeholder-label svg {
    opacity: 0.75;
    flex-shrink: 0;
  }

  /* ── Photo Slideshow ── */
  .ss-photo-slideshow {
    position: absolute;
    overflow: hidden;
    z-index: 1;
  }
  .ss-photo-slideshow.ss-placeholder {
    border: 2px dashed rgba(102, 126, 234, 0.5);
    background: rgba(15, 15, 25, 0.55);
    display: flex !important;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
  }
  .ss-photo-slideshow.ss-placeholder .ss-slide { display: none; }

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

  /* ── Social Media Bar ── */
  .ss-social-bar {
    position: absolute;
    display: none;
    gap: 24px;
    align-items: center;
    justify-content: center;
    z-index: 2;
    white-space: nowrap;
  }
  .ss-social-bar.visible { display: flex; }
  .ss-social-bar.vertical { flex-direction: column; gap: 16px; }
  .ss-social-item {
    display: flex;
    align-items: center;
    gap: 8px;
    color: rgba(255,255,255,0.9);
    font-size: 18px;
    font-weight: 500;
  }
  .ss-social-item svg {
    flex-shrink: 0;
  }

  /* ── Event Info Card ── */
  .ss-event-card {
    position: absolute;
    display: none;
    z-index: 2;
  }
  .ss-event-card.visible { display: block; }
  .ss-event-card-inner {
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(12px);
    border-radius: 12px;
    padding: 20px 28px;
    border: 1px solid rgba(255,255,255,0.12);
    min-width: 200px;
  }
  .ss-event-field {
    color: rgba(255,255,255,0.9);
    font-size: 18px;
    margin-bottom: 8px;
    line-height: 1.4;
  }
  .ss-event-field:last-child { margin-bottom: 0; }
  .ss-event-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: rgba(255,255,255,0.5);
    margin-bottom: 2px;
  }
  .ss-event-value {
    font-size: 18px;
    font-weight: 600;
    color: rgba(255,255,255,0.95);
  }

  /* ── Sponsor Logo Carousel ── */
  .ss-sponsor-carousel {
    position: absolute;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .ss-sponsor-carousel img {
    position: absolute;
    max-height: 60px;
    width: auto;
    object-fit: contain;
    opacity: 0;
    transition: opacity 0.8s ease;
  }
  .ss-sponsor-carousel img.active {
    opacity: 1;
  }

  /* ── Music Visualizer ── */
  .ss-up-next {
    position: absolute;
    background: rgba(0,0,0,0.55);
    border-radius: 12px;
    padding: 16px 20px;
    backdrop-filter: blur(8px);
    display: none;
    overflow: hidden;
  }
  .ss-up-next.visible { display: block; }
  .ss-up-next-header {
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: rgba(255,255,255,0.6);
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255,255,255,0.15);
  }
  .ss-up-next-item {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    opacity: 0;
    animation: ssUpNextFadeIn 0.5s ease forwards;
  }
  .ss-up-next-item:last-child { border-bottom: none; }
  .ss-up-next-num {
    font-size: 13px;
    font-weight: 700;
    color: rgba(255,255,255,0.5);
    min-width: 28px;
    text-align: right;
  }
  .ss-up-next-info { flex: 1; min-width: 0; }
  .ss-up-next-title {
    font-size: 16px;
    font-weight: 600;
    color: #ffffff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ss-up-next-detail {
    font-size: 12px;
    color: rgba(255,255,255,0.55);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @keyframes ssUpNextFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .ss-visualizer {
    position: absolute;
    z-index: 2;
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    justify-content: center;
    gap: 2px;
  }
  .ss-visualizer .viz-bar {
    flex: 1;
    min-width: 4px;
    max-width: 20px;
    border-radius: 2px 2px 0 0;
    transform-origin: bottom center;
    transition: transform 0.15s ease-out;
  }

  /* ── Pinned Chat Comments ── */
  .ss-pinned-chat {
    position: absolute;
    display: none;
    flex-direction: column;
    gap: 10px;
    overflow: hidden;
    z-index: 2;
  }
  .ss-pinned-chat.visible { display: flex; }
  .ss-chat-bubble {
    background: rgba(30, 30, 46, 0.8);
    border: 1px solid rgba(102, 126, 234, 0.35);
    border-radius: 12px;
    padding: 10px 14px;
    backdrop-filter: blur(8px);
    animation: chatBubbleIn 0.4s ease forwards;
    opacity: 0;
    transform: translateX(20px);
  }
  @keyframes chatBubbleIn {
    to { opacity: 1; transform: translateX(0); }
  }
  .ss-chat-name {
    font-size: 13px;
    font-weight: 700;
    color: #667eea;
    margin-bottom: 3px;
    letter-spacing: 0.3px;
  }
  .ss-chat-text {
    font-size: 15px;
    color: #e0e0f0;
    line-height: 1.4;
    word-wrap: break-word;
  }
  .ss-chat-time {
    font-size: 10px;
    color: #7070a0;
    margin-top: 4px;
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
  <div class="ss-gradient-bg" id="ss-gradient"></div>
  <div class="ss-logo" id="ss-logo"><img id="ss-logo-img" src="" alt="" /></div>
  <div class="ss-title" id="ss-title"></div>
  <div class="ss-accent-line" id="ss-accent"></div>
  <div class="ss-subtitle" id="ss-subtitle"></div>
  <div class="ss-countdown" id="ss-countdown"></div>
  <div class="ss-time-date" id="ss-time-date"></div>
  <div class="ss-video-window" id="ss-video" style="display:none">
    <video id="ss-video-player" muted playsinline autoplay style="width:100%;height:100%;object-fit:cover"></video>
    <div class="ss-placeholder-label" id="ss-video-placeholder" style="display:none">
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="9"/><path d="M9 7.5v7l6-3.5z" fill="currentColor" stroke="none"/></svg>
      <span>Video Playlist (no folder)</span>
    </div>
  </div>
  <div class="ss-photo-slideshow" id="ss-photos" style="display:none">
    <img class="ss-slide ss-slide-front" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:opacity 1s" />
    <img class="ss-slide ss-slide-back" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 1s" />
    <div class="ss-placeholder-label" id="ss-photo-placeholder" style="display:none">
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="16" height="14" rx="2"/><circle cx="8" cy="9" r="1.5" fill="currentColor" stroke="none"/><path d="M19 15l-5-5-8 8"/></svg>
      <span>Photo Slideshow (no folder)</span>
    </div>
  </div>
  <div class="ss-social-bar" id="ss-social"></div>
  <div class="ss-event-card" id="ss-event-card"></div>
  <div class="ss-sponsor-carousel" id="ss-sponsors" style="display:none"></div>
  <div class="ss-up-next" id="ss-up-next"></div>
  <div class="ss-visualizer" id="ss-visualizer" style="display:none"></div>
  <div class="ss-pinned-chat" id="ss-pinned-chat"></div>
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
  let timeDateInterval = null;

  function hexToRgb(hex) {
    var result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 255, g: 0, b: 0 };
  }

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
        if (msg.type === 'audioLevels') applyAudioLevels(msg.levels);
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
      applyStartingSoon(o.startingSoon, state.ssConfig, o.logo ? o.logo.url : '', state);
    }
  }

  function applyStartingSoon(ss, ssCfg, logoUrl, state) {
    var ssEl = document.getElementById('starting-soon');
    var ssTitleEl = document.getElementById('ss-title');
    var ssSubEl = document.getElementById('ss-subtitle');
    var ssCountEl = document.getElementById('ss-countdown');
    var ssLogoEl = document.getElementById('ss-logo');
    var ssLogoImg = document.getElementById('ss-logo-img');
    var ssTimeDateEl = document.getElementById('ss-time-date');

    if (!ss) { ssEl.classList.remove('visible'); return; }

    // Text content: config is source of truth; fall back to transient ss state
    var cfgTitle = (ssCfg && typeof ssCfg.title === 'string') ? ssCfg.title : '';
    var cfgSubtitle = (ssCfg && typeof ssCfg.subtitle === 'string') ? ssCfg.subtitle : '';
    ssTitleEl.textContent = cfgTitle || ss.title || '';
    ssSubEl.textContent = cfgSubtitle || ss.subtitle || '';

    // --- Font resolution (per-element override > brand font > system default) ---
    var fallbackStack = ', -apple-system, system-ui, sans-serif';
    var brandFont = (state && state.branding && state.branding.brandFont) ? state.branding.brandFont : '';
    var cfgTitleFont = (ssCfg && ssCfg.titleFont) ? ssCfg.titleFont : '';
    var cfgSubtitleFont = (ssCfg && ssCfg.subtitleFont) ? ssCfg.subtitleFont : '';
    if (cfgTitleFont) {
      ssTitleEl.style.fontFamily = '"' + cfgTitleFont + '"' + fallbackStack;
    } else if (brandFont) {
      ssTitleEl.style.fontFamily = '"' + brandFont + '"' + fallbackStack;
    } else {
      ssTitleEl.style.fontFamily = '';
    }
    if (cfgSubtitleFont) {
      ssSubEl.style.fontFamily = '"' + cfgSubtitleFont + '"' + fallbackStack;
    } else if (brandFont) {
      ssSubEl.style.fontFamily = '"' + brandFont + '"' + fallbackStack;
    } else {
      ssSubEl.style.fontFamily = '';
    }

    // --- Title layout + styling ---
    if (ssCfg && ssCfg.layout && ssCfg.layout.title && ssCfg.layout.title.visible) {
      var tLayout = ssCfg.layout.title;
      ssTitleEl.style.display = 'block';
      ssTitleEl.style.left = (tLayout.x + tLayout.width / 2) + '%';
      ssTitleEl.style.top = (tLayout.y + tLayout.height / 2) + '%';
      if (ssCfg.titleFontSize) ssTitleEl.style.fontSize = ssCfg.titleFontSize + 'px';
      if (ssCfg.titleColor) ssTitleEl.style.color = ssCfg.titleColor;
    } else {
      ssTitleEl.style.display = 'none';
    }

    // --- Subtitle layout + styling ---
    if (ssCfg && ssCfg.layout && ssCfg.layout.subtitle && ssCfg.layout.subtitle.visible) {
      var stLayout = ssCfg.layout.subtitle;
      ssSubEl.style.display = 'block';
      ssSubEl.style.left = (stLayout.x + stLayout.width / 2) + '%';
      ssSubEl.style.top = (stLayout.y + stLayout.height / 2) + '%';
      if (ssCfg.subtitleFontSize) ssSubEl.style.fontSize = ssCfg.subtitleFontSize + 'px';
      if (ssCfg.subtitleColor) ssSubEl.style.color = ssCfg.subtitleColor;
    } else {
      ssSubEl.style.display = 'none';
    }

    // --- Countdown layout (visibility + position; styling handled below) ---
    var countdownLayoutVisible = !!(ssCfg && ssCfg.layout && ssCfg.layout.countdown && ssCfg.layout.countdown.visible);
    if (countdownLayoutVisible) {
      var cdLayout = ssCfg.layout.countdown;
      ssCountEl.style.display = 'block';
      ssCountEl.style.left = (cdLayout.x + cdLayout.width / 2) + '%';
      ssCountEl.style.top = (cdLayout.y + cdLayout.height / 2) + '%';
    } else {
      ssCountEl.style.display = 'none';
    }

    if (ss.visible) {
      ssEl.classList.add('visible');
    } else {
      ssEl.classList.remove('visible');
    }

    // --- Gradient Background ---
    var gradientEl = document.getElementById('ss-gradient');
    if (gradientEl && ssCfg && ssCfg.gradient) {
      var g = ssCfg.gradient;
      var presetColors = {
        'midnight-pulse': ['#0f0c29','#302b63','#24243e','#667eea'],
        'sunset-drift': ['#f12711','#f5af19','#fc4a1a','#f7b733'],
        'ocean-wave': ['#0077b6','#00b4d8','#023e8a','#48cae4'],
        'aurora': ['#11998e','#38ef7d','#667eea','#764ba2'],
        'ember-glow': ['#1a0000','#8b0000','#ff4500','#1a0000'],
        'monochrome-shift': ['#0a0a0a','#2d2d2d','#4a4a4a','#1a1a1a'],
        'neon-cyber': ['#ff006e','#8338ec','#3a86ff','#ffbe0b'],
        'forest-mist': ['#0b3d0b','#1a7a1a','#2d6a4f','#40916c'],
      };
      var colors;
      if (g.preset === 'brand' && state && state.branding && state.branding.brandColors && state.branding.brandColors.length >= 2) {
        colors = state.branding.brandColors.slice(0, 4);
      } else if (g.preset === 'custom' && g.customColors && g.customColors.length >= 2) {
        colors = g.customColors;
      } else {
        colors = presetColors[g.preset] || ['#667eea','#764ba2'];
      }
      var angle = g.angle || 45;
      var speed = g.speed || 5;
      var duration = Math.max(5, 30 - (speed - 1) * (25 / 9));
      gradientEl.style.background = 'linear-gradient(' + angle + 'deg, ' + colors.join(', ') + ')';
      gradientEl.style.backgroundSize = '400% 400%';
      ssEl.style.setProperty('--gradient-speed', duration + 's');
    }

    // --- Logo ---
    if (ssCfg && ssCfg.layout && ssCfg.layout.logo && ssCfg.layout.logo.visible) {
      var logoLayout = ssCfg.layout.logo;
      ssLogoEl.style.display = 'block';
      ssLogoEl.style.left = logoLayout.x + '%';
      ssLogoEl.style.top = logoLayout.y + '%';
      ssLogoEl.style.width = logoLayout.width + '%';
      ssLogoEl.style.height = logoLayout.height + '%';
      // Use the same logo URL as the main overlay logo
      if (logoUrl) {
        ssLogoImg.src = logoUrl;
      } else {
        ssLogoEl.style.display = 'none';
      }
    } else {
      ssLogoEl.style.display = 'none';
    }

    // --- Countdown styling ---
    if (ssCfg && ssCfg.countdownStyle) {
      var cs = ssCfg.countdownStyle;
      ssCountEl.style.fontSize = cs.fontSize + 'px';
      ssCountEl.style.color = cs.color;
      ssCountEl.style.fontWeight = String(cs.fontWeight);
    }

    // Countdown timer
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (ss.showCountdown && ss.countdownTarget) {
      var showLabels = (ssCfg && ssCfg.countdownStyle) ? ssCfg.countdownStyle.showLabels : false;
      function updateCountdown() {
        var target = new Date(ss.countdownTarget).getTime();
        var now = Date.now();
        var diff = Math.max(0, target - now);
        if (diff <= 0) {
          ssCountEl.textContent = showLabels ? '0h 00m 00s' : '00:00';
          if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
          return;
        }
        var h = Math.floor(diff / 3600000);
        var m = Math.floor((diff % 3600000) / 60000);
        var s = Math.floor((diff % 60000) / 1000);
        if (showLabels) {
          if (h > 0) {
            ssCountEl.textContent = h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
          } else {
            ssCountEl.textContent = m + 'm ' + String(s).padStart(2, '0') + 's';
          }
        } else {
          if (h > 0) {
            ssCountEl.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
          } else {
            ssCountEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
          }
        }
      }
      updateCountdown();
      countdownInterval = setInterval(updateCountdown, 1000);
    } else if (countdownLayoutVisible) {
      // Layout visible but no active timer — show placeholder text
      ssCountEl.textContent = '00:00';
    } else {
      ssCountEl.textContent = '';
    }

    // --- Time & Date ---
    if (timeDateInterval) { clearInterval(timeDateInterval); timeDateInterval = null; }
    if (ssCfg && ssCfg.timeDate && ssCfg.timeDate.enabled && ssCfg.layout && ssCfg.layout.timeDate && ssCfg.layout.timeDate.visible) {
      var tdLayout = ssCfg.layout.timeDate;
      var tdCfg = ssCfg.timeDate;
      ssTimeDateEl.style.display = 'block';
      ssTimeDateEl.style.left = tdLayout.x + '%';
      ssTimeDateEl.style.top = tdLayout.y + '%';
      ssTimeDateEl.style.width = tdLayout.width + '%';
      ssTimeDateEl.style.height = tdLayout.height + '%';
      ssTimeDateEl.style.fontSize = tdCfg.fontSize + 'px';
      ssTimeDateEl.style.color = tdCfg.color;
      ssTimeDateEl.style.textAlign = 'right';

      function updateTimeDate() {
        var now = new Date();
        var h = now.getHours();
        var m = String(now.getMinutes()).padStart(2, '0');
        var s = String(now.getSeconds()).padStart(2, '0');
        var timeStr = '';

        if (tdCfg.format === '24h') {
          timeStr = String(h).padStart(2, '0') + ':' + m;
          if (tdCfg.showSeconds) timeStr += ':' + s;
        } else {
          var ampm = h >= 12 ? 'PM' : 'AM';
          var h12 = h % 12 || 12;
          timeStr = h12 + ':' + m;
          if (tdCfg.showSeconds) timeStr += ':' + s;
          timeStr += ' ' + ampm;
        }

        if (tdCfg.showDate) {
          var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          var dateStr = months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();
          ssTimeDateEl.textContent = dateStr + ' ' + timeStr;
        } else {
          ssTimeDateEl.textContent = timeStr;
        }
      }
      updateTimeDate();
      timeDateInterval = setInterval(updateTimeDate, 1000);
    } else {
      ssTimeDateEl.style.display = 'none';
      ssTimeDateEl.textContent = '';
    }

    // --- Social Media Bar ---
    var ssSocialEl = document.getElementById('ss-social');
    if (ssSocialEl && ssCfg && ssCfg.socialBar && ssCfg.socialBar.enabled && ssCfg.layout && ssCfg.layout.socialBar && ssCfg.layout.socialBar.visible) {
      var sbLayout = ssCfg.layout.socialBar;
      var sbCfg = ssCfg.socialBar;
      ssSocialEl.classList.add('visible');
      ssSocialEl.style.left = sbLayout.x + '%';
      ssSocialEl.style.top = sbLayout.y + '%';
      ssSocialEl.style.width = sbLayout.width + '%';
      ssSocialEl.style.height = sbLayout.height + '%';
      var isVertical = sbCfg.position === 'left' || sbCfg.position === 'right';
      ssSocialEl.classList.toggle('vertical', isVertical);
      var html = '';
      var icons = {
        instagram: '<svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M8 1.44c2.14 0 2.39.01 3.23.05.78.04 1.2.16 1.48.27.37.14.64.32.92.6s.46.55.6.92c.11.28.23.7.27 1.48.04.84.05 1.09.05 3.23s-.01 2.39-.05 3.23c-.04.78-.16 1.2-.27 1.48-.14.37-.32.64-.6.92s-.55.46-.92.6c-.28.11-.7.23-1.48.27-.84.04-1.09.05-3.23.05s-2.39-.01-3.23-.05c-.78-.04-1.2-.16-1.48-.27a2.49 2.49 0 01-.92-.6 2.49 2.49 0 01-.6-.92c-.11-.28-.23-.7-.27-1.48C1.45 10.39 1.44 10.14 1.44 8s.01-2.39.05-3.23c.04-.78.16-1.2.27-1.48.14-.37.32-.64.6-.92s.55-.46.92-.6c.28-.11.7-.23 1.48-.27C5.61 1.45 5.86 1.44 8 1.44M8 0C5.83 0 5.55.01 4.7.05 3.86.09 3.26.22 2.74.42a3.92 3.92 0 00-1.42.92A3.92 3.92 0 00.42 2.74C.22 3.26.09 3.86.05 4.7.01 5.55 0 5.83 0 8s.01 2.45.05 3.3c.04.84.17 1.44.37 1.96.2.54.48.99.92 1.42.43.44.88.72 1.42.92.52.2 1.12.33 1.96.37.85.04 1.13.05 3.3.05s2.45-.01 3.3-.05c.84-.04 1.44-.17 1.96-.37a3.92 3.92 0 001.42-.92c.44-.43.72-.88.92-1.42.2-.52.33-1.12.37-1.96.04-.85.05-1.13.05-3.3s-.01-2.45-.05-3.3c-.04-.84-.17-1.44-.37-1.96a3.92 3.92 0 00-.92-1.42A3.92 3.92 0 0013.26.42C12.74.22 12.14.09 11.3.05 10.45.01 10.17 0 8 0zm0 3.89a4.11 4.11 0 100 8.22 4.11 4.11 0 000-8.22zm0 6.78a2.67 2.67 0 110-5.34 2.67 2.67 0 010 5.34zm5.23-6.94a.96.96 0 11-1.92 0 .96.96 0 011.92 0z"/></svg>',
        facebook: '<svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M16 8a8 8 0 10-9.25 7.9v-5.59H4.72V8h2.03V6.24c0-2 1.19-3.11 3.02-3.11.87 0 1.79.16 1.79.16v1.97h-1.01c-.99 0-1.3.62-1.3 1.25V8h2.22l-.35 2.31h-1.87v5.59A8 8 0 0016 8z"/></svg>',
        tiktok: '<svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M11.77 2.24A3.22 3.22 0 0110.7.44 3.2 3.2 0 019.63 0H7.26v10.67a1.92 1.92 0 01-1.91 1.78 1.92 1.92 0 01-.95-.25 1.92 1.92 0 01-.97-1.66 1.92 1.92 0 011.92-1.92c.2 0 .4.03.58.09V6.26a4.32 4.32 0 00-.58-.04 4.29 4.29 0 00-4.29 4.29 4.27 4.27 0 002.15 3.71 4.28 4.28 0 006.43-3.71V5.37a5.56 5.56 0 003.26 1.05V4.06a3.22 3.22 0 01-1.13-.3 3.24 3.24 0 01-1.1-.82v-.7z"/></svg>',
        youtube: '<svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M15.66 4.13a2.01 2.01 0 00-1.41-1.42C13 2.4 8 2.4 8 2.4s-5 0-6.25.31A2.01 2.01 0 00.34 4.13C.03 5.38.03 8 .03 8s0 2.62.31 3.87a2.01 2.01 0 001.41 1.42C3 13.6 8 13.6 8 13.6s5 0 6.25-.31a2.01 2.01 0 001.41-1.42C16 10.62 16 8 16 8s0-2.62-.34-3.87zM6.4 10.4V5.6L10.56 8 6.4 10.4z"/></svg>',
        twitter: '<svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M9.52 6.78L15.48 0h-1.41L8.89 5.88 4.76 0H0l6.25 9.1L0 16h1.41l5.47-6.35L11.24 16H16L9.52 6.78zm-1.94 2.25l-.63-.91L1.94 1.04h2.17l4.08 5.84.63.91 5.29 7.56h-2.17l-4.36-6.32z"/></svg>',
        website: '<svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zm5.29 4.71h-2.24a12.49 12.49 0 00-1.1-2.87 6.57 6.57 0 013.34 2.87zM8 1.38c.63.78 1.13 1.76 1.46 2.87H6.54c.33-1.11.83-2.09 1.46-2.87zM1.55 9.41a6.63 6.63 0 010-2.82h2.58a13.1 13.1 0 000 2.82H1.55zm.74 1.88h2.24a12.49 12.49 0 001.1 2.87 6.57 6.57 0 01-3.34-2.87zM4.53 9.41a11.7 11.7 0 010-2.82h2.94v2.82H4.53zm3.47 5.21c-.63-.78-1.13-1.76-1.46-2.87h2.92A10.48 10.48 0 018 14.62zm1.78-4.75H6.22V6.59h3.56v3.28zm.22 4.29a12.49 12.49 0 001.1-2.87h2.24a6.57 6.57 0 01-3.34 2.87zm1.41-4.75a11.7 11.7 0 010-2.82h2.58a6.63 6.63 0 010 2.82h-2.58z"/></svg>',
      };
      var showIcon = sbCfg.style !== 'text-only';
      var showText = sbCfg.style !== 'icons-only';
      var handles = sbCfg.handles && sbCfg.handles.length > 0 ? sbCfg.handles : [];
      if (handles.length === 0 && state && state.branding) {
        var b = state.branding;
        var platformMap = [
          ['instagram', b.instagram], ['facebook', b.facebook], ['tiktok', b.tiktok],
          ['youtube', b.youtube], ['twitter', b.twitter], ['website', b.website]
        ];
        platformMap.forEach(function(pair) {
          if (pair[1]) handles.push({ platform: pair[0], handle: pair[1] });
        });
      }
      handles.forEach(function(h) {
        var icon = showIcon ? (icons[h.platform] || '') : '';
        var text = showText ? '<span>' + h.handle + '</span>' : '';
        html += '<div class="ss-social-item">' + icon + text + '</div>';
      });
      ssSocialEl.innerHTML = html;
    } else if (ssSocialEl) {
      ssSocialEl.classList.remove('visible');
      ssSocialEl.innerHTML = '';
    }

    // --- Event Info Card ---
    var ssEventEl = document.getElementById('ss-event-card');
    if (ssEventEl && ssCfg && ssCfg.eventInfo && ssCfg.eventInfo.enabled && ssCfg.layout && ssCfg.layout.eventCard && ssCfg.layout.eventCard.visible) {
      var ecLayout = ssCfg.layout.eventCard;
      var ecCfg = ssCfg.eventInfo;
      ssEventEl.classList.add('visible');
      ssEventEl.style.left = ecLayout.x + '%';
      ssEventEl.style.top = ecLayout.y + '%';
      ssEventEl.style.width = ecLayout.width + '%';
      ssEventEl.style.height = ecLayout.height + '%';
      var ecHtml = '<div class="ss-event-card-inner">';
      // Competition data from WS state (passed via state.routine)
      if (ecCfg.showCompetitionName) {
        var compName = (state && state.branding && state.branding.organizationName) || (state && state.routine && state.routine.category) || '';
        if (compName) ecHtml += '<div class="ss-event-field"><div class="ss-event-label">Event</div><div class="ss-event-value">' + compName + '</div></div>';
      }
      if (ecCfg.showVenue) {
        ecHtml += '<div class="ss-event-field"><div class="ss-event-label">Venue</div><div class="ss-event-value">' + (state.venue || '') + '</div></div>';
      }
      if (ecCfg.showDate) {
        var dateNow = new Date();
        var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        ecHtml += '<div class="ss-event-field"><div class="ss-event-label">Date</div><div class="ss-event-value">' + monthNames[dateNow.getMonth()] + ' ' + dateNow.getDate() + ', ' + dateNow.getFullYear() + '</div></div>';
      }
      // Custom fields
      (ecCfg.customFields || []).forEach(function(f) {
        if (f.label || f.value) {
          ecHtml += '<div class="ss-event-field"><div class="ss-event-label">' + (f.label || '') + '</div><div class="ss-event-value">' + (f.value || '') + '</div></div>';
        }
      });
      ecHtml += '</div>';
      ssEventEl.innerHTML = ecHtml;
    } else if (ssEventEl) {
      ssEventEl.classList.remove('visible');
      ssEventEl.innerHTML = '';
    }

    // --- Video Playlist ---
    var ssVideoEl = document.getElementById('ss-video');
    var ssVideoPlayer = document.getElementById('ss-video-player');
    var ssVideoPlaceholder = document.getElementById('ss-video-placeholder');
    var vpLayoutVisible = !!(ssCfg && ssCfg.layout && ssCfg.layout.videoPlaylist && ssCfg.layout.videoPlaylist.visible);
    if (ssVideoEl && vpLayoutVisible) {
      var vpLayout = ssCfg.layout.videoPlaylist;
      var vpCfg = ssCfg.videoPlaylist || {};
      ssVideoEl.style.display = 'block';
      ssVideoEl.style.left = vpLayout.x + '%';
      ssVideoEl.style.top = vpLayout.y + '%';
      ssVideoEl.style.width = vpLayout.width + '%';
      ssVideoEl.style.height = vpLayout.height + '%';
      var vpHasContent = !!(vpCfg.enabled && vpCfg.folderPath);
      if (vpHasContent && ssVideoPlayer) {
        ssVideoEl.classList.remove('ss-placeholder');
        if (ssVideoPlaceholder) ssVideoPlaceholder.style.display = 'none';
        ssVideoPlayer.muted = vpCfg.muted !== false;
        // Fetch and manage playlist
        if (!window._ssVideoPlaylist || window._ssVideoConfigHash !== JSON.stringify(vpCfg)) {
          window._ssVideoConfigHash = JSON.stringify(vpCfg);
          fetch('/media/list/videos').then(function(r) { return r.json(); }).then(function(files) {
            if (!files || files.length === 0) {
              // No files — fall back to placeholder
              ssVideoEl.classList.add('ss-placeholder');
              if (ssVideoPlaceholder) ssVideoPlaceholder.style.display = 'flex';
              return;
            }
            var playlist = vpCfg.shuffled ? files.sort(function() { return Math.random() - 0.5; }) : files.slice();
            window._ssVideoPlaylist = playlist;
            window._ssVideoIndex = 0;
            ssVideoPlayer.src = '/media/videos/' + encodeURIComponent(playlist[0]);
            ssVideoPlayer.onended = function() {
              window._ssVideoIndex = (window._ssVideoIndex + 1);
              if (window._ssVideoIndex >= playlist.length) {
                if (vpCfg.loop) { window._ssVideoIndex = 0; } else { return; }
              }
              ssVideoPlayer.src = '/media/videos/' + encodeURIComponent(playlist[window._ssVideoIndex]);
              ssVideoPlayer.play();
            };
            ssVideoPlayer.play();
          }).catch(function() {});
        }
      } else {
        // Visible but no content — show placeholder
        ssVideoEl.classList.add('ss-placeholder');
        if (ssVideoPlaceholder) ssVideoPlaceholder.style.display = 'flex';
        if (ssVideoPlayer) { ssVideoPlayer.pause(); ssVideoPlayer.src = ''; }
        window._ssVideoPlaylist = null;
        window._ssVideoConfigHash = null;
      }
    } else if (ssVideoEl) {
      ssVideoEl.style.display = 'none';
      ssVideoEl.classList.remove('ss-placeholder');
      if (ssVideoPlaceholder) ssVideoPlaceholder.style.display = 'none';
      if (ssVideoPlayer) { ssVideoPlayer.pause(); ssVideoPlayer.src = ''; }
      window._ssVideoPlaylist = null;
      window._ssVideoConfigHash = null;
    }

    // --- Photo Slideshow ---
    var ssPhotosEl = document.getElementById('ss-photos');
    var ssPhotoPlaceholder = document.getElementById('ss-photo-placeholder');
    var psLayoutVisible = !!(ssCfg && ssCfg.layout && ssCfg.layout.photoSlideshow && ssCfg.layout.photoSlideshow.visible);
    if (ssPhotosEl && psLayoutVisible) {
      var psLayout = ssCfg.layout.photoSlideshow;
      var psCfg = ssCfg.photoSlideshow || {};
      ssPhotosEl.style.display = 'block';
      ssPhotosEl.style.left = psLayout.x + '%';
      ssPhotosEl.style.top = psLayout.y + '%';
      ssPhotosEl.style.width = psLayout.width + '%';
      ssPhotosEl.style.height = psLayout.height + '%';
      var psHasContent = !!(psCfg.enabled && psCfg.folderPath);
      if (psHasContent) {
        ssPhotosEl.classList.remove('ss-placeholder');
        if (ssPhotoPlaceholder) ssPhotoPlaceholder.style.display = 'none';
        var psDuration = (psCfg.transitionDuration || 1) + 's';
        var psTransition = psCfg.transitionType || 'crossfade';
        var frontImg = ssPhotosEl.querySelector('.ss-slide-front');
        var backImg = ssPhotosEl.querySelector('.ss-slide-back');
        if (frontImg && backImg) {
          frontImg.style.transition = psTransition === 'none' ? 'none' : 'opacity ' + psDuration;
          backImg.style.transition = psTransition === 'none' ? 'none' : 'opacity ' + psDuration;
        }
        // Fetch and cycle photos
        if (!window._ssPhotoList || window._ssPhotoConfigHash !== JSON.stringify(psCfg)) {
          window._ssPhotoConfigHash = JSON.stringify(psCfg);
          if (window._ssPhotoInterval) { clearInterval(window._ssPhotoInterval); window._ssPhotoInterval = null; }
          fetch('/media/list/photos').then(function(r) { return r.json(); }).then(function(files) {
            if (!files || files.length === 0) {
              ssPhotosEl.classList.add('ss-placeholder');
              if (ssPhotoPlaceholder) ssPhotoPlaceholder.style.display = 'flex';
              return;
            }
            window._ssPhotoList = files;
            window._ssPhotoIndex = 0;
            window._ssPhotoFront = true;
            if (frontImg) { frontImg.src = '/media/photos/' + encodeURIComponent(files[0]); frontImg.style.opacity = '1'; }
            if (backImg) { backImg.style.opacity = '0'; }
            var intervalMs = (psCfg.intervalSeconds || 5) * 1000;
            window._ssPhotoInterval = setInterval(function() {
              var photos = window._ssPhotoList;
              if (!photos || photos.length <= 1) return;
              window._ssPhotoIndex = (window._ssPhotoIndex + 1) % photos.length;
              var nextSrc = '/media/photos/' + encodeURIComponent(photos[window._ssPhotoIndex]);
              if (window._ssPhotoFront) {
                // Load next in back, crossfade
                if (backImg) { backImg.src = nextSrc; backImg.style.opacity = '1'; }
                if (frontImg) { frontImg.style.opacity = '0'; }
              } else {
                if (frontImg) { frontImg.src = nextSrc; frontImg.style.opacity = '1'; }
                if (backImg) { backImg.style.opacity = '0'; }
              }
              window._ssPhotoFront = !window._ssPhotoFront;
            }, intervalMs);
          }).catch(function() {});
        }
      } else {
        // Visible but no content — show placeholder
        ssPhotosEl.classList.add('ss-placeholder');
        if (ssPhotoPlaceholder) ssPhotoPlaceholder.style.display = 'flex';
        if (window._ssPhotoInterval) { clearInterval(window._ssPhotoInterval); window._ssPhotoInterval = null; }
        window._ssPhotoList = null;
        window._ssPhotoConfigHash = null;
      }
    } else if (ssPhotosEl) {
      ssPhotosEl.style.display = 'none';
      ssPhotosEl.classList.remove('ss-placeholder');
      if (ssPhotoPlaceholder) ssPhotoPlaceholder.style.display = 'none';
      if (window._ssPhotoInterval) { clearInterval(window._ssPhotoInterval); window._ssPhotoInterval = null; }
      window._ssPhotoList = null;
      window._ssPhotoConfigHash = null;
    }

    // --- Sponsor Logo Carousel ---
    var ssSponsorsEl = document.getElementById('ss-sponsors');
    if (ssSponsorsEl && ssCfg && ssCfg.sponsorCarousel && ssCfg.sponsorCarousel.enabled && ssCfg.layout && ssCfg.layout.sponsorCarousel && ssCfg.layout.sponsorCarousel.visible) {
      var scLayout = ssCfg.layout.sponsorCarousel;
      ssSponsorsEl.style.display = 'flex';
      ssSponsorsEl.style.left = scLayout.x + '%';
      ssSponsorsEl.style.top = scLayout.y + '%';
      ssSponsorsEl.style.width = scLayout.width + '%';
      ssSponsorsEl.style.height = scLayout.height + '%';
      if (!window._ssSponsorList || window._ssSponsorConfigHash !== JSON.stringify(ssCfg.sponsorCarousel)) {
        window._ssSponsorConfigHash = JSON.stringify(ssCfg.sponsorCarousel);
        if (window._ssSponsorInterval) { clearInterval(window._ssSponsorInterval); window._ssSponsorInterval = null; }
        fetch('/media/list/sponsors').then(function(r) { return r.json(); }).then(function(files) {
          if (!files || files.length === 0) { ssSponsorsEl.style.display = 'none'; return; }
          window._ssSponsorList = files;
          window._ssSponsorIndex = 0;
          ssSponsorsEl.innerHTML = '';
          files.forEach(function(f, i) {
            var img = document.createElement('img');
            img.src = '/media/sponsors/' + encodeURIComponent(f);
            if (i === 0) img.classList.add('active');
            ssSponsorsEl.appendChild(img);
          });
          var intervalMs = (ssCfg.sponsorCarousel.intervalSeconds || 5) * 1000;
          window._ssSponsorInterval = setInterval(function() {
            var imgs = ssSponsorsEl.querySelectorAll('img');
            if (imgs.length <= 1) return;
            imgs[window._ssSponsorIndex].classList.remove('active');
            window._ssSponsorIndex = (window._ssSponsorIndex + 1) % imgs.length;
            imgs[window._ssSponsorIndex].classList.add('active');
          }, intervalMs);
        }).catch(function() {});
      }
    } else if (ssSponsorsEl) {
      ssSponsorsEl.style.display = 'none';
      if (window._ssSponsorInterval) { clearInterval(window._ssSponsorInterval); window._ssSponsorInterval = null; }
      window._ssSponsorList = null;
      window._ssSponsorConfigHash = null;
    }

    // --- Up Next Preview ---
    var ssUpNextEl = document.getElementById('ss-up-next');
    if (ssUpNextEl && ssCfg && ssCfg.upNext && ssCfg.upNext.enabled && ssCfg.layout && ssCfg.layout.upNext && ssCfg.layout.upNext.visible && state && state.upcomingRoutines && state.upcomingRoutines.length > 0) {
      var unLayout = ssCfg.layout.upNext;
      var unCfg = ssCfg.upNext;
      ssUpNextEl.classList.add('visible');
      ssUpNextEl.style.left = unLayout.x + '%';
      ssUpNextEl.style.top = unLayout.y + '%';
      ssUpNextEl.style.width = unLayout.width + '%';
      ssUpNextEl.style.height = unLayout.height + '%';
      var unCount = unCfg.count || 5;
      var routines = state.upcomingRoutines.slice(0, unCount);
      var unHtml = '<div class="ss-up-next-header">Up Next</div>';
      routines.forEach(function(r, i) {
        var detailParts = [];
        if (unCfg.showDancers && r.dancers) detailParts.push(r.dancers);
        if (unCfg.showStudio && r.studioName) detailParts.push(r.studioName);
        if (unCfg.showCategory && r.category) detailParts.push(r.category);
        var detailStr = detailParts.join(' \u2022 ');
        unHtml += '<div class="ss-up-next-item" style="animation-delay:' + (i * 0.12) + 's">';
        unHtml += '<div class="ss-up-next-num">#' + (r.entryNumber || '') + '</div>';
        unHtml += '<div class="ss-up-next-info">';
        unHtml += '<div class="ss-up-next-title">' + (r.routineTitle || '') + '</div>';
        if (detailStr) unHtml += '<div class="ss-up-next-detail">' + detailStr + '</div>';
        unHtml += '</div></div>';
      });
      ssUpNextEl.innerHTML = unHtml;
    } else if (ssUpNextEl) {
      ssUpNextEl.classList.remove('visible');
      ssUpNextEl.innerHTML = '';
    }

    // --- Music Visualizer ---
    var ssVizEl = document.getElementById('ss-visualizer');
    if (ssVizEl && ssCfg && ssCfg.visualizer && ssCfg.visualizer.enabled && ssCfg.layout && ssCfg.layout.visualizer && ssCfg.layout.visualizer.visible) {
      var vizLayout = ssCfg.layout.visualizer;
      ssVizEl.style.display = 'flex';
      ssVizEl.style.left = vizLayout.x + '%';
      ssVizEl.style.top = vizLayout.y + '%';
      ssVizEl.style.width = vizLayout.width + '%';
      ssVizEl.style.height = vizLayout.height + '%';
      var barCount = ssCfg.visualizer.barCount || 16;
      var colorStart = ssCfg.visualizer.colorStart || '#ff4444';
      var colorEnd = ssCfg.visualizer.colorEnd || '#ffaa00';
      var vizStyle = ssCfg.visualizer.style || 'bars';
      // Only rebuild bars if count changed
      if (ssVizEl.childElementCount !== barCount || ssVizEl.dataset.vizHash !== barCount + colorStart + colorEnd + vizStyle) {
        ssVizEl.dataset.vizHash = barCount + colorStart + colorEnd + vizStyle;
        ssVizEl.innerHTML = '';
        for (var bi = 0; bi < barCount; bi++) {
          var bar = document.createElement('div');
          bar.className = 'viz-bar';
          // Interpolate color
          var t = barCount > 1 ? bi / (barCount - 1) : 0;
          var cs = hexToRgb(colorStart);
          var ce = hexToRgb(colorEnd);
          var r = Math.round(cs.r + (ce.r - cs.r) * t);
          var g = Math.round(cs.g + (ce.g - cs.g) * t);
          var b = Math.round(cs.b + (ce.b - cs.b) * t);
          bar.style.background = 'rgb(' + r + ',' + g + ',' + b + ')';
          bar.style.height = '100%';
          bar.style.transform = 'scaleY(0.05)';
          if (vizStyle === 'wave') {
            bar.style.borderRadius = '50% 50% 0 0';
          }
          ssVizEl.appendChild(bar);
        }
        window._ssVizBarCount = barCount;
      }
      // Start idle animation if not already running and no audio data
      if (!window._ssVizIdleInterval && !window._ssVizHasAudio) {
        window._ssVizIdleInterval = setInterval(function() {
          if (window._ssVizHasAudio) return;
          var bars = ssVizEl.querySelectorAll('.viz-bar');
          var now = Date.now() / 1000;
          bars.forEach(function(bar, i) {
            var val = 0.05 + 0.12 * (Math.sin(now * 1.5 + i * 0.4) + 1) / 2;
            bar.style.transform = 'scaleY(' + val + ')';
          });
        }, 60);
      }
    } else if (ssVizEl) {
      ssVizEl.style.display = 'none';
      if (window._ssVizIdleInterval) { clearInterval(window._ssVizIdleInterval); window._ssVizIdleInterval = null; }
      window._ssVizHasAudio = false;
    }

    // --- Pinned Chat Comments ---
    var ssPinnedEl = document.getElementById('ss-pinned-chat');
    if (ssPinnedEl && ssCfg && ssCfg.pinnedChat && ssCfg.pinnedChat.enabled && ssCfg.layout && ssCfg.layout.pinnedChat && ssCfg.layout.pinnedChat.visible && state.pinnedChat && state.pinnedChat.length > 0) {
      var pcLayout = ssCfg.layout.pinnedChat;
      var pcCfg = ssCfg.pinnedChat;
      ssPinnedEl.classList.add('visible');
      ssPinnedEl.style.left = pcLayout.x + '%';
      ssPinnedEl.style.top = pcLayout.y + '%';
      ssPinnedEl.style.width = pcLayout.width + '%';
      ssPinnedEl.style.height = pcLayout.height + '%';

      var pins = state.pinnedChat;
      var maxVis = pcCfg.maxVisible || 3;
      var showTime = pcCfg.showTimestamps;

      // Build HTML for visible slice
      function buildPinnedHTML(startIdx) {
        var slice = pins.slice(startIdx, startIdx + maxVis);
        var html = '';
        for (var pi = 0; pi < slice.length; pi++) {
          var p = slice[pi];
          html += '<div class="ss-chat-bubble" style="animation-delay:' + (pi * 0.1) + 's">';
          html += '<div class="ss-chat-name">' + (p.name || 'Anonymous').replace(/</g, '&lt;') + '</div>';
          html += '<div class="ss-chat-text">' + (p.text || '').replace(/</g, '&lt;') + '</div>';
          if (showTime && p.pinnedAt) {
            var d = new Date(p.pinnedAt);
            var hh = d.getHours() % 12 || 12;
            var mm = String(d.getMinutes()).padStart(2, '0');
            var ap = d.getHours() >= 12 ? 'PM' : 'AM';
            html += '<div class="ss-chat-time">' + hh + ':' + mm + ' ' + ap + '</div>';
          }
          html += '</div>';
        }
        return html;
      }

      // Auto-rotate if more pins than maxVisible
      if (pins.length > maxVis) {
        var rotateMs = (pcCfg.rotateIntervalSec || 8) * 1000;
        var configHash = JSON.stringify({ pins: pins.length, maxVis: maxVis, rotate: rotateMs });
        if (window._ssChatHash !== configHash) {
          window._ssChatHash = configHash;
          window._ssChatOffset = 0;
          if (window._ssChatRotateInterval) clearInterval(window._ssChatRotateInterval);
          ssPinnedEl.innerHTML = buildPinnedHTML(0);
          window._ssChatRotateInterval = setInterval(function() {
            window._ssChatOffset = ((window._ssChatOffset || 0) + maxVis) % pins.length;
            ssPinnedEl.innerHTML = buildPinnedHTML(window._ssChatOffset);
          }, rotateMs);
        }
      } else {
        if (window._ssChatRotateInterval) { clearInterval(window._ssChatRotateInterval); window._ssChatRotateInterval = null; }
        ssPinnedEl.innerHTML = buildPinnedHTML(0);
        window._ssChatHash = null;
      }
    } else if (ssPinnedEl) {
      ssPinnedEl.classList.remove('visible');
      ssPinnedEl.innerHTML = '';
      if (window._ssChatRotateInterval) { clearInterval(window._ssChatRotateInterval); window._ssChatRotateInterval = null; }
      window._ssChatHash = null;
    }

    // --- Ticker on Starting Soon ---
    var tickerEl = document.getElementById('ticker');
    if (tickerEl && ss.visible && ssCfg && ssCfg.tickerEnabled) {
      tickerEl.classList.add('visible');
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
  var urlParams = new URLSearchParams(window.location.search);
  var isPreview = urlParams.has('preview');
  var sceneParam = urlParams.get('scene');
  var previewOverrides = {}; // element -> boolean (true=visible, false=hidden)

  if (isPreview && sceneParam === 'startingsoon') {
    // Force starting-soon scene visible for scene editor preview
    var ssPreviewEl = document.getElementById('starting-soon');
    if (ssPreviewEl) ssPreviewEl.classList.add('visible');
    // Hide normal overlay elements
    ['counter', 'clock', 'logo', 'lt'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('visible');
    });
    // Set placeholder text
    var ssPTitle = document.getElementById('ss-title');
    var ssPSub = document.getElementById('ss-subtitle');
    if (ssPTitle && !ssPTitle.textContent) ssPTitle.textContent = 'Starting Soon';
    if (ssPSub && !ssPSub.textContent) ssPSub.textContent = 'The show begins shortly';
  } else if (isPreview) {
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
    if (isPreview && sceneParam === 'startingsoon') {
      // Keep starting-soon visible in scene editor preview
      var ssForceEl = document.getElementById('starting-soon');
      if (ssForceEl) ssForceEl.classList.add('visible');
      // Hide normal overlay elements
      ['counter', 'clock', 'logo', 'lt'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.classList.remove('visible');
      });
    } else if (isPreview) {
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

  function applyAudioLevels(levels) {
    var vizEl = document.getElementById('ss-visualizer');
    if (!vizEl || vizEl.style.display === 'none') return;
    var bars = vizEl.querySelectorAll('.viz-bar');
    if (bars.length === 0) return;

    // Extract peak values from levels array
    var peaks = [];
    if (Array.isArray(levels)) {
      levels.forEach(function(l) { peaks.push(l.peak || 0); });
    }
    if (peaks.length === 0) { window._ssVizHasAudio = false; return; }

    var maxPeak = Math.max.apply(null, peaks);
    if (maxPeak < 0.001) { window._ssVizHasAudio = false; return; }
    window._ssVizHasAudio = true;

    // Distribute audio levels across bars with interpolation
    var barCount = bars.length;
    for (var i = 0; i < barCount; i++) {
      var pos = (peaks.length - 1) * (i / Math.max(1, barCount - 1));
      var lo = Math.floor(pos);
      var hi = Math.min(lo + 1, peaks.length - 1);
      var frac = pos - lo;
      var val = peaks[lo] * (1 - frac) + peaks[hi] * frac;
      // Add some randomness for visual interest
      val = val + (Math.random() * 0.08 - 0.04);
      val = Math.max(0.05, Math.min(1, val));
      bars[i].style.transform = 'scaleY(' + val + ')';
    }
  }

  connect();
</script>
</body>
</html>`
}
