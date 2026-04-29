#!/usr/bin/env node
/**
 * Replay a sequence of test events against the CSE debug HTTP server.
 *
 * Usage:
 *   node scripts/test/replay-events.mjs --host http://dart:8765 --script <path-to-script.mjs>
 *
 * The script file is an ES module that default-exports an array of events,
 * each:
 *   { method: 'POST', path: '/debug/test/...', body?: object, expect?: { status?: number, jsonContains?: object } }
 *
 * Returns non-zero exit on any expectation failure. Logs results to stdout
 * + writes a JSON report to tests/reports/<timestamp>-replay.json
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs() {
  const args = { host: 'http://localhost:8765', script: null, reportDir: 'tests/reports' }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, '')
    args[k] = a[i + 1]
  }
  if (!args.script) throw new Error('--script required')
  return args
}

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  let body = null
  try { body = await res.json() } catch { try { body = await res.text() } catch {} }
  return { status: res.status, body }
}

function deepIncludes(actual, expected) {
  if (typeof expected !== 'object' || expected === null) return actual === expected
  if (typeof actual !== 'object' || actual === null) return false
  for (const k of Object.keys(expected)) {
    if (!deepIncludes(actual[k], expected[k])) return false
  }
  return true
}

async function main() {
  const args = parseArgs()
  const scriptUrl = pathToFileURL(path.resolve(args.script)).href
  const mod = await import(scriptUrl)
  const events = mod.default
  if (!Array.isArray(events)) throw new Error('script must default-export array')

  const results = []
  let pass = 0, fail = 0
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    const url = args.host + ev.path
    const start = Date.now()
    let res
    try {
      res = await fetchJson(url, {
        method: ev.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: ev.body ? JSON.stringify(ev.body) : undefined,
      })
    } catch (err) {
      res = { status: 0, body: { error: String(err) } }
    }
    const dur = Date.now() - start
    let ok = true
    let why = ''
    if (ev.expect?.status !== undefined && res.status !== ev.expect.status) {
      ok = false; why = `status ${res.status} != ${ev.expect.status}`
    }
    if (ok && ev.expect?.jsonContains && !deepIncludes(res.body, ev.expect.jsonContains)) {
      ok = false; why = `jsonContains mismatch`
    }
    if (ok) pass++; else fail++
    results.push({ idx: i, ev, status: res.status, durMs: dur, ok, why, body: res.body })
    console.log(`${ok ? 'PASS' : 'FAIL'} [${i}] ${ev.method || 'GET'} ${ev.path} → ${res.status} (${dur}ms)${why ? ' — ' + why : ''}`)
    if (ev.delayAfterMs) await new Promise((r) => setTimeout(r, ev.delayAfterMs))
  }

  await fs.mkdir(args.reportDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = path.join(args.reportDir, `${ts}-replay-${path.basename(args.script, '.mjs')}.json`)
  await fs.writeFile(reportPath, JSON.stringify({ host: args.host, script: args.script, pass, fail, results }, null, 2))

  console.log(`\n${pass} passed, ${fail} failed → ${reportPath}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('replay-events failed:', err)
  process.exit(2)
})
