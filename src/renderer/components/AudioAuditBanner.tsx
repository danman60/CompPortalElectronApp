import React, { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  AudioIdenticalTracksEvent,
  AudioSilenceDetectedEvent,
  AudioLowLoudnessEvent,
  AudioAuditPassEvent,
} from '../../shared/types'

interface AudioLowBitrateEvent {
  routineId: string
  entryNumber: string
  role: string
  kbps: number
  thresholdKbps: number
}

/**
 * A53 / A55 — post-encode audio audit findings.
 *
 * 2026-04-29: rewritten from the floating right-rail stack to a single
 * top-banner-per-routine. Operator feedback: stack was too aggressive (one
 * 25s recording produced 9 banners). Now consolidates per routine with a
 * "Dismiss" per banner and "Dismiss all" when 2+ routines have findings.
 *
 * Pass events still render as a small auto-fading green toast (~10s).
 *
 * NO re-record button — explicitly hallucinated and rejected.
 */

interface RoutineFindings {
  routineId: string
  entryNumber: string
  identicalPairs: Array<[string, string]>
  silentRoles: Array<{ role: string; silentFraction: number; noiseFloorDb: number }>
  lowLoudnessRoles: Array<{ role: string; meanRmsDb: number; thresholdDb: number }>
  lowBitrateRoles: Array<{ role: string; kbps: number; thresholdKbps: number }>
}

function summarize(f: RoutineFindings): string {
  const parts: string[] = []
  if (f.identicalPairs.length > 0) {
    const pairList = f.identicalPairs.map(([a, b]) => `${a}=${b}`).join(', ')
    parts.push(`identical tracks: ${pairList}`)
  }
  if (f.silentRoles.length > 0) {
    const roles = f.silentRoles.map((s) => s.role).join(', ')
    parts.push(`silent: ${roles}`)
  }
  if (f.lowLoudnessRoles.length > 0) {
    const roles = f.lowLoudnessRoles.map((l) => `${l.role}(${l.meanRmsDb.toFixed(0)}dB)`).join(', ')
    parts.push(`low: ${roles}`)
  }
  if (f.lowBitrateRoles.length > 0) {
    const roles = f.lowBitrateRoles.map((b) => `${b.role}(${b.kbps}kbps)`).join(', ')
    parts.push(`broken stream: ${roles}`)
  }
  return parts.join(' · ')
}

