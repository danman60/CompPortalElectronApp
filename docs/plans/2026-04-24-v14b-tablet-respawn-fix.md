# v14b — tablet wifi-display respawn-loop fix + VDD capture lock

**Created:** 2026-04-24 11:05 EDT during live UDC Toronto Day 1
**Scope:** Fresh session handoff. Nothing touching DART without explicit operator go.

## TL;DR — what's wrong, what's fixed, what's still open

### Wrong (live symptom today)

On DART right now, `wifi-display-server.exe` respawns every 3-5 seconds because of a bug I shipped in **v14 asar** (the one currently live on DART, md5 `7FABB035DA89ADE4B04CC4811DAA6588` at `C:\Program Files\CompSync Media\resources\app.asar`).

Evidence from `machine_logs` (2026-04-24 11:01:44 → 11:02:02 window, 18 seconds):

- 4 spawn cycles, PIDs `20048 → 16468 → 3028 → 6424`
- clientIp oscillates between `192.168.0.90` (DART's own IP) and `192.168.0.177` (test tablet)
- Live tablet (`.120`, id `KFTRWI`) receives ~5s of stream every ~15s — `frags=48 NALs=3 rendered=3` bursts

Root cause: two things in `src/main/services/wifiDisplay.ts` on the v14 branch tip (`9297a4f`):

1. `start()` calls `pingTabletForDiscovery()` twice (at +500ms and +2000ms). That broadcasts to `255.255.255.255:5002`. On Windows the broadcast loops back to our own discovery socket with `rinfo.address = <local interface IPv4>`. The drift handler sees a "new" IP (DART's own) that differs from saved `clientIp`, persists it, respawns wifi-display-server with `--client <DART IP>`. Packets then go into the void.
2. When a real tablet discover-request arrives (e.g. `.177` or `.120`), the same handler respawns pointed at it. The previous self-echo or second-tablet echo respawns again. Pong match.

### Fixed in this branch (NOT deployed)

Branch: `feat/sd-import-overnight`, patch is **uncommitted** in `src/main/services/wifiDisplay.ts` (leave it in the working tree until the fresh session verifies + commits). Three concrete changes already applied:

1. **New module-level flag** `driftAdoptedThisSession`. Reset on every `start()` and `stop()`. The drift handler consults it and adopts at most ONE IP per wifi-display session. Stops the pong-match.
2. **New helper `getLocalIpv4s()`**. The discovery `on('message')` handler calls it and returns early if `rinfo.address` is one of our own interface IPs. Kills the self-echo path even if future code re-introduces pingTabletForDiscovery.
3. **Removed both `setTimeout(() => { pingTabletForDiscovery() }, ...)` calls from `start()`**. The exported function is still defined for future IPC wiring, but the automatic self-broadcast on start is gone. Replaced the block with an explanatory comment.

`npx tsc --noEmit` is clean on the branch as of this commit.

### Still open (not attempted yet)

**VDD capture lock.** User's hard requirement: tablet display must ALWAYS mirror the Virtual Display Driver monitor, for both touch AND capture. Current state:

- Touch IS locked to VDD (my existing v14 Rust code matches VDD by adapter string — works even though adapter lookup is imperfect, because fallback picks `--monitor-index 1` which happens to be the VDD in EnumDisplayMonitors order).
- Capture is NOT locked. `scrap::Display::new(--monitor-index 1)` uses a different iteration order than EnumDisplayMonitors. User observation (authoritative): OBS Multiview is assigned to VDD and renders correctly on VDD in Chrome Remote Desktop view, but the tablet feed shows the OTHER monitor's content.

`scrap` 0.5 (the crate used by `WifiDisplay/server/src/capture.rs`) exposes `.width()` and `.height()` only, NOT `.x()` / `.y()` / origin / device name. Both of DART's monitors are `1920x1080`, so there's no unique bounds to match against.

Path to fix — bigger change:

- Bypass scrap's monitor selection. Use the `windows` crate's `IDXGIFactory → EnumAdapters → IDXGIAdapter → EnumOutputs` to get each DXGI output's `DeviceName` (`\\.\DISPLAYn`).
- Map the Win32 VDD target (szDevice from EnumDisplayMonitors + MONITORINFOEXW, already captured in `input.rs`'s enhanced enumeration) to the DXGI output with the same DeviceName.
- Hand the matched DXGI output to scrap's `Capturer::new()`. `scrap::Capturer::new(display)` takes a `Display`, and on Windows `scrap::Display` is constructible from a DXGI output via its lower-level constructor — or fork scrap locally to expose what we need. Either is doable, not fast.

Estimated effort: ~30-60 min Rust including rebuild + test on a spare machine.

**Adapter string lookup is wrong in my existing v14 Rust code.** `EnumDisplayDevicesW(szDevice, iDevNum=0, ...)` returns the MONITOR DeviceString (e.g. "Generic PnP Monitor"), not the ADAPTER DeviceString. To get the adapter (where "Virtual Display Driver" / "IddSampleDriver Device" / "Parsec Virtual Display Adapter" would appear):

- Call `EnumDisplayDevicesW(NULL, iDevNum, ...)` iterating `iDevNum = 0..N` to enumerate ADAPTERS.
- Each adapter's `DeviceName` is `\\.\DISPLAYn`, and `DeviceString` is the GPU / VDD name.
- Build a `DeviceName → DeviceString` map.
- Look up the monitor's szDevice in that map.

This fix would make the heuristic actually work on DART. Right now it falls through to `--monitor-index` because every monitor reports adapter="Generic PnP Monitor" which doesn't match "virtual/idd/vdd/parsec/amyuni/deskreen". Not fatal (fallback picks VDD index 1 via luck), but should be fixed at the same time as the capture lock.

## Exact fresh-session execution plan

Priority order — #1 is the live-show blocker, #2 and #3 are the "always VDD" ask.

### Step 1 — ship v14b asar (kill respawn loop)

**Precondition:** app is closed on DART (operator gates).

1. Confirm branch state:
   ```bash
   cd ~/projects/CompSyncElectronApp
   git status --short src/main/services/wifiDisplay.ts
   # should show: M src/main/services/wifiDisplay.ts (uncommitted patch from session 2026-04-24 late morning)
   git log --oneline -3
   # HEAD should be: 9297a4f wifiDisplay: auto-respawn on tablet-IP drift + post-start tablet ping
   ```
2. Type-check:
   ```bash
   npx tsc --noEmit
   ```
3. Commit the patch:
   ```bash
   git add src/main/services/wifiDisplay.ts
   git commit -m "v14b: fix wifi-display respawn loop (self-echo + drift pong)"
   git push
   ```
4. Build asar (same pattern as v14):
   ```bash
   npx electron-vite build
   npx electron-builder --win --dir
   # Resulting asar at: release/win-unpacked/resources/app.asar
   mkdir -p staging/2026-04-24-v14b
   cp release/win-unpacked/resources/app.asar staging/2026-04-24-v14b/app.asar
   md5sum staging/2026-04-24-v14b/app.asar
   ```
5. scp to DART staging (only if app is closed):
   ```bash
   ssh dart 'if not exist C:\\CompSyncStaging\\2026-04-24-v14b mkdir C:\\CompSyncStaging\\2026-04-24-v14b'
   scp staging/2026-04-24-v14b/app.asar dart:C:/CompSyncStaging/2026-04-24-v14b/app.asar
   ssh dart 'powershell -NoProfile -Command "Get-FileHash C:\\CompSyncStaging\\2026-04-24-v14b\\app.asar -Algorithm MD5"'
   # verify hash matches local
   ```
6. Operator-gated swap on DART (app closed):
   ```powershell
   cd "C:\Program Files\CompSync Media\resources"
   Rename-Item app.asar app.asar.bak.20260424-v14
   Copy-Item C:\CompSyncStaging\2026-04-24-v14b\app.asar .
   Get-FileHash app.asar -Algorithm MD5    # expect NEW hash matching staging
   ```
7. User starts app. Watch `machine_logs` for:
   - First expected line: `"Wifi display started (PID ..., monitor index 1)"` — should appear once on app start, NOT repeatedly.
   - Over 60 seconds, count `"Starting wifi display:"` lines. MUST be 1. If it's >1, the fix failed — revert to pre-v14b via backup.
   - `"Discovery request ignored (self-IP ..."` at debug level (won't show at info) — indicates the self-IP filter is working. Can bump to info temporarily if need to verify.
   - `"Tablet IP drift detected (one-shot): ..."` AT MOST ONCE per session. Seeing it twice means the one-shot guard failed.
8. Verify on tablet: UdpReceiver stats should show continuous frags (not 5s-burst-then-15s-silent pattern). Expect `frags` per 5s around 150-200, `NALs` close to the server's fps × 5.

### Step 2 — fix the adapter-lookup bug in wifi-display-server

The current Rust code at `~/projects/WifiDisplay/server/src/input.rs` calls `EnumDisplayDevicesW(PCWSTR(wide.as_ptr()), 0, ...)` with `wide = szDevice`. That gets MONITOR info. We want ADAPTER info.

Patch approach:

1. Change `adapter_string_for_device` to first enumerate adapters:
   ```rust
   fn build_adapter_map() -> HashMap<String, String> {
       let mut map = HashMap::new();
       for i in 0u32.. {
           let mut dd = DISPLAY_DEVICEW { cb: size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
           let ok = unsafe { EnumDisplayDevicesW(PCWSTR::null(), i, &mut dd, 0) }.as_bool();
           if !ok { break; }
           let name = wide_to_string(&dd.DeviceName);        // "\\.\DISPLAYn"
           let string = wide_to_string(&dd.DeviceString);     // "Virtual Display Driver" / "NVIDIA GeForce RTX 4070" / etc.
           map.insert(name, string);
       }
       map
   }
   ```
2. Replace per-call `adapter_string_for_device(device_name)` with a single `build_adapter_map()` at the start of `enumerate_monitors`, then `map.get(&monitor.device_name).cloned().unwrap_or_default()`.
3. Rebuild: `cargo build --release --target x86_64-pc-windows-gnu`.
4. Stage to `~/projects/WifiDisplay/staging/2026-04-24-vdd-lock-v2/wifi-display-server.exe`.

### Step 3 — lock capture to VDD (the "ALWAYS VDD display" ask)

`scrap` 0.5 doesn't expose position / DeviceName. Two options:

**Option A — fork scrap locally, add an accessor.** Lowest-risk approach:
- Clone `scrap = "0.5"` source locally into the repo (or a `crates/scrap-local` path).
- Add a getter: `impl Display { pub fn device_name(&self) -> String { ... } }` that returns the underlying DXGI output's name on Windows.
- In `capture.rs`, instead of `Display::all().nth(monitor_index)`, iterate `Display::all()` and pick the one whose `device_name()` matches the VDD's `szDevice` (passed in from `input.rs` selection).
- Point Cargo.toml at the local crate: `scrap = { path = "../../scrap-local" }`.

**Option B — bypass scrap for monitor selection.** Use `windows` crate DXGI bindings to enumerate outputs, get DeviceName for each, find the one matching VDD's szDevice, then construct a `scrap::Display` from that specific `IDXGIOutput`. Harder because scrap's `Display` struct is private-constructor — Option A may be easier.

Both paths end with capture and touch pointing at the same physical monitor regardless of `scrap` vs `EnumDisplayMonitors` iteration order. That's the user's "ALWAYS VDD" requirement.

Estimated effort: 1-2 hours to implement, rebuild, stage. Should NOT block step 1.

### Step 4 — verify tablet still works with the new stack

Stage the new wifi-display-server.exe to DART alongside v14b asar:
```
C:\CompSyncStaging\2026-04-24-v14b\wifi-display-server.exe
```
And during the swap window, replace both:
- `C:\Users\User\AppData\Roaming\compsync-media\wifi-display-server.exe` (the running copy — userData path is `compsync-media` LOWERCASE with dash, NOT `CompSync Media` with space)
- `C:\Program Files\CompSync Media\resources\wifi-display-server.exe`

Keep the `.bak.20260424-pre-vdd-lock` backups in place for rollback.

On successful start, look for:
- `monitor[N] WxH at (x,y) device=\\.\DISPLAYn adapter="<real adapter name>"` — every monitor's adapter string should now be meaningful (e.g. "NVIDIA RTX 4070", "Virtual Display Driver"), NOT all "Generic PnP Monitor".
- `Touch target LOCKED to monitor[N] ... reason: VDD heuristic match` — heuristic should succeed now that adapter strings are real.
- `Capturing monitor ... device=\\.\DISPLAYn` — same szDevice as touch target. This is the proof that capture IS locked to VDD.

## Rollback paths

**If v14b asar makes things worse:**
```powershell
cd "C:\Program Files\CompSync Media\resources"
Copy-Item app.asar.bak.20260424-v14 app.asar -Force
# or if pre-v14 is preferred:
# Copy-Item app.asar.bak.20260424-pre-v14 app.asar -Force
```

**If new wifi-display-server.exe makes things worse:**
```powershell
$ud = "C:\Users\User\AppData\Roaming\compsync-media"
Copy-Item "$ud\wifi-display-server.exe.bak.20260424-pre-vdd-lock" "$ud\wifi-display-server.exe" -Force
Copy-Item "C:\Program Files\CompSync Media\resources\wifi-display-server.exe.bak.20260424-pre-vdd-lock" "C:\Program Files\CompSync Media\resources\wifi-display-server.exe" -Force
```

## Standing rules (inherited from session context)

- **Never close, restart, kill, or swap anything on DART without explicit operator go.** Even during app-closed windows, confirm before touching files.
- Logs are CompPortal-authoritative. `machine_logs` table via `/api/admin/machine/logs?tenant=udc&n=500` or the livestream admin Dashboard Logs panel.
- No destructive DB ops.
- Eastern time in all user-facing output.
- The test tablet IP appears to be `192.168.0.177`. Live tablet is `192.168.0.120`. DART is `192.168.0.90`. All three were observed sending UDP to DART in the last hour of logs.

## Artifact inventory at end of this session

- Branch `feat/sd-import-overnight` on `CompSyncElectronApp`, HEAD `9297a4f`, uncommitted patch in `src/main/services/wifiDisplay.ts` (the respawn-loop fix — finish by running step 1).
- `~/projects/CompSyncElectronApp/staging/2026-04-24-v14/app.asar` (md5 `7fabb035...`) — the BROKEN v14 asar, currently live on DART. DO NOT RE-USE — build v14b from the fixed branch instead.
- `~/projects/WifiDisplay/staging/2026-04-24-vdd-lock/wifi-display-server.exe` (md5 `68f1dd02...`) — has good touch lock via `--monitor-index` fallback, but adapter lookup is broken and capture not locked to VDD. Live on DART now.
- `~/projects/CSController/staging/2026-04-24-tablet-hardener/CSController-2026-04-24-tablet-hardener.apk` (md5 `08095207...`) — installed on live tablet. Self-heal on 15s silent works correctly, confirmed by logs.
- Drive: APK uploaded at fileId `18ij8ZJLjVPoN9gLRmfIQM_W_fZAjewin` in APKs folder.

On DART right now (as of 2026-04-24 11:05 EDT):
- `app.asar` md5 `7FABB035...` (live v14, BROKEN — respawn loop)
- `wifi-display-server.exe` md5 `68F1DD02...` (live, benign)
- settings clientIp: oscillating between `192.168.0.90`, `192.168.0.120`, `192.168.0.177`
