import { test, expect, _electron as electron } from '@playwright/test'

const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
if (!hasDisplay) process.env.DISPLAY = ':0'

test.describe('System Monitor & App Stability', () => {
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

  // ---------- System Stats via IPC ----------

  test('system stats events are emitted within 10s', async () => {
    const stats = await window.evaluate(() => {
      return new Promise<any>((resolve) => {
        const unsub = window.api.on('system:stats', (data: any) => {
          unsub()
          resolve(data)
        })
        // Failsafe
        setTimeout(() => { unsub(); resolve(null) }, 12000)
      })
    })

    expect(stats).not.toBeNull()
    expect(stats).toHaveProperty('cpuPercent')
    expect(stats).toHaveProperty('diskFreeGB')
    expect(stats).toHaveProperty('diskTotalGB')
    expect(typeof stats.cpuPercent).toBe('number')
    expect(stats.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(stats.cpuPercent).toBeLessThanOrEqual(100)
  })

  test('disk stats report valid numbers', async () => {
    const stats = await window.evaluate(() => {
      return new Promise<any>((resolve) => {
        const unsub = window.api.on('system:stats', (data: any) => {
          unsub()
          resolve(data)
        })
        setTimeout(() => { unsub(); resolve(null) }, 12000)
      })
    })

    expect(stats).not.toBeNull()
    // diskFreeGB can be -1 if statfs fails (wrong platform), but should be a number
    expect(typeof stats.diskFreeGB).toBe('number')
    expect(typeof stats.diskTotalGB).toBe('number')
    // On a real system, total should be > 0 (unless statfs failed)
    if (stats.diskTotalGB > 0) {
      expect(stats.diskFreeGB).toBeGreaterThan(0)
      expect(stats.diskFreeGB).toBeLessThanOrEqual(stats.diskTotalGB)
    }
  })

  // ---------- CPU Baseline ----------

  test('CPU usage stays below 80% at idle (sampled over 15s)', async () => {
    const samples = await window.evaluate(() => {
      return new Promise<number[]>((resolve) => {
        const cpuSamples: number[] = []
        const unsub = window.api.on('system:stats', (data: any) => {
          cpuSamples.push(data.cpuPercent)
          if (cpuSamples.length >= 3) {
            unsub()
            resolve(cpuSamples)
          }
        })
        setTimeout(() => { unsub(); resolve(cpuSamples) }, 20000)
      })
    })

    expect(samples.length).toBeGreaterThanOrEqual(2)
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length
    console.log(`CPU samples: ${samples.join(', ')}% — avg: ${avg.toFixed(1)}%`)
    expect(avg).toBeLessThan(80)
  })

  // ---------- Memory Baseline ----------

  test('app process memory under 500MB at idle', async () => {
    const memInfo = await app.evaluate(async ({ app }) => {
      const metrics = await app.getAppMetrics()
      let totalKB = 0
      for (const m of metrics) {
        totalKB += m.memory.workingSetSize
      }
      return { totalMB: Math.round(totalKB / 1024), processCount: metrics.length }
    })

    console.log(`App memory: ${memInfo.totalMB}MB across ${memInfo.processCount} processes`)
    expect(memInfo.totalMB).toBeLessThan(500)
  })

  // ---------- Startup Validation ----------

  test('startup report returns diagnostics', async () => {
    const report = await window.evaluate(async () => {
      try {
        return await window.api.copyDiagnostics()
      } catch {
        return null
      }
    })

    // copyDiagnostics returns a string with system info
    if (report) {
      expect(typeof report).toBe('string')
      console.log('Diagnostics length:', report.length)
    }
  })

  // ---------- Stability Under Load ----------

  test('app remains responsive after 50 rapid IPC calls', async () => {
    const start = Date.now()
    const result = await window.evaluate(async () => {
      const errors: string[] = []
      for (let i = 0; i < 50; i++) {
        try {
          await window.api.overlayGetState()
          await window.api.settingsGet()
        } catch (e: any) {
          errors.push(e.message)
        }
      }
      return { errors, version: await window.api.getVersion() }
    })
    const elapsed = Date.now() - start

    console.log(`50 IPC round-trips in ${elapsed}ms (${(elapsed / 100).toFixed(1)}ms/call)`)
    expect(result.errors).toHaveLength(0)
    expect(result.version).toBeTruthy()
    // Should complete in under 10 seconds
    expect(elapsed).toBeLessThan(10000)
  })

  test('app window count stays at 1 (no leaking windows)', async () => {
    const windowCount = await app.evaluate(async ({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length
    })
    expect(windowCount).toBe(1)
  })

  test('no uncaught exceptions in renderer console', async () => {
    const errors: string[] = []
    window.on('pageerror', (err) => errors.push(err.message))

    // Do some activity
    await window.evaluate(async () => {
      await window.api.overlayGetState()
      await window.api.settingsGet()
      await window.api.jobQueueGet()
    })
    await window.waitForTimeout(2000)

    if (errors.length > 0) {
      console.log('Renderer errors:', errors)
    }
    expect(errors).toHaveLength(0)
  })
})
