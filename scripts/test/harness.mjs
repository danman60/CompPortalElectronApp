#!/usr/bin/env node
/**
 * Test harness — runs scenario files against a live CSE debug HTTP server.
 *
 * Each scenario is an ES module exporting:
 *   { name, description, run(api): Promise<{ ok, why? }> }
 *
 * `api` is an SDK that wraps the /debug/test/* endpoints + assertion helpers.
 *
 * Usage:
 *   node scripts/test/harness.mjs --host http://dart:8765 [--filter <pattern>]
 *
 * Output: tests/reports/<timestamp>-harness.json + console summary.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs() {
  const args = { host: 'http://localhost:8765', filter: null, scenariosDir: 'scripts/test/scenarios', reportDir: 'tests/reports' }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, '')
    args[k] = a[i + 1]
  }
  return args
}

function makeApi(host) {
  async function call(method, p, body) {
    const res = await fetch(host + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    // Read raw text once, then try JSON.parse. /debug/logs returns text/plain
    // and would otherwise crash res.json().
    const text = await res.text().catch(() => '')
    let parsed = text
    try { parsed = JSON.parse(text) } catch { /* keep as text */ }
    return { status: res.status, body: parsed }
  }

  return {
    // Read endpoints
    state: () => call('GET', '/debug/state'),
    snapshot: () => call('GET', '/debug/snapshot'),
    health: () => call('GET', '/debug/health'),
    queue: () => call('GET', '/debug/queue'),
    // /debug/routines returns { count, routines: [...] } — unwrap.
    routines: async () => {
      const r = await call('GET', '/debug/routines')
      return { ...r, body: Array.isArray(r.body?.routines) ? r.body.routines : [] }
    },
    watermarks: () => call('GET', '/debug/watermarks'),
    events: (limit = 50) => call('GET', `/debug/events?limit=${limit}`),
    logs: (tail = 100, grep = '') => call('GET', `/debug/logs?tail=${tail}${grep ? `&grep=${encodeURIComponent(grep)}` : ''}`),

    // Test mutation endpoints
    recordingStart: (body) => call('POST', '/debug/test/recording/start', body),
    recordingStop: (body) => call('POST', '/debug/test/recording/stop', body),
    importPhotos: (body) => call('POST', '/debug/test/import-photos', body),
    injectTake: (body) => call('POST', '/debug/test/inject-take', body),
    clearState: (body = {}) => call('POST', '/debug/test/clear-state', body),
    dispatchDecision: (body) => call('POST', '/debug/test/dispatch-decision', body),
    triggerAudioAudit: (body) => call('POST', '/debug/test/trigger-audio-audit', body),
    setWatermark: (body) => call('POST', '/debug/test/set-watermark', body),
    clearWatermarks: () => call('POST', '/debug/test/clear-watermarks'),
    setTakeRoutine: (body) => call('POST', '/debug/test/set-take-routine', body),
    extractKeyframes: (body) => call('POST', '/debug/test/extract-keyframes', body),
    reassignRecording: (body) => call('POST', '/debug/test/recording/reassign', body),

    // Assertion helpers
    assert: (cond, msg) => { if (!cond) throw new Error('assert failed: ' + msg) },
    assertEq: (a, b, msg) => { if (a !== b) throw new Error(`assertEq failed: ${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`) },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    // Wait for a condition (poll up to N times)
    async waitFor(predicate, { timeoutMs = 10000, intervalMs = 200, label = 'condition' } = {}) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (await predicate()) return true
        await this.sleep(intervalMs)
      }
      throw new Error(`waitFor timeout after ${timeoutMs}ms: ${label}`)
    },
  }
}

async function main() {
  const args = parseArgs()
  const api = makeApi(args.host)

  // Preflight: server reachable + test hooks enabled?
  const health = await api.health()
  if (health.status !== 200) {
    console.error(`Cannot reach ${args.host}/debug/health (got ${health.status}). Is the app running?`)
    process.exit(2)
  }
  // Probe by hitting a test endpoint and checking 403
  const probe = await api.clearWatermarks()
  if (probe.status === 403) {
    console.error(`Test hooks DISABLED. Set behavior.testHooksEnabled=true in CSE Settings, then restart.`)
    process.exit(3)
  }

  // Discover scenarios
  let scenarioFiles
  try {
    scenarioFiles = (await fs.readdir(args.scenariosDir))
      .filter((f) => f.endsWith('.mjs'))
      .sort()
  } catch (err) {
    console.error(`Cannot list scenarios in ${args.scenariosDir}: ${err.message}`)
    process.exit(2)
  }
  if (args.filter) {
    const re = new RegExp(args.filter)
    scenarioFiles = scenarioFiles.filter((f) => re.test(f))
  }

  console.log(`Running ${scenarioFiles.length} scenarios against ${args.host}`)
  const results = []
  let pass = 0, fail = 0, skip = 0

  for (const file of scenarioFiles) {
    const fullPath = path.resolve(args.scenariosDir, file)
    const url = pathToFileURL(fullPath).href
    let scenario
    try {
      scenario = (await import(url))
    } catch (err) {
      console.error(`SKIP [${file}] import failed: ${err.message}`)
      results.push({ file, status: 'skip', reason: 'import-failed', error: err.message })
      skip++
      continue
    }
    const { name, description, run, requiresPortal, requiresOBS } = scenario
    if (!run) {
      console.error(`SKIP [${file}] no run() exported`)
      results.push({ file, status: 'skip', reason: 'no-run' })
      skip++
      continue
    }

    // Per-scenario reset
    await api.clearState({ clearRoutineRecordings: false })

    const t0 = Date.now()
    let ok = false, err = null
    try {
      const result = await run(api)
      if (result && result.ok === false) {
        err = result.why || 'scenario returned ok:false'
      } else {
        ok = true
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    const dur = Date.now() - t0

    if (ok) { pass++; console.log(`PASS [${file}] ${name || ''} (${dur}ms)`) }
    else { fail++; console.log(`FAIL [${file}] ${name || ''} (${dur}ms) — ${err}`) }
    results.push({ file, name, description, status: ok ? 'pass' : 'fail', durMs: dur, error: err })
  }

  // Final report
  await fs.mkdir(args.reportDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = path.join(args.reportDir, `${ts}-harness.json`)
  await fs.writeFile(reportPath, JSON.stringify({
    host: args.host,
    scenariosDir: args.scenariosDir,
    pass, fail, skip,
    results,
  }, null, 2))

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped → ${reportPath}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('harness crashed:', err)
  process.exit(2)
})
