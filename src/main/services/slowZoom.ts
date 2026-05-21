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
    // Force-revert to Cut after the zoom completes. The Move Transition plugin
    // does not reliably fire SceneTransitionEnded, so the global auto-revert
    // in obs.ts (which catches stinger/fade/wipe) cannot rescue us. Without
    // this, the next scene change after a slow zoom uses the 10s Slow Zoom
    // transition by mistake (operator complaint 2026-05-15).
    const cutName = obs.getCutTransitionName()
    if (cutName) {
      setTimeout(() => {
        obs.setCurrentTransitionByName(cutName)
          .then(() => logger.app.info(`Slow zoom (${label}): reverted "${transition}" → "${cutName}"`))
          .catch((err) => logger.app.warn(`Slow zoom (${label}): revert to ${cutName} failed: ${err instanceof Error ? err.message : err}`))
      }, SLOW_ZOOM_DURATION_MS + 500)
    } else {
      logger.app.warn(`Slow zoom (${label}): no cut_transition found, leaving "${transition}" armed`)
    }
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

/**
 * 2026-05-15 operator fix: when the operator manually switches to a scene
 * OTHER than the camera's zoomed scene (e.g. cuts to a different camera or
 * a graphics scene after a slow zoom), the cached zoom flag stayed stuck
 * "zoomed", so the next Stream Deck press toggled the wrong way and needed
 * an extra transition. Now we follow the live program scene: if the current
 * scene isn't this camera's Zoomed scene, the flag resets to "not zoomed".
 */
export function onSceneChanged(sceneName: string | null): void {
  if (!sceneName) return
  const settings = getSettings()
  const wideZoomed = settings.obs?.slowZoomWideZoomedScene || 'Wide Zoomed'
  const tightZoomed = settings.obs?.slowZoomTightZoomedScene || 'Tight Zoomed'
  if (sceneName !== wideZoomed && zoomedInWide) {
    zoomedInWide = false
    logger.app.info(`Slow zoom (wide): scene → "${sceneName}" (not "${wideZoomed}") — zoom state reset`)
  }
  if (sceneName !== tightZoomed && zoomedInTight) {
    zoomedInTight = false
    logger.app.info(`Slow zoom (tight): scene → "${sceneName}" (not "${tightZoomed}") — zoom state reset`)
  }
}

/** Wire the scene-change reset. Call once at startup. */
export function registerSceneWatcher(): void {
  obs.setOnSceneChanged(onSceneChanged)
}
