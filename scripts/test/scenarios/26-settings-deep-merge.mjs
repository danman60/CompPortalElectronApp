/**
 * 26-settings-deep-merge — verify all new settings fields are present in
 * snapshot.relevantSettings (deep-merge from DEFAULT_SETTINGS handles missing
 * fields in user settings.json).
 */
export const name = 'Settings deep-merge populates new fields'
export const description = 'All recently-added behavior + audioAudit fields visible'

export async function run(api) {
  const snap = (await api.snapshot()).body
  const s = snap.relevantSettings
  api.assert(s, 'relevantSettings present')
  api.assertEq(typeof s.autoImportOnDrive, 'boolean', 'autoImportOnDrive')
  api.assertEq(typeof s.includePriorDayPhotos, 'boolean', 'includePriorDayPhotos (Phase 2.1)')
  api.assertEq(typeof s.compStateDriftCheck, 'boolean', 'compStateDriftCheck (Phase 1.4/1.6)')
  api.assertEq(typeof s.testHooksEnabled, 'boolean', 'testHooksEnabled')
  api.assertEq(s.testHooksEnabled, true, 'test hooks ON (we are inside the harness)')

  api.assert(s.audioAudit, 'audioAudit block present')
  api.assertEq(typeof s.audioAudit.identityCheckEnabled, 'boolean', 'A53 identity')
  api.assertEq(typeof s.audioAudit.silenceCheckEnabled, 'boolean', 'A55 silence')
  api.assertEq(typeof s.audioAudit.loudnessCheckEnabled, 'boolean', 'A55 loudness')
  api.assertEq(typeof s.audioAudit.bitrateCheckEnabled, 'boolean', 'Phase 5.3.1 bitrate')
  api.assertEq(typeof s.audioAudit.bitrateFloorKbps, 'number', 'Phase 5.3.1 floor numeric')
  return { ok: true }
}
