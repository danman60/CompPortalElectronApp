/**
 * 10-state-persistence — inject a take, snapshot, verify it persists in
 * snapshot. (Doesn't test cross-restart persistence — that requires a
 * controlled app restart which the harness can't trigger safely.)
 */
export const name = 'Take persistence in snapshot'
export const description = 'inject take → appears in snapshot.takes'

export async function run(api) {
  const before = (await api.snapshot()).body.takes.length
  const inj = await api.injectTake({
    startedAt: '2026-04-29T20:00:00.000Z',
    stoppedAt: '2026-04-29T20:01:00.000Z',
    mkvPath: '/tmp/persist-test.mkv',
    currentRoutineId: null, // dangling on purpose
  })
  api.assertEq(inj.status, 200)
  const after = (await api.snapshot()).body.takes.length
  api.assertEq(after, before + 1, 'takes count increased by 1')
  const t = (await api.snapshot()).body.takes.find((x) => x.takeId === inj.body.take.takeId)
  api.assert(t, 'injected take retrievable')
  api.assertEq(t.mkvPath, '/tmp/persist-test.mkv', 'mkvPath roundtripped')
  return { ok: true }
}
