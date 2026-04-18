import fs from 'fs'
import os from 'os'
import path from 'path'
import Store from 'electron-store'
import { safeStorage } from 'electron'
import { AppSettings, DEFAULT_SETTINGS } from '../../shared/types'
import { logger } from '../logger'
import { seedUserDataFromBundle } from './seedDefaults'

seedUserDataFromBundle()

const store = new Store({
  name: 'compsync-media-settings',
  defaults: DEFAULT_SETTINGS,
})

const SETTINGS_BACKUP_KEEP = 5
let backupScheduled = false

function getStorePath(): string {
  return (store as unknown as { path: string }).path
}

function getSecondaryBackupPath(): string {
  return path.join(os.homedir(), 'Documents', 'CompSync', 'settings-backup.json')
}

function listSettingsBackups(storePath: string): string[] {
  try {
    const dir = path.dirname(storePath)
    const base = path.basename(storePath)
    const prefix = `${base}.bak-`
    return fs
      .readdirSync(dir)
      .filter((e) => e.startsWith(prefix))
      .map((e) => path.join(dir, e))
      .sort((a, b) => {
        const ta = parseInt(path.basename(a).slice(prefix.length), 10) || 0
        const tb = parseInt(path.basename(b).slice(prefix.length), 10) || 0
        return tb - ta
      })
  } catch {
    return []
  }
}

function pruneSettingsBackups(storePath: string, keep: number): void {
  const backups = listSettingsBackups(storePath)
  if (backups.length <= keep) return
  for (const old of backups.slice(keep)) {
    try { fs.unlinkSync(old) } catch {}
  }
}

function writeSettingsBackup(): void {
  if (backupScheduled) return
  backupScheduled = true
  setTimeout(() => {
    backupScheduled = false
    try {
      const storePath = getStorePath()
      if (!fs.existsSync(storePath)) return
      const backupPath = `${storePath}.bak-${Date.now()}`
      fs.copyFileSync(storePath, backupPath)
      pruneSettingsBackups(storePath, SETTINGS_BACKUP_KEEP)
      const secondary = getSecondaryBackupPath()
      try {
        fs.mkdirSync(path.dirname(secondary), { recursive: true })
        fs.copyFileSync(storePath, secondary)
      } catch (sErr) {
        logger.settings.warn(`Secondary settings backup failed: ${sErr instanceof Error ? sErr.message : sErr}`)
      }
    } catch (err) {
      logger.settings.warn(`Settings backup failed: ${err instanceof Error ? err.message : err}`)
    }
  }, 250)
}

function tryRestoreSettingsFromBackup(): boolean {
  try {
    const storePath = getStorePath()
    const candidates: string[] = []
    candidates.push(...listSettingsBackups(storePath))
    const secondary = getSecondaryBackupPath()
    if (fs.existsSync(secondary)) candidates.push(secondary)
    for (const candidate of candidates) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8')
        JSON.parse(raw)
        fs.copyFileSync(candidate, storePath)
        logger.settings.warn(`Settings restored from backup: ${candidate}`)
        return true
      } catch {
        continue
      }
    }
  } catch (err) {
    logger.settings.warn(`Restore settings from backup failed: ${err instanceof Error ? err.message : err}`)
  }
  return false
}

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

function quarantineCorruptSettings(storePath: string): void {
  // Copy (not move) the on-disk file out of the way for forensic review so a
  // later getSettings() call doesn't trip over the same corruption. Never
  // delete it — operators have recovered passwords/shareCodes from quarantine.
  try {
    if (!fs.existsSync(storePath)) return
    const quarantined = `${storePath}.corrupt-${Date.now()}`
    fs.copyFileSync(storePath, quarantined)
    logger.settings.warn(`Corrupt settings quarantined to ${quarantined}`)
  } catch (err) {
    logger.settings.warn(`Quarantine failed: ${err instanceof Error ? err.message : err}`)
  }
}

export function getSettings(): AppSettings {
  // IMPORTANT (UDC London 2026-04-18): never call store.clear() from the read
  // path. The operator request is explicit — onboarding / first-run / read
  // recovery may fill MISSING keys with defaults, but must NEVER overwrite
  // values the operator configured. store.clear() wipes shareCode, outputDir,
  // OBS password, tether folder… all unrecoverable without a backup. Instead,
  // if the raw store is corrupt or throws, we quarantine the file for
  // forensics and rely on deepMerge below to fill the missing sections from
  // DEFAULT_SETTINGS. The operator sees a warning, keeps whatever values
  // survived in `raw`, and can restore from `.corrupt-*` if needed.
  let raw: Record<string, unknown>
  try {
    raw = store.store as unknown as Record<string, unknown>
    if (!raw.obs || !raw.behavior || !raw.competition) {
      logger.settings.warn('Settings corrupted (missing sections) — attempting backup restore')
      const restored = tryRestoreSettingsFromBackup()
      if (restored) {
        raw = store.store as unknown as Record<string, unknown>
      } else {
        logger.settings.warn(
          'No usable backup — filling missing keys from defaults without overwriting existing values',
        )
        // Do NOT call store.clear(). Leave `raw` as-is; deepMerge below will
        // layer DEFAULT_SETTINGS under any configured values.
      }
    }
  } catch (err) {
    logger.settings.error('Failed to read settings, attempting backup restore:', err)
    const restored = tryRestoreSettingsFromBackup()
    if (restored) {
      try {
        raw = store.store as unknown as Record<string, unknown>
      } catch {
        logger.settings.warn(
          'Backup restored but store still unreadable — quarantining and starting from empty merge surface',
        )
        quarantineCorruptSettings(getStorePath())
        raw = {}
      }
    } else {
      logger.settings.warn(
        'No usable backup — quarantining corrupt settings file; defaults will fill via merge',
      )
      quarantineCorruptSettings(getStorePath())
      raw = {}
    }
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

  // Fix 13: debounced rolling backup
  writeSettingsBackup()

  return settings
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const current = store.store as unknown as Record<string, unknown>

  // Clamp ffmpeg.threadCount to [0, os.cpus().length]
  if (partial.ffmpeg && typeof (partial.ffmpeg as any).threadCount === 'number') {
    const max = os.cpus().length
    const n = (partial.ffmpeg as any).threadCount
    ;(partial.ffmpeg as any).threadCount = Math.max(0, Math.min(max, Math.floor(n)))
  }
  // Clamp upload.bandwidthCapBytesPerSec to >= 0
  if (partial.upload && typeof (partial.upload as any).bandwidthCapBytesPerSec === 'number') {
    const n = (partial.upload as any).bandwidthCapBytesPerSec
    ;(partial.upload as any).bandwidthCapBytesPerSec = Math.max(0, Math.floor(n))
  }

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
