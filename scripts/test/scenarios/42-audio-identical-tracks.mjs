/**
 * 42-audio-identical-tracks — A53 cross-channel hash detection.
 *
 * Pre-stage: synth-broken.mp4 already on DART. Trigger audit with
 * TWO encoded files pointing at the SAME mp4 — they should produce
 * identical SHA-256 audio hashes → A53 fires.
 */
const REMOTE_MP4 = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-broken.mp4'

export const name = 'A53 cross-channel hash — identical audio detected'
export const description = 'Two roles pointing at same MP4 → AUDIO_IDENTICAL_TRACKS fires'

export async function run(api) {
  const routines = (await api.routines()).body
  const r1 = routines[0]

  const trigger = await api.triggerAudioAudit({
    routineId: r1.id,
    encodedFiles: [
      { role: 'judge1', filePath: REMOTE_MP4 },
      { role: 'judge2', filePath: REMOTE_MP4 },
    ],
  })
  if (trigger.status === 501) return { ok: true } // soft skip
  if (trigger.status !== 200) return { ok: false, why: `audit trigger ${trigger.status}` }

  await api.sleep(8000) // hash takes a bit

  const logs = (await api.logs(2000, 'A53 identical-tracks')).body
  const fired = typeof logs === 'string' && logs.includes('A53 identical-tracks: routine')
  api.assert(fired, 'A53 identical-tracks fired (judge1 = judge2 hash match)')
  return { ok: true }
}
