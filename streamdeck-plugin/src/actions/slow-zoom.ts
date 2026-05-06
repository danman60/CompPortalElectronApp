import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

// Two scene-specific Stream Deck buttons (Wide + Tight) — each toggles its
// own scene independently via the Move Transition plugin. CSE owns the
// canonical state; we optimistically flip the local label for instant
// feedback. The historic single-button "slow-zoom" UUID is kept and now
// drives the Wide button so operators don't lose their existing key layout.

let zoomedInWide = false
let zoomedInTight = false

function imgFor(label: string, state: boolean): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg.slowZoomScene(label, state)).toString('base64')}`
}

@action({ UUID: 'com.compsync.streamdeck.slow-zoom' })
export class SlowZoomWideAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    await ev.action.setImage(imgFor('WIDE', zoomedInWide))
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('slowZoomWideToggle')
    zoomedInWide = !zoomedInWide
    await ev.action.setImage(imgFor('WIDE', zoomedInWide))
  }
}

@action({ UUID: 'com.compsync.streamdeck.slow-zoom-tight' })
export class SlowZoomTightAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    await ev.action.setImage(imgFor('TIGHT', zoomedInTight))
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('slowZoomTightToggle')
    zoomedInTight = !zoomedInTight
    await ev.action.setImage(imgFor('TIGHT', zoomedInTight))
  }
}
