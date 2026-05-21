#!/usr/bin/env node
/**
 * Photo-tier verdict reader — PRIMARY SOURCE ONLY.
 *
 * Reads the JSON the harness wrote from the REAL getNext('upload') dispatch
 * sequence + REAL job payloads (results/run-<mode>.json). No re-derivation of
 * the logic — only assertions over the recorded real dispatch.
 *
 *   node check-verdict.mjs <unpatched|patched> <results.json>
 * Exit 0 = mode expectation met, 1 = mismatch (proof failure).
 */
import fs from 'node:fs'

const mode = process.argv[2]
const file = process.argv[3]
if ((mode !== 'unpatched' && mode !== 'patched') || !file) {
  console.error('usage: check-verdict.mjs <unpatched|patched> <results.json>')
  process.exit(2)
}
let r
try { r = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch (e) {
  console.error(`FATAL: cannot read ${file}: ${e.message}`); process.exit(2)
}
const a = r.assertions || {}
const checks = []
function check(name, pass, detail) { checks.push({ name, pass: !!pass, detail }); return !!pass }

console.log(`\n=== PHOTO-TIER VERDICT (mode=${mode}) ===`)
console.log(`source: ${file}`)
console.log(`build exports: hasOutstandingVideoWork=${r.build?.hasOutstandingVideoWorkExport} hasPendingRemainingPhotos=${r.build?.hasPendingRemainingPhotosExport}`)
console.log(`photoJobCount=${r.enqueued?.photoJobCount}  tierByRoutine=${JSON.stringify(r.enqueued?.tierByRoutine)}`)
console.log(`totalPhotosDispatched=${a.totalPhotosDispatched}  photosDispatchedWhileEncodePending=${a.photosDispatchedWhileEncodePending}  starvedFraction=${a.photosStarvedFraction}`)
console.log(`remainingBeforeVideoCleared=${a.remainingPhotosDispatchedBeforeVideoCleared}  remainingAfterVideoCleared=${a.remainingPhotosDispatchedAfterVideoCleared}`)
console.log(`priorityBeforeVideoCleared=${a.priorityPhotosDispatchedBeforeVideoCleared}  videosBeforeVideoCleared=${a.videosDispatchedBeforeVideoCleared}`)
console.log(`nullReturns=${a.nullReturns}  consecutiveBusySpinNulls=${a.consecutiveBusySpinNulls}  clearedVideoWork=${a.clearedVideoWork}`)
console.log(`legacyMissingTierJob=${JSON.stringify(a.legacyMissingTierJob)}`)

let pass = true
if (mode === 'unpatched') {
  // RUN A must REPRODUCE the starvation: with NO tier gate, photos are handed
  // out while encode/video work is still pending. The unpatched build has no
  // tier exports and never withholds.
  pass &= check('unpatched build (no tier exports)',
    r.build?.hasOutstandingVideoWorkExport === false &&
    r.build?.hasPendingRemainingPhotosExport === false,
    `exports=${JSON.stringify(r.build)}`)
  pass &= check('STARVATION REPRODUCED: photos dispatched while encode work pending > 0',
    a.photosDispatchedWhileEncodePending > 0,
    `photosDispatchedWhileEncodePending=${a.photosDispatchedWhileEncodePending}`)
  // Stronger: a LARGE share starved (unpatched has zero protection — most
  // photos go out before the 2 encode jobs ever could). Threshold 0.5 is
  // conservative; observed ~1.0.
  pass &= check('STARVATION SEVERE: >50% of photos dispatched while encode pending',
    a.photosStarvedFraction > 0.5,
    `starvedFraction=${a.photosStarvedFraction}`)
  pass &= check('no withhold occurred (clearedVideoWork=false — gate absent)',
    a.clearedVideoWork === false,
    `clearedVideoWork=${a.clearedVideoWork}`)
} else {
  // RUN B must PROVE the fix.
  pass &= check('patched build (tier exports present)',
    r.build?.hasOutstandingVideoWorkExport === true &&
    r.build?.hasPendingRemainingPhotosExport === true,
    `exports=${JSON.stringify(r.build)}`)
  // Tagging: each of 3 routines => 3 priority + 6 remaining, 0 missing.
  const tb = r.enqueued?.tierByRoutine || {}
  const tagOk = Object.keys(tb).length === 3 &&
    Object.values(tb).every((v) => v.priority === 3 && v.remaining === 6 && v.missing === 0)
  pass &= check('TAGGING: every routine 3 priority + 6 remaining (ceil(9/3)=3), 0 missing',
    tagOk, JSON.stringify(tb))
  // NO remaining photo EVER dispatched while video work outstanding.
  pass &= check('GATE: zero remaining-tier photos dispatched before video work cleared',
    a.remainingPhotosDispatchedBeforeVideoCleared === 0,
    `remainingBeforeVideoCleared=${a.remainingPhotosDispatchedBeforeVideoCleared}`)
  // NO non-priority photo dispatched while encode work pending. Priority +
  // the missing-tier legacy job MAY go out then; remaining MUST NOT.
  pass &= check('GATE: no remaining photo dispatched while encode work pending',
    a.remainingPhotosDispatchedBeforeVideoCleared === 0,
    `remainingBeforeVideoCleared=${a.remainingPhotosDispatchedBeforeVideoCleared}`)
  // NO DEADLOCK: all 18 remaining (6*3) DID drain after video cleared.
  pass &= check('NO DEADLOCK: all 18 remaining photos drained after video work cleared',
    a.remainingPhotosDispatchedAfterVideoCleared === 18,
    `remainingAfterVideoCleared=${a.remainingPhotosDispatchedAfterVideoCleared}`)
  // Priority slice + legacy DID go out while video work outstanding (proves
  // priority beats everything except videos, and isn't itself starved).
  pass &= check('PRIORITY: priority photos dispatched while video work outstanding (>=9)',
    a.priorityPhotosDispatchedBeforeVideoCleared >= 9,
    `priorityBeforeVideoCleared=${a.priorityPhotosDispatchedBeforeVideoCleared}`)
  // NO BUSY-SPIN: at most a handful of total nulls, and never two
  // consecutive nulls with no progress (a tight spin would explode this).
  pass &= check('NO BUSY-SPIN: zero consecutive no-progress null returns',
    a.consecutiveBusySpinNulls === 0,
    `consecutiveBusySpinNulls=${a.consecutiveBusySpinNulls}`)
  pass &= check('NO BUSY-SPIN: total null returns bounded (<=3)',
    a.nullReturns <= 3, `nullReturns=${a.nullReturns}`)
  // MISSING-photoTier legacy job treated as PRIORITY (dispatched before
  // video cleared, never stranded to the remaining phase).
  const lj = a.legacyMissingTierJob || {}
  pass &= check('MISSING-tier job treated as priority (dispatched before video cleared)',
    lj.dispatched === true && lj.reportedTier === '(missing)' && lj.beforeVideoCleared === true,
    JSON.stringify(lj))
}

pass = !!pass
console.log('')
for (const c of checks) {
  console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}${c.pass ? '' : `  -- ${c.detail}`}`)
}
console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'} for mode=${mode}`)
process.exit(pass ? 0 : 1)
