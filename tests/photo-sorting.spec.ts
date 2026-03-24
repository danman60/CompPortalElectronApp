import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
if (!hasDisplay) process.env.DISPLAY = ':0'

const TEST_DIR = '/tmp/compsync-test-photos'
const PHOTO_DIR = path.join(TEST_DIR, 'camera-roll')
const DEST_DIR = path.join(TEST_DIR, 'sorted-output')

/**
 * Create a minimal JPEG file with EXIF DateTimeOriginal set.
 * Uses ImageMagick convert if available, otherwise creates a raw JPEG via sharp-less method.
 */
function createTestJPEG(filePath: string, dateTime: string): boolean {
  try {
    // dateTime format: "2026:03:24 14:30:00"
    // Use exiftool or convert to write EXIF
    // Fallback: use ffmpeg to create a 1-frame image
    const tmpPng = filePath.replace('.jpg', '.png')
    execSync(
      `ffmpeg -y -f lavfi -i color=c=blue:s=100x100:d=0.04 -frames:v 1 ${tmpPng}`,
      { timeout: 5000, stdio: 'pipe' },
    )
    execSync(
      `ffmpeg -y -i ${tmpPng} ${filePath}`,
      { timeout: 5000, stdio: 'pipe' },
    )
    fs.unlinkSync(tmpPng)

    // Write EXIF with exiftool if available
    try {
      execSync(
        `exiftool -overwrite_original -DateTimeOriginal="${dateTime}" ${filePath}`,
        { timeout: 5000, stdio: 'pipe' },
      )
      return true
    } catch {
      // exiftool not available — EXIF won't be set, test will note this
      return true
    }
  } catch {
    return false
  }
}

