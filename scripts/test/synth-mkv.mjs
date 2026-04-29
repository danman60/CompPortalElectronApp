#!/usr/bin/env node
/**
 * Build a synthetic .mkv file with a configurable audio profile.
 *
 * Uses the bundled ffmpeg to generate a tiny MKV with:
 *   - 1s of black video (160x90)
 *   - N audio channels per the profile (silent / sine / mixed)
 *
 * Profiles:
 *   --profile silent      → all audio channels are pure silence (low-bitrate VBR)
 *   --profile broken      → audio stream effectively empty (1KB total) — Tier-1 trigger
 *   --profile normal      → 4 channels with 440Hz sine tones at -20dBFS
 *   --profile clipped     → 4 channels with full-scale square wave (loudness ceiling)
 *
 * Usage:
 *   node scripts/test/synth-mkv.mjs --out /tmp/synth.mkv --profile broken --duration 30
 *
 * Stdlib + ffmpeg only.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function parseArgs() {
  const args = { out: null, profile: 'normal', duration: 10, ffmpeg: null }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, '')
    const v = a[i + 1]
    if (k === 'duration') args[k] = parseInt(v, 10)
    else args[k] = v
  }
  if (!args.out) throw new Error('--out required')
  if (!args.ffmpeg) {
    // Try common Windows locations + system PATH
    const candidates = [
      'ffmpeg',
      'C:\\Users\\User\\AppData\\Roaming\\compsync-media\\ffmpeg.exe',
      path.join(os.homedir(), 'AppData', 'Roaming', 'compsync-media', 'ffmpeg.exe'),
      '/usr/bin/ffmpeg',
    ]
    args.ffmpeg = candidates[0]
  }
  return args
}

function buildArgs(profile, duration, out) {
  const baseVideo = ['-f', 'lavfi', '-i', `color=c=black:s=160x90:d=${duration}`]
  switch (profile) {
    case 'silent':
      // 4-channel silence — low-bitrate VBR audio. Tier-2 silencedetect trigger.
      return [
        ...baseVideo,
        '-f', 'lavfi', '-i', `anullsrc=channel_layout=4.0:sample_rate=48000:duration=${duration}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-c:a', 'aac', '-b:a', '8k', // intentionally low — silence still encodes ~96kbps but force tiny
        '-shortest', '-y', out,
      ]
    case 'broken':
      // Audio effectively zero kbps. Force VBR with very low quality on silence.
      return [
        ...baseVideo,
        '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000:duration=${duration}`,
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '4k', '-ar', '8000',
        '-shortest', '-y', out,
      ]
    case 'normal':
      // Healthy 4-channel sine tones at -20dBFS
      return [
        ...baseVideo,
        '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`,
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-y', out,
      ]
    case 'clipped':
      // Full-scale square wave — loudness ceiling
      return [
        ...baseVideo,
        '-f', 'lavfi', '-i', `aevalsrc=if(lt(mod(t*440,1\\,0.5),sgn(t)\\,-sgn(t)):sample_rate=48000:duration=${duration}`,
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '256k',
        '-shortest', '-y', out,
      ]
    default:
      throw new Error(`Unknown profile: ${profile}`)
  }
}

async function main() {
  const args = parseArgs()
  await fs.mkdir(path.dirname(args.out), { recursive: true })
  const ff = args.ffmpeg
  const ffArgs = buildArgs(args.profile, args.duration, args.out)
  console.log(`Running: ${ff} ${ffArgs.join(' ')}`)
  try {
    execFileSync(ff, ffArgs, { stdio: ['ignore', 'inherit', 'inherit'] })
  } catch (err) {
    console.error(`ffmpeg failed:`, err.message)
    process.exit(1)
  }
  const stat = await fs.stat(args.out)
  console.log(`Wrote ${args.out} (${stat.size} bytes, profile=${args.profile}, duration=${args.duration}s)`)
}

main().catch((err) => {
  console.error('synth-mkv failed:', err)
  process.exit(1)
})
