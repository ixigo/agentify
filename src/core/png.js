// Minimal PNG reader and image comparison for the loop's visual gate.
//
// Agentify cannot take a Playwright or image-codec dependency: `capture.mjs`
// loads Playwright from the *target* repo, and the visual gate has to score
// screenshots in this process. So this module decodes exactly the PNG subset
// browsers emit — 8-bit, non-interlaced, grayscale/RGB with or without alpha —
// using only node:zlib, and refuses anything else with a clear message instead
// of guessing.
//
// Two scores come out of a comparison, because two very different questions get
// asked of the same gate:
// - Same dimensions (before/after regression, or a reference captured at the
//   gate's own viewport): an exact per-pixel diff is meaningful.
// - Different dimensions (a Figma node picture vs a rendered page): pixels do
//   not correspond at all, so the only honest signal is structural — luminance
//   downsampled to a fixed grid, which tracks layout, mass, and contrast while
//   ignoring resolution. It is a similarity heuristic, not a pixel oracle, and
//   the gate reports it as such.

import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Channel count per PNG color type (index = color type). Types 3 (palette) and
// the undefined slots are unsupported and rejected during decode.
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

// Structural comparison grid. 64x64 keeps layout structure (columns, blocks,
// spacing) while discarding text antialiasing and sub-pixel noise that would
// otherwise dominate the score.
export const STRUCTURAL_GRID = 64;

function fail(message) {
  throw new Error(`PNG decode failed: ${message}`);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Reverse the per-scanline filters (PNG spec 9.2) in place over the inflated
// stream, returning tightly packed samples with the filter bytes removed.
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.allocUnsafe(stride * height);
  let rawOffset = 0;
  let outOffset = 0;

  for (let row = 0; row < height; row += 1) {
    if (rawOffset >= raw.length) {
      fail(`truncated image data at row ${row} of ${height}`);
    }
    const filter = raw[rawOffset];
    rawOffset += 1;
    if (rawOffset + stride > raw.length) {
      fail(`truncated scanline ${row} (expected ${stride} bytes)`);
    }

    const prevOffset = outOffset - stride;
    for (let index = 0; index < stride; index += 1) {
      const value = raw[rawOffset + index];
      // Left neighbour and upper neighbour, both zero outside the image.
      const left = index >= channels ? out[outOffset + index - channels] : 0;
      const up = row > 0 ? out[prevOffset + index] : 0;
      const upLeft = row > 0 && index >= channels ? out[prevOffset + index - channels] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: return fail(`unknown scanline filter ${filter} on row ${row}`);
      }
      out[outOffset + index] = restored & 0xff;
    }
    rawOffset += stride;
    outOffset += stride;
  }
  return out;
}

// Decode a PNG buffer into normalized RGBA samples.
// Returns { width, height, data } where data is width*height*4 bytes.
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    fail("not a PNG file (bad signature)");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  let offset = 8;
  let sawIhdr = false;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      fail(`chunk ${type} claims ${length} bytes but the file ends early`);
    }

    if (type === "IHDR") {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const interlace = buf[dataStart + 12];
      if (width <= 0 || height <= 0) {
        fail(`invalid dimensions ${width}x${height}`);
      }
      if (bitDepth !== 8) {
        fail(`unsupported bit depth ${bitDepth} (only 8-bit is supported; re-export the reference as an 8-bit PNG)`);
      }
      if (!CHANNELS_BY_COLOR_TYPE[colorType]) {
        fail(`unsupported color type ${colorType}${colorType === 3 ? " (palette PNGs are not supported; re-export as RGB or RGBA)" : ""}`);
      }
      if (interlace !== 0) {
        fail("interlaced PNGs are not supported; re-export without Adam7 interlacing");
      }
      sawIhdr = true;
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!sawIhdr) {
    fail("no IHDR chunk");
  }
  if (idat.length === 0) {
    fail("no IDAT image data");
  }

  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat));
  } catch (error) {
    fail(`image data could not be inflated (${error.message})`);
  }
  const samples = unfilter(inflated, width, height, channels);

  // Normalize every supported color type to RGBA so callers never branch.
  const data = Buffer.allocUnsafe(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const src = pixel * channels;
    const dst = pixel * 4;
    if (channels === 1 || channels === 2) {
      const gray = samples[src];
      data[dst] = gray;
      data[dst + 1] = gray;
      data[dst + 2] = gray;
      data[dst + 3] = channels === 2 ? samples[src + 1] : 0xff;
    } else {
      data[dst] = samples[src];
      data[dst + 1] = samples[src + 1];
      data[dst + 2] = samples[src + 2];
      data[dst + 3] = channels === 4 ? samples[src + 3] : 0xff;
    }
  }

  return { width, height, data };
}

