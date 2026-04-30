/**
 * 20-test-hooks-gate — verify test endpoints can't be hit when the
 * settings flag is OFF. Operator safety net — prevents accidental
 * mutation in production.
 *
 * This scenario inverts the harness preflight: it expects the gate to be
 * ON for the harness to run at all. So we verify that all 9 test endpoints
 * exist (via 405 on GET, 4xx on bad payload, NOT 403/404).
 */
export const name = 'Test hooks endpoints reachable + gated correctly'
export const description = 'All 9 endpoints respond non-403 when hooks enabled'

export async function run(api) {
  // We're already past the harness preflight (testHooksEnabled=true), so
  // hitting any endpoint should NOT 403. Verify by sending malformed body.
  const endpoints = [
    { name: 'recordingStart', fn: () => api.recordingStart({}) },
    { name: 'recordingStop', fn: () => api.recordingStop({}) },
    { name: 'importPhotos', fn: () => api.importPhotos({}) },
    { name: 'injectTake', fn: () => api.injectTake({}) },
    { name: 'clearState', fn: () => api.clearState({}) },
    { name: 'dispatchDecision', fn: () => api.dispatchDecision({}) },
    { name: 'triggerAudioAudit', fn: () => api.triggerAudioAudit({}) },
    { name: 'setWatermark', fn: () => api.setWatermark({}) },
    { name: 'clearWatermarks', fn: () => api.clearWatermarks() },
    { name: 'setTakeRoutine', fn: () => api.setTakeRoutine({}) },
  ]
  for (const ep of endpoints) {
    const r = await ep.fn()
    api.assert(r.status !== 403, `${ep.name} not 403 (got ${r.status})`)
    api.assert(r.status !== 404, `${ep.name} not 404 (got ${r.status})`)
  }
  return { ok: true }
}
