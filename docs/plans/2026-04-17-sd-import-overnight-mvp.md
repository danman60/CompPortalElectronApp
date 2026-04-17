# SD-Import Overnight MVP

Branch: `feat/sd-import-overnight`
Target drop: dinner break 2026-04-17, overnight run
Scope: on-by-default (no feature flag); confidence = E2E test

## Goal

Tonight's overnight run needs zero-operator SD-card imports that:
- Auto-trigger import when SD inserted (no click)
- Keep a crash-safe per-run manifest so re-runs don't re-upload or re-copy
- Park unmatched photos in `_orphans/` instead of dropping them
- Delete local routine-folder photos after a verified R2 upload + plugin/complete ACK
- Never write back to the SD card

## File changes (delta)

| # | File | Change | LOC |
|---|------|--------|-----|
| 1 | `src/main/services/importManifest.ts` | NEW — per-run JSON manifest, ordered writes | ~80 |
| 2 | `src/shared/types.ts` | Add `storagePath`, `sourceHash`, `sourcePath` to `PhotoMatch` | ~5 |
| 3 | `src/main/services/photos.ts` | Hash+dedup, orphan routing, manifest append | ~45 |
| 4 | `src/main/services/upload.ts` | Mark manifest uploaded → unlink local copy | ~30 |
| 5 | `src/renderer/components/DriveAlert.tsx` | Auto-trigger on `drive:detected`, CLIP fire-and-forget | ~20 |
| 6 | `src/shared/types.ts` (DEFAULT_SETTINGS) | `behavior.autoImportOnDrive: true` | ~2 |
| 7 | `tests/e2e-sd-import.mjs` | 4 E2E cases | ~150 |

## Manifest schema

```json
{
  "outputDir": "C:\\\\CompSync\\\\out",
  "runs": [
    {
      "importRunId": "2026-04-17T22:11:53.004Z",
      "sourceFolder": "E:/DCIM/100CANON",
      "entries": [
        {
          "sourcePath": "E:/DCIM/100CANON/IMG_0001.JPG",
          "sourceHash": "3b4f2c...",
          "routineId": "uuid-of-matched-routine",
          "entryNumber": "42",
          "destPath": "C:\\\\CompSync\\\\out\\\\042_title_STU\\\\photos\\\\photo_001.jpg",
          "uploaded": false,
          "storagePath": null,
          "importedAt": "2026-04-17T22:11:54.120Z",
          "uploadedAt": null
        }
      ]
    }
  ]
}
```

Orphan entries carry `routineId: null` and a `destPath` pointing at `_orphans/{runId}/`.

## Ordered-write safety

Write sequence for any manifest mutation:
1. `JSON.stringify` the new manifest
2. Write to `<file>.tmp`
3. `fsync(fd)` then `close(fd)`
4. Atomic `rename(<file>.tmp, <file>)`

This guarantees the manifest is never torn on power loss. If a crash happens between step 3 and step 4, the real file is the previous fully-valid version.

Upload/delete sequence:
1. Plugin `/complete` returns 2xx
2. `markUploaded()` — manifest updated with `storagePath` and `uploadedAt` (ordered write)
3. `fs.promises.unlink(photo.filePath)` — delete local routine-folder copy

If we crash between 2 and 3: safe. On restart, file is present *and* manifest says uploaded=true. The dedup check uses `sourceHash` against `getUploadedHashes()`, so the re-run detects it's already uploaded and will not re-queue. The stale local file is harmless — it just takes disk space until cleaned up manually.

## SD safety

Unmatched photos are **copied** (`fs.promises.copyFile`) to `_orphans/{runId}/`. The SD card is never written to. `photos.ts` already never writes to the source.

Old tether-path photos (no `sourceHash` on `PhotoMatch`) are not deleted after upload. Only photos that came through the new SD-import path get deleted.

## Deploy sequence

See `2026-04-17-sd-import-overnight-deploy.md` for exact commands.

Summary:
1. `npm run build` on this Linux host
2. `electron-vite build` produces `out/` — package into an asar via `electron-builder --win --dir`
3. scp the `release/win-unpacked/resources/app.asar` → `/tmp/sd-import-overnight/app.asar`
4. SHA256 alongside
5. At dinner break: operator stops the app on DART, backs up existing asar, drops this one in, starts the app
6. Smoke-test via `scripts/smoke-sd-import.ps1`

## Rollback

```powershell
# Rollback to the last known good asar
Stop-Process -Name "CompSync Media"
Copy-Item "C:\Program Files\CompSync Media\resources\app.asar.bak" "C:\Program Files\CompSync Media\resources\app.asar" -Force
Start-Process "C:\Program Files\CompSync Media\CompSync Media.exe"
```

Known-good fallback: `v2.7.0-stable` (commit `11b97af`).

## Risks / deviations

- `markUploaded` is called in the same try-block as the existing `uploaded=true` state update. If manifest IO fails, we log + continue (do not block upload confirmation) — trade-off: crash-safe *enough*, but the operator may see a stale local file in that edge case.
- Auto-import is on-by-default. If no competition is loaded when the SD fires, DriveAlert already guards with `!competition` — we respect that; no-op instead of crashing.
- SHA1 of first 128KB is not cryptographically strong. It's fine for dedup because it's just a fingerprint; collisions in the first 128KB of two unrelated JPEGs is vanishingly rare for real camera output.
