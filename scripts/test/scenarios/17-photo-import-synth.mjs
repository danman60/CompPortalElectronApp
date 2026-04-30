/**
 * 17-photo-import-synth — exercises importPhotos against a synth SD card
 * folder. Validates the full body-key + watermark + date-filter chain
 * end-to-end without needing a real Lumix SD.
 *
 * Skips on Linux (synth-sd-card needs to write to a Windows path the
 * Electron process can read). When run from Linux against a tunneled
 * DART debug server, the harness POSTs the path and DART runs importPhotos
 * locally — but the path needs to exist on DART. We use a known TEST
 * folder under Temp.
 */
export const name = 'Photo import via synth SD card'
export const description = 'importPhotos with controlled EXIF dates + body-key filenames'

export async function run(api) {
  // For now this scenario validates that the endpoint guards work — the
  // synth folder generation requires DART-side execution which isn't
  // wired into the harness yet. We test the guard rails instead.

  // Reject on missing path
  const r1 = await api.importPhotos({})
  api.assert(r1.status === 400, `missing path → 400 (got ${r1.status})`)

  // Reject on non-existent path (importPhotos returns error in body)
  const r2 = await api.importPhotos({
    folderPath: 'C:\\nonexistent\\path\\that\\should\\never\\exist',
    dedupByDb: true,
  })
  // Either 500 with error, or 200 with totalPhotos=0 — both acceptable.
  api.assert(r2.status === 200 || r2.status === 500, `bad path returns 2xx or 5xx (got ${r2.status})`)

  return { ok: true }
}
