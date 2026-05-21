#!/usr/bin/env node
/**
 * Archive Media — CSE-local headless test (TEST2026 synthetic fixture ONLY).
 *
 * Launches the built electron-vite bundle (out/main/index.js) headless with
 * a private userData dir + a synthetic TEST2026 competition state that has
 * ONE recorded routine pointing at a temp routine folder containing real
 * local media bytes. Drives the renderer via CDP to:
 *   1. Screenshot the LIVE CHAT panel (verify highlight CSS classes present)
 *   2. Open a routine's ⋯ row-action menu, screenshot the "Archive Media" item
 *   3. Invoke Archive Media, then verify:
 *        a. local media files still EXIST in _archive/v1/ (moved, NOT deleted)
 *        b. the routine state was reset to pre-record `pending`
 *
 * No OBS, no CompPortal, no network, no DB. Pure CSE-local.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import http from 'http'
import os from 'os'
import crypto from 'crypto'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const OUT_MAIN = path.join(ROOT, 'out/main/index.js')
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron')
const SHOT_DIR = '/tmp/archive-media-test'
const CDP_PORT = 9242
const results = []
function rec(name, status, detail) { results.push({ name, status, detail }); console.log(`[${status}] ${name}${detail ? ' — ' + detail : ''}`) }

// --- Synthetic TEST2026 fixture -------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'am-test-'))
const userData = path.join(work, 'userData')
const outputRoot = path.join(work, 'recordings')
fs.mkdirSync(userData, { recursive: true })
// Routine folder layout mirrors getRoutineOutputDir: <baseDir>/<shareCode>/<entry>
const shareCode = 'TEST2026'
const routineDir = path.join(outputRoot, shareCode, '777')
fs.mkdirSync(routineDir, { recursive: true })
const mkvPath = path.join(routineDir, 'R777_test.mkv')
const kfPath = path.join(routineDir, 'keyframe_50.webp')
const MKV_BYTES = Buffer.alloc(2 * 1024 * 1024, 7) // 2MB sentinel
fs.writeFileSync(mkvPath, MKV_BYTES)
fs.writeFileSync(kfPath, Buffer.from('WEBPxFAKEKEYFRAME'))
const mkvSha = crypto.createHash('sha256').update(MKV_BYTES).digest('hex')

const TEST_ROUTINE_ID = '11111111-2222-3333-4444-555555555777'
const fixture = {
  competition: {
    tenantId: 'TEST2026',
    competitionId: 'test-2026-archive-media',
    name: 'TEST2026 Archive Media Harness',
    source: 'csv',
    loadedAt: new Date().toISOString(),
    days: ['2026-05-17'],
    routines: [{
      id: TEST_ROUTINE_ID,
      entryNumber: '777',
      routineTitle: 'Archive Media Test Routine',
      dancers: 'Test Dancer',
      studioName: 'Test Studio',
      studioCode: 'TST',
      category: 'Test | Sapphire | Lyrical | Age 11',
      classification: 'Sapphire',
      ageGroup: 'Age 11',
      sizeCategory: 'Solo',
      durationMinutes: 3,
      scheduledDay: '2026-05-17',
      position: 1,
      status: 'uploaded',
      recordingStartedAt: '2026-05-17T12:00:00.000Z',
      recordingStoppedAt: '2026-05-17T12:03:00.000Z',
      outputPath: mkvPath,
      outputDir: routineDir,
      encodedFiles: [{ role: 'performance', filePath: mkvPath, uploaded: true }],
      keyframes: [kfPath],
    }],
  },
  currentRoutineId: TEST_ROUTINE_ID,
  savedAt: new Date().toISOString(),
  takes: [{
    takeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    startedAt: '2026-05-17T12:00:00.000Z',
    stoppedAt: '2026-05-17T12:03:00.000Z',
    mkvPath: mkvPath,
    currentRoutineId: TEST_ROUTINE_ID,
  }],
}
fs.writeFileSync(path.join(userData, 'compsync-state.json'), JSON.stringify(fixture, null, 2))
// Settings: point fileNaming.outputDirectory at our temp root so any path
// resolution lands in the sandbox; disable share-code/network startup.
const settings = {
  fileNaming: { outputDirectory: outputRoot, pattern: '{entry_number}_{routine_title}' },
  wifiDisplay: { encoder: 'openh264' },
}
fs.writeFileSync(path.join(userData, 'compsync-media-settings.json'), JSON.stringify(settings, null, 2))

console.log('workdir:', work)
console.log('routineDir:', routineDir)
console.log('seeded mkv:', mkvPath, MKV_BYTES.length, 'bytes sha', mkvSha.slice(0, 16))

fs.mkdirSync(SHOT_DIR, { recursive: true })

// --- CDP helpers ----------------------------------------------------------
function cdpHttp(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname }, (res) => {
      let b = ''
      res.on('data', (d) => (b += d))
      res.on('end', () => resolve(b))
    }).on('error', reject)
  })
}
async function waitForCdp(timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const body = await cdpHttp('/json/list')
      const targets = JSON.parse(body)
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'))
      if (page) return page
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('CDP did not come up')
}

import WebSocket from 'ws'
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map() }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        }
      })
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  async screenshot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    const p = path.join(SHOT_DIR, name)
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'))
    console.log('screenshot:', p)
    return p
  }
}

// --- Launch ---------------------------------------------------------------
const child = spawn(ELECTRON, [
  OUT_MAIN,
  `--remote-debugging-port=${CDP_PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${userData}`,
  '--no-sandbox',
], {
  cwd: ROOT,
  env: { ...process.env, COMPSYNC_USERDATA: userData, NODE_ENV: 'production', DISPLAY: process.env.DISPLAY || ':0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
child.stdout.on('data', (d) => { appLog += d })
child.stderr.on('data', (d) => { appLog += d })

let cdp
async function main() {
  const page = await waitForCdp(40000)
  cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // Let renderer settle + dismiss any startup overlay/modal (Camera Clock
  // Check, DEV-build banner, etc). Clicks acknowledge/dismiss buttons by
  // text, plus any explicit close affordance. Runs twice to clear stacked
  // modals.
  await new Promise((r) => setTimeout(r, 6000))
  for (let i = 0; i < 3; i++) {
    await cdp.eval(`(()=>{
      let n=0;
      document.querySelectorAll('.modal-close,.overlay-dismiss,[data-dismiss]').forEach(e=>{e.click();n++});
      for (const b of [...document.querySelectorAll('button')]) {
        const t=(b.textContent||'').toLowerCase();
        if (t.includes('acknowledg')||t.includes('dismiss')||t.includes('got it')||t.includes('all cameras match')) { b.click(); n++; }
      }
      return n;
    })()`).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  }

  // --- Check 1: chat-highlight CSS present in the running document --------
  const cssCheck = await cdp.eval(`(()=>{
    let found={panel:false,row:false,curRoutine:false};
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules } catch { continue }
      if (!rules) continue;
      for (const r of rules) {
        const t = (r.cssText||'');
        if (t.includes('ic-panel-flash')||t.includes('has-new-message')) found.panel=true;
        if (t.includes('ic-strip-msg')&&t.includes('new-flash')) found.row=true;
        if (t.includes('ic-message-flash')) found.curRoutine=true;
        if (t.includes('ic-strip-msg.current-routine')) found.curRoutine=true;
      }
    }
    return found;
  })()`)
  const chatHi = cssCheck && (cssCheck.panel && cssCheck.row)
  await cdp.screenshot('01-live-chat-panel.png')
  // Also screenshot the Live Chat section specifically if present.
  const chatPanelShot = await cdp.eval(`(()=>{const e=document.querySelector('.ic-strip-wrap');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`)
  if (chatPanelShot && chatPanelShot.w > 0) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: chatPanelShot.x, y: chatPanelShot.y, width: chatPanelShot.w, height: chatPanelShot.h, scale: 1 } })
    fs.writeFileSync(path.join(SHOT_DIR, '02-live-chat-panel-crop.png'), Buffer.from(r.data, 'base64'))
    console.log('screenshot:', path.join(SHOT_DIR, '02-live-chat-panel-crop.png'))
  }
  rec('chat-highlight CSS present (ic-panel-flash/has-new-message + .ic-strip-msg.new-flash)',
      chatHi ? 'PASS' : 'FAIL', JSON.stringify(cssCheck))

  // --- Check 2: row-action ⋯ menu shows "Archive Media" ------------------
  // Open the ⋯ trigger for our test routine row.
  const menuOpened = await cdp.eval(`(()=>{
    const btns=[...document.querySelectorAll('button')];
    const trig=btns.find(b=>(b.textContent||'').trim().startsWith('⋯'));
    if(!trig) return {ok:false,reason:'no ⋯ trigger found'};
    trig.click();
    return {ok:true};
  })()`)
  await new Promise((r) => setTimeout(r, 800))
  const menuItems = await cdp.eval(`(()=>{
    const m=document.querySelector('.row-action-menu');
    if(!m) return {found:false,items:[]};
    return {found:true, items:[...m.querySelectorAll('button')].map(b=>(b.textContent||'').trim())};
  })()`)
  await cdp.screenshot('03-row-action-menu.png')
  const hasArchiveItem = !!(menuItems && menuItems.found && menuItems.items.includes('Archive Media'))
  rec('row-action menu shows "Archive Media"', hasArchiveItem ? 'PASS' : 'FAIL',
      JSON.stringify(menuItems))

  // --- Check 3: invoke Archive Media via the real preload IPC ------------
  // Pre-state on disk:
  const beforeFiles = fs.readdirSync(routineDir).filter((e) => e !== '_archive')
  const archiveResult = await cdp.eval(`window.api.routineArchiveMedia(${JSON.stringify(TEST_ROUTINE_ID)})`)
  await new Promise((r) => setTimeout(r, 2000))

  // (a) moved-not-deleted: original top-level media gone, _archive/v1 has them
  const topAfter = fs.existsSync(routineDir) ? fs.readdirSync(routineDir).filter((e) => e !== '_archive') : []
  const archiveV1 = path.join(routineDir, '_archive', 'v1')
  const archivedFiles = fs.existsSync(archiveV1) ? fs.readdirSync(archiveV1) : []
  const archivedMkv = path.join(archiveV1, 'R777_test.mkv')
  let archivedMkvSha = null, archivedMkvSize = null
  if (fs.existsSync(archivedMkv)) {
    const buf = fs.readFileSync(archivedMkv)
    archivedMkvSize = buf.length
    archivedMkvSha = crypto.createHash('sha256').update(buf).digest('hex')
  }
  const movedNotDeleted = fs.existsSync(archivedMkv) && archivedMkvSha === mkvSha &&
                          archivedMkvSize === MKV_BYTES.length && topAfter.length === 0
  rec('Archive Media moves-not-deletes (mkv byte-identical in _archive/v1, gone from top level)',
      movedNotDeleted ? 'PASS' : 'FAIL',
      `before=[${beforeFiles}] topAfter=[${topAfter}] _archive/v1=[${archivedFiles}] shaMatch=${archivedMkvSha === mkvSha} size=${archivedMkvSize}/${MKV_BYTES.length}`)

  // (b) state reset to pre-record `pending` with media refs cleared
  await new Promise((r) => setTimeout(r, 1000))
  const routineState = await cdp.eval(`(async()=>{
    const s = await window.api.stateGet();
    const r = (s && s.competition && s.competition.routines || []).find(x=>x.id===${JSON.stringify(TEST_ROUTINE_ID)});
    if(!r) return {found:false};
    return {found:true,status:r.status,recordingStartedAt:r.recordingStartedAt??null,recordingStoppedAt:r.recordingStoppedAt??null,outputPath:r.outputPath??null,outputDir:r.outputDir??null,encodedFiles:r.encodedFiles??null,keyframes:r.keyframes??null};
  })()`)
  const stateReset = !!(routineState && routineState.found && routineState.status === 'pending' &&
    !routineState.recordingStartedAt && !routineState.recordingStoppedAt &&
    !routineState.outputPath && !routineState.outputDir &&
    !routineState.encodedFiles && !routineState.keyframes)
  rec('routine state reset to pre-record `pending` (recording/output/encoded/keyframes cleared)',
      stateReset ? 'PASS' : 'FAIL', JSON.stringify({ archiveResult, routineState }))

  await cdp.screenshot('04-after-archive.png')
}

main()
  .then(() => finish(0))
  .catch((e) => { rec('harness', 'FAIL', e.message); finish(1) })

function finish(code) {
  try { child.kill('SIGKILL') } catch {}
  const summary = results.map((r) => `${r.status}  ${r.name}${r.detail ? '\n      ' + r.detail : ''}`).join('\n')
  fs.writeFileSync(path.join(SHOT_DIR, 'RESULTS.txt'),
    `Archive Media CSE-local test — ${new Date().toISOString()}\nworkdir: ${work}\n\n${summary}\n\n--- app log tail ---\n${appLog.slice(-4000)}\n`)
  console.log('\n===== RESULTS =====\n' + summary)
  const anyFail = results.some((r) => r.status === 'FAIL')
  console.log('\nOVERALL:', anyFail ? 'FAIL' : 'PASS')
  process.exit(code || (anyFail ? 1 : 0))
}
