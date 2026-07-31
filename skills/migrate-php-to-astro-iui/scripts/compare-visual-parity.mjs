#!/usr/bin/env node

/**
 * Compare two capture-visual-spec.mjs outputs and fail when the migrated
 * route is not a pixel-exact reproduction of the reference.
 *
 * Two independent signals are reported per viewport:
 *   1. Pixel diff of the full-page screenshots (decoded in Chromium, so no
 *      extra npm dependency beyond the Playwright the capture already needs).
 *   2. Structural diff of geometry and computed styles for every matched
 *      element, plus missing/extra content.
 */

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function usage() {
  return `Usage:
  node compare-visual-parity.mjs --reference <dir> --candidate <dir> --out <dir>

Options:
  --reference <dir>        Directory produced by capture-visual-spec.mjs (legacy)
  --candidate <dir>        Directory produced by capture-visual-spec.mjs (migrated)
  --out <dir>              Where to write the report and diff images
  --pixel-threshold <pct>  Max mismatching pixels, percent. Default: 0.20
  --color-tolerance <n>    Per-channel tolerance for pixel diff, 0-255. Default: 8
  --box-tolerance <px>     Max geometry delta per edge/size. Default: 1
  --ignore-props <list>    Comma-separated computed properties to skip
  --allow-missing <n>      Max unmatched reference elements. Default: 0
  --json                   Print the JSON report to stdout
`;
}

const LENGTH_PROPERTIES = new Set([
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "gap",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
]);

const COLOR_PROPERTIES = new Set([
  "color",
  "backgroundColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
]);

// fontFamily stacks differ textually while resolving to the same face; the
// pixel diff is the authority there, so compare only the first family.
const FIRST_TOKEN_PROPERTIES = new Set(["fontFamily"]);

function parseColor(value) {
  const match = /rgba?\(([^)]+)\)/.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }
  return {
    r: parts[0],
    g: parts[1],
    b: parts[2],
    a: parts.length > 3 ? parts[3] : 1,
  };
}

function parseLength(value) {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value || "").trim());
  return match ? Number.parseFloat(match[1]) : null;
}

