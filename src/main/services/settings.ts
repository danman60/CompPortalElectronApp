import Store from 'electron-store'
import { safeStorage } from 'electron'
import { AppSettings, DEFAULT_SETTINGS } from '../../shared/types'
import { logger } from '../logger'

const store = new Store({
  name: 'compsync-media-settings',
  defaults: DEFAULT_SETTINGS,
})

// Keys that should be encrypted
const SENSITIVE_KEYS = ['obs.password']

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  const last = keys.pop()!
  const target = keys.reduce((acc: unknown, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj) as Record<string, unknown>
  if (target) target[last] = value
}

export function getSettings(): AppSettings {
  let settings: AppSettings
  try {
    settings = store.store as unknown as AppSettings
    // Sanity check: if critical nested objects are missing, reset
    if (!settings.obs || !settings.behavior || !settings.competition) {
      logger.settings.warn('Settings corrupted (missing sections), resetting to defaults')
      store.clear()
      settings = store.store as unknown as AppSettings
    }
  } catch (err) {
    logger.settings.error('Failed to read settings, resetting to defaults:', err)
    store.clear()
    settings = store.store as unknown as AppSettings
  }

  // Migrate old lowerThird settings key to overlay
  const raw = settings as unknown as Record<string, unknown>
  if (raw.lowerThird && !raw.overlay) {
    const old = raw.lowerThird as Record<string, unknown>
    raw.overlay = {
      autoHideSeconds: old.autoHideSeconds ?? 8,
      overlayUrl: old.overlayUrl ?? 'http://localhost:9876/overlay',
      logoUrl: '',
      defaultCounter: true,
      defaultClock: false,
      defaultLogo: true,
    }
    delete raw.lowerThird
    store.set('overlay', raw.overlay)
    store.delete('lowerThird' as never)
    logger.settings.info('Migrated lowerThird settings to overlay')
  }

  // Migrate old compsync fields to shareCode format
  const cs = raw.compsync as Record<string, unknown> | undefined
  if (cs && ('tenant' in cs || 'pluginApiKey' in cs)) {
    const shareCode = (cs.shareCode as string) || ''
    raw.compsync = { shareCode }
    store.set('compsync', raw.compsync)
    logger.settings.info('Migrated compsync settings to shareCode format')
  }

  // Migrate ffmpeg: add cpuPriority if missing
  const ff = raw.ffmpeg as Record<string, unknown> | undefined
  if (ff && !('cpuPriority' in ff)) {
    ff.cpuPriority = 'below-normal'
    store.set('ffmpeg', ff)
  }

  // Migrate behavior: add compactMode if missing
  const beh = raw.behavior as Record<string, unknown> | undefined
  if (beh && !('compactMode' in beh)) {
    beh.compactMode = false
    store.set('behavior', beh)
  }

  // Decrypt sensitive values
  for (const key of SENSITIVE_KEYS) {
    const encrypted = getNestedValue(settings as unknown as Record<string, unknown>, key + '_encrypted') as string | undefined
    if (encrypted && safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
        setNestedValue(settings as unknown as Record<string, unknown>, key, decrypted)
      } catch {
        logger.settings.warn(`Failed to decrypt ${key}`)
      }
    }
  }

  return settings
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const current = store.store as unknown as Record<string, unknown>

  // Merge top-level keys
  for (const [key, value] of Object.entries(partial)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const existing = (current[key] || {}) as Record<string, unknown>
      store.set(key, { ...existing, ...value })
    } else {
      store.set(key, value)
    }
  }

  // Encrypt sensitive values
  if (safeStorage.isEncryptionAvailable()) {
    for (const key of SENSITIVE_KEYS) {
      const value = getNestedValue(store.store as unknown as Record<string, unknown>, key) as string | undefined
      if (value && value.length > 0) {
        const encrypted = safeStorage.encryptString(value).toString('base64')
        store.set(key + '_encrypted', encrypted)
      }
    }
  }

  logger.settings.info('Settings updated', Object.keys(partial).join(', '))
  return getSettings()
}

export function resetSettings(): AppSettings {
  store.clear()
  logger.settings.info('Settings reset to defaults')
  return getSettings()
}
