/**
 * 11-take-reassign-mutation — verify Take.currentRoutineId mutates while
 * startedAt/stoppedAt/mkvPath stay immutable. Models the post-stop modal's
 * "Specify Routine" + Item 17 click-to-reassign flow.
 */
export const name = 'Take reassign — currentRoutineId mutable, window immutable'
export const description = 'setTakeRoutine swaps routineId without losing window'

export async function run(api) {
  const routines = (await api.routines()).body
  if (routines.length < 2) return { ok: false, why: 'need 2+ routines' }
  const r1 = routines[0]
  const r2 = routines[1]

  const startedAt = '2026-04-29T20:30:00.000Z'
  const stoppedAt = '2026-04-29T20:31:00.000Z'
  const inj = await api.injectTake({
    startedAt, stoppedAt,
    mkvPath: 'C:\\test\\reassign-test.mkv',
    currentRoutineId: r1.id,
  })
  api.assertEq(inj.status, 200)
  const takeId = inj.body.take.takeId

  const reassign = await api.setTakeRoutine({ takeId, routineId: r2.id })
  api.assertEq(reassign.status, 200, 'reassign ok')
  api.assertEq(reassign.body.before.currentRoutineId, r1.id, 'before = r1')
  api.assertEq(reassign.body.after.currentRoutineId, r2.id, 'after = r2')
  api.assertEq(reassign.body.windowImmutable, true, 'window did not mutate')

  // Reassign back
  const reassign2 = await api.setTakeRoutine({ takeId, routineId: r1.id })
  api.assertEq(reassign2.body.after.currentRoutineId, r1.id, 'reassigned back to r1')

  // Detach (currentRoutineId = null)
  const detach = await api.setTakeRoutine({ takeId, routineId: null })
  api.assertEq(detach.body.after.currentRoutineId, null, 'detached')

  // Verify snapshot reflects final state
  const snap = (await api.snapshot()).body
  const t = snap.takes.find((x) => x.takeId === takeId)
  api.assertEq(t.startedAt, startedAt, 'startedAt still immutable after 3 reassigns')
  api.assertEq(t.stoppedAt, stoppedAt, 'stoppedAt still immutable after 3 reassigns')
  api.assertEq(t.mkvPath, 'C:\\test\\reassign-test.mkv', 'mkvPath still immutable')
  return { ok: true }
}
