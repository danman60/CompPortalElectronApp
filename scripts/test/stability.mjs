#!/usr/bin/env node
/**
 * Stability runner — exercises the harness + restart-loop in cycles.
 *
 * Sequence:
 *   1. Setup synth (fresh photos + MP4)
 *   2. Run harness (39 scenarios) → must be 39/39
 *   3. Run restart-loop (kill+relaunch) → 4/4 persistence checks
 *   4. Run harness again → must STILL be 39/39 (post-restart)
 *   5. Repeat for N cycles
 *
 * Catches:
 *   - State corruption that accumulates over runs
 *   - Persistence regressions (state.takes losing data on restart)
 *   - Memory leaks (each run grows in duration)
 *   - Determinism regressions (random failures)
 *
 * Usage:
 *   node scripts/test/stability.mjs [--cycles 3]
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs() {
  const args = { cycles: 3, host: 'http://127.0.0.1:18765' }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, '')
    args[k] = k === 'cycles' ? parseInt(a[i + 1], 10) : a[i + 1]
  }
  return args
}

function exec(cmd) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function main() {
  const args = parseArgs()
  const startTs = Date.now()
  const results = []

  for (let cycle = 1; cycle <= args.cycles; cycle++) {
    console.log(`\n=== CYCLE ${cycle}/${args.cycles} ===`)
    const cycleStart = Date.now()

    console.log('[setup] Refreshing synth assets')
    try { exec(`node scripts/test/setup-synth-on-dart.mjs`) } catch (e) {
      console.error('[setup] failed:', e.message)
      results.push({ cycle, phase: 'setup', ok: false, err: e.message })
      continue
    }

    console.log('[harness pre-restart]')
    let pre
    try {
      const out = exec(`node scripts/test/harness.mjs --host ${args.host}`)
      const m = out.match(/(\d+) passed, (\d+) failed/)
      pre = { pass: parseInt(m?.[1] || '0', 10), fail: parseInt(m?.[2] || '99', 10) }
      console.log(`  ${pre.pass} passed, ${pre.fail} failed`)
    } catch (e) {
      pre = { pass: 0, fail: 999, err: e.message }
      console.error('  harness crashed:', e.message)
    }

    console.log('[restart-loop]')
    let restart
    try {
      const out = exec(`node scripts/test/restart-loop.mjs`)
      const m = out.match(/(\d+) passed, (\d+) failed/)
      restart = { pass: parseInt(m?.[1] || '0', 10), fail: parseInt(m?.[2] || '99', 10) }
      console.log(`  ${restart.pass} passed, ${restart.fail} failed`)
    } catch (e) {
      restart = { pass: 0, fail: 999, err: e.message }
      console.error('  restart-loop crashed:', e.message)
    }

    console.log('[harness post-restart]')
    let post
    try {
      const out = exec(`node scripts/test/harness.mjs --host ${args.host}`)
      const m = out.match(/(\d+) passed, (\d+) failed/)
      post = { pass: parseInt(m?.[1] || '0', 10), fail: parseInt(m?.[2] || '99', 10) }
      console.log(`  ${post.pass} passed, ${post.fail} failed`)
    } catch (e) {
      post = { pass: 0, fail: 999, err: e.message }
      console.error('  harness crashed:', e.message)
    }

    const dur = Date.now() - cycleStart
    results.push({ cycle, durMs: dur, pre, restart, post })
  }

  const totalDur = Date.now() - startTs
  const reportDir = 'tests/reports'
  await fs.mkdir(reportDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = path.join(reportDir, `${ts}-stability.json`)
  await fs.writeFile(reportPath, JSON.stringify({ cycles: args.cycles, totalDurMs: totalDur, results }, null, 2))

  // Summary
  let totalPass = 0
  let totalFail = 0
  for (const r of results) {
    totalPass += (r.pre?.pass ?? 0) + (r.restart?.pass ?? 0) + (r.post?.pass ?? 0)
    totalFail += (r.pre?.fail ?? 0) + (r.restart?.fail ?? 0) + (r.post?.fail ?? 0)
  }
  console.log(`\n=== STABILITY SUMMARY ===`)
  console.log(`${args.cycles} cycles × (harness + restart + harness) = ${totalPass} passed, ${totalFail} failed`)
  console.log(`Total runtime: ${(totalDur / 1000).toFixed(0)}s`)
  console.log(`Report: ${reportPath}`)
  process.exit(totalFail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('stability crashed:', err)
  process.exit(2)
})
