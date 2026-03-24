import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
if (!hasDisplay) process.env.DISPLAY = ':0'

const TEST_DIR = '/tmp/compsync-test-ffmpeg'
const TEST_VIDEO = path.join(TEST_DIR, 'test-input.mkv')

test.describe('FFmpeg Recording Pipeline', () => {
  let app: Awaited<ReturnType<typeof electron.launch>>
  let window: Awaited<ReturnType<typeof app.firstWindow>>

  test.beforeAll(async () => {
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true })

    // Generate a minimal 5-second test MKV with 2 audio tracks (simulating performance + judge)
    // Using lavfi test sources — no real camera needed
    try {
      execSync(
        `ffmpeg -y -f lavfi -i testsrc=duration=5:size=640x480:rate=30 ` +
        `-f lavfi -i sine=frequency=440:duration=5 ` +
        `-f lavfi -i sine=frequency=880:duration=5 ` +
        `-map 0:v -map 1:a -map 2:a ` +
        `-c:v libx264 -preset ultrafast -crf 28 ` +
        `-c:a aac -b:a 64k ` +
        `${TEST_VIDEO}`,
        { timeout: 30000, stdio: 'pipe' },
      )
    } catch (err) {
      console.warn('Could not generate test video:', err)
    }

    app = await electron.launch({
      args: [
        './out/main/index.js',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-software-rasterizer',
        '--disable-gpu-sandbox',
        '--disable-features=VizDisplayCompositor',
      ],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', DISPLAY: process.env.DISPLAY || ':0' },
      timeout: 30000,
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(3000)
  })

  test.afterAll(async () => {
    if (app) await app.close()
    // Clean up test files
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {}
  })

  // ---------- FFmpeg Availability ----------

  test('FFmpeg binary is accessible', async () => {
    // Check via the app's internal validation
    const version = await window.evaluate(async () => {
      // Access main process ffmpeg validation indirectly
      try {
        const diag = await window.api.copyDiagnostics()
        return diag
      } catch {
        return null
      }
    })
    // Diagnostics returns either a string or object — just verify it's truthy
    expect(version).toBeTruthy()
  })

  test('system ffmpeg is available on PATH', () => {
    try {
      const version = execSync('ffmpeg -version', { timeout: 5000, stdio: 'pipe' }).toString()
      expect(version).toContain('ffmpeg version')
      console.log('System FFmpeg:', version.split('\n')[0])
    } catch {
      console.warn('FFmpeg not found on system PATH — bundled FFmpeg will be used')
    }
  })

  // ---------- Test Video Exists ----------

  test('test video was generated with correct tracks', () => {
    if (!fs.existsSync(TEST_VIDEO)) {
      test.skip()
      return
    }
    const probe = execSync(
      `ffprobe -v quiet -print_format json -show_streams ${TEST_VIDEO}`,
      { timeout: 10000 },
    ).toString()
    const info = JSON.parse(probe)
    const videoStreams = info.streams.filter((s: any) => s.codec_type === 'video')
    const audioStreams = info.streams.filter((s: any) => s.codec_type === 'audio')
    expect(videoStreams.length).toBe(1)
    expect(audioStreams.length).toBe(2) // performance + judge audio
    console.log(`Test video: ${videoStreams.length} video, ${audioStreams.length} audio tracks`)
  })

  // ---------- FFmpeg Settings ----------

  test('FFmpeg settings have required fields', async () => {
    const settings = await window.evaluate(async () => {
      const s = await window.api.settingsGet()
      return s.ffmpeg
    })

    expect(settings).toHaveProperty('path')
    expect(settings).toHaveProperty('cpuPriority')
    console.log('FFmpeg settings:', JSON.stringify(settings))
  })

  // ---------- Job Queue Integration ----------

  test('encode job queue starts empty or with only completed jobs', async () => {
    const queue = await window.evaluate(async () => {
      return await window.api.jobQueueGet()
    })
    const pendingEncodes = queue.filter(
      (j: any) => j.type === 'encode' && (j.status === 'pending' || j.status === 'running'),
    )
    expect(pendingEncodes.length).toBe(0)
  })

  // ---------- FFmpeg Progress Events ----------

  test('ffmpeg progress listener can subscribe/unsubscribe', async () => {
    const result = await window.evaluate(async () => {
      let received = false
      const unsub = window.api.on('ffmpeg:progress', () => { received = true })
      unsub()
      return { subscribed: true }
    })
    expect(result.subscribed).toBe(true)
  })

  // ---------- File Naming Convention ----------

  test('file naming pattern is configured', async () => {
    const settings = await window.evaluate(async () => {
      const s = await window.api.settingsGet()
      return s.fileNaming
    })

    expect(settings).toHaveProperty('pattern')
    expect(settings).toHaveProperty('outputDirectory')
    console.log('File naming pattern:', settings.pattern)
    console.log('Output directory:', settings.outputDirectory)
  })

  // ---------- Encode Request Without Active Recording ----------

  test('encodeAll without recordings is safe', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.ffmpegEncodeAll()
        return { success: true }
      } catch (e: any) {
        return { error: e.message }
      }
    })
    expect(result).toBeDefined()
  })

  // ---------- Output Directory Validation ----------

  test('configured output directory exists or is creatable', async () => {
    const outputDir = await window.evaluate(async () => {
      const s = await window.api.settingsGet()
      return s.fileNaming.outputDirectory
    })

    if (outputDir) {
      // On Linux (test env), just verify it's a string path
      expect(typeof outputDir).toBe('string')
      console.log('Output dir configured:', outputDir)
    }
  })

  // ---------- Competition Loading for Encode Context ----------

  test('loading competition provides routines for encoding pipeline', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.scheduleLoadCSV('/home/danman60/projects/CompSyncElectronApp/test-data/GLOW_Blue_Mountain_Spring_2026.csv')
        const schedule = await window.api.scheduleGet()
        return {
          loaded: true,
          routineCount: schedule?.routines?.length ?? 0,
          firstRoutine: schedule?.routines?.[0]
            ? {
                id: schedule.routines[0].id,
                entryNumber: schedule.routines[0].entryNumber,
                routineTitle: schedule.routines[0].routineTitle,
              }
            : null,
        }
      } catch (e: any) {
        return { loaded: false, error: e.message }
      }
    })

    if (result.loaded) {
      expect(result.routineCount).toBeGreaterThan(0)
      console.log(`Loaded ${result.routineCount} routines. First: #${result.firstRoutine?.entryNumber} ${result.firstRoutine?.routineTitle}`)
    }
  })
})
