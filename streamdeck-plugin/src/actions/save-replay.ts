import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.save-replay' })
export class SaveReplayAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const img = svg.replay(false)
    await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('saveReplay')
    const flashImg = svg.replay(true)
    await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(flashImg).toString('base64')}`)
    await ev.action.showOk()
    setTimeout(async () => {
      const normalImg = svg.replay(false)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(normalImg).toString('base64')}`)
    }, 1500)
  }
}
