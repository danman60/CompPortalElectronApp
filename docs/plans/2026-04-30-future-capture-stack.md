# Future work — owning more of the capture stack

**Status:** ideas, not committed plans. Captured 2026-04-30 EDT, expanded later same evening after a longer discussion about phone-as-source architecture and truly-headless OBS.

Originally two threads (hide OBS, decouple judge audio). The discussion converged on a unified architecture: a single tier of CSE that uses an invisible OBS engine, accepts phones as sources for both video and judge audio, renders the live preview into the CSE renderer with the existing UI wrapped around a centre video window, and scales from "Pro venue with capture cards" to "Lite venue with only phones" by changing what feeds the engine — not by maintaining a separate codebase.

The threads below should now be read as a coherent product trajectory, not independent options.

---

## Architectural target (the converged shape)

Operator sees one window: CSE. The window's centre is a live video preview of whatever the engine is currently outputting. The existing UI surfaces (top band with system monitor + RECORD controls, GRAPHICS card with overlays/ticker/lower-third/chat, schedule table, action bar) wrap around that centre preview. No separate OBS window, no separate browser tab, no separate phone screen for the operator.

Engine: OBS Studio, running invisibly as `compsync-engine.exe` (renamed portable build), driven exclusively by CSE via OBS WebSocket. Operator never opens it, never sees its chrome, never knows it exists by name.

Sources feeding the engine: any combination of:
- **Capture cards** (Pro tier): existing path, unchanged.
- **Phones as video sources** (Lite tier or supplementary cameras): NDI HX Camera over LAN, vdo.ninja over WAN, or eventually a CSE-branded WebRTC source app.
- **Phones as judge audio sources** (all tiers): per-judge phone with Bluetooth headset, recording locally, uploading per-routine to CompPortal with timecode alignment.

Output of the engine: live RTMP/SRT to StreamStage or other destination, plus the multi-track MKV recording locally (judge audio tracks empty if judge audio is phone-routed).

Preview transport from engine back to renderer: Spout (Windows GPU shared texture) is the recommended path; NDI is the fallback. Renderer hosts a `<canvas>` or `<video>` wired to the receiver.

This shape collapses the "Pro vs Lite" product split into a one-axis spectrum: same engine, same control plane, same backend; what differs is whether sources come from capture cards or phones.

---

## Thread 1 — OBS as truly-invisible engine

Goal: OBS runs, does its job, the operator never sees a window, a tray icon, a taskbar entry, an alt-tab entry, or a configuration dialog. Process exists in Task Manager as `compsync-engine.exe` and that's the only forensic trace.

This is the *practical* version of what was originally sketched as "Option A" (hide + bridge preview). It turned out to be more achievable than first scoped because the bridge piece is independent (Thread 1b below) and the hiding/control piece is well-trodden ground.

### Recipe

1. **Bundle a renamed portable OBS** in CSE resources (`resources/obs/compsync-engine.exe`). Standard OBS portable mode supports running from any directory under any name. Pin a specific OBS version; update only when CSE updates.

2. **Pre-bake the scene collection + profile.** One scene with sources for capture-card / NDI / vdo.ninja receivers (sources can exist even if not always populated; missing-source dialogs suppressed). One profile with NVENC h264 encoder settings, recording path templated to flow CSE's `fileNaming.outputDirectory` in. Multi-track audio configured. Operator never opens these dialogs because they're locked.

3. **Inject stream key at runtime via OBS WebSocket.** OBS WebSocket v5 has `SetStreamServiceSettings`. CSE pulls key from existing electron-store + safeStorage encryption, pushes via WebSocket post-launch. **Key never lands in any OBS config file on disk.** Better than the current state where stream keys live in OBS profile JSON.

4. **Launch flags (these all exist today):**
   ```
   compsync-engine.exe
     --portable
     --minimize-to-tray
     --collection "CompSyncEngine"
     --profile "CompSyncEngine"
     --scene "Main"
     --disable-updater
     --disable-shutdown-check
     --multi
   ```
   `--multi` allows coexistence with operator's personal OBS install. `--disable-updater` is critical — auto-updates can corrupt a bundled install.

