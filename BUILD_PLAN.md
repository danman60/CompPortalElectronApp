# CompSync OBS Plugin — Full Build Plan

## Context

Building the CompSync Media desktop app — everything in **one build**, no phased rollout. User confirmed: "I want to include everything else in your list." Scene switching removed (user handles in OBS directly).

**Two steps:**
1. Update `OBS_PLUGIN_SPEC.md` with all fixes below
2. Build the complete app at `D:\ClaudeCode\CompSyncElectronApp\`

### Final Technical Decisions (Feb 12)
- **electron-store v6** (CJS) — avoids ESM breakage in Electron main process
- **No drivelist** — manual "Browse Folder" button for photo import (no native SD card detection)
- **Include Sharp** — local thumbnail generation (200x200 WebP), accepts native compilation
- **Bundle ffmpeg-static** — zero-friction FFmpeg, ~80MB auto-bundled binary

---

## Step 1: Spec Updates (before any code)

### A. Remove Scene Switching

- Delete `SetCurrentProgramScene` and `GetSceneList` from Section 3 Requests table
- Delete `CurrentProgramSceneChanged` from Section 3 Events table
- Remove "Scene switching" from Section 12 Phase 4 checklist
- Remove "recording scene dropdown" from Settings Section 10 item 1

### B. Merge All Phases into Single Build

Replace Section 12's 4 phases with a single comprehensive checklist organized by subsystem (not by phase). Everything ships in v1:

**Core Infrastructure:**
- electron-vite + React + TypeScript scaffold
- IPC architecture (contextBridge + preload)
- Structured logging (electron-log with scoped categories)
- Settings persistence (electron-store + safeStorage)
- Window state persistence (electron-window-state)
- Always-on-top toggle
- Global hotkeys (F5/F6/F9/F10 via Electron globalShortcut)
- Crash recovery: scan output dir for orphaned MKVs

**OBS Integration:**
- obs-websocket-js connection from main process with auto-reconnect
- Recording control (Start/Stop/Next/Prev)
- Start/Stop Stream button (StartStream/StopStream)
- Save Replay button (SaveReplayBuffer)
- Audio level meters (InputVolumeMeters, throttled to rAF)
- Configurable judge count (1-4) with dynamic track/meter UI

**Schedule & Data:**
- CSV/XLSX schedule parser (papaparse + xlsx)
- Load Competition popover (offline file mode + live API mode)
- Routine state machine persisted to JSON
- Day filter, search/filter, skip/un-skip

**Recording Pipeline:**
- File rename after recording stops (RecordStateChanged)
- Re-recording: archive old files to `_archive/v{N}/`
- Auto-record on Next toggle

**FFmpeg Pipeline:**
- FFmpeg integration (bundled via ffmpeg-static ~80MB)
- Single-command multi-output audio track splitting
- Sequential queue, 1 at a time, progress in table
- Auto-encode toggle + Encode Now button

**Photo Pipeline:**
- Photo folder browse (manual dialog — no drivelist/auto-detection)
- EXIF timestamp extraction (exifreader)
- Timestamp matching algorithm with clock offset detection
- Photo-to-routine matching UI with manual correction
- Manual import trigger (Browse Folder dialog)
- Thumbnail generation (200x200 WebP via Sharp)
- View Media button (shell.openPath)

**Upload Pipeline:**
- tus upload to Supabase Storage (main process)
- Upload queue with start/stop/pause controls
- Bulk upload mode (drain entire queue)
- Per-routine upload progress in table
- Background upload (continues while recording)
- Queue persistence — resume on app restart
- CompSync API integration (POST /api/media/plugin/complete)
- Plugin API key authentication (sk_plugin_xxx)

**Lower Third Overlay:**
- Express server on localhost:9876
- Auto-fire + global hotkey (F9)
- Auto-hide timer

**CompPortal Backend (separate work):**
- Schedule API endpoint (GET /api/media/schedule)
- Plugin API key generation UI
- Plugin API key validation middleware
- Upload completion endpoint
- CSV/XLS export with entry_id UUID + tenant_id + competition_id

**UI (all features visible from day 1):**
- Single-page split layout with draggable panels (dark theme)
- Header with status indicators, Load Competition, Settings
- Left panel: current routine, audio meters, controls, lower third
- Right panel: routine table with status, encoding, upload progress
- Settings page (all 11 sections)
- Installer (Windows NSIS via electron-builder)

### C. Fix 6 Spec Blockers

1. **Unified State Machine (Section 6.3 + 5.4):**
   - Keep Section 6.3's routine state machine as the single source of truth
   - Expand it to include all states: `pending → recording → recorded → encoding → encoded → uploading → uploaded → confirmed`
   - Replace Section 5.4's separate upload state diagram with a note: "Upload states are tracked within the routine state machine (Section 6.3). The 'uploading' state includes sub-states: queued, in-progress (with %), paused, failed."

2. **File Path Source (Section 4.2):**
   - Clarify step 1: "OBS fires `RecordStateChanged` with `outputPath` when recording stops (`OBS_WEBSOCKET_OUTPUT_STOPPED`). This event — not the `StopRecord` response — is the canonical source of the output file path."

3. **State Persistence (Section 6.3 + Section 2):**
   - Add clarification: "**App settings** (OBS connection, judge count, hotkeys, etc.) persist via electron-store in `%APPDATA%/CompSyncMedia/`. **Competition state** (routine statuses, recording timestamps, file paths) persists to `compsync-state.json` in the output directory alongside recordings — this way the state file travels with the recording folder if moved."

4. **CSV Missing Tenant/Competition IDs (Section 6.1):**
   - Add `tenant_id` and `competition_id` to CSV header row
   - Update example CSV to include them
   - Add note: "These UUIDs are required for upload. In offline mode, they come from the CSV header. In live mode, from the API response."

5. **Auth Token (Section 5.1):**
   - Replace `serviceKey` in tus code example with `pluginApiKey`
   - Add note: "The plugin API key (`sk_plugin_xxx`) is used for both tus uploads and CompSync API calls. Generated by the CD in CompSync Settings > Integrations."

6. **Photo Timestamp Anchoring (Section 4.2):**
   - Change step 5 to: "Record timestamp window: start time captured from `RecordStateChanged` `OUTPUT_STARTED` event, stop time from `OUTPUT_STOPPED` event. These form the recording window for photo matching (Section 8.3)."

### D. Add Logging Strategy (New Section 4.7)

Insert after Section 4.6 (Re-Recording):

```
### 4.7 Logging Strategy

