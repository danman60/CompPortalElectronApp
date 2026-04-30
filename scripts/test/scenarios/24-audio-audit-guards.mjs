/**
 * 24-audio-audit-guards — verify the trigger-audio-audit endpoint validates
 * inputs. Real audit requires an actual MP4 — operator drives that path
 * through real recording + encoding.
 */
export const name = 'Audio audit endpoint guards'
export const description = 'trigger-audio-audit validates routineId + encodedFiles'

export async function run(api) {
  // Missing routineId
  const r1 = await api.triggerAudioAudit({})
  api.assertEq(r1.status, 400, 'missing routineId → 400')

  // Empty encodedFiles
  const r2 = await api.triggerAudioAudit({ routineId: 'any-uuid', encodedFiles: [] })
  api.assertEq(r2.status, 400, 'empty encodedFiles → 400')

  // Routine not found
  const r3 = await api.triggerAudioAudit({
    routineId: '00000000-0000-0000-0000-000000000000',
    encodedFiles: [{ role: 'performance', filePath: 'C:\\nonexistent.mp4' }],
  })
  api.assertEq(r3.status, 404, 'unknown routine → 404')

  return { ok: true }
}