5. **Hide window/taskbar/tray on launch via Win32 from CSE main process:**
   - `FindWindow` for OBS window class (`Qt5QWindowIcon` or successor)
   - `ShowWindow(SW_HIDE)`
   - `SetWindowLong(GWL_EXSTYLE, ... | WS_EX_TOOLWINDOW)` to remove from alt-tab + taskbar
   - Tray icon disabled in the baked `global.ini`

6. **Error dialog suppression watcher.** Tiny Win32 helper polls every ~500ms for windows whose class is `QtWidgetsApplicationWindow` and parent process is `compsync-engine.exe`. If found and not the main hidden window, post `WM_CLOSE`. Combined with pre-emption (lock down scene collection, ship known-good source defaults, pre-validate capture devices before spawning OBS), this handles ~95% of dialog cases.

7. **Health monitor.** CSE polls OBS WebSocket every ~5s. On disconnect/timeout: `taskkill /F` on the engine, respawn with same flags, re-inject stream key, mark any active recording as `recording_interrupted` (existing reconcile path handles it). Operator sees a brief "Engine restarting…" banner — never "OBS Studio has crashed."

8. **Windows Error Reporting suppression** for the renamed binary via registry overrides set at install time:
   ```
   HKCU\...\Windows Error Reporting\LocalDumps\compsync-engine.exe → DumpType=0
   HKCU\...\Windows Error Reporting → DontShowUI=1 (scoped)
   ```

### What stays visible after all this

| Surface | Visible to operator? |
|---|---|
| OBS window | No |
| Taskbar entry / alt-tab | No |
| System tray icon | No |
| Process in Task Manager | Yes, as `compsync-engine.exe` (rarely looked at) |
| OBS files on disk | Renamed binary; not labeled "OBS" |
| Network traffic to RTMP server | Yes via Wireshark; not a UX surface |
| Crash dialogs | Suppressed via watcher + WER registry |
| Update prompts | Suppressed via `--disable-updater` |
| First-run wizard | Suppressed via pre-baked portable config |

Operationally: operator boots machine, double-clicks CompSync, sees one window. They start a recording, the show streams. They never know an engine called OBS exists. If something fails catastrophically, CSE surfaces "Engine connection lost — retrying" not "OBS-Studio.exe has crashed."

### Asterisks

- **First-run device binding.** If the operator changes capture cards or audio interfaces between shows, OBS picks up new devices but the pre-baked scene needs to bind to them. Either ship a small "Engine setup" dialog in CSE that runs WebSocket calls to bind sources to detected devices, OR lean on phone-as-source (Thread 3) which sidesteps capture-card driver concerns entirely.
- **OBS plugin compatibility.** NDI plugin, capture card plugins, audio filter plugins all need to be present in the bundled portable install. Pre-stage them; manageable in build pipeline.
- **Cold first launch can take 20-40s** while OBS initializes and connects to capture devices. CSE shows "Engine starting…" and waits on WebSocket. Subsequent launches 3-5s.
- **Installer dependencies** (VC++ redist) ship with CSE installer, ~30-50MB additional. Standard for Electron apps that bundle native deps.

### Effort

~3-4 focused weeks for a working version that passes a "show this to a non-technical operator" test:
- 1 week: bundle, rename, portable config, launch flags, WebSocket key injection
- 1 week: window/taskbar/tray hiding via Win32
- 1 week: error dialog suppression watcher + health monitor + silent restart
- 1 week: integration testing, polish, edge cases (multi-monitor, RDP sessions, headphones replug mid-show)

Plus a couple weeks of iteration during real shows when new dialog types or crash modes surface.

This is roughly a third of the effort of libobs embedding (Thread 1d below) with ~90% of the UX win. The remaining 10% is "the binary still exists in Task Manager," which nobody who matters cares about.

---

## Thread 1b — In-CSE video preview (centre video window UX)

