import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

interface QrMatrix {
  addData(data: string): void
  make(): void
  getModuleCount(): number
  isDark(row: number, col: number): boolean
}

const QRCodeCtor = require('qrcode-terminal/vendor/QRCode/index.js') as new (
  typeNumber: number,
  errorCorrectLevel: number,
) => QrMatrix
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js') as {
  L: number
  M: number
  Q: number
  H: number
}

/**
 * Renders any QR payload to a crisp, self-contained `data:image/svg+xml` URI
 * suitable for displaying directly in browser modals.
 */
export function renderQrSvgDataUrl(payload: string): string {
  const qr = new QRCodeCtor(-1, QRErrorCorrectLevel.M)
  qr.addData(payload)
  qr.make()
  const count = qr.getModuleCount()
  const margin = 2
  const size = count + margin * 2
  const parts: string[] = []
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) {
        parts.push(`M${c + margin},${r + margin}h1v1h-1z`)
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${parts.join('')}" fill="#111827"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function crc32Png(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]!
    for (let b = 0; b < 8; b += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcInput = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32Png(crcInput), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * Generates a valid 512x512 RGBA PNG icon in pure Node.js (zero native canvas
 * or filesystem asset dependencies) for automatic Lark app icon upload.
 */
export function generateDefaultBotIconPng(): Buffer {
  const width = 512
  const height = 512
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * stride
    raw[rowOffset] = 0 // filter: None
    const ty = y / (height - 1)
    for (let x = 0; x < width; x += 1) {
      const tx = x / (width - 1)
      const mix = (tx * 0.55 + ty * 0.45)
      // Clean slate-to-indigo gradient background with centered geometric robot badge
      let r = Math.round(24 + mix * 28)
      let g = Math.round(32 + mix * 44)
      let b = Math.round(52 + mix * 86)

      const dx = Math.abs(x - 256)
      const dy = Math.abs(y - 268)
      // Rounded head frame
      const inHead = dx <= 128 && dy <= 104 && (dx <= 100 || dy <= 76 || (dx - 100) ** 2 + (dy - 76) ** 2 <= 28 ** 2)
      const inInner = dx <= 106 && dy <= 82 && (dx <= 84 || dy <= 60 || (dx - 84) ** 2 + (dy - 60) ** 2 <= 22 ** 2)
      // Antenna stem + tip
      const inStem = dx <= 10 && y >= 112 && y <= 168
      const inTip = (x - 256) ** 2 + (y - 100) ** 2 <= 22 ** 2
      // Eyes + smile bar
      const inLeftEye = (x - 206) ** 2 + (y - 254) ** 2 <= 20 ** 2
      const inRightEye = (x - 306) ** 2 + (y - 254) ** 2 <= 20 ** 2
      const inMouth = dx <= 48 && y >= 304 && y <= 320

      if ((inHead && !inInner) || inStem || inTip || inLeftEye || inRightEye || inMouth) {
        r = 246
        g = 248
        b = 252
      }

      const px = rowOffset + 1 + x * 4
      raw[px] = r
      raw[px + 1] = g
      raw[px + 2] = b
      raw[px + 3] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const compressed = deflateSync(raw, { level: 6 })
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    magic,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
