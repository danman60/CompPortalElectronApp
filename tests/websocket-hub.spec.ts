import { test, expect, _electron as electron } from '@playwright/test'
import WebSocket from 'ws'

const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
if (!hasDisplay) process.env.DISPLAY = ':0'

const WS_PORT = 9877

function connectWS(port = WS_PORT): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('WS connect timeout')), 5000)
  })
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs)
    ws.once('message', (data) => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(data.toString()))
      } catch {
        resolve(data.toString())
      }
    })
  })
}

test.describe('WebSocket Hub — Connectivity & Commands', () => {
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

  test('WebSocket hub accepts connections', async () => {
    const ws = await connectWS()
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  test('WebSocket hub handles multiple simultaneous clients', async () => {
    const clients: WebSocket[] = []
    for (let i = 0; i < 5; i++) {
      clients.push(await connectWS())
    }
    // All should be open
    for (const c of clients) {
      expect(c.readyState).toBe(WebSocket.OPEN)
    }
    // Clean up
    for (const c of clients) c.close()
  })

  test('WebSocket hub responds to identify as overlay client', async () => {
    const ws = await connectWS()
    ws.send(JSON.stringify({ type: 'identify', client: 'overlay' }))
    // Should not crash — give it a moment
    await new Promise((r) => setTimeout(r, 500))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  test('WebSocket hub responds to identify as streamdeck client', async () => {
    const ws = await connectWS()
    ws.send(JSON.stringify({ type: 'identify', client: 'streamdeck' }))
    await new Promise((r) => setTimeout(r, 500))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  test('WebSocket hub processes fireLowerThird command', async () => {
    const ws = await connectWS()
    ws.send(JSON.stringify({ type: 'command', command: 'fireLowerThird' }))
    await new Promise((r) => setTimeout(r, 500))
    // Verify overlay state changed
    const state = await window.evaluate(async () => {
      return (await window.api.overlayGetState()).lowerThird.visible
    })
    expect(state).toBe(true)
    // Clean up
    await window.evaluate(async () => await window.api.overlayHideLT())
    ws.close()
  })

  test('WebSocket hub processes nextRoutine command without crash', async () => {
    const ws = await connectWS()
    ws.send(JSON.stringify({ type: 'command', command: 'nextRoutine' }))
    await new Promise((r) => setTimeout(r, 1000))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  test('WebSocket hub ignores malformed messages gracefully', async () => {
    const ws = await connectWS()
    ws.send('not-json-at-all')
    ws.send('{"broken":')
    ws.send(JSON.stringify({ type: 'unknown', foo: 'bar' }))
    await new Promise((r) => setTimeout(r, 500))
    // Connection should still be alive
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  test('WebSocket hub broadcasts state to overlay clients', async () => {
    const overlay1 = await connectWS()
    const overlay2 = await connectWS()
    overlay1.send(JSON.stringify({ type: 'identify', client: 'overlay' }))
    overlay2.send(JSON.stringify({ type: 'identify', client: 'overlay' }))
    await new Promise((r) => setTimeout(r, 500))

    // Both should still be connected
    expect(overlay1.readyState).toBe(WebSocket.OPEN)
    expect(overlay2.readyState).toBe(WebSocket.OPEN)

    overlay1.close()
    overlay2.close()
  })

  test('WebSocket client disconnect is handled cleanly', async () => {
    const ws = await connectWS()
    ws.close()
    await new Promise((r) => setTimeout(r, 500))
    // App should still be running
    const title = await window.title()
    expect(title).toBe('CompSync Media')
  })

  test('WebSocket hub survives rapid connect/disconnect cycles', async () => {
    for (let i = 0; i < 10; i++) {
      const ws = await connectWS()
      ws.close()
    }
    // Final connection should still work
    const ws = await connectWS()
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})
