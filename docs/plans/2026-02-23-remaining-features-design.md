# Remaining Features Design — v2.4.0

Date: 2026-02-23

## 1. OBS Compact Mode (finish)

- App.css: `.app-layout.compact` left panel ~220px, right expands
- RoutineTable compact: hide Photos column, tighter padding
- Header compact: collapse logo to icon, keep Load Comp + Compact + Settings only
- Persist compactMode in electron-store
- Keyboard shortcut Ctrl+Shift+C to toggle

## 2. Backup Folder — ALREADY DONE

`archiveExistingFiles()` in recording.ts moves to `_archive/v1`, `v2` etc.

## 3. Jump to Routine

- Click routine row → sets as current routine
- Search input already exists (searchQuery in store)
- Type entry number to filter/jump

## 4. Routine Notes + Error Export

- `notes?: string` on Routine type
- Pencil icon per row → inline textarea
- Notes persist in state
- "Export Report" button → CSV with entry#, title, studio, status, notes, errors, times, offsets
- Session summary header

## 5. CPU/Disk Monitor

- SystemMonitor in header status area
- Main process polls 5s: CPU% (os.cpus delta), disk free (fs.statfs on output dir)
- IPC channel to renderer
- Yellow >80% CPU or <10GB, red >95% or <2GB
- Compact display in compact mode

## 6. FFmpeg CPU Throttling

- `ffmpeg.cpuPriority`: 'normal' | 'below-normal' | 'idle'
- Windows: spawn with BELOW_NORMAL_PRIORITY_CLASS
- Default: 'below-normal'
- Settings UI dropdown

## 7. Share Code (replaces Live API)

- Remove tenant/apiKey/uploadEndpoint/competition from settings
- Single `compsync.shareCode` field
- LoadCompetition: Offline + Live (share code input)
- Resolve via `GET https://api.compsync.net/plugin/resolve/{code}`
- Returns { tenant, competitionId, apiBase, name }
- Upload endpoint auto-derived
- Settings panel simplified
