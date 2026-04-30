#!/usr/bin/env node
/**
 * Stale-take recovery test (E1 from semantic spec).
 *
 * Sequence:
 *   1. Write a synthetic _active_take.json on DART
 *   2. Kill app
 *   3. Relaunch via schtasks
 *   4. Wait for boot, refresh tunnel
 *   5. Tail main.log for "Stale active take detected on boot"
 *   6. Verify _active_take.json was cleared (boot path deletes it)
 */
import { execSync } from 'node:child_process'

const SSH_TARGET = process.env.SSH_TARGET || 'dart'
const HOST = 'http://127.0.0.1:18765'
const TUNNEL_PORT = 18765

function ssh(cmd) {
  return execSync(`ssh ${SSH_TARGET} ${JSON.stringify(cmd)}`, { encoding: 'utf-8' }).trim()
}

async function fetchJson(p) {
  const res = await fetch(HOST + p, { method: 'GET' })
  const text = await res.text().catch(() => '')
  let parsed = text
  try { parsed = JSON.parse(text) } catch {}
  return { status: res.status, body: parsed }
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
  throw new Error('boot timeout')
}

async function main() {
  console.log('[stale-take] Reading outputDir from settings.json on DART...')
  const settingsPath = 'C:\\Users\\User\\AppData\\Roaming\\compsync-media\\compsync-media-settings.json'
  // Pull settings JSON to local + parse here (avoids escaping hell over SSH)
  const raw = execSync(`ssh ${SSH_TARGET} "powershell -NoProfile -Command Get-Content -Raw '${settingsPath}'"`, { encoding: 'utf-8' })
  const settings = JSON.parse(raw)
  const outputDir = settings.fileNaming?.outputDirectory
  if (!outputDir) {
    console.error('[stale-take] outputDirectory not configured — bailing')
    process.exit(2)
  }
  console.log('  outputDir:', outputDir)

  const takePath = `${outputDir}\\_active_take.json`
  const synthTake = JSON.stringify({
    takeId: 'stale-test-' + Date.now(),
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    currentTargetRoutineId: null,
  }, null, 2)

  console.log('[stale-take] Writing synthetic _active_take.json (via local file + SCP)...')
  const localPath = '/tmp/_active_take.json'
  execSync(`cat > ${localPath} << 'JSON_EOF'\n${synthTake}\nJSON_EOF`, { stdio: 'inherit' })
  // SCP — escape spaces in target path; use forward slashes
  // Path: C:\Users\User\OneDrive\Desktop\TesterOutput\_active_take.json
  const scpDst = '"' + outputDir.replace(/\\/g, '/').replace(/^([A-Z]:)/, '/$1') + '/_active_take.json"'
  // Actually openssh on Windows accepts: dart:'C:/Users/User/.../_active_take.json'
  const scpRemote = outputDir.replace(/\\/g, '/') + '/_active_take.json'
  execSync(`scp -q ${localPath} 'dart:${scpRemote}'`, { stdio: 'inherit' })
  // Verify it parses correctly
  const verify = ssh(`powershell -NoProfile -Command "Get-Content -Raw '${takePath}' | ConvertFrom-Json | ConvertTo-Json -Compress"`)
  console.log('  verified JSON:', verify.slice(0, 120))

  console.log('[stale-take] Killing app...')
  ssh(`powershell -NoProfile -Command "Get-Process -Name 'CompSync Media' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2"`)

  console.log('[stale-take] Relaunching via schtasks...')
  ssh(`schtasks /run /tn LaunchCompSyncMedia`)

  // Refresh tunnel
  try { execSync(`pkill -f "ssh.*${TUNNEL_PORT}:127.0.0.1:8765" 2>/dev/null`, { stdio: 'ignore' }) } catch {}
  await new Promise((r) => setTimeout(r, 5000))
  execSync(`ssh -f -N -4 -L ${TUNNEL_PORT}:127.0.0.1:8765 ${SSH_TARGET}`, { stdio: 'inherit' })
  await new Promise((r) => setTimeout(r, 3000))

  console.log('[stale-take] Waiting for boot...')
  await waitForBoot()

  console.log('[stale-take] Checking main.log for stale-take detection...')
  const logs = ssh(
    `powershell -NoProfile -Command "Get-Content 'C:\\Users\\User\\AppData\\Roaming\\compsync-media\\logs\\main.log' -Tail 100 | Select-String -Pattern 'Stale active take detected on boot'"`,
  )

  console.log('[stale-take] Checking _active_take.json was cleared...')
  const stillExists = ssh(`powershell -NoProfile -Command "if (Test-Path '${takePath}') { 'EXISTS' } else { 'CLEARED' }"`)

  let pass = 0, fail = 0
  function check(name, cond, why) {
    if (cond) { pass++; console.log(`  PASS ${name}`) }
    else { fail++; console.log(`  FAIL ${name} — ${why}`) }
  }
  check('Stale-take detection logged', logs.includes('Stale active take detected on boot'), `log not found: ${logs.slice(0, 200)}`)
  check('_active_take.json cleared post-detection', stillExists === 'CLEARED', `file state: ${stillExists}`)

  console.log(`\n[stale-take] ${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[stale-take] crashed:', err)
  process.exit(2)
})