Structured logging via `electron-log` for comprehensive debugging during development and production troubleshooting.

**Log categories (scoped loggers):**
| Scope | Logs |
|-------|------|
| App | Startup, shutdown, window events, crash recovery |
| OBS | Connect/disconnect, all requests with duration, all events, reconnect attempts |
| FFmpeg | Command args, stdout/stderr, exit codes, queue progress |
| Upload | Queue changes, tus progress, retries, API responses |
| Schedule | CSV parse results, routine count, validation errors |
| Settings | Changes (key + old/new value), load/save |
| IPC | All handler calls with args and results |
| Photos | Import detection, EXIF reads, matching results, clock offset |

**Log levels:** ERROR (failures) > WARN (recoverable) > INFO (operations) > DEBUG (details)

**Destinations:**
- **File:** Rotating, 10MB max, 5 files retained. Location: `%APPDATA%/CompSyncMedia/logs/`
- **Console:** Development only (shown in Electron DevTools)

**Key behaviors:**
- Every state transition logged with before → after
- Every OBS WebSocket request logged with method + duration + result
- FFmpeg stdout/stderr captured line-by-line to logs
- Upload progress logged at 25%/50%/75%/100% milestones (not every chunk)
- IPC calls logged with channel name + serialized args
```

### E. Remove "NOT Supported: Scene switching" if present; add note about scene switching

In Section 9 "NOT Supported" table, scene switching isn't listed, but make sure the existing `SetCurrentProgramScene` reference is removed cleanly. No need to add to NOT Supported — it's simply not part of the app.

---

## Frontend Design System (from Mockup + CompSync Design Principles)

The Electron app uses a **custom OBS-style dark theme** — NOT Tailwind. Styles come directly from the mockup's CSS custom properties. CompSync Design Principles apply where they overlap (typography philosophy, status colors, accent gradients).

### Why Not Tailwind

The OBS plugin is a standalone Electron app, not a Next.js page. No Tailwind build pipeline. We use CSS custom properties + CSS modules (or plain CSS) matching the mockup exactly.

### Color Tokens (from mockup `:root`)

```css
:root {
  /* Backgrounds — layered dark theme */
  --bg-primary: #1e1e2e;      /* App background */
  --bg-secondary: #252536;    /* Header, cards, panels */
  --bg-tertiary: #2d2d42;     /* Inputs, buttons, nested elements */
  --bg-hover: #363650;        /* Hover states */
  --bg-active: #3d3d5c;       /* Active/pressed states */

  /* Borders */
  --border: #3a3a52;          /* Default borders */
  --border-focus: #667eea;    /* Focus ring color */

  /* Text */
  --text-primary: #e0e0f0;    /* Headlines, button labels */
  --text-secondary: #9090b0;  /* Body text, labels */
  --text-muted: #606080;      /* Hints, section titles, inactive */

  /* Brand accent — matches CompSync purple/indigo gradient */
  --accent: #667eea;          /* Primary accent (maps to CompSync from-purple-500) */
  --accent-hover: #7b8ff0;    /* Accent hover */
  --accent-glow: rgba(102, 126, 234, 0.25); /* Selection/active glow */

  /* Status colors — mapped from CompSync Design Principles */
  --success: #4ade80;         /* DP: text-green-300 → green-400 */
  --success-bg: rgba(74, 222, 128, 0.12);
  --warning: #fbbf24;         /* DP: text-amber-300 → amber-400 */
  --warning-bg: rgba(251, 191, 36, 0.12);
  --danger: #f87171;          /* DP: text-red-300 → red-400 */
  --danger-bg: rgba(248, 113, 113, 0.12);

  /* Functional colors */
  --recording: #ef4444;       /* Red for recording state */
  --recording-pulse: rgba(239, 68, 68, 0.4);
  --upload-blue: #60a5fa;     /* Blue for upload progress */
  --stream-purple: #a855f7;   /* Purple for streaming */
}
```

### Typography (from mockup)

| Element | Size | Weight | Font | Color |
|---------|------|--------|------|-------|
| App logo | 13px | 600 | System sans-serif | `--accent` |
| Section titles | 10px | 600 | uppercase, tracking 1px | `--text-muted` |
| Routine title (current) | 16px | 700 | — | `--text-primary` |
| Routine dancers | 12px | — | — | `#a5b4fc` (indigo-300) |
| Routine meta | 10px | — | — | `--text-secondary` |
| Recording timer | 15px | 600 | Consolas/Monaco mono | `--danger` |
| Button labels | 11px | 500-600 | — | varies |
| Table headers | 9px | 600 | uppercase, tracking 0.5px | `--text-muted` |
| Table body | 11px | 500 | — | `--text-primary` |
| Entry numbers | 11px | 700 | — | `--accent` |
| Status labels | 9px | 500 | — | status color |
| Meter dB readout | 9px | — | Consolas/Monaco mono | `--text-muted` |
| Settings section titles | 11px | 700 | uppercase, tracking 1px | `--accent` |
| Settings field labels | 10px | 600 | uppercase, tracking 0.5px | `--text-secondary` |
| Settings field inputs | 12px | — | inherit | `--text-primary` |
| Hints | 9px | — | — | `--text-muted` |