export default function AudioAuditBanner(): React.ReactElement | null {
  const [byRoutine, setByRoutine] = useState<Map<string, RoutineFindings>>(new Map())
  const [pass, setPass] = useState<AudioAuditPassEvent | null>(null)
  const [passFading, setPassFading] = useState(false)
  const [expandedRoutineId, setExpandedRoutineId] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api) return

    function ensure(id: string, entry: string): RoutineFindings {
      let cur = byRoutine.get(id)
      if (!cur) {
        cur = { routineId: id, entryNumber: entry, identicalPairs: [], silentRoles: [], lowLoudnessRoles: [], lowBitrateRoles: [] }
      }
      return cur
    }

    const offId = window.api.on(IPC_CHANNELS.AUDIO_IDENTICAL_TRACKS_DETECTED, (data: unknown) => {
      const ev = data as AudioIdenticalTracksEvent
      setByRoutine((prev) => {
        const next = new Map(prev)
        const cur = next.get(ev.routineId) ?? ensure(ev.routineId, ev.entryNumber)
        cur.identicalPairs = ev.matchedPairs
        next.set(ev.routineId, { ...cur })
        return next
      })
    })
    const offSil = window.api.on(IPC_CHANNELS.AUDIO_SILENCE_DETECTED, (data: unknown) => {
      const ev = data as AudioSilenceDetectedEvent
      setByRoutine((prev) => {
        const next = new Map(prev)
        const cur = next.get(ev.routineId) ?? ensure(ev.routineId, ev.entryNumber)
        // Replace per role to dedup re-fires.
        cur.silentRoles = [
          ...cur.silentRoles.filter((s) => s.role !== ev.role),
          { role: ev.role, silentFraction: ev.silentFraction, noiseFloorDb: ev.noiseFloorDb },
        ]
        next.set(ev.routineId, { ...cur })
        return next
      })
    })
    const offLoud = window.api.on(IPC_CHANNELS.AUDIO_LOW_LOUDNESS_DETECTED, (data: unknown) => {
      const ev = data as AudioLowLoudnessEvent
      setByRoutine((prev) => {
        const next = new Map(prev)
        const cur = next.get(ev.routineId) ?? ensure(ev.routineId, ev.entryNumber)
        cur.lowLoudnessRoles = [
          ...cur.lowLoudnessRoles.filter((l) => l.role !== ev.role),
          { role: ev.role, meanRmsDb: ev.meanRmsDb, thresholdDb: ev.thresholdDb },
        ]
        next.set(ev.routineId, { ...cur })
        return next
      })
    })
    const offBitrate = window.api.on(IPC_CHANNELS.AUDIO_LOW_BITRATE_DETECTED, (data: unknown) => {
      const ev = data as AudioLowBitrateEvent
      setByRoutine((prev) => {
        const next = new Map(prev)
        const cur = next.get(ev.routineId) ?? ensure(ev.routineId, ev.entryNumber)
        cur.lowBitrateRoles = [
          ...cur.lowBitrateRoles.filter((b) => b.role !== ev.role),
          { role: ev.role, kbps: ev.kbps, thresholdKbps: ev.thresholdKbps },
        ]
        next.set(ev.routineId, { ...cur })
        return next
      })
    })
    const offPass = window.api.on(IPC_CHANNELS.AUDIO_AUDIT_PASS, (data: unknown) => {
      setPass(data as AudioAuditPassEvent)
      setPassFading(false)
    })
    return () => { try { offId() } catch {}; try { offSil() } catch {}; try { offLoud() } catch {}; try { offBitrate() } catch {}; try { offPass() } catch {} }
  // intentionally not depending on byRoutine; ensure() reads via setState callback
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pass toast auto-fade.
  useEffect(() => {
    if (!pass) return
    const t = setTimeout(() => setPassFading(true), 9700)
    const t2 = setTimeout(() => setPass(null), 10000)
    return () => { clearTimeout(t); clearTimeout(t2) }
  }, [pass])

  function dismissOne(id: string): void {
    setByRoutine((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    if (expandedRoutineId === id) setExpandedRoutineId(null)
  }

  function dismissAll(): void {
    setByRoutine(new Map())
    setExpandedRoutineId(null)
  }

  const findings = Array.from(byRoutine.values()).sort((a, b) => {
    const an = parseFloat(a.entryNumber)
    const bn = parseFloat(b.entryNumber)
    if (!isNaN(an) && !isNaN(bn)) return an - bn
    return a.entryNumber.localeCompare(b.entryNumber)
  })

  if (findings.length === 0 && !pass) return null

  return (
    <>
      {/* Top-banner stack consistent with HardeningBanners (top:0, full width). */}
      {findings.length > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998, display: 'flex', flexDirection: 'column' }}>
          {findings.length > 1 && (
            <div
              style={{
                background: '#3a2810',
                color: '#ffd38a',
                padding: '4px 12px',
                fontSize: 11,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid rgba(0,0,0,0.4)',
              }}
            >
              <span>{findings.length} routines flagged for audio review</span>
              <button
                type="button"
                onClick={dismissAll}
                style={{
                  background: 'transparent',
                  border: '1px solid #c17f00',
                  color: '#ffd38a',
                  padding: '2px 10px',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >Dismiss all</button>
            </div>
          )}
          {findings.map((f) => {
            const expanded = expandedRoutineId === f.routineId
            const summary = summarize(f)
            return (
              <div
                key={f.routineId}
                style={{
                  background: '#c17f00',
                  color: '#fff',
                  padding: '6px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 8,
                  borderBottom: '1px solid rgba(0,0,0,0.3)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <span style={{ fontWeight: 700 }}>R{f.entryNumber}</span> audio audit — {summary}
                  </div>
                  {expanded && (
                    <div style={{ fontSize: 11, fontWeight: 400, marginTop: 4, opacity: 0.95 }}>
                      {f.identicalPairs.length > 0 && (
                        <div>Identical hashes: {f.identicalPairs.map(([a, b]) => `${a}=${b}`).join(', ')} (likely ASIO rebind / routing collision)</div>
                      )}
                      {f.silentRoles.map((s) => (
                        <div key={'s-' + s.role}>{s.role}: {(s.silentFraction * 100).toFixed(0)}% below {s.noiseFloorDb} dB — verify mic / source</div>
                      ))}
                      {f.lowLoudnessRoles.map((l) => (
                        <div key={'l-' + l.role}>{l.role}: mean {l.meanRmsDb.toFixed(1)} dBFS &lt; {l.thresholdDb} dBFS — verify mic input</div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setExpandedRoutineId(expanded ? null : f.routineId)}
                    style={{
                      background: 'transparent',
                      border: '1px solid rgba(255,255,255,0.6)',
                      color: '#fff',
                      padding: '2px 10px',
                      borderRadius: 3,
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >{expanded ? 'Hide' : 'Details'}</button>
                  <button
                    type="button"
                    onClick={() => dismissOne(f.routineId)}
                    aria-label="Dismiss"
                    style={{
                      background: 'transparent',
                      border: '1px solid rgba(255,255,255,0.6)',
                      color: '#fff',
                      padding: '2px 8px',
                      borderRadius: 3,
                      cursor: 'pointer',
                      fontSize: 14,
                      lineHeight: 1,
                    }}
                  >×</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {pass && (
        <div
          style={{
            position: 'fixed',
            bottom: 80,
            right: 16,
            zIndex: 9997,
            background: '#0c2515',
            border: '1px solid #2da855',
            borderLeft: '4px solid #2da855',
            borderRadius: 6,
            padding: '8px 12px',
            color: '#a8e8c0',
            fontSize: 11,
            fontWeight: 600,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            opacity: passFading ? 0 : 1,
            transition: 'opacity 0.3s',
            cursor: 'pointer',
          }}
          onClick={() => { setPassFading(true); setTimeout(() => setPass(null), 300) }}
          title="Click to dismiss"
        >
          R{pass.entryNumber} audio scan ✓ — {pass.trackCount} tracks captured, all distinct, all audible
        </div>
      )}
    </>
  )
}
