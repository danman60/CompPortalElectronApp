# GPU Full-Decode Handoff — for Codex

Written 2026-05-16 ~20:55 EDT. UDC Cobourg 2026 is LIVE on DART. This is a faithful, no-spin handoff. Sources: live DART `machine_logs` (Supabase), today's transcripts, the FIRMAMENT test from earlier today.

## The goal (what the operator wants)

The CompSync Electron app on DART transcodes each recorded OBS `.mkv` routine into `.mp4` (a 1080p performance video + a 480p judge video). The operator wants the **full pipeline on the GPU: GPU decode AND GPU encode (h264_nvenc)** — so encoding is fast and does not peg the CPU during a live show (the same box also runs OBS live-recording and photo uploads).

**Current live state (verified from DART machine_logs this session, 20:43 EDT):**
- Encode IS on the GPU: `-c:v h264_nvenc`, confirmed in the live command. Zero NVENC failures over the last 5h. Not crashing.
- Decode is NOT full GPU. Live command is `-hwaccel cuda` only (no `-hwaccel_output_format cuda`). With that, decode is NVDEC-with-readback at best, and the logs do not even prove NVDEC engaged (no decoder-init line, no fallback line). Stream map reads `h264 (native) -> h264 (h264_nvenc)`.
- Sustained throughput ≈ 3.5–5 min/routine (NOT the "~2 min" claimed in older notes — that was one spot-check). Two nvenc passes per routine.

So: **encode = GPU (done). Full GPU decode = NOT achieved. Decode is the missing half.**

## The environment (critical — this is what caused the original failure)

- DART ffmpeg: **gyan 5.0.1-essentials win64 build**, at `C:\Users\User\AppData\Roaming\compsync-media\ffmpeg.exe`. Built with `--enable-nvdec --enable-cuvid --enable-ffnvcodec` (NVDEC/cuvid hw decode IS compiled in).
- DART is a Windows box running a LIVE competition. NEVER test on DART. NEVER kill/relaunch its app — operator owns close+relaunch.
- Local dev machine ffmpeg is **6.1.1 on Linux** — DIFFERENT from DART. **Local is NOT a valid test for a DART ffmpeg change. Testing locally and claiming it works is the exact mistake that broke the live show today.**
- The only faithful test environment is **FIRMAMENT**: Windows 10 + RTX 4090, where the *exact* gyan 5.0.1-essentials binary can be pulled and run against a real OBS `.mkv` (real source mkvs are on the FIRMAMENT share, e.g. `D:\Shared\...` / cryostorage Competition folders). FIRMAMENT matches OS + exact ffmpeg + real NVENC/NVDEC. Only unmatched axis: precise GPU/driver + OBS concurrency. No DART contact, no live risk.

## Code location

- `src/main/services/ffmpeg.ts` — the `hwDecodeArgs` / `judgeOnGpu` region builds the encode command. This is where decode flags are set. Two encode passes: step 1 (1080p performance, `-c:v h264_nvenc`), step 1b (480p judge, `-vf scale=854:480 -c:v h264_nvenc`).
- Branch `feat/ui-redesign-pass1`, all work uncommitted. GitNexus MCP is DOWN — use `git diff` / source reads for impact.
- Build: `npx electron-vite build` then `npx electron-builder --win --dir` (NOT `npm run dist` — needs dotnet, absent). Output: `release/win-unpacked/resources/app.asar`.

## What is KNOWN-DEAD (proven, do not retry)

`-hwaccel cuda -hwaccel_output_format cuda` (the zero-copy full-GPU form, with `-vf scale_cuda`):
- → **EXIT 1**. Errors: `Failed to inject frame into filter network: Function not implemented`, `No decoder surfaces left`, `Conversion failed!`
- Proven on DART (live, routine R328, 10:51:53 EDT) AND reproduced on FIRMAMENT on the EXACT gyan 5.0.1 binary (test "V1" = EXIT 1). It is the ffmpeg binary/version, not DART-specific. `-hwaccel_output_format cuda` forces decoded frames to stay as CUDA surfaces handed straight to nvenc with no download; gyan 5.0.1 win64 cannot do this. Do not propose this flag again.

## What WORKS (currently live)

