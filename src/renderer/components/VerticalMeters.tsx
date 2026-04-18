import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import '../styles/vertical-meters.css'

function dBToPercent(dB: number): number {
  if (dB <= -60) return 0
  if (dB >= 0) return 100
  return ((dB + 60) / 60) * 100
}

function dBToClass(dB: number): string {
  if (dB <= -60) return 'silent'
  if (dB > -6) return 'hot'
  if (dB > -12) return 'medium'
  return 'good'
}

function peakToDb(peak: number): number {
  if (peak <= 0) return -Infinity
  return 20 * Math.log10(peak)
}

// This component bypasses the app's IPC+store audio-level path entirely and
// connects directly to the WS hub (port 9877) as a "tablet"-type client.
// That's the same pipe the Android app uses — which works reliably, unlike
// the IPC path which has shown intermittent behavior. One less layer of
// indirection = far fewer places for updates to silently drop.
export default function VerticalMeters(): React.ReactElement {
  const settings = useStore((s) => s.settings)
  const judgeCount = settings?.competition.judgeCount ?? 3
  const [peaks, setPeaks] = useState<Record<string, number>>({})
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect(): void {
      if (cancelled) return
      try {
        const ws = new WebSocket('ws://localhost:9877')
        wsRef.current = ws

        ws.onopen = () => {
          console.error('[VM-WS] open, sending identify')
          try { ws.send(JSON.stringify({ type: 'identify', client: 'tablet' })) } catch {}
        }

        let msgCount = 0
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data)
            if (msg && msg.type === 'audioLevels' && Array.isArray(msg.levels)) {
              const next: Record<string, number> = {}
              for (const item of msg.levels) {
                if (item && typeof item.role === 'string' && typeof item.peak === 'number') {
                  next[item.role] = item.peak
                }
              }
              msgCount++
              if (msgCount <= 3 || msgCount % 50 === 0) {
                console.error(`[VM-WS #${msgCount}] audioLevels received, roles=${Object.keys(next).join(',')} peaks=${JSON.stringify(next)}`)
              }
              setPeaks(next)
            } else if (msgCount === 0 && msg && msg.type) {
              console.error(`[VM-WS] first non-audio msg type=${msg.type}`)
            }
          } catch (e) {
            console.error(`[VM-WS] parse error: ${e instanceof Error ? e.message : e}`)
          }
        }

        ws.onerror = () => { console.error('[VM-WS] ws error'); try { ws.close() } catch {} }

        ws.onclose = () => {
          console.error('[VM-WS] closed')
          wsRef.current = null
          if (!cancelled) {
            reconnectTimer = setTimeout(connect, 1000)
          }
        }
      } catch {
        if (!cancelled) reconnectTimer = setTimeout(connect, 1000)
      }
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { wsRef.current?.close() } catch {}
    }
  }, [])

  const tracks = [
    { label: 'P', dB: peakToDb(peaks['performance'] ?? 0) },
    ...Array.from({ length: judgeCount }, (_, i) => ({
      label: `J${i + 1}`,
      dB: peakToDb(peaks[`judge${i + 1}`] ?? 0),
    })),
  ]

  return (
    <div className="v-meters">
      {tracks.map((track) => (
        <div className="v-meter" key={track.label}>
          <div className="v-meter-track">
            <div
              className={`v-meter-fill ${dBToClass(track.dB)}`}
              style={{ height: `${dBToPercent(track.dB)}%` }}
            />
          </div>
          <span className="v-meter-label">{track.label}</span>
        </div>
      ))}
    </div>
  )
}
