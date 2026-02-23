import { app, BrowserWindow, shell } from 'electron'
import path from 'path'
import windowStateKeeper from 'electron-window-state'
import { logger } from './logger'
import { registerAllHandlers } from './ipc'
import { getSettings } from './services/settings'
import * as obs from './services/obs'
import * as recording from './services/recording'
import * as overlay from './services/overlay'
import * as wsHub from './services/wsHub'
import * as hotkeys from './services/hotkeys'
import { checkAndRecover } from './services/crashRecovery'
import { loadState } from './services/state'

// --- Global error handlers ---
process.on('uncaughtException', (error) => {
  logger.app.error('Uncaught exception:', error.message, error.stack)
})

process.on('unhandledRejection', (reason) => {
  logger.app.error('Unhandled rejection:', reason instanceof Error ? reason.message : String(reason))
})

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  logger.app.info('Creating main window')

  const mainWindowState = windowStateKeeper({
    defaultWidth: 1200,
    defaultHeight: 800,
  })

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e2e',
    show: false,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindowState.manage(mainWindow)

  // Load the renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // Apply initial zoom from settings
    const s = getSettings()
    const zoom = s.behavior.zoomFactor || 1.0
    if (zoom !== 1.0) {
      mainWindow?.webContents.setZoomFactor(zoom)
    }
  })

  // F12 toggles DevTools, Ctrl+=/- for zoom
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
    }
    // Ctrl+= zoom in, Ctrl+- zoom out, Ctrl+0 reset
    if (input.control && !input.alt && !input.meta) {
      if (input.key === '=' || input.key === '+') {
        const current = mainWindow?.webContents.getZoomFactor() || 1.0
        mainWindow?.webContents.setZoomFactor(Math.min(current + 0.1, 3.0))
      } else if (input.key === '-') {
        const current = mainWindow?.webContents.getZoomFactor() || 1.0
        mainWindow?.webContents.setZoomFactor(Math.max(current - 0.1, 0.5))
      } else if (input.key === '0') {
        mainWindow?.webContents.setZoomFactor(1.0)
      }
    }
  })

  // Forward renderer console errors to main process log
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // level: 0=debug, 1=info, 2=warn, 3=error
    if (level >= 2) {
      const src = sourceId ? ` (${sourceId}:${line})` : ''
      if (level === 3) {
        logger.app.error(`[Renderer] ${message}${src}`)
      } else {
        logger.app.warn(`[Renderer] ${message}${src}`)
      }
    }
  })

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Apply always-on-top setting
  const settings = getSettings()
  if (settings.behavior.alwaysOnTop) {
    mainWindow.setAlwaysOnTop(true)
  }
}

app.whenReady().then(async () => {
  logger.app.info('App starting, version:', app.getVersion())
  logger.app.info('User data path:', app.getPath('userData'))

  // Register IPC handlers before creating window
  registerAllHandlers()

  // Wire OBS recording events to recording pipeline
  obs.onRecordStarted((data) => {
    recording.handleRecordingStarted(data.timestamp)
  })
  obs.onRecordStopped((data) => {
    if (data.outputPath) {
      recording.handleRecordingStopped(data.outputPath, data.timestamp)
    }
  })

  // Create window
  createWindow()

  // Start overlay + WebSocket hub
  overlay.startServer()
  wsHub.start()

  // Register global hotkeys
  hotkeys.register()

  // Load persisted state
  // Note: OBS auto-connect is triggered by the renderer after loading settings
  loadState()

  // Check for crash recovery
  checkAndRecover().catch((err) => {
    logger.app.warn('Crash recovery check failed:', err)
  })
})

app.on('window-all-closed', () => {
  logger.app.info('All windows closed')
  hotkeys.unregister()
  wsHub.stop()
  overlay.stopServer()
  obs.disconnect()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('will-quit', () => {
  hotkeys.unregister()
})

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
