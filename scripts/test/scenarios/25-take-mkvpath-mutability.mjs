/**
 * 25-take-mkvpath-mutability — Take.mkvPath is set on stop, then can be
 * updated to a post-rename path (handleRecordingStopped does this in the
 * real flow). Verify setTakeMkvPath via inject + recordingStop.
 */
export const name = 'Take mkvPath set on stop, immutable startedAt/stoppedAt'
export const description = 'Recording stop sets mkvPath; immutable fields stay'

export async function run(api) {
  // Start a recording
  const start = await api.recordingStart({})
  const takeId = start.body.takeId
  const startedAt = start.body.startedAt

  // Stop with explicit mkvPath
  const mkvPath = 'C:\\test\\mutability.mkv'
  await api.recordingStop({ takeId, mkvPath, durationSec: 30 })

  let snap = (await api.snapshot()).body
  let take = snap.takes.find((t) => t.takeId === takeId)
  api.assert(take, 'take present')
  api.assertEq(take.startedAt, startedAt, 'startedAt unchanged')
  api.assertEq(take.mkvPath, mkvPath, 'mkvPath set')
  api.assert(take.stoppedAt, 'stoppedAt set')

  // Try to stop again — should be ignored (state.setTakeStopped no-ops on
  // already-stopped takes)
  const before = take.mkvPath
  const beforeStoppedAt = take.stoppedAt
  await api.recordingStop({ takeId, mkvPath: 'C:\\different.mkv', durationSec: 60, timestamp: '2026-04-29T23:00:00.000Z' })
  snap = (await api.snapshot()).body
  take = snap.takes.find((t) => t.takeId === takeId)
  api.assertEq(take.mkvPath, before, 'mkvPath did not mutate on second stop')
  api.assertEq(take.stoppedAt, beforeStoppedAt, 'stoppedAt did not mutate on second stop')
  return { ok: true }
}
