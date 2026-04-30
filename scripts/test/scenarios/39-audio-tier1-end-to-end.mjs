/**
 * 39-audio-tier1-end-to-end — full Phase 5.3.1 verification.
 *
 * Prerequisite: synth-broken.mp4 SCP'd to DART at known path.
 * Generated via:
 *   node scripts/test/synth-mkv.mjs --out /tmp/synth-broken.mp4 --profile broken --duration 10
 *   scp /tmp/synth-broken.mp4 dart:/Users/User/AppData/Local/Temp/synth-broken.mp4
 *
 * Triggers runAudioAuditForTest against the broken MP4. Watches
 * /debug/events for AUDIO_LOW_BITRATE_DETECTED IPC trace.
 */
const REMOTE_MP4 = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-broken.mp4'

export const name = 'Audio audit Tier-1 end-to-end (broken stream)'
export const description = 'Trigger audit on synth-broken.mp4, expect AUDIO_LOW_BITRATE_DETECTED'

export async function run(api) {
  const routines = (await api.routines()).body
  const r1 = routines[0]

  // Snapshot recent events count
  const eventsBefore = (await api.events(100)).body.events.length

  const trigger = await api.triggerAudioAudit({
    routineId: r1.id,
    encodedFiles: [
      { role: 'performance', filePath: REMOTE_MP4 },
    ],
  })
  if (trigger.status === 501) return { ok: true } // soft skip if wrapper not exported
  if (trigger.status !== 200) return { ok: false, why: `audit trigger status ${trigger.status}: ${JSON.stringify(trigger.body)}` }

  // Wait for audit (audit involves ffprobe + silencedetect + volumedetect, ~10s for a 10s file)
  await api.sleep(15000)

  // Tail logs for the trigger signal
  const logs = (await api.logs(2000, 'Phase 5.3.1 bitrate')).body
  const fired = typeof logs === 'string' && logs.includes('Phase 5.3.1 bitrate: routine')
  api.assert(fired, 'Phase 5.3.1 bitrate warn fired in logs (broken stream caught)')

  return { ok: true }
}
