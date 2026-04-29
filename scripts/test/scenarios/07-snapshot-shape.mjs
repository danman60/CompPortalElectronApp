/**
 * 07-snapshot-shape — verify /debug/snapshot returns deterministic schema.
 * Catches accidental field renames or new mandatory fields drifting silently.
 */
export const name = 'Snapshot schema integrity'
export const description = 'Snapshot has all expected top-level + nested fields'

export async function run(api) {
  const snap = (await api.snapshot()).body
  api.assertEq(typeof snap.snapshotVersion, 'number', 'snapshotVersion exists')
  api.assertEq(snap.snapshotVersion, 1, 'snapshotVersion=1')
  api.assert(Array.isArray(snap.routines), 'routines array')
  api.assert(Array.isArray(snap.takes), 'takes array')
  api.assert(snap.queueSummary, 'queueSummary present')
  api.assert(typeof snap.queueSummary.total === 'number', 'queueSummary.total numeric')
  api.assert(snap.relevantSettings, 'relevantSettings present')
  api.assert(typeof snap.relevantSettings.testHooksEnabled === 'boolean', 'testHooksEnabled key present')
  // Per-routine schema
  if (snap.routines.length > 0) {
    const r = snap.routines[0]
    for (const k of ['id', 'entryNumber', 'routineTitle', 'status', 'photoCount', 'encodedFileCount']) {
      api.assert(k in r, `routine[0].${k} present`)
    }
  }
  // Per-take schema
  if (snap.takes.length > 0) {
    const t = snap.takes[0]
    for (const k of ['takeId', 'startedAt', 'stoppedAt', 'mkvPath', 'currentRoutineId']) {
      api.assert(k in t, `take[0].${k} present`)
    }
  }
  return { ok: true }
}
