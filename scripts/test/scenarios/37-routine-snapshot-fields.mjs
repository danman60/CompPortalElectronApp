/**
 * 37-routine-snapshot-fields — every routine in snapshot has the expected
 * shape. Catches schema drift if the snapshot handler ever drops a field.
 */
export const name = 'Routine schema in snapshot stable'
export const description = 'Every routine has id/entryNumber/status/photoCount/recording fields'

export async function run(api) {
  const snap = (await api.snapshot()).body
  api.assert(Array.isArray(snap.routines), 'routines array')
  for (const r of snap.routines) {
    api.assert(typeof r.id === 'string' && r.id.length > 0, `routine.id non-empty`)
    api.assert(typeof r.entryNumber === 'string' || typeof r.entryNumber === 'number', `entryNumber present`)
    api.assert(typeof r.routineTitle === 'string', `routineTitle string`)
    api.assert(typeof r.status === 'string', `status string`)
    api.assert(typeof r.photoCount === 'number', `photoCount number`)
    api.assert(typeof r.encodedFileCount === 'number', `encodedFileCount number`)
    api.assert(r.recordingStartedAt === undefined || r.recordingStartedAt === null || typeof r.recordingStartedAt === 'string', 'recordingStartedAt typed')
    api.assert(r.recordingStoppedAt === undefined || r.recordingStoppedAt === null || typeof r.recordingStoppedAt === 'string', 'recordingStoppedAt typed')
  }
  return { ok: true }
}
