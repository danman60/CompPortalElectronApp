/**
 * 06-take-window-immutable — verify Take.startedAt/stoppedAt never mutate
 * once finalized, even on subsequent stop attempts.
 */
export const name = 'Take window immutability'
export const description = 'setTakeStopped is idempotent; second stop is rejected'

export async function run(api) {
  const start = await api.recordingStart({})
  const takeId = start.body.takeId
  const stoppedAt = '2026-04-29T19:00:00.000Z'

  await api.recordingStop({ takeId, mkvPath: '/tmp/synth.mkv', durationSec: 60, timestamp: stoppedAt })
  let snap = (await api.snapshot()).body
  let take = snap.takes.find((t) => t.takeId === takeId)
  api.assertEq(take.stoppedAt, stoppedAt, 'first stop wins')

  // Try to stop again with different timestamp — should be ignored (state.setTakeStopped logs warn + no-ops)
  const stoppedAt2 = '2026-04-29T20:00:00.000Z'
  await api.recordingStop({ takeId, mkvPath: '/tmp/synth2.mkv', durationSec: 60, timestamp: stoppedAt2 })
  snap = (await api.snapshot()).body
  take = snap.takes.find((t) => t.takeId === takeId)
  api.assertEq(take.stoppedAt, stoppedAt, 'stoppedAt did not mutate on second stop')
  api.assertEq(take.mkvPath, '/tmp/synth.mkv', 'mkvPath did not mutate')
  return { ok: true }
}
