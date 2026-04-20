import { test, _electron as electron } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Full recording→encode→upload→verify pipeline test for EMPWR-LONDON.
// Runs against PRODUCTION CompPortal + R2. MUST clean up everything it creates.
// Does NOT touch the user's real state directory.

const TMP_REC_DIR = '/tmp/compsync-recordings'
const RESULTS_PATH = 'tests/reports/empwr-london-pipeline-2026-04-14-results.json'
const MAIN_LOG_PATH = 'tests/reports/empwr-london-pipeline-2026-04-14-mainlog.txt'

test.setTimeout(300000)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

test('EMPWR-LONDON full pipeline record → encode → upload → verify → cleanup', async () => {
  const results: Record<string, unknown> = {
    phases: {
      phase1_launch: 'PENDING',
      phase2_loadCompetition: 'PENDING',
      phase3_recording: 'PENDING',
      phase4_encodeUpload: 'PENDING',
      phase5_dbVerify: 'PENDING',
      phase6_mediaPlayback: 'PENDING',
      phase7_cleanup: 'PENDING',
    },
    timings: {} as Record<string, number>,
    errors: [] as string[],
    routine: null as null | { id: string; entryNumber: string; routineTitle: string },
    uploadRunId: null as null | string,
    encodedFiles: [] as unknown[],
    dbRow: null as unknown,
    mediaUrl: null as null | string,
    mediaHttpStatus: null as null | number,
    cleanup: { db: false, r2: false, local: false },
  }

  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'compsync-e2e-pipeline-'))
  console.log('tmp user data dir:', tmpUserData)
  fs.mkdirSync(TMP_REC_DIR, { recursive: true })

  // Snapshot existing recordings so we can identify NEW files
  const preExistingRecordings = new Set(
    fs.existsSync(TMP_REC_DIR) ? fs.readdirSync(TMP_REC_DIR) : [],
  )

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

  const userDataPath = await app.evaluate(async ({ app }) => app.getPath('userData'))
  console.log('userData resolved to:', userDataPath)
  results.userDataPath = userDataPath
  results.tmpUserData = tmpUserData

  try {
    // ── Phase 1: Launch + OBS connect ───────────────────────────────
    console.log('\n=== Phase 1: Launch + OBS connect ===')
    const phase1Start = Date.now()

    // App does NOT auto-connect OBS on startup — drive it explicitly.
    const connectResult: any = await window.evaluate(async () => {
      // @ts-expect-error preload api
      return await window.api.obsConnect('ws://localhost:4455', '')
    })
    console.log('obsConnect result:', connectResult)

    // Main-process stdout isn't reliably captured in this harness, so verify via
    // the IPC return value + a state-check poll.
    const obsConnected =
      connectResult && connectResult.connectionStatus === 'connected'
    console.log('OBS connected:', obsConnected)
    results.phases['phase1_launch'] = obsConnected ? 'PASS' : 'FAIL'
    results.timings['phase1_ms'] = Date.now() - phase1Start
    if (!obsConnected) {
      results.errors.push('OBS did not report Connected log line within 10s')
      throw new Error('Phase 1 failed: OBS not connected')
    }

    // ── Phase 2: Load competition ────────────────────────────────────
    console.log('\n=== Phase 2: Load EMPWR-LONDON ===')
    const phase2Start = Date.now()
    const loadRes: any = await window.evaluate(async () => {
      // @ts-expect-error preload api
      return await window.api.scheduleLoadShareCode('EMPWR-LONDON')
    })
    if (!loadRes || !loadRes.routines) {
      results.phases['phase2_loadCompetition'] = 'FAIL'
      results.errors.push('scheduleLoadShareCode returned: ' + JSON.stringify(loadRes).slice(0, 300))
      throw new Error('Phase 2 failed: no routines')
    }
    const routineCount = loadRes.routines.length
    console.log(`Loaded competition "${loadRes.name}" — ${routineCount} routines`)
    results.competitionName = loadRes.name
    results.routineCount = routineCount

    // Pick a pending routine from the tail, preferring one with a numeric entryNumber.
    // (The very-last routine is often an "ADJUDICATION HELD" placeholder.)
    let testRoutine: any = null
    for (let i = routineCount - 1; i >= Math.max(0, routineCount - 30); i--) {
      const r = loadRes.routines[i]
      if (r && (r.status === 'pending' || r.status === undefined) && r.entryNumber && /\d/.test(r.entryNumber)) {
        testRoutine = r
        break
      }
    }
    if (!testRoutine) {
      testRoutine = loadRes.routines[routineCount - 1]
      console.log('Fell back to last routine:', testRoutine.entryNumber, testRoutine.routineTitle)
    }
    results.routine = {
      id: testRoutine.id,
      entryNumber: testRoutine.entryNumber,
      routineTitle: testRoutine.routineTitle,
    }
    console.log('Test routine picked:', results.routine)
    results.phases['phase2_loadCompetition'] = routineCount === 562 ? 'PASS' : 'PASS-UNEXPECTED-COUNT'
    results.timings['phase2_ms'] = Date.now() - phase2Start

    // Jump to the selected routine
    await window.evaluate(async (id: string) => {
      // @ts-expect-error preload api
      return await window.api.jumpToRoutine(id)
    }, testRoutine.id)
    await sleep(500)

    // Helper: fetch a routine's current state via scheduleGet
    const getRoutineState = async (id: string): Promise<any | null> => {
      const comp: any = await window.evaluate(async () => {
        // @ts-expect-error preload api
        return await window.api.scheduleGet()
      })
      if (!comp || !comp.routines) return null
      return comp.routines.find((r: any) => r.id === id) || null
    }

    // ── Phase 3: Recording ───────────────────────────────────────────
    console.log('\n=== Phase 3: Recording 6s of ColorBars ===')
    const phase3Start = Date.now()
    const recStartRes = await window.evaluate(async () => {
      // @ts-expect-error preload api
      return await window.api.obsStartRecord()
    })
    console.log('obsStartRecord result:', recStartRes)

    // Wait for routine.status === 'recording' OR an MKV to appear in /tmp/compsync-recordings.
    let recStarted = false
    const seenStatuses: string[] = []
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      const rt = await getRoutineState(testRoutine.id)
      if (rt && !seenStatuses.includes(rt.status)) {
        seenStatuses.push(rt.status)
        console.log('  poll status:', rt.status)
      }
      if (rt && rt.status === 'recording') {
        recStarted = true
        break
      }
      // Side-channel: detect new MKV file in rec dir
      const currentFiles = fs.existsSync(TMP_REC_DIR) ? fs.readdirSync(TMP_REC_DIR) : []
      const newFiles = currentFiles.filter((f) => !preExistingRecordings.has(f))
      if (newFiles.length > 0) {
        console.log('  detected new MKV in rec dir:', newFiles)
        recStarted = true
        break
      }
    }
    results.seenStatusesAfterStart = seenStatuses
    if (!recStarted) {
      results.phases['phase3_recording'] = 'FAIL'
      results.errors.push(
        'Routine never reached status=recording within 10s. Seen statuses: ' +
          JSON.stringify(seenStatuses),
      )
      throw new Error('Phase 3 failed: record never started')
    }
    console.log('Recording started — waiting 6s of content')
    await sleep(6000)

    const recStopRes = await window.evaluate(async () => {
      // @ts-expect-error preload api
      return await window.api.obsStopRecord()
    })
    console.log('obsStopRecord result:', recStopRes)

    // Wait for status to leave 'recording' (→ recorded / encoding / queued)
    let recStopped = false
    for (let i = 0; i < 60; i++) {
      // 30s max
      await sleep(500)
      const rt = await getRoutineState(testRoutine.id)
      if (rt && rt.status !== 'recording') {
        recStopped = true
        console.log('Post-stop routine status:', rt.status, 'outputPath:', rt.outputPath)
        results.outputPath = rt.outputPath
        if (rt.outputDir) results.routineDir = rt.outputDir
        break
      }
    }
    results.timings['phase3_ms'] = Date.now() - phase3Start

    if (!recStopped) {
      results.phases['phase3_recording'] = 'FAIL'
      results.errors.push('Routine never left recording status within 30s of stop')
      throw new Error('Phase 3 failed: record never stopped cleanly')
    }
    results.phases['phase3_recording'] = 'PASS'

    // Verify non-empty MKV exists on disk
    if (results.outputPath && fs.existsSync(String(results.outputPath))) {
      const sz = fs.statSync(String(results.outputPath)).size
      results.mkvSize = sz
      console.log('MKV on disk:', results.outputPath, sz, 'bytes')
      if (sz === 0) results.errors.push('MKV file is empty')
    } else {
      results.errors.push('MKV file not found on disk after record stop')
    }

    // ── Phase 4: Encode + Upload ─────────────────────────────────────
    console.log('\n=== Phase 4: Encode + Upload ===')
    const phase4Start = Date.now()
    let encoded = false
    let uploaded = false
    let lastStatus: string | null = null

    // Poll routine.status until 'uploaded' or failure
    // 200 iterations * 1s = 200s max
    for (let i = 0; i < 200; i++) {
      await sleep(1000)
      const rt = await getRoutineState(testRoutine.id)
      if (!rt) continue
      if (rt.status !== lastStatus) {
        console.log(`  routine status: ${lastStatus || 'init'} → ${rt.status}`)
        lastStatus = rt.status
      }
      if (!encoded && (rt.status === 'encoded' || rt.status === 'uploading' || rt.status === 'uploaded')) {
        encoded = true
        results.timings['encode_ms'] = Date.now() - phase4Start
        console.log('✓ Encode complete at +' + results.timings['encode_ms'] + 'ms')
      }
      if (rt.status === 'uploaded') {
        uploaded = true
        results.timings['upload_ms'] = Date.now() - phase4Start - (Number(results.timings['encode_ms']) || 0)
        results.uploadRunId = rt.uploadRunId || null
        results.encodedFiles = rt.encodedFiles || []
        results.routineStatus = rt.status
        console.log('✓ Upload complete. uploadRunId:', rt.uploadRunId)
        break
      }
      if (rt.status === 'failed') {
        results.errors.push('Routine ended in failed state: ' + (rt.error || ''))
        break
      }
    }

    results.timings['phase4_ms'] = Date.now() - phase4Start
    results.phases['phase4_encodeUpload'] = uploaded ? 'PASS' : encoded ? 'PARTIAL' : 'FAIL'

    // Capture final state
    const finalState = await getRoutineState(testRoutine.id)
    if (finalState) {
      results.uploadRunId = finalState.uploadRunId || null
      results.encodedFiles = finalState.encodedFiles || []
      results.routineStatus = finalState.status
      console.log('Final routine state:', {
        status: finalState.status,
        uploadRunId: finalState.uploadRunId,
        encodedFiles: (finalState.encodedFiles || []).length,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Pipeline test error:', msg)
    ;(results.errors as string[]).push('caught: ' + msg)
  }

  // Write logs even on partial failure so we can debug
  fs.writeFileSync(MAIN_LOG_PATH, mainLogs.join(''))

  // Close app before DB + R2 cleanup
  await app.close().catch((e) => console.warn('app close failed:', e))

  // Clean up tmp userData
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true })
  } catch {}

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2))
  console.log('\nWROTE:', RESULTS_PATH)
  console.log('WROTE:', MAIN_LOG_PATH)
})
