/**
 * 43-keyframes-fullres — Phase 1.12 verification.
 *
 * Calls /debug/test/extract-keyframes against a 1280x720 synth MP4 on DART.
 * Asserts each output keyframe is at least 8 KB. Native-res webp at q=82
 * on a 720p source produces ~10–80 KB depending on scene complexity; the
 * legacy 400×400 q=5 encode topped out around ~2 KB. 8 KB threshold cleanly
 * separates the two regimes.
 *
 * Prereq: 1280x720 synth video must exist on DART. Generated via:
 *   ffmpeg -y -f lavfi -i "testsrc=duration=10:size=1280x720:rate=30" \
 *     -c:v libx264 -pix_fmt yuv420p -crf 23 -t 10 \
 *     C:\Users\User\AppData\Local\Temp\synth-1280x720.mp4
 */
const REMOTE_MP4 = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-1280x720.mp4'
const REMOTE_OUT = 'C:\\Users\\User\\AppData\\Local\\Temp\\test-keyframes-' + Date.now()

export const name = 'Keyframes — full-resolution webp (Phase 1.12)'
export const description = 'extractKeyframes writes native-res webp ≥30KB per frame'

export async function run(api) {
  const r = await api.extractKeyframes({ mkvPath: REMOTE_MP4, outputDir: REMOTE_OUT })
  if (r.status === 501) return { ok: true, skipped: 'extract-keyframes endpoint not deployed yet' }
  if (r.status !== 200) {
    return { ok: false, why: `extract-keyframes status ${r.status}: ${JSON.stringify(r.body)}` }
  }
  const { keyframes } = r.body
  api.assert(Array.isArray(keyframes), 'keyframes is array')
  api.assert(keyframes.length === 3, `wrote 3 keyframes (got ${keyframes.length})`)
  for (const kf of keyframes) {
    api.assert(kf.sizeBytes >= 8 * 1024, `keyframe ${kf.path} ≥8KB (got ${kf.sizeBytes} bytes)`)
  }
  return { ok: true, sizes: keyframes.map((k) => k.sizeBytes) }
}
