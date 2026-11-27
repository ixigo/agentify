import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { compareImages, decodePng, toLuminanceGrid } from "../src/core/png.js";
import { encodePng, rectPng, solidPng } from "./fixtures/png.js";

test("decodes an RGBA image written with every scanline filter", () => {
  // A gradient exercises all five filters meaningfully: with a flat image every
  // filter reconstructs trivially and a broken predictor would still pass.
  const sample = (x, y) => [(x * 7) & 0xff, (y * 11) & 0xff, (x * y) & 0xff, 255];
  for (const filter of [0, 1, 2, 3, 4]) {
    const image = decodePng(encodePng(9, 6, 4, sample, { filter }));
    assert.equal(image.width, 9, `filter ${filter}`);
    assert.equal(image.height, 6, `filter ${filter}`);
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        const index = (y * 9 + x) * 4;
        assert.deepEqual(
          [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]],
          sample(x, y),
          `filter ${filter} pixel ${x},${y}`,
        );
      }
    }
  }
});

test("normalizes grayscale and RGB images to RGBA with an opaque alpha", () => {
  const gray = decodePng(encodePng(2, 1, 1, () => [128]));
  assert.deepEqual([...gray.data.subarray(0, 4)], [128, 128, 128, 255]);

  const rgb = decodePng(encodePng(2, 1, 3, () => [10, 20, 30]));
  assert.deepEqual([...rgb.data.subarray(0, 4)], [10, 20, 30, 255]);

  const grayAlpha = decodePng(encodePng(2, 1, 2, () => [64, 32]));
  assert.deepEqual([...grayAlpha.data.subarray(0, 4)], [64, 64, 64, 32]);
});

test("rejects unsupported PNG variants with actionable messages", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /bad signature/);

  // Hand-build a palette PNG header: the encoder cannot emit color type 3.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13);
  const palette = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    length,
    Buffer.from("IHDR", "ascii"),
    ihdr,
    Buffer.alloc(4),
  ]);
  assert.throws(() => decodePng(palette), /palette PNGs are not supported/);
});

test("rejects a truncated image stream instead of returning a partial image", () => {
  const full = encodePng(8, 8, 4, () => [1, 2, 3, 4]);
  // Rebuild the IDAT with one scanline's worth of data missing.
  const short = zlib.deflateSync(Buffer.alloc(8 * 4 + 1));
  const idatStart = full.indexOf(Buffer.from("IDAT", "ascii")) - 4;
  const header = full.subarray(0, idatStart);
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(short.length);
  const truncated = Buffer.concat([
    header,
    lengthBuf,
    Buffer.from("IDAT", "ascii"),
    short,
    Buffer.alloc(4),
  ]);
  assert.throws(() => decodePng(truncated), /truncated/);
});

test("composites transparency over white so empty regions do not read as black", () => {
  const transparent = decodePng(solidPng(4, 4, [0, 0, 0, 0]));
  const white = decodePng(solidPng(4, 4, [255, 255, 255, 255]));
  const grid = toLuminanceGrid(transparent, 4);
  assert.ok(grid.every((value) => value > 0.99), "fully transparent should read as white");
  assert.equal(compareImages(white, transparent).structural_score, 1);
});

test("identical images score 1 on a pixel basis", () => {
  const image = decodePng(rectPng(40, 30, { x: 5, y: 5, width: 20, height: 10 }));
  const result = compareImages(image, image);
  assert.equal(result.basis, "pixel");
  assert.equal(result.score, 1);
  assert.equal(result.differing_pixels, 0);
  assert.equal(result.same_size, true);
});

test("pixel basis counts only differences beyond the tolerance", () => {
  const reference = decodePng(solidPng(10, 10, [100, 100, 100, 255]));
  // +5 per channel is inside the default tolerance; +80 is well outside it.
  const nudged = decodePng(solidPng(10, 10, [105, 105, 105, 255]));
  const shifted = decodePng(solidPng(10, 10, [180, 180, 180, 255]));

  assert.equal(compareImages(reference, nudged).score, 1);
  assert.equal(compareImages(reference, shifted).score, 0);
  assert.equal(compareImages(reference, shifted).differing_pixels, 100);
});

test("differently sized images fall back to a structural score", () => {
  const small = decodePng(rectPng(60, 60, { x: 10, y: 10, width: 30, height: 20 }));
  // The same layout at 2x: no pixel correspondence at all, but the structure
  // is identical, which is exactly what a Figma reference vs a render needs.
  const large = decodePng(rectPng(120, 120, { x: 20, y: 20, width: 60, height: 40 }));

  const result = compareImages(small, large);
  assert.equal(result.basis, "structural");
  assert.equal(result.same_size, false);
  assert.equal(result.pixel_score, null);
  assert.ok(result.score > 0.97, `expected a high structural score, got ${result.score}`);
  assert.equal(result.reference_size, "60x60");
  assert.equal(result.candidate_size, "120x120");
});

test("structural score drops when the layout actually moves", () => {
  const reference = decodePng(rectPng(80, 80, { x: 0, y: 0, width: 40, height: 80 }));
  const moved = decodePng(rectPng(160, 160, { x: 80, y: 0, width: 80, height: 160 }));

  const result = compareImages(reference, moved);
  assert.equal(result.basis, "structural");
  // A block that swapped sides should read as far from a match, not near it.
  assert.ok(result.score < 0.3, `expected a low structural score, got ${result.score}`);
});
