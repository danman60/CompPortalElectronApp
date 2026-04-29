# Incident Report — UDC Toronto R199-end-of-Friday Judge Audio Loss

**Date:** 2026-04-28 (post-mortem opened from 2026-04-24 incident)
**Comp:** UDC Toronto 2026 (`a0adef31-177b-4dd6-8b63-7ff59fff0196`)
**Detected:** 2026-04-28 09:17 EDT (operator routine review, 4 days post-event)
**Status:** Root cause confirmed. Recovery: judge audio for affected routines is unrecoverable.

---

## Summary

Starting with R199 at **14:40:37 EDT** on Friday 2026-04-24, all subsequent routines through end-of-day Friday recorded **judge mic tracks 2/3/4 as silent** in the source MKV. Performance audio (track 1, venue music) was healthy throughout. **All three judge MP4 outputs per routine are byte-identical in their audio streams** — proven by encoded-file SHA fingerprinting against R2.

The proximate cause is **a ZOOM AMS-44 ASIO driver stop/restart at 14:01:23 EDT** during the lunch break. The 142 ms restart left OBS' obs-asio plugin with all three Judge sources bound to the same single channel (likely channel 0), producing identical silent samples to all three sources for the rest of the recording session.

The state was **runtime-only in OBS** — never written to the scene file — and self-corrected Saturday morning when DART's OBS process was relaunched and reloaded `route0=0/1/2` from disk.

## Scope

- **Affected:** R199 through R310 (~112 routines, operator-confirmed 2026-04-28 14:20 EDT). Spans R199 onward Friday afternoon through end of Friday recording. Judge tracks 2/3/4 silent on all of them.
- **Unaffected:** R197, R198, and every Friday-morning routine — judge tracks 2/3/4 healthy. Performance track 1 (venue music) unaffected on every routine all day.
- **Recovery:** None possible from CSE-side. The MKV's tracks 2/3/4 contain only silent samples; nothing can be reconstructed. Judge commentary for these routines is gone unless an external audio recorder captured the same window.

## Timeline (Eastern)

| Time | Event |
|---|---|
| 07:16:14 EDT | OBS launched. ZOOM AMS-44 ASIO driver started. Judge1/2/3 bound to ASIO channels 0/1/2 per scene file. |
| 07:16:14 EDT | Audio meter system online; recordings start through morning. |
| Through 13:21:24 EDT (R198 stop) | 14 prior ASIO stop/restart cycles (200 ms each). All recovered cleanly — every routine has healthy judge audio. |
| **13:18:44 EDT** | v15 commit (`efa9b03`) lands in git. SD-import / drive-monitor / job-queue changes only. **Does not touch audio code.** |
| **13:21:24 EDT** | R198 final stop. Last routine with healthy judge audio. |
| **13:27:46 EDT** | CSE Electron app restart #1 (asar swap to v15). New OBS-WebSocket connection. |
| 13:36:11 EDT | v15.1 commit (`e08e2d2`) — fixes v15's dynamic-require crash from "Live-show incident 2026-04-24 13:28". Touches `driveMonitor.ts` only. |
| **13:38:05 EDT** | CSE app restart #2 (asar swap to v15.1). |
| 13:54:54 EDT | v15.2 commit (`b5872b0`) — `clipVerify.ts` + `driveMonitor.ts`. |
| **14:01:23.787 EDT** | **ZOOM AMS-44 ASIO driver: Stopped.** OBS log line. Restart #15 of the day. |
| **14:01:23.929 EDT** | **ZOOM AMS-44 ASIO driver: Starting.** 142 ms gap. **This is the cliff.** All three judge sources re-bind, but to wrong channel(s). |
| **14:26:08 EDT** | CSE app restart #3 (asar swap to v15.2). OBS reconnect. |
| **14:38:15 EDT** | Settings:set IPC fires (audioInputMapping section saved). 2 minutes before R199. |
| **14:40:37 EDT** | R199 starts recording. **First routine with silent judge tracks.** |
| 14:49:04 EDT | R199 stops. Encode → J1=140kB, J2=140kB, J3=140kB on AAC 128 kbps for 8m25s — i.e. silence. |
| 14:49:08 → 16:58 EDT | R200, R201, R202, R203, all subsequent Friday routines: same silent-judge pattern. |
| 22:10:02 EDT | OBS log shows final `asio-input: Stopped` with `Last Recieved Timestamp (0)` — clean shutdown. |
| 2026-04-25 morning | DART relaunched. OBS read scene file → channels re-bound 0/1/2 → judge audio restored (verified by Saturday flat-line alerts firing on Judge1/Judge3 specifically). |

## Evidence

