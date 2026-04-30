/**
 * 30-clear-state-clean — clearState({clearRoutineRecordings: true}) leaves
 * routines in pending status with no recording fields. Verifies the test
 * harness reset path.
 */
export const name = 'clearState({clearRoutineRecordings: true}) leaves clean routines'
export const description = 'After clear, no routine has recordingStartedAt/StoppedAt'

export async function run(api) {
  // Set up: inject a take that updates a routine to recorded status
  const routines = (await api.routines()).body
  const r1 = routines[0]
  const start = await api.recordingStart({ routineId: r1.id })
  await api.recordingStop({ takeId: start.body.takeId, mkvPath: 'C:\\test\\clean.mkv', durationSec: 30 })

  // Verify routine is now 'recorded'
  let snap = (await api.snapshot()).body
  let r1Snap = snap.routines.find((r) => r.id === r1.id)
  api.assertEq(r1Snap.status, 'recorded', 'routine is recorded')
  api.assert(r1Snap.recordingStartedAt, 'startedAt set')

  // Clear with clearRoutineRecordings=true
  const clear = await api.clearState({ clearRoutineRecordings: true })
  api.assertEq(clear.status, 200)
  api.assertEq(clear.body.routineRecordingsCleared, true)

  // Now verify the routine is back to pending
  snap = (await api.snapshot()).body
  r1Snap = snap.routines.find((r) => r.id === r1.id)
  api.assertEq(r1Snap.status, 'pending', 'routine reverted to pending')
  api.assert(!r1Snap.recordingStartedAt, 'startedAt cleared')
  api.assert(!r1Snap.recordingStoppedAt, 'stoppedAt cleared')
  return { ok: true }
}
