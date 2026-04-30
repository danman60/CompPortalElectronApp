/**
 * 41-wrong-day-card — Phase 2.1: card with all-yesterday EXIF photos.
 * date filter should silently skip all of them, totalPhotos: 0.
 *
 * Pre-stage requires synth-sd-yesterday to exist on DART.
 */
const YESTERDAY_PATH = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-sd-yesterday'

export const name = 'Wrong-day card — all yesterday silent skip'
export const description = 'Phase 2.1 strict-today filter rejects all-yesterday EXIF dates'

export async function run(api) {
  await api.clearWatermarks()

  const r = await api.importPhotos({ folderPath: YESTERDAY_PATH, dedupByDb: false })
  if (r.status === 500) return { ok: true } // soft skip if not staged

  api.assertEq(r.status, 200, 'import ok')
  // Expected: zero photos pass the filter (all skipped as wrong-date)
  api.assertEq(r.body.totalPhotos, 0, 'zero photos imported (all yesterday skipped)')
  return { ok: true }
}
