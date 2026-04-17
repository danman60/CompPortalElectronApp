# SD-Import Overnight Deploy Runbook

Date: 2026-04-17
Target: DART (Windows, CompSync Media installed at `C:\Program Files\CompSync Media`)
Artifact: `/tmp/sd-import-overnight/app.asar`
SHA256: see `/tmp/sd-import-overnight/app.asar.sha256`
Source branch: `feat/sd-import-overnight`

## Pre-flight (Linux host, before dinner break)

```bash
# 1. Verify branch is committed + clean
cd /home/danman60/projects/CompSyncElectronApp
git log feat/sd-import-overnight --oneline | head -10

# 2. Verify artifact exists
ls -la /tmp/sd-import-overnight/app.asar
cat /tmp/sd-import-overnight/app.asar.sha256

# 3. Verify E2E passes
node tests/e2e-sd-import.mjs
# Expect: "13 passed, 0 failed"
```

## scp to DART

```bash
# From Linux host — replace DART_IP / DART_USER
scp /tmp/sd-import-overnight/app.asar DART_USER@DART_IP:"C:/Users/Public/sd-import-overnight/"
scp /tmp/sd-import-overnight/app.asar.sha256 DART_USER@DART_IP:"C:/Users/Public/sd-import-overnight/"
```

If scp is not set up, use WinSCP or the shared SMB folder.

## On DART — dinner break cutover

Run as Administrator (UIPI requires it for the running CompSync Media process).

```powershell
# 1. Verify transferred artifact
cd C:\Users\Public\sd-import-overnight
Get-FileHash app.asar -Algorithm SHA256
# Compare to app.asar.sha256

# 2. Confirm with operator that there is no routine actively recording/uploading
#    (Look at the CompSync Media UI — nothing should be in 'recording' or 'uploading' state)

# 3. Gracefully stop the app
#    Prefer File > Quit in the UI. Fall back to Stop-Process only if UI is frozen.
Get-Process "CompSync Media" -ErrorAction SilentlyContinue

# 4. Back up the current asar
$asarPath = 'C:\Program Files\CompSync Media\resources\app.asar'
$backupPath = "$asarPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $asarPath $backupPath

# 5. Swap in the new asar
Copy-Item C:\Users\Public\sd-import-overnight\app.asar $asarPath -Force

# 6. Restart the app (double-click icon OR:)
Start-Process 'C:\Program Files\CompSync Media\CompSync Media.exe'

# 7. Smoke test
C:\path\to\smoke-sd-import.ps1 -OutputDir "C:\CompSync\out"
# Expect: "PASS" and exit 0
```

## Post-deploy validation (first hour)

1. Insert a test SD (or mount the Smoke fixture dir as a drive).
2. Observe DriveAlert modal appears and — with no click — import kicks off automatically.
3. Inspect `C:\CompSync\out\_manifests\sd-import.json` — should have a new run entry.
4. If there are unmatched photos, inspect `C:\CompSync\out\_orphans\<runId>\` — each `.jpg` should have a sibling `.jpg.json` sidecar.
5. Verify upload completes (look at UI progress). After /complete ACK, the local `photos/photo_001.jpg` (etc) should be deleted. The manifest entry gets `uploaded: true` + `storagePath`.
6. Re-insert the same SD. Zero duplicate uploads should happen; manifest size stays the same.

## Rollback (if anything is wrong)

```powershell
# Identify most recent backup
$asarPath = 'C:\Program Files\CompSync Media\resources\app.asar'
$latestBak = Get-ChildItem "$asarPath.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

# Stop app, swap, restart
Get-Process "CompSync Media" -ErrorAction SilentlyContinue | Stop-Process -Force
Copy-Item $latestBak.FullName $asarPath -Force
Start-Process 'C:\Program Files\CompSync Media\CompSync Media.exe'
```

Known-good fallback asar if the .bak is missing: deploy `v2.7.0-stable` (commit `11b97af`) from a prior build drop.

## Emergency mitigations

If the auto-import loops or hammers uploads:
- Open Settings → Behavior → untick "Auto-Import on Drive" (key: `behavior.autoImportOnDrive`). Saves immediately.
- Settings file path: `$env:APPDATA\CompSync Media\compsync-media-settings.json`

If the manifest is corrupt:
- The manifest is append-only + atomic-rename safe, but if it is somehow invalid JSON, delete `C:\CompSync\out\_manifests\sd-import.json`. The next import run will recreate it (dedup resets — may re-upload the last batch).
