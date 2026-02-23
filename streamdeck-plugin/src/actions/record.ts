import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.record' })
export class RecordAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const img = svg.record(state.recording.active, state.recording.elapsed)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
      await ev.action.setState(state.recording.active ? 1 : 0)
    })
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('toggleRecord')
  }
}
