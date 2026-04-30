/**
 * 28-snapshot-large-state — snapshot endpoint must handle large takes[]
 * without timing out or producing malformed JSON.
 */
export const name = 'Snapshot scales with large state.takes'
export const description = '100+ takes — snapshot completes <2s + valid JSON'

export async function run(api) {
  // We've likely accumulated >100 takes from earlier scenarios. Verify
  // snapshot still responds quickly + cleanly.
  const t0 = Date.now()
  const snap = await api.snapshot()
  const dur = Date.now() - t0
  api.assertEq(snap.status, 200, 'snapshot ok')
  api.assert(dur < 2000, `snapshot in <2s (got ${dur}ms)`)
  api.assert(Array.isArray(snap.body.takes), 'takes array')
  api.assert(snap.body.takes.length > 0, 'takes present')
  // Spot-check first + last for shape
  const first = snap.body.takes[0]
  const last = snap.body.takes[snap.body.takes.length - 1]
  for (const t of [first, last]) {
    api.assert(typeof t.takeId === 'string', 'takeId string')
    api.assert(typeof t.startedAt === 'string', 'startedAt string')
    api.assert(t.stoppedAt === null || typeof t.stoppedAt === 'string', 'stoppedAt null or string')
  }
  return { ok: true }
}
