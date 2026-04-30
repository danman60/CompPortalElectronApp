/**
 * 29-watermark-survives-stress — set 30 watermarks across different bodies,
 * verify all visible + isolated.
 */
export const name = 'Watermarks scale (30+ bodies)'
export const description = 'Set watermarks for 30 distinct bodies, all isolated'

export async function run(api) {
  await api.clearWatermarks()
  const bodyKeys = []
  for (let i = 0; i < 30; i++) {
    const bodyKey = `STRESS_${String(i).padStart(2, '0')}`
    bodyKeys.push(bodyKey)
    const r = await api.setWatermark({
      bodyKey,
      lastCaptureTime: new Date(2026, 3, 29, 12, i, 0).toISOString(),
      lastFilenameSeq: i * 100,
    })
    api.assertEq(r.status, 200, `set ${bodyKey}`)
  }

  const wms = (await api.watermarks()).body
  for (const bk of bodyKeys) {
    api.assert(wms[bk], `${bk} present`)
  }
  api.assertEq(Object.keys(wms).filter((k) => k.startsWith('STRESS_')).length, 30, 'all 30 retrievable')

  // Verify isolation: each has its own seq
  for (let i = 0; i < 30; i++) {
    api.assertEq(wms[bodyKeys[i]].lastFilenameSeq, i * 100, `${bodyKeys[i]} seq isolated`)
  }
  return { ok: true }
}
