# CompSync Media Electron App — UX/Code Audit Prompt

## Context

CompSync Media is a desktop Electron app (v2.2.0) for dance competition broadcast production. It controls OBS, records routines, splits multi-track audio via FFmpeg, imports/matches photos, and uploads media to the CompSync backend.

**Stack:** Electron 33 + React 18 + TypeScript + Zustand + electron-vite
**Platform:** Windows (NSIS installer)
**Location:** `D:\ClaudeCode\CompSyncElectronApp\`

## Audit Scope

### 1. UI/UX Review (Manual)
Since this is a desktop app without a public URL, the audit requires launching the app locally:

```bash
cd D:\ClaudeCode\CompSyncElectronApp
npm run dev
```

**Evaluate:**
- Dark theme consistency (#1e1e2e background)
- Panel layout (LeftPanel / DragHandle / RightPanel) at various window sizes
- Settings modal (400+ lines) — field organization, label clarity, hotkey capture UX
- LoadCompetition flow — CSV browse vs API load
- RoutineTable — status indicators, progress bars, scrolling with 500+ routines
- Controls — record/stream/save buttons, disabled states
- AudioMeters — visual clarity at glance
- PreviewPanel — OBS screenshot update rate
- LowerThirdControls — fire/hide/auto-fire toggle
- ErrorBoundary — fallback UI quality
- DragHandle — drag affordance, cursor feedback

### 2. Code Quality Scan
```bash
# alert() calls
grep -rn "alert(" src/ --include="*.tsx" --include="*.ts"

# console.log in production
grep -rn "console.log" src/ --include="*.tsx" --include="*.ts" | wc -l

# TODO/FIXME
grep -rn "TODO\|FIXME\|HACK\|XXX" src/ --include="*.tsx" --include="*.ts"

# Type safety
grep -rn "as any\|@ts-ignore\|@ts-expect-error" src/ --include="*.tsx" --include="*.ts"

# Error handling gaps
grep -rn "catch\s*(" src/ --include="*.ts" | grep -v "console\|log\|throw"
```

### 3. Known Issues (from CHANGELIST_V2.md)
- Stream button shows "LIVE" even when stream failed
- Always On Top doesn't apply from Settings
- NSIS installer false "app already running" warning
- Need to rename "Encode Now" to "Process Video"
- Lower third auto-hide should be number input, not dropdown

### 4. Architecture Review
- IPC channel security (40+ channels via preload bridge)
- Context isolation + sandbox settings
- safeStorage usage for credentials
- FFmpeg process management (queue, cancellation, error recovery)
- tus upload resilience (resume, retry, queue persistence)
- Photo matching algorithm accuracy
- OBS WebSocket reconnection strategy
- Crash recovery reliability
- State management (Zustand) — are there race conditions?

### 5. Build & Distribution
- electron-builder config completeness
- Native module handling (sharp, ffmpeg-static)
- Code signing status
- Auto-update mechanism (if any)
- Install/uninstall cleanup

### 6. Performance
- Memory usage with 500+ routine state
- FFmpeg encoding CPU/memory profile
- Upload queue with many files
- OBS preview frame rate impact
- Audio meter update frequency (100ms)

## Output Format

Write findings to `D:\ClaudeCode\CompSyncElectronApp\.audit\ELECTRON_AUDIT_REPORT.md` with:
- Critical / High / Medium / Low severity tables
- Code quality metrics (alert count, console.log count, TODO count)
- Architecture concerns
- Prioritized recommendations
