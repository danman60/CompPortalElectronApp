import express from 'express'
import http from 'http'
import { LowerThirdData } from '../../shared/types'
import { logger } from '../logger'

const PORT = 9876
let server: http.Server | null = null
let currentData: LowerThirdData = {
  entryNumber: '',
  routineName: '',
  dancers: [],
  studioName: '',
  category: '',
  visible: false,
}

const overlayHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: hidden; width: 1920px; height: 1080px; font-family: -apple-system, 'Segoe UI', sans-serif; }
  .lower-third {
    position: absolute;
    bottom: 80px;
    left: 60px;
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease, transform 0.5s ease;
  }
  .lower-third.visible {
    opacity: 1;
    transform: translateY(0);
  }
  .lt-card {
    background: rgba(30, 30, 46, 0.92);
    border: 1px solid rgba(102, 126, 234, 0.4);
    border-radius: 8px;
    padding: 16px 24px;
    backdrop-filter: blur(10px);
    min-width: 400px;
  }
  .lt-top { display: flex; align-items: center; gap: 12px; }
  .lt-number {
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: white; font-weight: 700; font-size: 24px;
    padding: 4px 12px; border-radius: 6px;
  }
  .lt-number::before { content: '#'; opacity: 0.6; font-size: 16px; }
  .lt-title { font-size: 22px; font-weight: 700; color: #e0e0f0; }
  .lt-dancers { font-size: 14px; color: #a5b4fc; margin-top: 4px; }
  .lt-meta { font-size: 12px; color: #9090b0; margin-top: 6px; }
</style>
</head>
<body>
<div class="lower-third" id="lt">
  <div class="lt-card">
    <div class="lt-top">
      <div class="lt-number" id="ltNumber"></div>
      <div>
        <div class="lt-title" id="ltTitle"></div>
        <div class="lt-dancers" id="ltDancers"></div>
      </div>
    </div>
    <div class="lt-meta" id="ltMeta"></div>
  </div>
</div>
<script>
  async function poll() {
    try {
      const res = await fetch('/current');
      const data = await res.json();
      const el = document.getElementById('lt');
      document.getElementById('ltNumber').textContent = data.entryNumber;
      document.getElementById('ltTitle').textContent = data.routineName;
      document.getElementById('ltDancers').textContent = data.dancers.join(', ');
      document.getElementById('ltMeta').textContent = data.studioName + ' — ' + data.category;
      if (data.visible) { el.classList.add('visible'); } else { el.classList.remove('visible'); }
    } catch {}
    setTimeout(poll, 500);
  }
  poll();
</script>
</body>
</html>`

export function startServer(): void {
  if (server) return

  const app = express()
  app.use(express.json())

  app.get('/current', (_req, res) => {
    res.json(currentData)
  })

  app.get('/overlay', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(overlayHTML)
  })

  // API to update from external sources
  app.post('/update', (req, res) => {
    currentData = { ...currentData, ...req.body }
    res.json({ ok: true })
  })

  server = app.listen(PORT, () => {
    logger.app.info(`Lower third server running on http://localhost:${PORT}`)
  })

  server.on('error', (err) => {
    logger.app.error('Lower third server error:', err)
  })
}

export function stopServer(): void {
  if (server) {
    server.close()
    server = null
    logger.app.info('Lower third server stopped')
  }
}

export function updateLowerThird(data: Partial<LowerThirdData>): void {
  currentData = { ...currentData, ...data }
  logger.app.debug('Lower third updated:', currentData.entryNumber, currentData.visible)
}

export function fire(): void {
  currentData.visible = true
  logger.app.info('Lower third fired')
}

export function hide(): void {
  currentData.visible = false
  logger.app.info('Lower third hidden')
}

let autoHideTimer: NodeJS.Timeout | null = null

export function fireWithAutoHide(seconds: number): void {
  fire()
  if (autoHideTimer) clearTimeout(autoHideTimer)
  if (seconds > 0) {
    autoHideTimer = setTimeout(() => {
      hide()
      autoHideTimer = null
    }, seconds * 1000)
  }
}
