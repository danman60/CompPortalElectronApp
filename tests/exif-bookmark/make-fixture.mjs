#!/usr/bin/env node
/**
 * exif-bookmark harness — fixture generator.
 *
 * Builds a fake SD-card DCIM tree on disk with REAL EXIF JPEGs (the REAL
 * getPhotoCaptureTime -> ExifReader.load parses them; no EXIF mock) plus a
 * pre-seeded isolated userData state file carrying a prior EXIF cursor + a
 * mid-folder filename bookmark per subfolder.
 *
 * Card layout (one volume, serial pinned by the volumeSerial shim to the
 * card root) — TWO DCIM subfolders, independently bookmarked:
 *
 *   F:\DCIM\129EOSR6\  (Lumix-style names P129xxxx.JPG) — 30 files
 *   F:\DCIM\130EOSR6\  (Lumix-style names P130xxxx.JPG) — 30 files
 *
 * Plus three extra structures on SEPARATE roots so each scenario is isolated:
 *   G:\DCIM\140EOSR6\  rollover subfolder (name wrap mid-batch)
 *   H:\DCIM\150EOSR6\  unknown card (volumeSerial shim returns '' for H:)
 *
 * Scenario coverage embedded in 129EOSR6 / 130EOSR6:
 *   (a) already-imported files BEFORE the bookmark (sort < bookmark)
 *   (b) genuinely-new files AFTER the bookmark (sort > bookmark)
 *   (c) one backfilled file with an OLD name (sorts < bookmark) NOT
 *       previously imported, placed INSIDE the boundary re-read band
 *   (d) rollover (name wrap) in G:\DCIM\140EOSR6
 *   (e) unknown card H:\DCIM\150EOSR6 (no serial)
 *
 * EXIF capture times: all on the fixture "today" (so the always-on
 * strict-today filter does NOT drop them) and inside the recording windows
 * the harness installs. Monotonic with filename order EXCEPT the backfilled
 * file (old name, but a fresh capture time) and the rollover batch.
 *
 * TZ-mismatch sub-fixture: the pre-seeded sdCardCursor.lastCaptureTime is
 * written via the SAME `.toISOString()` projection photos.ts uses, but we
 * ALSO emit a parallel "cursor stored UTC-shifted" variant flag so the
 * verdict can assert a TZ skew on the cursor never causes a NEW file to be
 * pre-skipped (filename skip is TZ-immune; this is the data-loss guard).
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeExifJpeg } from './lib-exif-jpeg.mjs'

const UD = process.env.EB_UD || '/tmp/cse-exif-bookmark-ud'
const CARD = process.env.EB_CARD || '/tmp/cse-exif-bookmark-card'

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }) }

rmrf(UD); rmrf(CARD)
mkdirp(path.join(UD, 'logs'))
const mediaRoot = path.join(UD, 'media')
mkdirp(mediaRoot)

// Fixture "today" — MUST be the REAL current local date. photos.ts has an
// always-on strict-today filter (Bug F guard, photos.ts:1468) that drops any
// photo whose EXIF date != new Date() at import time. That guard is one of
// the dedup guarantees we PRESERVE; the fixture works WITH it by stamping
// every photo with today's date (the only scenario the import accepts by
// default). Hardcoding a date makes the whole fixture stale after midnight
// and the filter nukes 100% of photos (observed: a UTC-midnight rollover
// mid-session turned a green run red). EXIF strings are naive-local
// "YYYY:MM:DD HH:MM:SS"; recording windows use the SAME local wall-clock.
const _now = new Date()
const Y = _now.getFullYear(), MO = _now.getMonth() + 1, D = _now.getDate()
function exifStr(h, mi, s) {
  const p2 = (n) => String(n).padStart(2, '0')
  return `${Y}:${p2(MO)}:${p2(D)} ${p2(h)}:${p2(mi)}:${p2(s)}`
}
// JS Date in LOCAL tz from the same components (matches parseExifLocalDate).
function localDate(h, mi, s) {
  return new Date(Y, MO - 1, D, h, mi, s)
}

// ---- Subfolder builder -----------------------------------------------------
// Returns { files: [{name, exif, capture, isNew, inBand, backfill}], windowStart, windowEnd }
function buildSubfolder(cardRoot, dcimSub, prefix, opts) {
  const dir = path.join(cardRoot, 'DCIM', dcimSub)
  mkdirp(dir)
  const COUNT = 30
  const BOOKMARK_INDEX = opts.bookmarkIndex // 0-based; files [0..BM] are "already imported"
  const BAND = 5 // must equal BOUNDARY_REREAD_BAND in photos.ts

  // Base capture time: start at 14:00:00, +2s per file (monotonic).
  const baseH = opts.baseHour, baseMi = 0
  const files = []
  for (let i = 0; i < COUNT; i++) {
    // Lumix-style: P + 2-digit folder prefix + 5-digit seq. Filenames sort
    // lexically == numeric here (zero-padded), the camera-monotonic property.
    const seq = String(1000 + i).padStart(5, '0')
    const name = `${prefix}${seq}.JPG`
    const totalSec = i * 2
    const h = baseH + Math.floor((baseMi * 60 + totalSec) / 3600)
    const rem = (baseMi * 60 + totalSec) % 3600
    const mi = Math.floor(rem / 60)
    const s = rem % 60
    const exif = exifStr(h, mi, s)
    const capture = localDate(h, mi, s)
    const isNew = i > BOOKMARK_INDEX
    const inBand = i <= BOOKMARK_INDEX && i > BOOKMARK_INDEX - BAND
    files.push({ name, exif, capture, isNew, inBand, backfill: false })
    writeExifJpeg(path.join(dir, name), exif)
  }

  // (c) BACKFILLED FILE — task scenario (c): an OLD-style name that sorts
  // INSIDE the boundary re-read band (strictly below the bookmark but within
  // the last BAND files before it) and was NOT previously imported. Fresh
  // capture time (later than the bookmark file) — a write that landed
  // out-of-order on the card. The pre-skip MUST keep it (it is in the band)
  // and it MUST be imported (data-loss guard). Names are fixed-width
  // `${prefix}${01000+i}.JPG`; bookmark = `${prefix}${01000+BM}.JPG`. The
  // file `${prefix}${01000+(BM-1)}.JPG` (index BM-1) is the first slot inside
  // the band. We synthesize a name that lexically falls BETWEEN index BM-1
  // and the bookmark by appending 'Z' to the BM-1 stem:
  //   ...01013.JPG  <  ...01013Z.JPG  <  ...01014.JPG
  // ('.' 0x2E < 'Z' 0x5A < the next numeric stem), so it is strictly inside
  // [BM-BAND, BM) — exactly the band — without colliding with any real file.
  if (opts.includeBackfill) {
    const bmSeq = String(1000 + BOOKMARK_INDEX).padStart(5, '0')          // e.g. 01014
    const belowSeq = String(1000 + BOOKMARK_INDEX - 1).padStart(5, '0')   // e.g. 01013
    const bmName = `${prefix}${bmSeq}.JPG`
    const safeName = `${prefix}${belowSeq}Z.JPG`                           // ...01013Z.JPG
    const belowName = `${prefix}${belowSeq}.JPG`                           // ...01013.JPG
    // Capture time AFTER the bookmark file (genuinely new content).
    const cap = localDate(opts.baseHour, 30, 0)
    const ex = exifStr(opts.baseHour, 30, 0)
    writeExifJpeg(path.join(dir, safeName), ex)
    files.push({
      name: safeName, exif: ex, capture: cap,
      isNew: true, inBand: true, backfill: true,
    })
    // Hard sanity: safeName MUST sort strictly below the bookmark AND strictly
    // above the first in-band file (i.e. genuinely inside the band, not below
    // the whole window). If this fails the fixture is invalid → abort so we
    // never present a false PASS.
    const sn = safeName.toUpperCase(), bn = bmName.toUpperCase(), bl = belowName.toUpperCase()
    if (!(sn < bn) || !(sn > bl)) {
      throw new Error(
        `backfill placement invalid: need ${bl} < ${sn} < ${bn} (band=${BAND}, bmIdx=${BOOKMARK_INDEX})`,
      )
    }
  }

  const bmName = `${prefix}${String(1000 + BOOKMARK_INDEX).padStart(5, '0')}.JPG`
  const bmCapture = files.find((f) => f.name === bmName).capture
  return { dir, files, bmName, bmCapture }
}

// ---- 129EOSR6: serial card, mid-folder bookmark, +backfill in band --------
const sub129 = buildSubfolder(CARD, '129EOSR6', 'P129', {
  bookmarkIndex: 14, baseHour: 14, includeBackfill: true,
})
// ---- 130EOSR6: serial card, different bookmark, NO backfill ---------------
const sub130 = buildSubfolder(CARD, '130EOSR6', 'P130', {
  bookmarkIndex: 9, baseHour: 16, includeBackfill: false,
})

// ---- 140EOSR6: ROLLOVER (name wrap) — card root G ------------------------
// Simulate a counter wrap: the bookmark is at a HIGH name, but the whole
// current batch has LOW names (sequence reset). photos.ts must detect
// maxName <= bookmark and full-read (no skip), clearing the bookmark.
const CARD_G = CARD + '-G'
rmrf(CARD_G)
const dir140 = path.join(CARD_G, 'DCIM', '140EOSR6')
mkdirp(dir140)
const roll140 = []
for (let i = 0; i < 20; i++) {
  const seq = String(0 + i).padStart(5, '0') // LOW names: P14000000..P14000019
  const name = `P140${seq}.JPG`
  const h = 18, mi = 0, s = i * 2
  const exif = exifStr(h, mi, s)
  writeExifJpeg(path.join(dir140, name), exif)
  roll140.push({ name, exif, capture: localDate(h, mi, s), isNew: true })
}
// pre-seeded bookmark for 140 will point at a HIGH name P14099999 (wrap).

// ---- 150EOSR6: UNKNOWN CARD (volumeSerial shim returns '' for this root) --
const CARD_H = CARD + '-H'
rmrf(CARD_H)
const dir150 = path.join(CARD_H, 'DCIM', '150EOSR6')
mkdirp(dir150)
const unk150 = []
for (let i = 0; i < 15; i++) {
  const seq = String(2000 + i).padStart(5, '0')
  const name = `P150${seq}.JPG`
  const h = 20, mi = 0, s = i * 2
  const exif = exifStr(h, mi, s)
  writeExifJpeg(path.join(dir150, name), exif)
  unk150.push({ name, exif, capture: localDate(h, mi, s), isNew: true })
}

// ---- Pre-seed isolated userData state --------------------------------------
// SERIAL pinned by the volumeSerial shim. We pick stable fake serials per
// card root; the shim maps CARD root -> 'EB001CARD', CARD_G -> 'EB00GCARD',
// CARD_H -> '' (unknown).
const SERIAL_MAIN = 'EB001CARD'
const SERIAL_G = 'EB00GCARD'

// The EXIF cursor (correctness backstop) — seed it intentionally LOW (older
// than every fixture photo) so it does NOT mask the filename pre-skip's job:
// we want to prove the FILENAME layer skips opens, with the EXIF cursor as
// the safety net for whatever IS read. Stored via the SAME .toISOString()
// projection photos.ts uses (Date(localComponents).toISOString()).
function isoOf(d) { return d.getTime() !== d.getTime() ? '' : d.toISOString() }
const lowCursorIso = localDate(1, 0, 0).toISOString() // 01:00 local, far before any photo

// Filename bookmarks: 129 -> P1291014.JPG (index 14), 130 -> P1301009.JPG
// (index 9). 140 (rollover) -> a HIGH name to force the wrap path.
const bm129Name = sub129.bmName
const bm130Name = sub130.bmName
const bm129Cap = sub129.bmCapture.toISOString()
const bm130Cap = sub130.bmCapture.toISOString()

// TZ-mismatch sub-fixture: store a SECOND, intentionally UTC-skewed cursor
// value alongside (offset +5h) to model "cursor written UTC while EXIF is
// naive-local". The verdict asserts a new file is NEVER pre-skipped because
// of this; filename skip is TZ-immune and the EXIF cursor read-path compares
// like-for-like. We feed the skewed value as the ACTUAL seeded cursor for a
// dedicated assertion run (EB_TZSKEW=1).
const tzSkew = process.env.EB_TZSKEW === '1'
const skewMs = 5 * 3600 * 1000
const cursorIsoMain = tzSkew
  ? new Date(localDate(1, 0, 0).getTime() + skewMs).toISOString()
  : lowCursorIso

const now = new Date().toISOString()
const stateObj = {
  competition: {
    tenantId: 'eb-tenant',
    competitionId: 'eb-comp',
    name: 'exif-bookmark fixture',
    routines: [], // routines passed directly to importPhotos by the harness
    days: ['Day 1'],
    source: 'api',
    loadedAt: now,
  },
  currentRoutineId: null,
  savedAt: now,
  sdCardCursors: {
    [SERIAL_MAIN]: {
      volumeSerial: SERIAL_MAIN,
      volumeLabel: 'EB_CARD',
      lastCaptureTime: cursorIsoMain,
      setAt: now,
    },
    [SERIAL_G]: {
      volumeSerial: SERIAL_G,
      volumeLabel: 'EB_CARD_G',
      lastCaptureTime: lowCursorIso,
      setAt: now,
    },
  },
  sdFilenameBookmarks: {
    [`${SERIAL_MAIN}::129EOSR6`]: {
      volumeSerial: SERIAL_MAIN, subfolder: '129EOSR6',
      lastFilename: bm129Name.toUpperCase(), lastCaptureTime: bm129Cap, setAt: now,
    },
    [`${SERIAL_MAIN}::130EOSR6`]: {
      volumeSerial: SERIAL_MAIN, subfolder: '130EOSR6',
      lastFilename: bm130Name.toUpperCase(), lastCaptureTime: bm130Cap, setAt: now,
    },
    // ROLLOVER: bookmark points at an artificially HIGH name; the batch on
    // disk has only LOW names => maxName <= bookmark => wrap path.
    [`${SERIAL_G}::140EOSR6`]: {
      volumeSerial: SERIAL_G, subfolder: '140EOSR6',
      lastFilename: 'P14099999.JPG', lastCaptureTime: localDate(23, 0, 0).toISOString(), setAt: now,
    },
  },
}
fs.writeFileSync(path.join(UD, 'compsync-state.json'), JSON.stringify(stateObj, null, 2))
fs.writeFileSync(
  path.join(UD, 'compsync-media-settings.json'),
  JSON.stringify({ compsync: {}, behavior: { autoEncodeRecordings: false } }, null, 2),
)

// ---- Expectations manifest (primary-source verdict input) ------------------
function classify(files, sub, serial) {
  const bm = stateObj.sdFilenameBookmarks[`${serial}::${sub}`]
  return files.map((f) => ({
    name: f.name.toUpperCase(),
    exif: f.exif,
    captureIso: f.capture.toISOString(),
    isNew: !!f.isNew,
    inBand: !!f.inBand,
    backfill: !!f.backfill,
    sortsBelowBookmark: bm ? f.name.toUpperCase() < bm.lastFilename : false,
  }))
}

const expectations = {
  ud: UD,
  card: CARD,
  cardG: CARD_G,
  cardH: CARD_H,
  serialMain: SERIAL_MAIN,
  serialG: SERIAL_G,
  tzSkew,
  band: 5,
  windows: {
    // recording windows the harness installs (local wall-clock). Wide enough
    // to cover every fixture photo so the matcher copies them => "imported".
    main: { startLocal: [Y, MO, D, 13, 0, 0], endLocal: [Y, MO, D, 23, 30, 0] },
  },
  subfolders: {
    '129EOSR6': {
      root: CARD, serial: SERIAL_MAIN, bookmark: bm129Name.toUpperCase(),
      files: classify(sub129.files, '129EOSR6', SERIAL_MAIN),
    },
    '130EOSR6': {
      root: CARD, serial: SERIAL_MAIN, bookmark: bm130Name.toUpperCase(),
      files: classify(sub130.files, '130EOSR6', SERIAL_MAIN),
    },
    '140EOSR6': {
      root: CARD_G, serial: SERIAL_G, bookmark: 'P14099999.JPG', rollover: true,
      files: roll140.map((f) => ({
        name: f.name.toUpperCase(), exif: f.exif, captureIso: f.capture.toISOString(),
        isNew: true, inBand: false, backfill: false, sortsBelowBookmark: true,
      })),
    },
    '150EOSR6': {
      root: CARD_H, serial: '', bookmark: null, unknownCard: true,
      files: unk150.map((f) => ({
        name: f.name.toUpperCase(), exif: f.exif, captureIso: f.capture.toISOString(),
        isNew: true, inBand: false, backfill: false, sortsBelowBookmark: false,
      })),
    },
  },
}
fs.writeFileSync(
  path.join(UD, '_expectations.json'),
  JSON.stringify(expectations, null, 2),
)

const nNew = Object.values(expectations.subfolders)
  .flatMap((s) => s.files).filter((f) => f.isNew).length
console.log(`Fixture written:`)
console.log(`  UD=${UD}`)
console.log(`  card(main, serial ${SERIAL_MAIN})=${CARD}  [129EOSR6 +backfill, 130EOSR6]`)
console.log(`  cardG(rollover, serial ${SERIAL_G})=${CARD_G}  [140EOSR6]`)
console.log(`  cardH(unknown, no serial)=${CARD_H}  [150EOSR6]`)
console.log(`  129 bookmark=${bm129Name}  130 bookmark=${bm130Name}  140 bookmark=P14099999.JPG (wrap)`)
console.log(`  EXIF cursor seeded LOW (${cursorIsoMain})${tzSkew ? ' [TZ-SKEWED +5h]' : ''}`)
console.log(`  genuinely-new photos across all subfolders: ${nNew} (NONE may be dropped)`)
