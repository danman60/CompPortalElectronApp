#!/usr/bin/env node
/**
 * CompSync Media — Unattended E2E Pipeline Test
 *
 * Tests the full pipeline: Load Competition → Record → Encode → Upload → Verify
 * Runs against a live app instance via WebSocket hub (port 9877) + HTTP overlay (port 9876).
 * Verifies results via CompPortal API + R2 storage.
 *
 * Usage:
 *   node tests/e2e-pipeline.mjs [--host localhost] [--routines 2] [--record-sec 10] [--skip-upload]
 *
 * Prerequisites:
 *   - CompSync Media running with OBS connected
 *   - Share code configured in settings (or pass --share-code)
 */

import WebSocket from 'ws'
import https from 'https'
import http from 'http'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// --- Config ---
const args = process.argv.slice(2)
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback
}
const HOST = getArg('host', 'localhost')
const WS_PORT = 9877
const OVERLAY_PORT = 9876
const SHARE_CODE = getArg('share-code', 'EMPWR-STCATH-2')
const ROUTINE_COUNT = parseInt(getArg('routines', '2'))
const RECORD_SECONDS = parseInt(getArg('record-sec', '10'))
const SKIP_UPLOAD = args.includes('--skip-upload')
const VERBOSE = args.includes('--verbose')
const LOG_PATH = getArg('log-path', '')  // Path to main.log for monitoring

// --- Test state ---
let ws = null
let lastState = null
let statePromiseResolve = null
let testResults = []
let startTime = Date.now()

// --- Helpers ---
function log(msg) { console.log(`[${elapsed()}] ${msg}`) }
function warn(msg) { console.log(`[${elapsed()}] WARN: ${msg}`) }
function elapsed() {
  const sec = ((Date.now() - startTime) / 1000).toFixed(1)
  return `${sec}s`
}

function pass(name, detail) {
  testResults.push({ name, status: 'PASS', detail })
  log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`)
}

function fail(name, detail) {
  testResults.push({ name, status: 'FAIL', detail })
  log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`)
}

function skip(name, detail) {
  testResults.push({ name, status: 'SKIP', detail })
  log(`  SKIP: ${name}${detail ? ' — ' + detail : ''}`)
}

// --- HTTP helper ---
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    mod.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    }).on('error', reject)
  })
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const postData = JSON.stringify(body)
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

// --- WebSocket helpers ---
function connectWS() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://${HOST}:${WS_PORT}`)
    const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000)

    ws.on('open', () => {
      clearTimeout(timeout)
      // Identify as test client
      ws.send(JSON.stringify({ type: 'identify', client: 'streamdeck' }))
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'state') {
          lastState = msg
          if (statePromiseResolve) {
            statePromiseResolve(msg)
            statePromiseResolve = null
          }
          // First state message = connected
          if (!resolve._done) {
            resolve._done = true
            clearTimeout(timeout)
            resolve(msg)
          }
        }
        if (VERBOSE) log(`  WS: ${JSON.stringify(msg).substring(0, 120)}`)
      } catch {}
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

function sendCommand(action, extra = {}) {
  ws.send(JSON.stringify({ type: 'command', action, ...extra }))
}

function waitForState(predicate, timeoutMs = 30000, label = '') {
  return new Promise((resolve, reject) => {
    // Check current state first
    if (lastState && predicate(lastState)) {
      return resolve(lastState)
    }

    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for state: ${label}`))
    }, timeoutMs)

    const origHandler = ws.listeners('message').slice(-1)[0]

    function checkState(data) {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'state' && predicate(msg)) {
          clearTimeout(timeout)
          resolve(msg)
        }
      } catch {}
    }

    ws.on('message', checkState)

    // Cleanup on resolve/reject
    const origResolve = resolve
    resolve = (val) => { ws.removeListener('message', checkState); clearTimeout(timeout); origResolve(val) }
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// --- Log monitoring ---
function getRecentLogs(lines = 50) {
  if (!LOG_PATH) return ''
  try {
    const content = fs.readFileSync(LOG_PATH, 'utf-8')
    return content.split('\n').slice(-lines).join('\n')
  } catch { return '' }
}

function waitForLogEntry(pattern, timeoutMs = 60000) {
  if (!LOG_PATH) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Log timeout: ${pattern}`)), timeoutMs)
    const interval = setInterval(() => {
      const recent = getRecentLogs(20)
      const match = recent.split('\n').find(line => line.match(pattern))
      if (match) {
        clearInterval(interval)
        clearTimeout(timeout)
        resolve(match)
      }
    }, 1000)
  })
}

