
---

## From CompPortal session — 2026-04-13

### Tier B deployed (not full Phase 3)

User decision: **minimum safe subset** of Phase 3 on CompPortal, not the full rewrite. Reason: real competition data starts flowing soon, no time to properly test a rewritten `plugin/complete` endpoint. Current e2e pipeline (app → website → download) works and we're not touching it.

**What CompPortal IS doing:**

1. Prisma schema synced (`db pull`) — `deleted_at` columns on media_packages/media_photos, `plugin_write_log` table, all picked up.
2. `GET /api/plugin/schedule/[competitionId]` — adds two additive fields to each routine:
   - `mediaPackageStatus`: `'complete'` if a non-deleted package exists for the entry, else `'none'`
   - `mediaUpdatedAt`: ISO timestamp of package's `updated_at`, or `null`
   - `status` field unchanged (still `'pending'` for all routines)
3. `src/server/routers/media.ts` `deletePhoto` → soft delete (sets `deleted_at`, preserves R2)
4. Read-path audit — `deleted_at: null` filter added to all media_packages/media_photos reads across the repo
5. `deleteFromR2` call sites removed (function kept for future ops script)

**What CompPortal is NOT doing (deferred):**

- `getMediaStoragePath` signature change (no `uploadRunId` in path). **R2 paths remain mutable — re-uploads still overwrite.**
- `POST /api/plugin/upload-url` does NOT require `uploadRunId`. If Electron sends it, server ignores it.
- `POST /api/plugin/complete` is **UNCHANGED**. Still does the original `deleteMany` for photos, still sets status unconditionally, still no audit log.

### Implications for Electron deploy

- **Electron's reconcile logic CAN work** — it just reads `mediaPackageStatus` from the schedule endpoint. This is the most valuable Phase 4 protection and it's live.
- **Do NOT rely on `uploadRunId` being stored server-side.** Electron can still generate and send it, but CompPortal drops it. No per-run isolation on R2 paths until off-season.
- **Re-uploads will still overwrite R2 objects.** If a user re-triggers an upload on the same entry, photos/videos from the previous run are gone. This is the pre-existing behavior, not new risk.
- **`plugin/complete` photo behavior is unchanged.** It still wipes and recreates photo rows on every call. Don't assume filename-merge semantics.
- **No plugin_write_log audit trail yet.** `plugin_write_log` table exists but CompPortal's plugin endpoint doesn't write to it.

### Deploy order

Tier B on CompPortal is safe to deploy any time — it's additive + soft-delete only, zero risk to the current upload pipeline. No deploy-order constraint with Electron.

New Electron build can deploy whenever — it doesn't matter if CompPortal has Tier B deployed first, because the new Electron fields (`uploadRunId`) are ignored server-side rather than rejected.

### Flags still outstanding (from the original Phase 3 plan)

User is aware but deferring:

1. Cross-tenant exposure in `handleFamilyMediaRoutines` / `handleFamilyMediaDownload` (mobile family API, no `tenant_id` filter)
2. `updatePackageStatus` admin tRPC allows downgrades
3. `streamstage/` prefix in compsyncmedia bucket (StreamStage migration artifact)

These aren't being fixed in this session.

### Action items for Electron session

- Can proceed with Phase 4 commits at your discretion
- Reconcile logic should work against the additive schedule fields
- Don't remove Electron-side `uploadRunId` generation — it's forward-compatible even though server is dropping it
- If you want to verify the CompPortal schedule changes are live, fetch `/api/plugin/schedule/<competitionId>` with a plugin key and confirm `mediaPackageStatus` and `mediaUpdatedAt` appear on each routine
