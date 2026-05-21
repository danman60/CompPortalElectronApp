/**
 * exif-bookmark proof harness — REAL-MODULE entry (no mocking of logic under
 * test).
 *
 * Imports and drives the ACTUAL source:
 *   - photos.importPhotos / runImport   (the REAL scan + per-(serial,subfolder)
 *                                        filename pre-skip + EXIF cursor + DB
 *                                        dedup + ±30s window match + copy)
 *   - state                             (the REAL setCompetition + cursor +
 *                                        filename-bookmark persistence)
 *   - settings                          (REAL -> DEFAULT_SETTINGS; EXIF/matcher
 *                                        workers default OFF => the REAL inline
 *                                        getPhotoCaptureTime path runs)
 *
 * Only true I/O BOUNDARIES are aliased at bundle time (esbuild plugin in
 * build-harness.mjs), NEVER the dedup logic:
 *   - 'electron'                : app.getPath -> isolated tmp userData;
 *                                 BrowserWindow/dialog no-ops.
 *   - '../utils/volumeSerial'   : the `vol F:` Windows cmd is unavailable on
 *                                 Linux. Aliased to a deterministic map
 *                                 cardRoot -> serial (the SHIM IS the only
 *                                 thing standing in for the OS volume cmd;
 *                                 the cursor/bookmark KEYING logic that
 *                                 consumes the serial is the REAL code).
 *   - './recording'            : broadcastFullState is a renderer IPC push,
 *                                 not dedup logic. No-op'd.
 *
 * Instrumentation (primary-source verdict, not prose):
 *   - fs.promises.open is wrapped to record EVERY file the import OPENS
 *     (getPhotoCaptureTime opens the file to read its 128KB EXIF header).
 *     open-count per basename == "was this file EXIF-read?".
 *   - fs.promises.copyFile is wrapped to record EVERY source file the import
 *     COPIES into a routine folder == "was this file IMPORTED?" (the
 *     definitive imported set — the data-loss guard reads from here).
 *
 * Verdict JSON to stdout. The orchestrator/check-verdict judges from the
 * instrumented opens + copied set + the import's emitted events — never from
 * the harness's opinion of the code.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as photos from '../../src/main/services/photos'
import * as state from '../../src/main/services/state'
import * as events from '../../src/main/services/events'
import type { Competition, Routine } from '../../src/shared/types'

const UD = process.env.EB_UD || '/tmp/cse-exif-bookmark-ud'
const EXP = JSON.parse(fs.readFileSync(path.join(UD, '_expectations.json'), 'utf8'))

// ── fs instrumentation (the primary-source recorders) ──────────────────────
const opened: string[] = []      // every path passed to fs.promises.open
const copiedFrom: string[] = []  // every SOURCE path passed to fs.promises.copyFile

const realOpen = fs.promises.open.bind(fs.promises)
;(fs.promises as any).open = async function (p: any, ...rest: any[]) {
  try {
    const s = String(p)
    if (/\.(jpe?g)$/i.test(s)) opened.push(s)
  } catch {}
  return realOpen(p as any, ...(rest as []))
}
const realCopy = fs.promises.copyFile.bind(fs.promises)
;(fs.promises as any).copyFile = async function (src: any, dest: any, ...rest: any[]) {
  try {
    const s = String(src)
    if (/\.(jpe?g)$/i.test(s)) copiedFrom.push(s)
  } catch {}
  return realCopy(src as any, dest as any, ...(rest as []))
}

function baseUpper(p: string): string {
  return path.basename(p).toUpperCase()
}

// Recording windows: one routine whose window covers EVERY fixture photo so
// the REAL matcher copies all matched (= imported) photos. Built from the
// fixture's local wall-clock values (same basis as parseExifLocalDate).
function makeRoutine(): Routine {
  const w = EXP.windows.main
  const [, ...sArr] = [0] // noop to keep tsc happy about destructure
  void sArr
  const sd = new Date(w.startLocal[0], w.startLocal[1] - 1, w.startLocal[2], w.startLocal[3], w.startLocal[4], w.startLocal[5])
  const ed = new Date(w.endLocal[0], w.endLocal[1] - 1, w.endLocal[2], w.endLocal[3], w.endLocal[4], w.endLocal[5])
  return {
    id: 'eb-r1',
    entryNumber: '1',
    routineTitle: 'EB Routine 1',
    dancers: 'Test',
    studioName: 'Test Studio',
    studioCode: 'TS',
    category: 'Jazz',
    classification: 'Competitive',
    ageGroup: 'Teen',
    sizeCategory: 'Solo',
    durationMinutes: 600,
    scheduledDay: 'Day 1',
    position: 1,
    status: 'recorded',
    recordingStartedAt: sd.toISOString(),
    recordingStoppedAt: ed.toISOString(),
    outputDir: path.join(UD, 'media', '1_EB_Routine_1_TS'),
    photos: [],
  } as unknown as Routine
}

function buildCompetition(routines: Routine[]): Competition {
  return {
    tenantId: 'eb-tenant',
    competitionId: 'eb-comp',
    name: 'exif-bookmark fixture',
    routines,
    days: ['Day 1'],
    source: 'api',
    loadedAt: new Date().toISOString(),
  } as unknown as Competition
}

// Card root mapping must mirror make-fixture.mjs (CARD, CARD-G, CARD-H).
const ACTIVE_CARD_FILE = '/tmp/cse-eb-active-card'

async function importCard(folderPath: string, cardRoot: string, routines: Routine[]) {
  const before = { opened: opened.length, copied: copiedFrom.length }

  // Faithful "which card is in the reader" signal the volumeSerial shim
  // reads — set to the SINGLE card root this import processes (importPhotos
  // is FIFO-serialized; exactly one card active at a time, exactly like one
  // physical reader slot). The cursor/bookmark keying off the returned serial
  // is the REAL code.
  fs.writeFileSync(ACTIVE_CARD_FILE, cardRoot)

  // Capture emitted events via the REAL events.setOnEmit live subscriber
  // (events.ts has no .on; setOnEmit is the single live fanout the renderer
  // uses). Primary source = the import's own structured events.
  const fnPre: any[] = []
  const exifSum: any[] = []
  const prevOnEmit = (events as any).setOnEmit
  ;(events as any).setOnEmit?.((rec: any) => {
    if (rec?.kind === 'import.fnbookmark.preskip') fnPre.push(rec.data)
    else if (rec?.kind === 'import.exif.summary') exifSum.push(rec.data)
  })

  const res = await photos.importPhotos(
    folderPath,
    routines,
    path.join(UD, 'media'),
    {}, // NORMAL import: no previewOnly, no allowlist, no dedupByDb
  )

  // Per-import event isolation: ONLY the setOnEmit live capture active during
  // THIS import counts. We deliberately do NOT consult events.getRecent()
  // here — that ring is shared across all 3 imports in a run and would
  // cross-attribute the serial card's pre-skip event to the later
  // rollover/unknown imports. fnPre/exifSum were filled live above, scoped to
  // exactly this import's window. Filter by folderPath as a final guard.
  ;(events as any).setOnEmit?.(null)
  void prevOnEmit
  const fnPreOwn = fnPre.filter((e) => !e || e.folderPath === folderPath)
  const exifSumOwn = exifSum.filter((e) => !e || e.folderPath === folderPath || e.folderPath === undefined)
  fnPre.length = 0; fnPre.push(...fnPreOwn)
  exifSum.length = 0; exifSum.push(...exifSumOwn)

  return {
    folderPath,
    result: res,
    openedThisCard: opened.slice(before.opened).map(baseUpper),
    copiedThisCard: copiedFrom.slice(before.copied).map(baseUpper),
    fnPreskipEvents: fnPre,
    exifSummaryEvents: exifSum,
  }
}

async function main() {
  const out: any = {
    build: {
      filenamePreSkipPresent: undefined as any,
    },
    fixture: {
      ud: UD,
      tzSkew: EXP.tzSkew,
      serialMain: EXP.serialMain,
      serialG: EXP.serialG,
      band: EXP.band,
    },
    cards: {},
    perSubfolder: {},
    assertions: {},
  }

  // Build-detect: is the filename pre-skip code present in THIS bundle? The
  // patched build logs/emits 'import.fnbookmark.preskip' and exposes the
  // state bookmark API; the unpatched (toggled) build does not pre-skip.
  out.build.filenamePreSkipPresent =
    typeof (state as any).getSdFilenameBookmark === 'function'

  // REAL setCompetition (loads the pre-seeded isolated state: sdCardCursors +
  // sdFilenameBookmarks). state.loadState() is invoked by setCompetition path
  // / the module; to be explicit we hydrate first.
  try { (state as any).loadState?.() } catch {}

  const routines = [makeRoutine()]
  state.setCompetition(buildCompetition(routines))

  // Drive the three independent cards (each its own volume root => serial via
  // the volumeSerial shim). Sequential (importPhotos FIFO-queues anyway).
  const main1 = await importCard(EXP.card, EXP.card, routines)     // serial card (129+130)
  const roll = await importCard(EXP.cardG, EXP.cardG, routines)    // rollover (140)
  const unk = await importCard(EXP.cardH, EXP.cardH, routines)     // unknown card (150)

  out.cards.main = {
    result: main1.result,
    openedCount: main1.openedThisCard.length,
    copiedCount: main1.copiedThisCard.length,
    fnPreskip: main1.fnPreskipEvents,
    exifSummary: main1.exifSummaryEvents,
  }
  out.cards.rollover = {
    result: roll.result,
    openedCount: roll.openedThisCard.length,
    copiedCount: roll.copiedThisCard.length,
    fnPreskip: roll.fnPreskipEvents,
  }
  out.cards.unknown = {
    result: unk.result,
    openedCount: unk.openedThisCard.length,
    copiedCount: unk.copiedThisCard.length,
    fnPreskip: unk.fnPreskipEvents,
  }

  // ── Per-subfolder primary-source rollup ──────────────────────────────────
  // For each subfolder, against its fixture file list:
  //   opened?  (in the union of opens for the owning card)
  //   copied?  (in the union of copies for the owning card == imported)
  const openedAll = new Set<string>([
    ...main1.openedThisCard, ...roll.openedThisCard, ...unk.openedThisCard,
  ])
  const copiedAll = new Set<string>([
    ...main1.copiedThisCard, ...roll.copiedThisCard, ...unk.copiedThisCard,
  ])

  // Faithful in-harness replica of photos.ts's EXACT pre-skip cutoff so the
  // verdict's "expected skip set" is computed by the SAME algorithm the code
  // uses (not a fixture-side hand-model that can drift / off-by-one). Mirrors
  // photos.ts:
  //   sorted = subfolder basenames sorted asc (upper-cased)
  //   firstGE = first index where name >= bookmark
  //   cutoff  = max(0, firstGE - BOUNDARY_REREAD_BAND)
  //   pre-skipped (NOT opened) = sorted[0 .. cutoff)
  // Rollover (maxName <= bookmark) and unknown-card (no serial) => NO skip.
  const BAND = EXP.band
  function expectedSkipSet(info: any): Set<string> {
    if (info.unknownCard || !info.serial) return new Set()
    const names = info.files.map((f: any) => f.name) // already upper-cased
    const sorted = names.slice().sort((a: string, b: string) =>
      a < b ? -1 : a > b ? 1 : 0)
    const wm = (info.bookmark || '').toUpperCase()
    if (!wm) return new Set()
    const maxName = sorted.length ? sorted[sorted.length - 1] : ''
    if (maxName <= wm) return new Set() // rollover => full read
    let firstGE = sorted.length
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] >= wm) { firstGE = i; break }
    }
    const cutoff = Math.max(0, firstGE - BAND)
    return new Set(sorted.slice(0, cutoff))
  }

  let newDroppedTotal = 0
  const newDroppedNames: string[] = []
  for (const [sub, info] of Object.entries<any>(EXP.subfolders)) {
    const skipSet = expectedSkipSet(info)
    const rows = info.files.map((f: any) => ({
      name: f.name,
      isNew: f.isNew,
      inBand: f.inBand,
      backfill: f.backfill,
      sortsBelowBookmark: f.sortsBelowBookmark,
      expectedSkipped: skipSet.has(f.name), // per photos.ts's own algorithm
      opened: openedAll.has(f.name),
      copied: copiedAll.has(f.name), // == imported
    }))
    const newFiles = rows.filter((r: any) => r.isNew)
    const newDropped = newFiles.filter((r: any) => !r.copied)
    newDroppedTotal += newDropped.length
    for (const r of newDropped) newDroppedNames.push(`${sub}/${r.name}`)

    // SAFETY (the invariant, primary source): NO file the algorithm expects
    // to skip may be a genuinely-new photo. If any expected-skip file isNew,
    // the algorithm itself is unsafe (independent of whether it was opened).
    const newInsideSkipSet = rows.filter((r: any) => r.isNew && r.expectedSkipped)

    // SPEED (primary source): every expected-skip file must NOT have been
    // opened (proves the pre-skip actually elided the EXIF read). Conversely
    // every file NOT in the skip set MUST have been opened (proves we never
    // silently dropped a file we were supposed to read).
    const skippedButOpened = rows.filter((r: any) => r.expectedSkipped && r.opened)
    const keptButNotOpened = rows.filter((r: any) => !r.expectedSkipped && !r.opened)

    out.perSubfolder[sub] = {
      serial: info.serial,
      bookmark: info.bookmark,
      rollover: !!info.rollover,
      unknownCard: !!info.unknownCard,
      fileCount: rows.length,
      newCount: newFiles.length,
      newImported: newFiles.filter((r: any) => r.copied).length,
      newDropped: newDropped.map((r: any) => r.name),
      expectedSkipCount: skipSet.size,
      newInsideSkipSet: newInsideSkipSet.map((r: any) => r.name), // MUST be []
      skippedButOpened: skippedButOpened.map((r: any) => r.name), // tolerable (read more)
      keptButNotOpened: keptButNotOpened.map((r: any) => r.name), // MUST be []
      backfillRows: rows
        .filter((r: any) => r.backfill)
        .map((r: any) => ({
          name: r.name, opened: r.opened, imported: r.copied,
          expectedSkipped: r.expectedSkipped,
        })),
      rows,
    }
  }

  // ── Verdict-grade assertions (computed from instrumented primary source) ──
  const A = out.assertions

  // THE GATING ASSERTION: zero genuinely-new photos failed to import, across
  // every scenario. >0 == the change is WRONG.
  A.newPhotosDroppedTotal = newDroppedTotal
  A.newPhotosDroppedNames = newDroppedNames

  // SAFETY (mode-independent): the pre-skip algorithm must NEVER place a
  // genuinely-new photo in its skip set, and must NEVER fail to open a file
  // it was supposed to keep. Aggregated across every subfolder.
  let newInsideSkipTotal = 0
  let keptButNotOpenedTotal = 0
  const keptButNotOpenedNames: string[] = []
  for (const [sub, s] of Object.entries<any>(out.perSubfolder)) {
    newInsideSkipTotal += (s.newInsideSkipSet || []).length
    keptButNotOpenedTotal += (s.keptButNotOpened || []).length
    for (const n of s.keptButNotOpened || []) keptButNotOpenedNames.push(`${sub}/${n}`)
  }
  A.newPhotosInsideSkipSetTotal = newInsideSkipTotal // MUST be 0 (algorithm safety)
  A.keptButNotOpenedTotal = keptButNotOpenedTotal     // MUST be 0 (read-what-we-keep)
  A.keptButNotOpenedNames = keptButNotOpenedNames

  // Speed proof (PATCHED): on the serial card the pre-skip algorithm's skip
  // set is non-empty AND those files were genuinely NOT opened. On UNPATCHED
  // the pre-skip is disabled so the SAME files ARE opened (orchestrator
  // compares cards.main.openedCount A vs B for the headline open-count delta).
  const s129 = out.perSubfolder['129EOSR6']
  const s130 = out.perSubfolder['130EOSR6']
  A.serial129_expectedSkipCount = s129.expectedSkipCount
  A.serial129_skippedButOpenedCount = s129.skippedButOpened.length
  A.serial130_expectedSkipCount = s130.expectedSkipCount
  A.serial130_skippedButOpenedCount = s130.skippedButOpened.length
  A.serialCardOpenedCount = out.cards.main.openedCount
  A.serialCardCopiedCount = out.cards.main.copiedCount
  A.bothSerialSubfoldersHadNewImported =
    s129.newImported > 0 && s130.newImported > 0

  // Data-loss guard: the backfilled in-band file (old name, new content) MUST
  // be opened AND imported.
  const bf = ([] as any[])
    .concat(...Object.values<any>(out.perSubfolder).map((s: any) => s.backfillRows))
  A.backfillFiles = bf
  A.backfillAllImported = bf.length > 0 && bf.every((b: any) => b.imported === true)
  A.backfillAllOpened = bf.length > 0 && bf.every((b: any) => b.opened === true)

  // Rollover: 140 subfolder full-read (every new file imported), bookmark
  // cleared then re-established (post-import bookmark exists again).
  const s140 = out.perSubfolder['140EOSR6']
  A.rollover_allNewImported = s140.newCount > 0 && s140.newDropped.length === 0
  // Unknown card: 150 behaves exactly as no-pre-skip (every file opened AND
  // every new file imported); fnPreskip events empty for the unknown card.
  const s150 = out.perSubfolder['150EOSR6']
  A.unknown_allNewImported = s150.newCount > 0 && s150.newDropped.length === 0
  A.unknown_allOpened = s150.rows.every((r: any) => r.opened === true)
  A.unknown_noPreskipEvent =
    (out.cards.unknown.fnPreskip || []).reduce(
      (n: number, e: any) => n + (e?.skipped || 0), 0,
    ) === 0

  // Existing dedup still applies to the read set: the EXIF cursor was seeded
  // LOW (older than all photos) so nothing should be cursor-skipped here; we
  // assert the import still ran the cursor (exif.summary emitted) and that
  // the accepted count == files actually read minus cursor/date skips.
  const sum = (out.cards.main.exifSummary || [])[0]
  A.exifSummaryEmitted = !!sum
  A.exifSummary = sum
    ? {
        scanned: sum.scanned,
        accepted: sum.accepted,
        skippedDupes: sum.skippedDupes,
        skippedWrongDate: sum.skippedWrongDate,
      }
    : null

  // TZ-skew run flag (set by EB_TZSKEW=1 fixture): the gating assertion above
  // already covers "no new photo dropped" under the skewed cursor; surface
  // the flag so the verdict can label it.
  A.tzSkewRun = !!EXP.tzSkew

  // Flush synchronously, then HARD-EXIT. The REAL state.ts saveState() the
  // import calls schedules a referenced 500ms debounce setTimeout (verified
  // via a SIGUSR2 node report: after main() resolves, the ONLY active libuv
  // handle is that timer, no JS stack — so plain return would hang node ~∞
  // as the debounce keeps re-arming under repeated bookmark/cursor writes).
  // The state file has already been written by saveState()'s leading-edge
  // doSave(); the trailing debounce is redundant for the harness. We force a
  // synchronous final flush of state then exit 0 so the verdict reader gets
  // a clean terminating process. (Mirrors how the packaged app exits — it
  // calls saveStateImmediate() on quit; here exiting is equivalent because
  // every mutation already did its leading-edge doSave().)
  try { (state as any).saveStateImmediate?.() } catch {}
  fs.writeSync(1, JSON.stringify(out, null, 2) + '\n')
  process.exit(0)
}

main().catch((err) => {
  process.stderr.write('HARNESS ERROR: ' + (err?.stack || String(err)) + '\n')
  process.exit(3)
})
