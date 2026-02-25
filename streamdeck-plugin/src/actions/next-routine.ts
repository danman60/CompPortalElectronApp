import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.next-routine' })
export class NextRoutineAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    conn.onState(async (state) => {
      const num = state.routine?.entryNumber ?? null
      const img = svg.nextRoutine(num)
      await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(img).toString('base64')}`)
    })
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('nextRoutine')
    await ev.action.showOk()
  }
}