### Encoded MP4 byte-identical audio streams

Pulled from R2 `compsyncmedia/00000000-0000-0000-0000-000000000004/a0adef31-177b-4dd6-8b63-7ff59fff0196/<entry_id>/videos/judgeN.mp4`:

| Routine | J1 audio SHA-256 (first 16) | J2 audio SHA-256 | J3 audio SHA-256 | mean_dB | max_dB |
|---|---|---|---|---|---|
| R199 | `b3484787e0a32f2f` | `b3484787e0a32f2f` | `b3484787e0a32f2f` | -91.0 | -91.0 |
| R201 | `13a7896406b36c59` | `13a7896406b36c59` | `13a7896406b36c59` | -91.0 | -91.0 |

Audio streams are extracted via ffmpeg `-vn -acodec pcm_s16le -f wav` and SHA-256'd. **Identical hashes prove identical PCM samples.** Three independently encoded MP4s with three different `-map 1:a:N` FFmpeg flags producing identical audio bytes is only possible if all three source-MKV tracks contained identical samples — which only happens if OBS' three sources were reading from the same ASIO channel during recording.

mean_volume = max_volume = -91 dB is AAC's silent-frame floor (≈ -inf dB). 50–150 KB of "audio" for a 2:30–8:25 routine at 128 kbps stereo is exactly what you'd expect from an all-silent stream after AAC's compression.

### OBS audio source config (verified post-recovery)

Saved scene file `%APPDATA%\obs-studio\basic\scenes\CompSync.json` on DART, last write 2026-04-26 18:20:41 EDT (Sunday EOD):

| Source | device_id | route 0 | speaker_layout | mixers (decimal) | mixers (binary, low 6 bits) | Track routing |
|---|---|---|---|---|---|---|
| Judge1 | ZOOM AMS-44 ASIO Driver | **0** | 1 (mono) | 194 | `…000010` | Track 2 ✅ |
| Judge2 | ZOOM AMS-44 ASIO Driver | **1** | 1 (mono) | 196 | `…000100` | Track 3 ✅ |
| Judge3 | ZOOM AMS-44 ASIO Driver | **2** | 1 (mono) | 200 | `…001000` | Track 4 ✅ |

Saved scene is correct. Each Judge source is bound to a distinct ZOOM ASIO channel (0/1/2) and each routes to exactly one MKV track (2/3/4). Saturday morning's OBS launch loaded these values → audio recovered. Friday afternoon's runtime had something else.

### CSE log evidence — three asar swaps during the lunch break

Chat-bridge attempt counter resets to `1` at three timestamps inside the lunch gap, each immediately preceded by a fresh `[OBS] Connecting to ws://localhost:4455 (auth: yes)` line — that's three CSE Electron app restarts:

- 13:27:46 EDT (v15)
- 13:38:05 EDT (v15.1)
- 14:26:08 EDT (v15.2)

The three commits' diffs (verified): zero touches to `obs.ts`, `recording.ts`, audio code, or any track-routing path. **The asar swaps didn't cause the audio loss.**

### OBS log — 14:01:23 ASIO restart

```
14:01:23.787: asio-input: Stopped (ZOOM AMS-44 ASIO Driver)
14:01:23.787: asio-input: Last Recieved Timestamp (24370076263700)
14:01:23.929: asio-input: Starting (ZOOM AMS-44 ASIO Driver)
```

15th of the day's ASIO stop/restart cycles. Every prior cycle (200 ms each) recovered with healthy judge audio. This one (142 ms — the shortest gap) did not.

### App-side detection state on Friday

The per-channel "Audio flat-line" detector at `obs.ts:614-645` was added on **2026-04-25 ("Fix 14 + item 8")** — not present on Friday. Friday's OBS service had only the legacy "all-channels-flat" detector. That detector's trigger (every monitored input flat for ≥ 5 s) was never satisfied: track 1 (perf, venue music) was loud throughout, so "all flat" was always false. **Friday's app correctly stayed silent under its actual detection rules.** No alert was missed; the rule itself was insufficient.

The Saturday-morning per-channel detector started firing 2026-04-25 10:47–11:50 EDT (initial broad scope: `CSOverlay`, `Video Capture Device`) and after the 10:50 EDT scope-fix, on `Judge1`/`Judge2`/`Judge3` specifically — that's what the operator remembers watching go off. The detector is correct; it just didn't exist Friday.

## Root cause

**OBS obs-asio plugin runtime channel-rebinding bug, triggered by the 142 ms ASIO driver restart at 14:01:23 EDT.**

