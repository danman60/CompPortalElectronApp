/**
 * 33-snapshot-version-stable — snapshotVersion is exactly 1 in this build.
 * If we bump it, we're committing to a schema-versioning protocol.
 */
export const name = 'Snapshot version pinned at 1'
export const description = 'Catches accidental version bumps without explicit decision'

export async function run(api) {
  const snap = (await api.snapshot()).body
  api.assertEq(snap.snapshotVersion, 1, 'snapshot version 1')
  return { ok: true }
}