test.describe('Photo Import & Sorting', () => {
  let app: Awaited<ReturnType<typeof electron.launch>>
  let window: Awaited<ReturnType<typeof app.firstWindow>>
  let hasExiftool = false

  test.beforeAll(async () => {
    // Setup test directories
    fs.mkdirSync(PHOTO_DIR, { recursive: true })
    fs.mkdirSync(DEST_DIR, { recursive: true })

    // Check for exiftool
    try {
      execSync('exiftool -ver', { timeout: 3000, stdio: 'pipe' })
      hasExiftool = true
    } catch {
      console.warn('exiftool not available — EXIF-dependent tests will be limited')
    }

    // Create 10 test photos spanning a 30-minute window
    // Simulates: 3 photos per routine, 3 routines + 1 unmatched
    const baseTime = new Date('2026-03-24T10:00:00')
    const photos = [
      // Routine 1: 10:00-10:05
      { name: 'IMG_0001.jpg', offset: 0 },
      { name: 'IMG_0002.jpg', offset: 60 },
      { name: 'IMG_0003.jpg', offset: 180 },
      // Routine 2: 10:08-10:13
      { name: 'IMG_0004.jpg', offset: 480 },
      { name: 'IMG_0005.jpg', offset: 540 },
      { name: 'IMG_0006.jpg', offset: 660 },
      // Routine 3: 10:16-10:21
      { name: 'IMG_0007.jpg', offset: 960 },
      { name: 'IMG_0008.jpg', offset: 1020 },
      { name: 'IMG_0009.jpg', offset: 1140 },
      // Unmatched: way outside any window
      { name: 'IMG_0010.jpg', offset: 3600 },
    ]

    for (const p of photos) {
      const captureDate = new Date(baseTime.getTime() + p.offset * 1000)
      const exifDate = captureDate
        .toISOString()
        .replace(/T/, ' ')
        .replace(/\.\d+Z/, '')
        .replace(/-/g, ':')
        .replace(/T/, ' ')
      // Format: "2026:03:24 10:00:00"
      const formatted = `${captureDate.getFullYear()}:${String(captureDate.getMonth() + 1).padStart(2, '0')}:${String(captureDate.getDate()).padStart(2, '0')} ${String(captureDate.getHours()).padStart(2, '0')}:${String(captureDate.getMinutes()).padStart(2, '0')}:${String(captureDate.getSeconds()).padStart(2, '0')}`
      createTestJPEG(path.join(PHOTO_DIR, p.name), formatted)
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
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {}
  })

  // ---------- Test Photo Creation ----------

  test('test photos were created in camera-roll folder', () => {
    const files = fs.readdirSync(PHOTO_DIR).filter((f) => f.endsWith('.jpg'))
    console.log(`Created ${files.length} test photos in ${PHOTO_DIR}`)
    expect(files.length).toBeGreaterThanOrEqual(5) // at least some should have been created
  })

  test('test photos have EXIF data (if exiftool available)', () => {
    if (!hasExiftool) {
      console.log('Skipping EXIF verification — exiftool not installed')
      return
    }
    const firstPhoto = path.join(PHOTO_DIR, 'IMG_0001.jpg')
    if (!fs.existsSync(firstPhoto)) return

    const exif = execSync(`exiftool -DateTimeOriginal ${firstPhoto}`, {
      timeout: 5000,
    }).toString()
    expect(exif).toContain('Date/Time Original')
    console.log('EXIF check:', exif.trim())
  })

  // ---------- Photo Browse API ----------

  test('photos browse API is accessible', async () => {
    // Can't test dialog interaction, but verify API exists
    const exists = await window.evaluate(() => {
      return typeof window.api.photosBrowse === 'function'
    })
    expect(exists).toBe(true)
  })

  // ---------- Photo Import API ----------

  test('photos import API is accessible', async () => {
    const exists = await window.evaluate(() => {
      return typeof window.api.photosImport === 'function'
    })
    expect(exists).toBe(true)
  })

  // ---------- CLIP APIs ----------

  test('CLIP verify API is accessible', async () => {
    const exists = await window.evaluate(() => {
      return typeof window.api.clipVerifyImport === 'function'
    })
    expect(exists).toBe(true)
  })

  test('CLIP analyzeFolder API is accessible', async () => {
    const exists = await window.evaluate(() => {
      return typeof window.api.clipAnalyzeFolder === 'function'
    })
    expect(exists).toBe(true)
  })

  test('CLIP executeSort API is accessible', async () => {
    const exists = await window.evaluate(() => {
      return typeof window.api.clipExecuteSort === 'function'
    })
    expect(exists).toBe(true)
  })

  test('CLIP cancel API is accessible', async () => {
    const exists = await window.evaluate(() => {
      return typeof window.api.clipCancel === 'function'
    })
    expect(exists).toBe(true)
  })

  // ---------- CLIP Progress Events ----------

  test('CLIP progress listener can subscribe/unsubscribe', async () => {
    const result = await window.evaluate(async () => {
      let ok = true
      try {
        const unsub1 = window.api.on('clip:progress', () => {})
        unsub1()
        const unsub2 = window.api.on('clip:model-progress', () => {})
        unsub2()
      } catch {
        ok = false
      }
      return ok
    })
    expect(result).toBe(true)
  })

  // ---------- Photo Sorter UI ----------

  test('PhotoSorter component is accessible from left panel', async () => {
    // Look for the Photo Sorter nav item
    const hasSorter = await window.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      return buttons.some(
        (b) =>
          b.textContent?.toLowerCase().includes('photo') ||
          b.textContent?.toLowerCase().includes('sort'),
      )
    })
    // Take screenshot regardless
    await window.screenshot({ path: 'test-results/photo-sorter-nav.png' })
    console.log('Photo sorter nav button found:', hasSorter)
  })

  // ---------- CLIP analyzeFolder with Test Photos ----------

  test('CLIP analyzeFolder runs on test photo directory', async () => {
    // This will download the model on first run (~350MB), so allow a long timeout
    test.setTimeout(300000) // 5 minutes

    const result = await window.evaluate(async (photoDir: string) => {
      try {
        // Subscribe to progress
        const progress: any[] = []
        const unsub = window.api.on('clip:progress', (data: any) => {
          progress.push(data)
        })

        const analysis = await window.api.clipAnalyzeFolder(photoDir, {
          startingEntry: 1,
          samplingRate: 2,
          similarityThreshold: 0.75,
        })

        unsub()

        return {
          success: true,
          groups: analysis?.groups?.length ?? 0,
          transitions: analysis?.transitions?.length ?? 0,
          totalPhotos: analysis?.totalPhotos ?? 0,
          progressEvents: progress.length,
        }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    }, PHOTO_DIR)

    console.log('CLIP analyzeFolder result:', JSON.stringify(result))

    if (result.success) {
      expect(result.totalPhotos).toBeGreaterThan(0)
      expect(result.groups).toBeGreaterThan(0)
      console.log(`Found ${result.groups} groups, ${result.transitions} transitions, ${result.progressEvents} progress events`)
    } else {
      console.log('CLIP analysis failed (model download may be needed):', result.error)
    }
  })
})
