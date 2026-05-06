import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

// Two Stream Deck buttons:
//   - Feature Card UP NEXT: pre-routine large-format graphic
//   - Feature Card THAT WAS: post-routine + bottom UP NEXT strip
// Each press toggles fire/hide. CSE owns the canonical visible state — we
// optimistically flip the local label and the next state push from CSE will
// correct any drift (e.g. operator hides via toolbar instead).

let upNextActive = false
let thatWasActive = false

function imgFor(mode: 'upNext' | 'thatWas', active: boolean): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg.featureCard(mode, active)).toString('base64')}`
}

@action({ UUID: 'com.compsync.streamdeck.feature-card-up-next' })
export class FeatureCardUpNextAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    await ev.action.setImage(imgFor('upNext', upNextActive))
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (upNextActive) {
      conn.sendCommand('featureCardHide')
      upNextActive = false
      thatWasActive = false
    } else {
      conn.sendCommand('featureCardUpNext')
      upNextActive = true
      thatWasActive = false
    }
    await ev.action.setImage(imgFor('upNext', upNextActive))
  }
}

@action({ UUID: 'com.compsync.streamdeck.feature-card-that-was' })
export class FeatureCardThatWasAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    await ev.action.setImage(imgFor('thatWas', thatWasActive))
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (thatWasActive) {
      conn.sendCommand('featureCardHide')
      thatWasActive = false
      upNextActive = false
    } else {
      conn.sendCommand('featureCardThatWas')
      thatWasActive = true
      upNextActive = false
    }
    await ev.action.setImage(imgFor('thatWas', thatWasActive))
  }
}