`-hwaccel cuda` only (no `_output_format`): FIRMAMENT test "V2" = EXIT 0, valid 9.3 MB output, h264_nvenc, 1080p. Live on DART since ~16:48 EDT, confirmed working ~18:36 (R355, h264_nvenc both passes, zero libx264). This fixed the *regression* (encode back on GPU) but is NOT full GPU decode.

## The key UNKNOWN (this is the lead for Codex)

The FIRMAMENT test ran a 4-form matrix (transcript 2026-05-16, ~15:26 EDT, line ~1817): **V1** = strict zero-copy (exit 1, confirmed), **V2** = `-hwaccel cuda` only (exit 0, confirmed), **V3 = cuvid**, **V4 = CPU-decode baseline**. The transcript result table (lines ~1831–1832) **only reports V1 and V2. The V3 (cuvid) and V4 results were never captured or reported.**

`h264_cuvid` (explicit CUVID/NVDEC decoder: `-hwaccel cuda -c:v h264_cuvid -i ...`, possibly with cuvid `-resize` for the 480p pass) is the standard way to get true GPU decode WITHOUT the `-hwaccel_output_format cuda` flag that is known-dead. ffmpeg on DART has cuvid compiled in. **Whether cuvid passes on gyan 5.0.1 is the unanswered question that decides everything.**

**Codex's first action:** find the FIRMAMENT test script + its full output from earlier today (it was written to and executed on the FIRMAMENT share — look there and in `/tmp`, `/mnt/firmament`, repo `docs/`). Get the actual V3 (cuvid) exit code and output. If it exists and passed → that is the proven full-GPU-decode path; build it into ffmpeg.ts, FIRMAMENT-re-verify, then operator-gated swap. If V3 wasn't actually run or its result is lost → re-run the FIRMAMENT test (exact gyan 5.0.1, real OBS mkv) for the cuvid form before touching anything.

## Failed attempts today (honest, including this session)

1. **Local-test-then-claimed-understood-then-broke-DART.** The zero-copy form was tested only on local ffmpeg 6.1.1, asserted as understood/good, swapped to DART (gyan 5.0.1) → EXIT 1 on first routine → libx264 CPU fallback every routine (~4.7 min/routine, CPU 100%). **This impacted the live show.** Root cause: local ≠ DART; local was never a valid test.
2. **Cause asserted before isolation.** "Version mismatch" implied as settled before OS/GPU/driver/OBS axes were isolated. Corrected later.
3. **Partial fix shipped (the current live state).** Dropped `-hwaccel_output_format cuda`, kept `-hwaccel cuda`. Properly FIRMAMENT-validated this time (V1 exit 1 reproduced, V2 exit 0). Live + working. BUT it only restored GPU *encode*; decode is still not full-GPU. Relative to the operator's actual goal it is incomplete.
4. **This session (Claude): near-repeat of mistake #1 + measurement sloppiness.** Proposed cuvid as a path citing partial/FIRMAMENT evidence without first confirming the V3 cuvid result actually exists. Also asserted "CPU decode" definitively from a stream-map line, then had to walk it back to "ambiguous." Caught before any DART action, but it is the same class of error and is why this is being handed off.

## Hard rules for whoever executes this

- NEVER test ffmpeg changes locally and present them as validated. Local ffmpeg (6.1.1) is not evidence for DART (gyan 5.0.1).
- ONLY FIRMAMENT (Windows + RTX 4090 + the exact gyan 5.0.1 binary + a real OBS mkv) counts as validation.
- NEVER touch DART (no test, no swap, no app kill/relaunch) without explicit operator go. Each asar swap is its own gated action; operator owns app close+relaunch.
- Report exit codes and exact error strings verbatim. No paraphrasing flags. No claiming a result you did not observe.
- Do not re-propose `-hwaccel cuda -hwaccel_output_format cuda` — it is proven dead on this binary.

## Definition of done

A FIRMAMENT-proven (exact gyan 5.0.1, real OBS mkv, EXIT 0, valid playable output, decode confirmed on GPU) ffmpeg command that does GPU decode + GPU encode for both the 1080p performance and 480p judge passes, built into `ffmpeg.ts`, packaged to an asar, ready for an operator-gated swap. If no such command exists on gyan 5.0.1, the honest conclusion + the alternative (replace DART's ffmpeg binary with a version that supports it, then FIRMAMENT-test that binary) stated plainly — not a flag guess.
