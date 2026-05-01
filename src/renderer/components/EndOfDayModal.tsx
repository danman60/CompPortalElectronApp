import React, { useEffect, useState, useCallback } from 'react'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  DayChecklistShowEvent,
  DayChecklistItemState,
  DayChecklistDayState,
} from '../../shared/types'
import '../styles/day-checklist.css'

/**
 * End-of-Day checklist modal. Fires automatically after the LAST routine of
 * the day transitions to 'recorded' (see dayChecklist.maybeFireEndOfDay in
 * main). Also re-openable from Settings.
 *
 * Burlington UDC 2026-05-01 rewrite: CompSync stays OPEN overnight to finish
 * uploading — no "Close CompSync" step. Single flat ordered list (no sections),
 * no SD-in-Reader deadline escalation.
 */

interface ChecklistItem {
  id: string
  label: string
  detail?: string // optional sub-line displayed under label
}

/**
 * Hardcoded fallback for first-launch / IPC failure paths. Mirrors the
 * defaults in src/main/services/dayChecklistItems.ts — keep both in sync.
 */
const DEFAULT_ITEMS: ChecklistItem[] = [
  { id: 'awards-done', label: 'Wait for awards to finish' },
  { id: 'stream-off', label: 'Turn off stream' },
  { id: 'cameras-off', label: 'Turn off cameras' },
  { id: 'mevos-charging', label: 'Charge Mevos & power banks', detail: 'Verify blinking lights on BOTH power banks and Mevos' },
  { id: 'mevos-off', label: 'Turn off Mevos', detail: 'Press and hold back button until you hear the power-off sound' },
]

type RenderAPI = {
  dayChecklistGet: (date: string, kind: 'start' | 'end') => Promise<DayChecklistDayState>
  dayChecklistSetItem: (date: string, kind: 'start' | 'end', itemId: string, value: DayChecklistItemState) => Promise<DayChecklistDayState>
  dayChecklistDismiss: (date: string, kind: 'start' | 'end') => Promise<DayChecklistDayState>
  dayChecklistItemsGet?: () => Promise<{ start: ChecklistItem[]; end: ChecklistItem[] } | null>
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
}

function getApi(): RenderAPI | null {
  const w = window as unknown as { api?: RenderAPI }
  return w.api ?? null
}

export default function EndOfDayModal(): React.ReactElement | null {
  const [visible, setVisible] = useState(false)
  const [date, setDate] = useState<string>('')
  const [scheduledDay, setScheduledDay] = useState<string | null>(null)
  const [itemStates, setItemStates] = useState<Record<string, DayChecklistItemState>>({})
  const [items, setItems] = useState<ChecklistItem[]>(DEFAULT_ITEMS)

  // Listen for SHOW broadcasts.
  useEffect(() => {
    const api = getApi()
    if (!api) return
    const off = api.on(IPC_CHANNELS.DAY_CHECKLIST_SHOW, (evUnknown: unknown) => {
      const ev = evUnknown as DayChecklistShowEvent
      if (!ev || ev.kind !== 'end') return
      setDate(ev.date)
      setScheduledDay(ev.scheduledDay)
      // Re-fetch items each SHOW so CompPortal edits take effect on next reopen.
      if (api.dayChecklistItemsGet) {
        api.dayChecklistItemsGet().then((res) => {
          if (res && Array.isArray(res.end) && res.end.length > 0) {
            setItems(res.end)
          } else {
            setItems(DEFAULT_ITEMS)
          }
        }).catch(() => setItems(DEFAULT_ITEMS))
      }
      api.dayChecklistGet(ev.date, 'end').then((d) => {
        setItemStates(d.items || {})
      }).catch(() => {})
      setVisible(true)
    })
    return () => { try { off() } catch {} }
  }, [])

  const setExplicit = useCallback((itemId: string, v: DayChecklistItemState): void => {
    const api = getApi()
    if (!api || !date) return
    const cur = itemStates[itemId] || 'open'
    const next: DayChecklistItemState = cur === v ? 'open' : v
    setItemStates((s) => ({ ...s, [itemId]: next }))
    api.dayChecklistSetItem(date, 'end', itemId, next).catch(() => {})
  }, [date, itemStates])

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
    api.dayChecklistSetItem(date, 'end', itemId, next).catch(() => {})
  }, [date, itemStates])

  const dismiss = useCallback((): void => {
    const api = getApi()
    if (api && date) {
      api.dayChecklistDismiss(date, 'end').catch(() => {})
    }
    setVisible(false)
  }, [date])

  if (!visible) return null

  const totalItems = items.length
  const checkedCount = items.filter((i) => itemStates[i.id] === 'checked').length
  const skippedCount = items.filter((i) => itemStates[i.id] === 'skipped').length
  const naCount = items.filter((i) => itemStates[i.id] === 'na').length
  const openCount = totalItems - checkedCount - skippedCount - naCount

  return (
    <div className="daychk-overlay">
      <div className="daychk-modal">
        <div className="daychk-header">
          <span className="daychk-icon">{'\u{1F319}'}</span>
          <div className="daychk-title">End-of-Day Checklist</div>
        </div>
        <div className="daychk-subtitle">
          Last routine of {scheduledDay || 'the day'} is done. Run through these in order — CompSync stays open overnight to finish uploading. Dismiss anytime, state is saved.
        </div>

        <div className="daychk-list">
          {items.map((item) => {
            const s = itemStates[item.id] || 'open'
            const klass = `daychk-item ${s === 'checked' ? 'checked' : s === 'skipped' ? 'skipped' : s === 'na' ? 'na' : ''}`
            return (
              <div key={item.id} className={klass}>
                <div>
                  <div className="daychk-item-label" onClick={() => cycleState(item.id)} style={{ cursor: 'pointer' }}>
                    {item.label}
                  </div>
                  {item.detail && (
                    <div className="daychk-item-deadline">{item.detail}</div>
                  )}
                </div>
                <div className="daychk-state-btns">
                  <button
                    className={`daychk-state-btn ${s === 'checked' ? 'active checked' : ''}`}
                    onClick={() => setExplicit(item.id, 'checked')}
                    title="Mark done"
                  >
                    {'✓'} Done
                  </button>
                  <button
                    className={`daychk-state-btn ${s === 'skipped' ? 'active skipped' : ''}`}
                    onClick={() => setExplicit(item.id, 'skipped')}
                    title="Skip"
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
            Dismiss — done for the day
          </button>
        </div>
      </div>
    </div>
  )
}
