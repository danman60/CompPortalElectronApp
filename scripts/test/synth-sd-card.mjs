#!/usr/bin/env node
/**
 * Build a synthetic SD card folder structure with real JPEG files carrying
 * deterministic EXIF DateTimeOriginal stamps + body-key-conformant filenames.
 *
 * Usage:
 *   node scripts/test/synth-sd-card.mjs \
 *     --out /tmp/synth-sd-A \
 *     --count 30 \
 *     --bodyKey P16 \
 *     --baseDate 2026-04-29T14:00:00 \
 *     --intervalSec 12
 *
 * Generates a minimal-but-valid JPEG with embedded EXIF (using a tiny
 * pre-built stub + injection of DateTimeOriginal). Filenames follow the
 * body-key pattern (e.g. P1612345.JPG for Lumix P16).
 *
 * Folder layout:
 *   <out>/DCIM/100_PANA/<filename>.JPG  (Lumix style)
 *   <out>/DCIM/<filename>.JPG            (other bodies)
 *
 * The harness then points importPhotos at <out>/DCIM/<...>/ and verifies
 * matcher behavior, watermark gate, body-key extraction, etc.
 *
 * Stdlib only. No npm deps.
 */

import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'

function parseArgs() {
  const args = { out: null, count: 10, bodyKey: 'P16', baseDate: null, intervalSec: 12 }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, '')
    const v = a[i + 1]
    if (k === 'count' || k === 'intervalSec') args[k] = parseInt(v, 10)
    else args[k] = v
  }
  if (!args.out) throw new Error('--out required')
  if (!args.baseDate) args.baseDate = new Date().toISOString().slice(0, 19)
  return args
}

// Body-key → filename + folder pattern
const BODY_PATTERNS = {
  'P10': { folder: '100_PANA', filename: (seq) => `P10${String(seq).padStart(5, '0')}.JPG` },
  'P11': { folder: '101_PANA', filename: (seq) => `P11${String(seq).padStart(5, '0')}.JPG` },
  'P16': { folder: '166_PANA', filename: (seq) => `P16${String(seq).padStart(5, '0')}.JPG` },
  'P17': { folder: '170_PANA', filename: (seq) => `P17${String(seq).padStart(5, '0')}.JPG` },
  'NAP': { folder: 'DCIM', filename: (seq) => `NAP_${String(seq).padStart(4, '0')}.JPG` },
  'DSC': { folder: 'DCIM', filename: (seq) => `DSC_${String(seq).padStart(4, '0')}.JPG` },
  'IMG': { folder: 'DCIM', filename: (seq) => `IMG_${String(seq).padStart(4, '0')}.JPG` },
  'Q53A': { folder: 'DCIM', filename: (seq) => `Q53A${String(seq).padStart(4, '0')}.JPG` },
  'UNKNOWN': { folder: 'DCIM', filename: (seq) => `WEIRD_${String(seq).padStart(3, '0')}.JPG` },
}

