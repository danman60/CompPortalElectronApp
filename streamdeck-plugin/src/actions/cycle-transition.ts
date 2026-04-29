import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.cycle-transition' })
export class CycleTransitionAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    let lastName: string | null | undefined = undefined
    conn.onState(async (state) => {
      const cur = state.transitions?.current ?? null
      if (cur === lastName) return
      lastName = cur
      const img = svg.cycleTransition(cur)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('cycleTransition')

  }
}
