import express from 'express'
import http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { OverlayState, OverlayLayout, DEFAULT_LAYOUT, TickerState, StartingSoonState, AnimationConfig, StartingSoonConfig, StartingSoonPreset, StartingSoonLayout, GradientConfig, SSElementPosition, TimeDateConfig, CountdownStyleConfig, VideoPlaylistConfig, PhotoSlideshowConfig, SocialBarConfig, SponsorCarouselConfig, VisualizerConfig, EventInfoConfig, ChatMessage, OverlayAnimation, VenueIdentifierConfig, SectionBadgeConfig } from '../../shared/types'
import { getSettings } from './settings'
import { logger } from '../logger'
import { setupMediaRoutes, setVideoFolder, setPhotoFolder, setSponsorFolder } from './startingSoonMedia'

const PORT = 9876
let server: http.Server | null = null
let autoHideTimer: NodeJS.Timeout | null = null
let chatFireTimer: NodeJS.Timeout | null = null

// 2026-05-04 unified depth defaults — every element gets a card / subElements /
// presets / activePreset. Defaults are tuned so the rendered output is byte-
// equal to the previous CSS-only render (paddings/blurs match existing CSS,
// fontSize=0 / color='' / fontWeight=0 / borderWidth=-1 mean "use CSS default").
function defaultCard(overrides: Partial<import('../../shared/types').OverlayElementCardStyle> = {}): import('../../shared/types').OverlayElementCardStyle {
  return {
    backgroundColor: '',
    backgroundOpacity: 1,
    backdropBlur: 0,
    paddingX: 0,
    paddingY: 0,
    innerGap: 0,
    borderRadius: 0,
    borderColor: '',
    borderWidth: -1,
    ...overrides,
  }
}
function defaultSub(overrides: Partial<import('../../shared/types').OverlaySubElementStyle> = {}): import('../../shared/types').OverlaySubElementStyle {
  return { fontSize: 0, color: '', fontWeight: 0, order: 0, show: true, ...overrides }
}

