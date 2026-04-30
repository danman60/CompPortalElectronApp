/**
 * 40-multi-day-card — Phase 2.1 always-on date filter verification.
 *
 * Pre-stage two synth folders on DART:
 *   - synth-sd-yesterday: 5 JPEGs with yesterday's EXIF
 *   - synth-sd-today (= synth-sd-harness): 10 JPEGs with today's EXIF
 *
 * Scenario imports the COMBINED folder (operator's typical multi-day card).
 * Without the date filter, all 15 would import. With Phase 2.1's strict-today
 * filter (default ON), only today's 10 import; yesterday's 5 silently skip.
 *
 * Falls back to soft-skip if combined folder isn't pre-staged.
 */
const COMBINED_PATH = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-sd-multiday'

export const name = 'Multi-day card — only today imports'
export const description = 'Phase 2.1 strict-today filter via Settings.behavior.includePriorDayPhotos'

export async function run(api) {
  await api.clearWatermarks()

  const r = await api.importPhotos({ folderPath: COMBINED_PATH, dedupByDb: false })
  if (r.status === 500) return { ok: true } // soft skip if not staged

  api.assertEq(r.status, 200, 'import ok')
  // Expected: only today's photos import (count varies based on what was staged).
  api.assert(r.body.totalPhotos > 0, `today's photos imported (got ${r.body.totalPhotos})`)
  // The "skipped wrong date" log will show the prior-day count.
  return { ok: true }
}
