/**
 * 14-bad-input-rejection — endpoints reject malformed payloads cleanly
 * (no 500 crashes, no state corruption).
 */
export const name = 'Bad input rejection'
export const description = 'Malformed payloads return 4xx without crashing'

export async function run(api) {
  // Missing routineId on inject-take (startedAt is required)
  const r1 = await api.injectTake({})
  api.assert(r1.status === 400 || r1.status === 422, `inject-take empty body → 4xx (got ${r1.status})`)

  // Missing bodyKey on set-watermark
  const r2 = await api.setWatermark({ lastCaptureTime: '2026-04-29T00:00:00Z' })
  api.assert(r2.status === 400, `set-watermark missing bodyKey → 400 (got ${r2.status})`)

  // setTakeRoutine with non-existent takeId
  const r3 = await api.setTakeRoutine({ takeId: '00000000-0000-0000-0000-000000000000', routineId: null })
  api.assert(r3.status === 404, `set-take-routine missing takeId → 404 (got ${r3.status})`)

  // recording/stop with no active take
  await api.clearState({ clearRoutineRecordings: true })
  const r4 = await api.recordingStop({})
  api.assert(r4.status === 404 || r4.status === 400, `stop without active → 4xx (got ${r4.status})`)

  // import-photos with missing folderPath
  const r5 = await api.importPhotos({})
  api.assert(r5.status === 400, `import-photos missing path → 400 (got ${r5.status})`)

  return { ok: true }
}
