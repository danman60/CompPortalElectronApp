# Media Loss Prevention — Critical Priority

**Status:** In progress (Phase 2 complete)
**Goal:** Ironclad guarantee that no media can ever be lost or silently overwritten.

## Layered defenses (each independent)

1. **R2 versioning / immutable paths** — every upload goes to a unique storage path; re-uploads never overwrite.
2. **Soft-delete at DB layer** — `deleted_at` on `media_packages` and `media_photos`; no hard deletes from app code.
3. **FK RESTRICT** — parent-row deletion (competition, tenant) blocked if media exists. Applied.
4. **Write-path hardening** — `/api/plugin/complete` cannot blank fields, cannot delete photos, cannot downgrade status.
5. **Audit log** — append-only `plugin_write_log` for every `/api/plugin/complete` call.
6. **Electron reconcile** — read-only one-way downgrade of local state when server says `none`. Never touches mid-pipeline.

## Phase 2 — COMPLETE (DB migrations applied to Supabase COMPSYNC)

- `media_packages.deleted_at timestamptz` (nullable)
- `media_photos.deleted_at timestamptz` (nullable)
- `idx_media_packages_alive` partial index on (`tenant_id, competition_id, entry_id`) WHERE `deleted_at IS NULL`
- `idx_media_photos_alive` partial index on (`media_package_id`) WHERE `deleted_at IS NULL`
- FK cascade → RESTRICT for:
  - `media_packages.competition_id → competitions.id`
  - `media_packages.tenant_id → tenants.id`
  - `media_photos.media_package_id → media_packages.id`
- `plugin_write_log` table (append-only audit) with indexes

## API Contracts (target state)

### `POST /api/plugin/upload-url`

**Request (new fields in bold):**
```json
{
  "entryId": "uuid",
  "competitionId": "uuid",
  "type": "videos" | "photos",
  "filename": "string",
  "contentType": "string",
  "uploadRunId": "uuid"   // NEW — required
}
```

**Response:**
```json
{
  "signedUrl": "string",
  "storagePath": "string"   // now includes uploadRunId segment
}
```

**Storage path scheme (immutable):**
```
{tenantId}/{competitionId}/{entryId}/{type}/{uploadRunId}/{filename}
```

Every upload gets a fresh `uploadRunId`, so no two PUTs ever target the same R2 key. Retries generate a new runId. Old paths are orphaned but preserved forever until an explicit ops purge.

### `POST /api/plugin/complete`

**Request (new field in bold):**
```json
{
  "entryId": "uuid",
  "competitionId": "uuid",
  "uploadRunId": "uuid",   // NEW — required
  "files": {
    "performance": "storagePath",
    "judge1": "storagePath",
    "judge2": "storagePath",
    "judge3": "storagePath",
    "judge4": "storagePath",
    "photos": ["storagePath", ...]
  }
}
```

**Server behavior:**
- Video URL fields: only update if the incoming string is non-empty. Explicit guard rejects `null` or `""`. Missing fields are untouched.
- Photos: **merge by filename.** For each incoming photo, upsert into `media_photos` by `(media_package_id, filename)`. Never call `deleteMany`. A re-upload with a new R2 path updates `storage_url` for that filename (the old R2 object remains under its old uploadRunId path).
- Status: never downgrade `media_packages.status` from `complete`. Never write anything that removes a video URL or photo row.
- Write log: insert one row into `plugin_write_log` with full request payload (JSON) + result (`success`/`error`) + uploadRunId + tenant + entry + competition.
- Filter `deleted_at IS NULL` when looking up existing media_packages.

### `GET /api/plugin/schedule/[competitionId]`

**Response (new field in bold):**
```json
{
  "tenantId": "uuid",
  "competitionId": "uuid",
  "name": "string",
  "routines": [
    {
      "id": "uuid",
      "entryNumber": "string",
      ...,
      "status": "pending",
      "mediaPackageStatus": "none" | "complete",   // NEW
      "mediaUpdatedAt": "iso string | null"         // NEW
    }
  ],
  "days": ["..."],
  "source": "api",
  "loadedAt": "iso string"
}
```

**Server behavior:**
- LEFT JOIN `media_packages` ON `media_packages.entry_id = ce.id AND media_packages.deleted_at IS NULL`
- `mediaPackageStatus = 'complete'` if a row exists, else `'none'`
- `mediaUpdatedAt = media_packages.updated_at` or null

## Phase 3 — CompPortal code changes

Files to update:

1. `src/lib/r2.ts` — `getMediaStoragePath()` adds `uploadRunId` segment:
   ```ts
   export function getMediaStoragePath(
     tenantId, competitionId, entryId, type, uploadRunId, filename
   ): string {
     return `${tenantId}/${competitionId}/${entryId}/${type}/${uploadRunId}/${filename}`;
   }
   ```
2. `src/app/api/plugin/upload-url/route.ts` — accept + require `uploadRunId`, pass to `getMediaStoragePath`. 400 if missing.
3. `src/app/api/plugin/complete/route.ts` — full rewrite per contract above:
   - Require `uploadRunId`
   - Video fields: explicit `typeof === 'string' && length > 0` guard
   - Photos: replace `deleteMany` + insert loop with upsert-by-filename loop
   - Filter existing package lookup by `deleted_at: null`
   - Insert into `plugin_write_log` at end (always, even on error branch)
   - Never set `status` to anything less than `'complete'`
