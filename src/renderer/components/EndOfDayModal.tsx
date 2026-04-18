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
 * Matches ClockSyncReminder visuals (amber, big, dismissable). Grouped into
 * "App actions" and "Physical / hotel". The "SD card in Reader" item has a
 * hard deadline of 10:15pm; past that time, if not checked, the row shows
 * bold red with a pulse to escalate.
 */

interface ChecklistItem {
  id: string
  label: string
  deadline?: string // informational — displayed under label
}

interface ChecklistSection {
  title: string
  items: ChecklistItem[]
}

const SECTIONS: ChecklistSection[] = [
  {
    title: 'App actions',
    items: [
      { id: 'close-compsync', label: 'Close CompSync' },
      { id: 'stop-stream', label: 'Stop stream' },
      { id: 'turn-off-counter', label: 'Turn off counter' },
    ],
  },
  {
    title: 'Physical / hotel',
    items: [
      { id: 'mevos-charging', label: 'Mevos / banks charging (charge banks with banks charging Mevos — use tablet charger cable, etc.)' },
      { id: 'cameras-off', label: 'Cameras off, charging deadest batteries overnight' },
      { id: 'tvs-off', label: 'Stream off / TVs off (hold bottom power button)' },
      { id: 'sd-in-reader', label: 'Each Photo SD card in each Reader', deadline: 'MUST BE IN BY 10:15 PM' },
    ],
  },
]

const SD_ITEM_ID = 'sd-in-reader'

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

/** Return true if local clock is past 10:15pm. */
function isPastSdDeadline(now: Date): boolean {
  const h = now.getHours()
  const m = now.getMinutes()
  if (h > 22) return true
  if (h === 22 && m >= 15) return true
  return false
}

export default function EndOfDayModal(): React.ReactElement | null {
  const [visible, setVisible] = useState(false)
  const [date, setDate] = useState<string>('')
  const [scheduledDay, setScheduledDay] = useState<string | null>(null)
  const [itemStates, setItemStates] = useState<Record<string, DayChecklistItemState>>({})
  const [now, setNow] = useState<Date>(new Date())

  // Listen for SHOW broadcasts.
  useEffect(() => {
    const api = getApi()
    if (!api) return
    const off = api.on(IPC_CHANNELS.DAY_CHECKLIST_SHOW, (evUnknown: unknown) => {
      const ev = evUnknown as DayChecklistShowEvent
      if (!ev || ev.kind !== 'end') return
      setDate(ev.date)
      setScheduledDay(ev.scheduledDay)
      api.dayChecklistGet(ev.date, 'end').then((d) => {
        setItemStates(d.items || {})
      }).catch(() => {})
      setVisible(true)
    })
    return () => { try { off() } catch {} }
  }, [])

  // Tick clock once per minute — drives the SD deadline escalation.
  useEffect(() => {
    if (!visible) return
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [visible])

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

  const pastDeadline = isPastSdDeadline(now)
  const sdState = itemStates[SD_ITEM_ID] || 'open'
  const sdEscalated = pastDeadline && sdState !== 'checked'

  const allItems = SECTIONS.flatMap((s) => s.items)
  const totalItems = allItems.length
  const checkedCount = allItems.filter((i) => itemStates[i.id] === 'checked').length
  const skippedCount = allItems.filter((i) => itemStates[i.id] === 'skipped').length
  const naCount = allItems.filter((i) => itemStates[i.id] === 'na').length
  const openCount = totalItems - checkedCount - skippedCount - naCount

  return (
    <div className="daychk-overlay">
      <div className="daychk-modal">
        <div className="daychk-header">
          <span className="daychk-icon">{'\u{1F319}'}</span>
          <div className="daychk-title">End-of-Day Checklist</div>
        </div>
        <div className="daychk-subtitle">
          Last routine of {scheduledDay || 'the day'} is done. Wrap-up steps below — dismiss anytime, state is saved.
        </div>

        {SECTIONS.map((section) => (
          <div key={section.title}>
            <div className="daychk-section-title">{section.title}</div>
            <div className="daychk-list">
              {section.items.map((item) => {
                const s = itemStates[item.id] || 'open'
                const isSdRow = item.id === SD_ITEM_ID
                const classes = [
                  'daychk-item',
                  s === 'checked' ? 'checked' : s === 'skipped' ? 'skipped' : s === 'na' ? 'na' : '',
                  isSdRow && sdEscalated ? 'deadline-late' : '',
                ].filter(Boolean).join(' ')
                return (
                  <div key={item.id} className={classes}>
                    <div>
                      <div className="daychk-item-label" onClick={() => cycleState(item.id)} style={{ cursor: 'pointer' }}>
                        {item.label}
                      </div>
                      {item.deadline && (
                        <div className="daychk-item-deadline">
                          {isSdRow && sdEscalated ? `OVERDUE — ${item.deadline}` : item.deadline}
                        </div>
                      )}
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
          </div>
        ))}

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
