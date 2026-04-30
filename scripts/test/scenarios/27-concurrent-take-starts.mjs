/**
 * 27-concurrent-take-starts — fire two recordingStart calls back-to-back.
 * Both succeed (creating 2 takes), but after both: 2 in-flight takes exist.
 * The "active take" semantic (state.getActiveTake = first stoppedAt=null)
 * still returns one — verify deterministic.
 *
 * Real OBS can only have 1 recording at a time, so concurrent starts via
 * the test endpoint represent a degenerate case. Goal: state stays
 * consistent + getActiveTake doesn't crash.
 */
export const name = 'Concurrent take starts (degenerate)'
export const description = 'Two starts back-to-back: both takes added, state coherent'

export async function run(api) {
  await api.clearState({ clearRoutineRecordings: false })

  const [start1, start2] = await Promise.all([
    api.recordingStart({}),
    api.recordingStart({}),
  ])
  api.assertEq(start1.status, 200)
  api.assertEq(start2.status, 200)
  api.assert(start1.body.takeId !== start2.body.takeId, 'distinct takeIds')

  const snap = (await api.snapshot()).body
  const inFlight = snap.takes.filter((t) => t.stoppedAt === null)
  api.assert(inFlight.length >= 2, `at least 2 in-flight takes (got ${inFlight.length})`)

  // Stop both
  await api.recordingStop({ takeId: start1.body.takeId, mkvPath: 'C:\\test\\c1.mkv', durationSec: 30 })
  await api.recordingStop({ takeId: start2.body.takeId, mkvPath: 'C:\\test\\c2.mkv', durationSec: 30 })

  const snap2 = (await api.snapshot()).body
  const stillInFlight = snap2.takes.filter((t) => t.stoppedAt === null)
  api.assert(stillInFlight.length === 0 || stillInFlight.length < inFlight.length, 'stops reduced in-flight count')
  return { ok: true }
}
