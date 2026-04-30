/**
 * 19-active-take-sync — verify state.takes[] in-flight take + _active_take.json
 * stay in sync via the recording lifecycle (start/stop endpoints).
 *
 * The "active take" is by definition: the row in state.takes whose stoppedAt
 * is null. If recording.start runs and writes both _active_take.json AND adds
 * to state.takes, we should see exactly one in-flight take at all times.
 */
export const name = 'Active take ↔ state.takes sync'
export const description = 'Exactly one take with stoppedAt=null while recording'

export async function run(api) {
  // Start a recording via test endpoint
  const start = await api.recordingStart({})
  api.assertEq(start.status, 200)
  const takeId = start.body.takeId

  let snap = (await api.snapshot()).body
  let inFlight = snap.takes.filter((t) => t.stoppedAt === null)
  api.assertEq(inFlight.length, 1, 'exactly one in-flight take while recording')
  api.assertEq(inFlight[0].takeId, takeId, 'in-flight = our take')

  // Stop it
  await api.recordingStop({ takeId, mkvPath: 'C:\\test\\active-sync.mkv', durationSec: 30 })
  snap = (await api.snapshot()).body
  inFlight = snap.takes.filter((t) => t.stoppedAt === null)
  api.assertEq(inFlight.length, 0, 'zero in-flight takes after stop')
  return { ok: true }
}
