// Stream Deck buttons render at 144x144. Stream Deck XL is 96x96 but the SDK
// rasterizes whatever we send — we always render at 144x144 and the SDK scales.
// Design rules: use ~70%+ of the canvas. Big labels (32-56px), big icons.
// Bottom 24px reserved for an optional caption / sublabel; everything else is hero.

function wrap(inner: string, bg = '#1e1e2e'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${bg}"/>
    ${inner}
  </svg>`
}

// Auto-shrink font for long entry numbers (e.g. "#1234" → smaller than "#42").
function entryFontSize(num: string, base: number): number {
  const len = num.length
  if (len <= 2) return base
  if (len === 3) return Math.round(base * 0.85)
  if (len === 4) return Math.round(base * 0.70)
  return Math.round(base * 0.60)
}

export function nextFull(entryNumber: string | null, connected: boolean): string {
  if (!connected) {
    return wrap(`<text x="72" y="84" text-anchor="middle" fill="#555" font-size="22" font-weight="bold" font-family="sans-serif">OFFLINE</text>`, '#111')
  }
  const num = entryNumber || '\u2014'
  const display = `#${num}`
  const fs = entryFontSize(display, 64)
  return wrap(`
    <text x="72" y="34" text-anchor="middle" fill="#a5b4fc" font-size="22" font-weight="700" font-family="sans-serif" letter-spacing="3">NEXT</text>
    <text x="72" y="96" text-anchor="middle" fill="#ffffff" font-size="${fs}" font-weight="900" font-family="sans-serif">${display}</text>
    <text x="72" y="128" text-anchor="middle" fill="#667eea" font-size="20" font-weight="700" font-family="sans-serif" letter-spacing="2">\u25B6 FULL</text>
  `, '#1a1a2e')
}

export function nextRoutine(entryNumber: string | null): string {
  const num = entryNumber || '\u2014'
  const display = `#${num}`
  const fs = entryFontSize(display, 72)
  return wrap(`
    <text x="72" y="32" text-anchor="middle" fill="#9090b0" font-size="20" font-weight="700" font-family="sans-serif" letter-spacing="2.5">CURRENT</text>
    <text x="72" y="104" text-anchor="middle" fill="#ffffff" font-size="${fs}" font-weight="900" font-family="sans-serif">${display}</text>
  `)
}

export function prev(entryNumber: string | null): string {
  const num = entryNumber || '\u2014'
  const display = `#${num}`
  const fs = entryFontSize(display, 56)
  return wrap(`
    <text x="72" y="34" text-anchor="middle" fill="#9090b0" font-size="20" font-weight="700" font-family="sans-serif" letter-spacing="2.5">PREV</text>
    <text x="72" y="100" text-anchor="middle" fill="#c0c0d0" font-size="${fs}" font-weight="700" font-family="sans-serif">${display}</text>
  `)
}

export function record(active: boolean, elapsed: number): string {
  if (active) {
    const mins = Math.floor(elapsed / 60)
    const secs = String(Math.floor(elapsed % 60)).padStart(2, '0')
    const time = `${mins}:${secs}`
    return wrap(`
      <circle cx="72" cy="50" r="26" fill="#ef4444">
        <animate attributeName="opacity" values="1;0.45;1" dur="1.4s" repeatCount="indefinite"/>
      </circle>
      <text x="72" y="118" text-anchor="middle" fill="#ffffff" font-size="38" font-weight="900" font-family="monospace">${time}</text>
    `, '#2a1010')
  }
  return wrap(`
    <circle cx="72" cy="58" r="32" fill="none" stroke="#888" stroke-width="4"/>
    <circle cx="72" cy="58" r="20" fill="#888"/>
    <text x="72" y="124" text-anchor="middle" fill="#ffffff" font-size="28" font-weight="900" font-family="sans-serif" letter-spacing="3">REC</text>
  `)
}

export function stream(active: boolean): string {
  if (active) {
    return wrap(`
      <text x="72" y="84" text-anchor="middle" fill="#ef4444" font-size="56" font-weight="900" font-family="sans-serif" letter-spacing="2">LIVE</text>
      <circle cx="72" cy="118" r="8" fill="#ef4444">
        <animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite"/>
      </circle>
    `, '#2a1010')
  }
  return wrap(`
    <text x="72" y="92" text-anchor="middle" fill="#666" font-size="48" font-weight="900" font-family="sans-serif" letter-spacing="2">OFF</text>
  `)
}

