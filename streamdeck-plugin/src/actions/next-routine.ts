import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck'
import * as conn from '../connection'
import * as svg from '../svg'

const FLASH_TRIGGER_SEC = 120 // 2:00 INTO a recording — operator-spec (revised 2026-04-25)
const FLASH_INTERVAL_MS = 250

// Per-action runtime state (Stream Deck can render the same action on multiple
// keys in theory; keying by ev.action.id keeps each independent).
interface FlashRuntime {
  baseImg: string  // current "calm" SVG (entryNumber when not flashing)
  flashing: boolean
  timer: ReturnType<typeof setInterval> | null
  altPhase: boolean
  lastEntryNum: string | null
}

const runtime = new Map<string, FlashRuntime>()

function buildBaseImg(num: string | null): string {
  return svg.nextRoutine(num)
}

function buildAlertImg(num: string | null): string {
  // High-contrast variant: red-ish background with an arrow + entry number.
  // Direct call (no defensive runtime cast) — earlier `(svg as any).x ? x() : y()`
  // pattern produced an infinite recursion in the rollup-bundled output where
  // the conditional's truthy branch resolved to the function itself instead
  // of `svg.x`. Operator-reported 2026-04-25: flash never fired.
  return svg.nextRoutineAlert(num)
}

async function setFromSvg(action: any, svgText: string): Promise<void> {
  await action.setImage(`data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`)
}

@action({ UUID: 'com.compsync.streamdeck.next-routine' })
export class NextRoutineAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const id = ev.action.id
    if (!runtime.has(id)) {
      runtime.set(id, {
        baseImg: buildBaseImg(null),
        flashing: false,
        timer: null,
        altPhase: false,
        lastEntryNum: null,
      })
    }
    const rt = runtime.get(id)!

    conn.onState(async (state) => {
      const num = state.routine?.entryNumber ?? null
      // Only rebuild base image when the entry number changes — saves churn.
      if (num !== rt.lastEntryNum) {
        rt.lastEntryNum = num
        rt.baseImg = buildBaseImg(num)
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
          const img = rt.altPhase ? buildAlertImg(rt.lastEntryNum) : rt.baseImg
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
    // Pressing NEXT clears any active flash immediately so the operator sees
    // the calm face before the next recording starts.
    const rt = runtime.get(ev.action.id)
    if (rt?.flashing) {
      rt.flashing = false
      if (rt.timer) { clearInterval(rt.timer); rt.timer = null }
      void setFromSvg(ev.action, rt.baseImg)
    }
    conn.sendCommand('nextRoutine')

  }
}