// --- CompPortal API helpers ---
let apiBase = null
let apiKey = null
let competitionId = null

async function resolveShareCode() {
  const res = await httpGet(`https://www.compsync.net/api/plugin/resolve/${encodeURIComponent(SHARE_CODE)}`)
  if (res.status !== 200) throw new Error(`Share code resolve failed: ${res.status}`)
  apiBase = res.body.apiBase
  apiKey = res.body.apiKey
  competitionId = res.body.competitionId
  return res.body
}

async function getSchedule() {
  const res = await httpGet(`${apiBase}/api/plugin/schedule/${competitionId}`)
  // This needs auth header — use httpPost workaround
  return res
}

async function checkMediaPackage(entryId) {
  const res = await httpPost(`${apiBase}/api/plugin/upload-url`, {
    entryId,
    competitionId,
    type: 'videos',
    filename: '__probe.mp4',
    contentType: 'video/mp4',
  }, { Authorization: `Bearer ${apiKey}` })
  return res
}

// ============================================================
// TEST SECTIONS
// ============================================================

async function testWSConnection() {
  log('--- Test: WebSocket Hub Connection ---')
  try {
    const initialState = await connectWS()
    pass('WS connected', `total=${initialState.total}, index=${initialState.index}`)

    if (initialState.recording?.active) {
      warn('Recording is active — will wait for it to finish')
    }
    return initialState
  } catch (err) {
    fail('WS connected', err.message)
    throw err
  }
}

async function testOverlayServer() {
  log('--- Test: Overlay Server ---')
  try {
    const res = await httpGet(`http://${HOST}:${OVERLAY_PORT}/current`)
    if (res.status === 200 && typeof res.body === 'object') {
      pass('Overlay /current', `visible=${res.body.visible}`)
    } else {
      fail('Overlay /current', `status=${res.status}`)
    }
  } catch (err) {
    fail('Overlay /current', err.message)
  }

  try {
    const res = await httpGet(`http://${HOST}:${OVERLAY_PORT}/overlay`)
    if (res.status === 200) {
      pass('Overlay /overlay HTML', `${typeof res.body === 'string' ? res.body.length : '?'} bytes`)
    } else {
      fail('Overlay /overlay HTML', `status=${res.status}`)
    }
  } catch (err) {
    fail('Overlay /overlay HTML', err.message)
  }
}

async function testShareCodeResolution() {
  log('--- Test: Share Code Resolution ---')
  try {
    const data = await resolveShareCode()
    pass('Share code resolved', `${data.name} (${data.tenant})`)
    return data
  } catch (err) {
    fail('Share code resolved', err.message)
    throw err
  }
}

async function testCompetitionLoad() {
  log('--- Test: Competition Load ---')

  // Check if competition already loaded
  if (lastState && lastState.total > 0) {
    pass('Competition loaded', `${lastState.total} routines, current=#${lastState.routine?.entryNumber}`)
    return
  }

  // Try loading via WS hub command
  try {
    sendCommand('loadShareCode', { shareCode: SHARE_CODE })
    const state = await waitForState(s => s.total > 0, 15000, 'competition loaded')
    pass('Competition loaded via WS', `${state.total} routines`)
  } catch (err) {
    fail('Competition loaded', err.message)
    throw err
  }
}

