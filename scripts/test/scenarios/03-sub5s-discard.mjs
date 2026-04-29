/**
 * 03-sub5s-discard — Phase 4.2 guard: takes < 5s discarded silently.
 * Take row gets archivedPath + currentRoutineId cleared.
 */
export const name = 'Phase 4.2 sub-5s discard'
export const description = 'Sub-5s take routes to discard, take detached from routine'

export async function run(api) {
  const start = await api.recordingStart({})
  api.assertEq(start.status, 200)
  const takeId = start.body.takeId

  const stop = await api.recordingStop({
    takeId,
    mkvPath: '/tmp/synth-tap-stop.mkv',
    durationSec: 3,
  })
  api.assertEq(stop.status, 200)
  api.assertEq(stop.body.action, 'sub-5s-discard', 'sub-5s discard action')

  const snap = (await api.snapshot()).body
  const take = snap.takes.find((t) => t.takeId === takeId)
  api.assert(take, 'take row preserved (not deleted)')
  api.assert(take.archivedPath, 'archivedPath set to discard location')
  api.assertEq(take.currentRoutineId, null, 'currentRoutineId cleared')
  api.assertEq(take.mkvPath, null, 'mkvPath cleared (file moved)')
  return { ok: true }
}
