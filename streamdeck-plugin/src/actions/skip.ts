import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.skip' })
export class SkipAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.skip(state.skippedCount)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('skip')
    await ev.action.showOk()
  }
}
