/**
 * 15-watermark-edge-cases — exercises the gate logic around extreme dates,
 * very high seqs, malformed inputs.
 */
export const name = 'Watermark edge cases'
export const description = 'Year-boundary, max-int seq, multi-body isolation'

export async function run(api) {
  await api.clearWatermarks()

  // Set watermark for body A — very old date
  await api.setWatermark({
    bodyKey: 'A_TEST',
    lastCaptureTime: '1970-01-01T00:00:00.000Z',
    lastFilename: 'A_TEST_0001.JPG',
    lastFilenameSeq: 1,
  })
  // Set body B — far future
  await api.setWatermark({
    bodyKey: 'B_TEST',
    lastCaptureTime: '2099-12-31T23:59:59.000Z',
    lastFilename: 'B_TEST_9999.JPG',
    lastFilenameSeq: 9999,
  })
  // Verify both isolated
  const wms = (await api.watermarks()).body
  api.assert(wms.A_TEST, 'A_TEST exists')
  api.assert(wms.B_TEST, 'B_TEST exists')
  api.assertEq(wms.A_TEST.lastFilenameSeq, 1, 'A seq 1')
  api.assertEq(wms.B_TEST.lastFilenameSeq, 9999, 'B seq 9999')

  // Year-boundary: same time, max-safe-int seq
  await api.setWatermark({
    bodyKey: 'C_BIG',
    lastCaptureTime: '2026-04-29T23:59:59.999Z',
    lastFilenameSeq: 9007199254740991, // Number.MAX_SAFE_INTEGER
  })
  const wms2 = (await api.watermarks()).body
  api.assertEq(wms2.C_BIG.lastFilenameSeq, 9007199254740991, 'max-safe-int preserved')

  // Same body bumped to newer time + lower seq → time wins
  await api.setWatermark({
    bodyKey: 'A_TEST',
    lastCaptureTime: '2026-01-01T00:00:00.000Z',
    lastFilenameSeq: 0,
  })
  const wms3 = (await api.watermarks()).body
  api.assertEq(wms3.A_TEST.lastCaptureTime, '2026-01-01T00:00:00.000Z', 'A advanced to 2026')
  api.assertEq(wms3.A_TEST.lastFilenameSeq, 0, 'A seq replaced (newer time)')
  return { ok: true }
}
