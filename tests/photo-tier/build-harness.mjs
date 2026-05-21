#!/usr/bin/env node
/**
 * Bundles harness-entry.ts with esbuild (the SAME bundler electron-vite uses,
 * v0.21.5) so the photo-tier logic exercised is byte-identical to what the
 * packaged app.asar runs. Only the two I/O BOUNDARIES are aliased — never the
 * logic under test.
 *
 *   - 'electron'  : filesystem/window boundary. app.getPath -> isolated tmp
 *                   userData; BrowserWindow.getAllWindows -> []; dialog no-op.
 *   - 'schedule'  : the share-code resolver is a NETWORK GET, not the tiered
 *                   selection logic. Aliased to a fixed in-memory connection;
 *                   the REAL enqueueRoundRobin/enqueueRoutine/getNext run.
 *
 * Output: tests/photo-tier/.build/harness.cjs  (run with node).
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HD = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HD, '../..')
const UD = process.env.PT_UD || '/tmp/cse-photo-tier-ud'
const OUT = path.join(HD, '.build', 'harness.cjs')

fs.rmSync(UD, { recursive: true, force: true })
fs.mkdirSync(path.join(UD, 'logs'), { recursive: true })
fs.mkdirSync(path.dirname(OUT), { recursive: true })

const electronShim = `
const _ud = ${JSON.stringify(UD)};
exports.app = {
  getPath: (n) => _ud,
  getName: () => 'compsync-photo-tier-harness',
  getVersion: () => '0.0.0-harness',
  getAppPath: () => _ud,
  isPackaged: false,
  isReady: () => true,
  on: () => {}, off: () => {}, once: () => {}, whenReady: () => Promise.resolve(),
  quit: () => {}, exit: () => {}, requestSingleInstanceLock: () => true,
  setPath: () => {}, getLocale: () => 'en-US',
};
exports.BrowserWindow = function(){};
exports.BrowserWindow.getAllWindows = () => [];
exports.BrowserWindow.fromWebContents = () => null;
exports.dialog = { showMessageBox: async () => ({ response: 0 }), showMessageBoxSync: () => 0, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }), showErrorBox: () => {} };
exports.ipcMain = { on: () => {}, handle: () => {}, removeHandler: () => {}, removeAllListeners: () => {} };
exports.shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} };
exports.Notification = function(){ return { show(){}, on(){} }; };
exports.Notification.isSupported = () => false;
exports.nativeImage = { createFromPath: () => ({ isEmpty: () => true, toDataURL: () => '' }), createEmpty: () => ({ isEmpty: () => true }) };
exports.safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
exports.powerSaveBlocker = { start: () => 0, stop: () => {}, isStarted: () => false };
exports.screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }), getAllDisplays: () => [] };
exports.Tray = function(){ return { setToolTip(){}, setContextMenu(){}, on(){}, destroy(){} }; };
exports.Menu = function(){}; exports.Menu.buildFromTemplate = () => ({}); exports.Menu.setApplicationMenu = () => {};
exports.globalShortcut = { register: () => true, unregister: () => {}, unregisterAll: () => {} };
exports.session = { defaultSession: { webRequest: { onBeforeRequest(){} }, clearCache: async () => {} } };
exports.default = exports;
`

// In-memory schedule shim: REAL ResolvedConnection shape, fixed values. This
// is the network boundary only — enqueue paths read conn.competitionId /
// apiBase / apiKey; getResolvedConnection()!==null gates upload start.
const scheduleShim = `
const _conn = {
  tenant: 'pt-fixture-tenant',
  competitionId: 'pt-fixture-competition',
  apiBase: 'http://harness.invalid',
  name: 'Photo-Tier Fixture',
  apiKey: 'pt-harness-key',
};
exports.getResolvedConnection = () => _conn;
exports.clearResolvedConnection = () => {};
exports.resolveShareCode = async () => _conn;
exports.buildFilePrefix = (entryNumber) => 'E' + String(entryNumber);
`

const ioBoundaryAlias = {
  name: 'pt-io-boundary-alias',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({
      path: 'electron-shim',
      namespace: 'pt-shim',
    }))
    // Match the schedule module however it's imported ('./schedule',
    // '../services/schedule', absolute). Resolve by basename.
    build.onResolve({ filter: /(^|\/)schedule$/ }, (args) => {
      if (args.namespace === 'pt-shim') return
      return { path: 'schedule-shim', namespace: 'pt-shim' }
    })
    build.onLoad({ filter: /.*/, namespace: 'pt-shim' }, (args) => {
      if (args.path === 'electron-shim') return { contents: electronShim, loader: 'js' }
      if (args.path === 'schedule-shim') return { contents: scheduleShim, loader: 'js' }
      return null
    })
  },
}

await esbuild.build({
  entryPoints: [path.join(HD, 'harness-entry.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: OUT,
  plugins: [ioBoundaryAlias],
  // sharp is a native binding pulled transitively by ffmpeg.ts's thumbnail
  // path — NOT the tier logic under test, and never invoked in this scenario
  // (no thumbnail generation). Keep it external so esbuild doesn't choke on
  // the .node binary; it's lazily required only if a thumbnail is generated,
  // which this fixture never triggers. electron-store/conf ARE bundled so
  // their internal require('electron') resolves to the shim above.
  external: ['sharp'],
  logLevel: 'warning',
  sourcemap: false,
})

console.log(`harness bundled -> ${OUT} (UD=${UD})`)
