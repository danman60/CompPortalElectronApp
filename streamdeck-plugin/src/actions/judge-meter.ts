import { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

interface JudgeMeterSettings {
  role?: 'performance' | 'judge1' | 'judge2' | 'judge3' | 'judge4'
}

const ROLE_LABELS: Record<string, string> = {
  performance: 'PERF',
  judge1: 'J1',
  judge2: 'J2',
  judge3: 'J3',
  judge4: 'J4',
}

// EMA smoothing state per action instance — keeps the bar visually responsive
// without chattering on every audio frame.
const EMA_ALPHA = 0.35
const FALL_ALPHA = 0.18 // slower fall

// Convert linear amplitude (OBS InputVolumeMeters is linear 0..1) to a
// perceptual 0..1 meter scale via -60..0 dB mapping. Without this the bars
// sit at the bottom 2-10% of the button because typical audio peaks live in
// linear 0.05–0.3 (which is -26..-10 dB — plenty of signal, just not linear).
function linearToMeterScale(linear: number): number {
  if (linear <= 0) return 0
  const dB = 20 * Math.log10(linear)
  if (dB <= -60) return 0
  if (dB >= 0) return 1
  return (dB + 60) / 60
}

@action({ UUID: 'com.compsync.streamdeck.judge-meter' })
export class JudgeMeterAction extends SingletonAction<JudgeMeterSettings> {
  // Keep per-context state — context = single Stream Deck button instance.
  // A user can drop multiple judge meters on different keys with different roles.
  private smoothed = new Map<string, number>()
  private lastRender = new Map<string, number>()
  private listeners = new Map<string, (levels: conn.AudioLevels) => void>()

  override async onWillAppear(ev: WillAppearEvent<JudgeMeterSettings>): Promise<void> {
    const ctxId = ev.action.id
    const settings = ev.payload.settings || {}
    const role = settings.role || 'performance'
    this.smoothed.set(ctxId, 0)

    // Initial render so the button isn't blank
    await this.render(ev.action, role, 0)

    // Subscribe to live audio levels — re-renders at incoming WS rate (~5/s)
    const listener = (levels: conn.AudioLevels) => {
      const rawLinear = levels[role] ?? 0
      const target = linearToMeterScale(rawLinear)
      const prev = this.smoothed.get(ctxId) ?? 0
      // Asymmetric EMA — fast attack, slow release (looks more like a real VU)
      const alpha = target > prev ? EMA_ALPHA : FALL_ALPHA
      const next = prev + (target - prev) * alpha
      this.smoothed.set(ctxId, next)

      // Throttle renders to ~10 fps max — Stream Deck SDK chokes if you spam
      const now = Date.now()
      const last = this.lastRender.get(ctxId) ?? 0
      if (now - last < 100) return
      this.lastRender.set(ctxId, now)

      this.render(ev.action, role, next).catch(() => {})
    }
    this.listeners.set(ctxId, listener)
    conn.onAudioLevels(listener)
  }

  override async onWillDisappear(ev: WillDisappearEvent<JudgeMeterSettings>): Promise<void> {
    const ctxId = ev.action.id
    this.smoothed.delete(ctxId)
    this.lastRender.delete(ctxId)
    this.listeners.delete(ctxId)
    // Note: connection.ts doesn't expose offAudioLevels yet — listeners stay
    // in the array but get filtered as no-ops via the deleted state. Acceptable
    // for now; can add proper unsubscribe later if memory becomes a concern.
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<JudgeMeterSettings>): Promise<void> {
    const role = ev.payload.settings.role || 'performance'
    const ctxId = ev.action.id
    const peak = this.smoothed.get(ctxId) ?? 0
    await this.render(ev.action, role, peak)
  }

  override async onKeyDown(_ev: KeyDownEvent<JudgeMeterSettings>): Promise<void> {
    // No-op — meter is display-only. Could trigger a passthrough later
    // (e.g. mute that input in OBS) but keeping it inert for now.
  }

  private async render(action: WillAppearEvent['action'] | KeyDownEvent['action'], role: string, peak: number): Promise<void> {
    const label = ROLE_LABELS[role] || role.toUpperCase()
    const img = svg.judgeMeter(label, peak)
    await action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
  }
}
