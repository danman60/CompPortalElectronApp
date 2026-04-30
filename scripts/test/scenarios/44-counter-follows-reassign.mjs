/**
 * 44-counter-follows-reassign — Phase 1.9 (rescoped).
 *
 * The burned-in upper-right routine counter MUST update when the operator
 * overrides the recording target via either path:
 *   (1) click-to-reassign mid-recording (Item 17 / A54)
 *   (2) SAVE-AS-EMPTY-ROUTINE number entry
 *
 * Both paths fire RECORDING_REASSIGN_TARGET in production. Pre-fix the
 * IPC handler called recording.broadcastFullState() (debounced), which
 * skipped overlay sync. Post-fix it calls broadcastFullStateImmediate()
 * which fires syncOverlayFromCurrent → overlay.updateRoutineData with the
 * new entryNumber.
 *
 * Test surface: /debug/test/recording/reassign mimics the post-fix IPC
 * handler. /debug/snapshot exposes overlay.counterEntryNumber.
 */
export const name = 'Burned-in counter follows reassign (Phase 1.9 rescoped)'
export const description = 'Reassign mid-recording → overlay counter updates to new routine'

export async function run(api) {
  const routines = (await api.routines()).body
  api.assert(routines.length >= 2, 'at least 2 routines for reassign')
  const r1 = routines[0]
  const r2 = routines[1]

  // Start recording on r1
  const start = await api.recordingStart({ routineId: r1.id })
  api.assertEq(start.status, 200, `start ok (got ${start.status}: ${JSON.stringify(start.body)})`)

  // After start, overlay counter should be on r1's entry number
  let snap = (await api.snapshot()).body
  api.assert(snap.overlay, 'snapshot exposes overlay')
  api.assertEq(snap.overlay.counterEntryNumber, r1.entryNumber, `overlay starts on r1=${r1.entryNumber}`)

  // Reassign to r2 via the test endpoint (mimics IPC handler)
  const reassign = await api.reassignRecording({
    newRoutineId: r2.id,
    takeStartedAt: new Date().toISOString(),
  })
  api.assertEq(reassign.status, 200, `reassign ok (got ${reassign.status}: ${JSON.stringify(reassign.body)})`)
  api.assertEq(reassign.body.newEntryNumber, r2.entryNumber, 'reassign returns r2 entryNumber')

  // CRITICAL: overlay counter must now reflect r2
  snap = (await api.snapshot()).body
  api.assertEq(
    snap.overlay.counterEntryNumber,
    r2.entryNumber,
    `overlay counter updated to r2=${r2.entryNumber} (got ${snap.overlay.counterEntryNumber})`,
  )

  // Phase 1.10 (rescoped) — the take that just got reassigned must be
  // flagged manuallyRecovered = true. Snapshot exposes the flag.
  const activeTake = snap.takes.find((t) => t.currentRoutineId === r2.id && !t.stoppedAt)
  api.assert(activeTake, 'active take exists on r2 after reassign')
  api.assertEq(
    activeTake.manuallyRecovered,
    true,
    `active take flagged manuallyRecovered=true (got ${activeTake.manuallyRecovered})`,
  )

  // Cleanup: stop and clear so subsequent scenarios start fresh
  await api.recordingStop({ durationSec: 5 })
  await api.clearState()

  return { ok: true }
}