function firstToken(value) {
  return String(value || "")
    .split(",")[0]
    .replace(/["']/g, "")
    .trim()
    .toLowerCase();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Elements worth asserting on. Pure layout wrappers are covered by the pixel
 * diff; asserting on them would only produce noise from differing DOM shapes.
 */
function isAnchorable(element) {
  if (element.role === "image" || element.role === "control") {
    return true;
  }
  return normalizeText(element.text).length > 0;
}

function signatureOf(element) {
  if (element.role === "image") {
    return `image|${path.basename(String(element.src || "").split("?")[0])}`;
  }
  if (element.role === "control") {
    return `control|${element.inputType || ""}|${normalizeText(element.placeholder)}`;
  }
  return `${element.role}|${normalizeText(element.text)}`;
}

function indexBySignature(elements) {
  const index = new Map();
  for (const element of elements) {
    if (!isAnchorable(element)) {
      continue;
    }
    const signature = signatureOf(element);
    if (!index.has(signature)) {
      index.set(signature, []);
    }
    index.get(signature).push(element);
  }
  return index;
}

function compareStyles(reference, candidate, tolerances, ignored) {
  const differences = [];
  for (const property of Object.keys(reference.styles || {})) {
    if (ignored.has(property)) {
      continue;
    }
    const expected = reference.styles[property];
    const actual = candidate.styles?.[property];
    if (expected === actual) {
      continue;
    }

    if (COLOR_PROPERTIES.has(property)) {
      const left = parseColor(expected);
      const right = parseColor(actual);
      if (left && right) {
        const transparent = (color) => color.a === 0;
        if (transparent(left) && transparent(right)) {
          continue;
        }
        const delta = Math.max(
          Math.abs(left.r - right.r),
          Math.abs(left.g - right.g),
          Math.abs(left.b - right.b),
        );
        if (delta <= tolerances.color && Math.abs(left.a - right.a) <= 0.02) {
          continue;
        }
      }
    }

    if (LENGTH_PROPERTIES.has(property)) {
      const left = parseLength(expected);
      const right = parseLength(actual);
      if (left !== null && right !== null && Math.abs(left - right) <= tolerances.length) {
        continue;
      }
    }

    if (FIRST_TOKEN_PROPERTIES.has(property)) {
      if (firstToken(expected) === firstToken(actual)) {
        continue;
      }
    }

    differences.push({ property, expected, actual: actual ?? null });
  }
  return differences;
}

function compareBoxes(reference, candidate, tolerance) {
  const differences = [];
  for (const key of ["x", "y", "width", "height"]) {
    const delta = Math.abs(reference.box[key] - candidate.box[key]);
    if (delta > tolerance) {
      differences.push({
        property: `box.${key}`,
        expected: reference.box[key],
        actual: candidate.box[key],
        delta: Math.round(delta * 100) / 100,
      });
    }
  }
  return differences;
}

async function loadChromium() {
  for (const specifier of ["@playwright/test", "playwright", "playwright-core"]) {
    try {
      const module = await import(specifier);
      const chromium = module.chromium || module.default?.chromium;
      if (chromium) {
        return chromium;
      }
    } catch {
      // Try the next specifier.
    }
  }
  return null;
}

async function pixelDiff(chromium, referencePng, candidatePng, diffPath, colorTolerance) {
  const [referenceData, candidateData] = await Promise.all([
    fs.readFile(referencePng),
    fs.readFile(candidatePng),
  ]);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(
      async ({ left, right, tolerance }) => {
        const toBitmap = async (base64) => {
          const response = await fetch(`data:image/png;base64,${base64}`);
          const blob = await response.blob();
          return createImageBitmap(blob);
        };

        const [a, b] = await Promise.all([toBitmap(left), toBitmap(right)]);
        const width = Math.max(a.width, b.width);
        const height = Math.max(a.height, b.height);

        const draw = (bitmap) => {
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext("2d");
          context.fillStyle = "#ff00ff";
          context.fillRect(0, 0, width, height);
          context.drawImage(bitmap, 0, 0);
          return context.getImageData(0, 0, width, height);
        };

        const imageA = draw(a);
        const imageB = draw(b);
        const diffCanvas = new OffscreenCanvas(width, height);
        const diffContext = diffCanvas.getContext("2d");
        const diffImage = diffContext.createImageData(width, height);

        let mismatched = 0;
        for (let index = 0; index < imageA.data.length; index += 4) {
          const dr = Math.abs(imageA.data[index] - imageB.data[index]);
          const dg = Math.abs(imageA.data[index + 1] - imageB.data[index + 1]);
          const db = Math.abs(imageA.data[index + 2] - imageB.data[index + 2]);
          const da = Math.abs(imageA.data[index + 3] - imageB.data[index + 3]);
          const differs = Math.max(dr, dg, db, da) > tolerance;
          if (differs) {
            mismatched += 1;
            diffImage.data[index] = 255;
            diffImage.data[index + 1] = 0;
            diffImage.data[index + 2] = 0;
            diffImage.data[index + 3] = 255;
          } else {
            const grey = Math.round(
              (imageA.data[index] + imageA.data[index + 1] + imageA.data[index + 2]) / 3,
            );
            const faded = Math.round(255 - (255 - grey) * 0.15);
            diffImage.data[index] = faded;
            diffImage.data[index + 1] = faded;
            diffImage.data[index + 2] = faded;
            diffImage.data[index + 3] = 255;
          }
        }

        diffContext.putImageData(diffImage, 0, 0);
        const diffBlob = await diffCanvas.convertToBlob({ type: "image/png" });
        const buffer = await diffBlob.arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let index = 0; index < bytes.length; index += 1) {
          binary += String.fromCharCode(bytes[index]);
        }

        return {
          width,
          height,
          referenceSize: { width: a.width, height: a.height },
          candidateSize: { width: b.width, height: b.height },
          mismatchedPixels: mismatched,
          totalPixels: width * height,
          mismatchPercent: Math.round((mismatched / (width * height)) * 1000000) / 10000,
          diffBase64: btoa(binary),
        };
      },
      {
        left: referenceData.toString("base64"),
        right: candidateData.toString("base64"),
        tolerance: colorTolerance,
      },
    );

    await fs.writeFile(diffPath, Buffer.from(result.diffBase64, "base64"));
    delete result.diffBase64;
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === "true" || !args.reference || !args.candidate || !args.out) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = args.help === "true" ? 0 : 1;
    return;
  }

  const referenceDir = path.resolve(args.reference);
  const candidateDir = path.resolve(args.candidate);
  const outputDir = path.resolve(args.out);
  const pixelThreshold = Number(args["pixel-threshold"] || 0.2);
  const colorTolerance = Number(args["color-tolerance"] || 8);
  const boxTolerance = Number(args["box-tolerance"] || 1);
  const allowMissing = Number(args["allow-missing"] || 0);
  const ignored = new Set(
    (args["ignore-props"] && args["ignore-props"] !== "true" ? args["ignore-props"] : "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  const referenceSpec = JSON.parse(
    await fs.readFile(path.join(referenceDir, "visual-spec.json"), "utf8"),
  );
  const candidateSpec = JSON.parse(
    await fs.readFile(path.join(candidateDir, "visual-spec.json"), "utf8"),
  );

  await fs.mkdir(outputDir, { recursive: true });
  const chromium = await loadChromium();

  const report = {
    generatedAt: new Date().toISOString(),
    reference: { dir: referenceDir, url: referenceSpec.url, label: referenceSpec.label },
    candidate: { dir: candidateDir, url: candidateSpec.url, label: candidateSpec.label },
    thresholds: { pixelThreshold, colorTolerance, boxTolerance, allowMissing },
    viewports: [],
    verdict: "pass",
  };

  for (const referenceViewport of referenceSpec.viewports) {
    const key = `${referenceViewport.width}x${referenceViewport.height}`;
    const candidateViewport = candidateSpec.viewports.find(
      (entry) => `${entry.width}x${entry.height}` === key,
    );

    if (!candidateViewport) {
      report.viewports.push({ viewport: key, status: "missing-candidate-capture" });
      report.verdict = "fail";
      continue;
    }

    const entry = { viewport: key, status: "pass", failures: [] };

    if (chromium) {
      entry.pixel = await pixelDiff(
        chromium,
        path.join(referenceDir, referenceViewport.screenshot),
        path.join(candidateDir, candidateViewport.screenshot),
        path.join(outputDir, `diff-${key}.png`),
        colorTolerance,
      );
      entry.pixel.diffImage = path.join(outputDir, `diff-${key}.png`);
      if (entry.pixel.mismatchPercent > pixelThreshold) {
        entry.failures.push(
          `pixel mismatch ${entry.pixel.mismatchPercent}% exceeds ${pixelThreshold}%`,
        );
      }
      const heightDelta = Math.abs(
        entry.pixel.referenceSize.height - entry.pixel.candidateSize.height,
      );
      if (heightDelta > 2) {
        entry.failures.push(
          `full-page height differs by ${heightDelta}px (${entry.pixel.referenceSize.height} vs ${entry.pixel.candidateSize.height})`,
        );
      }
    } else {
      entry.pixel = { status: "skipped", reason: "Playwright unavailable" };
      entry.failures.push("pixel diff not run: install Playwright to enable it");
    }

    const candidateIndex = indexBySignature(candidateViewport.elements);
    const consumed = new Map();
    const elementFindings = [];
    let matched = 0;
    let missing = 0;

    for (const referenceElement of referenceViewport.elements) {
      if (!isAnchorable(referenceElement)) {
        continue;
      }
      const signature = signatureOf(referenceElement);
      const bucket = candidateIndex.get(signature) || [];
      const cursor = consumed.get(signature) || 0;
      const candidateElement = bucket[cursor];

      if (!candidateElement) {
        missing += 1;
        elementFindings.push({
          kind: "missing",
          signature,
          referencePath: referenceElement.path,
          text: referenceElement.text,
          box: referenceElement.box,
        });
        continue;
      }

      consumed.set(signature, cursor + 1);
      matched += 1;

      const differences = [
        ...compareBoxes(referenceElement, candidateElement, boxTolerance),
        ...compareStyles(
          referenceElement,
          candidateElement,
          { color: colorTolerance, length: 0.5 },
          ignored,
        ),
      ];

      if (differences.length > 0) {
        elementFindings.push({
          kind: "diff",
          signature,
          referencePath: referenceElement.path,
          candidatePath: candidateElement.path,
          text: referenceElement.text,
          differences,
        });
      }
    }

    let extra = 0;
    for (const [signature, bucket] of candidateIndex) {
      const used = consumed.get(signature) || 0;
      if (bucket.length > used) {
        extra += bucket.length - used;
        for (const element of bucket.slice(used)) {
          elementFindings.push({
            kind: "extra",
            signature,
            candidatePath: element.path,
            text: element.text,
            box: element.box,
          });
        }
      }
    }

    entry.elements = {
      referenceAnchorable: matched + missing,
      matched,
      missing,
      extra,
      mismatched: elementFindings.filter((finding) => finding.kind === "diff").length,
    };

    if (missing > allowMissing) {
      entry.failures.push(`${missing} reference element(s) missing from the candidate`);
    }
    if (entry.elements.mismatched > 0) {
      entry.failures.push(
        `${entry.elements.mismatched} element(s) differ in geometry or computed style`,
      );
    }
    if (referenceViewport.hasHorizontalOverflow !== candidateViewport.hasHorizontalOverflow) {
      entry.failures.push("horizontal overflow behavior differs");
    }
    if (referenceViewport.truncated || candidateViewport.truncated) {
      entry.failures.push(
        "element capture was truncated by --max-elements; raise the cap before trusting this result",
      );
    }

    if (entry.failures.length > 0) {
      entry.status = "fail";
      report.verdict = "fail";
    }

    const findingsPath = path.join(outputDir, `findings-${key}.json`);
    await fs.writeFile(
      findingsPath,
      `${JSON.stringify(elementFindings, null, 2)}\n`,
      "utf8",
    );
    entry.findingsFile = findingsPath;
    entry.topFindings = elementFindings.slice(0, 25);

    report.viewports.push(entry);
  }

  const reportPath = path.join(outputDir, "visual-parity.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (args.json === "true") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const viewport of report.viewports) {
      const pixel =
        viewport.pixel && typeof viewport.pixel.mismatchPercent === "number"
          ? `${viewport.pixel.mismatchPercent}% pixels`
          : "pixel diff skipped";
      const elements = viewport.elements
        ? `${viewport.elements.matched} matched, ${viewport.elements.mismatched} mismatched, ${viewport.elements.missing} missing, ${viewport.elements.extra} extra`
        : "no element data";
      process.stdout.write(`${viewport.viewport}: ${viewport.status} — ${pixel}; ${elements}\n`);
      for (const failure of viewport.failures || []) {
        process.stdout.write(`  - ${failure}\n`);
      }
    }
    process.stdout.write(`verdict: ${report.verdict}\nreport: ${reportPath}\n`);
  }

  if (report.verdict !== "pass") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
