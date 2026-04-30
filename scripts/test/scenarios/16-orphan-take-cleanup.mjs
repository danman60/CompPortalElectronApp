/**
 * 16-orphan-take-cleanup — takes with currentRoutineId pointing at a
 * non-existent routine. Verify state survives, snapshot doesn't crash.
 */
export const name = 'Orphan take (currentRoutineId points nowhere)'
export const description = 'Take with bogus routineId — snapshot still works'

export async function run(api) {
  const inj = await api.injectTake({
    startedAt: '2026-04-29T21:00:00.000Z',
    stoppedAt: '2026-04-29T21:01:00.000Z',
    mkvPath: 'C:\\test\\orphan.mkv',
    currentRoutineId: '00000000-1111-2222-3333-444444444444', // doesn't exist
  })
  api.assertEq(inj.status, 200)
  const takeId = inj.body.take.takeId

  // Snapshot must still respond and show this take
  const snap = (await api.snapshot()).body
  const t = snap.takes.find((x) => x.takeId === takeId)
  api.assert(t, 'orphan take present in snapshot')
  api.assertEq(t.currentRoutineId, '00000000-1111-2222-3333-444444444444', 'orphan routineId preserved')
  return { ok: true }
}
