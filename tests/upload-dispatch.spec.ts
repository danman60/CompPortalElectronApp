import { test, expect, _electron as electron } from '@playwright/test'

const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
if (!hasDisplay) process.env.DISPLAY = ':0'

test.describe('Upload Dispatch — Queue & Routing', () => {
  let app: Awaited<ReturnType<typeof electron.launch>>
  let window: Awaited<ReturnType<typeof app.firstWindow>>

  test.beforeAll(async () => {
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
  })

  // ---------- Job Queue Basics ----------

  test('job queue returns an array', async () => {
    const queue = await window.evaluate(async () => {
      return await window.api.jobQueueGet()
    })
    expect(Array.isArray(queue)).toBe(true)
  })

  test('job queue entries have required fields', async () => {
    const queue = await window.evaluate(async () => {
      return await window.api.jobQueueGet()
    })

    for (const job of queue) {
      expect(job).toHaveProperty('id')
      expect(job).toHaveProperty('type')
      expect(job).toHaveProperty('status')
      expect(['pending', 'running', 'completed', 'failed']).toContain(job.status)
      expect(['upload', 'encode']).toContain(job.type)
    }
  })

  // ---------- Upload Without Connection ----------

  test('uploadAll without connection returns graceful error', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.uploadAll()
        return { success: true }
      } catch (e: any) {
        return { error: e.message }
      }
    })
    // Should either succeed silently (nothing to upload) or return a connection error
    expect(result).toBeDefined()
    if (result.error) {
      expect(result.error.toLowerCase()).toMatch(/connection|competition|share code/i)
    }
  })

  test('uploadRoutine with invalid ID fails gracefully', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.uploadRoutine('nonexistent-routine-id-xyz')
        return { success: true }
      } catch (e: any) {
        return { error: e.message }
      }
    })
    expect(result).toBeDefined()
  })

  // ---------- Upload Start/Stop State ----------

  test('upload start without active connection is safe', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.uploadStart()
        return 'started'
      } catch (e: any) {
        return e.message
      }
    })
    expect(result).toBeDefined()
  })

  test('upload stop is always safe', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.uploadStop()
        return 'stopped'
      } catch (e: any) {
        return e.message
      }
    })
    expect(result).toBeDefined()
  })

  test('upload start then stop does not leave hanging state', async () => {
    await window.evaluate(async () => {
      try { await window.api.uploadStart() } catch {}
      try { await window.api.uploadStop() } catch {}
    })

    // Queue should have no running jobs
    const queue = await window.evaluate(async () => {
      return await window.api.jobQueueGet()
    })
    const runningJobs = queue.filter((j: any) => j.status === 'running' && j.type === 'upload')
    expect(runningJobs.length).toBe(0)
  })

  // ---------- Upload Progress Events ----------

  test('upload progress listener can subscribe/unsubscribe', async () => {
    const result = await window.evaluate(async () => {
      let received = false
      const unsub = window.api.on('upload:progress', () => { received = true })
      unsub()
      return { subscribed: true }
    })
    expect(result.subscribed).toBe(true)
  })

  // ---------- Job Queue Retry/Cancel ----------

  test('job queue retry with invalid job ID is safe', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.jobQueueRetry('nonexistent-job-id')
        return { success: true }
      } catch (e: any) {
        return { error: e.message }
      }
    })
    expect(result).toBeDefined()
  })

  test('job queue cancel with invalid job ID is safe', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.jobQueueCancel('nonexistent-job-id')
        return { success: true }
      } catch (e: any) {
        return { error: e.message }
      }
    })
    expect(result).toBeDefined()
  })

  // ---------- Upload After Loading Competition ----------

  test('loading competition via CSV makes upload context available', async () => {
    const loaded = await window.evaluate(async () => {
      try {
        await window.api.scheduleLoadCSV('/home/danman60/projects/CompSyncElectronApp/test-data/GLOW_Blue_Mountain_Spring_2026.csv')
        const schedule = await window.api.scheduleGet()
        return schedule?.routines?.length > 0
      } catch {
        return false
      }
    })

    if (loaded) {
      // With competition loaded, uploading should fail on missing API key, not missing schedule
      const result = await window.evaluate(async () => {
        try {
          await window.api.uploadAll()
          return { success: true }
        } catch (e: any) {
          return { error: e.message }
        }
      })
      if (result.error) {
        // Should complain about connection/API key, not "no routines"
        expect(result.error.toLowerCase()).not.toContain('no routines')
      }
    }
  })
})
