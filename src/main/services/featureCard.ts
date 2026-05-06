/**
 * Feature Card service — orchestrates the full-screen broadcast graphic.
 *
 * Two modes:
 *   - upNext:  large layout of upcoming routine. Main slot reads current pointer.
 *   - thatWas: large layout of just-performed routine. Main slot = current
 *              pointer. Bottom UP NEXT strip = pointer + 1.
 *
 * Fire flow:
 *   1. Capture current OBS scene name (for restore on hide).
 *   2. Pull routine data from state.ts and stuff into overlay.featureCard.
 *   3. Flip overlay.featureCard.visible = true (also sets mode + slide direction).
 *   4. Cut OBS to the configured FEATURE CARD scene. Operator pre-builds this
 *      scene with: the same overlay browser source full-bleed + a separately-
 *      sized Wide camera source PIP behind it.
 *
 * Hide flow:
 *   1. Flip overlay.featureCard.visible = false.
 *   2. Cut OBS back to the captured previous scene (if still exists).
 *
 * Auto-hide on manual scene cut:
 *   If operator cuts OBS away from the FEATURE CARD scene while featureCard
 *   is visible, we listen via obs.setOnSceneChanged and flip visible=false to
 *   keep state consistent (no scene restore — operator already moved on).
 */

import { logger } from '../logger'
import * as overlay from './overlay'
import * as obs from './obs'
import * as state from './state'
import { getSettings } from './settings'
import type { OverlayFeatureCardMode, Routine } from '../../shared/types'

let savedPreviousSceneName: string | null = null

function routineToSlot(r: Routine | null): {
  entryNumber: string
  routineTitle: string
  dancers: string
  studioName: string
  category: string
} {
  if (!r) {
    return { entryNumber: '', routineTitle: '', dancers: '', studioName: '', category: '' }
  }
  return {
    entryNumber: r.entryNumber || '',
    routineTitle: r.routineTitle || '',
    dancers: r.dancers || '',
    studioName: r.studioName || '',
    category: r.category || '',
  }
}

export async function fire(mode: OverlayFeatureCardMode): Promise<void> {
  const cur = state.getCurrentRoutine()
  const nxt = state.getNextRoutine()
  // Per Q1 (A+B): UP NEXT main = current pointer, THAT WAS main = current
  // pointer, THAT WAS bottom strip = pointer + 1. UP NEXT mode does not use
  // the bottom strip but we populate it harmlessly.
  overlay.setFeatureCardData({
    main: routineToSlot(cur),
    next: routineToSlot(nxt),
  })

  const dir = overlay.fireFeatureCard(mode)
  logger.app.info(`Feature card fire: mode=${mode} dir=${dir}`)

  // OBS scene swap. Capture previous so hide() can restore. If OBS is offline
  // or scene name not configured, we skip silently — overlay still shows.
  try {
    const obsState = obs.getState()
    if (obsState.connectionStatus !== 'connected') {
      logger.app.warn('Feature card: OBS not connected, skipping scene swap')
      return
    }
    const settings = getSettings()
    const targetScene = settings.obs?.featureCardScene || 'FEATURE CARD'
    const cur = await obs.getCurrentSceneName()
    if (cur && cur !== targetScene) {
      savedPreviousSceneName = cur
    }
    await obs.setCurrentScene(targetScene)
    logger.app.info(`Feature card: cut OBS scene "${cur}" → "${targetScene}"`)
  } catch (err) {
    logger.app.warn(`Feature card: OBS scene swap failed: ${err instanceof Error ? err.message : err}`)
  }
}

export async function hide(restoreScene = true): Promise<void> {
  if (!overlay.isFeatureCardVisible()) return
  overlay.hideFeatureCard()

  if (!restoreScene) {
    savedPreviousSceneName = null
    return
  }

  try {
    const obsState = obs.getState()
    if (obsState.connectionStatus !== 'connected') return
    if (savedPreviousSceneName) {
      await obs.setCurrentScene(savedPreviousSceneName)
      logger.app.info(`Feature card: restored OBS scene "${savedPreviousSceneName}"`)
      savedPreviousSceneName = null
    }
  } catch (err) {
    logger.app.warn(`Feature card: scene restore failed: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Wire OBS scene-change events. If operator manually cuts away from the
 * FEATURE CARD scene while featureCard is visible, auto-hide the overlay
 * (no scene restore — operator already chose where to go).
 */
export function init(): void {
  obs.setOnSceneChanged((sceneName: string | null) => {
    if (!overlay.isFeatureCardVisible()) return
    const settings = getSettings()
    const targetScene = settings.obs?.featureCardScene || 'FEATURE CARD'
    if (sceneName !== targetScene) {
      logger.app.info(`Feature card: scene cut to "${sceneName}" while visible — auto-hiding`)
      void hide(false)
    }
  })
}
