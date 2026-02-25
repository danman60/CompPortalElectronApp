import React from 'react'
import { useStore } from '../store/useStore'
import '../styles/meters.css'

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

function formatDB(dB: number): string {
  if (dB <= -60) return '-inf'
  return `${Math.round(dB)} dB`
}

export default function AudioMeters(): React.ReactElement {
  const meters = useStore((s) => s.audioMeters)
  const settings = useStore((s) => s.settings)
  const judgeCount = settings?.competition.judgeCount ?? 3

  const tracks = [
    { label: 'Performance', dB: meters.performance },
    ...Array.from({ length: judgeCount }, (_, i) => ({
      label: `Judge ${i + 1}`,
      dB: meters.judges[i] ?? -Infinity,
    })),
  ]

  return (
    <div className="section">
      <div className="section-title">Audio Levels</div>
      <div className="audio-meters">
        {tracks.map((track) => (
          <React.Fragment key={track.label}>
            <span className="meter-label">{track.label}</span>
            <div className="meter-bar">
              <div
                className={`meter-fill ${dBToClass(track.dB)}`}
                style={{ width: `${dBToPercent(track.dB)}%` }}
              />
            </div>
            <span className="meter-db">{formatDB(track.dB)}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}
