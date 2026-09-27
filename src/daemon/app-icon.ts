import { deflateSync } from "zlib"

// --- Phone app icon ---
//
// Home screens need PNGs (iOS ignores SVG touch icons, and Chrome wants a
// 192 and a 512 for installability). Drawn here rather than shipped as
// binary files so the zero-build dashboard stays text-only: a full-bleed
// brand-blue square (safe for "maskable" crops) with a white dot inside the
// central safe zone.

const BG = [0x29, 0x79, 0xff] // --ax-blue
const FG = [0xff, 0xff, 0xff]

const cache = new Map<number, Buffer>()

export function appIconPng(size: number): Buffer {
  let png = cache.get(size)
  if (!png) {
    png = encodePng(size, drawIcon(size))
    cache.set(size, png)
  }
  return png
}

function drawIcon(size: number): Buffer {
  // One filter byte (0 = none) per row, then RGB pixels.
  const row = 1 + size * 3
  const raw = Buffer.alloc(row * size)
  const c = size / 2
  const r = size * 0.22
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c
      const dy = y + 0.5 - c
      const color = dx * dx + dy * dy <= r * r ? FG : BG
      raw.set(color, y * row + 1 + x * 3)
    }
  }
  return raw
}

function encodePng(size: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
