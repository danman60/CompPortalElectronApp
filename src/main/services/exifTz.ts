/**
 * Phase 2.6 — TZ contract helper.
 *
 * Single source of truth for interpreting EXIF DateTimeOriginal stamps.
 *
 * Contract (operator-confirmed 2026-04-29):
 *   EXIF DateTimeOriginal is **camera-local time**, which is the same as the
 *   operator's machine local time (the operator sets each camera body's clock
 *   to match the recording machine before shooting). The string carries NO
 *   timezone marker. We MUST interpret it as local — never append `+00:00`,
 *   never append `Z`, never apply any UTC offset.
 *
 * Rationale:
 *   UDC Toronto 2026-04-26 incident — 3,514 photos got corrupted timestamps
 *   because a recovery script appended `+00:00` to a naked EXIF string,
 *   shifting them by 4–5 hours into the wrong routine windows. CSE app-side
 *   code has always been correct (uses `new Date('YYYY-MM-DDTHH:MM:SS')`
 *   which JS parses as local) — this helper exists to make that contract
 *   explicit + impossible to drift from in future code.
 *
 * If you need to read EXIF DateTimeOriginal anywhere in CSE main process,
 * use `parseExifLocalDate()` here. Don't roll your own.
 */

import { logger } from '../logger'

/**
 * Parse an EXIF DateTimeOriginal string ("YYYY:MM:DD HH:MM:SS") as local time
 * in the operator's machine timezone. Returns null on malformed input.
 *
 * @example parseExifLocalDate('2026:04:29 14:32:08') → Date in operator-local TZ
 */
export function parseExifLocalDate(dateTimeOriginal: string): Date | null {
  if (!dateTimeOriginal || typeof dateTimeOriginal !== 'string') return null
  const [datePart, timePart] = dateTimeOriginal.trim().split(' ')
  if (!datePart || !timePart) return null
  // Convert "YYYY:MM:DD" → "YYYY-MM-DD" and assemble ISO-8601 LOCAL form.
  // Critical: NO trailing Z, NO +HH:MM offset. JS Date constructor on
  // "YYYY-MM-DDTHH:MM:SS" (no offset) parses as local time, which is what
  // the operator-machine-TZ contract requires.
  const isoLocal = datePart.replace(/:/g, '-') + 'T' + timePart
  const d = new Date(isoLocal)
  if (isNaN(d.getTime())) return null
  return d
}

/**
 * Sanity check helper — call this when in doubt about whether code is
 * accidentally treating an EXIF stamp as UTC. Logs a warning if the year
 * is outside [2010, 2050] or if the date appears wildly off from "now."
 *
 * Not used in the hot path; available for forensic diagnostics.
 */
export function exifSanityCheck(d: Date, context: string): void {
  const y = d.getFullYear()
  if (y < 2010 || y > 2050) {
    logger.photos.warn(`exifSanityCheck: implausible year ${y} (context=${context}) — TZ corruption suspected`)
    return
  }
  const ageDays = Math.abs((Date.now() - d.getTime()) / 86_400_000)
  if (ageDays > 365 * 10) {
    logger.photos.warn(`exifSanityCheck: timestamp ${d.toISOString()} is ${Math.round(ageDays)} days from now (context=${context})`)
  }
}
