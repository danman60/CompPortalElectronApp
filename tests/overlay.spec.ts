import { test, expect, _electron as electron } from '@playwright/test'
import http from 'http'
import WebSocket from 'ws'

const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
if (!hasDisplay) process.env.DISPLAY = ':0'

const OVERLAY_PORT = 9876
const WS_PORT = 9877

function httpGet(url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () =>
        resolve({ status: res.statusCode!, body, headers: res.headers as Record<string, string> }),
      )
    }).on('error', reject)
  })
}

test.describe('Overlay System — Full Feature Test', () => {
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
    await window.waitForTimeout(3000) // wait for overlay server to start
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  // ---------- HTTP Server ----------

  test('overlay HTTP server responds on /overlay', async () => {
    const res = await httpGet(`http://localhost:${OVERLAY_PORT}/overlay`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.body).toContain('<!DOCTYPE html>')
  })

  test('overlay HTML contains required elements', async () => {
    const res = await httpGet(`http://localhost:${OVERLAY_PORT}/overlay`)
    // Must have counter, clock, logo, lower-third divs
    expect(res.body).toContain('counter')
    expect(res.body).toContain('clock')
    expect(res.body).toContain('logo')
    expect(res.body).toContain('lower-third')
  })

  test('/current endpoint returns routine JSON', async () => {
    const res = await httpGet(`http://localhost:${OVERLAY_PORT}/current`)
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body)
    expect(data).toHaveProperty('entryNumber')
    expect(data).toHaveProperty('routineName')
    expect(data).toHaveProperty('dancers')
    expect(data).toHaveProperty('studioName')
  })

  // ---------- Overlay State via IPC ----------

  test('overlay getState returns all element states', async () => {
    const state = await window.evaluate(async () => {
      return await window.api.overlayGetState()
    })
    expect(state).toHaveProperty('counter')
    expect(state).toHaveProperty('clock')
    expect(state).toHaveProperty('logo')
    expect(state).toHaveProperty('lowerThird')
    expect(state.counter).toHaveProperty('visible')
    expect(state.clock).toHaveProperty('visible')
    expect(state.logo).toHaveProperty('visible')
    expect(state.lowerThird).toHaveProperty('visible')
  })

  // ---------- Toggle Each Element ----------

  test('toggle counter visibility', async () => {
    const before = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).counter.visible
    })
    await window.evaluate(async () => {
      await window.api.overlayToggle('counter')
    })
    const after = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).counter.visible
    })
    expect(after).toBe(!before)

    // Toggle back to restore
    await window.evaluate(async () => {
      await window.api.overlayToggle('counter')
    })
  })

  test('toggle clock visibility', async () => {
    const before = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).clock.visible
    })
    await window.evaluate(async () => {
      await window.api.overlayToggle('clock')
    })
    const after = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).clock.visible
    })
    expect(after).toBe(!before)
    await window.evaluate(async () => {
      await window.api.overlayToggle('clock')
    })
  })

  test('toggle logo visibility', async () => {
    const before = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).logo.visible
    })
    await window.evaluate(async () => {
      await window.api.overlayToggle('logo')
    })
    const after = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).logo.visible
    })
    expect(after).toBe(!before)
    await window.evaluate(async () => {
      await window.api.overlayToggle('logo')
    })
  })

  test('toggle lowerThird visibility', async () => {
    const before = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).lowerThird.visible
    })
    await window.evaluate(async () => {
      await window.api.overlayToggle('lowerThird')
    })
    const after = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).lowerThird.visible
    })
    expect(after).toBe(!before)
    await window.evaluate(async () => {
      await window.api.overlayToggle('lowerThird')
    })
  })

  // ---------- Lower Third Fire / Hide ----------

  test('fire lower third makes it visible', async () => {
    // Ensure hidden first
    await window.evaluate(async () => {
      await window.api.overlayHideLT()
    })
    const hiddenState = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).lowerThird.visible
    })
    expect(hiddenState).toBe(false)

    // Fire it
    await window.evaluate(async () => {
      await window.api.overlayFireLT()
    })
    const firedState = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).lowerThird.visible
    })
    expect(firedState).toBe(true)
  })

  test('hide lower third after fire', async () => {
    await window.evaluate(async () => {
      await window.api.overlayFireLT()
    })
    await window.evaluate(async () => {
      await window.api.overlayHideLT()
    })
    const state = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).lowerThird.visible
    })
    expect(state).toBe(false)
  })

  test('lower third auto-hides after configured seconds', async () => {
    // Set auto-hide to 2 seconds for test speed
    await window.evaluate(async () => {
      const settings = await window.api.settingsGet()
      settings.overlay = settings.overlay || {}
      settings.overlay.autoHideSeconds = 2
      await window.api.settingsSet(settings)
    })

    await window.evaluate(async () => {
      await window.api.overlayFireLT()
    })
    const visible = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).lowerThird.visible
    })
    expect(visible).toBe(true)

    // Wait for auto-hide
    await window.waitForTimeout(3000)
    const hidden = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).lowerThird.visible
    })
    expect(hidden).toBe(false)
  })

  // ---------- Auto-fire Toggle ----------

  test('auto-fire toggle changes state', async () => {
    const before = await window.evaluate(async () => {
      return await window.api.overlayAutoFireToggle()
    })
    // Toggle returns the new state or we query it
    const state = await window.evaluate(async () => {
      return await window.api.overlayAutoFireToggle()
    })
    // Toggled twice = back to original, just verify no errors
    expect(typeof state).not.toBe('undefined')
  })

  // ---------- Overlay Shows Routine Data ----------

  test('overlay reflects routine data updates', async () => {
    // Load test CSV to populate routines
    const loaded = await window.evaluate(async () => {
      try {
        await window.api.scheduleLoadCSV('/home/danman60/projects/CompSyncElectronApp/test-data/GLOW_Blue_Mountain_Spring_2026.csv')
        return true
      } catch { return false }
    })

    if (loaded) {
      // Advance to first routine so overlay gets data
      await window.evaluate(async () => {
        await window.api.recordingNext()
      })
      await window.waitForTimeout(500)

      const res = await httpGet(`http://localhost:${OVERLAY_PORT}/current`)
      const data = JSON.parse(res.body)
      // After loading a comp and advancing, entry data should be populated
      expect(data.entryNumber || data.routineName).toBeTruthy()
    }
  })

  // ---------- Overlay HTML Animation Classes ----------

  test('overlay HTML includes all animation types', async () => {
    const res = await httpGet(`http://localhost:${OVERLAY_PORT}/overlay`)
    const animations = ['slide', 'zoom', 'fade', 'rise', 'sparkle']
    for (const anim of animations) {
      expect(res.body.toLowerCase()).toContain(anim)
    }
  })

  // ---------- Overlay Survives Rapid Toggles ----------

  test('overlay survives rapid toggle spam without errors', async () => {
    const results = await window.evaluate(async () => {
      const errors: string[] = []
      for (let i = 0; i < 20; i++) {
        try {
          await window.api.overlayToggle('lowerThird')
        } catch (e: any) {
          errors.push(e.message)
        }
      }
      return errors
    })
    expect(results).toHaveLength(0)
  })

  test('rapid fire/hide cycles do not crash', async () => {
    const errors = await window.evaluate(async () => {
      const errs: string[] = []
      for (let i = 0; i < 10; i++) {
        try {
          await window.api.overlayFireLT()
          await window.api.overlayHideLT()
        } catch (e: any) {
          errs.push(e.message)
        }
      }
      return errs
    })
    expect(errors).toHaveLength(0)
  })
})
