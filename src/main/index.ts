import { app, BrowserWindow, dialog, shell, powerSaveBlocker } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'
import windowStateKeeper from 'electron-window-state'
import { logger } from './logger'
import { registerAllHandlers } from './ipc'
import { getSettings } from './services/settings'
import { IPC_CHANNELS } from '../shared/types'
import * as obs from './services/obs'
import * as recording from './services/recording'
import * as overlay from './services/overlay'
import * as wsHub from './services/wsHub'
import * as hotkeys from './services/hotkeys'
import * as jobQueue from './services/jobQueue'
import * as ffmpegService from './services/ffmpeg'
import * as uploadService from './services/upload'
import * as state from './services/state'
import * as systemMonitor from './services/systemMonitor'
import * as driveMonitor from './services/driveMonitor'
import * as schedule from './services/schedule'
import * as wpdBridge from './services/wpdBridge'
import * as tether from './services/tether'
import * as wifiDisplay from './services/wifiDisplay'
import * as chatBridge from './services/chatBridge'
import { checkAndRecover } from './services/crashRecovery'
import { runStartupChecks } from './services/startup'

// --- Global error handlers ---
process.on('uncaughtException', (error) => {
  logger.app.error('FATAL uncaught exception:', error.message, error.stack)

  // Flush critical state to disk
  try { jobQueue.flushSync() } catch {}
  try { state.saveStateImmediate() } catch {}

  dialog.showErrorBox(
    'CompSync Media — Critical Error',
    `The app encountered an unexpected error:\n\n${error.message}\n\nYour data has been saved. Please restart the app.`,
  )

  app.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.app.error('Unhandled rejection:', reason instanceof Error ? reason.message : String(reason))
  // Non-fatal — log and continue
})

let mainWindow: BrowserWindow | null = null
let powerBlockerId: number | null = null