**Key requirement: the CSE UI wraps around a centre video window.** The current top band, GRAPHICS card on the right, schedule table on the bottom, and action bar all wrap around a live video preview occupying the centre column. Operator's mental model becomes "this is the show, in CSE" — not "CSE is over here, the show is over there."

This requires bridging OBS's program output back into the CSE renderer. Without it, OBS can run invisibly but CSE has no live video to display in its centre.

### Transport options

- **Spout** (recommended): Windows-only shared GPU texture. Free, mature. `obs-spoutoutput` plugin already exists. Receiver in CSE via a small N-API native module (or a WebGL helper window that reads the shared texture). Latency ~1 frame (~16ms at 60Hz). Quality preserved (zero-copy GPU path).
- **NDI**: network-style, OBS first-party plugin. Latency 2-3 frames. Works cross-machine if needed (e.g., engine on a different host than the renderer). Slight bandwidth cost on loopback.
- **WebRTC loopback**: OBS's WebRTC output plugin → CSE renderer's `<video>` element. Works in browser-native code, no native module. Higher latency (~100-200ms) and CPU cost; useful as a fallback when native receivers are problematic.

### Layout implications

The current iter-9 layout has:
- Top band (brand, system monitor, OBS controls)
- Schedule table (centre/left, primary surface)
- GRAPHICS card (right rail)
- Action bar (top right)

For a centre-video layout:
- Top band stays
- **Centre becomes live video preview** (replaces the upper portion of the schedule table)
- Schedule table moves below the video preview, or the video shrinks during recording-active periods to give the table room
- GRAPHICS card stays right rail
- Action bar stays top right

Open layout questions for design pass (not for this doc):
- Does the schedule table compress to a thin strip below the video, or does it remain full-height with the video preview floating in a corner?
- Does the video preview resize based on routine state (full-size during a recording, thumbnail between routines)?
- Operator-toggle for "preview-first" vs "schedule-first" view?

These are design pass questions when the work begins; the doc just notes the requirement.

### Effort

On top of Thread 1's headless engine work:
- 1-2 weeks: Spout receiver native module + renderer hookup
- 2-3 weeks: layout redesign for centre video window + design iteration
- 1 week: edge cases (multi-monitor, preview during scene transitions, performance under stress)

Total Thread 1 + 1b: ~6-8 weeks.

---

## Thread 1c — CSE-owned config panels, OBS as pure backend

Originally Thread 1 Option B. Build CSE's own UI for scene/source/audio/encoder config, all backed by OBS WebSocket. Operator never sees OBS chrome at all — not even via "edit scene in OBS" escape hatches.

Trade-offs:
- ✅ Full UX ownership; CSE-shaped controls instead of OBS-shaped.
- ✅ Hide OBS-isms operators don't need (transitions, studio mode, profiles).
- ⚠️ Real surface to maintain — every audio device or encoder option needs CSE UI.
- ⚠️ OBS-WebSocket protocol becomes load-bearing.

Effort: 1-3 months on top of Thread 1 + 1b. Defer until at least one full season of stable Thread 1 + 1b operation.

---

## Thread 1d — Embed `libobs` directly

Originally Thread 1 Option C. Link libobs as a native module; no separate `compsync-engine.exe` process at all. Single binary.

Trade-offs:
- ✅ Ultimate integration; single process, single update surface.
- ✅ Stop shipping any OBS executable.
- ⚠️ libobs's API is C with manual lifecycle; misuse = silent crashes during recording.
- ⚠️ Plugin compat: capture card / NDI / virtual cam plugins assume Studio is the host; some load without issue, some need patching.
- ⚠️ Distribution bloat (~150MB+ of libobs runtime in CSE binary).
- ⚠️ Tracks upstream OBS releases — every libobs version bump is a CSE release.
- ⚠️ Renderer/main-process boundary in Electron isn't ideal for hosting D3D/OpenGL contexts.

Reference precedent: Streamlabs Desktop links libobs directly. It works but the team becomes a libobs distribution maintainer.

Effort: 6-12 months engineering plus carrying maintenance.