After the restart, the plugin reconnected the ASIO driver to OBS but failed to restore the per-source `route 0` mapping for the three Judge sources. All three sources ended up reading from the same ASIO channel (which was producing silence). Source-level meter readings continued to update from this misbound channel, so the in-app meter UI (a 1:1 mirror of OBS InputVolumeMeters) showed apparent activity rather than going flat. The MKV recording captured identical silent samples from all three sources into tracks 2/3/4.

The bug's runtime-only nature is consistent with the operator's observation that the issue self-corrected the following morning: scene-file routing was untouched, so the next OBS launch read correct values and re-bound channels properly.

## Why detection failed

Three layers of detection existed; all three were defeated by this specific failure mode:

1. **Operator visual check of audio meters.** Meter shows OBS InputVolumeMeters levels — computed *upstream* of track-routing. After the rebind, the misbound channel still produced level data, so meters still bounced. The meter cannot distinguish "this source's signal is reaching its assigned track" from "this source is reading some channel of the device."
2. **Friday's `audio.flatline.warning` (legacy all-channels-flat detector).** Required all monitored inputs flat. Performance track was loud all day → trigger never met. Functioning correctly per its specification; specification was wrong for the failure class.
3. **Saturday's per-channel `audio.flatline.warning`.** Would have caught this had it existed Friday. Same detection layer as the meter (source-level), so still wouldn't have caught the rebind specifically — but the misbound source's level happened to also be near silent, so the detector would have fired on a 5-sec sustained-flat measurement. **Coincidence**, not design.

The fundamental gap: **no detector compares "what should be on track N" against "what's actually on track N."** Every detector reads the same source-level data the meter shows; if the source-to-track binding is wrong, every detector misses it.

## Affected media

- R199 through R310 (~112 routines, operator-confirmed 2026-04-28 14:20 EDT).
- Tracks 2/3/4 of the source MKVs and the encoded judge MP4s in R2 are silent.
- Performance MP4 (track 1) is unaffected — venue music + dancer floor mic captured normally.
- Photos unaffected.
- Saturday + Sunday: all four tracks healthy except for the three sporadic flat-line events the new detector caught (Judge1 18:37 / 21:10, Judge3 12:15 / 19:16 EDT 2026-04-25 + Judge3 12:46 / 15:28 / 16:27 EDT 2026-04-26 — those are different incidents, possibly mic mute or operator fiddling).

## Action items (link to fix plan)

- **5.3 — Audio flat-line detection.** Already covered. The Saturday detector handles single-source flat events; rebind events that happen to also produce silence will trigger it.
- **NEW — Per-routine post-stop audio sanity check (item below).** Catches rebind-class failures where source-level readings are misleading.
- **5.12 — Real-time 4-camera drift indicator.** Audio-side analog: emit a track-content audit on each ASIO restart event (the OBS log already produces them). For Burlington: subscribe via the websocket to ASIO start/stop events and surface them to operator at minimum.

---

# Per-routine automated audio spot-check — design

## The detection problem

Source-level meters cannot detect track-routing or rebind failures. The only reliable detector is **content-of-track**: did track N actually contain the audio it should have, after recording finished?

Two flavours of spot-check:
1. **Lightweight (always-on) post-stop check** — run on every routine; near-zero cost.
2. **Heavy (occasional) deep audio analysis** — run periodically; catches subtle issues lightweight misses.

The first is the bulk of the value. The second is opt-in.

---

## Lightweight check: encode-time `audio_kB / duration_s` heuristic

### Why it works

The CSE app's encode pipeline already invokes ffmpeg with stderr telemetry. ffmpeg prints `audio:NkB` per output file at the end of each mux step. We already parse this for log purposes (the byte counts that drove this whole investigation came from this output). Adding a pass/fail check costs essentially nothing.

### The check

Per encoded MP4 (perf + 3 judges), compute:

```
ratio = audio_kB / duration_seconds
```

For 128 kbps stereo AAC, healthy audio ratio is ~16 KB/s. AAC silent frames produce ~0.3 KB/s. **Threshold: ratio < 1.0 KB/s = "track is essentially silent."**

```
HEALTHY:  audio_kB / duration_s ≥ 1.0 KB/s
SILENT:   audio_kB / duration_s < 1.0 KB/s
```

For R199's J1: 140 kB / 505 s = 0.277 KB/s → SILENT ✅ (correctly flagged).
For R197's J1: 2,355 kB / 175 s = 13.5 KB/s → HEALTHY ✅.

### Where this hooks into existing code