**CompSync Principle alignment:** "Big, beautiful, confident typography" applies to the CompPortal web app. The OBS plugin uses **compact, information-dense typography** (11-13px body) because it's a desktop tool competing for screen space with OBS Studio. However, we keep the principle of **dramatic size contrast** for the routine title (16px vs 10px meta), **monospace for data** (timer, dB), and **uppercase sparingly** (section headers, labels only).

### Component Styles (exact from mockup)

**Routine Card (current):**
```css
background: var(--bg-secondary);
border: 1px solid var(--border);
border-radius: 6px;
padding: 10px;
/* Recording state adds: */
border-color: var(--recording);
box-shadow: 0 0 0 1px var(--recording-pulse), inset 0 0 20px var(--recording-pulse);
```

**Entry Number Badge:**
```css
background: linear-gradient(135deg, #667eea, #764ba2); /* CompSync brand gradient */
color: white;
font-weight: 700;
font-size: 16px;
padding: 3px 8px;
border-radius: 4px;
```

**Audio Meter Bars:**
```css
/* Track: */ height: 6px; background: var(--bg-tertiary); border-radius: 3px;
/* Fill colors by level: */
.good { background: linear-gradient(90deg, #22c55e, #4ade80); }    /* -40 to -12 dB */
.medium { background: linear-gradient(90deg, #22c55e, #fbbf24); }  /* -12 to -6 dB */
.hot { background: linear-gradient(90deg, #22c55e, #fbbf24, #ef4444); } /* -6 to 0 dB */
.silent { background: var(--text-muted); opacity: 0.3; }           /* below -60 dB */
```

