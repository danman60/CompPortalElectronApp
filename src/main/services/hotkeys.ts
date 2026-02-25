import { globalShortcut } from 'electron'
import * as obs from './obs'
import * as recording from './recording'
import * as overlay from './overlay'
import { getSettings } from './settings'
import { logger } from '../logger'

let registeredKeys: string[] = []

export function register(): void {
  unregister() // Clear existing

  const settings = getSettings()

  registerKey(settings.hotkeys.toggleRecording, 'Toggle Recording', async () => {
    const state = obs.getState()
    if (state.connectionStatus !== 'connected') {
      logger.app.debug('Toggle Recording ignored — OBS not connected')
      return
    }
    if (state.isRecording) {
      await obs.stopRecord()
    } else {
      await obs.startRecord()
    }
  })

  registerKey(settings.hotkeys.nextRoutine, 'Next Routine', async () => {
    await recording.next()
  })

  registerKey(settings.hotkeys.fireLowerThird, 'Fire Lower Third', () => {
    overlay.fireLowerThird()
  })

  registerKey(settings.hotkeys.saveReplay, 'Save Replay', async () => {
    if (obs.getState().connectionStatus !== 'connected') return
    await obs.saveReplay()
  })

  logger.app.info(`Global hotkeys registered: ${registeredKeys.join(', ')}`)
}

function registerKey(
  accelerator: string,
  label: string,
  callback: () => void | Promise<void>,
): void {
  if (!accelerator) return

  try {
    const success = globalShortcut.register(accelerator, () => {
      logger.app.debug(`Hotkey pressed: ${accelerator} (${label})`)
      const result = callback()
      if (result instanceof Promise) {
        result.catch((err) => logger.app.error(`Hotkey ${label} error:`, err))
      }
    })

    if (success) {
      registeredKeys.push(accelerator)
    } else {
      logger.app.warn(`Failed to register hotkey: ${accelerator} (${label})`)
    }
  } catch (err) {
    logger.app.error(`Error registering hotkey ${accelerator}:`, err)
  }
}

export function unregister(): void {
  globalShortcut.unregisterAll()
  registeredKeys = []
}
