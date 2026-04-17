# smoke-sd-import.ps1
# Post-deploy smoke test for SD-import overnight asar on DART.
# Returns 0 on pass, 1 on fail with a terse reason printed to stdout.
#
# Prerequisite (stage once on DART before overnight run):
#   - Create fixture folder C:\CompSyncSmoke\DCIM with 4+ JPG files that carry EXIF
#     DateTimeOriginal. These can be real photos from a prior session.
#   - Set OUTPUT_DIR to the active CompSync output directory (same the app writes to).
#
# Checks:
#   1. App process is running
#   2. A manifest file exists (or is created on next import)
#   3. No orphan directory older than 24h is left unclean (sanity)
#   4. Behavior setting autoImportOnDrive is true

param(
  [string]$AppName = 'CompSync Media',
  [string]$OutputDir = 'C:\CompSync\out',
  [string]$SettingsPath = "$env:APPDATA\CompSync Media\compsync-media-settings.json",
  [string]$SmokeFixtureDir = 'C:\CompSyncSmoke\DCIM'
)

$ErrorActionPreference = 'Stop'
$fail = @()

function Fail($msg) { $script:fail += $msg }

# 1. App running
$proc = Get-Process -Name $AppName -ErrorAction SilentlyContinue
if (-not $proc) { Fail "App '$AppName' is not running" }

# 2. OutputDir is writable
if (-not (Test-Path $OutputDir)) { Fail "OutputDir missing: $OutputDir" }
else {
  try {
    $probe = Join-Path $OutputDir "_smoke_probe_$([guid]::NewGuid().ToString('N')).tmp"
    Set-Content -Path $probe -Value 'ok'
    Remove-Item $probe
  } catch { Fail "OutputDir not writable: $OutputDir" }
}

# 3. Settings contain autoImportOnDrive == true
if (Test-Path $SettingsPath) {
  try {
    $settings = Get-Content $SettingsPath -Raw | ConvertFrom-Json
    if ($settings.behavior.autoImportOnDrive -ne $true) {
      Fail "settings.behavior.autoImportOnDrive is not true (got: $($settings.behavior.autoImportOnDrive))"
    }
  } catch {
    Fail "Could not parse settings at $SettingsPath"
  }
} else {
  Fail "Settings file not found: $SettingsPath"
}

# 4. _manifests dir exists OR is creatable
$manifestDir = Join-Path $OutputDir '_manifests'
if (-not (Test-Path $manifestDir)) {
  try {
    New-Item -ItemType Directory -Path $manifestDir | Out-Null
    Remove-Item $manifestDir
  } catch { Fail "_manifests directory not creatable under $OutputDir" }
}

# 5. Orphan dir sanity (warn only)
$orphanRoot = Join-Path $OutputDir '_orphans'
if (Test-Path $orphanRoot) {
  $old = Get-ChildItem $orphanRoot -Directory | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-48) }
  if ($old) {
    Write-Host "[warn] $($old.Count) orphan run dirs older than 48h — not a failure"
  }
}

# 6. Fixture dir exists (so operator can drop in the SD-shaped folder to smoke-import)
if (-not (Test-Path $SmokeFixtureDir)) {
  Write-Host "[warn] Smoke fixture dir missing — $SmokeFixtureDir (acceptable if the operator runs a real SD)"
}

if ($fail.Count -gt 0) {
  Write-Host "FAIL:"
  foreach ($m in $fail) { Write-Host "  - $m" }
  exit 1
}

Write-Host "PASS"
exit 0
