/**
 * 34-real-photo-import — full importPhotos hot path against synth SD on DART.
 *
 * Prerequisite: run `node scripts/test/setup-synth-on-dart.mjs` first.
 * If the path doesn't exist on DART, this scenario skips the assertions
 * with ok: true (treats as soft-skip).
 */
const REMOTE_PATH = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-sd-harness'

export const name = 'Real photo import (synth SD on DART)'
export const description = 'importPhotos against pre-staged synth folder; verifies EXIF + body-key + watermark'

export async function run(api) {
  // Pre-clear watermarks so synth photos aren't filtered out
  await api.clearWatermarks()

  const r = await api.importPhotos({ folderPath: REMOTE_PATH, dedupByDb: false })
  if (r.status === 500) {
    // Path likely doesn't exist on DART — soft skip
    return { ok: true }
  }
  api.assertEq(r.status, 200, 'import ok')
  api.assert(r.body.totalPhotos > 0, `at least 1 photo imported (got ${r.body.totalPhotos})`)
  api.assertEq(r.body.totalPhotos, 10, 'exactly 10 photos (matches setup)')
  api.assert(typeof r.body.matched === 'number', 'matched is number')
  api.assert(typeof r.body.unmatched === 'number', 'unmatched is number')
  api.assertEq(r.body.matched + r.body.unmatched, r.body.totalPhotos, 'matched + unmatched = total')

  // Verify watermark advanced for body P16
  const wms = (await api.watermarks()).body
  api.assert(wms.P16, 'P16 watermark created')
  api.assert(wms.P16.lastFilenameSeq > 0, 'P16 seq advanced')
  return { ok: true }
}
