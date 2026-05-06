// Volume serial number lookup for SD-card dedup cursors (build9o, item #2).
//
// Replaces per-file source-hash dedup. Each SD card carries a stable Windows
// volume serial number that survives swaps in/out of the same reader and is
// distinct between cards. We key the dedup cursor by serial so the EXIF
// timestamp watermark advances per-card, not per-camera-body — this fixes
// the counter-wraparound and out-of-order-recovery cases that doomed the
// body-watermark approach (photos.ts:1384–1399 deletion 2026-05-02).
//
// Reads via the legacy `vol <letter>:` cmd which is available on every
// Windows release CSE targets. Output:
//   ` Volume in drive F is CANON_EOS`
//   ` Volume Serial Number is XXXX-XXXX`
// We strip the dash and uppercase so cache keys are stable.

import { execSync } from 'child_process'

const cache = new Map<string, { serial: string; label: string }>()

export interface VolumeInfo {
  serial: string  // uppercase hex with no dash, e.g., "AB12CD34". Empty on failure.
  label: string   // human-readable disk label, e.g., "CANON_EOS". Empty on failure.
}

/** Normalize a drive root to "F:" form (no trailing slash). */
function normalizeDrive(driveRoot: string): string {
  if (!driveRoot) return ''
  // Strip trailing slashes/backslashes, take first two chars only ("F:")
  const stripped = driveRoot.replace(/[\\/]+$/, '').toUpperCase()
  if (stripped.length >= 2 && stripped.charAt(1) === ':') return stripped.slice(0, 2)
  return stripped
}

/**
 * Look up the volume serial + label for a Windows drive root.
 * Returns empty strings on any failure (non-Windows, drive missing, parse fail).
 * Cached per-session because the same SD card stays mounted at the same letter
 * for the duration of an import.
 */
export function getVolumeInfo(driveRoot: string): VolumeInfo {
  if (process.platform !== 'win32') return { serial: '', label: '' }
  const drive = normalizeDrive(driveRoot)
  if (!drive) return { serial: '', label: '' }
  const cached = cache.get(drive)
  if (cached) return cached
  try {
    const out = execSync(`vol ${drive}`, { timeout: 3000, windowsHide: true, encoding: 'utf-8' })
    const labelMatch = out.match(/Volume in drive [A-Z] is (.+)/i)
    const label = (labelMatch && labelMatch[1]) ? labelMatch[1].trim() : ''
    const serialMatch = out.match(/Volume Serial Number is ([0-9A-F]{4}-[0-9A-F]{4})/i)
    const serial = (serialMatch && serialMatch[1]) ? serialMatch[1].replace('-', '').toUpperCase() : ''
    const info = { serial, label }
    cache.set(drive, info)
    return info
  } catch {
    cache.set(drive, { serial: '', label: '' })
    return { serial: '', label: '' }
  }
}

/** Convenience for callers that only care about the serial. */
export function getVolumeSerial(driveRoot: string): string {
  return getVolumeInfo(driveRoot).serial
}

/** Test-only: clear the in-process cache (e.g., when a card is reformatted). */
export function clearVolumeCache(): void {
  cache.clear()
}
