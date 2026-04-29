/**
 * 01-boot-integrity — every read endpoint returns 200 + valid JSON shape.
 * Catches startup regressions (debug server didn't start, state corrupt).
 */
export const name = 'Boot integrity'
export const description = 'All read endpoints respond with valid shape'

export async function run(api) {
  const checks = [
    { name: 'state', fn: () => api.state(), keys: ['competition', 'platform', 'memRssMb'] },
    { name: 'snapshot', fn: () => api.snapshot(), keys: ['snapshotVersion', 'routines', 'takes'] },
    { name: 'health', fn: () => api.health(), keys: ['pid', 'uptimeSec', 'memory'] },
    { name: 'queue', fn: () => api.queue(), keys: ['totalJobs', 'byStatus'] },
    { name: 'routines', fn: () => api.routines(), keys: [] },
    { name: 'watermarks', fn: () => api.watermarks(), keys: [] },
    { name: 'events', fn: () => api.events(5), keys: ['events'] },
  ]
  for (const c of checks) {
    const r = await c.fn()
    api.assertEq(r.status, 200, `${c.name} status`)
    for (const k of c.keys) {
      api.assert(r.body[k] !== undefined, `${c.name}.${k} missing`)
    }
  }
  return { ok: true }
}
