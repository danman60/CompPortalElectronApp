import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

const FLASH_TRIGGER_SEC = 120 // 2:00 INTO a recording — operator-spec (revised 2026-04-25)
const FLASH_INTERVAL_MS = 250

interface FlashRuntime {
  baseImg: string
  flashing: boolean
  timer: ReturnType<typeof setInterval> | null
  altPhase: boolean
  lastNum: string | null
  lastConnected: boolean
}

const runtime = new Map<string, FlashRuntime>()

function buildBaseImg(num: string | null, connected: boolean): string {
  return svg.nextFull(num, connected)
}

function buildAlertImg(num: string | null): string {
  return svg.nextFullAlert(num)
}

async function setFromSvg(action: any, svgText: string): Promise<void> {
  await action.setImage(`data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`)
}

@action({ UUID: 'com.compsync.streamdeck.next-full' })
export class NextFullAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const id = ev.action.id
    if (!runtime.has(id)) {
      runtime.set(id, {
        baseImg: buildBaseImg(null, conn.isConnected()),
        flashing: false,
        timer: null,
        altPhase: false,
        lastNum: null,
        lastConnected: conn.isConnected(),
      })
    }
    const rt = runtime.get(id)!

    conn.onState(async (state) => {
      const num = state.nextRoutine?.entryNumber ?? null
      const connected = conn.isConnected()

      if (num !== rt.lastNum || connected !== rt.lastConnected) {
        rt.lastNum = num
        rt.lastConnected = connected
        rt.baseImg = buildBaseImg(num, connected)
        if (!rt.flashing) {
          await setFromSvg(ev.action, rt.baseImg)
        }
      }

      const shouldFlash = !!state.recording?.active &&
        (state.recording.elapsed ?? 0) >= FLASH_TRIGGER_SEC

      if (shouldFlash && !rt.flashing) {
        rt.flashing = true
        rt.altPhase = false
        rt.timer = setInterval(() => {
          rt.altPhase = !rt.altPhase
          const img = rt.altPhase ? buildAlertImg(rt.lastNum) : rt.baseImg
          void setFromSvg(ev.action, img)
        }, FLASH_INTERVAL_MS)
      } else if (!shouldFlash && rt.flashing) {
        rt.flashing = false
        if (rt.timer) { clearInterval(rt.timer); rt.timer = null }
        await setFromSvg(ev.action, rt.baseImg)
      }
    })
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    // Pressing NEXT clears the flash so the deck shows the calm face going
    // into the next recording.
    const rt = runtime.get(ev.action.id)
    if (rt?.flashing) {
      rt.flashing = false
      if (rt.timer) { clearInterval(rt.timer); rt.timer = null }
      void setFromSvg(ev.action, rt.baseImg)
    }
    conn.sendCommand('nextFull')

  }
}