4. `src/app/api/plugin/schedule/[competitionId]/route.ts` — add LEFT JOIN on media_packages, include `mediaPackageStatus` + `mediaUpdatedAt` per routine, filter `deleted_at IS NULL`.
5. `src/server/routers/media.ts`:
   - `deletePhoto` mutation (lines 355-414) → soft delete: set `deleted_at`, do NOT call `deleteFromR2`. Do NOT decrement `photo_count` (derive from live rows instead, or leave drift).
   - Any `findUnique`/`findMany` on `media_packages` or `media_photos` → add `deleted_at: null`
6. **All read paths** that query media_packages / media_photos need `deleted_at: null` filters. Grep and patch:
   - `src/app/api/media/dancer/[dancerId]/route.ts`
   - `src/app/api/media/studio/[studioId]/route.ts`
   - `src/app/api/media/cd/dashboard/route.ts`
   - `src/app/api/media/download/[packageId]/route.ts`
   - Any other route returning media
   - tRPC queries in `src/server/routers/media.ts`
7. **Remove `deleteFromR2` and `deleteFromMediaStorage` from app-accessible call sites.** Leave the function but scrub callers. Current callers to fix: `src/server/routers/media.ts:387,396`.
8. `npx prisma generate` to pick up new `plugin_write_log` model.
9. `npm run build` to verify types.

## Phase 4 — CompSyncElectronApp code changes

Files to update:

1. `src/shared/types.ts`:
   - Add `uploadRunId?: string` to `Routine` interface (optional, set at upload start)
   - Add `mediaPackageStatus?: 'none' | 'complete'` to `Routine` (populated from schedule API, used by reconcile)
2. `src/main/services/upload.ts`:
   - Generate a fresh `uploadRunId` (crypto.randomUUID()) per upload attempt, store on the routine at the start of the upload pipeline
   - Pass `uploadRunId` in the `getSignedUploadUrl` request body
   - Pass `uploadRunId` in the `callPluginComplete` request body
3. `src/main/services/state.ts` — reconcile pass inside `setCompetition()`:
   - After the persisted-state merge loop, run a second pass
   - For each routine where local `status` is `'uploaded'` or `'confirmed'` AND server's `mediaPackageStatus === 'none'`:
     - Before demoting, snapshot the routine to a backup entry in memory (logged + written to `compsync-state.json.bak-{timestamp}` once per reconcile)
     - Check that local `encodedFiles[*].filePath` still exist on disk
     - If files exist → demote to `'encoded'`, keep all other fields (outputPath, encodedFiles, photos, etc.)
     - If files don't exist → demote to `'pending'`, clear encodedFiles
     - Log the demote with reason (entry number, old status, new status, file check result)
   - NEVER touch mid-pipeline states (`recording`, `encoding`, `uploading`)
   - NEVER run if the API response is missing the `mediaPackageStatus` field (backward compat with old server — no downgrades, no writes)
4. **Dry-run mode first**: add a constant `RECONCILE_DRY_RUN = true` at the top of state.ts. When true, log what would happen but don't actually mutate status. Flip to false after verifying on a real competition load.
5. `src/main/services/schedule.ts` — `loadFromShareCode` already returns the full Competition shape; make sure `mediaPackageStatus` field flows through untouched.

## Phase 5 — Audits

1. **One-time DB audit** (run from main session via Supabase MCP):
   - `SELECT * FROM media_packages WHERE performance_video_url IS NULL AND judge1_video_url IS NULL AND judge2_video_url IS NULL AND judge3_video_url IS NULL AND judge4_video_url IS NULL AND photo_count = 0` — empty rows
   - `SELECT COUNT(*) FROM media_packages WHERE entry_id IS NULL` — orphans from SET NULL
2. **R2 orphan audit**: list all objects in `compsyncmedia`, cross-reference against live `media_packages.*_video_url` + `media_photos.storage_url`. Report:
   - Objects in R2 not referenced by any DB row → orphans (usually safe to purge later)
   - DB rows referencing R2 paths that don't exist → broken pointers (data loss, needs investigation)
3. **Weekly cron**: script both audits + email results.

## Deploy order (no flag day)

1. CompPortal backend deploys first (new API contract, backward-compat where possible).
2. Electron app build + deploy to DART.
3. Test end-to-end: upload a routine, verify plugin_write_log row exists, verify immutable path in R2, reload share code, verify reconcile log shows no demotes.

## What's already done

- ✅ R2 recon (versioning not supported via S3 API; pivoted to immutable paths)
- ✅ DB migrations (soft-delete, FK RESTRICT, plugin_write_log table)
- ✅ Prisma schema pulled and up to date

## What's NOT yet done

- ⬜ Phase 3 CompPortal code changes
- ⬜ Phase 4 CompSyncElectronApp code changes
- ⬜ Phase 5 audits
- ⬜ Deploy