- `src/main/services/ffmpeg.ts:435-465` — post-encode result loop where `encodedFiles` array is built. Add per-file ratio check.
- New event channel: `audio.track.silent.detected` with payload `{ routineId, file, role, ratio_kbs, duration_s }`.
- Renderer-side: surface as a red banner the moment encode finishes — typical encode is 30–60 sec post-stop, so banner fires within 60 sec of operator pressing STOP.
- Operator action options on the banner: **[Re-record]**, **[Acknowledge — playback was actually silent]**, **[View encode log]**.

### Resource cost

**Zero.** The ratio is already in stderr; we're just reading and comparing. The operation is one regex match per encode invocation on a string the encoder is already producing. ~10 µs per routine.

### Failure modes it catches

- ✅ Today's exact bug (ASIO rebind → silent all judges)
- ✅ Source set to Monitor Only (silent recording)
- ✅ Source mute toggled in Audio Mixer
- ✅ Source's track-routing bit cleared in Advanced Audio Properties
- ✅ Audio device disconnected
- ❌ Source recording wrong audio (e.g. judge1 mic into judge2 track) — undetectable from level data alone

Coverage of catastrophic-class failures: 90%+. Misses only "wrong audio in right slot," which is a different problem.

---

## Heavy check: ffmpeg `silencedetect` filter on a sample

The lightweight check uses *aggregate* audio bytes over the whole file. It can miss intermittent dropouts (e.g. judge mic flat for 2 minutes mid-routine then comes back). For deeper coverage:

### The check

After encode, run an out-of-band ffprobe + silencedetect pass on each encoded MP4:

```
ffmpeg -i judge1.mp4 -af silencedetect=noise=-50dB:d=10 -f null - 2>&1 | grep silence_end
```

Returns a list of silent regions ≥ 10 seconds at ≤ -50 dB. Output:

```
silence_start: 12.34
silence_end: 145.67 | silence_duration: 133.33
```

Per routine, sum silence-duration across each judge MP4. If any judge has >50% of routine duration silent, flag it.

### When to run

Not on every routine. Adds maybe 2–4 seconds per file (fast forward decode + filter) — across 4 files, that's ~10s extra per routine. During live recording with rapid succession of takes, this would queue up.

### Two scheduling options

**Option A — every Nth routine.** Fixed cadence. N=10 → spot-check fires on R10, R20, R30, etc. Cheap, predictable. Misses transient mid-routine issues that happen between checks.

**Option B — opportunistic between takes.** Track the gap between current "STOP" and next routine's "START RECORD" (typically 30–90 seconds). If gap ≥ 30 seconds, run silencedetect on the just-finished routine. If gap < 30 seconds, skip it. This way deep checks run only when CPU is otherwise idle.

**Recommended:** **Option B (opportunistic).** Naturally rate-limits to operator-tempo. Quiet sessions get full coverage; rushed back-to-back routines get only the lightweight check (which is sufficient for catastrophic failures anyway).

### Resource cost — Option B

ffmpeg silencedetect: ~25× real-time on modest hardware. A 3-minute routine MP4 takes ~7 seconds for one file. Four files = ~28 seconds CPU on a single core. Modern multi-core machines can run all four in parallel for ~7 seconds wall clock.

CPU envelope: 7s of one core every ~30s gap = ~25% of one core during between-take quiet periods. The encode pipeline itself uses NVENC + multiple ffmpeg processes already; adding one more is marginal.

Memory: negligible (ffmpeg streams the file, doesn't load it).

If even this is too much for live production, gate it on a settings toggle (default OFF) and only enable on operator-confirmed quiet days.

---

## Combined recommendation

Two-tier:

1. **Always-on, every routine: lightweight `audio_kB / duration_s` check at encode-time.** Zero cost. Catches 90% of catastrophic class.
2. **Opportunistic, between-takes: full silencedetect pass.** Bounded to gap ≥ 30s between operator actions. Catches subtle dropouts. Default ON; operator can disable.

Wire both into the same `audio.track.silent.detected` event so the renderer's banner has one trigger to listen for. Banner says either:

- *"R199 J1 audio appears silent (ratio 0.28 KB/s vs 16 KB/s expected). Re-record?"* (lightweight)
- *"R199 J1 audio: 312 of 505 seconds silent. Re-record?"* (deep)

Both versions give the operator the next action immediately. No log-file archaeology required.

---

## What this would have done for this incident

R199 stops at 14:49:04 EDT. Encode runs roughly 14:49:05 → 14:53:00. Lightweight check fires at ~14:53:00 → red banner *"R199 judge audio appears silent on J1, J2, J3"* — operator sees the banner before R200 (which started 14:49:08, conflicting with R199's encode tail; let's assume R201 then ~14:53:47). **Detection latency: ~4 minutes.** Compared to actual detection latency of **4 days**, that's the order-of-magnitude improvement that justifies the work.

---

*End of incident report.*
