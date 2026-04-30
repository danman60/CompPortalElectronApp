/**
 * 38-malformed-snapshot-resilience — even with degenerate state (orphan
 * takes, dangling routine refs, weird watermarks), snapshot must NOT 500.
 */
export const name = 'Snapshot resilient to degenerate state'
export const description = 'Inject many orphan takes + bad watermarks, snapshot still 200'

export async function run(api) {
  // Inject 5 orphan takes (no routine link)
  for (let i = 0; i < 5; i++) {
    await api.injectTake({
      startedAt: `2099-12-31T${String(i).padStart(2, '0')}:00:00.000Z`,
      stoppedAt: `2099-12-31T${String(i).padStart(2, '0')}:01:00.000Z`,
      currentRoutineId: null,
    })
  }
  // Inject takes with bogus routine refs
  for (let i = 0; i < 5; i++) {
    await api.injectTake({
      startedAt: `2099-12-31T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
      stoppedAt: null, // in-flight!
      currentRoutineId: `bogus-${i}`,
    })
  }
  // Add weird watermark
  await api.setWatermark({ bodyKey: '', lastCaptureTime: 'invalid' })

  const r = await api.snapshot()
  api.assertEq(r.status, 200, 'snapshot survived degenerate state')
  api.assert(Array.isArray(r.body.takes), 'takes still array')

  // /debug/state should also survive
  const s = await api.state()
  api.assertEq(s.status, 200, 'state survived')
  return { ok: true }
}