let overlayState: OverlayState = {
  counter: {
    visible: true, current: 0, total: 0, entryNumber: '', nextAwardsTime: null,
    card: defaultCard(),
    subElements: { number: defaultSub({ order: 0 }), label: defaultSub({ order: 1 }) },
    presets: {},
    activePreset: null,
  },
  clock: {
    visible: false,
    card: defaultCard(),
    subElements: { time: defaultSub({ order: 0 }), date: defaultSub({ order: 1 }) },
    presets: {},
    activePreset: null,
  },
  logo: {
    visible: true, url: '', assetUrl: '',
    card: defaultCard(),
    subElements: { image: defaultSub({ order: 0 }) },
    presets: {},
    activePreset: null,
  },
  lowerThird: {
    visible: false,
    entryNumber: '',
    routineTitle: '',
    dancers: '',
    studioName: '',
    category: '',
    autoHideSeconds: 8,
    animation: 'random',
    showBrandGlyph: true,
    showEntryNumber: true,
    showRoutineTitle: true,
    showDancers: true,
    showStudioName: true,
    showCategory: true,
    brandGlyphUrl: '', // empty = use default /brand-logo route
    card: {
      backgroundColor: '',     // empty = use existing gradient
      backgroundOpacity: 1,
      backdropBlur: 16,        // matches existing CSS default
      paddingX: 38,
      paddingY: 24,
      innerGap: 22,
      borderRadius: 0,         // 0 = CSS default
      borderColor: '',
      borderWidth: -1,
    },
    subElements: {
      brandGlyph:   defaultSub({ order: 0 }),
      entryNumber:  defaultSub({ order: 1 }),
      routineTitle: defaultSub({ order: 0 }),
      dancers:      defaultSub({ order: 1 }),
      studioName:   defaultSub({ order: 0 }),
      category:     defaultSub({ order: 1 }),
    },
    presets: {},
    activePreset: null,
  },
  ticker: {
    visible: false,
    text: '',
    speed: 60,
    backgroundColor: '#1e1e2e',
    textColor: '#ffffff',
    card: defaultCard(),
    subElements: { text: defaultSub({ order: 0 }) },
    presets: {},
    activePreset: null,
  },
  startingSoon: {
    visible: false,
    title: 'Starting Soon',
    subtitle: '',
    showCountdown: false,
    countdownTarget: '',
    assetUrl: '',
    card: defaultCard(),
    subElements: {
      logo:     defaultSub({ order: 0 }),
      title:    defaultSub({ order: 1 }),
      accent:   defaultSub({ order: 2 }),
      subtitle: defaultSub({ order: 3 }),
      countdown:defaultSub({ order: 4 }),
    },
    presets: {},
    activePreset: null,
  },
  featureCard: {
    visible: false,
    mode: 'upNext',
    entryNumber: '',
    routineTitle: '',
    dancers: '',
    studioName: '',
    category: '',
    nextEntryNumber: '',
    nextRoutineTitle: '',
    nextStudioName: '',
    nextDancers: '',
    nextCategory: '',
    slideDirection: 'up',
    firedAt: 0,
    assetUrl: '',
    card: {
      backgroundColor: '',     // empty = use built-in gradient
      backgroundOpacity: 1,
      backdropBlur: 0,         // intentionally 0 — surface is fully opaque
      paddingX: 64,
      paddingY: 56,
      innerGap: 28,
      borderRadius: 0,
      borderColor: '',
      borderWidth: -1,
    },
    subElements: {
      header:           defaultSub({ order: 0 }),
      studioLogo:       defaultSub({ order: 1 }),
      entryNumber:      defaultSub({ order: 2 }),
      routineTitle:     defaultSub({ order: 3 }),
      dancers:          defaultSub({ order: 4 }),
      studioName:       defaultSub({ order: 5 }),
      category:         defaultSub({ order: 6 }),
      nextHeader:       defaultSub({ order: 7 }),
      nextEntryNumber:  defaultSub({ order: 8 }),
      nextRoutineTitle: defaultSub({ order: 9 }),
      nextStudioName:   defaultSub({ order: 10 }),
    },
    presets: {},
    activePreset: null,
  },
  chatFire: {
    visible: false,
    messageId: null,
    username: '',
    message: '',
    animation: 'random',
    autoHideSeconds: 8,
    firedAt: 0,
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
  // "Magazine cover" default layout — asymmetric, intentional, looks good
  // out of the box without operator tweaking. Title-block on the left,
  // countdown hero on the right, logo top-left, time bottom-left.
  // Slate Aurora gradient — deep indigo cinematic baseline. Operator can
  // switch to Aurora / any other preset via SSE; this is just a pro start.
  gradient: {
    preset: 'slate-aurora',
    speed: 4,
    angle: 135,
  },
  layout: {
    logo:           { x:  5, y:  5, width: 14, height: 10, visible: true  },
    title:          { x:  6, y: 30, width: 50, height: 16, visible: true  },
    subtitle:       { x:  6, y: 47, width: 48, height:  7, visible: true  },
    countdown:      { x: 56, y: 32, width: 38, height: 30, visible: true  },
    timeDate:       { x:  5, y: 92, width: 22, height:  5, visible: true  },
    videoPlaylist:  { x:  5, y: 64, width: 30, height: 26, visible: false },
    photoSlideshow: { x: 38, y: 64, width: 28, height: 26, visible: false },
    // Ticker layout is visible by default so user can position it; whether the
    // rail actually renders is controlled by ssCfg.ticker.enabled in the panel.
    ticker:         { x:  0, y: 95, width:100, height:  5, visible: true  },
    socialBar:      { x: 76, y: 92, width: 22, height:  6, visible: false },
    sponsorCarousel:{ x: 35, y: 92, width: 30, height:  5, visible: false },
    visualizer:     { x: 70, y: 68, width: 25, height: 22, visible: false },
    eventCard:      { x:  5, y: 62, width: 32, height: 26, visible: false },
    upNext:         { x:  5, y: 58, width: 38, height: 34, visible: false },
    pinnedChat:     { x: 60, y: 64, width: 36, height: 26, visible: false },
    // Premium pass 2026-05-06 — broadcast hallmarks. Sit in scene corners,
    // operator-draggable via SSE if exposed; safe defaults below.
    venueId:        { x: 36, y:  3, width: 28, height:  4, visible: true  },
    sectionBadge:   { x: 82, y:  3, width: 16, height:  4, visible: true  },
  },
  title: 'Starting Soon',
  titleFontSize: 112,
  titleColor: '#ffffff',
  titleFont: 'Bebas Neue',
  subtitle: 'The show begins shortly',
  subtitleFontSize: 32,
  subtitleColor: '#a5b4fc',
  subtitleFont: 'Inter',
  showCountdown: true,
  countdownTarget: '',
  countdownStyle: {
    fontSize: 96,
    color: '#ffffff',
    fontWeight: 900,
    showLabels: false,
    expiredText: 'SOON',
    prefixText: '',
    // Premium pass 2026-05-06 — flipboard digit treatment by default for the
    // broadcast feel. Operator can drop back to 'soft' via SSE.
    style: 'flipboard',
    finalSecondsTakeover: true,
    finalSecondsThreshold: 30,
    finalLabel: 'FINAL 30 SECONDS',
    finalSubLabel: 'Show begins shortly',
  },
  timeDate: {
    enabled: true,
    format: '12h',
    showDate: false,
    showSeconds: true,
    fontSize: 28,
    color: '#ffffff',
  },
  logo: {
    source: 'brand',
    customUrl: '',
    fit: 'contain',
    opacity: 1,
    animation: 'pulse',
    animationSpeed: 5,
    // Premium pass 2026-05-06 — trophy plinth on by default; operator can
    // disable via SSE if the brand mark already has a busy shape.
    haloEnabled: true,
    haloColor: '#a4b3ff',
  },
  ticker: {
    enabled: false,
    text: 'Welcome to the show — please find your seats — competition starts shortly',
    speed: 60,
    color: '#ffffff',
    bgColor: 'rgba(0,0,0,0.55)',
    fontSize: 22,
    // Premium pass 2026-05-06 — broadcast two-row treatment. Operator-overridable.
    twoRow: true,
    categoryLabel: 'EVENT INFO',
    liveIndicator: true,
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
  // Premium pass 2026-05-06 — broadcast hallmarks. Operator-editable via SSE.
  venueIdentifier: {
    enabled: true,
    eventLabel: '',     // operator fills via SSE; empty = section hidden
    venueName: '',
    dayLabel: '',
    fontSize: 14,
    color: '#c5cae9',
  },
  sectionBadge: {
    enabled: true,
    label: 'STARTING SOON',
    dotColor: '#ef4444',
    fontSize: 12,
    color: '#ffffff',
  },
}

let startingSoonConfig: StartingSoonConfig = { ...defaultSSConfig }
let ssPresets: StartingSoonPreset[] = []

// build9p (Item #13 fix 2026-05-06): multi-subscriber state-change broadcast.
// Was a single-slot callback (wsHub overrode at startup; renderer never got
// pushed → 2s setInterval poll caused SD↔app drift). Now a list of listeners
// fan out on every notifyChange so wsHub broadcasts AND main/index.ts pushes
// IPC to the renderer atomically. Back-compat: setOnStateChange still works
// (single-slot replace semantic preserved for the FIRST caller — wsHub —
// while addStateChangeListener stacks additional subscribers).
let onStateChange: (() => void) | null = null
const stateChangeListeners: Array<() => void> = []

export function setOnStateChange(cb: () => void): void {
  // Back-compat: original single-slot wsHub registration. Replaces only the
  // primary slot; stacked listeners (addStateChangeListener) are unaffected.
  if (onStateChange) {
    const idx = stateChangeListeners.indexOf(onStateChange)
    if (idx >= 0) stateChangeListeners.splice(idx, 1)
  }
  onStateChange = cb
  stateChangeListeners.push(cb)
}

/** Add an additional listener (does not replace the primary slot). */
export function addStateChangeListener(cb: () => void): () => void {
  stateChangeListeners.push(cb)
  return () => {
    const idx = stateChangeListeners.indexOf(cb)
    if (idx >= 0) stateChangeListeners.splice(idx, 1)
  }
}

function notifyChange(): void {
  for (const cb of stateChangeListeners) {
    try { cb() } catch (err) {
      logger.app.warn(`overlay state listener failed: ${err instanceof Error ? err.message : err}`)
    }
  }
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
      // Deep-merge with defaults so nested objects added in newer versions
      // (new layout elements, new gradient fields, etc.) don't disappear when
      // loading an older saved config. Shallow spread would drop missing keys.
      startingSoonConfig = {
        ...defaultSSConfig,
        ...data,
        layout: { ...defaultSSConfig.layout, ...(data.layout || {}) },
        gradient: { ...defaultSSConfig.gradient, ...(data.gradient || {}) },
        countdownStyle: { ...defaultSSConfig.countdownStyle, ...(data.countdownStyle || {}) },
        timeDate: { ...defaultSSConfig.timeDate, ...(data.timeDate || {}) },
        logo: { ...defaultSSConfig.logo, ...(data.logo || {}) },
        ticker: { ...defaultSSConfig.ticker, ...(data.ticker || {}) },
        socialBar: { ...defaultSSConfig.socialBar, ...(data.socialBar || {}) },
        eventInfo: { ...defaultSSConfig.eventInfo, ...(data.eventInfo || {}) },
        videoPlaylist: { ...defaultSSConfig.videoPlaylist, ...(data.videoPlaylist || {}) },
        photoSlideshow: { ...defaultSSConfig.photoSlideshow, ...(data.photoSlideshow || {}) },
        sponsorCarousel: { ...defaultSSConfig.sponsorCarousel, ...(data.sponsorCarousel || {}) },
        visualizer: { ...defaultSSConfig.visualizer, ...(data.visualizer || {}) },
        upNext: { ...defaultSSConfig.upNext, ...(data.upNext || {}) },
        pinnedChat: { ...defaultSSConfig.pinnedChat, ...(data.pinnedChat || {}) },
        venueIdentifier: { ...(defaultSSConfig.venueIdentifier as VenueIdentifierConfig), ...(data.venueIdentifier || {}) },
        sectionBadge: { ...(defaultSSConfig.sectionBadge as SectionBadgeConfig), ...(data.sectionBadge || {}) },
      }
      logger.app.info('Starting soon config loaded from disk (deep-merged with defaults)')
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
    logo: { ...defaultSSConfig.logo, ...(overrides.logo || {}) },
    ticker: { ...defaultSSConfig.ticker, ...(overrides.ticker || {}) },
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

// Helper — pluck the stylable surface (card/subElements/presets/activePreset
// + asset overrides) for a single element so we can persist it without the
// data-flow churn (entryNumber, current, etc. that should NEVER restore).
function snapshotElementStyle(elementKey: OverlayElementKey): Record<string, unknown> {
  const el = overlayState[elementKey] as any
  return {
    card: el.card,
    subElements: el.subElements,
    presets: el.presets,
    activePreset: el.activePreset,
    assetUrl: el.assetUrl,                  // logo / startingSoon
    brandGlyphUrl: el.brandGlyphUrl,        // lowerThird
    showBrandGlyph: el.showBrandGlyph,      // LT visibility flags
    showEntryNumber: el.showEntryNumber,
    showRoutineTitle: el.showRoutineTitle,
    showDancers: el.showDancers,
    showStudioName: el.showStudioName,
    showCategory: el.showCategory,
  }
}

function applyElementStyleSnapshot(elementKey: OverlayElementKey, snap: any): void {
  if (!snap || typeof snap !== 'object') return
  const el = overlayState[elementKey] as any
  if (snap.card)           el.card = { ...el.card, ...snap.card }
  if (snap.subElements)    el.subElements = { ...el.subElements, ...snap.subElements }
  if (snap.presets)        el.presets = { ...el.presets, ...snap.presets }
  if ('activePreset' in snap) el.activePreset = snap.activePreset
  if (typeof snap.assetUrl === 'string')         el.assetUrl = snap.assetUrl
  if (typeof snap.brandGlyphUrl === 'string')    el.brandGlyphUrl = snap.brandGlyphUrl
  if (typeof snap.showBrandGlyph === 'boolean')  el.showBrandGlyph = snap.showBrandGlyph
  if (typeof snap.showEntryNumber === 'boolean') el.showEntryNumber = snap.showEntryNumber
  if (typeof snap.showRoutineTitle === 'boolean')el.showRoutineTitle = snap.showRoutineTitle
  if (typeof snap.showDancers === 'boolean')     el.showDancers = snap.showDancers
  if (typeof snap.showStudioName === 'boolean')  el.showStudioName = snap.showStudioName
  if (typeof snap.showCategory === 'boolean')    el.showCategory = snap.showCategory
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
      // 2026-05-04 unified depth — per-element stylable surface, restored on
      // boot. Excludes routine data (entryNumber/title/etc.) which is
      // re-populated by updateRoutineData each session.
      elementStyles: {
        counter:      snapshotElementStyle('counter'),
        clock:        snapshotElementStyle('clock'),
        logo:         snapshotElementStyle('logo'),
        lowerThird:   snapshotElementStyle('lowerThird'),
        ticker:       snapshotElementStyle('ticker'),
        startingSoon: snapshotElementStyle('startingSoon'),
        featureCard:  snapshotElementStyle('featureCard'),
      },
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
      // 2026-05-04 unified depth — restore per-element style snapshots.
      if (config.elementStyles && typeof config.elementStyles === 'object') {
        const es = config.elementStyles as Record<string, any>
        ;(['counter','clock','logo','lowerThird','ticker','startingSoon','featureCard'] as OverlayElementKey[]).forEach((k) => {
          if (es[k]) applyElementStyleSnapshot(k, es[k])
        })
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

/**
 * Fire a chat message as a transient LT-style overlay broadcast.
 * Inherits the current lower-third animation + animConfig.autoHideSeconds.
 * If called again while a fire is still visible, replaces the current
 * message and resets the auto-hide timer (simplest queue policy).
 *
 * 2026-05-02 (Burlington UDC Day 2): when each fire's timer expires, fire the
 * `onChatFireAutoHide` callback so external code (chatBridge) can clear that
 * specific pinned-message state.
 *
 * 2026-05-02 (Burlington UDC Day 2 — bug fix): the shared `chatFireTimer`
 * was being cleared on every subsequent fire, which cancelled earlier pins'
 * auto-hide-unpin timers. When operator hammered pins faster than 8s apart,
 * earlier pins stayed "PINNED" in the operator UI forever. Now each fire gets
 * its own per-msgId unpin timer in `chatFireUnpinTimers` so all pins reliably
 * auto-clean even under burst-pin workloads.
 */
let onChatFireAutoHide: ((msgId: string) => void) | null = null
export function setOnChatFireAutoHide(cb: (msgId: string) => void): void {
  onChatFireAutoHide = cb
}
const chatFireUnpinTimers = new Map<string, NodeJS.Timeout>()

export function fireChatMessage(msg: ChatMessage): void {
  const animation = (overlayState.lowerThird.animation || 'random') as OverlayAnimation
  // 2026-05-02 (Burlington UDC Day 2): operator request — chat-fires (comment
  // pins) should hold 1s less than the LT autoHide. LT settings stay
  // authoritative; chat snaps off a beat earlier so the audience-visible state
  // and the operator's pin queue feel responsive. Floor at 2s.
  const baseSeconds = overlayState.animConfig.autoHideSeconds ?? 8
  const seconds = Math.max(2, baseSeconds - 1)
  const msgId = msg.id
  overlayState.chatFire = {
    visible: true,
    messageId: msgId,
    username: msg.name || 'Anonymous',
    message: msg.text || '',
    animation,
    autoHideSeconds: seconds,
    firedAt: Date.now(),
  }
  logger.app.info(`Overlay chat fire: "${msg.text?.slice(0, 40) ?? ''}" (${animation}, ${seconds}s) id=${msgId.slice(0, 8)}`)
  // Visibility timer: only the LAST fire's bubble is on-air, so clobbering
  // the prior visibility timer is correct here.
  if (chatFireTimer) clearTimeout(chatFireTimer)
  if (seconds > 0) {
    chatFireTimer = setTimeout(() => {
      if (overlayState.chatFire) overlayState.chatFire.visible = false
      chatFireTimer = null
      notifyChange()
    }, seconds * 1000)
  }
  // Per-message unpin timer: every pin gets its OWN timer so all pins clear in
  // operator UI even if more pins fire in the meantime. Replacing the same
  // message's timer if it gets re-pinned mid-fire is intentional (one unpin).
  if (seconds > 0) {
    const existing = chatFireUnpinTimers.get(msgId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      chatFireUnpinTimers.delete(msgId)
      logger.app.info(`Chat fire auto-hide unpinning id=${msgId.slice(0, 8)}`)
      try { onChatFireAutoHide?.(msgId) } catch (e) {
        logger.app.warn(`onChatFireAutoHide callback failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }, seconds * 1000)
    chatFireUnpinTimers.set(msgId, t)
  }
  notifyChange()
}

export function toggleElement(element: 'counter' | 'clock' | 'logo' | 'lowerThird' | 'startingSoon' | 'ticker' | 'featureCard'): OverlayState {
  const el = overlayState[element]
  el.visible = !el.visible

  // Cancel auto-hide timer when toggling lower third off
  if (element === 'lowerThird' && !el.visible && autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }

  // Persist ticker visibility — setTicker() is the canonical write path that
  // saves overlay-config.json, so call it for parity instead of relying on a
  // bare overlayState mutation that wouldn't survive restart.
  if (element === 'ticker') {
    saveOverlayConfig()
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
  nextAwardsTime?: string | null
}): void {
  overlayState.counter.entryNumber = data.entryNumber
  overlayState.counter.current = data.current
  overlayState.counter.total = data.total
  overlayState.counter.nextAwardsTime = data.nextAwardsTime ?? null
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

// ── Feature Card (2026-05-04) ──
// Full-screen broadcast graphic. Two modes:
//   - upNext:  large layout of upcoming routine
//   - thatWas: large layout of just-performed routine + bottom UP NEXT strip
// Surface is fully opaque (no transparency, no backdrop blur). Slide-on with
// random direction per fire, bounce ease-in-out, motion blur during slide.
// Slide-off mirrors. Auto-hide is intentionally OFF — operator owns timing.

const FEATURE_CARD_DIRECTIONS: import('../../shared/types').OverlayFeatureCardSlideDirection[] =
  ['up', 'down', 'left', 'right']

export interface FeatureCardSlot {
  entryNumber: string
  routineTitle: string
  dancers: string
  studioName: string
  category: string
}

export function setFeatureCardData(data: {
  main: FeatureCardSlot
  next: FeatureCardSlot
}): void {
  overlayState.featureCard.entryNumber = data.main.entryNumber
  overlayState.featureCard.routineTitle = data.main.routineTitle
  overlayState.featureCard.dancers = data.main.dancers
  overlayState.featureCard.studioName = data.main.studioName
  overlayState.featureCard.category = data.main.category
  overlayState.featureCard.nextEntryNumber = data.next.entryNumber
  overlayState.featureCard.nextRoutineTitle = data.next.routineTitle
  overlayState.featureCard.nextDancers = data.next.dancers
  overlayState.featureCard.nextStudioName = data.next.studioName
  overlayState.featureCard.nextCategory = data.next.category
  notifyChange()
}

export function fireFeatureCard(
  mode: import('../../shared/types').OverlayFeatureCardMode,
): import('../../shared/types').OverlayFeatureCardSlideDirection {
  const dir = FEATURE_CARD_DIRECTIONS[Math.floor(Math.random() * FEATURE_CARD_DIRECTIONS.length)]
  overlayState.featureCard.mode = mode
  overlayState.featureCard.slideDirection = dir
  overlayState.featureCard.firedAt = Date.now()
  overlayState.featureCard.visible = true
  logger.app.info(`Overlay feature card fired: mode=${mode} slide=${dir}`)
  notifyChange()
  return dir
}

export function hideFeatureCard(): void {
  if (!overlayState.featureCard.visible) return
  overlayState.featureCard.visible = false
  // Bump firedAt so the iframe can re-trigger the slide-off animation
  // independently of slide-on (it uses the same monotonic counter).
  overlayState.featureCard.firedAt = Date.now()
  logger.app.info('Overlay feature card hidden')
  notifyChange()
}

export function isFeatureCardVisible(): boolean {
  return overlayState.featureCard.visible
}

export function getFeatureCardMode(): import('../../shared/types').OverlayFeatureCardMode {
  return overlayState.featureCard.mode
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

/**
 * Apply partial updates to the lower-third state. Mirror of setTicker —
 * called from the VisualEditor when the operator toggles per-sub-element
 * visibility (showBrandGlyph, showEntryNumber, showRoutineTitle, showDancers,
 * showStudioName, showCategory) or any other LT field. notifyChange triggers
 * the broadcast so the live overlay iframe updates without a refresh.
 */
export function setLowerThirdState(
  updates: Partial<OverlayState['lowerThird']>,
): void {
  overlayState.lowerThird = { ...overlayState.lowerThird, ...updates }
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

// --- 2026-05-04 Unified per-element style + preset operations ---

export type OverlayElementKey =
  | 'counter' | 'clock' | 'logo' | 'lowerThird' | 'ticker' | 'startingSoon' | 'featureCard'

/**
 * Decide whether a URL should be rendered as <video>, <img>, or skipped.
 * Local Windows paths (operator-browsed) are normalized to lowercase to
 * detect extensions safely. Animated GIF / animated WebP / APNG stay as
 * <img> — the browser animates them natively. Only true video containers
 * (mp4 / webm / mov / m4v) become <video autoplay loop muted playsinline>.
 */
export function assetTagForUrl(url: string): 'video' | 'img' | 'none' {
  if (!url || typeof url !== 'string') return 'none'
  const lower = url.toLowerCase().split('?')[0].split('#')[0]
  if (/\.(mp4|webm|mov|m4v)$/.test(lower)) return 'video'
  if (/\.(png|jpg|jpeg|svg|webp|gif|apng|avif)$/.test(lower)) return 'img'
  // Default to img for ambiguous URLs (operator may have browsed an unusual ext)
  return 'img'
}

/**
 * Apply a partial style snapshot to one element's card / subElements / assetUrl.
 * Used by the renderer's SelectedElementProperties panel — operator twiddles
 * a knob, this fires, the WS state push fans out to every overlay iframe.
 */
export function setElementStyle(
  elementKey: OverlayElementKey,
  partial: {
    card?: Partial<import('../../shared/types').OverlayElementCardStyle>
    subElements?: Record<string, Partial<import('../../shared/types').OverlaySubElementStyle>>
    assetUrl?: string
  },
): OverlayState {
  const el = overlayState[elementKey] as any
  if (!el) return overlayState
  if (partial.card) {
    el.card = { ...el.card, ...partial.card }
  }
  if (partial.subElements) {
    const merged: Record<string, any> = { ...(el.subElements || {}) }
    for (const [k, v] of Object.entries(partial.subElements)) {
      merged[k] = { ...(merged[k] || {}), ...v }
    }
    el.subElements = merged
  }
  if (partial.assetUrl !== undefined) {
    if (elementKey === 'logo' || elementKey === 'startingSoon' || elementKey === 'featureCard') {
      el.assetUrl = partial.assetUrl
    } else if (elementKey === 'lowerThird') {
      el.brandGlyphUrl = partial.assetUrl
    }
  }
  saveOverlayConfig()
  notifyChange()
  return overlayState
}

function ensurePresetsBag(elementKey: OverlayElementKey): Record<string, import('../../shared/types').OverlayElementPreset> {
  const el = overlayState[elementKey] as any
  if (!el.presets) el.presets = {}
  return el.presets
}

export function saveElementPreset(elementKey: OverlayElementKey, name: string): OverlayState {
  if (!name || !name.trim()) return overlayState
  const el = overlayState[elementKey] as any
  const snapshot: import('../../shared/types').OverlayElementPreset = {
    card: { ...el.card },
    subElements: JSON.parse(JSON.stringify(el.subElements || {})),
    assetUrl: (elementKey === 'lowerThird') ? (el.brandGlyphUrl || '') : (el.assetUrl || ''),
  }
  const bag = ensurePresetsBag(elementKey)
  bag[name.trim()] = snapshot
  el.activePreset = name.trim()
  saveOverlayConfig()
  notifyChange()
  logger.app.info(`Overlay preset saved: ${elementKey} → "${name.trim()}"`)
  return overlayState
}

export function loadElementPreset(elementKey: OverlayElementKey, name: string): OverlayState {
  const el = overlayState[elementKey] as any
  const preset = el.presets?.[name]
  if (!preset) return overlayState
  el.card = { ...el.card, ...preset.card }
  el.subElements = JSON.parse(JSON.stringify(preset.subElements || {}))
  if (elementKey === 'lowerThird') {
    el.brandGlyphUrl = preset.assetUrl || ''
  } else if (elementKey === 'logo' || elementKey === 'startingSoon' || elementKey === 'featureCard') {
    el.assetUrl = preset.assetUrl || ''
  }
  el.activePreset = name
  saveOverlayConfig()
  notifyChange()
  logger.app.info(`Overlay preset loaded: ${elementKey} → "${name}"`)
  return overlayState
}

export function deleteElementPreset(elementKey: OverlayElementKey, name: string): OverlayState {
  const el = overlayState[elementKey] as any
  if (el.presets && name in el.presets) {
    delete el.presets[name]
    if (el.activePreset === name) el.activePreset = null
    saveOverlayConfig()
    notifyChange()
    logger.app.info(`Overlay preset deleted: ${elementKey} → "${name}"`)
  }
  return overlayState
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

  // 2026-05-04 unified depth — per-element asset override route. Mirrors
  // /brand-logo's file-piping pattern so <img>/<video> in the iframe can fetch
  // the operator-configured override (logo, LT brand glyph, SS logo) from
  // their respective state.assetUrl / state.brandGlyphUrl fields without
  // hitting the file:// cross-origin block.
  app.get('/element-asset', (req, res) => {
    try {
      const key = String(req.query.key || '').toLowerCase()
      let filePath = ''
      if (key === 'logo')              filePath = (overlayState.logo as any).assetUrl || ''
      else if (key === 'startingsoon') filePath = (overlayState.startingSoon as any).assetUrl || ''
      else if (key === 'lowerthird')   filePath = (overlayState.lowerThird as any).brandGlyphUrl || ''
      else if (key === 'featurecard')  filePath = (overlayState.featureCard as any).assetUrl || ''
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).send('No element asset configured')
        return
      }
      const ext = path.extname(filePath).toLowerCase().slice(1)
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        svg: 'image/svg+xml', webp: 'image/webp', apng: 'image/apng', avif: 'image/avif',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
      }
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      fs.createReadStream(filePath).pipe(res)
    } catch (err) {
      logger.app.warn('Failed to serve element asset: ' + (err instanceof Error ? err.message : String(err)))
      res.status(500).send('Element asset error')
    }
  })

  // Brand logo HTTP route — Chromium blocks file:// URLs from http origin.
  // The iframe loads from http://localhost:9876/overlay so any <img src> must
  // also be http(s) or data:. Serve the configured logo file as a binary HTTP
  // response. Source priority: brand logo → legacy overlay logo url.
  app.get('/brand-logo', (_req, res) => {
    try {
      const settings = getSettings()
      const brandLogo = settings?.branding?.brandLogoUrl || ''
      const overlayLogo = settings?.overlay?.logoUrl || overlayState.logo.url || ''
      const filePath = brandLogo || overlayLogo
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).send('No logo configured')
        return
      }
      const ext = path.extname(filePath).toLowerCase().slice(1)
      const mime = ext === 'png' ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'svg' ? 'image/svg+xml'
        : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
        : 'application/octet-stream'
      res.setHeader('Content-Type', mime)
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      fs.createReadStream(filePath).pipe(res)
    } catch (err) {
      logger.app.warn('Failed to serve brand logo: ' + (err instanceof Error ? err.message : String(err)))
      res.status(500).send('Logo serve error')
    }
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
  // 2026-05-02 (Burlington UDC Day 2): pull tenant brand accent from settings
  // for the LT redesign. Falls back to the legacy purple if unset so non-branded
  // tenants render unchanged. Reads only — never writes branding settings.
  const settings = getSettings()
  const brandAccent = (settings as { branding?: { brandColors?: string[] } })?.branding?.brandColors?.[0] || '#667eea'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Abril+Fatface&family=Anton&family=Archivo+Black&family=Barlow:wght@400;700&family=Bebas+Neue&family=Caveat:wght@400;700&family=Cormorant+Garamond:wght@400;700&family=Dancing+Script:wght@400;700&family=DM+Sans:wght@400;700&family=EB+Garamond:wght@400;700&family=Fira+Sans:wght@400;700&family=Fjalla+One&family=IBM+Plex+Sans:wght@400;700&family=Inter:wght@400;700&family=JetBrains+Mono:wght@400;700&family=Lato:wght@400;700&family=Lora:wght@400;700&family=Manrope:wght@400;700&family=Merriweather:wght@400;700&family=Montserrat:wght@400;700&family=Nunito:wght@400;700&family=Open+Sans:wght@400;700&family=Oswald:wght@400;700&family=Outfit:wght@400;700&family=Pacifico&family=Playfair+Display:wght@400;700&family=Plus+Jakarta+Sans:wght@400;700&family=Poppins:wght@400;700&family=Raleway:wght@400;700&family=Righteous&family=Roboto:wght@400;700&family=Rubik:wght@400;700&family=Russo+One&family=Space+Grotesk:wght@400;700&family=Space+Mono:wght@400;700&family=Work+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {
    --anim-dur: 0.5s;
    --anim-ease: ease;
    --brand-accent: ${brandAccent};
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
    font-size: 48px; font-weight: 800; color: #ffffff; line-height: 1;
  }
  .counter-number::before { content: '#'; opacity: 0.4; font-size: 28px; }
  .counter-label { font-size: 13px; color: #e8e8f5; margin-top: 4px; letter-spacing: 0.5px; }

  /* Counter advance — premium animation pack (build #9, 2026-05-05).
     One variant picked at random per advance, no-repeat with prior. Classes
     v1–v6 are added by the iframe JS alongside .advance, then cleared at end.
     Each animation 0.6–0.9s. Designed to read at broadcast distance. */
  .counter.advance .counter-number { will-change: transform, filter, color, text-shadow; }

  /* v1 — Premium pop: scale + brand-color glow flash + brightness pulse */
  .counter.advance.v1 .counter-number { animation: counterV1 0.7s cubic-bezier(0.34, 1.56, 0.64, 1); }
  @keyframes counterV1 {
    0%   { transform: scale(1); filter: brightness(1) drop-shadow(0 0 0 rgba(102,126,234,0)); }
    35%  { transform: scale(1.32); filter: brightness(1.4) drop-shadow(0 0 22px rgba(102,126,234,0.9)); color: #a4b3ff; }
    100% { transform: scale(1); filter: brightness(1) drop-shadow(0 0 0 rgba(102,126,234,0)); }
  }

  /* v2 — 3D flip (perspective rotateX) with brand color at apex */
  .counter.advance.v2 .counter-number {
    animation: counterV2 0.85s cubic-bezier(0.4, 0, 0.2, 1);
    transform-style: preserve-3d;
  }
  @keyframes counterV2 {
    0%   { transform: perspective(420px) rotateX(0deg); }
    45%  { transform: perspective(420px) rotateX(90deg); color: #667eea; filter: brightness(1.5); }
    55%  { transform: perspective(420px) rotateX(-90deg); color: #667eea; filter: brightness(1.5); }
    100% { transform: perspective(420px) rotateX(0deg); }
  }

  /* v3 — Slide down + spring overshoot bounce */
  .counter.advance.v3 .counter-number { animation: counterV3 0.85s cubic-bezier(0.34, 1.56, 0.64, 1); }
  @keyframes counterV3 {
    0%   { transform: translateY(-60%); opacity: 0; filter: blur(8px); }
    55%  { transform: translateY(10%); opacity: 1; filter: blur(0); }
    75%  { transform: translateY(-4%); }
    90%  { transform: translateY(2%); }
    100% { transform: translateY(0); }
  }

  /* v4 — RGB-split glitch sweep settling into brand glow */
  .counter.advance.v4 .counter-number { animation: counterV4 0.7s steps(1, end); }
  @keyframes counterV4 {
    0%   { transform: translate(0,0); text-shadow: 0 0 0 transparent; }
    8%   { transform: translate(-3px,2px); text-shadow: 3px 0 0 #ff00ea, -3px 0 0 #00fff0; }
    16%  { transform: translate(3px,-2px); text-shadow: -3px 0 0 #ff00ea, 3px 0 0 #00fff0; }
    24%  { transform: translate(-2px,1px); text-shadow: 2px 0 0 #ff00ea, -2px 0 0 #00fff0; }
    32%  { transform: translate(2px,-1px); text-shadow: -2px 0 0 #ff00ea, 2px 0 0 #00fff0; }
    40%  { transform: translate(-1px,0); text-shadow: 1px 0 0 #ff00ea, -1px 0 0 #00fff0; }
    50%  { transform: translate(0,0); text-shadow: 0 0 16px rgba(102,126,234,0.85); }
    100% { transform: translate(0,0); text-shadow: 0 0 0 transparent; }
  }

  /* v5 — Zoom burst: starts blurred-small, blows out, settles back */
  .counter.advance.v5 .counter-number { animation: counterV5 0.8s cubic-bezier(0.22, 1, 0.36, 1); }
  @keyframes counterV5 {
    0%   { transform: scale(0.55); filter: blur(14px) brightness(1.2); opacity: 0; }
    40%  { transform: scale(1.5); filter: blur(0) brightness(1.6); opacity: 1; color: #c7d0ff; }
    65%  { transform: scale(0.94); filter: blur(0) brightness(1); color: #ffffff; }
    100% { transform: scale(1); }
  }

  /* v6 — Shimmer streak across the number (additive ::after overlay) */
  .counter.advance.v6 .counter-number {
    position: relative;
    animation: counterV6Pop 0.7s ease-out;
  }
  .counter.advance.v6 .counter-number::after {
    content: '';
    position: absolute;
    inset: -4px -8px;
    background: linear-gradient(115deg,
      transparent 35%,
      rgba(255,255,255,0.9) 48%,
      rgba(164,179,255,0.9) 52%,
      transparent 65%);
    transform: translateX(-110%);
    animation: counterV6Sweep 0.85s ease-out forwards;
    mix-blend-mode: screen;
    pointer-events: none;
    border-radius: 8px;
  }
  @keyframes counterV6Pop {
    0%   { transform: scale(1); filter: brightness(1); }
    50%  { transform: scale(1.18); filter: brightness(1.35); }
    100% { transform: scale(1); filter: brightness(1); }
  }
  @keyframes counterV6Sweep {
    0%   { transform: translateX(-110%); }
    100% { transform: translateX(110%); }
  }
  .logo {
    position: absolute;
    left: ${overlayLayout.logo.x}%; top: ${overlayLayout.logo.y}%;
    width: ${overlayLayout.logo.width}%; height: ${overlayLayout.logo.height}%;
    opacity: 0; transition: opacity 0.4s ease;
  }
  .logo.visible { opacity: 1; }
  .logo img {
    width: 100%; height: 100%;
    object-fit: contain;
    object-position: left top;
    opacity: 0.6;
    border-radius: 6px;
  }
  .clock {
    position: absolute; left: ${overlayLayout.clock.x}%; top: ${overlayLayout.clock.y}%;
    opacity: 0;
    /* Burlington UDC 2026-05-01: smooth transition on left/top so clock
       slides up into counter's slot when counter is hidden during awards
       and slides back down when counter reappears. */
    transition: opacity 0.4s ease, left 0.5s cubic-bezier(0.22,1,0.36,1), top 0.5s cubic-bezier(0.22,1,0.36,1);
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
    font-size: 20px; font-weight: 600; color: #ffffff;
    font-variant-numeric: tabular-nums;
  }
  .clock-date {
    font-size: 11px; color: #e8e8f5; margin-top: 2px;
  }
  .lower-third {
    position: absolute; left: ${overlayLayout.lowerThird.x}%; top: ${overlayLayout.lowerThird.y}%;
    opacity: 0;
    transition: opacity var(--anim-dur) var(--anim-ease), transform var(--anim-dur) var(--anim-ease), filter var(--anim-dur) var(--anim-ease);
  }
  .lower-third.visible { opacity: 1; }

  /* ── Animation variants ── */

  /* Slide — dramatized 2026-05-02: 100→240px travel, snappier overshoot bezier */
  .lower-third.anim-slide { transform: translateX(-240px) skewX(-4deg); }
  .lower-third.anim-slide.visible { transform: translateX(0) skewX(0deg); transition: opacity calc(var(--anim-dur) * 0.5) ease, transform calc(var(--anim-dur) * 1.15) cubic-bezier(0.18, 1.7, 0.32, 1); }

  /* Fade */
  .lower-third.anim-fade { transform: none; }

  /* Zoom — dramatized: 0.3→0.12 start, longer overshoot with shadow inflation */
  .lower-third.anim-zoom { transform: scale(0.12); }
  .lower-third.anim-zoom.visible { transform: scale(1); transition: opacity calc(var(--anim-dur) * 0.45) ease, transform calc(var(--anim-dur) * 1.2) cubic-bezier(0.22, 1.85, 0.42, 1); }

  /* Rise — dramatized: 60→160px, harder spring */
  .lower-third.anim-rise { transform: translateY(160px) scale(0.92); }
  .lower-third.anim-rise.visible { transform: translateY(0) scale(1); transition: opacity calc(var(--anim-dur) * 0.45) ease, transform calc(var(--anim-dur) * 1.15) cubic-bezier(0.18, 1.75, 0.4, 1); }

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

  /* Bounce — dramatized: -80→-200px drop, more aggressive bezier */
  .lower-third.anim-bounce { transform: translateY(-200px) scale(0.88); }
  .lower-third.anim-bounce.visible { transform: translateY(0) scale(1); transition: opacity calc(var(--anim-dur) * 0.28) ease, transform calc(var(--anim-dur) * 1.2) cubic-bezier(0.2, 1.95, 0.42, 1); }

  /* Split — dramatized: scaleX with slight Y squash on rebound */
  .lower-third.anim-split { transform: scaleX(0) scaleY(0.6); transform-origin: center; }
  .lower-third.anim-split.visible { transform: scaleX(1) scaleY(1); transition: opacity calc(var(--anim-dur) * 0.35) ease, transform calc(var(--anim-dur) * 1.15) cubic-bezier(0.2, 1.7, 0.4, 1); }

  /* Blur — dramatized: 20→44px blur, stronger scale punch */
  .lower-third.anim-blur { filter: blur(44px); transform: scale(1.18); }
  .lower-third.anim-blur.visible { filter: blur(0px); transform: scale(1); transition: opacity calc(var(--anim-dur) * 0.5) ease, transform calc(var(--anim-dur) * 1.1) cubic-bezier(0.22, 1.4, 0.4, 1), filter calc(var(--anim-dur) * 1.3) ease-out; }

  /* Sparkle — dramatized: brighter punch, larger brand-tinted glow */
  .lower-third.anim-sparkle {
    transform: scale(0.84);
    filter: brightness(2.4) drop-shadow(0 0 0px var(--brand-accent));
  }
  .lower-third.anim-sparkle.visible {
    transform: scale(1);
    filter: brightness(1) drop-shadow(0 0 28px var(--brand-accent));
    transition: opacity calc(var(--anim-dur) * 0.45) ease,
                transform calc(var(--anim-dur) * 1.2) cubic-bezier(0.22, 1.7, 0.42, 1),
                filter calc(var(--anim-dur) * 1.4) ease;
  }

  /* LT card — dramatized 2026-05-02: heavier border with brand-color stripe,
     deeper shadow with tenant-tinted glow, beefier padding/radius. */
  .lt-card {
    position: relative;
    background: linear-gradient(135deg, rgba(20, 20, 32, 0.94), rgba(30, 30, 46, 0.92));
    border: 2px solid color-mix(in srgb, var(--brand-accent) 55%, transparent);
    border-left: 6px solid var(--brand-accent);
    border-radius: 14px; padding: 24px 38px;
    backdrop-filter: blur(16px);
    min-width: 580px;
    box-shadow:
      0 18px 60px color-mix(in srgb, var(--brand-accent) 30%, rgba(0,0,0,0.55)),
      0 0 0 1px rgba(255,255,255,0.04) inset,
      0 0 80px color-mix(in srgb, var(--brand-accent) 14%, transparent) inset;
    overflow: hidden;
  }
  /* Animated shimmer sweep on entry — single pass, decorative only.
     2026-05-02 perf fix: animate transform instead of left to keep this on the
     GPU compositor — animating left forces layout recalc per frame and was
     measurably bumping renderer CPU (~300% combined across 3 windows). */
  .lt-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0;
    width: 60%; height: 100%;
    background: linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.16) 50%, transparent 100%);
    transform: translateX(-200%) skewX(-20deg);
    pointer-events: none;
    will-change: transform;
  }
  .lower-third.visible .lt-card::before {
    transform: translateX(380%) skewX(-20deg);
    transition: transform calc(var(--anim-dur) * 1.6) cubic-bezier(0.22, 1, 0.36, 1) calc(var(--anim-dur) * 0.2);
  }
  .lt-top { display: flex; align-items: center; gap: 22px; }
  /* Title + dancers stack — flex column so it self-centers vertically against
     the entry-number pill regardless of how many lines either row wraps to.
     min-width:0 lets long titles shrink instead of overflowing the card. */
  .lt-stack {
    display: flex; flex-direction: column; justify-content: center;
    gap: 6px;
    min-width: 0;
    flex: 1 1 auto;
  }
  /* Brand glyph mounted at the leading edge of the card. Hidden when the
     tenant has no brand logo (image fails to load → JS clears display). */
  .lt-brand-glyph {
    /* Sized to fit within the lt-top row height set by .lt-number (~74px).
       No pill background / padding — img fills the container, so visual logo
       is ~72px vs. the previous 52px (64px box - 6px padding × 2). */
    width: 72px; height: 72px;
    flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    filter: drop-shadow(0 0 22px color-mix(in srgb, var(--brand-accent) 42%, transparent))
            drop-shadow(0 2px 6px rgba(0,0,0,0.45));
    opacity: 0;
    transform: scale(0.6) rotate(-8deg);
    transition: opacity calc(var(--anim-dur) * 0.5) ease,
                transform calc(var(--anim-dur) * 0.9) cubic-bezier(0.2, 1.6, 0.4, 1);
  }
  .lower-third.visible .lt-brand-glyph {
    opacity: 1;
    transform: scale(1) rotate(0deg);
    transition-delay: 0s, 0s;
  }
  .lt-brand-glyph img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .lt-brand-glyph.empty { display: none; }
  .lt-number {
    background: linear-gradient(135deg, var(--brand-accent), color-mix(in srgb, var(--brand-accent) 55%, #1a1a2e));
    color: white; font-weight: 900; font-size: 48px;
    padding: 6px 22px; border-radius: 10px; flex-shrink: 0;
    letter-spacing: -0.02em;
    line-height: 1;
    display: flex; align-items: baseline; justify-content: center;
    text-shadow: 0 2px 8px rgba(0,0,0,0.35);
    box-shadow: 0 6px 22px color-mix(in srgb, var(--brand-accent) 45%, transparent),
                0 0 0 1px rgba(255,255,255,0.08) inset;
  }
  .lt-number::before { content: '#'; opacity: 0.55; font-size: 28px; font-weight: 700; margin-right: 2px; }
  .lt-title {
    font-size: 40px; font-weight: 800; color: #ffffff;
    letter-spacing: -0.01em;
    line-height: 1.05;
    text-shadow: 0 2px 12px color-mix(in srgb, var(--brand-accent) 25%, rgba(0,0,0,0.5));
  }
  .lt-dancers {
    font-size: 22px; color: #d8dbff; font-weight: 500;
    line-height: 1.2;
    letter-spacing: 0.005em;
    opacity: 0.92;
  }
  .lt-meta {
    font-size: 18px; color: #e8e8f5;
    margin-top: 14px;
    line-height: 1.3;
    letter-spacing: 0.02em;
    font-weight: 500;
    opacity: 0.85;
  }
  /* Brand-color underline that draws in below the title block on entry */
  .lt-card::after {
    content: '';
    position: absolute;
    left: 38px; right: 38px; bottom: 14px;
    height: 2px;
    background: linear-gradient(90deg, var(--brand-accent), transparent);
    transform: scaleX(0);
    transform-origin: left center;
    transition: transform calc(var(--anim-dur) * 1.1) cubic-bezier(0.22, 1, 0.36, 1) calc(var(--anim-dur) * 0.15);
  }
  .lower-third.visible .lt-card::after { transform: scaleX(1); }

  /* ── Starting Soon Scene — design-pro pass 2026-05-05 ──
     Defaults still operator-editable through SSE; what changed is the baseline.
     Adds atmospheric depth (vignette + grain + bloom), cinematic scene-entry
     orchestration on first-show, and broadcast-grade typography polish. */
  .starting-soon {
    position: absolute;
    top: 0; left: 0; width: 100%; height: 100%;
    background: #0a0e1a;
    opacity: 0;
    transition: opacity 0.8s ease;
    z-index: 50;
    overflow: hidden;
  }
  .starting-soon.visible { opacity: 1; }

  /* Scene-entry: subtle camera-zoom on the whole scene, settles to 1:1 */
  .starting-soon.first-show {
    animation: ssSceneZoom 2.4s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes ssSceneZoom {
    0%   { transform: scale(1.025); }
    100% { transform: scale(1.0); }
  }

  /* Atmospheric layers — radial vignette pulls eye to center */
  .ss-vignette {
    position: absolute; inset: 0; z-index: 1;
    background: radial-gradient(ellipse at center,
      transparent 0%,
      transparent 45%,
      rgba(0, 0, 0, 0.35) 100%);
    pointer-events: none;
  }
  /* Subtle film grain — CSS-generated noise via SVG fractal turbulence */
  .ss-grain {
    position: absolute; inset: 0; z-index: 1;
    pointer-events: none;
    opacity: 0.04;
    mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
    background-size: 200px 200px;
  }
  /* Conic light bloom — soft brand-tinted halo behind the logo position.
     Position via CSS variables so layout edits in SSE move it with the logo. */
  .ss-bloom {
    position: absolute; z-index: 1;
    left: var(--ss-bloom-x, 12%); top: var(--ss-bloom-y, 10%);
    width: 38vw; height: 38vw;
    transform: translate(-50%, -50%);
    background: conic-gradient(from 220deg,
      transparent 0%,
      rgba(102,126,234,0.22) 22%,
      rgba(164,179,255,0.30) 32%,
      rgba(102,126,234,0.18) 50%,
      transparent 72%);
    filter: blur(48px);
    pointer-events: none;
    opacity: 0.85;
    animation: ssBloomDrift 24s ease-in-out infinite;
  }
  @keyframes ssBloomDrift {
    0%, 100% { transform: translate(-50%, -50%) rotate(0deg); }
    50%      { transform: translate(-48%, -52%) rotate(40deg); }
  }

  .ss-title {
    position: absolute;
    display: none;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: 0.04em;
    text-align: center;
    white-space: nowrap;
    transform: translate(-50%, -50%);
    text-shadow: 0 4px 32px rgba(0, 0, 0, 0.45);
  }
  .ss-subtitle {
    position: absolute;
    display: none;
    font-weight: 400;
    color: #c5cae9;
    opacity: 0.92;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    text-align: center;
    white-space: nowrap;
    transform: translate(-50%, -50%);
  }
  .ss-countdown {
    position: absolute;
    display: none;
    font-weight: 300;
    color: #ffffff;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    text-align: center;
    white-space: nowrap;
    transform: translate(-50%, -50%);
    text-shadow: 0 6px 40px rgba(0, 0, 0, 0.5);
  }
  /* Subtle 1s blink on every colon character inside the countdown so the
     timer feels alive without being noisy. JS marks colons with .ss-cd-colon */
  .ss-cd-colon { animation: ssColonBlink 1.05s ease-in-out infinite; }
  @keyframes ssColonBlink {
    0%, 100% { opacity: 1; }
    52%      { opacity: 0.55; }
  }
  /* Title accent — thin gradient hairline that sweeps in on first show.
     Sits centered horizontally below the title, scales from 0 → 1. */
  .ss-accent-line {
    position: absolute;
    display: none;
    height: 2px;
    background: linear-gradient(90deg,
      transparent 0%,
      rgba(164, 179, 255, 0.35) 18%,
      rgba(164, 179, 255, 0.95) 50%,
      rgba(164, 179, 255, 0.35) 82%,
      transparent 100%);
    transform: translate(-50%, -50%) scaleX(0);
    transform-origin: center;
    border-radius: 1px;
  }
  .starting-soon.first-show .ss-accent-line.visible {
    animation: ssAccentSweep 0.9s cubic-bezier(0.22, 1, 0.36, 1) 1.0s both;
  }
  @keyframes ssAccentSweep {
    0%   { transform: translate(-50%, -50%) scaleX(0); opacity: 0; }
    100% { transform: translate(-50%, -50%) scaleX(1); opacity: 1; }
  }

  /* First-show entry orchestration. Each element fades + transforms in
     with a staggered offset. Settles via animation-fill-mode: both. */
  .starting-soon.first-show .ss-title {
    animation: ssTitleEnter 0.9s cubic-bezier(0.22, 1, 0.36, 1) 0.2s both;
  }
  @keyframes ssTitleEnter {
    0%   { transform: translate(-50%, -50%) translateY(20px); letter-spacing: 0.18em; opacity: 0; filter: blur(6px); }
    100% { transform: translate(-50%, -50%) translateY(0);    letter-spacing: 0.04em; opacity: 1; filter: blur(0); }
  }
  .starting-soon.first-show .ss-subtitle {
    animation: ssSubtitleEnter 0.7s ease-out 0.85s both;
  }
  @keyframes ssSubtitleEnter {
    0%   { transform: translate(-50%, -50%) translateY(8px); opacity: 0; }
    100% { transform: translate(-50%, -50%) translateY(0);   opacity: 0.92; }
  }
  .starting-soon.first-show .ss-countdown {
    animation: ssCountdownIgnite 1.0s cubic-bezier(0.22, 1, 0.36, 1) 1.1s both;
  }
  @keyframes ssCountdownIgnite {
    0%   { transform: translate(-50%, -50%) scale(0.85); opacity: 0; filter: blur(10px); }
    65%  { transform: translate(-50%, -50%) scale(1.03); opacity: 1; filter: blur(0); }
    100% { transform: translate(-50%, -50%) scale(1.0); }
  }
  .starting-soon.first-show .ss-time-date {
    animation: ssTimeDateEnter 0.6s ease-out 1.6s both;
  }
  @keyframes ssTimeDateEnter {
    0%   { opacity: 0; transform: translateY(4px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  .starting-soon.first-show .ss-vignette {
    animation: ssVignetteFade 1.4s ease-out both;
  }
  @keyframes ssVignetteFade {
    0%   { opacity: 0; }
    100% { opacity: 1; }
  }
  /* Background saturation ramps from 60% → 100% on entry */
  .starting-soon.first-show .ss-gradient-bg {
    animation: ssBgIgnite 1.6s ease-out both, gradient-shift var(--gradient-speed, 18s) ease infinite 1.6s;
  }
  @keyframes ssBgIgnite {
    0%   { filter: saturate(0.55) brightness(0.7); }
    100% { filter: saturate(1.0)  brightness(1.0); }
  }
  .ss-logo {
    position: absolute;
    display: none;
  }
  .ss-logo img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    filter: drop-shadow(0 12px 32px rgba(0, 0, 0, 0.45));
  }
  /* Logo first-show — subtle scale-up from 0.92 with motion blur */
  .starting-soon.first-show .ss-logo {
    animation: ssLogoEnter 1.1s cubic-bezier(0.22, 1, 0.36, 1) 1.4s both;
  }
  @keyframes ssLogoEnter {
    0%   { transform: scale(0.92); opacity: 0; filter: blur(4px); }
    100% { transform: scale(1.0);  opacity: 1; filter: blur(0); }
  }
  /* Logo animations — applied as classes from applyStartingSoon */
  .ss-logo.anim-pulse img {
    animation: ss-logo-pulse var(--ss-logo-anim-dur, 2s) ease-in-out infinite;
  }
  .ss-logo.anim-float img {
    animation: ss-logo-float var(--ss-logo-anim-dur, 4s) ease-in-out infinite;
  }
  .ss-logo.anim-spin img {
    animation: ss-logo-spin var(--ss-logo-anim-dur, 12s) linear infinite;
  }
  .ss-logo.anim-fade-in-once img {
    animation: ss-logo-fade-in-once var(--ss-logo-anim-dur, 1.2s) ease-out 1 both;
  }
  .ss-logo.anim-breathing img {
    animation: ss-logo-breathing var(--ss-logo-anim-dur, 5s) ease-in-out infinite;
  }
  .ss-logo.anim-glow img {
    animation: ss-logo-glow var(--ss-logo-anim-dur, 3s) ease-in-out infinite;
    filter: drop-shadow(0 0 8px rgba(255,255,255,0.6));
  }
  @keyframes ss-logo-pulse {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.08); }
  }
  @keyframes ss-logo-float {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-6px); }
  }
  @keyframes ss-logo-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes ss-logo-fade-in-once {
    from { opacity: 0; transform: translateY(-12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes ss-logo-breathing {
    0%, 100% { transform: scale(1); opacity: 0.85; }
    50%      { transform: scale(1.04); opacity: 1; }
  }
  @keyframes ss-logo-glow {
    0%, 100% { filter: drop-shadow(0 0 4px rgba(255,255,255,0.3)); }
    50%      { filter: drop-shadow(0 0 14px rgba(255,255,255,0.85)); }
  }
  /* ── Premium pass 2026-05-06 — broadcast hallmarks ──
     Logo plinth halo, venue identifier strip, section identifier badge,
     two-row ticker treatment, flip-board countdown digits. */

  /* Logo plinth — translucent beveled plate behind logo with rotating
     conic halo. Sits in the same layout slot as the logo; halo extends
     beyond the plate edges. */
  .ss-logo-halo {
    position: absolute;
    inset: -18%;
    pointer-events: none;
    z-index: 0;
    background: conic-gradient(from 0deg,
      transparent 0deg,
      var(--ss-halo, rgba(164,179,255,0.55)) 70deg,
      transparent 130deg,
      transparent 230deg,
      var(--ss-halo, rgba(164,179,255,0.55)) 290deg,
      transparent 360deg);
    filter: blur(22px);
    opacity: 0;
    border-radius: 50%;
    transform: scale(0.85);
  }
  .starting-soon.visible .ss-logo-halo {
    animation: ssHaloIn 1.1s cubic-bezier(0.22,1,0.36,1) 1.4s forwards,
               ssHaloSpin 18s linear 2.5s infinite;
  }
  @keyframes ssHaloIn {
    0%   { opacity: 0; transform: scale(0.85); }
    100% { opacity: 1; transform: scale(1.0); }
  }
  @keyframes ssHaloSpin {
    from { transform: scale(1.0) rotate(0deg); }
    to   { transform: scale(1.0) rotate(360deg); }
  }
  .ss-logo-plate {
    position: absolute;
    inset: -8%;
    z-index: 0;
    pointer-events: none;
    border-radius: 14px;
    background: linear-gradient(135deg,
      rgba(255,255,255,0.06) 0%,
      rgba(255,255,255,0.02) 50%,
      rgba(255,255,255,0.06) 100%);
    border: 1px solid rgba(255,255,255,0.08);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.10),
      inset 0 -1px 0 rgba(0,0,0,0.30),
      0 12px 38px rgba(0,0,0,0.45);
    opacity: 0;
  }
  .starting-soon.visible .ss-logo-plate {
    animation: ssPlateIn 1.0s cubic-bezier(0.22,1,0.36,1) 1.2s forwards;
  }
  @keyframes ssPlateIn {
    0%   { opacity: 0; transform: scale(0.96); }
    100% { opacity: 1; transform: scale(1.0); }
  }
  .ss-logo .ss-logo-img-wrap {
    position: relative;
    width: 100%; height: 100%;
    z-index: 2;
  }
  .ss-logo.has-halo img {
    position: relative;
    z-index: 2;
  }

  /* Eurosport-style identifier strip — sits in scene corner.
     Renders 1-3 segments separated by a hairline pipe. */
  .ss-venue-id {
    position: absolute;
    display: none;
    align-items: center;
    gap: 14px;
    padding: 8px 14px;
    z-index: 3;
    color: #c5cae9;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 600;
    background: linear-gradient(135deg, rgba(20,24,44,0.62), rgba(20,24,44,0.32));
    border: 1px solid rgba(164,179,255,0.18);
    border-radius: 4px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05);
  }
  .ss-venue-id.visible { display: inline-flex; }
  .ss-venue-id .ss-vid-seg {
    display: inline-block;
    white-space: nowrap;
  }
  .ss-venue-id .ss-vid-pipe {
    display: inline-block;
    width: 1px; height: 12px;
    background: linear-gradient(180deg, transparent, rgba(164,179,255,0.55), transparent);
  }
  .ss-venue-id .ss-vid-seg.ss-vid-event {
    color: #ffffff;
    font-weight: 800;
  }
  .starting-soon.first-show .ss-venue-id.visible {
    animation: ssVenueEnter 0.8s ease-out 0.6s both;
  }
  @keyframes ssVenueEnter {
    0%   { opacity: 0; transform: translateY(-6px); }
    100% { opacity: 1; transform: translateY(0); }
  }

  /* Section identifier badge — top-corner pill ("STARTING SOON" + dot) */
  .ss-section-badge {
    position: absolute;
    display: none;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    z-index: 3;
    color: #ffffff;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    font-weight: 700;
    background: linear-gradient(135deg, rgba(0,0,0,0.55), rgba(0,0,0,0.30));
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 999px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 4px 14px rgba(0,0,0,0.4);
  }
  .ss-section-badge.visible { display: inline-flex; }
  .ss-section-badge .ss-sb-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--ss-sb-dot, #ef4444);
    box-shadow: 0 0 8px var(--ss-sb-dot, #ef4444);
    animation: ssBadgeDotPulse 1.4s ease-in-out infinite;
  }
  @keyframes ssBadgeDotPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50%      { transform: scale(1.35); opacity: 0.55; }
  }
  .starting-soon.first-show .ss-section-badge.visible {
    animation: ssBadgeEnter 0.7s ease-out 0.4s both;
  }
  @keyframes ssBadgeEnter {
    0%   { opacity: 0; transform: translateY(-4px) scale(0.92); }
    100% { opacity: 1; transform: translateY(0)    scale(1.0); }
  }

  /* Two-row ticker — accent row above main scroller. The main rail keeps
     its existing styles; the accent row sits flush above with category +
     LIVE indicator. */
  .ss-ticker-block {
    position: absolute;
    display: none;
    flex-direction: column;
    z-index: 2;
  }
  .ss-ticker-block.visible { display: flex; }
  .ss-ticker-accent {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 14px;
    background: linear-gradient(90deg, rgba(0,0,0,0.65), rgba(0,0,0,0.40));
    border-bottom: 1px solid rgba(164,179,255,0.22);
    color: #ffffff;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    font-weight: 700;
    font-size: 12px;
    flex: 0 0 auto;
  }
  .ss-ticker-accent .ss-ticker-cat {
    color: #c5cae9;
  }
  .ss-ticker-live {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    background: rgba(239, 68, 68, 0.18);
    border: 1px solid rgba(239,68,68,0.45);
    border-radius: 3px;
    color: #ff6b6b;
    font-weight: 800;
    font-size: 11px;
  }
  .ss-ticker-live::before {
    content: '';
    display: inline-block;
    width: 7px; height: 7px;
    border-radius: 50%;
    background: #ef4444;
    box-shadow: 0 0 6px #ef4444;
    animation: ssLiveDot 1.0s ease-in-out infinite;
  }
  @keyframes ssLiveDot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.4; transform: scale(0.75); }
  }
  /* Flip-board countdown digits. JS wraps each digit in
     <span class="ss-cd-digit">D</span>; on tick the old digit slides up
     and the new digit slides in. Background plates evoke Olympic flip clocks. */
  .ss-countdown.style-flipboard {
    display: flex !important;
    gap: 6px;
    align-items: baseline;
    justify-content: center;
    line-height: 1;
  }
  .ss-cd-digit-cell {
    display: inline-block;
    position: relative;
    padding: 0.18em 0.28em;
    border-radius: 8px;
    background: linear-gradient(180deg,
      rgba(20,24,44,0.85) 0%,
      rgba(20,24,44,0.85) 49%,
      rgba(0,0,0,0.92) 50%,
      rgba(20,24,44,0.85) 100%);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.10),
      inset 0 -1px 0 rgba(0,0,0,0.55),
      0 6px 18px rgba(0,0,0,0.50);
    overflow: hidden;
    color: #ffffff;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 2px 8px rgba(0,0,0,0.65);
  }
  .ss-cd-digit-cell::after {
    content: '';
    position: absolute;
    left: 0; right: 0;
    top: 50%;
    height: 1px;
    background: rgba(0,0,0,0.65);
    pointer-events: none;
  }
  .ss-cd-digit-cell .ss-cd-digit {
    display: inline-block;
    animation: ssDigitFlip 0.45s cubic-bezier(0.22,1,0.36,1) both;
    transform-origin: center top;
  }
  @keyframes ssDigitFlip {
    0%   { transform: translateY(-12%) rotateX(-90deg); opacity: 0; }
    55%  { transform: translateY(0)    rotateX(0deg);   opacity: 1; }
    100% { transform: translateY(0)    rotateX(0deg);   opacity: 1; }
  }
  /* Flipboard colon — no plate, just a stylized separator */
  .ss-cd-sep {
    display: inline-block;
    color: #c5cae9;
    opacity: 0.85;
    padding: 0 0.04em;
    animation: ssColonBlink 1.05s ease-in-out infinite;
  }

  /* ── Final-30 countdown takeover (premium pass 2026-05-06) ──
     When countdown ≤ 30s, fade the layout-positioned countdown and reveal
     a full-screen, centered, oversized flipboard treatment. Fades out at 0
     and falls back to the layout countdown when the operator extends the
     timer. */
  .ss-final-cd {
    position: absolute;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    background: radial-gradient(ellipse at center,
      rgba(10,14,26,0.55) 0%,
      rgba(10,14,26,0.86) 60%,
      rgba(0,0,0,0.94) 100%);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    transition: opacity 0.6s ease;
  }
  .ss-final-cd.visible { opacity: 1; }
  .ss-final-cd.entering {
    animation: ssFinalEnter 0.9s cubic-bezier(0.22,1,0.36,1) both;
  }
  @keyframes ssFinalEnter {
    0%   { opacity: 0; transform: scale(0.92); filter: blur(8px); }
    100% { opacity: 1; transform: scale(1.0);  filter: blur(0); }
  }
  .ss-final-cd-label {
    color: #ef4444;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    font-weight: 800;
    font-size: 22px;
    margin-bottom: 22px;
    text-shadow: 0 0 16px rgba(239,68,68,0.55);
    display: flex; align-items: center; gap: 12px;
  }
  .ss-final-cd-label::before, .ss-final-cd-label::after {
    content: '';
    display: inline-block;
    width: 60px; height: 2px;
    background: linear-gradient(90deg, transparent, rgba(239,68,68,0.85), transparent);
  }
  .ss-final-cd-digits {
    display: flex;
    align-items: baseline;
    gap: 16px;
    color: #ffffff;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    letter-spacing: -0.02em;
    font-weight: 900;
    text-shadow: 0 12px 60px rgba(0,0,0,0.7);
  }
  /* Cell sizing scales with viewport so 1080p / 2160p both look right */
  .ss-final-cd-digits .ss-cd-digit-cell {
    font-size: clamp(160px, 22vw, 360px);
    padding: 0.05em 0.18em;
    border-radius: 18px;
    background: linear-gradient(180deg,
      rgba(20,24,44,0.95) 0%,
      rgba(20,24,44,0.95) 49%,
      rgba(0,0,0,0.98) 50%,
      rgba(20,24,44,0.95) 100%);
    box-shadow:
      inset 0 2px 0 rgba(255,255,255,0.15),
      inset 0 -2px 0 rgba(0,0,0,0.65),
      0 24px 60px rgba(0,0,0,0.6),
      0 0 80px rgba(164,179,255,0.18);
  }
  .ss-final-cd-digits .ss-cd-sep {
    font-size: clamp(120px, 16vw, 280px);
    color: #c5cae9;
    opacity: 0.75;
    animation: ssColonBlink 1.0s ease-in-out infinite;
  }
  .ss-final-cd-sub {
    margin-top: 26px;
    color: #c5cae9;
    letter-spacing: 0.25em;
    text-transform: uppercase;
    font-weight: 600;
    font-size: 16px;
    opacity: 0.75;
  }
  /* Halo pulse on each digit-change tick — adds a brief brand-tinted glow */
  .ss-final-cd-digits .ss-cd-digit-cell.flash {
    animation: ssFinalFlash 0.55s ease-out both;
  }
  @keyframes ssFinalFlash {
    0%   { box-shadow:
            inset 0 2px 0 rgba(255,255,255,0.15),
            inset 0 -2px 0 rgba(0,0,0,0.65),
            0 24px 60px rgba(0,0,0,0.6),
            0 0 0 rgba(164,179,255,0); }
    35%  { box-shadow:
            inset 0 2px 0 rgba(255,255,255,0.20),
            inset 0 -2px 0 rgba(0,0,0,0.65),
            0 24px 60px rgba(0,0,0,0.6),
            0 0 120px rgba(164,179,255,0.65); }
    100% { box-shadow:
            inset 0 2px 0 rgba(255,255,255,0.15),
            inset 0 -2px 0 rgba(0,0,0,0.65),
            0 24px 60px rgba(0,0,0,0.6),
            0 0 80px rgba(164,179,255,0.18); }
  }
  /* Last-5 escalation — digits go red at ≤ 5s for the stadium-buzz feel */
  .ss-final-cd.escalate .ss-final-cd-digits .ss-cd-digit-cell {
    background: linear-gradient(180deg,
      rgba(40,12,12,0.98) 0%,
      rgba(40,12,12,0.98) 49%,
      rgba(0,0,0,1) 50%,
      rgba(40,12,12,0.98) 100%);
    box-shadow:
      inset 0 2px 0 rgba(255,80,80,0.20),
      inset 0 -2px 0 rgba(0,0,0,0.7),
      0 24px 80px rgba(0,0,0,0.7),
      0 0 100px rgba(239,68,68,0.50);
  }
  .ss-final-cd.escalate .ss-final-cd-label { color: #ff6b6b; }
  /* Drop-out at zero — radial flash + fade */
  .ss-final-cd.drop {
    animation: ssFinalDrop 1.2s cubic-bezier(0.22,1,0.36,1) forwards;
  }
  @keyframes ssFinalDrop {
    0%   { opacity: 1; transform: scale(1.0); filter: brightness(1); }
    20%  { opacity: 1; transform: scale(1.10); filter: brightness(2.2); }
    100% { opacity: 0; transform: scale(1.18); filter: brightness(1); }
  }

  /* Independent SSE ticker rail (not the main overlay ticker).
     Lives inside .ss-ticker-block which carries the absolute positioning;
     the rail is a flex child that takes the full block width. */
  .ss-ticker-rail {
    position: relative;
    overflow: hidden;
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    width: 100%;
    /* Edge-fade gradient mask so text fades into bg instead of hard-clipping */
    -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%);
            mask-image: linear-gradient(90deg, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%);
    /* Brand-tinted gradient bg (was passed via inline style; keep that as override) */
    backdrop-filter: blur(6px);
  }
  .ss-ticker-rail-inner {
    display: inline-block;
    white-space: nowrap;
    padding-left: 100%;
    animation: ss-ticker-scroll var(--ss-ticker-dur, 30s) linear infinite;
  }
  @keyframes ss-ticker-scroll {
    0%   { transform: translateX(0); }
    100% { transform: translateX(-100%); }
  }
  .ss-time-date {
    position: absolute;
    display: none;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: #b8b8d0; /* Dimmed from #fff to read as secondary, not competing */
    letter-spacing: 0.04em;
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
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
  .starting-soon > *:not(.ss-gradient-bg) { z-index: 1; }

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
    color: rgba(230, 235, 255, 0.95);
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
    color: rgba(255,255,255,0.92);
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
    color: rgba(255,255,255,0.92);
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
    color: rgba(255,255,255,0.92);
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
    color: rgba(255,255,255,0.95);
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
    color: #ffffff;
    line-height: 1.4;
    word-wrap: break-word;
  }
  .ss-chat-time {
    font-size: 10px;
    color: #d5d5e8;
    margin-top: 4px;
  }

  /* ── Chat Fire — LT-style transient broadcast of pinned chat messages (commit 6) ── */
  /* Positioned top-center so it doesn't clobber a bottom-anchored LT for an active routine.
     Operator note 2026-04-25: pin-fires were not appearing on the live overlay even though
     the IPC/state path was confirmed working ("Overlay chat fire:" log + state broadcast).
     Hypothesis: stacking context conflict with .starting-soon (z-index 50) which is full-canvas
     even at opacity 0. Hardening: position:fixed + viewport units + z-index above starting-soon. */
  .chat-fire {
    position: fixed;
    left: 50vw;
    top: 80px;
    transform: translateX(-50%);
    opacity: 0;
    transition: opacity var(--anim-dur) var(--anim-ease), transform var(--anim-dur) var(--anim-ease), filter var(--anim-dur) var(--anim-ease);
    max-width: 720px;
    pointer-events: none;
    z-index: 100;
  }
  .chat-fire.visible { opacity: 1; }
  /* Reuse the LT animation variants — mirrored 2026-05-03 to match the
     "dramatized 2026-05-02" travel/scale/blur/sparkle values for parity.
     Centering baseline is translateX(-50%); every variant adds its delta on top. */

  /* Slide — 240px travel + skewX(-4deg), snappier overshoot bezier */
  .chat-fire.anim-slide { transform: translateX(calc(-50% - 240px)) skewX(-4deg); }
  .chat-fire.anim-slide.visible { transform: translateX(-50%) skewX(0deg); transition: opacity calc(var(--anim-dur) * 0.5) ease, transform calc(var(--anim-dur) * 1.15) cubic-bezier(0.18, 1.7, 0.32, 1); }

  /* Fade */
  .chat-fire.anim-fade { transform: translateX(-50%); }

  /* Zoom — 0.12 start with overshoot and shadow inflation */
  .chat-fire.anim-zoom { transform: translateX(-50%) scale(0.12); }
  .chat-fire.anim-zoom.visible { transform: translateX(-50%) scale(1); transition: opacity calc(var(--anim-dur) * 0.45) ease, transform calc(var(--anim-dur) * 1.2) cubic-bezier(0.22, 1.85, 0.42, 1); }

  /* Rise — 160px lift + 0.92 squish with harder spring */
  .chat-fire.anim-rise { transform: translateX(-50%) translateY(160px) scale(0.92); }
  .chat-fire.anim-rise.visible { transform: translateX(-50%) translateY(0) scale(1); transition: opacity calc(var(--anim-dur) * 0.45) ease, transform calc(var(--anim-dur) * 1.15) cubic-bezier(0.18, 1.75, 0.4, 1); }

  /* Bounce — -200px drop + 0.88 squish */
  .chat-fire.anim-bounce { transform: translateX(-50%) translateY(-200px) scale(0.88); }
  .chat-fire.anim-bounce.visible { transform: translateX(-50%) translateY(0) scale(1); transition: opacity calc(var(--anim-dur) * 0.28) ease, transform calc(var(--anim-dur) * 1.2) cubic-bezier(0.2, 1.95, 0.42, 1); }

  /* Split — scaleX 0 + scaleY 0.6 squash on rebound */
  .chat-fire.anim-split { transform: translateX(-50%) scaleX(0) scaleY(0.6); transform-origin: center; }
  .chat-fire.anim-split.visible { transform: translateX(-50%) scaleX(1) scaleY(1); transition: opacity calc(var(--anim-dur) * 0.35) ease, transform calc(var(--anim-dur) * 1.15) cubic-bezier(0.2, 1.7, 0.4, 1); }

  /* Blur — 44px blur + 1.18 scale punch */
  .chat-fire.anim-blur { filter: blur(44px); transform: translateX(-50%) scale(1.18); }
  .chat-fire.anim-blur.visible { filter: blur(0px); transform: translateX(-50%) scale(1); transition: opacity calc(var(--anim-dur) * 0.5) ease, transform calc(var(--anim-dur) * 1.1) cubic-bezier(0.22, 1.4, 0.4, 1), filter calc(var(--anim-dur) * 1.3) ease-out; }

  /* Sparkle — brand-tinted glow, brighter punch */
  .chat-fire.anim-sparkle {
    transform: translateX(-50%) scale(0.84);
    filter: brightness(2.4) drop-shadow(0 0 0px var(--brand-accent));
  }
  .chat-fire.anim-sparkle.visible {
    transform: translateX(-50%) scale(1);
    filter: brightness(1) drop-shadow(0 0 28px var(--brand-accent));
    transition: opacity calc(var(--anim-dur) * 0.45) ease,
                transform calc(var(--anim-dur) * 1.2) cubic-bezier(0.22, 1.7, 0.42, 1),
                filter calc(var(--anim-dur) * 1.4) ease;
  }

  /* Typewriter — JS-driven character reveal of cf-name + cf-text. Cursor
     uses .cf-cursor (not .lt-cursor) to keep clearTypewriter scoped. */
  .chat-fire.anim-typewriter { transform: translateX(-50%); }
  .chat-fire.anim-typewriter .cf-cursor {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: var(--brand-accent);
    margin-left: 2px;
    vertical-align: text-bottom;
    animation: cursor-blink 0.6s step-end infinite;
  }
  .cf-card {
    background: rgba(30, 30, 46, 0.92);
    border: 1px solid rgba(102, 126, 234, 0.55);
    border-left: 4px solid #667eea;
    border-radius: 10px;
    padding: 18px 28px;
    backdrop-filter: blur(10px);
    min-width: 420px;
    font-family: Inter, system-ui, sans-serif;
  }
  .cf-name {
    font-size: 18px;
    font-weight: 700;
    color: #a5b4fc;
    margin-bottom: 6px;
    letter-spacing: 0.3px;
  }
  .cf-text {
    font-size: 26px;
    font-weight: 600;
    color: #ffffff;
    line-height: 1.35;
    word-wrap: break-word;
  }

  /* ── Feature Card (2026-05-04) ────────────────────────────────────────
     Full-bleed broadcast graphic with TWO modes (upNext / thatWas). Slides
     in from a random direction per fire with bounce ease-in-out + motion
     blur. Surface is fully opaque (no backdrop-blur, no transparency).
     Bottom-right corner is intentionally left empty (no content) so the
     operator's OBS-side PIP camera (separate source in the FEATURE CARD
     scene) sits cleanly behind it.
  */
  .feature-card {
    position: absolute; inset: 0;
    width: 1920px; height: 1080px;
    color: #ffffff;
    pointer-events: none;
    visibility: hidden;
    transform: translateY(100%);
    filter: blur(0px);
    opacity: 0;
  }
  .feature-card.visible { visibility: visible; opacity: 1; }
  .feature-card.slide-up   { --fc-from: translateY( 100%); }
  .feature-card.slide-down { --fc-from: translateY(-100%); }
  .feature-card.slide-left { --fc-from: translateX( 100%); }
  .feature-card.slide-right{ --fc-from: translateX(-100%); }
  .feature-card.entering {
    animation: fcEnter 0.85s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }
  .feature-card.exiting {
    animation: fcExit 0.65s cubic-bezier(0.55, 0.05, 0.6, 0.05) forwards;
  }
  @keyframes fcEnter {
    0%   { transform: var(--fc-from); filter: blur(14px); opacity: 0; }
    35%  { filter: blur(8px); opacity: 1; }
    72%  { transform: translate(0,0); filter: blur(2px); }
    100% { transform: translate(0,0); filter: blur(0px); opacity: 1; }
  }
  @keyframes fcExit {
    0%   { transform: translate(0,0); filter: blur(0px); opacity: 1; }
    100% { transform: var(--fc-from); filter: blur(14px); opacity: 0; }
  }
  .fc-bg {
    position: absolute; inset: 0;
    background:
      radial-gradient(ellipse at 18% 22%, rgba(102,126,234,0.42) 0%, transparent 55%),
      radial-gradient(ellipse at 82% 78%, rgba(var(--brand-accent-rgb, 156 109 255) / 0.30) 0%, transparent 60%),
      linear-gradient(135deg, #0d0f1d 0%, #14172a 45%, #1c1f3a 100%);
  }
  .fc-bg::before {
    content: '';
    position: absolute; inset: 0;
    background:
      repeating-linear-gradient(135deg, rgba(255,255,255,0.018) 0 2px, transparent 2px 6px),
      radial-gradient(circle at 50% 50%, transparent 60%, rgba(0,0,0,0.55) 100%);
    pointer-events: none;
  }
  .fc-bg::after {
    /* brand-accent stripe — subtle top diagonal slash */
    content: '';
    position: absolute; left: 0; top: 0; right: 0; height: 6px;
    background: linear-gradient(90deg, transparent 0%, var(--brand-accent) 50%, transparent 100%);
    opacity: 0.85;
    box-shadow: 0 0 24px var(--brand-accent);
  }
  .fc-content {
    position: absolute; inset: 56px 64px;
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: 28px;
    /* Reserve bottom-right corner (PIP zone) at 540×304 px (16:9 quarter) */
    grid-template-columns: 1fr;
    z-index: 3;  /* above bg/sparkles/glow-ring */
  }
  .fc-header-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 24px;
  }
  .fc-header {
    font-family: 'Bebas Neue', 'Anton', 'Arial Black', sans-serif;
    font-size: 64px; letter-spacing: 0.08em;
    color: var(--brand-accent);
    line-height: 1;
    text-align: center;
    text-shadow:
      0 0 28px rgba(0,0,0,0.5),
      0 0 18px color-mix(in srgb, var(--brand-accent) 60%, transparent);
    animation: fcHeaderGlow 3.4s ease-in-out infinite;
  }
  @keyframes fcHeaderGlow {
    0%, 100% { text-shadow: 0 0 28px rgba(0,0,0,0.5), 0 0 14px color-mix(in srgb, var(--brand-accent) 35%, transparent); }
    50%      { text-shadow: 0 0 28px rgba(0,0,0,0.5), 0 0 38px color-mix(in srgb, var(--brand-accent) 80%, transparent); }
  }
  /* Tenant brand-logo lockup, top-left of card. Source: /brand-logo HTTP route
     (settings.branding.brandLogoUrl). Hidden if route 404s. */
  .fc-brand-lockup {
    position: relative;
    width: 240px; height: 130px;
    display: flex; align-items: center; justify-content: flex-start;
    overflow: hidden;
    justify-self: start;
    filter: drop-shadow(0 0 14px rgba(255,255,255,0.18));
  }
  .fc-brand-lockup img {
    max-width: 100%; max-height: 100%; object-fit: contain;
    display: block;
  }
  .fc-brand-lockup::after {
    /* shimmer sweep — left-to-right gloss every 4.5s */
    content: '';
    position: absolute; inset: 0;
    background: linear-gradient(
      105deg,
      transparent 38%,
      rgba(255,255,255,0.45) 50%,
      transparent 62%
    );
    animation: fcShimmer 4.5s ease-in-out infinite;
    pointer-events: none;
    mix-blend-mode: screen;
  }
  @keyframes fcShimmer {
    0%   { transform: translateX(-130%); opacity: 0; }
    35%  { opacity: 1; }
    65%  { opacity: 1; }
    100% { transform: translateX( 130%); opacity: 0; }
  }
  .fc-brand-lockup.empty { visibility: hidden; }
  /* Studio logo (per-routine), top-right corner, de-emphasized. */
  .fc-studio-logo {
    width: 96px; height: 96px;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    justify-self: end;
    opacity: 0.88;
    filter: drop-shadow(0 0 14px rgba(0,0,0,0.6));
  }
  .fc-studio-logo img,
  .fc-studio-logo video {
    max-width: 100%; max-height: 100%; object-fit: contain;
  }
  .fc-studio-logo.empty { visibility: hidden; }
  /* Sparkle field — 14 SVG stars (3 sizes) at random positions, twinkling. */
  .fc-sparkles {
    position: absolute; inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 0;
  }
  .fc-sparkle {
    position: absolute;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><defs><radialGradient id='g' cx='50%25' cy='50%25' r='50%25'><stop offset='0%25' stop-color='%23fff' stop-opacity='1'/><stop offset='40%25' stop-color='%23fff' stop-opacity='0.85'/><stop offset='100%25' stop-color='%23fff' stop-opacity='0'/></radialGradient></defs><path d='M12 0 L13.5 10.5 L24 12 L13.5 13.5 L12 24 L10.5 13.5 L0 12 L10.5 10.5 Z' fill='url(%23g)'/></svg>");
    background-size: contain; background-repeat: no-repeat;
    opacity: 0;
    filter: drop-shadow(0 0 6px rgba(255,255,255,0.85));
    animation: fcSparkle 3s ease-in-out infinite;
    will-change: opacity, transform;
  }
  .fc-sparkle.fc-sparkle-sm { width: 10px;  height: 10px; }
  .fc-sparkle.fc-sparkle-md { width: 18px;  height: 18px; }
  .fc-sparkle.fc-sparkle-lg { width: 28px;  height: 28px; }
  @keyframes fcSparkle {
    0%, 100% { opacity: 0;    transform: scale(0.4) rotate(0deg); }
    45%      { opacity: 0.95; transform: scale(1.05) rotate(45deg); }
    60%      { opacity: 0.95; transform: scale(1.05) rotate(45deg); }
  }
  /* Conic-gradient ring border — slow rotation, brand-accent → gold cycle.
     @property requires Chromium 99+ (OBS CEF supports it). */
  @property --fc-ring-angle {
    syntax: '<angle>';
    initial-value: 0deg;
    inherits: false;
  }
  .fc-glow-ring {
    position: absolute; inset: 0;
    pointer-events: none;
    padding: 5px;
    background: conic-gradient(
      from var(--fc-ring-angle, 0deg),
      var(--brand-accent) 0deg,
      #ffd700 90deg,
      var(--brand-accent) 180deg,
      #ffd700 270deg,
      var(--brand-accent) 360deg
    );
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
            mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
            mask-composite: exclude;
    animation: fcRingSpin 8s linear infinite;
    opacity: 0.75;
    z-index: 1;
  }
  @keyframes fcRingSpin {
    to { --fc-ring-angle: 360deg; }
  }
  /* Title glow pulse — 2.4s soft halo synced to brand accent. */
  .fc-title {
    animation: fcTitlePulse 2.4s ease-in-out infinite;
  }
  @keyframes fcTitlePulse {
    0%, 100% {
      text-shadow:
        0 4px 16px rgba(0,0,0,0.55),
        0 0 18px color-mix(in srgb, var(--brand-accent) 0%, transparent);
    }
    50% {
      text-shadow:
        0 4px 16px rgba(0,0,0,0.55),
        0 0 42px color-mix(in srgb, var(--brand-accent) 65%, transparent),
        0 0 12px rgba(255,255,255,0.18);
    }
  }
  /* Keep .fc-content above the bg/sparkle/ring layers (without overriding
     position:absolute set in the original .fc-content rule above). */
  .fc-main {
    display: flex; flex-direction: column; gap: 18px;
    padding-right: 580px;  /* PIP zone reserve on the right */
    align-self: start;
  }
  .fc-entry {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 168px;
    color: var(--brand-accent);
    line-height: 0.92;
    letter-spacing: 0.02em;
  }
  .fc-entry::before { content: '#'; opacity: 0.55; margin-right: 4px; font-size: 0.6em; vertical-align: 0.35em; }
  .fc-title {
    font-family: 'Playfair Display', 'Georgia', serif;
    font-weight: 700;
    font-size: 88px;
    line-height: 1.04;
    text-shadow: 0 4px 16px rgba(0,0,0,0.55);
  }
  .fc-dancers {
    font-family: 'Inter', 'Segoe UI', sans-serif;
    font-weight: 500;
    font-size: 30px;
    line-height: 1.35;
    color: rgba(255,255,255,0.93);
    /* Multi-column auto-fit so 12-30 names spread evenly without overflow. */
    column-count: 2;
    column-gap: 56px;
    column-fill: balance;
    max-height: 360px;
    overflow: hidden;
  }
  .fc-dancers .fc-dancer-sep { color: var(--brand-accent); margin: 0 0.45em; opacity: 0.75; }
  .fc-meta {
    font-family: 'Inter', 'Segoe UI', sans-serif;
    font-weight: 600;
    font-size: 28px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.78);
  }
  .fc-meta .fc-meta-sep { color: var(--brand-accent); margin: 0 0.6em; }
  /* Bottom UP NEXT strip — only rendered in thatWas mode. */
  .fc-next-strip {
    align-self: end;
    padding: 18px 24px;
    background: linear-gradient(90deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.18) 80%, transparent 100%);
    border-left: 4px solid var(--brand-accent);
    display: flex;
    align-items: center;
    gap: 28px;
    /* Don't overlap PIP zone */
    margin-right: 580px;
  }
  .fc-next-header {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 32px;
    letter-spacing: 0.12em;
    color: var(--brand-accent);
  }
  .fc-next-entry {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 56px;
    color: rgba(255,255,255,0.95);
    line-height: 1;
  }
  .fc-next-entry::before { content: '#'; opacity: 0.5; }
  .fc-next-title {
    font-family: 'Playfair Display', serif;
    font-weight: 700;
    font-size: 36px;
    color: rgba(255,255,255,0.92);
  }
  .fc-next-studio {
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    font-size: 22px;
    letter-spacing: 0.04em;
    color: rgba(255,255,255,0.7);
    text-transform: uppercase;
  }
  /* Hide bottom strip in upNext mode */
  .feature-card[data-mode="upNext"] .fc-next-strip { display: none; }
  /* Suppress all other overlay elements while featureCard is visible. They
     fight for screen real estate; the card is the takeover surface. */
  body.fc-active .counter,
  body.fc-active .logo,
  body.fc-active .clock,
  body.fc-active .lower-third,
  body.fc-active #ticker,
  body.fc-active #starting-soon,
  body.fc-active .chat-fire { opacity: 0 !important; visibility: hidden !important; }

</style>
</head>
<body>
<div class="counter" id="counter">
  <div class="counter-box">
    <div class="counter-number" id="counterNumber"></div>
    <div class="counter-label" id="counterLabel" style="display:none"></div>
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
      <div class="lt-brand-glyph empty" id="ltBrandGlyph"><img id="ltBrandImg" src="" alt="" /></div>
      <div class="lt-number" id="ltNumber"></div>
      <div class="lt-stack">
        <div class="lt-title" id="ltTitle"></div>
        <div class="lt-dancers" id="ltDancers"></div>
      </div>
    </div>
    <div class="lt-meta" id="ltMeta"></div>
  </div>
</div>

<div id="starting-soon" class="starting-soon">
  <div class="ss-gradient-bg" id="ss-gradient"></div>
  <div class="ss-bloom" id="ss-bloom"></div>
  <div class="ss-grain" id="ss-grain"></div>
  <div class="ss-vignette" id="ss-vignette"></div>
  <div class="ss-venue-id" id="ss-venue-id"></div>
  <div class="ss-section-badge" id="ss-section-badge"></div>
  <div class="ss-logo" id="ss-logo"><div class="ss-logo-plate" id="ss-logo-plate"></div><div class="ss-logo-halo" id="ss-logo-halo"></div><div class="ss-logo-img-wrap"><img id="ss-logo-img" src="" alt="" /></div></div>
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
  <div class="ss-ticker-block" id="ss-ticker-block">
    <div class="ss-ticker-accent" id="ss-ticker-accent">
      <span class="ss-ticker-cat" id="ss-ticker-cat"></span>
      <span class="ss-ticker-live" id="ss-ticker-live" style="display:none">LIVE</span>
    </div>
    <div class="ss-ticker-rail" id="ss-ticker-rail"><div class="ss-ticker-rail-inner" id="ss-ticker-rail-inner"></div></div>
  </div>
  <div class="ss-final-cd" id="ss-final-cd">
    <div class="ss-final-cd-label" id="ss-final-cd-label">FINAL 30 SECONDS</div>
    <div class="ss-final-cd-digits" id="ss-final-cd-digits"></div>
    <div class="ss-final-cd-sub" id="ss-final-cd-sub">Show begins shortly</div>
  </div>
</div>

<!-- Chat fire (commit 6) — transient LT-style broadcast when operator pins a chat message -->
<div class="chat-fire" id="chat-fire">
  <div class="cf-card">
    <div class="cf-name" id="cf-name"></div>
    <div class="cf-text" id="cf-text"></div>
  </div>
</div>

<!-- Feature Card (2026-05-04, beauty pass 2026-05-05) — full-screen broadcast graphic, two modes -->
<div class="feature-card" id="featureCard" data-mode="upNext">
  <div class="fc-bg"></div>
  <div class="fc-sparkles" id="fc-sparkles"></div>
  <div class="fc-glow-ring"></div>
  <div class="fc-content">
    <div class="fc-header-row">
      <div class="fc-brand-lockup empty" id="fc-brand-lockup">
        <img id="fc-brand-img" src="" alt="" />
      </div>
      <div class="fc-header" id="fc-header">UP NEXT</div>
      <div class="fc-studio-logo empty" id="fc-studio-logo"></div>
    </div>
    <div class="fc-main">
      <div class="fc-entry" id="fc-entry"></div>
      <div class="fc-title" id="fc-title"></div>
      <div class="fc-dancers" id="fc-dancers"></div>
      <div class="fc-meta" id="fc-meta"></div>
    </div>
    <div class="fc-next-strip" id="fc-next-strip">
      <div class="fc-next-header">UP NEXT</div>
      <div class="fc-next-entry" id="fc-next-entry"></div>
      <div class="fc-next-title" id="fc-next-title"></div>
      <div class="fc-next-studio" id="fc-next-studio"></div>
    </div>
  </div>
</div>

<script>
  const WS_URL = 'ws://localhost:9877';
  const LT_ANIMS = ['anim-slide','anim-zoom','anim-fade','anim-rise','anim-sparkle','anim-typewriter','anim-bounce','anim-split','anim-blur'];
  let ws = null;
  let reconnectDelay = 1000;
  let lastCounterEntry = '';
  // Counter advance — premium animation pack. Pick a random variant per
  // advance, no-repeat with prior so consecutive advances always look fresh.
  const COUNTER_VARIANTS = ['v1','v2','v3','v4','v5','v6'];
  let lastCounterVariant = '';
  function pickCounterVariant() {
    if (COUNTER_VARIANTS.length === 1) return COUNTER_VARIANTS[0];
    let pick;
    let guard = 0;
    do {
      pick = COUNTER_VARIANTS[Math.floor(Math.random() * COUNTER_VARIANTS.length)];
      guard++;
    } while (pick === lastCounterVariant && guard < 6);
    lastCounterVariant = pick;
    return pick;
  }
  let currentAnim = '';
  let currentChatFireAnim = '';
  let lastChatFireId = '';
  let typewriterTimer = null;
  let cfTypewriterTimer = null;
  let lastLtFingerprint = '';
  let lastLtAnimConfigPrint = '';
  let lastFeatureCardFiredAt = 0;
  let lastFeatureCardVisible = false;
  let fcExitTimer = null;
  let countdownInterval = null;
  let timeDateInterval = null;
  // SS scene-entry orchestration. The first-show class drives staggered
  // enter animations on each child; remove after entry so subsequent state
  // pings dont re-fire it.
  let lastSsVisible = false;
  let ssFirstShowTimer = null;

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

  // 2026-05-04 unified depth — apply card / sub-element style overlays. Idle
  // values (fontSize=0, color='', fontWeight=0, borderWidth=-1) skip the
  // assignment so the existing CSS default wins. backgroundColor='' similarly
  // leaves the gradient untouched. backgroundOpacity != 1 multiplies into
  // an rgba override only when backgroundColor is set (otherwise the existing
  // gradient stays in charge).
  function applyElementCard(rootEl, card) {
    if (!rootEl || !card) return;
    if (card.backgroundColor) {
      // Convert hex+opacity to rgba so existing card background is overridden.
      var hex = card.backgroundColor.replace('#','');
      var op = (typeof card.backgroundOpacity === 'number') ? card.backgroundOpacity : 1;
      if (hex.length === 6) {
        var r = parseInt(hex.substr(0,2),16);
        var g = parseInt(hex.substr(2,2),16);
        var b = parseInt(hex.substr(4,2),16);
        rootEl.style.background = 'rgba(' + r + ',' + g + ',' + b + ',' + op + ')';
      } else {
        rootEl.style.background = card.backgroundColor;
      }
    }
    if (typeof card.backdropBlur === 'number' && card.backdropBlur > 0) {
      rootEl.style.backdropFilter = 'blur(' + card.backdropBlur + 'px)';
      rootEl.style.webkitBackdropFilter = 'blur(' + card.backdropBlur + 'px)';
    }
    if (typeof card.paddingX === 'number' && card.paddingX > 0 &&
        typeof card.paddingY === 'number' && card.paddingY > 0) {
      rootEl.style.padding = card.paddingY + 'px ' + card.paddingX + 'px';
    } else if (typeof card.paddingX === 'number' && card.paddingX > 0) {
      rootEl.style.paddingLeft = card.paddingX + 'px';
      rootEl.style.paddingRight = card.paddingX + 'px';
    } else if (typeof card.paddingY === 'number' && card.paddingY > 0) {
      rootEl.style.paddingTop = card.paddingY + 'px';
      rootEl.style.paddingBottom = card.paddingY + 'px';
    }
    if (typeof card.innerGap === 'number' && card.innerGap > 0) {
      rootEl.style.gap = card.innerGap + 'px';
    }
    if (typeof card.borderRadius === 'number' && card.borderRadius > 0) {
      rootEl.style.borderRadius = card.borderRadius + 'px';
    }
    if (typeof card.borderWidth === 'number' && card.borderWidth >= 0) {
      var bc = card.borderColor || 'rgba(255,255,255,0.4)';
      rootEl.style.border = card.borderWidth + 'px solid ' + bc;
    } else if (card.borderColor) {
      rootEl.style.borderColor = card.borderColor;
    }
  }

  function applySubElementStyle(el, sub) {
    if (!el || !sub) return;
    if (typeof sub.fontSize === 'number' && sub.fontSize > 0) el.style.fontSize = sub.fontSize + 'px';
    if (sub.color) el.style.color = sub.color;
    if (typeof sub.fontWeight === 'number' && sub.fontWeight > 0) el.style.fontWeight = String(sub.fontWeight);
    if (typeof sub.order === 'number') el.style.order = String(sub.order);
    if (sub.show === false) el.style.display = 'none';
  }

  // Swap an asset host container's inner element to <video> or <img> based on
  // assetUrl extension. assetUrl is empty by default — we then leave the
  // existing /brand-logo <img> chain alone (back-compat). When set: we mount
  // either a video tag (mp4/webm/mov/m4v with autoplay/loop/muted/playsinline)
  // or an img tag (png/jpg/svg/webp/gif/apng/avif). 'none' = clear container.
  function mountElementAsset(containerEl, key, assetUrl) {
    if (!containerEl) return;
    if (!assetUrl) {
      // No override — leave whatever's already in the container intact (the
      // legacy /brand-logo img path keeps working unchanged).
      return;
    }
    var lower = String(assetUrl).toLowerCase().split('?')[0].split('#')[0];
    var isVideo = /\\.(mp4|webm|mov|m4v)$/.test(lower);
    var bust = 0;
    for (var i = 0; i < assetUrl.length; i++) { bust = ((bust << 5) - bust) + assetUrl.charCodeAt(i); bust |= 0; }
    var src = '/element-asset?key=' + encodeURIComponent(key) + '&v=' + Math.abs(bust);
    var existing = containerEl.firstElementChild;
    var wantTag = isVideo ? 'VIDEO' : 'IMG';
    if (existing && existing.tagName === wantTag && existing.dataset.assetSrc === src) {
      return; // already correct
    }
    // Replace inner element.
    while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
    var node;
    if (isVideo) {
      node = document.createElement('video');
      node.autoplay = true;
      node.loop = true;
      node.muted = true;
      node.setAttribute('playsinline', '');
      node.setAttribute('muted', '');
      node.setAttribute('autoplay', '');
      node.setAttribute('loop', '');
      node.style.maxWidth = '100%';
      node.style.maxHeight = '100%';
      node.style.objectFit = 'contain';
    } else {
      node = document.createElement('img');
      node.style.maxWidth = '100%';
      node.style.maxHeight = '100%';
      node.style.objectFit = 'contain';
    }
    node.dataset.assetSrc = src;
    node.src = src;
    containerEl.appendChild(node);
  }

  function applyState(state) {
    const o = state.overlay;
    if (state.overlayLayout) {
      // Cache layout for the clock-slide logic that needs to reapply on
      // every state change (counter visibility toggles don't include the
      // overlayLayout in the state push).
      window._cachedOverlayLayout = state.overlayLayout;
      var L = state.overlayLayout;
      var ce = document.getElementById('counter');
      ce.style.left = L.counter.x + '%'; ce.style.top = L.counter.y + '%'; ce.style.right = 'auto';
      var le = document.getElementById('logo');
      le.style.left = L.logo.x + '%'; le.style.top = L.logo.y + '%';
      if (typeof L.logo.width === 'number') le.style.width = L.logo.width + '%';
      if (typeof L.logo.height === 'number') le.style.height = L.logo.height + '%';
      var te = document.getElementById('lt');
      te.style.left = L.lowerThird.x + '%'; te.style.top = L.lowerThird.y + '%'; te.style.bottom = 'auto';
    }
    // Burlington UDC 2026-05-01: clock-slide. Runs on EVERY state update
    // (not just layout updates) because counter visibility toggles don't
    // re-emit overlayLayout. When counter is hidden but clock is visible,
    // clock takes the counter's slot. CSS transition smooths the move.
    var Lcached = window._cachedOverlayLayout;
    if (Lcached) {
      var ke = document.getElementById('clock');
      if (ke) {
        var clockTakesCounterSlot = !o.counter.visible && o.clock.visible;
        var clockX = clockTakesCounterSlot ? Lcached.counter.x : Lcached.clock.x;
        var clockY = clockTakesCounterSlot ? Lcached.counter.y : Lcached.clock.y;
        ke.style.left = clockX + '%'; ke.style.top = clockY + '%'; ke.style.right = 'auto';
      }
    }
    const counterEl = document.getElementById('counter');
    const counterNum = document.getElementById('counterNumber');
    const counterLabel = document.getElementById('counterLabel');
    if (o.counter.visible) {
      counterEl.classList.add('visible');
      if (o.counter.entryNumber !== lastCounterEntry && lastCounterEntry !== '') {
        counterEl.classList.remove('advance', 'v1','v2','v3','v4','v5','v6');
        void counterEl.offsetWidth;
        counterEl.classList.add('advance', pickCounterVariant());
      }
      lastCounterEntry = o.counter.entryNumber;
      counterNum.textContent = o.counter.entryNumber;
      if (counterLabel) {
        var awards = o.counter.nextAwardsTime;
        if (awards) {
          counterLabel.textContent = 'NEXT AWARDS ' + awards;
          counterLabel.style.display = '';
        } else {
          counterLabel.style.display = 'none';
        }
      }
    } else {
      counterEl.classList.remove('visible');
    }
    const logoEl = document.getElementById('logo');
    const logoImg = document.getElementById('logoImg');
    if (o.logo.visible && o.logo.url) {
      logoEl.classList.add('visible');
      // Chromium blocks file:// from http:// origin inside iframe preview. Serve
      // the logo via /brand-logo HTTP route (same pattern as ss-logo in r19 fix).
      var logoBust = 0;
      for (var i = 0; i < o.logo.url.length; i++) { logoBust = ((logoBust << 5) - logoBust) + o.logo.url.charCodeAt(i); logoBust |= 0; }
      logoImg.src = '/brand-logo?v=' + Math.abs(logoBust);
    } else {
      logoEl.classList.remove('visible');
    }
    const clockEl = document.getElementById('clock');
    if (o.clock.visible) clockEl.classList.add('visible');
    else clockEl.classList.remove('visible');

    // Animation timing from animConfig
    var durVal = (o.animConfig && o.animConfig.animationDuration) || 0.5;
    var dur = durVal + 's';
    var easingMap = { ease:'ease', 'ease-in':'ease-in', 'ease-out':'ease-out', 'ease-in-out':'ease-in-out', linear:'linear', bounce:'cubic-bezier(0.34,1.56,0.64,1)', elastic:'cubic-bezier(0.68,-0.55,0.27,1.55)' };
    var ease = easingMap[(o.animConfig && o.animConfig.animationEasing)] || 'ease';

    const ltEl = document.getElementById('lt');

    // 2026-05-02 (Burlington UDC Day 2): brand glyph mounted on the LT card.
    // Loaded once and cached by the browser; .empty class hides it when the
    // tenant has no brand logo configured. Source is the same /brand-logo
    // route used by the legacy logo overlay and ss-logo.
    var ltBrandImg = document.getElementById('ltBrandImg');
    var ltBrandGlyph = document.getElementById('ltBrandGlyph');
    if (ltBrandImg && ltBrandGlyph && !ltBrandImg.dataset.loaded) {
      ltBrandImg.dataset.loaded = '1';
      ltBrandImg.onload = function () { ltBrandGlyph.classList.remove('empty'); };
      ltBrandImg.onerror = function () { ltBrandGlyph.classList.add('empty'); };
      ltBrandImg.src = '/brand-logo?v=lt';
    }

    // Idempotency guard: the recording-timer broadcasts state ~1Hz while
    // recording. Without this guard every broadcast re-ran the LT setup
    // (text wipe, typewriter restart, RAF add-visible). Typewriter then
    // flashed once per second. Only re-render the LT block when the fire
    // payload actually changes (entry, title, dancers, studio, category,
    // flags, animation type, visibility). Broadcasts that don't touch the
    // lower third become no-ops here.
    var ltFingerprint = o.lowerThird.visible
      ? [
          'v',
          o.lowerThird.entryNumber,
          o.lowerThird.routineTitle,
          o.lowerThird.dancers,
          o.lowerThird.studioName,
          o.lowerThird.category,
          o.lowerThird.animation || 'random',
          o.lowerThird.showBrandGlyph === false ? 0 : 1,
          o.lowerThird.showEntryNumber === false ? 0 : 1,
          o.lowerThird.showRoutineTitle === false ? 0 : 1,
          o.lowerThird.showDancers === false ? 0 : 1,
          o.lowerThird.showStudioName === false ? 0 : 1,
          o.lowerThird.showCategory === false ? 0 : 1,
        ].join('|')
      : 'hidden';

    // showBrandGlyph: hide the LT brand-logo capsule independently of whether
    // the brand logo URL loads. Operator can opt out from the VisualEditor.
    if (ltBrandGlyph) {
      ltBrandGlyph.style.display = o.lowerThird.showBrandGlyph === false ? 'none' : '';
    }
    var ltAnimConfigPrint = dur + '|' + ease;

    if (ltAnimConfigPrint !== lastLtAnimConfigPrint) {
      ltEl.style.setProperty('--anim-dur', dur);
      ltEl.style.setProperty('--anim-ease', ease);
      lastLtAnimConfigPrint = ltAnimConfigPrint;
    }

    if (ltFingerprint === lastLtFingerprint) {
      // No LT-relevant change — skip entirely (no clearTypewriter, no
      // classList churn, no text reset, no RAF).
    } else if (o.lowerThird.visible) {
      lastLtFingerprint = ltFingerprint;
      // Genuine fire or routine-data change: (re)run setup.
      clearTypewriter();
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
      lastLtFingerprint = ltFingerprint;
      clearTypewriter();
      ltEl.classList.remove('visible');
      if (currentAnim) {
        var clearAnimLt = currentAnim;
        currentAnim = '';
        setTimeout(() => { ltEl.classList.remove(clearAnimLt); }, 600);
      }
    }

    // Ticker
    if (o.ticker) {
      var tickerEl = document.getElementById('ticker');
      var tickerText = document.getElementById('ticker-text');
      tickerText.textContent = o.ticker.text || '';
      tickerEl.style.background = o.ticker.backgroundColor || '#1e1e2e';
      tickerText.style.color = o.ticker.textColor || '#ffffff';
      var speed = o.ticker.speed || 60;
      var duration = Math.max(10, 1920 / speed * 2);
      tickerText.style.animationDuration = duration + 's';
      tickerEl.classList.toggle('visible', o.ticker.visible);
    }

    // Starting Soon
    if (o.startingSoon) {
      applyStartingSoon(o.startingSoon, state.ssConfig, o.logo ? o.logo.url : '', state);
    }

    // 2026-05-04 unified depth — apply per-element card / sub-element styles.
    // Defaults are no-op (fontSize=0, color='', borderWidth=-1) so this branch
    // is invisible to the operator until they tweak something in VisualEditor.
    try {
      // Counter — root .counter-box gets card; sub-elements: number + label.
      if (o.counter && o.counter.card) {
        var counterBox = document.querySelector('#counter .counter-box');
        if (counterBox) applyElementCard(counterBox, o.counter.card);
        var subC = o.counter.subElements || {};
        applySubElementStyle(document.getElementById('counterNumber'), subC.number);
        applySubElementStyle(document.getElementById('counterLabel'), subC.label);
      }
      // Clock — root .clock-box; sub-elements: time + date.
      if (o.clock && o.clock.card) {
        var clockBox = document.querySelector('#clock .clock-box');
        if (clockBox) applyElementCard(clockBox, o.clock.card);
        var subK = o.clock.subElements || {};
        applySubElementStyle(document.getElementById('clockTime'), subK.time);
        applySubElementStyle(document.getElementById('clockDate'), subK.date);
      }
      // Logo — assetUrl override + card on root .logo container.
      if (o.logo) {
        var logoContainer = document.getElementById('logo');
        if (o.logo.card) applyElementCard(logoContainer, o.logo.card);
        if (o.logo.assetUrl) {
          mountElementAsset(logoContainer, 'logo', o.logo.assetUrl);
        }
        var subL = (o.logo.subElements) || {};
        if (subL.image) {
          var inner = logoContainer && logoContainer.firstElementChild;
          if (inner) applySubElementStyle(inner, subL.image);
        }
      }
      // Lower Third — card on .lt-card; sub-elements include brandGlyph,
      // entryNumber, routineTitle, dancers, studioName, category. Asset
      // override is brandGlyphUrl (mounted into #ltBrandGlyph container).
      if (o.lowerThird) {
        var ltCard = document.querySelector('#lt .lt-card');
        if (o.lowerThird.card) applyElementCard(ltCard, o.lowerThird.card);
        if (o.lowerThird.brandGlyphUrl) {
          mountElementAsset(document.getElementById('ltBrandGlyph'), 'lowerthird', o.lowerThird.brandGlyphUrl);
        }
        var subLT = o.lowerThird.subElements || {};
        applySubElementStyle(document.getElementById('ltBrandGlyph'), subLT.brandGlyph);
        applySubElementStyle(document.getElementById('ltNumber'), subLT.entryNumber);
        applySubElementStyle(document.getElementById('ltTitle'), subLT.routineTitle);
        applySubElementStyle(document.getElementById('ltDancers'), subLT.dancers);
        // Meta is studio + category combined; partial sub-element styling
        // applies to the meta line as a whole (use studioName slot).
        applySubElementStyle(document.getElementById('ltMeta'), subLT.studioName || subLT.category);
      }
      // Ticker — card on root #ticker bar; sub-element 'text' on the scrolling text.
      if (o.ticker) {
        var tickerEl2 = document.getElementById('ticker');
        if (o.ticker.card) applyElementCard(tickerEl2, o.ticker.card);
        var subT = o.ticker.subElements || {};
        applySubElementStyle(document.getElementById('ticker-text'), subT.text);
      }
      // Starting Soon — assetUrl override on #ss-logo + card on .starting-soon root.
      if (o.startingSoon) {
        var ssRoot = document.getElementById('starting-soon');
        if (o.startingSoon.card) applyElementCard(ssRoot, o.startingSoon.card);
        if (o.startingSoon.assetUrl) {
          mountElementAsset(document.getElementById('ss-logo'), 'startingsoon', o.startingSoon.assetUrl);
        }
        var subSS = o.startingSoon.subElements || {};
        applySubElementStyle(document.getElementById('ss-logo'), subSS.logo);
        applySubElementStyle(document.getElementById('ss-title'), subSS.title);
        applySubElementStyle(document.getElementById('ss-accent'), subSS.accent);
        applySubElementStyle(document.getElementById('ss-subtitle'), subSS.subtitle);
        applySubElementStyle(document.getElementById('ss-countdown'), subSS.countdown);
      }
    } catch (e) { console.warn('[overlay] per-element style apply failed: ' + e); }

    // --- Chat Fire (commit 6) ---
    // Transient LT-style broadcast when operator pins a chat message.
    // Inherits animation from lowerThird + autoHideSeconds from animConfig.
    // 2026-04-25 (v11): console diagnostics so the browser-side pipeline
    // can be inspected in OBS Browser Source dev tools when fires don't render.
    // 2026-04-25 (v15-fix): MOVED here from applyStartingSoon — that scope
    // didn't see o/dur/ease, so cfState was always undefined and the entire
    // branch was silently dead.
    var cfEl = document.getElementById('chat-fire');
    var cfState = o && o.chatFire;
    if (cfEl) {
      cfEl.style.setProperty('--anim-dur', dur);
      cfEl.style.setProperty('--anim-ease', ease);
      if (cfState && cfState.visible) {
        if (cfState.messageId && cfState.messageId !== lastChatFireId) {
          console.warn('[chat-fire] NEW FIRE id=' + cfState.messageId + ' user=' + JSON.stringify(cfState.username) + ' msg=' + JSON.stringify((cfState.message || '').slice(0, 40)) + ' anim=' + cfState.animation);
          lastChatFireId = cfState.messageId;
          LT_ANIMS.forEach(function(a) { cfEl.classList.remove(a); });
          cfEl.classList.remove('visible');
          var cfAnim = cfState.animation || 'random';
          if (cfAnim === 'random') {
            currentChatFireAnim = LT_ANIMS[Math.floor(Math.random() * LT_ANIMS.length)];
          } else {
            currentChatFireAnim = 'anim-' + cfAnim;
          }
          cfEl.classList.add(currentChatFireAnim);
          var cfName = document.getElementById('cf-name');
          var cfText = document.getElementById('cf-text');
          // Cancel any prior typewriter run + remove leftover cursors
          if (cfTypewriterTimer) { clearInterval(cfTypewriterTimer); cfTypewriterTimer = null; }
          var oldCursors = cfEl.querySelectorAll('.cf-cursor');
          for (var ci = 0; ci < oldCursors.length; ci++) oldCursors[ci].remove();
          var cfFullName = cfState.username || 'Anonymous';
          var cfFullText = cfState.message || '';
          if (currentChatFireAnim === 'anim-typewriter') {
            if (cfName) cfName.textContent = '';
            if (cfText) cfText.textContent = '';
          } else {
            if (cfName) cfName.textContent = cfFullName;
            if (cfText) cfText.textContent = cfFullText;
          }
          requestAnimationFrame(function() {
            cfEl.classList.add('visible');
            cfEl.style.opacity = '1';
            cfEl.style.display = 'block';
            cfEl.style.visibility = 'visible';

            if (currentChatFireAnim === 'anim-typewriter' && cfName && cfText) {
              var totalCf = cfFullName.length + cfFullText.length;
              if (totalCf > 0) {
                var charDelayCf = Math.max(20, (durVal * 1000) / totalCf);
                var idxCf = 0;
                var cursorCf = document.createElement('span');
                cursorCf.className = 'cf-cursor';
                cfName.appendChild(cursorCf);
                cfTypewriterTimer = setInterval(function () {
                  if (idxCf < cfFullName.length) {
                    cfName.textContent = cfFullName.substring(0, idxCf + 1);
                    cfName.appendChild(cursorCf);
                  } else {
                    cfName.textContent = cfFullName;
                    var siCf = idxCf - cfFullName.length;
                    cfText.textContent = cfFullText.substring(0, siCf + 1);
                    cfText.appendChild(cursorCf);
                  }
                  idxCf++;
                  if (idxCf >= totalCf) {
                    clearInterval(cfTypewriterTimer);
                    cfTypewriterTimer = null;
                    cfName.textContent = cfFullName;
                    cfText.textContent = cfFullText;
                    setTimeout(function () { cursorCf.remove(); }, 800);
                  }
                }, charDelayCf);
              }
            }

            var rect = cfEl.getBoundingClientRect();
            var cs = getComputedStyle(cfEl);
            console.warn('[chat-fire] visible class added — rect=' + JSON.stringify({ x: rect.x, y: rect.y, w: rect.width, h: rect.height }) + ' opacity=' + cs.opacity + ' display=' + cs.display + ' visibility=' + cs.visibility + ' position=' + cs.position + ' zIndex=' + cs.zIndex + ' classes=' + cfEl.className);
          });
        } else {
          cfEl.classList.add('visible');
        }
      } else {
        if (cfEl.classList.contains('visible')) {
          console.warn('[chat-fire] HIDE — removing visible class');
          cfEl.classList.remove('visible');
          cfEl.style.opacity = '0';
          // Cancel any in-flight typewriter run + strip leftover cursor.
          if (cfTypewriterTimer) { clearInterval(cfTypewriterTimer); cfTypewriterTimer = null; }
          var leftoverCursors = cfEl.querySelectorAll('.cf-cursor');
          for (var lci = 0; lci < leftoverCursors.length; lci++) leftoverCursors[lci].remove();
          var clearAnim = currentChatFireAnim;
          setTimeout(function() {
            if (clearAnim) cfEl.classList.remove(clearAnim);
            var cfN = document.getElementById('cf-name');
            var cfT = document.getElementById('cf-text');
            if (cfN) cfN.textContent = '';
            if (cfT) cfT.textContent = '';
          }, 600);
          currentChatFireAnim = '';
          lastChatFireId = '';
        }
      }
    } else {
      if (cfState && cfState.visible) {
        console.error('[chat-fire] element #chat-fire NOT FOUND in DOM but state says visible=true');
      }
    }

    // ── Feature Card ──
    var fc = o && o.featureCard;
    var fcEl = document.getElementById('featureCard');
    if (fcEl && fc) {
      var fcMode = fc.mode || 'upNext';
      var fcDir = fc.slideDirection || 'up';
      var fcShouldShow = !!fc.visible;
      var fcRetrigger = (fc.firedAt && fc.firedAt !== lastFeatureCardFiredAt);

      // Body class flips overlay-element suppression on/off in one CSS rule.
      if (fcShouldShow) document.body.classList.add('fc-active');
      else document.body.classList.remove('fc-active');

      // (Re)populate text. Idempotent on every state push — cheap.
      fcEl.setAttribute('data-mode', fcMode);
      var fcHeader = document.getElementById('fc-header');
      if (fcHeader) fcHeader.textContent = (fcMode === 'thatWas') ? 'THAT WAS' : 'UP NEXT';
      var fcEntry = document.getElementById('fc-entry');
      if (fcEntry) fcEntry.textContent = fc.entryNumber || '';
      var fcTitle = document.getElementById('fc-title');
      if (fcTitle) fcTitle.textContent = fc.routineTitle || '';
      var fcDancers = document.getElementById('fc-dancers');
      if (fcDancers) {
        // Dot-separated rendering with brand-accent separators between names.
        var fcRaw = (fc.dancers || '').split(/\s*[,·]\s*/).filter(function(s){ return s.length > 0; });
        var fcOut = '';
        for (var di = 0; di < fcRaw.length; di++) {
          if (di > 0) fcOut += '<span class="fc-dancer-sep">·</span>';
          fcOut += fcRaw[di].replace(/[<>&]/g, function(c){ return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;'; });
        }
        fcDancers.innerHTML = fcOut;
      }
      var fcMeta = document.getElementById('fc-meta');
      if (fcMeta) {
        var fcMetaParts = [];
        if (fc.studioName) fcMetaParts.push(fc.studioName);
        if (fc.category) fcMetaParts.push(fc.category);
        var fcMetaHtml = '';
        for (var mi = 0; mi < fcMetaParts.length; mi++) {
          if (mi > 0) fcMetaHtml += '<span class="fc-meta-sep">/</span>';
          fcMetaHtml += fcMetaParts[mi].replace(/[<>&]/g, function(c){ return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;'; });
        }
        fcMeta.innerHTML = fcMetaHtml;
      }
      // Bottom strip (thatWas mode only — CSS hides in upNext)
      var fcNextEntry = document.getElementById('fc-next-entry');
      if (fcNextEntry) fcNextEntry.textContent = fc.nextEntryNumber || '';
      var fcNextTitle = document.getElementById('fc-next-title');
      if (fcNextTitle) fcNextTitle.textContent = fc.nextRoutineTitle || '';
      var fcNextStudio = document.getElementById('fc-next-studio');
      if (fcNextStudio) fcNextStudio.textContent = fc.nextStudioName || '';
      // Studio logo (assetUrl override or hidden if empty)
      var fcLogoEl = document.getElementById('fc-studio-logo');
      if (fcLogoEl) {
        if (fc.assetUrl && fc.assetUrl.length > 0) {
          // Pick img vs video based on extension. Reuses /element-asset route
          // pattern used by the existing element editor for operator-browsed
          // local files (avoids file:// CORS in iframe).
          var url = fc.assetUrl;
          var lower = url.toLowerCase().split('?')[0];
          var isVideo = /\.(mp4|webm|mov|m4v)$/.test(lower);
          var bust = 0;
          for (var ui = 0; ui < url.length; ui++) { bust = ((bust << 5) - bust) + url.charCodeAt(ui); bust |= 0; }
          var src = '/element-asset?key=featureCard&v=' + Math.abs(bust);
          if (isVideo) {
            if (fcLogoEl.firstChild && fcLogoEl.firstChild.tagName !== 'VIDEO') fcLogoEl.innerHTML = '';
            if (!fcLogoEl.firstChild) {
              var v = document.createElement('video');
              v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
              v.src = src;
              fcLogoEl.appendChild(v);
            }
          } else {
            if (fcLogoEl.firstChild && fcLogoEl.firstChild.tagName !== 'IMG') fcLogoEl.innerHTML = '';
            if (!fcLogoEl.firstChild) {
              var img = document.createElement('img');
              img.src = src;
              fcLogoEl.appendChild(img);
            }
          }
          fcLogoEl.classList.remove('empty');
        } else {
          fcLogoEl.classList.add('empty');
          fcLogoEl.innerHTML = '';
        }
      }

      // Tenant brand-logo lockup (top-left of card). Loads from /brand-logo HTTP
      // route — falls back to hidden if no logo configured (route 404s).
      var fcBrandLockup = document.getElementById('fc-brand-lockup');
      var fcBrandImg = document.getElementById('fc-brand-img');
      if (fcBrandLockup && fcBrandImg) {
        // Cache-bust per fire so logo updates pick up without iframe reload.
        if (fcRetrigger || !fcBrandImg.src || fcBrandImg.src.indexOf('/brand-logo') < 0) {
          fcBrandImg.onload  = function() { fcBrandLockup.classList.remove('empty'); };
          fcBrandImg.onerror = function() { fcBrandLockup.classList.add('empty'); };
          fcBrandImg.src = '/brand-logo?v=fc' + (fc.firedAt || Date.now());
        }
      }

      // Direction class — clear all then add the chosen one.
      ['slide-up','slide-down','slide-left','slide-right'].forEach(function(d){ fcEl.classList.remove(d); });
      fcEl.classList.add('slide-' + fcDir);

      if (fcShouldShow && (fcRetrigger || !lastFeatureCardVisible)) {
        // Slide IN — restart the entering animation cleanly.
        if (fcExitTimer) { clearTimeout(fcExitTimer); fcExitTimer = null; }
        fcEl.classList.remove('exiting');
        fcEl.classList.remove('entering');
        fcEl.classList.remove('visible');
        // Re-seed sparkle field with fresh random positions/delays per fire.
        var fcSparkleContainer = document.getElementById('fc-sparkles');
        if (fcSparkleContainer) {
          fcSparkleContainer.innerHTML = '';
          var fcSparkleSizes = ['fc-sparkle-sm','fc-sparkle-md','fc-sparkle-lg'];
          for (var fsi = 0; fsi < 14; fsi++) {
            var sp = document.createElement('div');
            sp.className = 'fc-sparkle ' + fcSparkleSizes[fsi % 3];
            sp.style.left = (Math.random() * 92 + 4) + '%';
            sp.style.top  = (Math.random() * 92 + 4) + '%';
            sp.style.animationDelay    = (Math.random() * 3).toFixed(2) + 's';
            sp.style.animationDuration = (2.4 + Math.random() * 1.6).toFixed(2) + 's';
            fcSparkleContainer.appendChild(sp);
          }
        }
        // Force reflow so the animation restarts.
        void fcEl.offsetWidth;
        fcEl.classList.add('visible');
        fcEl.classList.add('entering');
        lastFeatureCardFiredAt = fc.firedAt;
        lastFeatureCardVisible = true;
      } else if (!fcShouldShow && lastFeatureCardVisible) {
        // Slide OUT — exit animation, then drop visibility once it ends.
        fcEl.classList.remove('entering');
        fcEl.classList.add('exiting');
        if (fcExitTimer) clearTimeout(fcExitTimer);
        fcExitTimer = setTimeout(function() {
          fcEl.classList.remove('visible');
          fcEl.classList.remove('exiting');
          fcExitTimer = null;
        }, 700);
        lastFeatureCardVisible = false;
        lastFeatureCardFiredAt = fc.firedAt || 0;
      }
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

    // Hoisted HTML escape for venue/badge/etc. The countdown's local
    // escHtml shadows this within its closure (kept for backcompat).
    function escHtmlGlobal(s) {
      return String(s).replace(/[&<>"']/g, function(c) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
      });
    }

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
    var ssAccentEl = document.getElementById('ss-accent');
    if (ssCfg && ssCfg.layout && ssCfg.layout.title && ssCfg.layout.title.visible) {
      var tLayout = ssCfg.layout.title;
      ssTitleEl.style.display = 'block';
      ssTitleEl.style.left = (tLayout.x + tLayout.width / 2) + '%';
      ssTitleEl.style.top = (tLayout.y + tLayout.height / 2) + '%';
      if (ssCfg.titleFontSize) ssTitleEl.style.fontSize = ssCfg.titleFontSize + 'px';
      if (ssCfg.titleColor) ssTitleEl.style.color = ssCfg.titleColor;
      // Accent line — sits just below title center, scaled to ~50% of title width
      if (ssAccentEl) {
        ssAccentEl.style.display = 'block';
        ssAccentEl.style.left = (tLayout.x + tLayout.width / 2) + '%';
        ssAccentEl.style.top = (tLayout.y + tLayout.height + 1.4) + '%';
        ssAccentEl.style.width = (tLayout.width * 0.5) + '%';
        ssAccentEl.classList.add('visible');
      }
    } else {
      ssTitleEl.style.display = 'none';
      if (ssAccentEl) {
        ssAccentEl.style.display = 'none';
        ssAccentEl.classList.remove('visible');
      }
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

    // Preview mode (scene editor iframe): force visible regardless of ss.visible.
    // Without this, the wrap at applyState race-loses and the scene fades to black
    // ~0.8s after the first state broadcast arrives. Guard at source, not after.
    var ssForcePreview = (typeof isPreview !== 'undefined') && isPreview && sceneParam === 'startingsoon';
    var nowVisible = !!(ss.visible || ssForcePreview);
    if (nowVisible) {
      ssEl.classList.add('visible');
      // First-show orchestration: trigger entry animations only on the
      // invisible→visible flip, never on subsequent state pings while shown.
      if (!lastSsVisible) {
        ssEl.classList.remove('first-show');
        // Force reflow so animation restarts cleanly
        void ssEl.offsetWidth;
        ssEl.classList.add('first-show');
        if (ssFirstShowTimer) clearTimeout(ssFirstShowTimer);
        ssFirstShowTimer = setTimeout(function() {
          ssEl.classList.remove('first-show');
          ssFirstShowTimer = null;
        }, 2800);
      }
    } else {
      ssEl.classList.remove('visible', 'first-show');
      if (ssFirstShowTimer) { clearTimeout(ssFirstShowTimer); ssFirstShowTimer = null; }
    }
    lastSsVisible = nowVisible;

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
        // Design-pro pack 2026-05-05 — broadcast-grade palettes
        'slate-aurora': ['#0a0e2a','#1f1947','#3b3585','#4f4a9b'],
        'velvet-night': ['#0a0a0f','#2a0a1f','#4a0e2f','#1a0a14'],
        'champagne-light': ['#f5f0e1','#e8c87a','#d4b48a','#f0e8d5'],
        'cinematic-teal': ['#0a3344','#1a6b8e','#0a3344','#0e1d2a'],
        'neutral-studio': ['#1a1a1f','#2d2d35','#3a3a44','#1a1a1f'],
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
    // The iframe is loaded over http://, so file:// URLs (or bare Windows paths
    // that Chromium auto-rewrites to file://) are blocked as cross-origin. We
    // serve the logo via the same overlay HTTP server at /brand-logo. The route
    // resolves the file from settings.branding.brandLogoUrl → settings.overlay.logoUrl
    // and pipes the bytes. Cache-buster query param ensures fresh load when path changes.
    var logoCfg = (ssCfg && ssCfg.logo) || {};
    var brandLogo = (state && state.branding && state.branding.brandLogoUrl) ? state.branding.brandLogoUrl : '';
    // Hash a stable string so img.src changes when the underlying file path changes
    var hashSrc = (brandLogo || logoUrl || '');
    var bust = 0;
    for (var hi = 0; hi < hashSrc.length; hi++) bust = ((bust << 5) - bust + hashSrc.charCodeAt(hi)) | 0;
    var resolvedLogo = hashSrc ? '/brand-logo?v=' + Math.abs(bust) : '';
    var LOGO_ANIMS = ['anim-pulse','anim-float','anim-spin','anim-fade-in-once','anim-breathing','anim-glow'];
    LOGO_ANIMS.forEach(function(c) { ssLogoEl.classList.remove(c); });
    if (ssCfg && ssCfg.layout && ssCfg.layout.logo && ssCfg.layout.logo.visible) {
      var logoLayout = ssCfg.layout.logo;
      ssLogoEl.style.display = 'block';
      ssLogoEl.style.left = logoLayout.x + '%';
      ssLogoEl.style.top = logoLayout.y + '%';
      ssLogoEl.style.width = logoLayout.width + '%';
      ssLogoEl.style.height = logoLayout.height + '%';
      ssLogoEl.style.opacity = (logoCfg.opacity != null ? logoCfg.opacity : 1);
      // Bloom follows logo center so the off-screen halo lands behind the
      // brand mark wherever the operator places it via SSE.
      ssEl.style.setProperty('--ss-bloom-x', (logoLayout.x + logoLayout.width / 2) + '%');
      ssEl.style.setProperty('--ss-bloom-y', (logoLayout.y + logoLayout.height / 2) + '%');
      if (ssLogoImg) {
        ssLogoImg.style.objectFit = logoCfg.fit || 'contain';
      }
      // Premium pass — trophy plinth + rotating conic halo. Opt-in via SSE.
      var haloEnabled = (logoCfg.haloEnabled !== false);
      var haloColor = logoCfg.haloColor || '#a4b3ff';
      var ssHaloEl = document.getElementById('ss-logo-halo');
      var ssPlateEl = document.getElementById('ss-logo-plate');
      if (haloEnabled) {
        ssLogoEl.classList.add('has-halo');
        if (ssHaloEl) {
          ssHaloEl.style.display = '';
          // hex → rgba(.55) so blur+conic doesn't blow out
          var hex = String(haloColor).replace('#','');
          if (hex.length === 6) {
            var hr = parseInt(hex.substr(0,2),16);
            var hg = parseInt(hex.substr(2,2),16);
            var hb = parseInt(hex.substr(4,2),16);
            ssLogoEl.style.setProperty('--ss-halo', 'rgba(' + hr + ',' + hg + ',' + hb + ',0.55)');
          }
        }
        if (ssPlateEl) ssPlateEl.style.display = '';
      } else {
        ssLogoEl.classList.remove('has-halo');
        if (ssHaloEl) ssHaloEl.style.display = 'none';
        if (ssPlateEl) ssPlateEl.style.display = 'none';
      }
      var anim = logoCfg.animation || 'none';
      if (anim && anim !== 'none') {
        ssLogoEl.classList.add('anim-' + anim);
        // animation speed 1..10 → duration scale: 1 = slowest (3x base), 10 = fastest (0.4x base)
        var sp = logoCfg.animationSpeed || 5;
        var scale = 3 - (sp - 1) * (2.6 / 9); // 1→3.0, 5→1.84, 10→0.4
        // Pulse base 2s, float 4s, spin 12s, fade 1.2s, breathing 5s, glow 3s
        var bases = { pulse: 2, float: 4, spin: 12, 'fade-in-once': 1.2, breathing: 5, glow: 3 };
        var base = bases[anim] || 2;
        ssLogoEl.style.setProperty('--ss-logo-anim-dur', (base * scale).toFixed(2) + 's');
      }
      if (resolvedLogo) {
        ssLogoImg.src = resolvedLogo;
      } else {
        ssLogoEl.style.display = 'none';
      }
    } else {
      ssLogoEl.style.display = 'none';
    }

    // --- Countdown styling ---
    var cdStyleMode = 'soft';
    if (ssCfg && ssCfg.countdownStyle) {
      var cs = ssCfg.countdownStyle;
      ssCountEl.style.fontSize = cs.fontSize + 'px';
      ssCountEl.style.color = cs.color;
      ssCountEl.style.fontWeight = String(cs.fontWeight);
      cdStyleMode = cs.style || 'soft';
    }
    // Toggle the flipboard layout class on the countdown root so CSS can
    // switch from a plain text node to digit-cell flex layout.
    ssCountEl.classList.remove('style-flipboard', 'style-sevenSeg');
    if (cdStyleMode === 'flipboard') ssCountEl.classList.add('style-flipboard');
    else if (cdStyleMode === 'sevenSeg') ssCountEl.classList.add('style-sevenSeg');

    // Countdown timer
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    // Reset the final-30 takeover layer on every applyStartingSoon — countdown
    // may have been disabled, or the operator extended the target. The interval
    // closure below re-engages it if the new target is within threshold.
    var ssFinalReset = document.getElementById('ss-final-cd');
    if (ssFinalReset) {
      ssFinalReset.classList.remove('visible', 'entering', 'escalate', 'drop');
    }
    if (ssCountEl) ssCountEl.style.opacity = '';
    if (ss.showCountdown && ss.countdownTarget) {
      var showLabels = (ssCfg && ssCfg.countdownStyle) ? ssCfg.countdownStyle.showLabels : false;
      var expiredText = (ssCfg && ssCfg.countdownStyle && ssCfg.countdownStyle.expiredText) ? ssCfg.countdownStyle.expiredText : 'SOON';
      var prefixText = (ssCfg && ssCfg.countdownStyle && ssCfg.countdownStyle.prefixText) ? ssCfg.countdownStyle.prefixText : '';
      function escHtml(s) {
        return String(s).replace(/[&<>"']/g, function(c) {
          return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
        });
      }
      // Renders body as flipboard cells: each digit gets its own cell with a
      // flip animation that re-fires whenever the cell's digit changes.
      function renderFlipboard(body) {
        var html = '';
        for (var ci = 0; ci < body.length; ci++) {
          var ch = body.charAt(ci);
          if (ch === ':') {
            html += '<span class="ss-cd-sep">:</span>';
          } else if (ch === ' ') {
            html += '<span style="display:inline-block;width:0.25em"></span>';
          } else if (/[0-9]/.test(ch)) {
            html += '<span class="ss-cd-digit-cell"><span class="ss-cd-digit">' + ch + '</span></span>';
          } else {
            // labels like "h"/"m"/"s" — don't wrap, just inline
            html += '<span style="padding:0 0.06em;color:#c5cae9;opacity:0.85">' + escHtml(ch) + '</span>';
          }
        }
        return html;
      }
      var lastBody = '';
      // Final-N takeover state. Tracked across ticks so we only animate the
      // entry once when crossing the threshold and the drop once at zero.
      var finalCfg = (ssCfg && ssCfg.countdownStyle) || {};
      var takeoverOn = (finalCfg.finalSecondsTakeover !== false);
      var takeoverThresholdSec = (typeof finalCfg.finalSecondsThreshold === 'number' && finalCfg.finalSecondsThreshold > 0)
        ? finalCfg.finalSecondsThreshold : 30;
      var takeoverLabel = finalCfg.finalLabel || 'FINAL 30 SECONDS';
      var takeoverSub = finalCfg.finalSubLabel || 'Show begins shortly';
      var ssFinalEl = document.getElementById('ss-final-cd');
      var ssFinalDigitsEl = document.getElementById('ss-final-cd-digits');
      var ssFinalLabelEl = document.getElementById('ss-final-cd-label');
      var ssFinalSubEl = document.getElementById('ss-final-cd-sub');
      var lastFinalActive = !!(ssFinalEl && ssFinalEl.classList.contains('visible'));
      var lastFinalSec = -1;
      var droppedAtZero = false;

      function fmtFinalDigits(secs) {
        // 00:00 layout for sub-minute final stretch — clear at a glance.
        var mm = Math.floor(secs / 60);
        var ss2 = secs % 60;
        return String(mm).padStart(2,'0') + ':' + String(ss2).padStart(2,'0');
      }
      function renderFinalCountdown(secs) {
        if (!ssFinalDigitsEl) return;
        var body = fmtFinalDigits(secs);
        // Build cells fresh on first reveal, otherwise update only changed digits.
        var existing = ssFinalDigitsEl.children.length;
        if (existing === 0 || ssFinalDigitsEl.dataset.fcdLayout !== String(body.length)) {
          var html = '';
          for (var fi = 0; fi < body.length; fi++) {
            var fch = body.charAt(fi);
            if (fch === ':') html += '<span class="ss-cd-sep">:</span>';
            else html += '<span class="ss-cd-digit-cell"><span class="ss-cd-digit">' + fch + '</span></span>';
          }
          ssFinalDigitsEl.innerHTML = html;
          ssFinalDigitsEl.dataset.fcdLayout = String(body.length);
          ssFinalDigitsEl.dataset.fcdBody = body;
        } else {
          // Per-digit diff. Flash any cell whose digit changed.
          var prevBody = ssFinalDigitsEl.dataset.fcdBody || '';
          var cells = ssFinalDigitsEl.querySelectorAll('.ss-cd-digit-cell');
          var cellIdx = -1;
          for (var bi = 0; bi < body.length; bi++) {
            var bch = body.charAt(bi);
            if (bch === ':') continue;
            cellIdx++;
            if (prevBody.charAt(bi) === bch) continue;
            if (cells[cellIdx]) {
              cells[cellIdx].innerHTML = '<span class="ss-cd-digit">' + bch + '</span>';
              // Re-trigger the flash class
              cells[cellIdx].classList.remove('flash');
              void cells[cellIdx].offsetWidth;
              cells[cellIdx].classList.add('flash');
            }
          }
          ssFinalDigitsEl.dataset.fcdBody = body;
        }
      }

      function updateCountdown() {
        var target = new Date(ss.countdownTarget).getTime();
        var now = Date.now();
        var diff = Math.max(0, target - now);
        var totalSec = Math.ceil(diff / 1000);

        // ── Final-N takeover ──
        var inFinal = takeoverOn && totalSec > 0 && totalSec <= takeoverThresholdSec;
        if (ssFinalEl) {
          if (inFinal) {
            // Enter the takeover layer
            if (!lastFinalActive) {
              if (ssFinalLabelEl) ssFinalLabelEl.textContent = takeoverLabel;
              if (ssFinalSubEl) ssFinalSubEl.textContent = takeoverSub;
              ssFinalEl.classList.remove('drop');
              ssFinalEl.classList.add('visible', 'entering');
              setTimeout(function() {
                if (ssFinalEl) ssFinalEl.classList.remove('entering');
              }, 950);
              // Dim the layout countdown while takeover is up.
              if (ssCountEl) ssCountEl.style.opacity = '0.0';
            }
            if (totalSec !== lastFinalSec) {
              renderFinalCountdown(totalSec);
              lastFinalSec = totalSec;
            }
            // Last-5 escalation
            if (totalSec <= 5) ssFinalEl.classList.add('escalate');
            else ssFinalEl.classList.remove('escalate');
          } else {
            // Exit takeover (reset countdown extended past threshold)
            if (lastFinalActive && totalSec > takeoverThresholdSec) {
              ssFinalEl.classList.remove('visible', 'entering', 'escalate', 'drop');
              if (ssCountEl) ssCountEl.style.opacity = '';
              lastFinalSec = -1;
            }
          }
          lastFinalActive = inFinal;
        }

        if (diff <= 0) {
          if (cdStyleMode === 'flipboard') {
            ssCountEl.innerHTML = renderFlipboard(expiredText);
          } else {
            ssCountEl.textContent = expiredText;
          }
          // Drop-out flash on the takeover layer if it was active.
          if (ssFinalEl && lastFinalActive && !droppedAtZero) {
            droppedAtZero = true;
            ssFinalEl.classList.add('drop');
            setTimeout(function() {
              if (!ssFinalEl) return;
              ssFinalEl.classList.remove('visible', 'drop', 'escalate');
              if (ssCountEl) ssCountEl.style.opacity = '';
            }, 1200);
          }
          if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
          return;
        }
        var h = Math.floor(diff / 3600000);
        var m = Math.floor((diff % 3600000) / 60000);
        var s = Math.floor((diff % 60000) / 1000);
        var body = '';
        if (showLabels) {
          if (h > 0) {
            body = h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
          } else {
            body = m + 'm ' + String(s).padStart(2, '0') + 's';
          }
        } else {
          if (h > 0) {
            body = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
          } else {
            body = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
          }
        }
        if (body === lastBody) return;
        lastBody = body;
        if (cdStyleMode === 'flipboard') {
          // Per-digit flip — only re-render cells whose digit changed so the
          // unchanged hours/minutes don't flap each second.
          if (ssCountEl.children.length === 0 || ssCountEl.dataset.cdLayout !== body.length + '|' + body.replace(/[0-9]/g,'#')) {
            // Layout changed (digit count or position of separators) — full rebuild.
            ssCountEl.innerHTML = (prefixText ? '<span style="margin-right:0.4em;color:#c5cae9">' + escHtml(prefixText) + '</span>' : '') + renderFlipboard(body);
            ssCountEl.dataset.cdLayout = body.length + '|' + body.replace(/[0-9]/g,'#');
            ssCountEl.dataset.cdBody = body;
          } else {
            // Diff per-cell. Walk children and update only changed digits.
            var prevBody = ssCountEl.dataset.cdBody || '';
            var cellIdx = -1;
            for (var bi = 0; bi < body.length; bi++) {
              var bch = body.charAt(bi);
              if (!/[0-9]/.test(bch)) continue;
              cellIdx++;
              if (prevBody.charAt(bi) === bch) continue;
              // Find the cellIdx-th digit cell among children
              var cells = ssCountEl.querySelectorAll('.ss-cd-digit-cell');
              if (cells[cellIdx]) {
                cells[cellIdx].innerHTML = '<span class="ss-cd-digit">' + bch + '</span>';
              }
            }
            ssCountEl.dataset.cdBody = body;
          }
        } else {
          // Wrap colons in spans so the .ss-cd-colon blink animation hits them.
          // Prefix is HTML-escaped first since it's operator-controlled.
          var bodyHtml = escHtml(body).replace(/:/g, '<span class="ss-cd-colon">:</span>');
          ssCountEl.innerHTML = prefixText ? (escHtml(prefixText) + ' ' + bodyHtml) : bodyHtml;
        }
      }
      updateCountdown();
      countdownInterval = setInterval(updateCountdown, 1000);
    } else if (countdownLayoutVisible) {
      // Layout visible but no active timer — show placeholder text
      if (cdStyleMode === 'flipboard') {
        ssCountEl.innerHTML = '<span class="ss-cd-digit-cell"><span class="ss-cd-digit">0</span></span><span class="ss-cd-digit-cell"><span class="ss-cd-digit">0</span></span><span class="ss-cd-sep">:</span><span class="ss-cd-digit-cell"><span class="ss-cd-digit">0</span></span><span class="ss-cd-digit-cell"><span class="ss-cd-digit">0</span></span>';
      } else {
        ssCountEl.textContent = '00:00';
      }
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
    // Diagnostic
    if (!window._ssSocialLogged) {
      window._ssSocialLogged = true;
      var sbCfgD = ssCfg && ssCfg.socialBar;
      var sbLayoutD = ssCfg && ssCfg.layout && ssCfg.layout.socialBar;
      console.error('[SSE-social-diag] el=' + !!ssSocialEl +
        ' enabled=' + (sbCfgD && sbCfgD.enabled) +
        ' layoutVisible=' + (sbLayoutD && sbLayoutD.visible) +
        ' handleCount=' + (sbCfgD && sbCfgD.handles ? sbCfgD.handles.length : 'NULL') +
        ' brandingIG=' + (state && state.branding ? state.branding.instagram : 'NO'));
    }
    if (ssSocialEl && ssCfg && ssCfg.socialBar && ssCfg.socialBar.enabled && ssCfg.layout && ssCfg.layout.socialBar && ssCfg.layout.socialBar.visible) {
      var sbLayout = ssCfg.layout.socialBar;
      var sbCfg = ssCfg.socialBar;
      ssSocialEl.classList.add('visible');
      ssSocialEl.style.left = sbLayout.x + '%';
      ssSocialEl.style.top = sbLayout.y + '%';
      ssSocialEl.style.width = sbLayout.width + '%';
      ssSocialEl.style.height = sbLayout.height + '%';
      // Force display in case CSS .ss-social-bar has display:none and the
      // .visible class doesn't override it.
      ssSocialEl.style.display = 'flex';
      ssSocialEl.style.alignItems = 'center';
      ssSocialEl.style.justifyContent = 'center';
      ssSocialEl.style.gap = '14px';
      var isVertical = sbCfg.position === 'left' || sbCfg.position === 'right';
      if (isVertical) {
        ssSocialEl.style.flexDirection = 'column';
      } else {
        ssSocialEl.style.flexDirection = 'row';
      }
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
      // Drop handles where the actual handle string is empty — saved configs can
      // contain stub entries from the editor "+ Add Handle" button before user
      // typed anything, and rendering them produces blank icons/text.
      var rawHandles = (sbCfg.handles || []).filter(function(h) {
        return h && typeof h.handle === 'string' && h.handle.trim().length > 0;
      });
      var handles = rawHandles.slice();
      // Always merge in branding-derived handles for any platforms not already
      // explicitly listed. This way: empty-handle config → all branding handles;
      // partial config → fills the gaps with branding.
      if (state && state.branding) {
        var b = state.branding;
        var platformMap = [
          ['instagram', b.instagram], ['facebook', b.facebook], ['tiktok', b.tiktok],
          ['youtube', b.youtube], ['twitter', b.twitter], ['website', b.website]
        ];
        platformMap.forEach(function(pair) {
          var alreadyHas = handles.some(function(h) { return h.platform === pair[0]; });
          if (!alreadyHas && pair[1] && String(pair[1]).trim()) {
            handles.push({ platform: pair[0], handle: pair[1] });
          }
        });
      }
      handles.forEach(function(h) {
        var icon = showIcon ? (icons[h.platform] || '') : '';
        // Strip leading @ if present so we don't double it; add @ for handle-style platforms only
        var raw = String(h.handle || '').replace(/^@/, '');
        var displayed = (h.platform === 'website') ? raw : ('@' + raw);
        var text = showText ? '<span>' + displayed + '</span>' : '';
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

    // --- Independent SSE Ticker Rail ---
    // (Replaces the legacy "share the main overlay ticker" hack. The SSE ticker
    // is its own DOM element with its own text/speed/color/bg, and lives inside
    // #starting-soon so it only shows when the SSE scene is up.)
    var ssTickerBlock = document.getElementById('ss-ticker-block');
    var ssTickerRail = document.getElementById('ss-ticker-rail');
    var ssTickerInner = document.getElementById('ss-ticker-rail-inner');
    var ssTickerAccent = document.getElementById('ss-ticker-accent');
    var ssTickerCat = document.getElementById('ss-ticker-cat');
    var ssTickerLive = document.getElementById('ss-ticker-live');
    var ticker = (ssCfg && ssCfg.ticker) || null;
    var tickerLayoutVisible = !!(ssCfg && ssCfg.layout && ssCfg.layout.ticker && ssCfg.layout.ticker.visible);
    // Diagnostic — use console.error since main.log only forwards error level.
    if (!window._ssTickerLogged) {
      window._ssTickerLogged = true;
      console.error('[SSE-ticker-diag] block=' + !!ssTickerBlock + ' rail=' + !!ssTickerRail + ' inner=' + !!ssTickerInner +
        ' tickerEnabled=' + (ticker && ticker.enabled) +
        ' tickerText=' + (ticker && ticker.text ? '"' + String(ticker.text).slice(0,40) + '"' : 'NONE') +
        ' layoutVisible=' + tickerLayoutVisible +
        ' twoRow=' + (ticker && ticker.twoRow) +
        ' ssCfgKeys=' + (ssCfg ? Object.keys(ssCfg).join(',') : 'NULL'));
    }
    if (ssTickerBlock && ssTickerRail && ssTickerInner && ticker && ticker.enabled && tickerLayoutVisible && ticker.text) {
      var tLayout = ssCfg.layout.ticker;
      ssTickerBlock.classList.add('visible');
      ssTickerBlock.style.left = tLayout.x + '%';
      ssTickerBlock.style.top = tLayout.y + '%';
      ssTickerBlock.style.width = tLayout.width + '%';
      ssTickerBlock.style.height = tLayout.height + '%';
      ssTickerRail.style.background = ticker.bgColor || 'rgba(0,0,0,0.55)';
      ssTickerInner.style.color = ticker.color || '#ffffff';
      ssTickerInner.style.fontSize = (ticker.fontSize || 22) + 'px';
      ssTickerInner.style.fontWeight = '600';
      ssTickerInner.textContent = ticker.text;
      // speed (px/s) → keyframe duration: estimate text width via 1920px reference frame
      var speed = Math.max(20, ticker.speed || 60);
      var dur = Math.max(8, Math.round(2400 / speed));
      ssTickerBlock.style.setProperty('--ss-ticker-dur', dur + 's');
      // Premium pass — two-row treatment
      var twoRow = !!ticker.twoRow;
      if (ssTickerAccent) {
        ssTickerAccent.style.display = twoRow ? 'flex' : 'none';
        if (twoRow && ssTickerCat) ssTickerCat.textContent = ticker.categoryLabel || '';
        if (twoRow && ssTickerLive) ssTickerLive.style.display = ticker.liveIndicator ? 'inline-flex' : 'none';
      }
    } else if (ssTickerBlock) {
      ssTickerBlock.classList.remove('visible');
    }

    // --- Venue identifier strip (premium pass) ---
    var ssVenueEl = document.getElementById('ss-venue-id');
    var venue = (ssCfg && ssCfg.venueIdentifier) || null;
    var venueLayout = (ssCfg && ssCfg.layout && ssCfg.layout.venueId) || null;
    if (ssVenueEl && venue && venue.enabled && venueLayout && venueLayout.visible) {
      // Build segments from the three free-text fields. Only render non-empty
      // segments so the strip doesn't show stray pipes for unset fields.
      var segs = [];
      if (venue.eventLabel) segs.push({ cls: 'ss-vid-event', text: venue.eventLabel });
      if (venue.venueName) segs.push({ cls: '', text: venue.venueName });
      if (venue.dayLabel) segs.push({ cls: '', text: venue.dayLabel });
      if (segs.length > 0) {
        var vidHtml = '';
        for (var vi = 0; vi < segs.length; vi++) {
          if (vi > 0) vidHtml += '<span class="ss-vid-pipe"></span>';
          vidHtml += '<span class="ss-vid-seg ' + segs[vi].cls + '">' + escHtmlGlobal(segs[vi].text) + '</span>';
        }
        ssVenueEl.innerHTML = vidHtml;
        ssVenueEl.style.left = venueLayout.x + '%';
        ssVenueEl.style.top = venueLayout.y + '%';
        ssVenueEl.style.fontSize = (venue.fontSize || 14) + 'px';
        ssVenueEl.style.color = venue.color || '#c5cae9';
        ssVenueEl.classList.add('visible');
      } else {
        ssVenueEl.classList.remove('visible');
      }
    } else if (ssVenueEl) {
      ssVenueEl.classList.remove('visible');
    }

    // --- Section identifier badge (premium pass) ---
    var ssBadgeEl = document.getElementById('ss-section-badge');
    var badge = (ssCfg && ssCfg.sectionBadge) || null;
    var badgeLayout = (ssCfg && ssCfg.layout && ssCfg.layout.sectionBadge) || null;
    if (ssBadgeEl && badge && badge.enabled && badgeLayout && badgeLayout.visible && badge.label) {
      ssBadgeEl.innerHTML = '<span class="ss-sb-dot"></span><span class="ss-sb-label">' + escHtmlGlobal(badge.label) + '</span>';
      // Position via right-edge so the pill hugs the configured x as its left
      // anchor (operator-friendly: drag the x to slide it across the corner).
      ssBadgeEl.style.left = badgeLayout.x + '%';
      ssBadgeEl.style.top = badgeLayout.y + '%';
      ssBadgeEl.style.fontSize = (badge.fontSize || 12) + 'px';
      ssBadgeEl.style.color = badge.color || '#ffffff';
      ssBadgeEl.style.setProperty('--ss-sb-dot', badge.dotColor || '#ef4444');
      ssBadgeEl.classList.add('visible');
    } else if (ssBadgeEl) {
      ssBadgeEl.classList.remove('visible');
    }
    // Backward-compat: also turn OFF the legacy main-overlay ticker hijack.
    var legacyTickerEl = document.getElementById('ticker');
    if (legacyTickerEl && ss.visible && ssCfg && ssCfg.tickerEnabled && !(ticker && ticker.enabled)) {
      // Old config without the new ticker shape — fall back to old behavior so
      // existing saved configs don't visually break.
      legacyTickerEl.classList.add('visible');
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
    if (cn && !cn.textContent) cn.textContent = '1';
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
