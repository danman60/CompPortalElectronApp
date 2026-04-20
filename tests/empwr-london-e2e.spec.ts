import { test, _electron as electron } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Isolated E2E smoke test for EMPWR-LONDON cold-load on Linux/xvfb.
// Does NOT touch the user's real state directory.
// Covers flows 1, 2, 3, 5, 6 from the task brief. Flow 4 (OBS) skipped.

const SCREENSHOT_DIR = 'tests/reports/empwr-london-2026-04-14-screenshots'
const MAIN_LOG_PATH = 'tests/reports/empwr-london-2026-04-14-mainlog.txt'

test.setTimeout(180000)

test('EMPWR-LONDON cold load + smoke', async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'compsync-e2e-'))
  console.log('tmp user data dir:', tmpUserData)

  const app = await electron.launch({
    args: [
      './out/main/index.js',
      `--user-data-dir=${tmpUserData}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--disable-gpu-sandbox',
      '--disable-features=VizDisplayCompositor',
    ],
    env: {
      ...process.env,
      ELECTRON_DISABLE_GPU: '1',
      DISPLAY: process.env.DISPLAY || ':99',
    },
    timeout: 45000,
  })

  const mainLogs: string[] = []
  app.process().stdout?.on('data', (d) => {
    const s = d.toString()
    mainLogs.push(s)
    process.stdout.write('[main:stdout] ' + s)
  })
  app.process().stderr?.on('data', (d) => {
    const s = d.toString()
    mainLogs.push(s)
    process.stderr.write('[main:stderr] ' + s)
  })

  const window = await app.firstWindow()

  const consoleMessages: { type: string; text: string }[] = []
  window.on('console', (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() })
  })
  const pageErrors: string[] = []
  window.on('pageerror', (err) => {
    pageErrors.push(err.stack || err.message)
  })

  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2000)

  // Confirm userData is isolated to our tmp path
  const userDataPath = await app.evaluate(async ({ app }) => app.getPath('userData'))
  console.log('userData resolved to:', userDataPath)

  // ─── Flow 1: cold load via share code ───
  console.log('\n=== Flow 1: share code load ===')
  let loadErr: string | null = null
  let routineCount = 0
  let loadedCompName: string | null = null
  const tryLoad = async (code: string): Promise<{ ok: boolean; count: number; name: string | null; err: string | null }> => {
    try {
      const res = await window.evaluate(async (c: string) => {
        // preload exposes window.api (brief said electronAPI — that is incorrect for this build)
        // @ts-expect-error preload API
        return await window.api.scheduleLoadShareCode(c)
      }, code)
      if (res && typeof res === 'object' && 'routines' in (res as any)) {
        return { ok: true, count: (res as any).routines.length, name: (res as any).name || null, err: null }
      }
      return { ok: false, count: 0, name: null, err: 'unexpected return: ' + JSON.stringify(res).slice(0, 200) }
    } catch (e: any) {
      return { ok: false, count: 0, name: null, err: e?.message || String(e) }
    }
  }

  let r = await tryLoad('EMPWR-LONDON')
  if (!r.ok) {
    console.log('EMPWR-LONDON failed:', r.err, '— trying fallback EMPWR-STCATH-2')
    loadErr = r.err
    r = await tryLoad('EMPWR-STCATH-2')
    if (!r.ok) {
      console.log('fallback EMPWR-STCATH-2 failed:', r.err)
    }
  }
  if (r.ok) {
    routineCount = r.count
    loadedCompName = r.name
    console.log(`Loaded competition "${loadedCompName}" with ${routineCount} routines`)
  }

  // Let reconcile + render settle
  await window.waitForTimeout(5000)

  try {
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, '01-loaded.png'), fullPage: true })
  } catch (err) {
    console.warn('01-loaded screenshot failed:', err)
  }

  // ─── Flow 3: reconcile dry-run (BEFORE we poke the UI) ───
  console.log('\n=== Flow 3: reconcile dry-run check ===')
  const dryRunLines = mainLogs.join('').split('\n').filter((l) => l.includes('[DRY RUN] would demote'))
  console.log('DRY-RUN lines count:', dryRunLines.length)
  if (dryRunLines.length > 0) {
    console.log('FIRST 5:', dryRunLines.slice(0, 5))
  }
  const reconcileSummary = mainLogs.join('').split('\n').filter((l) => l.includes('Reconcile:'))
  console.log('Reconcile summary lines:', reconcileSummary)

  // ─── Flow 2: navigation + filtering render check ───
  console.log('\n=== Flow 2: navigation + filtering ===')
  const navCheck = await window.evaluate(() => {
    const q = (sel: string) => document.querySelectorAll(sel).length
    const hasDayFilter = document.querySelectorAll('select, [role="combobox"]').length > 0
    const searchInputs = document.querySelectorAll('input[type="search"], input[placeholder*="earch" i]').length
    const tables = document.querySelectorAll('table').length
    const rows = document.querySelectorAll('tbody tr, [role="row"]').length
    // Pipeline stage column heuristic — look for "Pipeline" or "Stage" header text, or emoji markers
    const allText = document.body.innerText || ''
    const hasPipelineHeader = /pipeline|stage/i.test(allText)
    const hasRecTokens = /REC|SPLIT|PHOTO|UP/.test(allText)
    // Time column: header "Time" present
    const headers = Array.from(document.querySelectorAll('th, [role="columnheader"]')).map((h) => h.textContent?.trim() || '')
    const hasTimeHeader = headers.some((h) => /time/i.test(h))
    return {
      selects: q('select, [role="combobox"]'),
      searchInputs,
      tables,
      rows,
      hasPipelineHeader,
      hasRecTokens,
      hasTimeHeader,
      headers: headers.slice(0, 20),
      firstRowHtml: document.querySelector('tbody tr')?.outerHTML?.slice(0, 500) || '',
    }
  })
  console.log('nav check:', JSON.stringify(navCheck, null, 2))

  // Click a row and check for highlight change
  const clickResult = await window.evaluate(() => {
    const row = document.querySelectorAll('tbody tr')[5] as HTMLElement | undefined
    if (!row) return { clicked: false, classBefore: null }
    const classBefore = row.className
    row.click()
    return { clicked: true, classBefore }
  })
  await window.waitForTimeout(500)
  const afterClick = await window.evaluate(() => {
    const row = document.querySelectorAll('tbody tr')[5] as HTMLElement | undefined
    return row ? { className: row.className } : null
  })
  console.log('row click:', clickResult, '->', afterClick)

  try {
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, '02-navigation.png'), fullPage: true })
  } catch (err) {
    console.warn('02 screenshot failed:', err)
  }

  // ─── Flow 5: settings panel ───
  console.log('\n=== Flow 5: settings panel ===')
  // Look for a settings button (gear icon or text)
  const settingsOpened = await window.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'))
    const match = candidates.find((el) => {
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').toLowerCase()
      return /settings|gear|preferences|config/.test(label)
    }) as HTMLElement | undefined
    if (match) {
      match.click()
      return { clicked: true, label: match.getAttribute('aria-label') || match.textContent?.slice(0, 40) || match.getAttribute('title') }
    }
    return { clicked: false, label: null }
  })
  console.log('settings opened:', settingsOpened)
  await window.waitForTimeout(1500)
  try {
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, '03-settings.png'), fullPage: true })
  } catch (err) {
    console.warn('03 screenshot failed:', err)
  }
  // Close settings via Escape
  await window.keyboard.press('Escape').catch(() => {})
  await window.waitForTimeout(500)

  // ─── Flow 6: wifi tablet / overlay smoke render ───
  console.log('\n=== Flow 6: wifi tablet + overlay ===')
  const wifiOpened = await window.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'))
    const match = candidates.find((el) => {
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').toLowerCase()
      return /wifi|tablet|wi-fi/.test(label)
    }) as HTMLElement | undefined
    if (match) {
      match.click()
      return { clicked: true, label: match.getAttribute('aria-label') || match.textContent?.slice(0, 40) }
    }
    return { clicked: false, label: null }
  })
  console.log('wifi opened:', wifiOpened)
  await window.waitForTimeout(1200)
  try {
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, '04-wifi-tablet.png'), fullPage: true })
  } catch (err) {
    console.warn('04 screenshot failed:', err)
  }
  await window.keyboard.press('Escape').catch(() => {})
  await window.waitForTimeout(500)

  const overlayOpened = await window.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'))
    const match = candidates.find((el) => {
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').toLowerCase()
      return /overlay|broadcast|lower.third/.test(label)
    }) as HTMLElement | undefined
    if (match) {
      match.click()
      return { clicked: true, label: match.getAttribute('aria-label') || match.textContent?.slice(0, 40) }
    }
    return { clicked: false, label: null }
  })
  console.log('overlay opened:', overlayOpened)
  await window.waitForTimeout(1200)
  try {
    await window.screenshot({ path: path.join(SCREENSHOT_DIR, '05-overlay.png'), fullPage: true })
  } catch (err) {
    console.warn('05 screenshot failed:', err)
  }
  await window.keyboard.press('Escape').catch(() => {})

  // ── Persist results for the report script ──
  const results = {
    userDataPath,
    tmpUserData,
    loadedCompName,
    routineCount,
    loadErr,
    dryRunCount: dryRunLines.length,
    dryRunSample: dryRunLines.slice(0, 10),
    reconcileSummary,
    navCheck,
    clickResult,
    afterClick,
    settingsOpened,
    wifiOpened,
    overlayOpened,
    consoleMessageCount: consoleMessages.length,
    consoleErrors: consoleMessages.filter((m) => m.type === 'error').map((m) => m.text),
    consoleWarnings: consoleMessages.filter((m) => m.type === 'warning').map((m) => m.text).slice(0, 10),
    pageErrors,
  }
  fs.writeFileSync('tests/reports/empwr-london-2026-04-14-results.json', JSON.stringify(results, null, 2))
  fs.writeFileSync(MAIN_LOG_PATH, mainLogs.join(''))
  console.log('\nWROTE:', 'tests/reports/empwr-london-2026-04-14-results.json')
  console.log('WROTE:', MAIN_LOG_PATH)

  await app.close().catch((e) => console.warn('close failed:', e))

  // Try to clean up tmp userData
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true })
  } catch (e) {
    console.warn('failed to rm tmpUserData:', e)
  }
})
