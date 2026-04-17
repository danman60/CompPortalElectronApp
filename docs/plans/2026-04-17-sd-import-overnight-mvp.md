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

## Thumbnail upload (added 2026-04-17, post-dinner)

Electron plugin now uploads the 200×200 WebP thumbnail it already generates locally as a sibling of each original photo in R2, so CompPortal's Media Portal can populate `media_photos.thumbnail_url`.

### Local generation
`photos.ts` swapped from JPEG to **WebP** for the thumb (`.webp({ quality: 80 })`), written to `{routineDir}/thumbnails/thumb_NNN.webp`. `PhotoMatch.thumbnailPath` now points at the `.webp`.

### Upload
Thumb PUT fires **after** the original PUT succeeds in `upload.ts:processLoop`:
1. Call `getSignedUploadUrl()` a second time with `filename = deriveThumbObjectName(originalObjectName)` and `contentType = 'image/webp'`.
2. PUT the local `photo.thumbnailPath` to the returned signed URL.
3. Store the returned `storagePath` on the job payload as `thumbStoragePath`.

`deriveThumbObjectName` swaps the `.jpg`/`.jpeg` suffix (case-insensitive) for `_thumb.webp`:
`photo_001.jpg` → `photo_001_thumb.webp`. The R2 key mirrors the original's prefix, so the thumb lands as a literal sibling (`.../photos/photo_001.jpg` + `.../photos/photo_001_thumb.webp`).

Thumb PUT failures are **non-fatal** — logged as warnings, original-photo path continues. CompPortal will fall back to on-the-fly thumb generation when `thumbnail_url` is null.

### `/api/plugin/complete` payload change

A new parallel array `files.photo_thumbnails` is sent alongside `files.photos`. Indexed identically: `photo_thumbnails[i]` is the R2 key for the thumb of `photos[i]`. Empty string means "no thumb for this index" (tether-flow photos or thumb PUT failed). Absent (`undefined`) means "this payload does not include thumb data" (legacy — CompPortal should treat as all-null).

Example body:
```json
{
  "entryId": "...",
  "competitionId": "...",
  "uploadRunId": "...",
  "video_start_timestamp": "...",
  "video_end_timestamp": "...",
  "files": {
    "performance": "comp/.../performance.mp4",
    "judge1": "comp/.../judge1.mp4",
    "photos": [
      "comp/.../photos/photo_001.jpg",
      "comp/.../photos/photo_002.jpg"
    ],
    "photo_thumbnails": [
      "comp/.../photos/photo_001_thumb.webp",
      "comp/.../photos/photo_002_thumb.webp"
    ]
  }
}
```

**CompPortal-3 TODO:** in `/api/plugin/complete` handler, read `files.photo_thumbnails` if present and set `media_photos[i].thumbnail_url = files.photo_thumbnails[i]` whenever the string is non-empty. Null/empty-string entries leave `thumbnail_url` unset, preserving existing on-the-fly fallback.

### Types
`PhotoMatch.thumbnailStoragePath?: string` added (next to `storagePath`). Populated after successful thumb PUT; persisted into routine state so post-crash retries know the thumb already landed.

### Tests
`tests/e2e-sd-import.mjs` extended with a 5th case (`testThumbUploadWiring`) plus new assertions inside the happy path:
- Every matched photo has `thumbnailPath` ending in `.webp`
- WebP files exist on disk and have the `RIFF....WEBP` magic bytes
- Compiled bundle contains the `_thumb.webp` / `photo_thumbnails` / `thumbStoragePath` literals

## Risks / deviations

- `markUploaded` is called in the same try-block as the existing `uploaded=true` state update. If manifest IO fails, we log + continue (do not block upload confirmation) — trade-off: crash-safe *enough*, but the operator may see a stale local file in that edge case.
- Auto-import is on-by-default. If no competition is loaded when the SD fires, DriveAlert already guards with `!competition` — we respect that; no-op instead of crashing.
- SHA1 of first 128KB is not cryptographically strong. It's fine for dedup because it's just a fingerprint; collisions in the first 128KB of two unrelated JPEGs is vanishingly rare for real camera output.
