import { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck'
import type { JsonObject } from '@elgato/utils'
import * as conn from '../connection'
import * as svg from '../svg'

type Role = 'performance' | 'judge1' | 'judge2' | 'judge3' | 'judge4'

interface UnifiedMetersSettings extends JsonObject {
  // Comma-separated role list, e.g. "judge1,judge2,judge3,judge4" or
  // "performance,judge1,judge2,judge3,judge4". If absent, defaults to J1-J4.
  roles?: string
}

const ROLE_LABELS: Record<Role, string> = {
  performance: 'P',
  judge1: 'J1',
  judge2: 'J2',
  judge3: 'J3',
  judge4: 'J4',
}

const DEFAULT_ROLES: Role[] = ['performance', 'judge1', 'judge2', 'judge3']
const VALID_ROLES = new Set<Role>(['performance', 'judge1', 'judge2', 'judge3', 'judge4'])

const EMA_ALPHA = 0.35
const FALL_ALPHA = 0.18

function linearToMeterScale(linear: number): number {
  if (linear <= 0) return 0
  const dB = 20 * Math.log10(linear)
  if (dB <= -60) return 0
  if (dB >= 0) return 1
  return (dB + 60) / 60
}

function parseRoles(raw?: string): Role[] {
  if (!raw) return DEFAULT_ROLES
  const out: Role[] = []
  for (const part of raw.split(',').map((s) => s.trim())) {
    if (VALID_ROLES.has(part as Role)) out.push(part as Role)
  }
  return out.length > 0 ? out : DEFAULT_ROLES
}

@action({ UUID: 'com.compsync.streamdeck.unified-meters' })
export class UnifiedMetersAction extends SingletonAction<UnifiedMetersSettings> {
  // Per-button-instance state. Each instance can show a different role set.
  private smoothed = new Map<string, Map<Role, number>>()
  private rolesByCtx = new Map<string, Role[]>()
  private lastRender = new Map<string, number>()
  private listeners = new Map<string, (levels: conn.AudioLevels) => void>()

  private getSmoothed(ctxId: string, role: Role): number {
    return this.smoothed.get(ctxId)?.get(role) ?? 0
  }

  private setSmoothed(ctxId: string, role: Role, value: number): void {
    let m = this.smoothed.get(ctxId)
    if (!m) {
      m = new Map<Role, number>()
      this.smoothed.set(ctxId, m)
    }
    m.set(role, value)
  }

  override async onWillAppear(ev: WillAppearEvent<UnifiedMetersSettings>): Promise<void> {
    const ctxId = ev.action.id
    const roles = parseRoles(ev.payload.settings?.roles)
    this.rolesByCtx.set(ctxId, roles)
    for (const r of roles) this.setSmoothed(ctxId, r, 0)

    await this.render(ev.action, ctxId)

    const listener = (levels: conn.AudioLevels) => {
      const myRoles = this.rolesByCtx.get(ctxId) || DEFAULT_ROLES
      for (const role of myRoles) {
        const target = linearToMeterScale(levels[role] ?? 0)
        const prev = this.getSmoothed(ctxId, role)
        const alpha = target > prev ? EMA_ALPHA : FALL_ALPHA
        this.setSmoothed(ctxId, role, prev + (target - prev) * alpha)
      }
      const now = Date.now()
      const last = this.lastRender.get(ctxId) ?? 0
      if (now - last < 100) return // ~10 fps cap
      this.lastRender.set(ctxId, now)
      this.render(ev.action, ctxId).catch(() => {})
    }
    this.listeners.set(ctxId, listener)
    conn.onAudioLevels(listener)
  }

  override async onWillDisappear(ev: WillDisappearEvent<UnifiedMetersSettings>): Promise<void> {
    const ctxId = ev.action.id
    this.smoothed.delete(ctxId)
    this.rolesByCtx.delete(ctxId)
    this.lastRender.delete(ctxId)
    this.listeners.delete(ctxId)
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UnifiedMetersSettings>): Promise<void> {
    const ctxId = ev.action.id
    const newRoles = parseRoles(ev.payload.settings?.roles)
    this.rolesByCtx.set(ctxId, newRoles)
    for (const r of newRoles) {
      if (this.getSmoothed(ctxId, r) === undefined) this.setSmoothed(ctxId, r, 0)
    }
    await this.render(ev.action, ctxId)
  }

  override async onKeyDown(_ev: KeyDownEvent<UnifiedMetersSettings>): Promise<void> {
    // No-op — display only.
  }

  private async render(action: WillAppearEvent['action'] | KeyDownEvent['action'], ctxId: string): Promise<void> {
    const roles = this.rolesByCtx.get(ctxId) || DEFAULT_ROLES
    const entries = roles.map((r) => ({
      label: ROLE_LABELS[r],
      peak: this.getSmoothed(ctxId, r),
    }))
    const img = svg.unifiedMeter(entries)
    await action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
  }
}