// Minimal valid JPEG bytes (16x16 white) with EXIF placeholder space.
// We build it programmatically to inject DateTimeOriginal.
function buildMinimalJpegWithExif(dateTime) {
  // EXIF tag for DateTimeOriginal (0x9003), ASCII, 20 bytes (incl null terminator)
  // Format: "YYYY:MM:DD HH:MM:SS\0"
  const dtBytes = Buffer.from(dateTime + '\0', 'ascii')
  if (dtBytes.length !== 20) {
    throw new Error(`DateTime string must be 19 chars + null, got ${dtBytes.length}`)
  }

  // EXIF segment structure (TIFF in JPEG APP1):
  //   FF E1 [size] "Exif\0\0" + TIFF data
  //   TIFF: II (little-endian) + 0x002A + IFD0 offset (8)
  //   IFD0: 1 entry pointing to ExifIFD subdir
  //         tag 0x8769 (ExifIFDPointer), type LONG (4), count 1, value = offset to ExifIFD
  //   ExifIFD: 1 entry: DateTimeOriginal
  //     tag 0x9003, type ASCII (2), count 20, value = offset to date string
  //   String data: 20 bytes
  //
  // Layout in TIFF block (offsets from start of TIFF, i.e. after "MM\0\0"):
  //   0:  "II"
  //   2:  0x2A 0x00         (TIFF magic)
  //   4:  IFD0 offset (8)
  //   8:  IFD0: count=1
  //   10: tag 0x8769, type 4, count 1, value = 26 (ExifIFD offset)
  //   22: next IFD offset = 0
  //   26: ExifIFD count = 1
  //   28: tag 0x9003, type 2, count 20, value-offset = 44 (date string offset)
  //   40: next IFD offset = 0
  //   44: 20 bytes date string

  const tiff = Buffer.alloc(64)
  // II
  tiff[0] = 0x49; tiff[1] = 0x49
  // magic 0x002A
  tiff.writeUInt16LE(0x002A, 2)
  // IFD0 offset = 8
  tiff.writeUInt32LE(8, 4)
  // IFD0: count=1
  tiff.writeUInt16LE(1, 8)
  // tag 0x8769 (ExifIFDPointer), type 4 (LONG), count 1, value 26
  tiff.writeUInt16LE(0x8769, 10)
  tiff.writeUInt16LE(4, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt32LE(26, 18)
  // next IFD = 0
  tiff.writeUInt32LE(0, 22)
  // ExifIFD: count=1
  tiff.writeUInt16LE(1, 26)
  // tag 0x9003 (DateTimeOriginal), type 2 (ASCII), count 20, offset 44
  tiff.writeUInt16LE(0x9003, 28)
  tiff.writeUInt16LE(2, 30)
  tiff.writeUInt32LE(20, 32)
  tiff.writeUInt32LE(44, 36)
  // next IFD = 0
  tiff.writeUInt32LE(0, 40)
  // date string at offset 44
  dtBytes.copy(tiff, 44)

  // EXIF marker payload: "Exif\0\0" + tiff
  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const segSize = exifPayload.length + 2 // includes the 2-byte size field
  const app1Header = Buffer.alloc(4)
  app1Header[0] = 0xFF; app1Header[1] = 0xE1
  app1Header.writeUInt16BE(segSize, 2)
  const app1 = Buffer.concat([app1Header, exifPayload])

  // SOI + APP1 + minimal SOF0 + DQT + SOS + EOI for 16x16 white JPEG.
  // Use a precomputed minimal JPEG body.
  const jpegBody = Buffer.from([
    0xFF, 0xD8, // SOI
  ])
  // We'll splice APP1 right after SOI.
  // Then use a minimal valid 16x16 white JPEG body (precomputed):
  const minBodyHex =
    'FFDB004300080606070605080707070909080A0C140D0C0B0B0C1912130F141D' +
    '1A1F1E1D1A1C1C20242E2720222C231C1C2837292C30313434341F27393D3832' +
    '3C2E333432FFC0000B080010001001011100FFC4001F0000010501010101010100' +
    '000000000000000102030405060708090A0BFFC400B5100002010303020403050504' +
    '040000017D01020300041105122131410613516107227114328191A1082342B1C115' +
    '52D1F02433627282090A161718191A25262728292A3435363738393A434445464748' +
    '494A535455565758595A636465666768696A737475767778797A838485868788898A' +
    '92939495969798999AA2A3A4A5A6A7A8A9AAB2B3B4B5B6B7B8B9BAC2C3C4C5C6C7C8' +
    'C9CAD2D3D4D5D6D7D8D9DAE1E2E3E4E5E6E7E8E9EAF1F2F3F4F5F6F7F8F9FAFFDA00' +
    '08010100003F00FB7FFFD9'
  const minBody = Buffer.from(minBodyHex, 'hex')

  return Buffer.concat([
    jpegBody,
    app1,
    minBody.slice(2), // skip the duplicate SOI
  ])
}

async function main() {
  const args = parseArgs()
  const pattern = BODY_PATTERNS[args.bodyKey]
  if (!pattern) throw new Error(`Unknown bodyKey: ${args.bodyKey}. Known: ${Object.keys(BODY_PATTERNS).join(',')}`)

  const dcimRoot = path.join(args.out, 'DCIM', pattern.folder)
  await fs.mkdir(dcimRoot, { recursive: true })

  const baseTimeMs = new Date(args.baseDate).getTime()
  if (isNaN(baseTimeMs)) throw new Error(`Invalid baseDate: ${args.baseDate}`)

  for (let i = 0; i < args.count; i++) {
    const t = new Date(baseTimeMs + i * args.intervalSec * 1000)
    // EXIF DateTimeOriginal format: "YYYY:MM:DD HH:MM:SS"
    const exifDate =
      `${t.getFullYear()}:${String(t.getMonth() + 1).padStart(2, '0')}:${String(t.getDate()).padStart(2, '0')} ` +
      `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
    const seq = 1000 + i
    const filename = pattern.filename(seq)
    const jpeg = buildMinimalJpegWithExif(exifDate)
    await fs.writeFile(path.join(dcimRoot, filename), jpeg)
  }
  console.log(`Wrote ${args.count} synth JPEG(s) to ${dcimRoot} (bodyKey=${args.bodyKey}, base=${args.baseDate}, interval=${args.intervalSec}s)`)
}

main().catch((err) => {
  console.error('synth-sd-card failed:', err)
  process.exit(1)
})
