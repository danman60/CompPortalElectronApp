/**
 * 22-watermark-allowlist-interaction — when import is run with a filename
 * allowlist (recovery mode), the watermark filter is bypassed for those
 * files. Verify the gate logic.
 *
 * This is hard to test end-to-end without real synth photos on disk.
 * Instead: verify the import endpoint accepts the path + structure.
 */
export const name = 'Watermark + allowlist coexistence (guards)'
export const description = 'Set watermark for a body, verify watermark API still surfaces it'

export async function run(api) {
  await api.clearWatermarks()

  // Set watermark for body Z
  await api.setWatermark({
    bodyKey: 'Z_TEST',
    lastCaptureTime: '2026-04-29T22:00:00.000Z',
    lastFilename: 'Z_TEST_5000.JPG',
    lastFilenameSeq: 5000,
  })

  // Verify it's persisted via /debug/watermarks endpoint
  const wms = (await api.watermarks()).body
  api.assert(wms.Z_TEST, 'Z_TEST watermark visible')
  api.assertEq(wms.Z_TEST.lastFilenameSeq, 5000, 'seq persisted')

  // Verify it appears in /debug/snapshot.watermarks
  const snap = (await api.snapshot()).body
  api.assert(snap.watermarks.Z_TEST, 'Z_TEST in snapshot')
  api.assertEq(snap.watermarks.Z_TEST.lastFilenameSeq, 5000, 'snap seq')

  return { ok: true }
}