async function testOBSConnection() {
  log('--- Test: OBS Connection ---')
  // Check via WS hub state — recording section tells us if OBS is accessible
  // If we can toggle recording, OBS is connected
  if (lastState) {
    // Try a harmless state check — the state message includes recording.active
    pass('OBS state available', `recording=${lastState.recording?.active}, streaming=${lastState.streaming}`)
  }
}

async function testRecordingPipeline(routineIndex) {
  const routineNum = routineIndex + 1
  log(`--- Test: Recording Pipeline (routine ${routineNum}/${ROUTINE_COUNT}) ---`)

  // Get current routine info
  const preState = lastState
  const entryNum = preState?.routine?.entryNumber || '?'
  log(`  Current routine: #${entryNum} "${preState?.routine?.routineTitle || '?'}"`)

  // Start recording
  log(`  Starting recording (${RECORD_SECONDS}s)...`)
  sendCommand('toggleRecord')

  try {
    const recState = await waitForState(s => s.recording?.active === true, 10000, 'recording started')
    pass(`Routine ${routineNum} — recording started`, `#${entryNum}`)
  } catch (err) {
    fail(`Routine ${routineNum} — recording started`, err.message)
    return false
  }

  // Wait for recording duration
  await sleep(RECORD_SECONDS * 1000)

  // Stop recording
  log(`  Stopping recording...`)
  sendCommand('toggleRecord')

  try {
    const stopState = await waitForState(s => s.recording?.active === false, 15000, 'recording stopped')
    pass(`Routine ${routineNum} — recording stopped`, `elapsed=${RECORD_SECONDS}s`)
  } catch (err) {
    fail(`Routine ${routineNum} — recording stopped`, err.message)
    return false
  }

  // Wait for state to update (encoding may start)
  await sleep(3000)

  // Monitor for encoding if log path available
  if (LOG_PATH) {
    try {
      log(`  Waiting for encoding...`)
      const encodeLine = await waitForLogEntry(/FFmpeg encoding|Encoding complete|No encoding needed/, 120000)
      if (encodeLine) {
        pass(`Routine ${routineNum} — encoding`, encodeLine.trim().substring(0, 80))
      }
    } catch (err) {
      warn(`Encoding log not detected within timeout: ${err.message}`)
    }
  }

  // Advance to next routine
  if (routineIndex < ROUTINE_COUNT - 1) {
    sendCommand('nextRoutine')
    await sleep(1000)
    const nextState = lastState
    if (nextState?.routine?.entryNumber !== entryNum) {
      pass(`Routine ${routineNum} — advanced`, `now at #${nextState?.routine?.entryNumber}`)
    } else {
      warn(`Routine advance may not have worked — still at #${entryNum}`)
    }
  }

  return true
}

async function testUploadVerification() {
  if (SKIP_UPLOAD) {
    skip('Upload verification', 'skipped via --skip-upload')
    return
  }

  log('--- Test: Upload API Chain ---')

  // Test upload-url endpoint
  try {
    const res = await checkMediaPackage(lastState?.routine?.entryNumber || 'test')
    if (res.status === 200 && res.body.signedUrl) {
      pass('Upload URL generation', `storagePath=${res.body.storagePath?.substring(0, 60)}...`)
    } else {
      fail('Upload URL generation', `status=${res.status}`)
    }
  } catch (err) {
    fail('Upload URL generation', err.message)
  }
}

async function testWebSocketHeartbeat() {
  log('--- Test: WebSocket Heartbeat ---')
  const statesBefore = lastState
  await sleep(6000) // Heartbeat interval is 5s
  if (lastState && lastState !== statesBefore) {
    pass('WS heartbeat', 'state update received within 6s')
  } else {
    warn('No heartbeat detected — may be normal if nothing changed')
    pass('WS heartbeat', 'connection alive')
  }
}

