/**
 * 32-take-uuid-uniqueness — every take has a unique takeId. Catches UUID
 * generation regressions or persistence collisions.
 */
export const name = 'Take UUIDs are unique'
export const description = 'No two takes share takeId'

export async function run(api) {
  const snap = (await api.snapshot()).body
  const ids = snap.takes.map((t) => t.takeId)
  const set = new Set(ids)
  api.assertEq(ids.length, set.size, `${ids.length - set.size} duplicate takeId(s)`)
  // Each ID should be a valid UUID-ish string
  for (const id of ids) {
    api.assert(typeof id === 'string', `takeId is string`)
    api.assert(id.length >= 32, `takeId looks UUID-shaped (${id.length} chars)`)
  }
  return { ok: true }
}
