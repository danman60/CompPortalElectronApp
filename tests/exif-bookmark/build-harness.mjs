#!/usr/bin/env node
/**
 * Bundles harness-entry.ts with esbuild (the SAME bundler electron-vite uses)
 * so the photos.ts / state.ts dedup logic exercised is byte-identical to what
 * the packaged app.asar runs. Only the genuine I/O BOUNDARIES are aliased —
 * never the dedup logic under test.
 *
 *   - 'electron'              : filesystem/window boundary. app.getPath ->
 *                               isolated tmp userData; BrowserWindow/dialog
 *                               no-ops.
 *   - '../utils/volumeSerial' : the `vol F:` Windows shell cmd is unavailable
 *                               on Linux. Aliased to a deterministic
 *                               cardRoot -> serial map. THIS SHIM IS THE ONLY
 *                               substitute for the OS volume command; the
 *                               cursor/bookmark KEYING that consumes the
 *                               serial is the REAL photos.ts/state.ts code.
 *   - './recording'           : broadcastFullState is a renderer IPC push,
 *                               not dedup logic. No-op.
 *
 * Output: tests/exif-bookmark/.build/harness.cjs  (run with node).
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HD = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HD, '../..')
const UD = process.env.EB_UD || '/tmp/cse-exif-bookmark-ud'
const CARD = process.env.EB_CARD || '/tmp/cse-exif-bookmark-card'
const OUT = path.join(HD, '.build', 'harness.cjs')

fs.mkdirSync(path.join(UD, 'logs'), { recursive: true })
fs.mkdirSync(path.dirname(OUT), { recursive: true })

const electronShim = `
const _ud = ${JSON.stringify(UD)};
exports.app = {
  getPath: (n) => _ud,
  getName: () => 'compsync-exif-bookmark-harness',
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

// Deterministic stand-in for the OS \`vol F:\` command.
//
// FIDELITY NOTE: on Windows the REAL getVolumeInfo distinguishes cards by
// drive letter (path.parse('F:\\\\...').root = 'F:\\\\'); photos.ts passes
// that letter. On Linux path.parse('/tmp/...').root is '/' for EVERY card —
// the OS volume command genuinely cannot run here. So the shim stands in for
// the OS command exactly the way the operator's workflow does: at any moment
// the import is processing ONE inserted card (importPhotos is FIFO-serialized,
// one folderPath per call). The harness sets EB_ACTIVE_CARD to the card root
// being imported; the shim returns THAT card's serial. The per-volume cursor
// + per-(serial,subfolder) filename-bookmark KEYING that consumes the serial
// is the REAL photos.ts/state.ts code — NOT shimmed. We additionally map by
// path prefix so a non-root driveRoot still resolves correctly if a future
// caller passes one.
const CARD_G = CARD + '-G'
const CARD_H = CARD + '-H'
const volumeSerialShim = `
const fs = require('fs');
const MAP = ${JSON.stringify({
  [CARD]: { serial: 'EB001CARD', label: 'EB_CARD' },
  [CARD_G]: { serial: 'EB00GCARD', label: 'EB_CARD_G' },
  // CARD_H intentionally absent => unknown card (serial '').
})};
function norm(p){ return String(p || '').replace(/[\\\\/]+$/,''); }
function activeCardSignal(){
  // The harness writes the card root currently being imported here. This is
  // the faithful stand-in for "which physical card is in the reader" — the
  // exact thing the Windows \`vol\` command answers per drive letter.
  try { return norm(fs.readFileSync('/tmp/cse-eb-active-card', 'utf8').trim()); } catch { return ''; }
}
function lookup(driveRoot){
  const r = norm(driveRoot);
  // 1) Exact / prefix match on a known card root (Windows-letter analogue).
  for (const k of Object.keys(MAP)) {
    if (r === k || r.startsWith(k + '/')) return MAP[k];
  }
  // 2) driveRoot is the POSIX collapsed root ('/') — resolve via the active
  //    card signal (one card per import, exactly like a single reader slot).
  const active = activeCardSignal();
  if (active && MAP[active]) return MAP[active];
  // 3) Unknown card (CARD_H / anything unmapped) => serial '' == the REAL
  //    non-Windows / unreadable failure path. No pre-skip (fail-safe).
  return { serial: '', label: '' };
}
exports.getVolumeInfo = (driveRoot) => lookup(driveRoot);
exports.getVolumeSerial = (driveRoot) => lookup(driveRoot).serial;
exports.clearVolumeCache = () => {};
exports.default = exports;
`

// broadcastFullState is a renderer IPC push (not dedup logic). The rest of
// recording.ts is heavy (OBS, ffmpeg) and not on the import dedup path; we
// only need the symbol photos.ts imports.
const recordingShim = `
exports.broadcastFullState = () => {};
exports.broadcastFullStateImmediate = () => {};
exports.default = exports;
`

const ioBoundaryAlias = {
  name: 'eb-io-boundary-alias',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({
      path: 'electron-shim', namespace: 'eb-shim',
    }))
    build.onResolve({ filter: /(^|\/)volumeSerial$/ }, (args) => {
      if (args.namespace === 'eb-shim') return
      return { path: 'volumeserial-shim', namespace: 'eb-shim' }
    })
    build.onResolve({ filter: /(^|\/)recording$/ }, (args) => {
      if (args.namespace === 'eb-shim') return
      return { path: 'recording-shim', namespace: 'eb-shim' }
    })
    build.onLoad({ filter: /.*/, namespace: 'eb-shim' }, (args) => {
      if (args.path === 'electron-shim') return { contents: electronShim, loader: 'js' }
      if (args.path === 'volumeserial-shim') return { contents: volumeSerialShim, loader: 'js' }
      if (args.path === 'recording-shim') return { contents: recordingShim, loader: 'js' }
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
  // sharp = native binding pulled transitively by ffmpeg.ts's thumbnail path.
  // The ONLY caller reachable here is the unknown-card inline thumbnail, which
  // photos.ts fires as `void generateInlineThumbBase64().then().catch(()=>{})`
  // — fully swallowed, cannot affect the dedup verdict. Keep it external so
  // esbuild doesn't choke on the .node binary.
  external: ['sharp'],
  logLevel: 'warning',
  sourcemap: false,
})

console.log(`harness bundled -> ${OUT} (UD=${UD})`)
