/**
 * 02-take-lifecycle — recording start → stop creates + finalizes a Take.
 * Verifies Phase 2.8 data layer at the most fundamental level.
 */
export const name = 'Take lifecycle (start → stop)'
export const description = 'Create Take on start, finalize on stop, verify state'

export async function run(api) {
  const start = await api.recordingStart({})
  api.assertEq(start.status, 200, 'start ok')
  const takeId = start.body.takeId
  api.assert(typeof takeId === 'string' && takeId.length > 0, 'takeId returned')
  const routineId = start.body.routineId
  api.assert(typeof routineId === 'string', 'routineId returned')

  // Verify take present in snapshot with stoppedAt: null
  let snap = (await api.snapshot()).body
  let take = snap.takes.find((t) => t.takeId === takeId)
  api.assert(take, `take ${takeId} present in snapshot`)
  api.assertEq(take.stoppedAt, null, 'stoppedAt null while in-flight')
  api.assertEq(take.currentRoutineId, routineId, 'currentRoutineId matches')

  // Stop with 30s duration
  const stop = await api.recordingStop({
    takeId,
    mkvPath: '/tmp/synth-finalized.mkv',
    durationSec: 30,
  })
  api.assertEq(stop.status, 200, 'stop ok')
  api.assertEq(stop.body.action, 'finalized', 'finalize action')

  // Re-snapshot: take should now have stoppedAt + mkvPath
  snap = (await api.snapshot()).body
  take = snap.takes.find((t) => t.takeId === takeId)
  api.assert(take, 'take still present')
  api.assert(take.stoppedAt, 'stoppedAt set')
  api.assertEq(take.mkvPath, '/tmp/synth-finalized.mkv', 'mkvPath set')
  api.assertEq(take.currentRoutineId, routineId, 'currentRoutineId unchanged')
  return { ok: true }
}