Defer indefinitely. Thread 1 + 1b achieves ~90% of the UX outcome at ~10% the cost.

---

## Thread 1e — Replace OBS entirely with a custom pipeline

Originally Thread 1 Option D. GStreamer / FFmpeg / Media Foundation custom pipeline. Almost certainly not worth it:

- OBS's hardware coverage is the product of ~12 years of community work (Elgato, Magewell, AVerMedia, Blackmagic, every USB capture stick, every webcam quirk).
- Encoder licensing edges (NVENC, QSV) are mostly handled by OBS's careful FFmpeg integration.
- One person at CSE can't match that surface in finite time.

Worth considering only if CSE's hardware target collapses to a single SKU forever and the OBS dependency itself becomes the failure mode. Neither is true today.

---

## Thread 2 — Judge audio decoupled via per-judge phone capture

Today every judge sits at a station wired into a multi-input audio interface (Behringer/similar). The interface routes N judge mics into OBS as separate audio tracks, captured into the multi-track MKV. Post-encode splits them into per-judge files for upload.

Failure modes seen on this path:
- 2026-04-28 R199 incident: judge audio loss because of routing/interface state (see [2026-04-28-incident-r199-judge-audio-loss.md](2026-04-28-incident-r199-judge-audio-loss.md)).
- Mixer gain staging is operator-tweakable mid-show.
- Mics get bumped, cables get unseated, judges drift off-axis.
- Judge audio goes through 4-5 hops (mic → cable → interface → OBS → mux) before it's durable.

### Architecture

- Each judge has a phone running a CSE Judge app.
- Phone is paired with a Bluetooth headset (mic + earpiece).
- Judge speaks scoring/commentary into the headset; phone records locally per routine.
- Judge enters scores on the same phone.
- Per-routine audio uploads to CompPortal/R2 directly from the phone (existing plugin-token signed-URL pattern).
- OBS no longer responsible for judge audio at all. Multi-track MKV becomes single-track (program audio only) — or OBS keeps a track for ambient/floor mic if useful.

### Live mix vs local-record (decided)

The "obvious" approach — judge phone joins live OBS mix as another audio source via WebRTC/NDI — is the wrong architecture:

- Bluetooth headset → phone mic capture: 100-400ms latency before audio leaves the phone.
- WebRTC/NDI hop to OBS: another 100-300ms.
- Total: judge audio arrives 200-700ms behind video.
- For live broadcast: catastrophic.
- For review: technically fixable via server-side timeshift, but creates a real-time pipeline failure mode where a network blip = lost judge audio for that routine, no recovery.

**The right architecture is local-record + post-routine upload + timecode alignment:**

1. **CSE broadcasts routine boundaries** over WebSocket to every judge phone:
   ```json
   { "event": "routine_started", "routine_id": "...", "started_at": "2026-04-30T20:54:00.123Z" }
   { "event": "routine_stopped", "routine_id": "...", "stopped_at": "2026-04-30T20:57:42.891Z" }
   ```
2. **Judge phone records locally** AAC or Opus, 64-128 kbps. 4 minutes ≈ 2-4 MB.
3. **Phone captures clock skew on each event.** `(phone_local_at_event - cse_server_at_event)` = clock offset.
4. **Calibrate Bluetooth headset latency once per pairing.** Phone plays a click out speaker, mic captures via Bluetooth, measures round-trip. Stores per-headset MAC. Typical HFP: 200-400ms; AAC: 100-200ms; AptX LL: 30-80ms.
5. **On routine stop, phone uploads** `routine-{id}-judge-{n}.aac` to CompPortal with metadata:
   ```json
   {
     "routine_id": "...",
     "judge_id": "...",
     "audio_started_at_phone_local": "...",
     "audio_started_at_cse_server": "...",
     "clock_offset_ms": -42,
     "bt_latency_ms": 180,
     "duration_sec": 222
   }
   ```
6. **Server stores audio aligned to routine's start_ts** with `(clock_offset_ms - bt_latency_ms)` applied.

### Sync precision this gets you