**Control Buttons:**
```css
/* Base: */ padding: 7px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-tertiary); font-size: 11px;
/* Primary (Next): */ background: var(--accent); border-color: var(--accent); color: white; font-weight: 600;
/* Record (Stop): */ background: var(--recording); border-color: var(--recording); color: white; animation: pulse-border;
/* Stream (Live): */ background: var(--stream-purple); → when live: var(--recording) + pulse;
```

**Upload Table:**
```css
/* Headers: */ padding: 5px 8px; font-size: 9px; uppercase; sticky top: 0;
/* Cells: */ padding: 6px 8px; border-bottom: 1px solid var(--border);
/* LIVE row: */ background: rgba(239,68,68,0.06); border-left: 3px solid var(--recording);
/* Not recorded rows: */ opacity: 0.35;
/* Progress bars: */ height: 3px; border-radius: 2px;
```

**Load Competition Popover:**
```css
width: 360px; background: var(--bg-secondary); border: 1px solid var(--border);
border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
/* Tabs: */ border-bottom: 2px solid transparent; → active: var(--accent);
/* File drop zone: */ border: 2px dashed var(--border); hover: var(--accent);
```

**Settings Page:**
```css
/* Overlay: */ position: fixed; inset: 0; background: var(--bg-primary); z-index: 100;
/* Sections: */ margin-bottom: 20px; title: 11px bold uppercase var(--accent) with bottom border;
/* Grid: */ 2 columns, gap 10px 20px;
/* Toggles: */ 30x16px switch, var(--accent) when checked;
/* Track mapping: */ 3-column grid: label → arrow → select;
/* Footer: */ Save (accent) + Cancel (tertiary) buttons;
```

**Drag Handle:**
```css
width: 5px; cursor: col-resize; background: var(--border);
hover: var(--accent); /* Grip dots: */ ::after pseudo-element, 2 vertical lines;
```

**Status Bar (bottom):**
```css
border-top: 1px solid var(--border); padding: 6px 12px; background: var(--bg-secondary);
font-size: 10px; color: var(--text-muted); numbers: 13px bold;
```

**Scrollbars:**
```css
width: 5px; thumb: var(--bg-hover); border-radius: 3px; track: transparent;
```

### Animations (from mockup)

```css
/* Recording pulse (dots, borders) */
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 4px var(--recording-pulse); }
  50% { box-shadow: 0 0 12px var(--recording-pulse); }
}

/* Recording border pulse (Stop Rec button, Stream Live) */
@keyframes pulse-border {
  0%, 100% { box-shadow: 0 0 0 0 var(--recording-pulse); }
  50% { box-shadow: 0 0 0 3px var(--recording-pulse); }
}

/* All transitions: */ transition: all 0.15s; /* (buttons, hovers) */
/* Meter fills: */ transition: width 0.1s; /* smooth level changes */
/* Progress bars: */ transition: width 0.3s; /* smooth progress updates */
```

### CompSync Design Principle Mapping

| CompSync Principle | OBS Plugin Equivalent |
|---|---|
| Purple/Indigo gradient background | `--bg-primary: #1e1e2e` (darker for OBS context, but accent uses same `#667eea` indigo) |
| `bg-white/10 backdrop-blur` cards | `background: var(--bg-secondary)` (solid dark, no blur — desktop app, not glass effect) |
| `from-purple-500 to-pink-500` primary button | `linear-gradient(135deg, #667eea, #764ba2)` on entry number badge + Load Competition button |
| `text-green-300` success / `text-red-300` danger | `--success: #4ade80` / `--danger: #f87171` (same Tailwind green-400/red-400 family) |
| `text-white` primary text on dark | `--text-primary: #e0e0f0` (slightly cool-toned white for OBS feel) |
| `animate-pulse` for status | Recording pulse animation on dots, borders, LIVE badge |
| Monospace for data (timers, scores) | `Consolas/Monaco` for timer, dB readout, file naming preview |
| `font-mono tabular-nums` | Applied to timer and dB readouts |

### What NOT to Invent

- No new color palette — use mockup tokens exactly
- No new component patterns — every component maps 1:1 to a mockup HTML element
- No responsive breakpoints — desktop app, fixed minimum 900x600
- No light theme — OBS plugin is always dark
- No Tailwind — plain CSS with custom properties
- No glass/blur effects — solid backgrounds (desktop perf)

---