// Rec. 601 luma, composited over white. Screenshots of transparent regions
// otherwise read as black and manufacture huge differences against a reference
// captured on an opaque background.
function luminance(data, index) {
  const alpha = data[index + 3] / 255;
  const r = data[index] * alpha + 255 * (1 - alpha);
  const g = data[index + 1] * alpha + 255 * (1 - alpha);
  const b = data[index + 2] * alpha + 255 * (1 - alpha);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Box-average an image down to size x size normalized luminance samples.
// Averaging (rather than nearest-neighbour sampling) is what makes the result
// resolution-independent: a 2x-scaled render of the same layout maps onto the
// same grid.
export function toLuminanceGrid(image, size = STRUCTURAL_GRID) {
  const grid = new Float64Array(size * size);
  for (let gy = 0; gy < size; gy += 1) {
    const y0 = Math.floor((gy * image.height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * image.height) / size));
    for (let gx = 0; gx < size; gx += 1) {
      const x0 = Math.floor((gx * image.width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * image.width) / size));
      let total = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < image.height; y += 1) {
        for (let x = x0; x < x1 && x < image.width; x += 1) {
          total += luminance(image.data, (y * image.width + x) * 4);
          count += 1;
        }
      }
      grid[gy * size + gx] = count > 0 ? total / count : 0;
    }
  }
  return grid;
}

// Fraction of pixels whose RGB distance stays within tolerance. Only defined
// for identically sized images.
function pixelScore(a, b, tolerance) {
  const total = a.width * a.height;
  let differing = 0;
  for (let index = 0; index < total * 4; index += 4) {
    const dr = a.data[index] - b.data[index];
    const dg = a.data[index + 1] - b.data[index + 1];
    const db = a.data[index + 2] - b.data[index + 2];
    const da = a.data[index + 3] - b.data[index + 3];
    // Squared distance across RGBA against a squared tolerance — no sqrt in
    // the inner loop over what can be millions of pixels.
    if (dr * dr + dg * dg + db * db + da * da > tolerance * tolerance) {
      differing += 1;
    }
  }
  return { score: total > 0 ? 1 - differing / total : 0, differing_pixels: differing, total_pixels: total };
}

/**
 * Compare two decoded PNGs.
 *
 * `score` is the number the gate thresholds on: the exact pixel score when the
 * images are the same size, the structural score otherwise. `basis` says which
 * one it was, so a report never presents a heuristic as a pixel measurement.
 */
export function compareImages(reference, candidate, { tolerance = 12, grid = STRUCTURAL_GRID } = {}) {
  const sameSize = reference.width === candidate.width && reference.height === candidate.height;

  const referenceGrid = toLuminanceGrid(reference, grid);
  const candidateGrid = toLuminanceGrid(candidate, grid);
  let absolute = 0;
  for (let index = 0; index < referenceGrid.length; index += 1) {
    absolute += Math.abs(referenceGrid[index] - candidateGrid[index]);
  }
  const structural = 1 - absolute / referenceGrid.length;

  const pixel = sameSize ? pixelScore(reference, candidate, tolerance) : null;

  return {
    basis: sameSize ? "pixel" : "structural",
    score: Number((sameSize ? pixel.score : structural).toFixed(4)),
    structural_score: Number(structural.toFixed(4)),
    pixel_score: pixel ? Number(pixel.score.toFixed(4)) : null,
    differing_pixels: pixel ? pixel.differing_pixels : null,
    total_pixels: pixel ? pixel.total_pixels : null,
    reference_size: `${reference.width}x${reference.height}`,
    candidate_size: `${candidate.width}x${candidate.height}`,
    same_size: sameSize,
  };
}
