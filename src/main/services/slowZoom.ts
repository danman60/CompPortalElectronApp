/**
 * Slow Zoom — drives a Move Transition between a base scene and a "zoomed"
 * scene for both Wide and Tight cameras. Operator pre-creates in OBS:
 *   - "Wide" + "Wide Zoomed" scenes (camera at base / +10% scale)
 *   - "Tight" + "Tight Zoomed" scenes (same pattern)
 *   - One Move Transition named "Slow Zoom" (default duration ~10s,
 *     ease-in-out cubic — Move plugin's own settings).
 *
 * Two Stream Deck buttons (slowZoomWide, slowZoomTight) — each toggles
 * its own scene's zoom state independently. Move plugin handles the
 * frame-perfect interpolation natively at OBS render rate, replacing the
 * older 30Hz SetSceneItemTransform polling that had stutter under WS jitter.
 *
 * If the configured transition or scene names don't exist in OBS, calls
 * fail soft with a warning — operator just hasn't completed the OBS-side
 * setup yet.
 */

import * as obs from './obs'
import { getSettings } from './settings'
import { logger } from '../logger'

let zoomedInWide = false
let zoomedInTight = false

// Slow zoom plays over 10s by design. OBS's transition_duration is per-current-
// transition: SetCurrentSceneTransitionDuration applies to whichever transition
// is currently selected. So we always set transition first, then duration, then
// cut scene. Without this the Move plugin uses whatever the global duration
// happened to be (typically 2000ms for Cut/Fade) which makes the zoom snap
// instead of slow-pan.
const SLOW_ZOOM_DURATION_MS = 10_000

async function trigger(
  label: 'wide' | 'tight',
  baseScene: string,
  zoomedScene: string,
  isZoomed: boolean,
): Promise<boolean> {
  const obsState = obs.getState()
  if (obsState.connectionStatus !== 'connected') {
    logger.app.warn(`Slow zoom (${label}): OBS not connected`)
    return isZoomed
  }
  const settings = getSettings()
  const transition = settings.obs?.slowZoomTransition || 'Slow Zoom'
  const target = isZoomed ? baseScene : zoomedScene
  try {
    await obs.setCurrentTransitionByName(transition)
    await obs.setCurrentTransitionDuration(SLOW_ZOOM_DURATION_MS)
    await obs.setCurrentScene(target)
    const newState = !isZoomed
    logger.app.info(
      `Slow zoom (${label}): ${isZoomed ? 'OUT' : 'IN'} via "${transition}" (${SLOW_ZOOM_DURATION_MS}ms) → "${target}"`,
    )
    return newState
  } catch (err) {
    logger.app.warn(
      `Slow zoom (${label}) failed: ${err instanceof Error ? err.message : err}`,
    )
    return isZoomed
  }
}

export async function triggerWide(): Promise<void> {
  const settings = getSettings()
  const base = settings.obs?.slowZoomWideBaseScene || 'Wide'
  const zoomed = settings.obs?.slowZoomWideZoomedScene || 'Wide Zoomed'
  zoomedInWide = await trigger('wide', base, zoomed, zoomedInWide)
}

export async function triggerTight(): Promise<void> {
  const settings = getSettings()
  const base = settings.obs?.slowZoomTightBaseScene || 'Tight'
  const zoomed = settings.obs?.slowZoomTightZoomedScene || 'Tight Zoomed'
  zoomedInTight = await trigger('tight', base, zoomed, zoomedInTight)
}

/** Clear cached zoom flags — call on OBS reconnect. */
export function reset(): void {
  zoomedInWide = false
  zoomedInTight = false
}
