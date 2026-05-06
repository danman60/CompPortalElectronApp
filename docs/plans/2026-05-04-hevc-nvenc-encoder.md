# HEVC NVENC encoder for wifi-display-server

Date: 2026-05-04
Status: COMPILED (cross-compile from Linux to Windows x64 via mingw OK).
Not deployed. Not committed.

## Problem

`wifi-display-server.exe` runs `openh264 = "0.6"` software H.264 encode.
During capture/encode bursts on DART the host CPU is saturated, which
starves the operator-foreground work (Electron, Lumix Tether, Stream Deck).
Operator wants the encode moved off the CPU to NVENC.

## Encoder path picked

**Path B: pipe BGRA frames to bundled `ffmpeg.exe`** (HEVC NVENC).

Reasoning:
- `ffmpeg.exe` is already bundled at
  `resources/ffmpeg/ffmpeg.exe` in CompSync Media — zero new build deps.
- No new Cargo dependency to vendor / cross-compile (so the existing mingw
  cross-compile from Linux keeps working).
- Encoder args are runtime-tweakable without rebuilding the Rust binary
  (preset, bitrate, GOP can move into config later).
- Path A (`ffmpeg-next`) would require pkg-config + libavcodec headers in
  the cross-compile sysroot — unrealistic to set up tonight.
- Path C (direct NVENC SDK) is the lowest overhead but multiple sessions of
  work; not "tonight".

## What changed (server side)

1. `server/src/encoder.rs`
   - Added `EncoderKind` enum (`OpenH264 | HevcNvenc`) with `FromStr`.
   - Added `VideoEncoder` enum that monomorphises both backends — no
     trait objects.
   - Existing `H264Encoder` is unchanged behaviourally; just sits inside
     the enum.
   - Added `NvencHevcEncoder`:
     - Spawns `ffmpeg.exe` once with rawvideo BGRA stdin / hevc stdout.
     - Args: `-c:v hevc_nvenc -preset p4 -tune ull -zerolatency 1
       -rc cbr -b:v <kbps*1000> -g <fps*2>`
     - Background thread drains stdout, splits Annex-B start codes,
       forwards each NAL via `mpsc::Sender<EncodedNal>`.
     - Stderr drained to `tracing::warn!(target = "ffmpeg", ...)`.
     - HEVC NAL type extracted from the first byte
       (`(b >> 1) & 0x3F`); types 19/20/21 (IDR_W_RADL / IDR_N_LP /
       CRA_NUT) and 32/33/34 (VPS/SPS/PPS) flagged as keyframe.
     - `Drop` closes stdin so ffmpeg flushes & exits cleanly.

2. `server/src/config.rs` — added two new flags:
   - `--encoder <openh264|hevc-nvenc>` (default: `openh264`)
   - `--ffmpeg-path <abs path>` (required iff `--encoder hevc-nvenc`)

3. `server/src/main.rs` — swapped `H264Encoder::new` for
   `VideoEncoder::new(kind, ..., ffmpeg_path)`.

## Default behaviour: unchanged

Without any new flags the binary still runs OpenH264 software encode with
identical output. The Electron host (`src/main/services/wifiDisplay.ts`)
does not pass `--encoder`, so production traffic stays on the OpenH264
path until someone explicitly opts in.

## Build / cross-compile status

- Target: `x86_64-pc-windows-gnu` (mingw, already installed).
- `cargo check --target x86_64-pc-windows-gnu` — clean (only pre-existing
  `scrap-local` warnings + 1 `list_displays` dead-code warning).
- `cargo build --release --target x86_64-pc-windows-gnu` — succeeded.
- Output: `target/x86_64-pc-windows-gnu/release/wifi-display-server.exe`
  (5,796,468 bytes — same size class as the prior binary).
- Staged at:
  `/mnt/firmament/CompSync-builds/wifi-display-server.exe.build8c-hevc-experimental`

No MSVC blocker — the mingw toolchain handled it. ffmpeg-next was avoided
specifically to keep this clean.

## How to test on DART

1. Stage the new binary in `userData` next to the running one (operator
   closes the app, swap the .exe, restart). Or scp into resources/ for
   first-run copy.
2. From a temporary launch, force the new path:
   ```
   wifi-display-server.exe ^
     --monitor-index 1 ^
     --bitrate 6000 ^
     --fps 30 ^
     --video-port 5000 ^
     --touch-port 5001 ^
     --client <tablet ip> ^
     --encoder hevc-nvenc ^
     --ffmpeg-path "C:\Program Files\CompSync Media\resources\ffmpeg\ffmpeg.exe"
   ```
3. Watch the log for the line
   `HEVC NVENC encoder: WxH, Nkbps, Mfps (ffmpeg child via ...)`.
4. Expect CPU on the wifi-display-server process to drop sharply; GPU
   encode utilisation on `nvidia-smi` (Encoder column) to climb.
5. **Android side note:** CSController currently decodes H.264. The
   Android decoder needs to be flipped to HEVC for this to actually
   render — this server-side change is half the work. That's the next
   item, intentionally out of scope per the request.

## Fallback

To revert to OpenH264 without redeploying the binary, drop the
`--encoder hevc-nvenc` arg (or pass `--encoder openh264`). The default
is openh264, so simply not adding the flag is the rollback.

If the new binary crashes on DART, the operator can restore the
previous `.bak.20260423` stamped binary.

## What's left to ship

- **Plumb the flag through the Electron host.** `wifiDisplay.ts:start()`
  needs an opt-in setting (e.g. `settings.wifiDisplay.encoder`) and to
  append `--encoder hevc-nvenc --ffmpeg-path <ffmpegPath()>` when set.
  Default off so prod stays on OpenH264.
- **Android decoder swap.** CSController must request `video/hevc` from
  MediaCodec instead of `video/avc`. Likely a single string change in
  the decoder init plus a CSD (VPS/SPS/PPS) pass-through check — but
  separate repo, not touched here per the constraint.
- **End-to-end test on DART.** Encode a known clip on tester tenant
  (no real recordings) and confirm the tablet decodes; capture
  `nvidia-smi --query-gpu=encoder.utilization` for evidence of GPU
  offload.
- **Bitrate/preset tuning.** Current arg set assumes 6 Mbps CBR /
  preset p4. May need bump to p5/p6 if quality drops at high motion,
  or drop to p2/p3 if latency creeps.