- NTP-synced phones agree with each other to within ~10-50ms.
- Clock-offset handshake corrects remaining drift.
- BT latency calibration handles headset variance.
- Final alignment error: typically 30-80ms, occasionally 100-200ms in adversarial cases.

Sample-accurate for review. Judges aren't on camera; lip-sync isn't a constraint. Sub-100ms is overkill.

### Why local-record beats live-mix

- **Resilience.** Audio is durable on the phone the moment the judge speaks. Network can fail and recover; file survives. Live-mix loses any audio during a network blip forever.
- **Quality.** Locally-encoded AAC at 128kbps is broadcast-grade. WebRTC audio is typically 32-64kbps Opus with adaptive bitrate that drops under network pressure.
- **Decoupling.** Judge audio path is independent of OBS. If OBS crashes, judge audio still records. If a judge phone dies, only that judge is lost.
- **Sync is solved for the use case.** ~50-100ms alignment is overkill for review.

### Real challenges to design around

- **Bluetooth audio quality.** HFP is mediocre. AAC bidirectional helps. Mid-tier consumer headsets need to be tested back-to-back against the current interface path before committed to. Pilot one judge per comp first, side-by-side, compare blind.
- **Venue network reliability.** Often awful. Phone records locally first, queues upload when network returns. Same model SD-import already uses.
- **Bluetooth disconnect mid-routine.** Phone notices disconnect, falls back to phone built-in mic, surfaces banner to judge, flags file as "BT-dropped" so review knows to listen.
- **Phone OS variation.** iOS + Android both. Existing CSController is Android — extend that codebase first.
- **Personal vs venue-issued phones.** Personal = privacy + battery + judge cooperation issues. Venue-issued = inventory + theft + charging logistics. Probably venue-issued for production, personal for pilots.
- **Battery.** Full comp day = phones need mid-day charging. Bench charging stations at judge area.
- **App UX for senior judges.** Large buttons, single screen per routine, no nested menus. Bar is "easier than current paper + interface workflow."

### Pipeline integration sketch

- CompPortal already accepts plugin uploads with signed R2 URLs. Add per-judge endpoint or extend `/api/plugin/upload-url` with `kind: 'judge-audio'` discriminator.
- DB: per-routine `judge_audio_files` rows linking judge_id + routine_id + R2 path + duration + clock_offset_ms + bt_latency_ms + bt_dropped flag.
- CompPortal CD media view: per-judge audio rows alongside performance video.
- Download manifest: bundles per-judge audio into the package the same way encoded video does today.
- CSE side: routine boundary broadcast already exists (WebSocket → tablet). Extend to phone judges. CSE doesn't need to ingest judge audio at all — it goes phone → CompPortal directly.

### Phased rollout

1. **Pilot** — one judge with phone + Bluetooth at a single comp. Rest stay on existing interface. Side-by-side audio comparison post-show. ~1 month build.
2. **Judge app MVP** — Android first (extend control tablet codebase). Per-routine record + score entry + queued upload. iOS once shape is right.
3. **Server pipeline** — per-judge audio in CompPortal CD view + download manifest.
4. **Production migration** — after a full season of pilots without quality regressions, retire the audio interface for net-new comps. Keep OBS multi-track as safety net for one more season before dropping.
5. **OBS audio simplification** — once judge audio fully phone-sourced, OBS recording becomes single-track or program+floor only. Smaller MKVs, simpler post-encode, less mux complexity in `ffmpeg.ts`.

### Hardware delta

- **Before:** stage cameras → capture card → OBS, mics → cables → audio interface → OBS multi-track.
- **After:** stage cameras → capture card → OBS (program track only). N phones with Bluetooth headsets, each recording its own judge.

Net: one fewer hardware class on the venue load-in list. One fewer mid-show failure mode. The audio interface stops being load-bearing.

---

## Thread 3 — Phone-as-source via NDI / vdo.ninja / WebRTC

The architectural unlock that makes the Lite tier credible (Thread 4 below) and adds resilience to the Pro tier. Phones become first-class video sources feeding the (invisible) OBS engine, alongside or in place of capture cards.