function isElevated(): boolean {
  if (process.platform !== 'win32') return true
  try {
    execSync('net session', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Fix 5: elevation gate moved into app.whenReady below — calling dialog
// before whenReady on Windows doesn't render because no message pump exists,
// so the gate would fire app.exit(1) without showing the reason to the user.

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
    autoHideMenuBar: true,
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

  // Fix 5: elevation gate — runs after whenReady so the message box can render.
  // Calling dialog.showMessageBoxSync at module load returns silently on Windows
  // because no message pump exists yet; the user sees the process vanish.
  if (process.platform === 'win32' && app.isPackaged && !isElevated()) {
    const gateSettings = (() => {
      try { return getSettings() } catch { return null }
    })()
    if (!gateSettings?.behavior?.allowNonElevated) {
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'CompSync Media',
        message:
          'CompSync Media must run as Administrator. OBS hotkeys require elevated privileges (UIPI). Right-click the app and choose "Run as administrator".',
        buttons: ['Exit'],
      })
      logger.app.warn('Exiting: not running as administrator (elevation gate)')
      app.exit(1)
      return
    }
  }

  // Fix 12 (FIX 7): prevent OBS Safe Mode dialog after a bad exit
  try {
    const obsConfigDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'obs-studio')
      : path.join(os.homedir(), '.config', 'obs-studio')
    const sentinelPath = path.join(obsConfigDir, 'safe_mode')
    if (fs.existsSync(sentinelPath)) {
      try {
        fs.unlinkSync(sentinelPath)
        logger.app.info('Cleaned OBS safe_mode sentinel to prevent Safe Mode dialog')
      } catch (err) {
        logger.app.debug('Could not remove OBS safe_mode sentinel:', err)
      }
    }
    const legacySentinel = path.join(obsConfigDir, '.sentinel')
    if (fs.existsSync(legacySentinel)) {
      try { fs.unlinkSync(legacySentinel) } catch {}
    }
  } catch (err) {
    logger.app.debug('OBS sentinel cleanup failed:', err)
  }

  // Fix 12 (FIX 7): prevent display sleep while running
  try {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
    logger.app.info(`Power save blocker started (id=${powerBlockerId})`)
  } catch (err) {
    logger.app.warn(`Power save blocker failed: ${err instanceof Error ? err.message : err}`)
  }

  // Initialize persistent job queue (must be before any service that enqueues)
  jobQueue.init()

  // Kill orphaned FFmpeg from previous crash
  ffmpegService.killOrphanedProcess()
  wifiDisplay.killOrphanedProcess()

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
  obs.setOnReconcile((info) => {
    recording.handleObsReconcile(info)
  })

  // Load persisted state BEFORE creating window (so renderer gets correct data on first IPC)
  state.loadState()

  // Create window
  createWindow()

  // Start overlay + WebSocket hub
  overlay.startServer()
  wsHub.start()

  // Start chat bridge (connects to Supabase Realtime if share code already resolved)
  chatBridge.startChatBridge()

  // Register global hotkeys
  hotkeys.register()

  // Drive monitor disabled — using folder-watch mode for photos
  // driveMonitor.startMonitoring()
  // WPD/MTP disabled — using folder-watch mode instead
  // tether.initWPDHandlers()
  // wpdBridge.startMonitor().catch((err) => {
  //   logger.app.warn('WPD monitor start failed:', err)
  // })

  // Auto-start tether folder watch if configured
  const tetherSettings = getSettings().tether
  if (tetherSettings?.autoWatchFolder) {
    const fs = require('fs')
    if (fs.existsSync(tetherSettings.autoWatchFolder)) {
      tether.startWatching(tetherSettings.autoWatchFolder).then(() => {
        logger.app.info(`Auto-started tether watch on ${tetherSettings.autoWatchFolder}`)
      }).catch((err: Error) => {
        logger.app.warn(`Auto-start tether watch failed: ${err.message}`)
      })
    } else {
      logger.app.warn(`Tether auto-watch folder not found: ${tetherSettings.autoWatchFolder}`)
    }
  }

  // Auto-start wifi display if configured
  const wdSettings = getSettings().wifiDisplay
  if (wdSettings?.autoStart && wdSettings.monitorIndex !== null) {
    wifiDisplay.start().then(() => {
      logger.app.info('Auto-started wifi display streaming')
    }).catch((err: Error) => {
      logger.app.warn(`Auto-start wifi display failed: ${err.message}`)
    })
  }

  // Check for crash recovery
  checkAndRecover().catch((err) => {
    logger.app.warn('Crash recovery check failed:', err)
  })

  // Resolve share code on startup (needed for upload credentials even if competition is persisted)
  const settings = getSettings()
  if (settings.compsync?.shareCode) {
    schedule.resolveShareCode(settings.compsync.shareCode)
      .then(async () => {
        // Always refetch schedule on startup to pick up server-authoritative
        // changes (scheduledTime, mediaPackageStatus, mediaUpdatedAt, title
        // edits, new/removed routines). setCompetition() already merges local
        // pipeline status (status/encodedFiles/photos/etc.) into the fresh
        // routines by ID, and then runs the Phase 4 reconcile pass which
        // demotes locally-'uploaded' routines that the server reports as
        // having no media_package. Network failure falls back silently to
        // persisted state so the app still launches offline.
        try {
          const comp = await schedule.loadFromShareCode(settings.compsync.shareCode)
          state.setCompetition(comp)
          recording.broadcastFullState()
          logger.app.info(`Refetched schedule on startup: ${comp.name} (${comp.routines.length} routines)`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.app.warn(`Startup schedule refetch failed, continuing with persisted state: ${msg}`)
        }
        // Fix orphaned 'uploading' routines (job queue is in-memory, lost on restart)
        const comp = state.getCompetition()
        if (comp) {
          let resetCount = 0
          for (const r of comp.routines) {
            if (r.status === 'uploading') {
              state.updateRoutineStatus(r.id, 'encoded')
              resetCount++
            }
          }
          if (resetCount > 0) {
            logger.app.info(`Reset ${resetCount} orphaned 'uploading' routines to 'encoded'`)
            recording.broadcastFullState()
          }
        }
        // Retry orphaned completions (routines where uploads finished but completion call was lost)
        uploadService.retryOrphanedCompletions().then(count => {
          if (count > 0) logger.app.info(`Recovered ${count} orphaned upload completions`)
        }).catch(() => {})
        // Retry encoded routines that were skipped due to missing connection at encode time
        const skippedRetried = uploadService.retrySkippedEncoded()
        if (skippedRetried > 0) logger.app.info(`Retried ${skippedRetried} encoded routines that were skipped earlier`)
        // Retry incomplete photo uploads for routines already marked 'uploaded'
        const photoRetried = uploadService.retryIncompletePhotoUploads()
        if (photoRetried > 0) logger.app.info(`Retrying incomplete photo uploads for ${photoRetried} routines`)
      })
      .catch((err) => {
        logger.app.warn(`Share code resolve failed: ${err instanceof Error ? err.message : err}`)
      })
  }

  // Run startup validation (after window is ready so we can send report to renderer)
  runStartupChecks().catch((err) => {
    logger.app.warn('Startup checks failed:', err)
  })

  // Fix 3: dev-build warning banner
  if (!app.isPackaged) {
    setTimeout(() => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.DEV_BUILD_WARNING, {
          message: 'DEV BUILD — uploads go to staging or may fail. Do not use for real events.',
        })
      }
    }, 2000)

    // Fix 15: stale renderer bundle check (dev only)
    try {
      const mainJs = path.join(__dirname, 'index.js')
      const rendererDir = path.join(__dirname, '../renderer/assets')
      if (fs.existsSync(mainJs) && fs.existsSync(rendererDir)) {
        const mainMtime = fs.statSync(mainJs).mtimeMs
        let rendererMtime = 0
        for (const e of fs.readdirSync(rendererDir)) {
          if (!e.endsWith('.js')) continue
          const p = path.join(rendererDir, e)
          const st = fs.statSync(p)
          if (st.mtimeMs > rendererMtime) rendererMtime = st.mtimeMs
        }
        if (mainMtime > rendererMtime + 60000) {
          logger.app.warn(`Renderer bundle appears stale (main is ${Math.round((mainMtime - rendererMtime) / 1000)}s newer)`)
          setTimeout(() => {
            const win = BrowserWindow.getAllWindows()[0]
            if (win && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.DEV_BUILD_WARNING, {
                message: 'STALE RENDERER BUNDLE — run the renderer build. UI may not match main process.',
              })
            }
          }, 3000)
        }
      }
    } catch (err) {
      logger.app.debug('Stale bundle check failed:', err)
    }
  }
})

app.on('window-all-closed', () => {
  logger.app.info('All windows closed')
  app.quit()
})

app.on('before-quit', async (event) => {
  logger.app.info('Graceful shutdown starting...')

  if (powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId) } catch {}
    powerBlockerId = null
  }

  // Cancel active FFmpeg
  ffmpegService.cancelCurrent()

  // Flush persistent state
  state.saveStateImmediate()
  jobQueue.cleanup()

  // Stop wifi display
  wifiDisplay.cleanup()

  // Stop servers + hotkeys + monitors
  hotkeys.unregister()
  systemMonitor.stopMonitoring()
  driveMonitor.stopMonitoring()
  chatBridge.stopChatBridge()
  // await wpdBridge.stop() // WPD disabled
  wsHub.stop()
  overlay.stopServer()

  // Disconnect OBS with timeout to avoid blocking shutdown
  try {
    await Promise.race([
      obs.disconnect(),
      new Promise(r => setTimeout(r, 3000)),
    ])
  } catch {}

  logger.app.info('Graceful shutdown complete')
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
