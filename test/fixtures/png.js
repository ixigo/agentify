// Minimal PNG encoder for tests. src/core/png.js only decodes (nothing in the
// product writes PNGs), so fixtures need an independent writer — otherwise the
// decoder would only ever be tested against its own output.
//
// Not picked up by `node --test test/*.test.js`: this file is a helper, not a
// suite.

import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encode raw samples as an 8-bit PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} channels 1 (gray), 2 (gray+alpha), 3 (RGB), or 4 (RGBA)
 * @param {(x: number, y: number) => number[]} sample returns `channels` bytes
 * @param {{ filter?: number }} options scanline filter to emit (0-4)
 */
export function encodePng(width, height, channels, sample, { filter = 0 } = {}) {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  if (colorType === undefined) {
    throw new Error(`unsupported channel count ${channels}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  // Unfiltered samples, kept alongside so the filters below can reference the
  // previous scanline's *reconstructed* bytes exactly as a decoder would.
  const flat = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bytes = sample(x, y);
      for (let c = 0; c < channels; c += 1) {
        flat[y * stride + x * channels + c] = bytes[c] & 0xff;
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = filter;
    for (let index = 0; index < stride; index += 1) {
      const value = flat[y * stride + index];
      const left = index >= channels ? flat[y * stride + index - channels] : 0;
      const up = y > 0 ? flat[(y - 1) * stride + index] : 0;
      const upLeft = y > 0 && index >= channels ? flat[(y - 1) * stride + index - channels] : 0;
      let encoded;
      switch (filter) {
        case 0: encoded = value; break;
        case 1: encoded = value - left; break;
        case 2: encoded = value - up; break;
        case 3: encoded = value - ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          encoded = value - predictor;
          break;
        }
        default: throw new Error(`unsupported filter ${filter}`);
      }
      raw[rowStart + 1 + index] = encoded & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Flat single-colour RGBA image. */
export function solidPng(width, height, [r, g, b, a = 255]) {
  return encodePng(width, height, 4, () => [r, g, b, a]);
}

/** RGBA image with a filled rectangle over a white ground — a crude "layout". */
export function rectPng(width, height, rect, colour = [20, 20, 20, 255]) {
  return encodePng(width, height, 4, (x, y) => (
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
      ? colour
      : [255, 255, 255, 255]
  ));
}
