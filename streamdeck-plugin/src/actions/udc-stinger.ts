import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

@action({ UUID: 'com.compsync.streamdeck.udc-stinger' })
export class UdcStingerAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(svg.udcStinger()).toString('base64')}`)
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    conn.sendCommand('setUdcStingerTransition')
    await ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(svg.udcStinger(true)).toString('base64')}`)
    setTimeout(() => {
      ev.action.setImage(`data:image/svg+xml;base64,${Buffer.from(svg.udcStinger()).toString('base64')}`).catch(() => {})
    }, 650)
  }
}
