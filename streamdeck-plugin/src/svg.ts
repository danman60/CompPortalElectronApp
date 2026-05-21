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

export function nextFullAlert(entryNumber: string | null): string {
  const num = entryNumber || '—'
  const display = `#${num}`
  const fs = entryFontSize(display, 64)
  return wrap(`
    <text x="72" y="34" text-anchor="middle" fill="#ffffff" font-size="20" font-weight="900" font-family="sans-serif" letter-spacing="2">NEXT ⏩</text>
    <text x="72" y="96" text-anchor="middle" fill="#ffffff" font-size="${fs}" font-weight="900" font-family="sans-serif">${display}</text>
    <text x="72" y="128" text-anchor="middle" fill="#fff5b8" font-size="18" font-weight="900" font-family="sans-serif" letter-spacing="2">ADVANCE</text>
  `, '#b91c1c')
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

// Item 6: high-contrast variant used during the 2:20+ flash. Plugin alternates
// between this and the calm nextRoutine() image every 250ms while the active
// recording has been running \u2265 140s.
export function nextRoutineAlert(entryNumber: string | null): string {
  const num = entryNumber || '\u2014'
  const display = `#${num}`
  const fs = entryFontSize(display, 72)
  return wrap(`
    <text x="72" y="32" text-anchor="middle" fill="#ffffff" font-size="20" font-weight="900" font-family="sans-serif" letter-spacing="2.5">NEXT \u23e9</text>
    <text x="72" y="104" text-anchor="middle" fill="#ffffff" font-size="${fs}" font-weight="900" font-family="sans-serif">${display}</text>
    <text x="72" y="134" text-anchor="middle" fill="#fff5b8" font-size="14" font-weight="800" font-family="sans-serif" letter-spacing="1.5">ADVANCE</text>
  `, '#b91c1c')
}

// Item 7: cycle OBS transitions on press. Button face shows the current
// transition name (truncated) so operator knows what's loaded.
// Stinger transitions get a big glowing red border because firing one is
// destructive (auto-reverts after settle) \u2014 operator wants a hard visual
// cue so they don't accidentally leave the button on stinger.
export function cycleTransition(currentName: string | null): string {
  const safeName = (currentName ?? 'NONE').toUpperCase()
  const cropped = safeName.length > 9 ? safeName.slice(0, 8) + '\u2026' : safeName
  const fs = cropped.length <= 5 ? 28 : cropped.length <= 7 ? 22 : 18
  const isStinger = (currentName ?? '').toLowerCase().includes('stinger')

  if (isStinger) {
    // Custom wrap \u2014 red glow border + warmer body. Border rect inset 4px
    // so the stroke (8px) sits inside the 144px canvas without clipping.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <defs>
        <filter id="redGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3.5"/>
        </filter>
      </defs>
      <rect width="144" height="144" rx="12" fill="#2a0a0a"/>
      <rect x="4" y="4" width="136" height="136" rx="10" fill="none" stroke="#ef4444" stroke-width="8" filter="url(#redGlow)" opacity="0.9">
        <animate attributeName="opacity" values="0.6;1;0.6" dur="1.4s" repeatCount="indefinite"/>
      </rect>
      <rect x="4" y="4" width="136" height="136" rx="10" fill="none" stroke="#ff6b6b" stroke-width="3"/>
      <text x="72" y="32" text-anchor="middle" fill="#ff8a8a" font-size="18" font-weight="800" font-family="sans-serif" letter-spacing="2.5">CYCLE</text>
      <text x="72" y="62" text-anchor="middle" fill="#ffb0b0" font-size="14" font-weight="700" font-family="sans-serif" letter-spacing="1.5">TRANSITION</text>
      <text x="72" y="100" text-anchor="middle" fill="#ffffff" font-size="${fs}" font-weight="900" font-family="sans-serif">${cropped}</text>
      <text x="72" y="128" text-anchor="middle" fill="#ff6b6b" font-size="22" font-weight="900" font-family="sans-serif">\u26a0</text>
    </svg>`
  }

  return wrap(`
    <text x="72" y="32" text-anchor="middle" fill="#a5b4fc" font-size="18" font-weight="800" font-family="sans-serif" letter-spacing="2.5">CYCLE</text>
    <text x="72" y="62" text-anchor="middle" fill="#9090b0" font-size="14" font-weight="700" font-family="sans-serif" letter-spacing="1.5">TRANSITION</text>
    <text x="72" y="100" text-anchor="middle" fill="#ffffff" font-size="${fs}" font-weight="900" font-family="sans-serif">${cropped}</text>
    <text x="72" y="128" text-anchor="middle" fill="#667eea" font-size="22" font-weight="900" font-family="sans-serif">\u21bb</text>
  `, '#181826')
}

export function udcStinger(flash = false): string {
  const bg = flash ? '#3a0707' : '#2a0a0a'
  const stroke = flash ? '#ffffff' : '#ff6b6b'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <defs>
      <filter id="stingerGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="3.5"/>
      </filter>
    </defs>
    <rect width="144" height="144" rx="12" fill="${bg}"/>
    <rect x="4" y="4" width="136" height="136" rx="10" fill="none" stroke="#ef4444" stroke-width="8" filter="url(#stingerGlow)" opacity="${flash ? '1' : '0.82'}"/>
    <rect x="4" y="4" width="136" height="136" rx="10" fill="none" stroke="${stroke}" stroke-width="3"/>
    <text x="72" y="32" text-anchor="middle" fill="#ffb0b0" font-size="18" font-weight="900" font-family="sans-serif" letter-spacing="2.5">UDC</text>
    <text x="72" y="74" text-anchor="middle" fill="#ffffff" font-size="28" font-weight="900" font-family="sans-serif" letter-spacing="1.5">STINGER</text>
    <text x="72" y="106" text-anchor="middle" fill="#ff8a8a" font-size="15" font-weight="800" font-family="sans-serif" letter-spacing="1.5">SET TRANS</text>
    <text x="72" y="130" text-anchor="middle" fill="#ff6b6b" font-size="19" font-weight="900" font-family="sans-serif">AUTO CUT</text>
  </svg>`
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

// Starting Soon — dedicated multi-line label so operator sees full name on the key.
export function startingSoonToggle(active: boolean): string {
  const color = active ? '#22c55e' : '#888'
  const labelColor = active ? '#ffffff' : '#aaa'
  const bg = active ? '#0d1f0d' : '#1e1e2e'
  const status = active ? 'ON' : 'OFF'
  const statusColor = active ? '#22c55e' : '#666'
  return wrap(`
    <text x="72" y="44" text-anchor="middle" fill="${labelColor}" font-size="22" font-weight="900" font-family="sans-serif" letter-spacing="2">STARTING</text>
    <text x="72" y="74" text-anchor="middle" fill="${labelColor}" font-size="22" font-weight="900" font-family="sans-serif" letter-spacing="2">SOON</text>
    <circle cx="60" cy="112" r="9" fill="${color}"/>
    <text x="80" y="120" text-anchor="start" fill="${statusColor}" font-size="24" font-weight="900" font-family="sans-serif" letter-spacing="2">${status}</text>
  `, bg)
}

// Unified meter — N vertical columns side-by-side on a single button.
// `entries` = [{label, peak (0..1)}]. Color-graded: green / amber / red.
export function unifiedMeter(entries: Array<{ label: string; peak: number }>): string {
  if (entries.length === 0) return wrap('', '#0d0d14')
  const N = entries.length
  const SIDE_PAD = 8
  const COL_GAP = 4
  const LABEL_Y = 14
  const LABEL_H = 18
  const BAR_TOP = LABEL_H + 4
  const BAR_BOTTOM = 138
  const BAR_H = BAR_BOTTOM - BAR_TOP
  const totalGapW = (N - 1) * COL_GAP
  const colW = (144 - 2 * SIDE_PAD - totalGapW) / N

  function fillFor(ratio: number): string {
    if (ratio < 0.55) return '#22c55e'
    if (ratio < 0.85) return '#f59e0b'
    return '#ef4444'
  }

  let parts = ''
  for (let i = 0; i < N; i++) {
    const { label, peak } = entries[i]
    const clamped = Math.max(0, Math.min(1, peak))
    const x = SIDE_PAD + i * (colW + COL_GAP)
    // Label
    parts += `<text x="${x + colW / 2}" y="${LABEL_Y}" text-anchor="middle" fill="#cbd5e1" font-size="13" font-weight="800" font-family="sans-serif" letter-spacing="1">${label}</text>`
    // Track (background)
    parts += `<rect x="${x}" y="${BAR_TOP}" width="${colW}" height="${BAR_H}" fill="#1a1a24" opacity="0.85" rx="2"/>`
    // Filled portion (grows from bottom up)
    const fillH = clamped * BAR_H
    const fillY = BAR_TOP + (BAR_H - fillH)
    parts += `<rect x="${x}" y="${fillY}" width="${colW}" height="${fillH}" fill="${fillFor(clamped)}" rx="2"/>`
    // Tick marks at -20dB (~0.67), -10dB (~0.83), 0dB (1.0) — visual reference
    for (const t of [0.55, 0.85]) {
      const tickY = BAR_TOP + (1 - t) * BAR_H
      parts += `<line x1="${x}" y1="${tickY}" x2="${x + colW}" y2="${tickY}" stroke="#0d0d14" stroke-width="1.5" opacity="0.6"/>`
    }
  }

  return wrap(parts, '#0d0d14')
}

// Slow zoom — magnifying glass with + (zoomed-in state) or - (zoomed-out state).
export function slowZoom(zoomedIn: boolean): string {
  const accent = zoomedIn ? '#fbbf24' : '#a5b4fc'
  const bg = zoomedIn ? '#1f1a0a' : '#1a1a2e'
  const sign = zoomedIn ? '+' : '−' // − minus
  return wrap(`
    <text x="72" y="34" text-anchor="middle" fill="${accent}" font-size="20" font-weight="700" font-family="sans-serif" letter-spacing="3">ZOOM</text>
    <circle cx="60" cy="78" r="26" fill="none" stroke="${accent}" stroke-width="6"/>
    <line x1="80" y1="98" x2="104" y2="122" stroke="${accent}" stroke-width="8" stroke-linecap="round"/>
    <text x="60" y="88" text-anchor="middle" fill="${accent}" font-size="36" font-weight="900" font-family="sans-serif">${sign}</text>
    <text x="72" y="138" text-anchor="middle" fill="#888" font-size="14" font-weight="600" font-family="sans-serif" letter-spacing="2">${zoomedIn ? 'IN' : 'OUT'}</text>
  `, bg)
}

export function slowZoomScene(label: string, zoomedIn: boolean): string {
  const accent = zoomedIn ? '#fbbf24' : '#a5b4fc'
  const bg = zoomedIn ? '#1f1a0a' : '#1a1a2e'
  const sign = zoomedIn ? '+' : '−'
  return wrap(`
    <text x="72" y="30" text-anchor="middle" fill="${accent}" font-size="16" font-weight="700" font-family="sans-serif" letter-spacing="3">${label}</text>
    <circle cx="60" cy="78" r="22" fill="none" stroke="${accent}" stroke-width="5"/>
    <line x1="76" y1="94" x2="100" y2="118" stroke="${accent}" stroke-width="7" stroke-linecap="round"/>
    <text x="60" y="86" text-anchor="middle" fill="${accent}" font-size="30" font-weight="900" font-family="sans-serif">${sign}</text>
    <text x="72" y="138" text-anchor="middle" fill="#888" font-size="13" font-weight="600" font-family="sans-serif" letter-spacing="2">${zoomedIn ? 'ZOOMED' : 'BASE'}</text>
  `, bg)
}

export function featureCard(mode: 'upNext' | 'thatWas', active: boolean): string {
  const accent = active ? '#fbbf24' : '#a5b4fc'
  const bg = active ? '#1f1a0a' : '#0f1024'
  const top = mode === 'upNext' ? 'UP NEXT' : 'THAT WAS'
  // Simple "page" icon: outer card, brand stripe, two text lines, dancers row
  return wrap(`
    <rect x="22" y="34" width="100" height="78" rx="6" fill="none" stroke="${accent}" stroke-width="4"/>
    <rect x="22" y="34" width="100" height="6" fill="${accent}"/>
    <text x="72" y="22" text-anchor="middle" fill="${accent}" font-size="14" font-weight="800" font-family="sans-serif" letter-spacing="3">${top}</text>
    <text x="72" y="68" text-anchor="middle" fill="${active ? '#fff7d6' : '#cbd5e1'}" font-size="22" font-weight="900" font-family="sans-serif">#42</text>
    <line x1="36" y1="80" x2="108" y2="80" stroke="${accent}" stroke-width="2" opacity="0.6"/>
    <line x1="36" y1="90" x2="108" y2="90" stroke="${accent}" stroke-width="2" opacity="0.4"/>
    <line x1="36" y1="100" x2="86" y2="100" stroke="${accent}" stroke-width="2" opacity="0.3"/>
    <text x="72" y="138" text-anchor="middle" fill="#888" font-size="13" font-weight="600" font-family="sans-serif" letter-spacing="2">${active ? 'LIVE' : 'FIRE'}</text>
  `, bg)
}