### Protocols

| Protocol | Transport | Latency | Quality | OBS integration | Cost |
|---|---|---|---|---|---|
| **NDI HX Camera** (NewTek free apps) | LAN-only (NDI) | ~200ms | Production-grade | Native via OBS NDI plugin | Free; LAN required |
| **vdo.ninja** | WebRTC over WAN | 100-500ms | Up to 1080p | Browser source or `obs-vdo-ninja` plugin | Free; works over cellular |
| **OBS Camera / Camo / DroidCam / EpocCam** | USB or WiFi | <100ms USB, ~200ms WiFi | Excellent on iPhone | Native (virtual webcam) | Free or one-time license |
| **Larix Broadcaster → local nginx-rtmp** | RTMP over LAN | 2-3s | High | Media source pointed at `rtmp://host/live` | Free |
| **Custom WebRTC bridge** (LiveKit/Daily) | WebRTC | ~100-200ms | Tunable | Browser source or virtual cam | Engineering effort |

### Recommendation

- **NDI HX Camera as v1 integration.** Free, mature apps from NewTek/Vizrt, OBS NDI plugin rock-solid. Constraint: needs working LAN. Recommendation in docs: "operator brings small travel router, all phones join its SSID, host PC plugs into it via ethernet."
- **vdo.ninja for WAN cases.** Remote judges, venues with WiFi too poor for LAN multicast. Lower quality ceiling but 99% reliable over public internet.
- **Custom WebRTC bridge as long-term branded version** — phones run CSE-branded app, push to CSE WebRTC ingest, OBS picks up from known-stable source. Probably year 2; v1 leans on NDI HX Camera with quickstart guide.

### What this unlocks

- **Capture-card driver setup becomes optional.** Pro tier can keep capture cards; Lite tier doesn't need them. NDI sources auto-discover.
- **Multi-camera resilience.** If a primary phone source drops, OBS scene fails over to a secondary phone. No physical cable to reseat.
- **Mobile camera operators.** Camera operators can roam the venue with phones instead of being tethered to a station.

### Effort

- ~3 weeks: bundle OBS NDI plugin, ship a "Engine Setup" panel in CSE that auto-discovers NDI sources on the LAN and binds them to scene sources via WebSocket, document the recommended hardware.
- Plus pilot iteration.

---

## Thread 4 — Lite tier (phone-only venues)

Combines Threads 1, 1b, 2, and 3 into a deployable product variant for studios that can't justify Pro hardware.

### Setup

- One headless host (small Mac mini, NUC, or beefy laptop) running CSE + invisible OBS. Sub-$1000 hardware.
- Operator's machine could *be* the host — they bring a laptop to the venue, run CSE, plug into a travel router.
- Travel router (~$50-100) creates a local LAN. All phones join its SSID. Host plugs in via ethernet.
- Stage cameras = phones running NDI HX Camera. 1-N phones; CSE scene config picks which is active.
- Judge audio = phones running CSE Judge app, Bluetooth headsets (Thread 2).
- No capture cards, no audio interface, no Lumix tether, no mixer.

### Hardware bill

- **Pro:** ~$3-5K of broadcast gear (Magewell capture, Behringer interface, mics, cables, mixer, multi-cam) plus a Windows recording PC.
- **Lite:** ~$800 host computer + travel router + N consumer phones (often venue-supplied or studio-owned) + Bluetooth headsets per judge.

### What stays unchanged from Pro

- Same CSE app.
- Same OBS engine (invisible).
- Same CompPortal backend.
- Same schedule, scratch, match, upload flows.
- Same control plane and operator UX.
- Same in-CSE centre video preview.

### What changes

- Different sources feeding the engine (NDI from phones vs capture cards).
- Different judge audio path (phones vs interface).
- Different setup procedure (router config + NDI source binding vs capture card driver setup).
- Likely different price point and SKU.

### Quality bar

Lite-tier video must look at least as good as a parent's iPhone pointed at the stage — which it will, since the camera *is* a phone. The differentiator is the integrated overlays + schedule + judge tooling, not raw video quality. If overlay rendering looks janky or judge audio is rough, the value prop collapses to "phone with extra steps." Polish bar is high.

