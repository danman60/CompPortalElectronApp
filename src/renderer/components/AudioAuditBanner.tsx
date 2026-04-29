import React, { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  AudioIdenticalTracksEvent,
  AudioSilenceDetectedEvent,
  AudioLowLoudnessEvent,
  AudioAuditPassEvent,
} from '../../shared/types'

/**
 * A53 / A55: post-encode audio audit findings + pass toast.
 *
 * Failures (identical tracks, excessive silence, low loudness) render as
 * persistent dismissable banners. Pass events render as a small toast
 * that auto-fades after 10s. NO re-record button — explicitly rejected
 * (operator decision 2026-04-28).
 */

type Finding =
  | { kind: 'identical'; id: string; ev: AudioIdenticalTracksEvent }
  | { kind: 'silence'; id: string; ev: AudioSilenceDetectedEvent }
  | { kind: 'loudness'; id: string; ev: AudioLowLoudnessEvent }

let findingSeq = 0

export default function AudioAuditBanner(): React.ReactElement | null {
  const [findings, setFindings] = useState<Finding[]>([])
  const [pass, setPass] = useState<AudioAuditPassEvent | null>(null)
  const [passFading, setPassFading] = useState(false)

  useEffect(() => {
    if (!window.api) return
    const offId = window.api.on(IPC_CHANNELS.AUDIO_IDENTICAL_TRACKS_DETECTED, (data: unknown) => {
      const ev = data as AudioIdenticalTracksEvent
      setFindings((prev) => [...prev, { kind: 'identical', id: `id-${++findingSeq}`, ev }])
    })
    const offSil = window.api.on(IPC_CHANNELS.AUDIO_SILENCE_DETECTED, (data: unknown) => {
      const ev = data as AudioSilenceDetectedEvent
      setFindings((prev) => [...prev, { kind: 'silence', id: `sil-${++findingSeq}`, ev }])
    })
    const offLoud = window.api.on(IPC_CHANNELS.AUDIO_LOW_LOUDNESS_DETECTED, (data: unknown) => {
      const ev = data as AudioLowLoudnessEvent
      setFindings((prev) => [...prev, { kind: 'loudness', id: `loud-${++findingSeq}`, ev }])
    })
    const offPass = window.api.on(IPC_CHANNELS.AUDIO_AUDIT_PASS, (data: unknown) => {
      setPass(data as AudioAuditPassEvent)
      setPassFading(false)
    })
    return () => { try { offId() } catch {}; try { offSil() } catch {}; try { offLoud() } catch {}; try { offPass() } catch {} }
  }, [])

  // Auto-fade pass toast after ~10s.
  useEffect(() => {
    if (!pass) return
    const t = setTimeout(() => setPassFading(true), 9700)
    const t2 = setTimeout(() => setPass(null), 10000)
    return () => { clearTimeout(t); clearTimeout(t2) }
  }, [pass])

  function dismiss(id: string): void {
    setFindings((prev) => prev.filter((f) => f.id !== id))
  }

  if (findings.length === 0 && !pass) return null

  return (
    <div style={{ position: 'fixed', top: 60, right: 16, zIndex: 9998, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 460 }}>
      {findings.map((f) => {
        let title = ''
        let detail = ''
        if (f.kind === 'identical') {
          const pairList = f.ev.matchedPairs.map(([a, b]) => `${a}=${b}`).join(', ')
          title = `R${f.ev.entryNumber} — audio tracks identical`
          detail = `${pairList}. Likely ASIO rebind or routing collision. Verify.`
        } else if (f.kind === 'silence') {
          title = `R${f.ev.entryNumber} — ${f.ev.role} mostly silent`
          detail = `${(f.ev.silentFraction * 100).toFixed(0)}% of duration below ${f.ev.noiseFloorDb} dB. Verify mic / source.`
        } else {
          title = `R${f.ev.entryNumber} — ${f.ev.role} audio low`
          detail = `Mean ${f.ev.meanRmsDb.toFixed(1)} dBFS < ${f.ev.thresholdDb} dBFS. Verify mic input.`
        }
        return (
          <div
            key={f.id}
            style={{
              background: '#2a1e08',
              border: '1px solid #c17f00',
              borderLeft: '4px solid #c17f00',
              borderRadius: 6,
              padding: '10px 14px',
              color: '#ffd38a',
              fontSize: 12,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>{title}</div>
              <div style={{ opacity: 0.9 }}>{detail}</div>
            </div>
            <button
              type="button"
              onClick={() => dismiss(f.id)}
              title="Dismiss"
              aria-label="Dismiss"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 18,
                lineHeight: 1,
                padding: 0,
                opacity: 0.7,
              }}
            >×</button>
          </div>
        )
      })}
      {pass && (
        <div
          style={{
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
    </div>
  )
}
