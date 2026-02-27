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

/** Deep merge: fills in missing keys from defaults without overwriting existing values. */
function deepMerge(target: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(defaults)) {
    if (!(key in target)) {
      target[key] = defaults[key]
    } else if (
      typeof defaults[key] === 'object' &&
      defaults[key] !== null &&
      !Array.isArray(defaults[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null
    ) {
      target[key] = deepMerge(
        target[key] as Record<string, unknown>,
        defaults[key] as Record<string, unknown>,
      )
    }
  }
  return target
}

export function getSettings(): AppSettings {
  let raw: Record<string, unknown>
  try {
    raw = store.store as unknown as Record<string, unknown>
    if (!raw.obs || !raw.behavior || !raw.competition) {
      logger.settings.warn('Settings corrupted (missing sections), resetting to defaults')
      store.clear()
      raw = store.store as unknown as Record<string, unknown>
    }
  } catch (err) {
    logger.settings.error('Failed to read settings, resetting to defaults:', err)
    store.clear()
    raw = store.store as unknown as Record<string, unknown>
  }

  // --- Migrations (collected, applied in single store.set) ---
  let migrated = false

  // Migrate old lowerThird settings key to overlay
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
    logger.settings.info('Migrated lowerThird settings to overlay')
    migrated = true
  }

  // Migrate old compsync fields to shareCode format
  const cs = raw.compsync as Record<string, unknown> | undefined
  if (cs && ('tenant' in cs || 'pluginApiKey' in cs)) {
    raw.compsync = { shareCode: (cs.shareCode as string) || '' }
    logger.settings.info('Migrated compsync settings to shareCode format')
    migrated = true
  }

  // Deep merge with defaults — fills in any missing keys at any nesting level
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>
  const merged = deepMerge(raw, defaults)
  if (JSON.stringify(merged) !== JSON.stringify(raw)) {
    migrated = true
  }

  // Atomic migration: single store write
  if (migrated) {
    for (const [key, value] of Object.entries(merged)) {
      store.set(key, value)
    }
    // Clean up legacy keys
    if ('lowerThird' in store.store) {
      store.delete('lowerThird' as never)
    }
  }

  const settings = merged as unknown as AppSettings

  // Decrypt sensitive values
  for (const key of SENSITIVE_KEYS) {
    const encrypted = getNestedValue(merged, key + '_encrypted') as string | undefined
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
