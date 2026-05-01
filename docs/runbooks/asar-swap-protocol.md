# Asar swap protocol — optimal pre-staged cutover

**Trigger:** any time the operator wants a CSE asar update applied to DART.

**Core rule:** the build + scp must happen BEFORE the operator closes the app. The "swap" itself is a sub-10-second cutover. Anything else wastes operator time and is a process bug.

---

## Phases

### Phase 1 — Pre-stage (operator still using app)

As soon as the patch batch is ready and committed to a feature branch:

1. `cd /home/danman60/projects/CompSyncElectronApp`
2. `npm run build` (electron-vite — ~30-60s)
3. `npx electron-builder --win --dir` (electron-builder — ~60-120s)
4. Verify asar exists: `ls -la release/win-unpacked/resources/app.asar`
5. `scp -O release/win-unpacked/resources/app.asar dart:/CompSync-staging/app.asar.new`
6. Verify landing: `ssh dart "powershell -NoProfile -Command \"Get-Item 'C:\\CompSync-staging\\app.asar.new' | Format-List Name, Length, LastWriteTime\""`
7. Report to operator: "Asar staged at `C:\CompSync-staging\app.asar.new` (`<size>` bytes, build `<time>`). Ready for SWAP whenever you close the app."

**Total elapsed: ~2-4 min from `git commit` to "ready" message. Run while operator is still using the app — they don't notice the build.**

### Phase 2 — Cutover (operator says "swap" or "app closed")

Single SSH round-trip — three Move-Item calls in one PowerShell, then launch:

```bash
ssh dart "powershell -NoProfile -Command \"Move-Item 'C:\\Program Files\\CompSync Media\\resources\\app.asar' 'C:\\Program Files\\CompSync Media\\resources\\app.asar.bak.<YYYYMMDD-tag>' -Force\""

ssh dart "powershell -NoProfile -Command \"Move-Item 'C:\\CompSync-staging\\app.asar.new' 'C:\\Program Files\\CompSync Media\\resources\\app.asar' -Force\""

ssh dart "powershell -NoProfile -Command \"Start-ScheduledTask -TaskName 'LaunchCompSyncMedia'\""
```

**IMPORTANT: each Move-Item gets its OWN ssh invocation.** Multi-line PowerShell here-strings inside `ssh` get mangled by quoting layers (bash → ssh → PowerShell). Burlington UDC 2026-05-01 incident: a multi-line invocation produced empty output, swap silently no-opped, asar stayed at the OLD version. Single-line per-step is robust.

### Phase 3 — Verify (within ~10s of launch)

```bash
ssh dart "powershell -NoProfile -Command \"Get-Item 'C:\\Program Files\\CompSync Media\\resources\\app.asar' | Format-List Name, Length, LastWriteTime\""
ssh dart "powershell -NoProfile -Command \"Get-Process -Name 'CompSync Media' -ErrorAction SilentlyContinue | Select-Object Id, CPU, Responding | Format-Table -AutoSize\""
```

Expected:
- `LastWriteTime` matches the new asar's mtime (the staging file you scp'd)
- `Length` matches the new asar size
- 3-4 `CompSync Media` processes, all `Responding=True`

Report to operator: "Live, app responding, new asar in place."

---

## Anti-patterns (things NOT to do)

- ❌ Wait for operator to say "swap" before starting the build. **Build during their app-running window.**
- ❌ Bundle multi-step PowerShell into a single ssh call with multi-line here-strings. **One ssh per Move-Item / Start-ScheduledTask.**
- ❌ Use `dist/` as the asar output path. electron-builder writes to `release/win-unpacked/resources/app.asar`.
- ❌ Skip the verify step. Length + LastWriteTime mismatch = swap didn't actually happen (Burlington UDC 2026-05-01 hit this).
- ❌ Run the build in main Claude context. Use a subagent OR background bash with `run_in_background: true`. Main context blocks the operator chat.
- ❌ Touch the live app on DART without operator confirmation it's closed. Per [feedback_never_close_app_on_dart] — operator owns the close decision.

