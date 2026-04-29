/**
 * 05-watermark-tiebreaker — Phase 2.3 burst-mode tiebreaker:
 * setSdWatermark + setSdWatermark with same lastCaptureTime + lower seq → ignored
 * setSdWatermark with same lastCaptureTime + higher seq → bumped
 * Legacy watermark (no seq) preserved (legacy fallback in fix 3789450)
 */
export const name = 'Phase 2.3 watermark tiebreaker'
export const description = 'Watermark gate + burst-mode tiebreaker via setSdWatermark API'

export async function run(api) {
  await api.clearWatermarks()

  // Set initial watermark
  let res = await api.setWatermark({
    bodyKey: 'P16',
    lastCaptureTime: '2026-04-29T18:30:45.000Z',
    lastFilename: 'P1605000.JPG',
    lastFilenameSeq: 5000,
  })
  api.assertEq(res.status, 200)
  api.assertEq(res.body.watermark.lastFilenameSeq, 5000, 'initial seq=5000')

  // Try to set same time + lower seq → should NOT bump
  res = await api.setWatermark({
    bodyKey: 'P16',
    lastCaptureTime: '2026-04-29T18:30:45.000Z',
    lastFilename: 'P1604999.JPG',
    lastFilenameSeq: 4999,
  })
  api.assertEq(res.status, 200)
  // After this call, the wm should still be at seq 5000 (not 4999)
  const wm = (await api.watermarks()).body
  api.assertEq(wm.P16.lastFilenameSeq, 5000, 'no regression on lower seq')

  // Same time + higher seq → bump
  res = await api.setWatermark({
    bodyKey: 'P16',
    lastCaptureTime: '2026-04-29T18:30:45.000Z',
    lastFilename: 'P1605001.JPG',
    lastFilenameSeq: 5001,
  })
  api.assertEq(res.status, 200)
  const wm2 = (await api.watermarks()).body
  api.assertEq(wm2.P16.lastFilenameSeq, 5001, 'bumped to seq 5001')

  // Newer time → bumps regardless of seq
  res = await api.setWatermark({
    bodyKey: 'P16',
    lastCaptureTime: '2026-04-29T18:30:46.000Z',
    lastFilename: 'P1604000.JPG',
    lastFilenameSeq: 4000,
  })
  api.assertEq(res.status, 200)
  const wm3 = (await api.watermarks()).body
  api.assertEq(wm3.P16.lastCaptureTime, '2026-04-29T18:30:46.000Z', 'time advanced')
  api.assertEq(wm3.P16.lastFilenameSeq, 4000, 'seq replaced (newer time)')
  return { ok: true }
}