export function replay(flash: boolean): string {
  const color = flash ? '#22c55e' : '#888'
  const bg = flash ? '#0d1f0d' : '#1e1e2e'
  return wrap(`
    <text x="72" y="86" text-anchor="middle" fill="${color}" font-size="76" font-family="sans-serif">\u27F2</text>
    <text x="72" y="124" text-anchor="middle" fill="${color}" font-size="22" font-weight="800" font-family="sans-serif" letter-spacing="3">REPLAY</text>
  `, bg)
}

export function skip(count: number): string {
  return wrap(`
    <text x="72" y="80" text-anchor="middle" fill="#f59e0b" font-size="68" font-family="sans-serif">\u23ED</text>
    <text x="72" y="118" text-anchor="middle" fill="#ffffff" font-size="22" font-weight="800" font-family="sans-serif">${count}</text>
    <text x="72" y="136" text-anchor="middle" fill="#9090b0" font-size="13" font-weight="600" font-family="sans-serif" letter-spacing="1.5">SKIPPED</text>
  `)
}

// Audio meter — vertical bar grid that fills the button. Used by judge-meter
// action. `peak` is 0..1, `label` is "P" / "J1"-"J4" / "PERF" etc.
//
// 16 bars × 5px wide × 4px gap = 144 wide. Each bar = vertical column of
// 24 segments stacked from bottom; how many segments are lit is proportional
// to the smoothed peak. Smoothing is done by the caller via emaPeak.
export function judgeMeter(label: string, peak: number, color: string = '#22c55e'): string {
  const clamped = Math.max(0, Math.min(1, peak))
  const BAR_COUNT = 16
  const SEGMENTS = 24
  const BAR_W = 5
  const BAR_GAP = 3
  const totalBarsWidth = BAR_COUNT * BAR_W + (BAR_COUNT - 1) * BAR_GAP
  const startX = (144 - totalBarsWidth) / 2
  const SEG_H = 3
  const SEG_GAP = 1
  const totalH = SEGMENTS * SEG_H + (SEGMENTS - 1) * SEG_GAP // 95
  const startY = 16 // leaves room for label at top
  const labelY = 12

  // Color tiers — bottom green, middle amber, top red
  function segColor(segIdx: number): string {
    const ratio = segIdx / SEGMENTS
    if (ratio < 0.55) return '#22c55e'
    if (ratio < 0.85) return '#f59e0b'
    return '#ef4444'
  }

  let bars = ''
  for (let b = 0; b < BAR_COUNT; b++) {
    // Per-bar phase offset so neighboring bars don't move in lockstep visually.
    // We don't actually animate per-bar — we just stagger the threshold slightly
    // so the bar group looks more organic when the peak hits hard.
    const stagger = (Math.sin(b * 0.7) * 0.06)
    const localPeak = Math.max(0, Math.min(1, clamped + stagger))
    const litCount = Math.round(localPeak * SEGMENTS)
    const barX = startX + b * (BAR_W + BAR_GAP)
    for (let s = 0; s < SEGMENTS; s++) {
      // Segments stack from BOTTOM up
      const segY = startY + (SEGMENTS - 1 - s) * (SEG_H + SEG_GAP)
      const lit = s < litCount
      const fill = lit ? segColor(s) : '#1a1a24'
      const opacity = lit ? '1' : '0.5'
      bars += `<rect x="${barX}" y="${segY}" width="${BAR_W}" height="${SEG_H}" fill="${fill}" opacity="${opacity}" rx="0.5"/>`
    }
  }

  const isActive = clamped > 0.05
  const labelColor = isActive ? '#ffffff' : '#9090b0'
  const bg = isActive ? '#0d1f0d' : '#0f0f17'

  return wrap(`
    <text x="72" y="${labelY}" text-anchor="middle" fill="${labelColor}" font-size="12" font-weight="900" font-family="sans-serif" letter-spacing="2">${label}</text>
    ${bars}
  `, bg)
}

export function overlayToggle(label: string, active: boolean): string {
  const color = active ? '#22c55e' : '#666'
  const bg = active ? '#0d1f0d' : '#1e1e2e'
  // Bigger status dot, bigger label
  return wrap(`
    <circle cx="72" cy="50" r="22" fill="${color}"/>
    <text x="72" y="118" text-anchor="middle" fill="${active ? '#ffffff' : color}" font-size="36" font-weight="900" font-family="sans-serif" letter-spacing="2">${label}</text>
  `, bg)
}
