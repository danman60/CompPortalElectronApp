# VDD capture-lock — fresh-session handoff (2026-04-24 11:59 EDT)

**Scope:** Make `wifi-display-server.exe` ALWAYS capture from the Virtual Display Driver monitor, not whatever `scrap::Display::new(--monitor-index N)` picks. Touch routing to VDD is already working from an earlier fix; this is the display side that's still wrong.

**Live state right now (verify before touching anything):**

- DART `app.asar`: v14c, md5 `99D21205DA20D291DEE3FE432A5A2DD2` (freshly swapped). Respawn loop killed, routine-folder Windows-char sanitization live.
- DART `wifi-display-server.exe`: deployed earlier today, md5 `68F1DD0245D7D3F20309E07D50604C5C` at both `%APPDATA%\compsync-media\wifi-display-server.exe` AND `C:\Program Files\CompSync Media\resources\wifi-display-server.exe`. Touch-lock works; capture does not.
- Tablets on subnet: `192.168.0.120` (live tablet `KFTRWI`, hardener APK), `192.168.0.177` (test tablet, diag APK). DART is `192.168.0.90`.
- CSController APKs on Drive APKs folder (team drive `0AGB2bWreEh8wUk9PVA`, folder `11rHOUrQzXNqQtyS-t1cVWOxL1CjQ96iq`): `CSController-2026-04-24-tablet-hardener.apk` (md5 `08095207…`), `CSController-2026-04-24-diag.apk` (md5 `def6d997…`).

## Confirmed problem

From the operator today:

> "In Windows it's showing VDD attached, taps are working properly even with third monitor now hooked up and taps on tablet apk change scene as expected, just no display black screen"

And later:

> "OBS MULTIVIEW is assigned to VDD and appears properly in CRD, but the tablet feed shows the wrong feed that I'm trying to send to a different monitor"

So the VDD exists at a known `\\.\DISPLAYn` / HMONITOR rectangle. Win32's `EnumDisplayMonitors` indexes it correctly (the touch code already found it and taps land there). But `scrap::Display::all()` iterates outputs in a different order — `scrap_index=1` captures a DIFFERENT physical monitor from Win32's `enum_index=1`. User's hard requirement: **always lock both touch AND capture to the VDD**.

Evidence from live logs during today's session (machine_logs source=wifi-display):

```
Virtual desktop: 3840x1080 at (0,0)
monitor[0] 1920x1080 at (0,0)    device=\\.\DISPLAY1 adapter="Generic PnP Monitor"
monitor[1] 1920x1080 at (1920,0) device=\\.\DISPLAY8 adapter="Generic PnP Monitor"
Touch target LOCKED to monitor[1] at (1920,0) device=\\.\DISPLAY8 — reason: --monitor-index fallback
Capturing monitor #1: 1920x1080
```

Touch locks to `\\.\DISPLAY8` (VDD). Capture says `monitor #1` but that's scrap's index 1, which in DXGI output order may be `\\.\DISPLAY1` instead. Both monitors are `1920x1080` so you can't disambiguate by resolution.

## Related bug (fix at the same time)

`adapter_string_for_device` in `WifiDisplay/server/src/input.rs` calls `EnumDisplayDevicesW(PCWSTR(wide.as_ptr()), 0, ...)` with `szDevice` as the first arg. That's the "monitors attached to a display device" form, returning `"Generic PnP Monitor"` (the monitor-panel DeviceString, NOT the adapter). To get the actual adapter DeviceString ("Virtual Display Driver", "IddSampleDriver Device", "Parsec Virtual Display Adapter", "NVIDIA RTX 4070" etc.), call `EnumDisplayDevicesW(NULL, iDevNum, ...)` iterating iDevNum, which returns adapters. Build a `DeviceName → DeviceString` map and look up each monitor's szDevice there.

Fixing this makes the existing `looks_like_vdd` heuristic actually work on DART (right now every adapter returns "Generic PnP Monitor" so the heuristic falls through to `--monitor-index`).

## Design

scrap 0.5 (in `WifiDisplay/server/Cargo.toml`) does NOT expose monitor position or device name. Two shippable paths:

### Path A — fork scrap locally to expose DeviceName

Smallest surface change.

1. Clone scrap 0.5 source into the repo as `WifiDisplay/server/crates/scrap-local/` (or similar).
2. On Windows (`platform/windows/capturable_display.rs` or equivalent), `IDXGIOutput::GetDesc()` returns a `DXGI_OUTPUT_DESC` whose `DeviceName` field (wide string, up to 32 chars) is the same form as Win32's `\\.\DISPLAYn`. Expose this as:
   ```rust
   impl Display {
       pub fn device_name(&self) -> String { ... }
   }
   ```
