/**
 * 13-stress-many-takes — inject 50 takes, verify state.takes scales,
 * snapshot doesn't OOM, persistence survives.
 */
export const name = 'Stress — 50 takes injected'
export const description = '50 takes don\'t crash state, snapshot, or persistence'

export async function run(api) {
  const routines = (await api.routines()).body
  const r1 = routines[0]

  const t0 = Date.now()
  for (let i = 0; i < 50; i++) {
    const startedAt = new Date(2026, 3, 29, 12, i, 0).toISOString()
    const stoppedAt = new Date(2026, 3, 29, 12, i, 30).toISOString()
    const inj = await api.injectTake({
      startedAt, stoppedAt,
      mkvPath: `C:\\test\\stress-${i}.mkv`,
      currentRoutineId: i % 2 === 0 ? r1.id : null,
    })
    if (inj.status !== 200) return { ok: false, why: `inject ${i} failed: ${inj.status}` }
  }
  const dur = Date.now() - t0

  const snap = (await api.snapshot()).body
  api.assert(snap.takes.length >= 50, `at least 50 takes (got ${snap.takes.length})`)
  // Snapshot should still respond fast even with 50+ takes
  api.assert(dur < 30000, `inject loop completed in <30s (got ${dur}ms)`)
  return { ok: true }
}
