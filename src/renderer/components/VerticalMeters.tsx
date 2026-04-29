import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { IPC_CHANNELS } from '../../shared/types'
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
  // Track per-role contiguous silent-since timestamps. When a role has been
  // silent (peak ≤ ~-60 dBFS) for >5s, mark it flat → bar glows red.
  // This is local-only to the renderer; the main-process detector emits a
  // separate IPC alert and a top-of-app banner. No coupling required.
  const silentSinceRef = useRef<Map<string, number>>(new Map())
  const [flatRoles, setFlatRoles] = useState<Set<string>>(new Set())
  const wsRef = useRef<WebSocket | null>(null)
  const debugMeters = window.location.search.includes('debugMeters=1')

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect(): void {
      if (cancelled) return
      try {
        const ws = new WebSocket('ws://localhost:9877')
        wsRef.current = ws

        ws.onopen = () => {
          if (debugMeters) console.error('[VM-WS] open, sending identify')
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
              if (debugMeters && (msgCount <= 3 || msgCount % 50 === 0)) {
                console.error(`[VM-WS #${msgCount}] audioLevels received, roles=${Object.keys(next).join(',')} peaks=${JSON.stringify(next)}`)
              }
              setPeaks(next)
              // Update silent-since per role and recompute flat set.
              const now = Date.now()
              const since = silentSinceRef.current
              const SILENT_THRESH = 0.001
              const FLAT_MS = 5000
              const newFlat = new Set<string>()
              for (const role of Object.keys(next)) {
                if (next[role] <= SILENT_THRESH) {
                  if (!since.has(role)) since.set(role, now)
                  if (now - (since.get(role) ?? now) > FLAT_MS) newFlat.add(role)
                } else {
                  since.delete(role)
                }
              }
              setFlatRoles((prev) => {
                if (prev.size === newFlat.size && [...prev].every((r) => newFlat.has(r))) return prev
                return newFlat
              })
            } else if (debugMeters && msgCount === 0 && msg && msg.type) {
              console.error(`[VM-WS] first non-audio msg type=${msg.type}`)
            }
          } catch (e) {
            if (debugMeters) console.error(`[VM-WS] parse error: ${e instanceof Error ? e.message : e}`)
          }
        }

        ws.onerror = () => { if (debugMeters) console.error('[VM-WS] ws error'); try { ws.close() } catch {} }

        ws.onclose = () => {
          if (debugMeters) console.error('[VM-WS] closed')
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
    { label: 'P', role: 'performance', dB: peakToDb(peaks['performance'] ?? 0) },
    ...Array.from({ length: judgeCount }, (_, i) => ({
      label: `J${i + 1}`,
      role: `judge${i + 1}`,
      dB: peakToDb(peaks[`judge${i + 1}`] ?? 0),
    })),
  ]

  return (
    <div className="v-meters">
      {tracks.map((track) => {
        const isFlat = flatRoles.has(track.role)
        return (
          <div className={`v-meter${isFlat ? ' flat-alert' : ''}`} key={track.label}>
            <div className="v-meter-track">
              <div
                className={`v-meter-fill ${dBToClass(track.dB)}`}
                style={{ height: `${dBToPercent(track.dB)}%` }}
              />
            </div>
            <span className="v-meter-label">{track.label}</span>
          </div>
        )
      })}
    </div>
  )
}
