import React from 'react'
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

export default function VerticalMeters(): React.ReactElement {
  const meters = useStore((s) => s.audioMeters)
  const settings = useStore((s) => s.settings)
  const judgeCount = settings?.competition.judgeCount ?? 3

  const tracks = [
    { label: 'P', dB: meters.performance },
    ...Array.from({ length: judgeCount }, (_, i) => ({
      label: `J${i + 1}`,
      dB: meters.judges[i] ?? -Infinity,
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
