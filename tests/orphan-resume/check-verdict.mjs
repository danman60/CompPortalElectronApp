#!/usr/bin/env node
/**
 * Orphan-resume harness — verdict reader (PRIMARY SOURCE ONLY).
 *
 * After the packaged app booted against the isolated fixture, read the
 * authoritative on-disk state the app itself wrote:
 *
 *   <UD>/job-queue.json        encode jobs the app actually created
 *   <UD>/compsync-state.json   post-boot routine statuses (updateRoutineStatus
 *                              persists; resumeRecordedRoutines parks at 'queued')
 *   <UD>/logs/main.log         the "Resume recorded: queued N ..." log line
 *
 * No cache, no manifest, no intermediate trust. Argv:
 *   node check-verdict.mjs <mode: unpatched|patched> <UD>
 * Exit 0 = expectations met for that mode, 1 = mismatch (proof failure).
 */
import fs from 'node:fs'
import path from 'node:path'

const mode = process.argv[2]   // 'unpatched' | 'patched'
const UD = process.argv[3] || '/tmp/cse-orphan-test'
if (mode !== 'unpatched' && mode !== 'patched') {
  console.error('usage: check-verdict.mjs <unpatched|patched> <userDataDir>')
  process.exit(2)
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

const expect = readJson(path.join(UD, '_expectations.json'))
if (!expect) { console.error('FATAL: _expectations.json missing — fixture not generated'); process.exit(2) }

// PRIMARY SOURCE 1: the encode job queue the app wrote.
const jq = readJson(path.join(UD, 'job-queue.json')) || []
const encodeJobRoutineIds = new Set(
  (Array.isArray(jq) ? jq : [])
    .filter((j) => j && j.type === 'encode')
    .map((j) => j.routineId),
)
// Detect double-enqueue: same routine appearing in >1 encode job record.
const encodeJobCounts = {}
for (const j of (Array.isArray(jq) ? jq : [])) {
  if (j && j.type === 'encode') encodeJobCounts[j.routineId] = (encodeJobCounts[j.routineId] || 0) + 1
}

// PRIMARY SOURCE 2: post-boot routine statuses.
const st = readJson(path.join(UD, 'compsync-state.json'))
const statusById = {}
if (st && st.competition && Array.isArray(st.competition.routines)) {
  for (const r of st.competition.routines) statusById[r.id] = r.status
}

// PRIMARY SOURCE 3: the resume log line.
let logText = ''
try { logText = fs.readFileSync(path.join(UD, 'logs', 'main.log'), 'utf-8') } catch {}
const resumeMatch = logText.match(/Resume recorded: queued (\d+) recorded routine\(s\) for encoding/)
const resumeLoggedN = resumeMatch ? Number(resumeMatch[1]) : 0

const key = mode === 'patched' ? 'expectResumePatched' : 'expectResumeUnpatched'
const rows = []
let pass = true
let resumedCount = 0
let doubleEnqueued = []

for (const e of expect.routines) {
  const hasJob = encodeJobRoutineIds.has(e.id)
  if (hasJob) resumedCount++
  if ((encodeJobCounts[e.id] || 0) > 1) doubleEnqueued.push(e.entryNumber)
  const want = e[key]
  const ok = hasJob === want
  if (!ok) pass = false
  rows.push({
    entry: e.entryNumber,
    seededStatus: e.seededStatus,
    wantResume: want,
    gotEncodeJob: hasJob,
    postBootStatus: statusById[e.id] ?? '(absent)',
    verdict: ok ? 'OK' : 'MISMATCH',
  })
}

if (doubleEnqueued.length > 0) pass = false

// Log line cross-check: in patched mode resumeLoggedN must equal resumedCount;
// in unpatched mode it must equal the count of 'recorded' that resumed.
const expectedLoggedN = expect.routines.filter((e) => e[key]).length
const logOk = resumeLoggedN === expectedLoggedN
if (!logOk) pass = false

console.log(`\n=== ORPHAN-RESUME VERDICT (mode=${mode}) ===`)
console.log(`userData: ${UD}`)
console.log(`primary src 1 (job-queue.json) encode jobs: ${encodeJobRoutineIds.size}`)
console.log(`primary src 3 (main.log) "Resume recorded: queued N": N=${resumeLoggedN} (expected ${expectedLoggedN}) ${logOk ? 'OK' : 'MISMATCH'}`)
console.log(`double-enqueued routines: ${doubleEnqueued.length ? doubleEnqueued.join(',') : 'none'}`)
console.log('')
const w = (s, n) => String(s).padEnd(n)
console.log(w('entry', 6) + w('seeded', 11) + w('wantResume', 12) + w('gotEncodeJob', 14) + w('postBootStatus', 16) + 'verdict')
for (const r of rows) {
  console.log(
    w(r.entry, 6) + w(r.seededStatus, 11) + w(r.wantResume, 12) +
    w(r.gotEncodeJob, 14) + w(r.postBootStatus, 16) + r.verdict,
  )
}
console.log('')
console.log(`resumed (got encode job): ${resumedCount} / ${expect.routines.length}`)
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'} for mode=${mode}`)
process.exit(pass ? 0 : 1)
