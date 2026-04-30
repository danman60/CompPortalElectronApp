#!/usr/bin/env node
/**
 * Generate synth SD card folder locally + SCP to DART under a known
 * deterministic path. Used as a precondition for harness scenarios that
 * exercise the real importPhotos hot path.
 *
 * Usage:
 *   node scripts/test/setup-synth-on-dart.mjs [--bodyKey P16] [--count 10]
 */
import { execSync } from 'node:child_process'
import path from 'node:path'

const args = { bodyKey: 'P16', count: 10 }
for (let i = 0; i < process.argv.length - 2; i += 2) {
  const k = process.argv[i + 2].replace(/^--/, '')
  args[k] = k === 'count' ? parseInt(process.argv[i + 3], 10) : process.argv[i + 3]
}

const LOCAL_OUT = '/tmp/synth-sd-harness'
const REMOTE_OUT = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-sd-harness'

// Generate using DART local time (Eastern). Today at 14:00 Eastern.
const tzDate = execSync(`TZ='America/New_York' date -d 'today 14:00' +'%Y-%m-%dT%H:%M:00'`, { encoding: 'utf-8' }).trim()
console.log(`[setup-synth] Generating ${args.count} JPEGs at base=${tzDate} body=${args.bodyKey}`)

execSync(`rm -rf ${LOCAL_OUT}`)
execSync(
  `node scripts/test/synth-sd-card.mjs --out ${LOCAL_OUT} --count ${args.count} --bodyKey ${args.bodyKey} --baseDate ${tzDate} --intervalSec 30`,
  { stdio: 'inherit' },
)

// Find the DCIM subfolder name (depends on body pattern)
const dcimSubdirs = execSync(`ls ${LOCAL_OUT}/DCIM`, { encoding: 'utf-8' }).trim().split('\n')
const dcimFolder = dcimSubdirs[0]
const localSrc = `${LOCAL_OUT}/DCIM/${dcimFolder}`
const remoteDst = `${REMOTE_OUT}\\DCIM\\${dcimFolder}`

console.log(`[setup-synth] Removing prior + creating ${remoteDst} on DART`)
execSync(
  `ssh dart "powershell -NoProfile -Command \\"Remove-Item '${REMOTE_OUT}' -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path '${remoteDst}' -Force | Out-Null\\""`,
  { stdio: 'inherit' },
)

console.log(`[setup-synth] SCPing ${args.count} JPEGs to DART`)
execSync(`scp -q ${localSrc}/*.JPG dart:/Users/User/AppData/Local/Temp/synth-sd-harness/DCIM/${dcimFolder}/`, { stdio: 'inherit' })

console.log(`[setup-synth] OK — synth SD ready at ${REMOTE_OUT}`)
console.log(`[setup-synth] Scenarios can POST { folderPath: "${REMOTE_OUT}" } to /debug/test/import-photos`)

// Phase 2.1 scenarios — also stage yesterday + multi-day folders (B3 + B4).
const yesterdayDate = execSync(`TZ='America/New_York' date -d 'yesterday 14:00' +'%Y-%m-%dT%H:%M:00'`, { encoding: 'utf-8' }).trim()
const Y_LOCAL = '/tmp/synth-sd-yesterday'
const Y_REMOTE = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-sd-yesterday'
console.log(`\n[setup-synth] Yesterday folder for B4 wrong-day scenario`)
execSync(`rm -rf ${Y_LOCAL}`)
// Use a different bodyKey so watermarks don't conflict with synth-sd-harness
execSync(
  `node scripts/test/synth-sd-card.mjs --out ${Y_LOCAL} --count 5 --bodyKey P10 --baseDate ${yesterdayDate} --intervalSec 30`,
  { stdio: 'inherit' },
)
const yDcim = execSync(`ls ${Y_LOCAL}/DCIM`, { encoding: 'utf-8' }).trim().split('\n')[0]
execSync(
  `ssh dart "powershell -NoProfile -Command \\"Remove-Item '${Y_REMOTE}' -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path '${Y_REMOTE}\\DCIM\\${yDcim}' -Force | Out-Null\\""`,
  { stdio: 'inherit' },
)
execSync(`scp -q ${Y_LOCAL}/DCIM/${yDcim}/*.JPG dart:/Users/User/AppData/Local/Temp/synth-sd-yesterday/DCIM/${yDcim}/`, { stdio: 'inherit' })

// Multi-day folder = today + yesterday combined (B3)
const M_LOCAL = '/tmp/synth-sd-multiday'
const M_REMOTE = 'C:\\Users\\User\\AppData\\Local\\Temp\\synth-sd-multiday'
console.log(`\n[setup-synth] Multi-day folder for B3 multi-day scenario`)
execSync(`rm -rf ${M_LOCAL}`)
execSync(`mkdir -p ${M_LOCAL}/DCIM/${dcimFolder} ${M_LOCAL}/DCIM/${yDcim}`)
execSync(`cp ${LOCAL_OUT}/DCIM/${dcimFolder}/*.JPG ${M_LOCAL}/DCIM/${dcimFolder}/`)
execSync(`cp ${Y_LOCAL}/DCIM/${yDcim}/*.JPG ${M_LOCAL}/DCIM/${yDcim}/`)
execSync(
  `ssh dart "powershell -NoProfile -Command \\"Remove-Item '${M_REMOTE}' -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path '${M_REMOTE}\\DCIM\\${dcimFolder}' -Force | Out-Null; New-Item -ItemType Directory -Path '${M_REMOTE}\\DCIM\\${yDcim}' -Force | Out-Null\\""`,
  { stdio: 'inherit' },
)
execSync(`scp -q ${M_LOCAL}/DCIM/${dcimFolder}/*.JPG dart:/Users/User/AppData/Local/Temp/synth-sd-multiday/DCIM/${dcimFolder}/`, { stdio: 'inherit' })
execSync(`scp -q ${M_LOCAL}/DCIM/${yDcim}/*.JPG dart:/Users/User/AppData/Local/Temp/synth-sd-multiday/DCIM/${yDcim}/`, { stdio: 'inherit' })

console.log(`\n[setup-synth] All synth assets staged on DART:`)
console.log(`  ${REMOTE_OUT} (today, ${args.count} photos, body=${args.bodyKey})`)
console.log(`  ${Y_REMOTE} (yesterday, 5 photos, body=P10)`)
console.log(`  ${M_REMOTE} (today + yesterday combined)`)
