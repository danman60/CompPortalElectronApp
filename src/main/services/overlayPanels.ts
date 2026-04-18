/**
 * Overlay Mode — floating always-on-top panels that sit over OBS during a show.
 *
 * Operator clicks the Overlay button → main window hides → we spawn 5 tiny
 * frameless always-on-top BrowserWindows, each rendering one slice of the UI
 * via the secondary renderer entry (panel.html?panel=<id>). Clicking "Exit
 * Overlay" on any panel restores the main window.
 *
 * Not related to the streaming "overlay" (lower-thirds / port 9876) in
 * overlay.ts — the shared "overlay" word is coincidental.
 */

import { BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { logger } from '../logger'

export type PanelId =
  | 'currentRoutine'
  | 'controls'
  | 'previousRoutines'
  | 'nextRoutines'
  | 'systemStats'

interface PanelBounds { x?: number; y?: number; width: number; height: number }
interface PanelSpec { id: PanelId; default: PanelBounds; minWidth: number; minHeight: number }

const PANEL_SPECS: PanelSpec[] = [
  { id: 'currentRoutine',    default: { width: 380, height: 160 }, minWidth: 240, minHeight: 100 },
  { id: 'controls',          default: { width: 300, height: 180 }, minWidth: 220, minHeight: 120 },
  { id: 'previousRoutines',  default: { width: 500, height: 140 }, minWidth: 300, minHeight: 100 },
  { id: 'nextRoutines',      default: { width: 500, height: 140 }, minWidth: 300, minHeight: 100 },
  { id: 'systemStats',       default: { width: 240, height: 140 }, minWidth: 180, minHeight: 80 },
]

const panels = new Map<PanelId, BrowserWindow>()
let mainWindowRef: BrowserWindow | null = null

function stateFilePath(id: PanelId): string {
  return path.join(app.getPath('userData'), `panel-${id}.json`)
}

function loadBounds(id: PanelId, fallback: PanelBounds): PanelBounds {
  try {
    const raw = fs.readFileSync(stateFilePath(id), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PanelBounds>
    if (
      typeof parsed.width === 'number' && typeof parsed.height === 'number' &&
      parsed.width >= 100 && parsed.height >= 60
    ) {
      return {
        x: typeof parsed.x === 'number' ? parsed.x : undefined,
        y: typeof parsed.y === 'number' ? parsed.y : undefined,
        width: parsed.width,
        height: parsed.height,
      }
    }
  } catch {
    // missing / corrupt — fall through to default
  }
  return fallback
}

function saveBounds(id: PanelId, win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    const b = win.getBounds()
    fs.writeFileSync(stateFilePath(id), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }))
  } catch (err) {
    logger.app.warn(`overlayPanels: failed to save bounds for ${id}:`, err instanceof Error ? err.message : String(err))
  }
}

function panelUrl(id: PanelId): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    // electron-vite dev server: panel.html is a sibling of index.html at the root
    return `${process.env.ELECTRON_RENDERER_URL}/panel.html?panel=${id}`
  }
  // Packaged: electron-vite emits to out/renderer/. panel.html is a sibling of index.html.
  // __dirname at runtime is out/main/. Renderer sits at out/renderer/.
  const filePath = path.join(__dirname, '../renderer/panel.html')
  return `file://${filePath}?panel=${id}`
}

function createPanel(spec: PanelSpec): BrowserWindow {
  const bounds = loadBounds(spec.id, spec.default)

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1e1e2e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const url = panelUrl(spec.id)
  if (url.startsWith('file://')) {
    const [filePath, query] = url.replace('file://', '').split('?')
    win.loadFile(filePath, { search: query })
  } else {
    win.loadURL(url)
  }

  win.once('ready-to-show', () => win.show())

  const onChanged = (): void => saveBounds(spec.id, win)
  win.on('moved', onChanged)
  win.on('resized', onChanged)

  win.on('closed', () => {
    panels.delete(spec.id)
  })

  return win
}

export function isOpen(): boolean {
  return panels.size > 0
}

export function openAll(mainWindow: BrowserWindow): void {
  if (panels.size > 0) {
    logger.app.warn('overlayPanels: openAll called while panels already open; ignoring')
    return
  }
  mainWindowRef = mainWindow
  logger.app.info('overlayPanels: opening 5 panels')

  for (const spec of PANEL_SPECS) {
    try {
      const win = createPanel(spec)
      panels.set(spec.id, win)
    } catch (err) {
      logger.app.error(`overlayPanels: failed to create ${spec.id}:`, err instanceof Error ? err.message : String(err))
    }
  }

  try { mainWindow.hide() } catch {}
}

export function closeAll(): void {
  if (panels.size === 0 && !mainWindowRef) return
  logger.app.info('overlayPanels: closing all panels')

  for (const [id, win] of panels.entries()) {
    try {
      saveBounds(id, win)
      if (!win.isDestroyed()) win.close()
    } catch (err) {
      logger.app.warn(`overlayPanels: close error for ${id}:`, err instanceof Error ? err.message : String(err))
    }
  }
  panels.clear()

  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    try {
      mainWindowRef.show()
      mainWindowRef.focus()
    } catch {}
  }
  mainWindowRef = null
}

export function toggle(mainWindow: BrowserWindow): void {
  if (isOpen()) closeAll()
  else openAll(mainWindow)
}
