import fs from "node:fs";
import path from "node:path";

export function compareRgba(before, after, { width, height, beforeSize, afterSize, tolerance = 10 }) {
  const out = new Uint8ClampedArray(width * height * 4);
  let changed = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const inBefore = x < beforeSize.width && y < beforeSize.height;
      const inAfter = x < afterSize.width && y < afterSize.height;
      const b = inBefore ? (y * beforeSize.width + x) * 4 : -1;
      const a = inAfter ? (y * afterSize.width + x) * 4 : -1;
      const br = b >= 0 ? before[b] : 255, bg = b >= 0 ? before[b + 1] : 255, bb = b >= 0 ? before[b + 2] : 255;
      const ar = a >= 0 ? after[a] : 255, ag = a >= 0 ? after[a + 1] : 255, ab = a >= 0 ? after[a + 2] : 255;
      const delta = Math.max(Math.abs(br - ar), Math.abs(bg - ag), Math.abs(bb - ab));
      if (delta > tolerance) {
        changed += 1;
        out[index] = 255;
        out[index + 1] = 45;
        out[index + 2] = 85;
      } else {
        const gray = (ar * 0.3 + ag * 0.59 + ab * 0.11);
        const faded = 255 - (255 - gray) * 0.25;
        out[index] = faded;
        out[index + 1] = faded;
        out[index + 2] = faded;
      }
      out[index + 3] = 255;
    }
  }
  return { changed, data: out };
}

const BROWSER_DIFF = `async ({ before, after, tolerance }) => {
  const load = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("could not decode screenshot"));
    image.src = src;
  });
  const [left, right] = await Promise.all([load(before), load(after)]);
  const width = Math.max(left.naturalWidth, right.naturalWidth);
  const height = Math.max(left.naturalHeight, right.naturalHeight);
  const pixels = (image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const compare = ${compareRgba.toString()};
  const result = compare(pixels(left), pixels(right), {
    width, height, tolerance,
    beforeSize: { width: left.naturalWidth, height: left.naturalHeight },
    afterSize: { width: right.naturalWidth, height: right.naturalHeight },
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(result.data, width, height), 0, 0);
  return {
    changed: result.changed, width, height,
    beforeHeight: left.naturalHeight, afterHeight: right.naturalHeight,
    png: canvas.toDataURL("image/png").split(",")[1],
  };
}`;

export function createDiffer(browser, { tolerance = 10, dpr = 1 } = {}) {
  let pagePromise = null;
  let queue = Promise.resolve();
  const getPage = () => {
    pagePromise ??= browser.newContext().then((context) => context.newPage());
    return pagePromise;
  };
  const toDataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  async function diff(beforeFile, afterFile, outFile) {
    const page = await getPage();
    const result = await page.evaluate(`(${BROWSER_DIFF})(${JSON.stringify({ before: toDataUrl(beforeFile), after: toDataUrl(afterFile), tolerance })})`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, Buffer.from(result.png, "base64"));
    return {
      ratio: result.changed / (result.width * result.height),
      changedPixels: result.changed,
      heightBefore: result.beforeHeight / dpr,
      heightAfter: result.afterHeight / dpr,
    };
  }
  return {
    diff(beforeFile, afterFile, outFile) {
      const run = queue.then(() => diff(beforeFile, afterFile, outFile));
      queue = run.catch(() => {});
      return run;
    },
    async close() {
      if (pagePromise) await (await pagePromise).context().close().catch(() => {});
    },
  };
}