## Step 2: Build the App

Build order (from plan, now including everything):

| # | Subsystem | Key Dependencies | Est. Files |
|---|-----------|-----------------|------------|
| 0 | Scaffold | — | 5 (generated) |
| 1 | Logging | electron-log | 3 |
| 2 | IPC + Preload | Step 1 | 4 |
| 3 | OBS Service | obs-websocket-js, Step 2 | 2 |
| 4 | Settings Service | electron-store, Step 2 | 2 |
| 5 | Schedule Parser | papaparse, Step 2 | 2 |
| 6 | State Machine | Step 4, Step 5 | 1 |
| 7 | UI Layout Shell | React, Steps 2-6 | 7 |
| 8 | Left Panel Components | zustand, Step 7 | 5 |
| 9 | Right Panel (Table) | zustand, Step 7 | 4 |
| 10 | Settings UI | Step 4, Step 7 | 9 |
| 11 | Zustand Store | All services | 1 |
| 12 | Load Competition | Step 5, Step 11 | 1 |
| 13 | Recording Pipeline | Steps 3, 6, 11 | 1 (integration) |
| 14 | FFmpeg Service | Step 6, Step 13 | 1 |
| 15 | Photo Import | exifreader, sharp, Step 6 | 2 |
| 16 | Upload Service | tus-js-client, Step 6 | 2 |
| 17 | Lower Third Server | express, Step 11 | 2 |
| 18 | Global Hotkeys | Step 13 | 1 |
| 19 | Stream/Replay Controls | Step 3 | 1 (UI wiring) |
| 20 | Crash Recovery | Step 6 | 1 |
| 21 | Installer Config | electron-builder | 1 (config) |

**~50 files total.** ~40 source files + config files.

---

## Autonomous Build Loop

Each build step follows this self-verifying cycle — no user interaction needed unless a genuine blocker is hit:

```
For each step:
  1. WRITE — Create/edit files for this step
  2. BUILD — Run `npm run build` (TypeScript compilation + Vite bundling)
  3. CHECK — If build fails:
     a. Read error output
     b. Identify root cause (missing import, type error, bad path)
     c. Fix and re-build (up to 3 attempts)
     d. If still failing after 3 attempts → log blocker, skip to next independent step
  4. VERIFY — Run step-specific checks:
     - Import resolution: does the new module import correctly?
     - Type safety: are all interfaces satisfied?
     - Runtime check (where applicable): `npm run dev` → check console for errors
  5. COMMIT — If build passes, commit with descriptive message
  6. NEXT — Move to next step
```

**Self-correction rules:**
- **Type errors:** Read the error, fix the type mismatch, rebuild. Don't suppress with `any`.
- **Missing deps:** If a package isn't installed, install it and rebuild.
- **Import path errors:** Check actual file locations, fix paths.
- **Circular deps:** Restructure to break the cycle (usually extract shared types).
- **Runtime errors in dev:** Check Electron DevTools console via the app's built-in logging, fix and rebuild.
- **electron-vite quirks:** If main/renderer/preload boundaries cause issues (e.g., importing Node modules in renderer), move code to the correct process and use IPC.

**Build checkpoints (hard gates — must pass before proceeding):**

| After Step | Gate |
|-----------|------|
| 0 (Scaffold) | `npm run dev` opens window |
| 6 (State Machine) | `npm run build` passes — all backend services compile |
| 11 (Zustand Store) | `npm run build` passes — full app compiles with all UI + services |
| 13 (Recording Pipeline) | `npm run dev` — app renders, OBS connection attempted (may fail if OBS not running, that's OK) |
| 21 (Installer) | `npm run build` passes, `npx electron-builder --win --dir` produces output |

**Between checkpoints:** Individual steps should compile but aren't hard-gated on runtime verification.

---

## Verification

1. `npm run dev` opens Electron window with full UI
2. Logs appear in `%APPDATA%/CompSyncMedia/logs/`
3. OBS connects (green dot), meters animate
4. CSV loads, routines appear in table
5. Recording works: Next → OBS records → file renamed → FFmpeg splits → MP4s appear
6. State persists across app restart
7. Photos: import from folder, EXIF matching works, photos appear in routine
8. Uploads: start queue, tus progress shows, stop/resume works
9. Lower third: OBS Browser Source at localhost:9876 shows routine info
10. Hotkeys: F5/F6/F9/F10 work with app unfocused
11. Stream toggle works
12. `npm run build` produces Windows installer