### Resilience trade-off (explicit)

Pro has redundancy by accident — multiple cameras, OBS scene backups, separate audio interface. Lite has fewer points of redundancy. If the host laptop dies mid-show, the show stops. If a source phone dies, that camera is lost (failover to a secondary phone source helps). Mitigation paths: explicit secondary-host failover, documented backup phone procedures, or lean into the pricing — "Lite is for events where 'host died, restart in 2 min' is acceptable."

### Real challenges

- **Battery + thermal.** Source phones encoding 1080p30 NDI for 4-6 hours need power-only USB-C cables, active cooling cases, recommended-hardware list. Test in a hot room before declaring solved.
- **Cellular fallback for sources** if venue WiFi fails. NDI is LAN-only; vdo.ninja is the WAN escape hatch but at quality cost.
- **Three codebases to maintain (Pro Electron + Android judge app + iOS judge app).** Even with React Native or Flutter sharing 60-70% of business logic, every UI feature ships to multiple places. Hire-implication.

### Closest precedents

- **Switcher Studio** — iOS multi-cam streaming app. Same compositing challenges, no comp domain.
- **Restream Studio / Streamyard** — browser-based; overlay UX worth aping.
- **mimoLive (Boinx)** — desktop, but the "live show layout with branded overlays" model is the user mental model.

None have comp-specific schedule + judge layer. That's the wedge. CSE Lite is "Switcher Studio for dance comps."

### Effort

With Threads 1 + 1b + 2 + 3 already shipped: Lite tier itself becomes a packaging exercise rather than a build:
- Quickstart docs + recommended hardware list + venue setup guide: ~2 weeks
- Different installer/SKU/pricing: ~1 week
- Pilot at 2-3 small comps side-by-side with Pro: 1-3 months elapsed
- Production launch: contingent on pilot quality

If Threads 1-3 *aren't* shipped first: Lite is the same 3-4 month build that Threads 1-3 collectively are.

---

## Sequencing

Recommended order:

1. **Thread 2 pilot first** — single judge phone capture, side-by-side with interface. Cheap to test, biggest immediate operator quality-of-life win, doesn't touch OBS. Failure mode is contained — bad pilot reverts to interface.
2. **Thread 1 + Thread 1b together** — invisible OBS + centre video preview. The headless engine work and the renderer integration are tightly coupled; ship them as one initiative. ~6-8 weeks.
3. **Thread 3** — phone-as-source via NDI HX Camera. ~3 weeks on top of Thread 1.
4. **Thread 2 production migration** once pilot data supports it.
5. **Thread 4 (Lite tier)** — packaging + pilot + launch. ~3 months elapsed once Threads 1-3 are stable.
6. **Thread 1c** — CSE-owned config panels. 1-3 months. Defer until Thread 1 + 1b have a full season of stable operation.
7. **Thread 1d (libobs embed)** — 6-12 months. Strategic decision; defer indefinitely unless a single-binary mandate emerges.
8. **Thread 1e (custom pipeline)** — never, unless OBS itself becomes the failure mode.

No hard dependencies between Thread 2 (judge audio) and Threads 1/1b/3 (engine + sources). Thread 2 can ship first, in parallel, or after — operator choice.

---

## Key requirement (called out separately because it's load-bearing)

**In-CSE centre video preview is non-negotiable.** Operator's mental model is "this is the show, in CSE." The current iter-9 layout (top band + schedule table + GRAPHICS card + action bar) wraps around a centre live preview window, not next to one. Without the preview, OBS can be invisible but CSE is just a control panel — operators will mentally split their attention between "the CSE window" and "wherever the video actually is" and the integration win evaporates.

This locks Thread 1b in as part of any Thread 1 ship — the headless engine without the preview transport is not a complete deliverable. Layout-side, the schedule table likely compresses below a centre video pane during recording-active state, and design pass should treat "centre video first" as the new layout primitive.
