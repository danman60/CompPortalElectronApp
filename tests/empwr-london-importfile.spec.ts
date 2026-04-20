import { test, _electron as electron } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Full importFile → encode → upload → verify pipeline test for EMPWR-LONDON.
// Bypasses OBS entirely by injecting a pre-recorded fixture via window.api.importFile.
// Runs against PRODUCTION CompPortal + R2. DB/R2 cleanup happens OUTSIDE this spec
// (the spec just captures IDs + paths for the parent agent to clean up via MCP/aws).

const FIXTURE_PATH = '/tmp/compsync-fixtures/test-recording.mkv'
const RESULTS_PATH = 'tests/reports/empwr-london-importfile-2026-04-14-results.json'
const MAIN_LOG_PATH = 'tests/reports/empwr-london-importfile-2026-04-14-mainlog.txt'

test.setTimeout(420000) // 7 min — encode+upload buffer

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

test('EMPWR-LONDON importFile pipeline: encode → upload → capture IDs', async () => {
  const results: Record<string, unknown> = {
    phases: {
      phase1_launch: 'PENDING',
      phase2_pickRoutine: 'PENDING',
      phase3_importFile: 'PENDING',
      phase4_encode: 'PENDING',
      phase5_upload: 'PENDING',
    },
    timings: {} as Record<string, number>,
    errors: [] as string[],
    resolvedConnection: null as unknown,
    routine: null as null | { id: string; entryNumber: string; routineTitle: string; priorStatus: string },
    outputDir: null as null | string,
    outputPath: null as null | string,
    uploadRunId: null as null | string,
    encodedFiles: [] as unknown[],
    finalRoutineStatus: null as null | string,
    importedTmpDir: null as null | string,
  }

  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture missing: ${FIXTURE_PATH} — run Phase 0 first`)
  }

  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'compsync-e2e-importfile-'))
  console.log('tmp user data dir:', tmpUserData)
  results.tmpUserData = tmpUserData

  // Tell the app to write its output somewhere isolated (not the user's real output dir).
  const tmpOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compsync-e2e-output-'))
  results.importedTmpDir = tmpOutputDir
  console.log('tmp output dir:', tmpOutputDir)

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
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2000)

  window.on('console', (msg) => {
    try {
      const text = msg.text()
      mainLogs.push(`[renderer:${msg.type()}] ${text}\n`)
    } catch {}
  })

  try {
    // ── Phase 1: Launch + load competition ───────────────────────────
    console.log('\n=== Phase 1: Launch + load EMPWR-LONDON ===')
    const phase1Start = Date.now()

    // Point the app at the isolated tmp output dir so any stray files stay out of real state.
    await window.evaluate(async (dir: string) => {
      // @ts-expect-error preload api
      return await window.api.settingsSet({ fileNaming: { outputDirectory: dir } })
    }, tmpOutputDir)

    const loadRes: any = await window.evaluate(async () => {
      // @ts-expect-error preload api
      return await window.api.scheduleLoadShareCode('EMPWR-LONDON')
    })
    if (!loadRes || !loadRes.routines) {
      results.phases['phase1_launch'] = 'FAIL'
      results.errors.push('scheduleLoadShareCode returned: ' + JSON.stringify(loadRes).slice(0, 300))
      throw new Error('Phase 1 failed: no routines')
    }
    const routineCount = loadRes.routines.length
    console.log(`Loaded competition "${loadRes.name}" — ${routineCount} routines`)
    results.competitionName = loadRes.name
    results.routineCount = routineCount
    results.phases['phase1_launch'] = routineCount > 500 ? 'PASS' : 'FAIL'
    results.timings['phase1_ms'] = Date.now() - phase1Start

    // Resolved connection (tenant, apiBase, competitionId) is proved indirectly via
    // main-process log scraping — look for `Loading schedule from <apiBase>/api/plugin/schedule/<competitionId>`
    // and the `Calling plugin/complete for routine` lines in mainLogs after upload.
    results.resolvedConnection = { note: 'captured via main log scraping post-run' }

    // ── Phase 2: Pick test routine ───────────────────────────────────
    console.log('\n=== Phase 2: Pick pending test routine ===')
    const phase2Start = Date.now()

    // Try the pre-picked candidate first (#546 "Rising Sun"), otherwise fall back.
    const PREFERRED_ID = 'efe2fcff-5d9b-4877-b239-f99d50b0705a'
    let testRoutine: any =
      loadRes.routines.find((r: any) => r.id === PREFERRED_ID && (r.status === 'pending' || r.status === undefined)) ||
      null

    if (!testRoutine) {
      // Walk backward from the tail looking for a pending routine with a numeric entry.
      for (let i = routineCount - 1; i >= Math.max(0, routineCount - 40); i--) {
        const r = loadRes.routines[i]
        if (
          r &&
          (r.status === 'pending' || r.status === undefined) &&
          r.entryNumber &&
          /\d/.test(r.entryNumber) &&
          !/ADJUDICATION|BUFFER|BREAK/i.test(r.routineTitle || '')
        ) {
          testRoutine = r
          break
        }
      }
    }

    if (!testRoutine) {
      results.phases['phase2_pickRoutine'] = 'FAIL'
      throw new Error('Phase 2 failed: no suitable pending routine found')
    }

    results.routine = {
      id: testRoutine.id,
      entryNumber: testRoutine.entryNumber,
      routineTitle: testRoutine.routineTitle,
      priorStatus: testRoutine.status || 'pending',
    }
    console.log('Test routine picked:', results.routine)
    results.phases['phase2_pickRoutine'] = 'PASS'
    results.timings['phase2_ms'] = Date.now() - phase2Start

    const getRoutineState = async (id: string): Promise<any | null> => {
      const comp: any = await window.evaluate(async () => {
        // @ts-expect-error preload api
        return await window.api.scheduleGet()
      })
      if (!comp || !comp.routines) return null
      return comp.routines.find((r: any) => r.id === id) || null
    }

    // Jump to selected routine
    await window.evaluate(async (id: string) => {
      // @ts-expect-error preload api
      return await window.api.jumpToRoutine(id)
    }, testRoutine.id)
    await sleep(500)

    // ── Phase 3: Inject pre-recorded file via importFile ─────────────
    console.log('\n=== Phase 3: importFile fixture into routine ===')
    const phase3Start = Date.now()

    const importRes: any = await window.evaluate(
      async ({ id, filePath }: { id: string; filePath: string }) => {
        // @ts-expect-error preload api
        return await window.api.importFile(id, filePath)
      },
      { id: testRoutine.id, filePath: FIXTURE_PATH },
    )
    console.log('importFile result:', importRes)
    results.importFileResult = importRes

    if (!importRes || importRes.error || !importRes.success) {
      results.phases['phase3_importFile'] = 'FAIL'
      results.errors.push('importFile error: ' + JSON.stringify(importRes))
      throw new Error('Phase 3 failed: importFile did not succeed')
    }

    // Wait for routine.status to reach 'recorded' (or beyond)
    let reached = false
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      const rt = await getRoutineState(testRoutine.id)
      if (rt && (rt.status === 'recorded' || rt.status === 'encoding' || rt.status === 'encoded' || rt.status === 'uploading' || rt.status === 'uploaded')) {
        reached = true
        results.outputPath = rt.outputPath || null
        results.outputDir = rt.outputDir || null
        console.log('Post-import routine state:', {
          status: rt.status,
          outputPath: rt.outputPath,
          outputDir: rt.outputDir,
        })
        break
      }
    }

    if (!reached) {
      results.phases['phase3_importFile'] = 'FAIL'
      throw new Error('Phase 3 failed: routine never reached recorded state after importFile')
    }
    results.phases['phase3_importFile'] = 'PASS'
    results.timings['phase3_ms'] = Date.now() - phase3Start

    // ── Phase 4: Encode (auto) ───────────────────────────────────────
    console.log('\n=== Phase 4: Wait for encode ===')
    const phase4Start = Date.now()
    let encoded = false
    let lastStatus: string | null = null

    for (let i = 0; i < 90; i++) {
      // 90s max
      await sleep(1000)
      const rt = await getRoutineState(testRoutine.id)
      if (!rt) continue
      if (rt.status !== lastStatus) {
        console.log(`  encode poll: ${lastStatus || 'init'} → ${rt.status}`)
        lastStatus = rt.status
      }
      if (
        rt.status === 'encoded' ||
        rt.status === 'uploading' ||
        rt.status === 'uploaded'
      ) {
        encoded = true
        results.encodedFiles = rt.encodedFiles || []
        console.log('Encoded files:', (rt.encodedFiles || []).length)
        break
      }
      if (rt.status === 'failed') {
        results.errors.push('Routine failed during encode: ' + (rt.error || ''))
        break
      }
    }
    results.timings['phase4_ms'] = Date.now() - phase4Start
    results.phases['phase4_encode'] = encoded ? 'PASS' : 'FAIL'
    if (!encoded) throw new Error('Phase 4 failed: encode did not finish within 90s')

    // ── Phase 5: Upload (auto, via plugin API) ───────────────────────
    console.log('\n=== Phase 5: Wait for upload ===')
    const phase5Start = Date.now()
    let uploaded = false
    lastStatus = null

    for (let i = 0; i < 180; i++) {
      // 180s max
      await sleep(1000)
      const rt = await getRoutineState(testRoutine.id)
      if (!rt) continue
      if (rt.status !== lastStatus) {
        console.log(`  upload poll: ${lastStatus || 'init'} → ${rt.status}`)
        lastStatus = rt.status
      }
      if (rt.status === 'uploaded') {
        uploaded = true
        results.uploadRunId = rt.uploadRunId || null
        results.encodedFiles = rt.encodedFiles || []
        results.finalRoutineStatus = rt.status
        console.log('Upload complete. uploadRunId:', rt.uploadRunId)
        console.log('encodedFiles:', JSON.stringify(rt.encodedFiles, null, 2))
        break
      }
      if (rt.status === 'failed') {
        results.errors.push('Routine failed during upload: ' + (rt.error || ''))
        break
      }
    }
    results.timings['phase5_ms'] = Date.now() - phase5Start
    results.phases['phase5_upload'] = uploaded ? 'PASS' : 'FAIL'

    // Always capture final state
    const finalState = await getRoutineState(testRoutine.id)
    if (finalState) {
      results.uploadRunId = finalState.uploadRunId || results.uploadRunId
      results.encodedFiles = finalState.encodedFiles || results.encodedFiles
      results.finalRoutineStatus = finalState.status
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Pipeline test error:', msg)
    ;(results.errors as string[]).push('caught: ' + msg)
  }

  // Write logs and close
  fs.writeFileSync(MAIN_LOG_PATH, mainLogs.join(''))
  await app.close().catch((e) => console.warn('app close failed:', e))

  // Clean up tmp userData (output dir is kept — parent agent may want to inspect)
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true })
  } catch {}

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2))
  console.log('\nWROTE:', RESULTS_PATH)
  console.log('WROTE:', MAIN_LOG_PATH)
})