3. Point Cargo.toml at the local crate: `scrap = { path = "crates/scrap-local" }`.
4. In `capture.rs::capture_loop`, replace the `monitor_index`-based pick with a DeviceName match. Pass the selected Win32 VDD `szDevice` in from `input.rs` (or discover it the same way inside capture.rs):
   ```rust
   let target_device_name = resolve_vdd_device_name()?;  // same heuristic as touch-lock
   let display = Display::all()?.into_iter()
       .find(|d| d.device_name().eq_ignore_ascii_case(&target_device_name))
       .context("VDD display not found among scrap displays")?;
   ```
5. Log the selection line: `"Capture target LOCKED to device=\\.\DISPLAYn size=WxH — reason: <whichever match won>"`.

### Path B — bypass scrap for selection, keep it for capture

Bigger but no fork.

1. Use `windows` crate's DXGI bindings (`IDXGIFactory1 → EnumAdapters1 → IDXGIAdapter1 → EnumOutputs → IDXGIOutput → GetDesc`) to enumerate outputs directly and capture each output's DeviceName.
2. Same matching by DeviceName.
3. scrap's public API doesn't let you construct a `Display` from an arbitrary `IDXGIOutput`, so you'd have to work around with whatever scrap exposes. This path is harder — Path A is cleaner.

## Execution plan

Assumes Path A.

1. `cd ~/projects/WifiDisplay/server`
2. Read current `Cargo.toml` to confirm `scrap = "0.5"` pinning.
3. `cargo search scrap` or check crates.io for 0.5.0's exact git tag. Clone from there.
4. Add `device_name()` accessor; verify it compiles standalone with `cargo check`.
5. Patch `input.rs::adapter_string_for_device` to use the correct `EnumDisplayDevicesW(NULL, iDevNum, ...)` iteration AND build a DeviceName→DeviceString adapter map. Extract the VDD-selection logic into a reusable function that returns both the `MonitorBounds` for touch AND the `device_name` for capture.
6. Patch `capture.rs::capture_loop` to accept a `target_device_name: String` parameter instead of `monitor_index: usize`. Use `Display::all().into_iter().find(|d| d.device_name() == target_device_name)`.
7. Update `main.rs` (or wherever capture_loop is invoked) to thread the device_name through from the monitor-selection code.
8. Keep `--monitor-index` arg as a fallback when VDD heuristic + env override both miss.
9. `cargo build --release --target x86_64-pc-windows-gnu`
10. Stage at `~/projects/WifiDisplay/staging/2026-04-24-vdd-capture-lock/wifi-display-server.exe`
11. Compute md5.

## Deployment (operator-gated, no asar swap needed)

The exe swap does NOT require closing CSE. Just wifi-display-server.

1. Operator taps Tablet button once → `wifiDisplay.stop()` kills the Rust process.
2. I scp new exe to `C:\CompSyncStaging\2026-04-24-vdd-capture-lock\wifi-display-server.exe`, verify hash.
3. I back up and replace both:
   - `%APPDATA%\compsync-media\wifi-display-server.exe` (the live copy)
   - `C:\Program Files\CompSync Media\resources\wifi-display-server.exe` (so restart doesn't revert)
4. Operator taps Tablet button again to start → new exe spawns → look for:
   - `monitor[N] ... adapter="<real name>"` (should be meaningful now, not all "Generic PnP Monitor")
   - `Touch target LOCKED to monitor[N] ... reason: VDD heuristic match` (or env match)
   - `Capture target LOCKED to device=\\.\DISPLAYn — reason: <same>`
   - Tablet feed should now show whatever's on the VDD monitor (OBS Multiview per operator's setup).

## Rollback

The current binary backup is at `%APPDATA%\compsync-media\wifi-display-server.exe.bak.20260424-pre-vdd-lock` and the same in resources. If the new build misbehaves, swap back.

## What NOT to do

- Do NOT rebuild the asar. Capture logic is NOT in CSE. A fresh session that tries to asar-swap for this is doing unnecessary work and risks regressing v14c.
- Do NOT touch the CSController APK. Tablet-side is working (UdpReceiver recovery firing on schedule per diag APK logs).
- Do NOT close CSE for the swap. Only stop wifi-display-server via the Tablet button.

## Verification queries (paste after deploy)

```sql
-- First 30s after swap: adapter strings should be meaningful, not all Generic PnP
SELECT received_at AT TIME ZONE 'America/New_York' AS edt, left(message, 400) AS msg
FROM machine_logs
WHERE tenant_slug='udc' AND host_id='DART' AND source='wifi-display'
  AND received_at > now() - interval '60 seconds'
  AND (message ILIKE '%monitor[%' OR message ILIKE '%LOCKED%' OR message ILIKE '%Capture target%')
ORDER BY received_at DESC LIMIT 20;
```

And confirm the tablet is receiving continuous video (frags per 5s should be ~150 at 26fps, not the 1-5 we saw during the respawn loop).

## Standing show-ops rules (do not violate)

- NEVER close, kill, or swap anything on DART without explicit operator go.
- Photo pipeline is blocked when videos respawn; v14c keeps it unblocked, don't regress.
- Logs authoritative at CompPortal `machine_logs`, not SSH.
- Eastern time in all user-facing output.
