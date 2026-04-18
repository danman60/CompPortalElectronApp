import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { IPC_CHANNELS } from '../../shared/types'
import '../styles/clock-sync-reminder.css'

/**
 * Front-and-center reminder for the operator to match every camera's clock to
 * the system clock before shooting. UDC London 2026 Day 1: Cam 2 ran 15 days
 * ahead, 171 photos unrecoverable. A passive footer indicator gets ignored —
 * this nudges a full modal that's always dismissible.
 *
 * Trigger rules:
 *   1. On app start (every launch). The modal appears once after the component
 *      mounts, regardless of prior dismissals.
 *   2. Re-trigger after 10 minutes of no recording activity OR import activity.
 *      Activity = OBS.isRecording transitioning, photo import progress event,
 *      tether photo progress event. Whenever any of those fire, the idle timer
 *      resets.
 *
 * The modal does NOT block the app — dismiss closes it, the operator keeps
 * working. The live-updating clock (seconds-precision) is the load-bearing UI.
 */

const IDLE_RETRIGGER_MS = 10 * 60 * 1000 // 10 minutes

function formatClock(d: Date): { date: string; time: string } {
  const dateStr = d.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const pad = (n: number): string => String(n).padStart(2, '0')
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return { date: dateStr, time: timeStr }
}

export default function ClockSyncReminder(): React.ReactElement | null {
  const [visible, setVisible] = useState(true) // always show on mount (startup)
  const [now, setNow] = useState<Date>(new Date())
  const lastActivityRef = useRef<number>(Date.now())
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const obsRecording = useStore((s) => s.obsState.isRecording)
  const prevRecordingRef = useRef<boolean>(obsRecording)

  // Live clock — 250ms refresh so seconds never look stuck
  useEffect(() => {
    if (!visible) return
    const id = setInterval(() => setNow(new Date()), 250)
    return () => clearInterval(id)
  }, [visible])

  // Activity signal: OBS recording start or stop
  useEffect(() => {
    if (prevRecordingRef.current !== obsRecording) {
      lastActivityRef.current = Date.now()
      prevRecordingRef.current = obsRecording
    }
  }, [obsRecording])

  // Activity signal: import events + tether events
  useEffect(() => {
    if (!window.api) return
    const offs: Array<() => void> = []
    const markActive = (): void => { lastActivityRef.current = Date.now() }
    offs.push(window.api.on(IPC_CHANNELS.PHOTOS_PROGRESS, markActive))
    offs.push(window.api.on(IPC_CHANNELS.PHOTOS_MATCH_RESULT, markActive))
    offs.push(window.api.on(IPC_CHANNELS.PHOTOS_IMPORT_COMPLETE_SUMMARY, markActive))
    offs.push(window.api.on(IPC_CHANNELS.TETHER_PROGRESS, markActive))
    offs.push(window.api.on(IPC_CHANNELS.DRIVE_DETECTED, markActive))
    return () => {
      for (const off of offs) {
        try { off() } catch {}
      }
    }
  }, [])

  // Idle watchdog: every 30s, if >10 min since last activity AND no active
  // recording AND the modal is currently hidden, re-surface it.
  useEffect(() => {
    idleTimerRef.current = setInterval(() => {
      if (visible) return
      if (obsRecording) {
        // Active recording counts as activity — bump the timestamp + skip.
        lastActivityRef.current = Date.now()
        return
      }
      const elapsed = Date.now() - lastActivityRef.current
      if (elapsed >= IDLE_RETRIGGER_MS) {
        setVisible(true)
      }
    }, 30000)
    return () => {
      if (idleTimerRef.current) {
        clearInterval(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }
  }, [visible, obsRecording])

  if (!visible) return null

  const { date, time } = formatClock(now)

  return (
    <div className="clock-sync-overlay">
      <div className="clock-sync-modal">
        <div className="clock-sync-header">
          <span className="clock-sync-icon">{'\u23F0'}</span>
          <div className="clock-sync-title">Camera Clock Check</div>
        </div>
        <div className="clock-sync-instruction">
          Match every camera's clock to this time before shooting.
        </div>
        <div className="clock-sync-clockbox">
          <div className="clock-sync-date">{date}</div>
          <div className="clock-sync-time">{time}</div>
        </div>
        <div className="clock-sync-hint">
          If a camera's clock is off, photos will not match their recordings.
          This reminder re-appears after 10 minutes of inactivity to catch
          battery-swap clock resets and mid-day camera changes.
        </div>
        <div className="clock-sync-actions">
          <button
            className="clock-sync-btn primary"
            onClick={() => {
              lastActivityRef.current = Date.now()
              setVisible(false)
            }}
          >
            Acknowledged — all cameras match
          </button>
        </div>
      </div>
    </div>
  )
}
