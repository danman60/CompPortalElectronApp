import React, { useEffect, useState, useCallback } from 'react'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  DayChecklistShowEvent,
  DayChecklistItemState,
  DayChecklistDayState,
} from '../../shared/types'
import '../styles/day-checklist.css'

/**
 * Start-of-Day checklist modal. Fires automatically when the app launches and
 * the next pending routine is the FIRST routine of its scheduledDay (see
 * dayChecklist.maybeFireStartOfDay in main). Also re-openable from Settings.
 *
 * Visual language matches ClockSyncReminder (big, amber, dismissable). Each
 * item has tri-state: checked / skipped / N-A. State persists per-day in
 * compsync-day-checklist.json.
 */

interface ChecklistItem {
  id: string
  label: string
}

const ITEMS: ChecklistItem[] = [
  { id: 'stream-live', label: 'Start the live stream (OBS) ~half hour to show' },
  { id: 'tvs-on', label: 'TVs on and pointed to pages' },
  { id: 'cameras', label: 'Set up cameras' },
  { id: 'streamdeck', label: 'Stream Deck app running' },
  { id: 'judge-backup', label: 'Judge backup audio recording' },
]

type RenderAPI = {
  dayChecklistGet: (date: string, kind: 'start' | 'end') => Promise<DayChecklistDayState>
  dayChecklistSetItem: (date: string, kind: 'start' | 'end', itemId: string, value: DayChecklistItemState) => Promise<DayChecklistDayState>
  dayChecklistDismiss: (date: string, kind: 'start' | 'end') => Promise<DayChecklistDayState>
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
}

function getApi(): RenderAPI | null {
  const w = window as unknown as { api?: RenderAPI }
  return w.api ?? null
}

export default function StartOfDayModal(): React.ReactElement | null {
  const [visible, setVisible] = useState(false)
  const [date, setDate] = useState<string>('')
  const [scheduledDay, setScheduledDay] = useState<string | null>(null)
  const [itemStates, setItemStates] = useState<Record<string, DayChecklistItemState>>({})

  // Listen for SHOW broadcasts from main.
  useEffect(() => {
    const api = getApi()
    if (!api) return
    const off = api.on(IPC_CHANNELS.DAY_CHECKLIST_SHOW, (evUnknown: unknown) => {
      const ev = evUnknown as DayChecklistShowEvent
      if (!ev || ev.kind !== 'start') return
      setDate(ev.date)
      setScheduledDay(ev.scheduledDay)
      api.dayChecklistGet(ev.date, 'start').then((d) => {
        setItemStates(d.items || {})
      }).catch(() => {})
      setVisible(true)
    })
    return () => { try { off() } catch {} }
  }, [])

  const cycleState = useCallback((itemId: string): void => {
    const api = getApi()
    if (!api || !date) return
    const cur = itemStates[itemId] || 'open'
    const next: DayChecklistItemState =
      cur === 'open' ? 'checked' :
      cur === 'checked' ? 'skipped' :
      cur === 'skipped' ? 'na' :
      'open'
    setItemStates((s) => ({ ...s, [itemId]: next }))
    api.dayChecklistSetItem(date, 'start', itemId, next).catch(() => {})
  }, [date, itemStates])

  const setExplicit = useCallback((itemId: string, v: DayChecklistItemState): void => {
    const api = getApi()
    if (!api || !date) return
    const cur = itemStates[itemId] || 'open'
    const next: DayChecklistItemState = cur === v ? 'open' : v
    setItemStates((s) => ({ ...s, [itemId]: next }))
    api.dayChecklistSetItem(date, 'start', itemId, next).catch(() => {})
  }, [date, itemStates])

  const dismiss = useCallback((): void => {
    const api = getApi()
    if (api && date) {
      api.dayChecklistDismiss(date, 'start').catch(() => {})
    }
    setVisible(false)
  }, [date])

  if (!visible) return null

  const totalItems = ITEMS.length
  const checkedCount = ITEMS.filter((i) => itemStates[i.id] === 'checked').length
  const skippedCount = ITEMS.filter((i) => itemStates[i.id] === 'skipped').length
  const naCount = ITEMS.filter((i) => itemStates[i.id] === 'na').length
  const openCount = totalItems - checkedCount - skippedCount - naCount

  return (
    <div className="daychk-overlay">
      <div className="daychk-modal">
        <div className="daychk-header">
          <span className="daychk-icon">{'\u2600'}{'\uFE0F'}</span>
          <div className="daychk-title">Start-of-Day Checklist</div>
        </div>
        <div className="daychk-subtitle">
          Run through this before the first routine{scheduledDay ? ` of ${scheduledDay}` : ''}.
          Tap a state button to mark. Modal is dismissable — items stay saved.
        </div>

        <div className="daychk-list">
          {ITEMS.map((item) => {
            const s = itemStates[item.id] || 'open'
            const klass = `daychk-item ${s === 'checked' ? 'checked' : s === 'skipped' ? 'skipped' : s === 'na' ? 'na' : ''}`
            return (
              <div key={item.id} className={klass}>
                <div>
                  <div className="daychk-item-label" onClick={() => cycleState(item.id)} style={{ cursor: 'pointer' }}>
                    {item.label}
                  </div>
                </div>
                <div className="daychk-state-btns">
                  <button
                    className={`daychk-state-btn ${s === 'checked' ? 'active checked' : ''}`}
                    onClick={() => setExplicit(item.id, 'checked')}
                    title="Mark done"
                  >
                    {'\u2713'} Done
                  </button>
                  <button
                    className={`daychk-state-btn ${s === 'skipped' ? 'active skipped' : ''}`}
                    onClick={() => setExplicit(item.id, 'skipped')}
                    title="Skip for today"
                  >
                    Skip
                  </button>
                  <button
                    className={`daychk-state-btn ${s === 'na' ? 'active na' : ''}`}
                    onClick={() => setExplicit(item.id, 'na')}
                    title="Not applicable"
                  >
                    N/A
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="daychk-progress">
          <span><strong>{checkedCount}</strong> done</span>
          <span><strong>{skippedCount}</strong> skipped</span>
          <span><strong>{naCount}</strong> N/A</span>
          <span><strong>{openCount}</strong> open</span>
        </div>

        <div className="daychk-actions">
          <button className="daychk-btn primary" onClick={dismiss}>
            Dismiss — ready to start
          </button>
        </div>
      </div>
    </div>
  )
}
