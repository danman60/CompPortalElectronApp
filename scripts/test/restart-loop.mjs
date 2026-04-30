#!/usr/bin/env node
/**
 * Restart-loop test — exercises persistence across an app restart.
 *
 * Sequence:
 *   1. Connect to running CSE on DART (via tunnel http://127.0.0.1:18765)
 *   2. Take pre-kill snapshot
 *   3. Kill app via SSH (Stop-Process)
 *   4. Wait ~2s
 *   5. Relaunch via schtasks /run LaunchCompSyncMedia
 *   6. Wait for boot (poll /debug/health)
 *   7. Refresh tunnel
 *   8. Take post-boot snapshot
 *   9. Compare:
 *      - takes[] count >= pre-kill (boot migration may add synthesized takes)
 *      - watermarks survived
 *      - routine recording fields preserved
 *
 * Usage:
 *   node scripts/test/restart-loop.mjs
 */
import { execSync } from 'node:child_process'

const HOST = process.env.CSE_HOST || 'http://127.0.0.1:18765'
const SSH_TARGET = process.env.SSH_TARGET || 'dart'
const TUNNEL_PORT = 18765

async function fetchJson(p) {
  const res = await fetch(HOST + p, { method: 'GET', headers: { 'Content-Type': 'application/json' } })
  const text = await res.text().catch(() => '')
  let parsed = text
  try { parsed = JSON.parse(text) } catch {}
  return { status: res.status, body: parsed }
}

function ssh(cmd) {
  return execSync(`ssh ${SSH_TARGET} ${JSON.stringify(cmd)}`, { encoding: 'utf-8' }).trim()
}

function refreshTunnel() {
  try { execSync(`pkill -f "ssh.*${TUNNEL_PORT}:127.0.0.1:8765" 2>/dev/null`, { stdio: 'ignore' }) } catch {}
  execSync('sleep 1', { stdio: 'ignore' })
  execSync(`ssh -f -N -4 -L ${TUNNEL_PORT}:127.0.0.1:8765 ${SSH_TARGET}`, { stdio: 'inherit' })
}

async function waitForBoot(timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await fetchJson('/debug/health')
      if (h.status === 200 && h.body.uptimeSec !== undefined) return h.body
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`boot timeout after ${timeoutMs}ms`)
}

async function main() {
  console.log('[restart-loop] Pre-kill snapshot...')
  const pre = (await fetchJson('/debug/snapshot')).body
  if (!pre || pre.snapshotVersion !== 1) {
    console.error('Pre-kill snapshot invalid:', pre)
    process.exit(1)
  }
  const preTakes = pre.takes.length
  const preWatermarks = Object.keys(pre.watermarks || {}).length
  const preRecorded = pre.routines.filter((r) => r.recordingStartedAt).length
  console.log(`  takes=${preTakes}, watermarks=${preWatermarks}, recorded=${preRecorded}`)

  console.log('[restart-loop] Killing app on DART...')
  ssh(`powershell -NoProfile -Command "Get-Process -Name 'CompSync Media' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2"`)

  console.log('[restart-loop] Relaunching via schtasks...')
  ssh(`schtasks /run /tn LaunchCompSyncMedia`)

  // Refresh tunnel since the prior server's port is gone
  console.log('[restart-loop] Refreshing tunnel...')
  await new Promise((r) => setTimeout(r, 5000))
  refreshTunnel()
  await new Promise((r) => setTimeout(r, 2000))

  console.log('[restart-loop] Waiting for boot...')
  const health = await waitForBoot()
  console.log(`  app up: pid=${health.pid}, uptime=${health.uptimeSec}s`)

  console.log('[restart-loop] Post-boot snapshot...')
  const post = (await fetchJson('/debug/snapshot')).body
  const postTakes = post.takes.length
  const postWatermarks = Object.keys(post.watermarks || {}).length
  const postRecorded = post.routines.filter((r) => r.recordingStartedAt).length
  console.log(`  takes=${postTakes}, watermarks=${postWatermarks}, recorded=${postRecorded}`)

  let pass = 0, fail = 0
  function check(name, cond, why) {
    if (cond) { pass++; console.log(`  PASS ${name}`) }
    else { fail++; console.log(`  FAIL ${name} — ${why}`) }
  }

  check('takes[] preserved', postTakes >= preTakes,
    `pre=${preTakes} post=${postTakes} (boot migration may add)`)
  check('watermarks preserved', postWatermarks === preWatermarks,
    `pre=${preWatermarks} post=${postWatermarks}`)
  check('recorded routines preserved', postRecorded >= preRecorded,
    `pre=${preRecorded} post=${postRecorded}`)
  check('snapshot version stable', post.snapshotVersion === 1, `got ${post.snapshotVersion}`)

  console.log(`\n[restart-loop] ${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[restart-loop] crashed:', err)
  process.exit(2)
})
