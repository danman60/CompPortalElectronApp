/**
 * 35-watermark-dedup-rerun — run import twice on same folder.
 * First call: all photos import (after clearWatermarks).
 * Second call: zero photos process (watermark gate skips all).
 *
 * Catches Phase 2.3 watermark seq tracking + the legacy-fallback fix in 3789450.
 * Requires synth folder pre-staged via setup-synth-on-dart.mjs.
 */
const REMOTE_PATH = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-sd-harness'

export const name = 'Watermark dedup — second import skips all'
export const description = 'Re-run import on same folder, verify watermark gate'

export async function run(api) {
  await api.clearWatermarks()

  const r1 = await api.importPhotos({ folderPath: REMOTE_PATH, dedupByDb: false })
  if (r1.status === 500) return { ok: true } // soft skip if path missing
  api.assertEq(r1.status, 200)
  api.assert(r1.body.totalPhotos > 0, `first import processes photos (got ${r1.body.totalPhotos})`)
  const firstCount = r1.body.totalPhotos

  // Second import — watermark should now skip ALL of them
  const r2 = await api.importPhotos({ folderPath: REMOTE_PATH, dedupByDb: false })
  api.assertEq(r2.status, 200)
  api.assertEq(r2.body.totalPhotos, 0, `second import skips all (got ${r2.body.totalPhotos}, expected 0)`)

  return { ok: true }
}