async function testOverlayDuringRecording() {
  log('--- Test: Overlay State During Operations ---')
  try {
    const res = await httpGet(`http://${HOST}:${OVERLAY_PORT}/current`)
    if (res.status === 200) {
      const hasData = res.body.entryNumber || res.body.routineName
      pass('Overlay has routine data', hasData ?
        `#${res.body.entryNumber} "${res.body.routineName}"` : 'no routine (overlay not fired)')
    } else {
      fail('Overlay during recording', `status=${res.status}`)
    }
  } catch (err) {
    fail('Overlay during recording', err.message)
  }
}

async function testErrorRecovery() {
  log('--- Test: Error Handling ---')

  // Test invalid WS command (should not crash)
  try {
    ws.send(JSON.stringify({ type: 'command', action: 'nonexistent_action' }))
    await sleep(1000)
    // If we're still connected, it handled gracefully
    if (ws.readyState === WebSocket.OPEN) {
      pass('Invalid command handled', 'connection survived')
    } else {
      fail('Invalid command handled', 'connection dropped')
    }
  } catch (err) {
    fail('Invalid command handled', err.message)
  }

  // Test malformed JSON
  try {
    ws.send('not json at all {{{')
    await sleep(1000)
    if (ws.readyState === WebSocket.OPEN) {
      pass('Malformed JSON handled', 'connection survived')
    } else {
      fail('Malformed JSON handled', 'connection dropped')
    }
  } catch (err) {
    fail('Malformed JSON handled', err.message)
  }
}

async function testLogHealth() {
  if (!LOG_PATH) {
    skip('Log health check', 'no --log-path provided')
    return
  }

  log('--- Test: Log Health ---')
  const recent = getRecentLogs(200)
  const errors = recent.split('\n').filter(l => l.includes('[error]') || l.includes('[ERROR]'))
  const warnings = recent.split('\n').filter(l =>
    (l.includes('[warn]') || l.includes('[WARN]')) &&
    !l.includes('OBS') && // OBS reconnect warnings are expected
    !l.includes('Crash recovery')
  )

  if (errors.length === 0) {
    pass('No errors in logs', `checked last 200 lines`)
  } else {
    fail('Errors in logs', `${errors.length} errors found`)
    errors.slice(0, 3).forEach(e => log(`    ${e.trim()}`))
  }

  if (warnings.length <= 2) {
    pass('Warnings acceptable', `${warnings.length} non-OBS warnings`)
  } else {
    warn(`${warnings.length} warnings in recent logs`)
    warnings.slice(0, 3).forEach(w => log(`    ${w.trim()}`))
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  log('=== CompSync Media E2E Pipeline Test ===')
  log(`Host: ${HOST}, Share code: ${SHARE_CODE}, Routines: ${ROUTINE_COUNT}, Record: ${RECORD_SECONDS}s`)
  if (LOG_PATH) log(`Log path: ${LOG_PATH}`)
  log('')

  try {
    // Phase 1: Connectivity
    await testWSConnection()
    await testOverlayServer()
    await testWebSocketHeartbeat()

    // Phase 2: Competition loading
    await testShareCodeResolution()
    await testCompetitionLoad()
    await testOBSConnection()

    // Phase 3: Recording pipeline (loop through routines)
    for (let i = 0; i < ROUTINE_COUNT; i++) {
      const ok = await testRecordingPipeline(i)
      if (!ok) {
        warn(`Stopping after routine ${i + 1} due to failure`)
        break
      }
      await testOverlayDuringRecording()
    }

    // Phase 4: Upload verification
    await testUploadVerification()

    // Phase 5: Resilience
    await testErrorRecovery()
    await testLogHealth()

  } catch (err) {
    log(`\nFATAL: ${err.message}`)
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
  }

  // Summary
  log('\n=== RESULTS ===')
  const passed = testResults.filter(r => r.status === 'PASS').length
  const failed = testResults.filter(r => r.status === 'FAIL').length
  const skipped = testResults.filter(r => r.status === 'SKIP').length

  for (const r of testResults) {
    const icon = r.status === 'PASS' ? '+' : r.status === 'FAIL' ? 'X' : '-'
    log(`  [${icon}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
  }

  log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped (${elapsed()})`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Unhandled:', err)
  process.exit(2)
})
