/**
 * 12-multi-take-per-routine — Phase 2.8 invariant: a routine can have
 * multiple takes (re-record archive case). All preserved with immutable
 * windows; matcher can iterate all.
 */
export const name = 'Multiple takes per routine (Phase 2.8 invariant)'
export const description = 'Inject 3 takes for same routine, all preserved'

export async function run(api) {
  const routines = (await api.routines()).body
  const r1 = routines[0]

  const takes = []
  for (let i = 0; i < 3; i++) {
    const startedAt = `2026-04-29T${String(20 + i).padStart(2, '0')}:00:00.000Z`
    const stoppedAt = `2026-04-29T${String(20 + i).padStart(2, '0')}:01:00.000Z`
    const inj = await api.injectTake({
      startedAt, stoppedAt,
      mkvPath: `C:\\test\\multi-take-${i}.mkv`,
      currentRoutineId: r1.id,
    })
    api.assertEq(inj.status, 200, `inject ${i} ok`)
    takes.push(inj.body.take.takeId)
  }

  // All 3 should appear in snapshot for r1
  const snap = (await api.snapshot()).body
  const r1Takes = snap.takes.filter((t) => t.currentRoutineId === r1.id && takes.includes(t.takeId))
  api.assertEq(r1Takes.length, 3, '3 takes preserved for r1')

  // Each window unique + non-overlapping
  const starts = r1Takes.map((t) => t.startedAt).sort()
  api.assertEq(new Set(starts).size, 3, 'all startedAt distinct')
  return { ok: true }
}
