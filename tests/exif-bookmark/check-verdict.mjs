#!/usr/bin/env node
/**
 * exif-bookmark verdict reader — PRIMARY SOURCE ONLY.
 *
 * Judges from the harness JSON, which is built from instrumented REAL
 * fs.promises.open (= "EXIF-read?") + fs.promises.copyFile (= "imported?")
 * calls of the REAL photos.ts import, plus the import's own emitted events.
 * No re-derivation of the dedup logic — only assertions over the recorded
 * real behavior.
 *
 *   node check-verdict.mjs <unpatched|patched> <results.json>
 * Exit 0 = mode expectation met, 1 = mismatch (proof / safety failure).
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
const ps = r.perSubfolder || {}
const checks = []
function check(name, passCond, detail) {
  const pass = !!passCond
  checks.push({ name, pass, detail })
  return pass
}

console.log(`\n=== EXIF-BOOKMARK VERDICT (mode=${mode}) ===`)
console.log(`source: ${file}`)
console.log(`tzSkewRun=${a.tzSkewRun}  band=${r.fixture?.band}`)
console.log(`[GATING] newPhotosDroppedTotal=${a.newPhotosDroppedTotal}  names=${JSON.stringify(a.newPhotosDroppedNames)}`)
for (const [sub, s] of Object.entries(ps)) {
  console.log(
    `  ${sub}: files=${s.fileCount} new=${s.newCount} newImported=${s.newImported} ` +
    `newDropped=${JSON.stringify(s.newDropped)} oldBelowBmOutsideBand=${s.oldBelowBookmarkOutsideBand} ` +
    `oldBelowBmOpened=${s.oldBelowBookmarkOpened} rollover=${s.rollover} unknownCard=${s.unknownCard} ` +
    `backfill=${JSON.stringify(s.backfillRows)}`,
  )
}
console.log(`exifSummary=${JSON.stringify(a.exifSummary)}`)

let pass = true

// ── INVARIANT (BOTH modes, NON-NEGOTIABLE): zero genuinely-new photos may
//    fail to import. This is the data-loss guard. If >0 the change is WRONG.
pass = check(
  'GATING: zero genuinely-new photos dropped (data-loss guard)',
  a.newPhotosDroppedTotal === 0,
  `dropped=${a.newPhotosDroppedTotal} ${JSON.stringify(a.newPhotosDroppedNames)}`,
) && pass

// Backfilled in-band file (old name, new content) MUST be opened AND imported.
pass = check(
  'data-loss guard: backfilled in-band file opened',
  a.backfillAllOpened === true,
  JSON.stringify(a.backfillFiles),
) && pass
pass = check(
  'data-loss guard: backfilled in-band file imported (NOT lost)',
  a.backfillAllImported === true,
  JSON.stringify(a.backfillFiles),
) && pass

// Rollover subfolder: full read, nothing lost.
pass = check(
  'rollover (140EOSR6) full-read, every new file imported',
  a.rollover_allNewImported === true,
  `s140 newDropped=${JSON.stringify(ps['140EOSR6']?.newDropped)}`,
) && pass

// Unknown card: behaves exactly as no-pre-skip in BOTH modes, nothing lost.
pass = check(
  'unknown card (150EOSR6) all new imported',
  a.unknown_allNewImported === true,
  `s150 newDropped=${JSON.stringify(ps['150EOSR6']?.newDropped)}`,
) && pass
pass = check(
  'unknown card every file opened (no pre-skip on no-serial card)',
  a.unknown_allOpened === true,
  `s150 rows opened`,
) && pass
pass = check(
  'unknown card emitted NO filename pre-skip',
  a.unknown_noPreskipEvent === true,
  `fnPreskip=${JSON.stringify(r.cards?.unknown?.fnPreskip)}`,
) && pass

// Existing dedup still runs over the read set (EXIF summary emitted).
pass = check(
  'existing EXIF dedup still applied to read set (exif.summary emitted)',
  a.exifSummaryEmitted === true,
  JSON.stringify(a.exifSummary),
) && pass

// Both serial subfolders independently scanned + imported new files.
pass = check(
  'both serial subfolders (129 & 130) independently imported new files',
  a.bothSerialSubfoldersHadNewImported === true,
  `129 newImported=${ps['129EOSR6']?.newImported} 130 newImported=${ps['130EOSR6']?.newImported}`,
) && pass

// ── ALGORITHM SAFETY (mode-independent, primary source) ──────────────────
// Computed by replicating photos.ts's EXACT firstGE-BAND cutoff over the
// fixture's sorted basenames vs the seeded bookmark. Two hard invariants:
//  (1) NO genuinely-new photo is ever in the pre-skip set.
//  (2) Every file the algorithm KEEPS was actually opened (we never silently
//      fail to read a file we intended to read).
pass = check(
  'SAFETY: zero genuinely-new photos placed in the pre-skip set (algorithm)',
  a.newPhotosInsideSkipSetTotal === 0,
  `newInsideSkipSet=${a.newPhotosInsideSkipSetTotal}`,
) && pass
pass = check(
  'SAFETY: every kept (non-skipped) file was actually opened (no silent drop)',
  a.keptButNotOpenedTotal === 0,
  `keptButNotOpened=${a.keptButNotOpenedTotal} ${JSON.stringify(a.keptButNotOpenedNames)}`,
) && pass

if (mode === 'unpatched') {
  // RUN A: pre-skip DISABLED — the serial card opens EVERY file (no skip),
  // and emits NO pre-skip event. (The headline open-count A>>B delta is
  // asserted by the orchestrator across run-unpatched vs run-patched.)
  const s129 = ps['129EOSR6'] || {}
  const s130 = ps['130EOSR6'] || {}
  pass = check(
    'UNPATCHED: 129EOSR6 every file opened (pre-skip disabled)',
    (s129.keptButNotOpened || []).length === 0 &&
      (s129.skippedButOpened || []).length === (s129.expectedSkipCount || 0),
    `expectedSkip=${s129.expectedSkipCount} skippedButOpened=${(s129.skippedButOpened||[]).length}`,
  ) && pass
  pass = check(
    'UNPATCHED: serial card emitted NO filename pre-skip',
    (r.cards?.main?.fnPreskip || []).reduce((n, e) => n + (e?.skipped || 0), 0) === 0,
    JSON.stringify(r.cards?.main?.fnPreskip),
  ) && pass
  pass = check(
    'UNPATCHED: serial-card open-count == total fixture files (read everything)',
    a.serialCardOpenedCount >= (s129.fileCount || 0) + (s130.fileCount || 0),
    `opened=${a.serialCardOpenedCount} files=${(s129.fileCount||0)+(s130.fileCount||0)}`,
  ) && pass
} else {
  // RUN B: pre-skip ACTIVE — the algorithm's skip set is non-empty AND every
  // file in it was genuinely NOT opened (the speed win), while every new file
  // is still imported (GATING above proved 0 dropped).
  pass = check(
    'PATCHED: serial-card pre-skip set non-empty (129 ∪ 130)',
    (a.serial129_expectedSkipCount + a.serial130_expectedSkipCount) > 0,
    `129=${a.serial129_expectedSkipCount} 130=${a.serial130_expectedSkipCount}`,
  ) && pass
  pass = check(
    'PATCHED: NO expected-skip file was opened on the serial card (speed proof)',
    a.serial129_skippedButOpenedCount === 0 && a.serial130_skippedButOpenedCount === 0,
    `129 skippedButOpened=${a.serial129_skippedButOpenedCount} 130=${a.serial130_skippedButOpenedCount}`,
  ) && pass
  pass = check(
    'PATCHED: filename pre-skip actually skipped files on the serial card',
    (r.cards?.main?.fnPreskip || []).reduce((n, e) => n + (e?.skipped || 0), 0) > 0,
    JSON.stringify(r.cards?.main?.fnPreskip),
  ) && pass
}

console.log('')
for (const c of checks) {
  console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
}
console.log('')
console.log(`VERDICT (${mode}): ${pass ? 'PASS' : 'FAIL'} — ` +
  `new-photos-dropped=${a.newPhotosDroppedTotal} (MUST be 0)`)
process.exit(pass ? 0 : 1)
