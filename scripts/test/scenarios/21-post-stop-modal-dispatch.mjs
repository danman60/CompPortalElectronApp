/**
 * 21-post-stop-modal-dispatch — drive the post-stop modal IPC at the data
 * layer. Verify the dispatch-decision endpoint accepts the 3 valid kinds
 * + rejects malformed payloads.
 *
 * Note: the modal only fires from real recording.handleRecordingStopped
 * triggered by OBS. We can't synthesize that without bypassing OBS. So
 * this scenario only exercises the resolveRerecDecision IPC endpoint.
 * Verifies it doesn't crash on each kind.
 */
export const name = 'Post-stop modal — dispatchDecision IPC accepts 3 kinds'
export const description = 'Test endpoint accepts archive / specify-routine / save-as-extra without crash'

export async function run(api) {
  // Bogus proposalId — should fail gracefully (no resolver registered)
  const r1 = await api.dispatchDecision({
    proposalId: 'bogus-' + Date.now(),
    decision: { kind: 'archive' },
  })
  // The resolveRerecDecision returns silently if no resolver registered.
  // The endpoint returns 200 ok regardless.
  api.assertEq(r1.status, 200, 'archive kind accepted')

  const r2 = await api.dispatchDecision({
    proposalId: 'bogus-2-' + Date.now(),
    decision: { kind: 'specify-routine', routineId: '00000000-0000-0000-0000-000000000000' },
  })
  api.assertEq(r2.status, 200, 'specify-routine kind accepted')

  const r3 = await api.dispatchDecision({
    proposalId: 'bogus-3-' + Date.now(),
    decision: { kind: 'save-as-extra', emptyRoutineNumber: '999.5' },
  })
  api.assertEq(r3.status, 200, 'save-as-extra kind accepted')

  // Missing proposalId
  const r4 = await api.dispatchDecision({ decision: { kind: 'archive' } })
  api.assertEq(r4.status, 400, 'missing proposalId rejected')

  return { ok: true }
}
