#!/usr/bin/env node
/**
 * Orphan-resume harness — fixture generator (real-merge-path faithful).
 *
 * Crafts a faithful post-restart state in an ISOLATED userData dir so the
 * operator's real state is never touched.
 *
 * FAITHFULNESS DESIGN (verified against source, not assumed):
 *  - The patched resumeRecordedRoutines only runs inside the index.ts boot
 *    block that lives in resolveShareCode("TEST2026").then(...). That resolve
 *    is a public read-only GET (fires every real launch, NOT DART).
 *  - loadFromShareCode("TEST2026") then returns the live DEMO schedule and
 *    setCompetition() runs its REAL production merge (state.ts:494-538):
 *    when persisted.competitionId == fresh.competitionId, it overlays the
 *    persisted status/outputPath/encodedFiles ONTO the fresh routines BY ID.
 *  - So we seed our fixture with the REAL demo competitionId and a handful of
 *    REAL demo routine ids (pulled live at gen time, read-only). On boot the
 *    real merge restores our seeded statuses onto those routines, and
 *    resumeRecordedRoutines acts on them. This exercises MORE of the real
 *    boot path (the production merge) than bypassing it would — fully
 *    faithful, deterministic, no DART, no DB write, no app-code change.
 *
 * The bug condition: NO job-queue.json (encode queue lost on restart) while
 * statuses say queued/encoding.
 *
 * Seeded statuses (9 routines, mapped onto 9 real demo routine ids):
 *   2x recorded   -> MUST resume (unpatched + patched)
 *   3x queued     -> MUST resume only when PATCHED  (orphan today)
 *   2x encoding   -> MUST resume only when PATCHED  (orphan today)
 *   1x encoded    -> MUST NOT get an encode job
 *   1x uploading  -> MUST NOT get an encode job (uploading-reconcile owns it)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const UD = process.env.CSE_UD || '/tmp/cse-orphan-test'
const SHARE_CODE = 'TEST2026'

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }) }

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

// --- Pull the live demo schedule (read-only, public resolve + Bearer) -------
const resolved = await getJson(`https://www.compsync.net/api/plugin/resolve/${SHARE_CODE}`)
const demoSchedule = await getJson(
  `${resolved.apiBase}/api/plugin/schedule/${resolved.competitionId}`,
  { Authorization: `Bearer ${resolved.apiKey}` },
)
const COMPETITION_ID = demoSchedule.competitionId
const TENANT_ID = demoSchedule.tenantId
if (!Array.isArray(demoSchedule.routines) || demoSchedule.routines.length < 9) {
  throw new Error(`demo schedule unusable: ${demoSchedule.routines && demoSchedule.routines.length} routines`)
}

// --- Clean isolated userData -----------------------------------------------
rmrf(UD)
mkdirp(UD)
mkdirp(path.join(UD, 'logs'))
const mediaRoot = path.join(UD, 'media')
mkdirp(mediaRoot)

// 1s real MKV ffmpeg can probe (pickLongestMkv stats real files).
const template = path.join(UD, '_template.mkv')
execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1',
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
  '-t', '1', template,
], { stdio: ['ignore', 'ignore', 'inherit'] })

// statusplan: status, expectResumeUnpatched, expectResumePatched
const plan = [
  { status: 'recorded',  unpatched: true,  patched: true  },
  { status: 'recorded',  unpatched: true,  patched: true  },
  { status: 'queued',    unpatched: false, patched: true  },
  { status: 'queued',    unpatched: false, patched: true  },
  { status: 'queued',    unpatched: false, patched: true  },
  { status: 'encoding',  unpatched: false, patched: true  },
  { status: 'encoding',  unpatched: false, patched: true  },
  { status: 'encoded',   unpatched: false, patched: false },
  { status: 'uploading', unpatched: false, patched: false },
]

// Map the plan onto the first N real demo routine ids. The merge keys on id;
// resumeRecordedRoutines skips routines without outputPath, so the other
// ~1441 demo routines (pending, no outputPath) are inert.
const picked = demoSchedule.routines.slice(0, plan.length)

const persistedRoutines = []
const expectations = []
plan.forEach((p, i) => {
  const base = picked[i]
  const id = base.id
  const entryNumber = base.entryNumber || String(100 + i)
  const rDir = path.join(mediaRoot, String(entryNumber).replace(/[^\w.-]/g, '_'))
  mkdirp(rDir)
  const outputPath = path.join(rDir, `${String(entryNumber).replace(/[^\w.-]/g, '_')}.mkv`)
  fs.copyFileSync(template, outputPath)

  // Persisted routine — only the fields setCompetition() merges by id matter
  // (status, recordingStartedAt/StoppedAt, outputPath, encodedFiles, photos,
  //  uploadProgress, notes). We keep the full shape for realism.
  persistedRoutines.push({
    ...base,
    status: p.status,
    recordingStartedAt: new Date(Date.now() - 600000).toISOString(),
    recordingStoppedAt: new Date(Date.now() - 540000).toISOString(),
    outputPath,
    outputDir: rDir,
    // uploading routine: leave mediaPackageStatus as the demo payload had it;
    // the index.ts uploading-reconcile (runs BEFORE resumeRecordedRoutines)
    // is expected to move it off 'uploading' — that's the asserted behavior
    // ("uploading does NOT get an encode job").
  })
  expectations.push({
    id, entryNumber, seededStatus: p.status,
    expectResumeUnpatched: p.unpatched,
    expectResumePatched: p.patched,
  })
})

// Persisted competition = the demo competition shape but with ONLY our 9
// routines carrying pipeline state. setCompetition merges persisted[byId]
// onto the fresh 1450; unmatched fresh routines stay pending (no outputPath).
const persistedCompetition = {
  tenantId: TENANT_ID,
  competitionId: COMPETITION_ID,
  name: demoSchedule.name,
  routines: persistedRoutines,
  days: demoSchedule.days || ['Day 1'],
  source: demoSchedule.source || 'api',
  loadedAt: new Date().toISOString(),
}

fs.writeFileSync(
  path.join(UD, 'compsync-state.json'),
  JSON.stringify({
    competition: persistedCompetition,
    currentRoutineId: null,
    savedAt: new Date().toISOString(),
  }, null, 2),
)

// Minimal settings seed — app deep-merges all other keys from
// DEFAULT_SETTINGS (incl. behavior.autoEncodeRecordings:true).
fs.writeFileSync(
  path.join(UD, 'compsync-media-settings.json'),
  JSON.stringify({
    compsync: { shareCode: SHARE_CODE },
    behavior: { autoEncodeRecordings: true },
  }, null, 2),
)

// THE BUG CONDITION: no persisted encode queue.
const jqPath = path.join(UD, 'job-queue.json')
if (fs.existsSync(jqPath)) fs.rmSync(jqPath)

fs.writeFileSync(
  path.join(UD, '_expectations.json'),
  JSON.stringify({ competitionId: COMPETITION_ID, routines: expectations }, null, 2),
)

console.log(`Fixture written to ${UD}`)
console.log(`  competitionId (real demo): ${COMPETITION_ID}`)
console.log(`  seeded ${persistedRoutines.length} routines onto real demo ids`)
console.log(`    statuses: 2 recorded, 3 queued, 2 encoding, 1 encoded, 1 uploading`)
console.log(`  job-queue.json present: ${fs.existsSync(jqPath)} (must be false)`)
console.log(`  seeded ids: ${expectations.map(e => e.id.slice(0, 8)).join(', ')}`)
