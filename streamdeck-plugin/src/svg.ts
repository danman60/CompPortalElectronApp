function wrap(inner: string, bg = '#1e1e2e'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${bg}"/>
    ${inner}
  </svg>`
}

export function nextFull(entryNumber: string | null, connected: boolean): string {
  if (!connected) {
    return wrap(`<text x="72" y="82" text-anchor="middle" fill="#555" font-size="16" font-family="sans-serif">OFFLINE</text>`, '#111')
  }
  const num = entryNumber || '\u2014'
  return wrap(`
    <text x="72" y="56" text-anchor="middle" fill="#667eea" font-size="14" font-family="sans-serif">NEXT</text>
    <text x="72" y="90" text-anchor="middle" fill="#e0e0f0" font-size="32" font-weight="bold" font-family="sans-serif">#${num}</text>
    <text x="72" y="116" text-anchor="middle" fill="#667eea" font-size="12" font-family="sans-serif">\u25B6 FULL</text>
  `, '#1a1a2e')
}

export function nextRoutine(entryNumber: string | null): string {
  const num = entryNumber || '\u2014'
  return wrap(`
    <text x="72" y="50" text-anchor="middle" fill="#9090b0" font-size="12" font-family="sans-serif">CURRENT</text>
    <text x="72" y="88" text-anchor="middle" fill="#e0e0f0" font-size="36" font-weight="bold" font-family="sans-serif">#${num}</text>
  `)
}

export function prev(entryNumber: string | null): string {
  const num = entryNumber || '\u2014'
  return wrap(`
    <text x="72" y="56" text-anchor="middle" fill="#9090b0" font-size="12" font-family="sans-serif">PREV</text>
    <text x="72" y="92" text-anchor="middle" fill="#c0c0d0" font-size="28" font-family="sans-serif">#${num}</text>
  `)
}

export function record(active: boolean, elapsed: number): string {
  if (active) {
    const mins = Math.floor(elapsed / 60)
    const secs = String(Math.floor(elapsed % 60)).padStart(2, '0')
    return wrap(`
      <circle cx="72" cy="52" r="12" fill="#ef4444"/>
      <text x="72" y="100" text-anchor="middle" fill="#ef4444" font-size="24" font-weight="bold" font-family="monospace">${mins}:${secs}</text>
    `, '#2a1a1a')
  }
  return wrap(`
    <circle cx="72" cy="60" r="16" fill="none" stroke="#666" stroke-width="2"/>
    <circle cx="72" cy="60" r="8" fill="#666"/>
    <text x="72" y="108" text-anchor="middle" fill="#888" font-size="16" font-family="sans-serif">REC</text>
  `)
}

export function stream(active: boolean): string {
  if (active) {
    return wrap(`
      <text x="72" y="80" text-anchor="middle" fill="#ef4444" font-size="28" font-weight="bold" font-family="sans-serif">LIVE</text>
      <circle cx="72" cy="108" r="4" fill="#ef4444"/>
    `, '#2a1a1a')
  }
  return wrap(`
    <text x="72" y="80" text-anchor="middle" fill="#666" font-size="24" font-family="sans-serif">OFF</text>
  `)
}

export function replay(flash: boolean): string {
  const color = flash ? '#22c55e' : '#888'
  return wrap(`
    <text x="72" y="80" text-anchor="middle" fill="${color}" font-size="32" font-family="sans-serif">\u27F2</text>
    <text x="72" y="112" text-anchor="middle" fill="${color}" font-size="12" font-family="sans-serif">REPLAY</text>
  `)
}

export function skip(count: number): string {
  return wrap(`
    <text x="72" y="72" text-anchor="middle" fill="#f59e0b" font-size="28" font-family="sans-serif">\u23ED</text>
    <text x="72" y="108" text-anchor="middle" fill="#9090b0" font-size="14" font-family="sans-serif">${count} skipped</text>
  `)
}

export function overlayToggle(label: string, active: boolean): string {
  const color = active ? '#22c55e' : '#666'
  const bg = active ? '#1a2a1a' : '#1e1e2e'
  return wrap(`
    <circle cx="72" cy="54" r="8" fill="${color}"/>
    <text x="72" y="100" text-anchor="middle" fill="${color}" font-size="16" font-weight="${active ? 'bold' : 'normal'}" font-family="sans-serif">${label}</text>
  `, bg)
}
