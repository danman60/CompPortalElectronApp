import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.overlay-lower-third' })
export class OverlayLowerThirdAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.overlayToggle('LT', state.overlay.lowerThird.visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleOverlay', 'lowerThird')
  }
}

@action({ UUID: 'com.compsync.streamdeck.overlay-counter' })
export class OverlayCounterAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.overlayToggle('CTR', state.overlay.counter.visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleOverlay', 'counter')
  }
}

@action({ UUID: 'com.compsync.streamdeck.overlay-clock' })
export class OverlayClockAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.overlayToggle('CLK', state.overlay.clock.visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleOverlay', 'clock')
  }
}

@action({ UUID: 'com.compsync.streamdeck.overlay-logo' })
export class OverlayLogoAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.overlayToggle('LOGO', state.overlay.logo.visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleOverlay', 'logo')
  }
}

@action({ UUID: 'com.compsync.streamdeck.overlay-ticker' })
export class OverlayTickerAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const visible = !!(state.overlay && state.overlay.ticker && state.overlay.ticker.visible)
      const img = svg.overlayToggle('TKR', visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleOverlay', 'ticker')
  }
}

@action({ UUID: 'com.compsync.streamdeck.overlay-starting-soon' })
export class OverlayStartingSoonAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const visible = !!(state.overlay && state.overlay.startingSoon && state.overlay.startingSoon.visible)
      const img = svg.startingSoonToggle(visible)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleOverlay', 'startingSoon')
  }
}