---

## Backup naming convention

`app.asar.bak.<YYYYMMDD>-<tag>` — e.g.:
- `app.asar.bak.20260501-burl-mid` (mid-show patch)
- `app.asar.bak.20260430-iter9` (iter-9 ship)
- `app.asar.bak.20260423` (date-only when no semantic tag)

Keep last ~5 backups in `C:\Program Files\CompSync Media\resources\`. Rolling cleanup is manual operator concern.

---

## Rollback procedure (if new asar misbehaves)

Same Phase 2 sequence in reverse:

```bash
ssh dart "powershell -NoProfile -Command \"Stop-Process -Name 'CompSync Media' -Force -ErrorAction SilentlyContinue\""
# (only if operator confirms close — never auto-kill)

ssh dart "powershell -NoProfile -Command \"Move-Item 'C:\\Program Files\\CompSync Media\\resources\\app.asar' 'C:\\Program Files\\CompSync Media\\resources\\app.asar.bad.<tag>' -Force\""

ssh dart "powershell -NoProfile -Command \"Move-Item 'C:\\Program Files\\CompSync Media\\resources\\app.asar.bak.<tag>' 'C:\\Program Files\\CompSync Media\\resources\\app.asar' -Force\""

ssh dart "powershell -NoProfile -Command \"Start-ScheduledTask -TaskName 'LaunchCompSyncMedia'\""
```

---

## Burlington UDC 2026-05-01 mid-show incident (what went wrong)

**Symptom:** operator said "ready for swap" after closing app; build hadn't started; total cutover took ~5 min instead of <10s.

**Causes:**
1. Build wasn't pre-staged. I waited for the swap signal before starting `npm run build`.
2. First swap attempt used multi-line PowerShell here-string inside `ssh dart`. Output was blank, swap didn't happen, asar verified as still the OLD version.
3. Re-attempted with one-ssh-per-step pattern. Worked.

**Lessons baked into this doc:**
- Pre-stage during operator's working window
- One ssh per Move-Item
- Verify Length + LastWriteTime after every swap

---

## Quick-reference: full sequence in copy-paste form

```bash
# PHASE 1 (during operator's working window, after commit)
cd /home/danman60/projects/CompSyncElectronApp
npm run build && npx electron-builder --win --dir
ls -la release/win-unpacked/resources/app.asar
scp -O release/win-unpacked/resources/app.asar dart:/CompSync-staging/app.asar.new
ssh dart "powershell -NoProfile -Command \"Get-Item 'C:\\CompSync-staging\\app.asar.new' | Format-List Name, Length, LastWriteTime\""

# Tell operator: ready for SWAP

# PHASE 2 (operator confirms app closed)
ssh dart "powershell -NoProfile -Command \"Move-Item 'C:\\Program Files\\CompSync Media\\resources\\app.asar' 'C:\\Program Files\\CompSync Media\\resources\\app.asar.bak.<TAG>' -Force\""
ssh dart "powershell -NoProfile -Command \"Move-Item 'C:\\CompSync-staging\\app.asar.new' 'C:\\Program Files\\CompSync Media\\resources\\app.asar' -Force\""
ssh dart "powershell -NoProfile -Command \"Start-ScheduledTask -TaskName 'LaunchCompSyncMedia'\""

# PHASE 3 (verify)
sleep 8
ssh dart "powershell -NoProfile -Command \"Get-Item 'C:\\Program Files\\CompSync Media\\resources\\app.asar' | Format-List Name, Length, LastWriteTime\""
ssh dart "powershell -NoProfile -Command \"Get-Process -Name 'CompSync Media' -ErrorAction SilentlyContinue | Select-Object Id, CPU, Responding | Format-Table -AutoSize\""

# Report: app live, new asar in place
```
