// Minimal deterministic JPEG-with-EXIF generator for the exif-bookmark
// harness. Produces a tiny valid baseline JPEG carrying an APP1/Exif segment
// with DateTimeOriginal (0x9003) so the REAL getPhotoCaptureTime ->
// ExifReader.load() in photos.ts parses a genuine timestamp. No mocking of
// the EXIF reader — we feed it a real file it really parses.
//
// EXIF string format is "YYYY:MM:DD HH:MM:SS" (matches camera output;
// parseExifLocalDate interprets it as naive operator-local, no TZ marker).

import fs from 'node:fs'

// A 1x1 black baseline JPEG (no EXIF). Smallest valid JFIF we can ship; we
// splice an APP1 segment in right after SOI. Bytes hand-verified.
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI' +
  'CQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
)

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b }

/**
 * Build an APP1 Exif segment containing exactly one ExifIFD with
 * DateTimeOriginal (tag 0x9003, ASCII, 20 bytes incl. NUL).
 * Big-endian ("MM") TIFF. Layout:
 *   "Exif\0\0" | TIFF hdr | IFD0(1 entry -> ExifIFDPointer) | next=0 |
 *   ExifIFD(1 entry -> DateTimeOriginal, offset) | next=0 | datetime ascii
 */
function buildExifApp1(dateTimeStr) {
  const dt = Buffer.from(dateTimeStr + '\0', 'ascii') // 20 bytes for "YYYY:MM:DD HH:MM:SS\0"
  const tiff = []
  tiff.push(Buffer.from('MM', 'ascii'))        // big-endian
  tiff.push(u16(42))                            // magic 42
  tiff.push(u32(8))                             // IFD0 at offset 8

  // IFD0: 1 entry (ExifIFDPointer 0x8769, LONG, ptr)
  const ifd0 = []
  ifd0.push(u16(1))                             // entry count
  ifd0.push(u16(0x8769))                        // ExifIFDPointer
  ifd0.push(u16(4))                             // type LONG
  ifd0.push(u32(1))                             // count
  // ExifIFD starts right after IFD0(2+12+4=18 bytes) -> offset 8+18 = 26
  const exifIfdOffset = 8 + 18
  ifd0.push(u32(exifIfdOffset))                 // value = pointer
  ifd0.push(u32(0))                             // next IFD = 0

  // ExifIFD: 1 entry (DateTimeOriginal 0x9003, ASCII, count=dt.length)
  const exifIfd = []
  exifIfd.push(u16(1))                          // entry count
  exifIfd.push(u16(0x9003))                     // DateTimeOriginal
  exifIfd.push(u16(2))                          // type ASCII
  exifIfd.push(u32(dt.length))                  // count
  // ExifIFD is 2+12+4 = 18 bytes; data follows at exifIfdOffset+18
  const dtOffset = exifIfdOffset + 18
  exifIfd.push(u32(dtOffset))                   // value offset
  exifIfd.push(u32(0))                          // next IFD = 0

  const tiffBuf = Buffer.concat([...tiff, ...ifd0, ...exifIfd, dt])
  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiffBuf])
  const app1Len = app1Payload.length + 2        // length field includes itself
  return Buffer.concat([
    Buffer.from([0xff, 0xe1]),                  // APP1 marker
    u16(app1Len),
    app1Payload,
  ])
}

/**
 * Write a JPEG file at `outPath` carrying DateTimeOriginal = `exifDateTime`
 * ("YYYY:MM:DD HH:MM:SS"). If exifDateTime is null, writes the base JPEG with
 * NO EXIF (getPhotoCaptureTime -> null path, exercises the "no EXIF" branch).
 */
export function writeExifJpeg(outPath, exifDateTime) {
  if (exifDateTime == null) {
    fs.writeFileSync(outPath, BASE_JPEG)
    return
  }
  const soi = BASE_JPEG.subarray(0, 2)          // FFD8
  const rest = BASE_JPEG.subarray(2)            // everything after SOI
  const app1 = buildExifApp1(exifDateTime)
  fs.writeFileSync(outPath, Buffer.concat([soi, app1, rest]))
}

// Self-test when run directly: write one, read it back with the REAL
// exifreader to prove the bytes are genuinely parseable (no mock).
if (process.argv[1] && process.argv[1].endsWith('lib-exif-jpeg.mjs')) {
  const os = await import('node:os')
  const path = await import('node:path')
  const ExifReader = (await import('exifreader')).default
  const tmp = path.join(os.tmpdir(), 'exif-jpeg-selftest.jpg')
  writeExifJpeg(tmp, '2026:05:16 14:32:08')
  const buf = fs.readFileSync(tmp)
  const tags = ExifReader.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const got = tags['DateTimeOriginal']?.description
  if (got !== '2026:05:16 14:32:08') {
    console.error('SELFTEST FAIL: got', JSON.stringify(got))
    process.exit(1)
  }
  console.log('SELFTEST OK: DateTimeOriginal =', got)
}
