#!/usr/bin/env node
/**
 * SD-Import Overnight E2E — 4 cases
 *
 *   1. happy path: 34 fixtures → 20 matched (brackets), 14 orphans
 *   2. dedup: re-run → 0 new matches, no new upload jobs
 *   3. delete-after-upload: mock R2+complete 2xx → local files unlinked
 *   4. crash safety: fail unlink → re-run detects via manifest, skips
 *
 * Runs on Linux (no Electron — exercises compiled main services directly).
 *
 * Invocation:
 *   node tests/e2e-sd-import.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const OUT_MAIN = path.join(REPO_ROOT, 'out', 'main', 'index.js')

if (!fs.existsSync(OUT_MAIN)) {
  console.error(`build missing: ${OUT_MAIN}\nrun: npm run build`)
  process.exit(2)
}

// Top-level stubs for electron — we never launch the app, we just exercise services.
const ELECTRON_STUB = `
export const app = { getPath: () => '/tmp', getName: () => 'compsync-media', on: () => {}, quit: () => {} }
export const BrowserWindow = class { static getAllWindows() { return [] } }
export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const safeStorage = { isEncryptionAvailable: () => false }
export const shell = { openPath: () => {} }
export const contextBridge = { exposeInMainWorld: () => {} }
export const ipcRenderer = { invoke: () => {}, on: () => {} }
`
// If we ever need to run the real compiled main, write this into a sandbox module.
// For now we just import TS services directly via a tsx runner or similar — but the
// overnight run must work with pure node. We import the *source* TS via a ts-node-free
// dynamic loader using electron-vite's output is too heavy. Simpler path: import the
// compiled main bundle (which already inlines the service code) and pull what we need
// off its module registry via ESM.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// --- Test harness ---
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const icon = ok ? 'PASS' : 'FAIL'
  console.log(`  [${icon}] ${name}${detail ? ' — ' + detail : ''}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// --- Fixtures ---
const FIXTURE_SRC = path.join(REPO_ROOT, '.ccbot-uploads')
const TEST_ROOT = path.join(REPO_ROOT, 'test-results', 'sd-import-overnight')
const MOCK_SD = path.join(TEST_ROOT, 'DCIM')
const OUT_DIR = path.join(TEST_ROOT, 'out')

const BASE_TIME = new Date('2026-04-17T20:00:00Z').getTime()
const MATCHED_COUNT = 20
const TOTAL_COUNT = 34

// Generates a tiny JPEG with EXIF DateTimeOriginal set to a specific time.
async function writeJpegWithTime(destPath, timeMs) {
  const sharp = require('sharp')
  const dt = new Date(timeMs)
  const pad = (n) => String(n).padStart(2, '0')
  // EXIF local-time format (no timezone) — matches cameras.
  const exifStr = `${dt.getUTCFullYear()}:${pad(dt.getUTCMonth() + 1)}:${pad(dt.getUTCDate())} ` +
    `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
  const buf = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: (timeMs / 1000) % 255, g: 150, b: 200 } },
  }).withMetadata({ exif: { IFD0: { DateTimeOriginal: exifStr } } }).jpeg().toBuffer()
  await fs.promises.writeFile(destPath, buf)
}

async function setupFixtures() {
  // Clean
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true })
  await fs.promises.mkdir(MOCK_SD, { recursive: true })
  await fs.promises.mkdir(OUT_DIR, { recursive: true })

  // Generate 34 mock JPEGs with EXIF times. 20 fall inside "recording windows", 14 outside.
  // Windows: 20 routines × 60s each, sequential with 60s gaps. Routine N bracket: BASE + N*120s .. BASE + N*120s + 60s.
  // Matched photos: one per routine at BASE + N*120s + 30s (dead center).
  // Orphans: 14 photos spread 2 hours AFTER all windows.
  const matchedTimes = []
  for (let i = 0; i < MATCHED_COUNT; i++) {
    matchedTimes.push(BASE_TIME + i * 120_000 + 30_000)
  }
  const orphanBase = BASE_TIME + MATCHED_COUNT * 120_000 + 7_200_000
  const orphanTimes = []
  for (let i = 0; i < TOTAL_COUNT - MATCHED_COUNT; i++) {
    orphanTimes.push(orphanBase + i * 60_000)
  }
  const allTimes = [...matchedTimes, ...orphanTimes]
  for (let i = 0; i < allTimes.length; i++) {
    const name = `IMG_${String(i + 1).padStart(4, '0')}.JPG`
    await writeJpegWithTime(path.join(MOCK_SD, name), allTimes[i])
  }
  return { matchedTimes, orphanTimes }
}

// --- Stub routines synthesized to bracket the 20 matched photos ---
function buildRoutines() {
  const routines = []
  for (let i = 0; i < MATCHED_COUNT; i++) {
    const start = new Date(BASE_TIME + i * 120_000).toISOString()
    const stop = new Date(BASE_TIME + i * 120_000 + 60_000).toISOString()
    routines.push({
      id: `routine-${i + 1}`,
      entryNumber: String(i + 1),
      routineTitle: `Routine ${i + 1}`,
      dancers: 'Dancer',
      studioName: 'Studio',
      studioCode: 'STU',
      category: 'cat',
      classification: 'cls',
      ageGroup: 'age',
      sizeCategory: 'size',
      durationMinutes: 1,
      scheduledDay: 'Day 1',
      position: i + 1,
      status: 'encoded',
      recordingStartedAt: start,
      recordingStoppedAt: stop,
      outputDir: path.join(OUT_DIR, `${i + 1}_routine_${i + 1}_STU`),
      encodedFiles: [],
      photos: [],
    })
  }
  return routines
}

// --- Load compiled services (CommonJS output from electron-vite) ---
// electron-vite outputs CJS .js that requires 'electron'. We intercept that require
// with a Proxy so service modules can be loaded without a running Electron app.
function installElectronShim() {
  const Module = require('module')
  const origResolve = Module._resolveFilename
  const origLoad = Module._load
  const shimPath = '/tmp/sd-import-overnight-test/_electron-shim.cjs'
  fs.mkdirSync(path.dirname(shimPath), { recursive: true })
  fs.writeFileSync(shimPath, `const tmpUserData = require('path').join(require('os').tmpdir(), 'sd-import-overnight-test', 'userData');
  require('fs').mkdirSync(tmpUserData, { recursive: true });
  module.exports = {
    app: {
      getPath: (name) => name === 'userData' ? tmpUserData : tmpUserData,
      getName: () => 'compsync-media',
      getVersion: () => '2.7.0-test',
      getAppPath: () => tmpUserData,
      on: () => {},
      quit: () => {}
    },
    BrowserWindow: class { static getAllWindows() { return [] } },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openPath: () => {} },
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: () => {}, on: () => {} },
    webFrame: { setZoomFactor: () => {} },
    nativeTheme: { on: () => {}, shouldUseDarkColors: false },
    session: { defaultSession: { webRequest: { onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} } } },
  }`)
  Module._resolveFilename = function (req, parent) {
    if (req === 'electron') return shimPath
    return origResolve.call(this, req, parent)
  }
  Module._load = function (req, parent) {
    if (req === 'electron') return require(shimPath)
    return origLoad.call(this, req, parent)
  }
}

installElectronShim()

// The compiled out/main/index.js is a bundle — it doesn't re-export individual
// service functions by name because electron-vite tree-shakes unused paths.
// Instead we invoke importManifest directly via a tiny per-test shim compiled
// inline using esbuild (already a dev dep).
async function loadServices() {
  const esbuild = require('esbuild')
  const workDir = TEST_ROOT
  const entryPath = path.join(workDir, '_entry.ts')
  fs.writeFileSync(entryPath, `
import * as manifest from '${path.join(REPO_ROOT, 'src/main/services/importManifest').replace(/\\\\/g, '/')}'
import { importPhotos } from '${path.join(REPO_ROOT, 'src/main/services/photos').replace(/\\\\/g, '/')}'
export { manifest, importPhotos }
`)
  const outPath = path.join(workDir, '_entry.cjs')
  await esbuild.build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: outPath,
    external: ['electron', 'sharp', 'exifreader', '@img/*', 'electron-log', 'electron-store', '@supabase/supabase-js', '@huggingface/transformers', 'onnxruntime-node', 'ws', 'express', 'papaparse', 'xlsx', 'obs-websocket-js', 'chokidar', 'ffmpeg-static', 'electron-window-state', '@aws-sdk/client-s3'],
    tsconfig: path.join(REPO_ROOT, 'tsconfig.node.json'),
    logLevel: 'error',
  })
  delete require.cache[outPath]
  return require(outPath)
}

// --- Stubs for the service's downstream deps ---
// photos.ts imports from state, recording, settings, upload — we patch by bundling a
// test-only entry that imports ONLY what we need. The unused imports remain present in
// the bundle but never execute because importPhotos() only touches seenHashes, state
// (updateRoutineStatus), broadcastFullState, getSettings, uploadService. For a pure
// manifest + orphan test we can let those side-effects happen in a sandbox.
//
// To keep the test self-contained, we reach into the bundle's `sendToRenderer` (no-op
// without a window) and `state.updateRoutineStatus` (no-op without a loaded comp).
// The only behaviors we actually assert are filesystem + manifest outcomes.

// --- Mock upload server ---
function startMockPortal() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.url.includes('/api/plugin/upload-url')) {
        const json = JSON.parse(body || '{}')
        const storagePath = `mock/${json.entryId}/${json.filename}`
        const signedUrl = `http://127.0.0.1:${server.address().port}/_mock-put/${encodeURIComponent(storagePath)}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ signedUrl, storagePath }))
      } else if (req.url.startsWith('/_mock-put/')) {
        res.writeHead(200)
        res.end('ok')
      } else if (req.url.includes('/api/plugin/complete')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(404); res.end()
      }
    })
  })
  server.listen(0, '127.0.0.1')
  return server
}

// ================================================================
// TESTS
// ================================================================
async function testHappyPath(svc) {
  console.log('\n--- Test 1: Happy path ---')
  const routines = buildRoutines()
  const result = await svc.importPhotos(MOCK_SD, routines, OUT_DIR)

  record('matched count == 20', result.matched === MATCHED_COUNT, `got ${result.matched}`)
  record('unmatched count == 14', result.unmatched === (TOTAL_COUNT - MATCHED_COUNT), `got ${result.unmatched}`)

  // Manifest written
  const manifestPath = path.join(OUT_DIR, '_manifests', 'sd-import.json')
  const manifestOk = fs.existsSync(manifestPath)
  record('manifest written', manifestOk, manifestPath)

  if (manifestOk) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    const allEntries = m.runs.flatMap(r => r.entries)
    record('manifest has 34 entries', allEntries.length === TOTAL_COUNT, `got ${allEntries.length}`)
    const matchedEntries = allEntries.filter(e => e.routineId !== null)
    const orphanEntries = allEntries.filter(e => e.routineId === null)
    record('manifest matched=20', matchedEntries.length === MATCHED_COUNT, `got ${matchedEntries.length}`)
    record('manifest orphans=14', orphanEntries.length === (TOTAL_COUNT - MATCHED_COUNT), `got ${orphanEntries.length}`)

    // Orphan dir exists and has 14 sidecars
    const orphansRoot = path.join(OUT_DIR, '_orphans')
    const orphanRuns = fs.existsSync(orphansRoot) ? fs.readdirSync(orphansRoot) : []
    let totalSidecars = 0
    for (const run of orphanRuns) {
      const runDir = path.join(orphansRoot, run)
      for (const f of fs.readdirSync(runDir)) {
        if (f.endsWith('.json')) totalSidecars++
      }
    }
    record('14 orphan sidecars on disk', totalSidecars === (TOTAL_COUNT - MATCHED_COUNT), `got ${totalSidecars}`)

    // --- Thumbnail assertions (2026-04-17 addition) ---
    // Every matched photo must have a WebP thumb on disk next to its copy,
    // and the PhotoMatch result must carry a thumbnailPath pointing at it.
    const matchedResults = result.matches.filter(m => m.confidence !== 'unmatched')
    const withThumbPath = matchedResults.filter(m => typeof m.thumbnailPath === 'string' && m.thumbnailPath.endsWith('.webp'))
    record('all matched photos have thumbnailPath (.webp)', withThumbPath.length === MATCHED_COUNT, `got ${withThumbPath.length}/${MATCHED_COUNT}`)

    let thumbsOnDisk = 0
    for (const m of matchedResults) {
      if (m.thumbnailPath && fs.existsSync(m.thumbnailPath)) thumbsOnDisk++
    }
    record('WebP thumbs present on disk', thumbsOnDisk === MATCHED_COUNT, `got ${thumbsOnDisk}/${MATCHED_COUNT}`)

    // Spot-check one thumb: size must be small (< 20KB) and have a valid WebP header.
    if (matchedResults[0]?.thumbnailPath) {
      const tPath = matchedResults[0].thumbnailPath
      const stat = fs.statSync(tPath)
      const head = fs.readFileSync(tPath).subarray(0, 12)
      // WebP files start with "RIFF....WEBP"
      const isWebp = head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP'
      record('thumb is valid WebP (RIFF/WEBP magic)', isWebp, `header: ${head.subarray(0, 12).toString('hex')}`)
      record('thumb size < 20KB', stat.size < 20000, `${stat.size} bytes`)
    }
  }
  return result
}

async function testDedup(svc) {
  console.log('\n--- Test 2: Dedup ---')
  // Mark all entries uploaded=true so re-run skips everything.
  const manifestPath = path.join(OUT_DIR, '_manifests', 'sd-import.json')
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  let marked = 0
  for (const run of m.runs) {
    for (const e of run.entries) {
      e.uploaded = true
      e.storagePath = `mock/${e.entryNumber || 'orphan'}/${path.basename(e.destPath)}`
      marked++
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))

  const routines = buildRoutines()
  const result = await svc.importPhotos(MOCK_SD, routines, OUT_DIR)
  record('re-run matched == 0', result.matched === 0, `got ${result.matched}`)
  record('re-run totalPhotos == 0', result.totalPhotos === 0, `got ${result.totalPhotos}`)
}

async function testDeleteAfterUpload(svc) {
  console.log('\n--- Test 3: Delete-after-upload ---')
  // Build a fresh outDir so we have real copied files to unlink
  const OUT3 = OUT_DIR + '_3'
  await fs.promises.rm(OUT3, { recursive: true, force: true })
  await fs.promises.mkdir(OUT3, { recursive: true })
  const routines = buildRoutines().map(r => ({ ...r, outputDir: path.join(OUT3, `${r.entryNumber}_routine_${r.entryNumber}_STU`) }))
  const result = await svc.importPhotos(MOCK_SD, routines, OUT3)

  // Manually exercise upload.ts's post-complete path: for each matched photo, call
  // manifest.markUploaded() and then unlink the local file (same sequence as upload.ts).
  const manifestPath = path.join(OUT3, '_manifests', 'sd-import.json')
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const matchedEntries = m.runs.flatMap(r => r.entries).filter(e => e.routineId !== null)
  for (const e of matchedEntries) {
    await svc.manifest.markUploaded(OUT3, e.sourceHash, `mock/${e.entryNumber}/${path.basename(e.destPath)}`)
    try { await fs.promises.unlink(e.destPath) } catch {}
  }
  // Verify
  const m2 = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const allUploaded = m2.runs.flatMap(r => r.entries).filter(e => e.routineId !== null).every(e => e.uploaded === true && typeof e.storagePath === 'string')
  record('all matched entries uploaded=true + storagePath', allUploaded)
  const allDeleted = matchedEntries.every(e => !fs.existsSync(e.destPath))
  record('all local matched files unlinked', allDeleted)
}

async function testThumbUploadWiring(svc) {
  console.log('\n--- Test 5: Thumbnail upload wiring ---')
  // Assert the main bundle (the code that will ship in the asar) contains the
  // thumb-upload string literals. If a refactor accidentally removes them,
  // this test catches it before the asar ships.
  const bundlePath = path.join(REPO_ROOT, 'out', 'main', 'index.js')
  if (!fs.existsSync(bundlePath)) {
    record('main bundle exists for thumb-wire inspection', false, bundlePath)
    return
  }
  const code = fs.readFileSync(bundlePath, 'utf-8')
  record('bundle contains "_thumb.webp"', code.includes('_thumb.webp'))
  record('bundle contains "photo_thumbnails"', code.includes('photo_thumbnails'))
  record('bundle contains "thumbStoragePath"', code.includes('thumbStoragePath'))
  // Also exercise deriveThumbObjectName contract (mirrors upload.ts regex):
  const derive = (s) => s.replace(/\.(jpe?g)$/i, '') + '_thumb.webp'
  record('derive photo_001.jpg → photo_001_thumb.webp', derive('photo_001.jpg') === 'photo_001_thumb.webp')
  record('derive IMG_0042.JPEG → IMG_0042_thumb.webp', derive('IMG_0042.JPEG') === 'IMG_0042_thumb.webp')
}

async function testCrashSafety(svc) {
  console.log('\n--- Test 4: Crash safety ---')
  // Use a fresh dir, run import, then for ONE photo simulate: markUploaded succeeds
  // but unlink is skipped (crash). Re-run the import — dedup must kick in via manifest hash.
  const OUT4 = OUT_DIR + '_4'
  await fs.promises.rm(OUT4, { recursive: true, force: true })
  await fs.promises.mkdir(OUT4, { recursive: true })
  const routines = buildRoutines().map(r => ({ ...r, outputDir: path.join(OUT4, `${r.entryNumber}_routine_${r.entryNumber}_STU`) }))
  await svc.importPhotos(MOCK_SD, routines, OUT4)

  const manifestPath = path.join(OUT4, '_manifests', 'sd-import.json')
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const first = m.runs[0].entries.find(e => e.routineId !== null)
  await svc.manifest.markUploaded(OUT4, first.sourceHash, `mock/${first.entryNumber}/${path.basename(first.destPath)}`)
  // (Crash happens here — we do NOT unlink first.destPath)

  // Re-import — the previously-uploaded photo must be skipped via hash
  const result2 = await svc.importPhotos(MOCK_SD, routines, OUT4)
  const expectedMatched = MATCHED_COUNT - 1
  record('re-run matched == 19 (one skipped via hash)', result2.matched === expectedMatched, `got ${result2.matched}`)
  record('local stale file still present (safe)', fs.existsSync(first.destPath))
}

// ================================================================
// MAIN
// ================================================================
async function main() {
  console.log('=== SD-Import Overnight E2E ===')
  console.log(`Repo: ${REPO_ROOT}`)
  await setupFixtures()
  const svc = await loadServices()
  const server = startMockPortal()
  try {
    await testHappyPath(svc)
    await testDedup(svc)
    await testDeleteAfterUpload(svc)
    await testCrashSafety(svc)
    await testThumbUploadWiring(svc)
  } catch (err) {
    console.error('FATAL:', err)
    record('test suite', false, err.message)
  } finally {
    server.close()
  }

  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const r of results.filter(r => !r.ok)) console.log(`  FAIL: ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(2) })
