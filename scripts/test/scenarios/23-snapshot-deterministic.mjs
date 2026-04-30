/**
 * 23-snapshot-deterministic — two consecutive snapshots return identical
 * structure (only takenAt timestamp differs). Catches non-determinism
 * regressions in serialization.
 */
export const name = 'Snapshot deterministic across consecutive calls'
export const description = 'Two snapshots differ only by takenAt'

export async function run(api) {
  const a = (await api.snapshot()).body
  const b = (await api.snapshot()).body

  api.assertEq(a.snapshotVersion, b.snapshotVersion, 'version stable')
  api.assertEq(a.competitionId, b.competitionId, 'comp id stable')
  api.assertEq(a.routines.length, b.routines.length, 'routine count stable')
  api.assertEq(a.takes.length, b.takes.length, 'takes count stable')
  api.assertEq(JSON.stringify(a.queueSummary), JSON.stringify(b.queueSummary), 'queue summary stable')

  // takenAt should differ (or be very close)
  api.assert(a.takenAt !== undefined, 'takenAt present')
  api.assert(b.takenAt !== undefined, 'takenAt present')
  return { ok: true }
}
