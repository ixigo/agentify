import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  normalizeNodeId,
  parseFigmaUrl,
} from "../skills/figma-ui-build/scripts/figma-ui-build.mjs";

const execFileAsync = promisify(execFile);
const helperPath = path.resolve("skills/figma-ui-build/scripts/figma-ui-build.mjs");

test("parseFigmaUrl supports design URLs with hyphen node IDs", () => {
  const result = parseFigmaUrl("https://www.figma.com/design/qIfekFRB75vg5pzmMXBvvH/App?node-id=9786-23492&t=abc");

  assert.equal(result.fileKey, "qIfekFRB75vg5pzmMXBvvH");
  assert.equal(result.nodeId, "9786:23492");
});

test("parseFigmaUrl supports file URLs with encoded colon node IDs", () => {
  const result = parseFigmaUrl("https://www.figma.com/file/qIfekFRB75vg5pzmMXBvvH/App?node-id=9786%3A23492");

  assert.equal(result.fileKey, "qIfekFRB75vg5pzmMXBvvH");
  assert.equal(result.nodeId, "9786:23492");
});

test("normalizeNodeId keeps colon format and normalizes hyphen format", () => {
  assert.equal(normalizeNodeId("9786:23492"), "9786:23492");
  assert.equal(normalizeNodeId("9786-23492"), "9786:23492");
  assert.equal(normalizeNodeId("9786%3A23492"), "9786:23492");
});

test("helper uses supplied reference image and raw node without Figma API", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figma-ui-build-"));
  const output = path.join(root, "run");
  const referenceImage = path.join(root, "node.png");
  const rawNodePath = path.join(root, "node.json");
  const figmaUrl = "https://www.figma.com/design/qIfekFRB75vg5pzmMXBvvH/App?node-id=9786-23492";

  await fs.writeFile(referenceImage, "placeholder");
  await fs.writeFile(rawNodePath, `${JSON.stringify({
    nodes: {
      "9786:23492": {
        document: {
          name: "Primary Button",
          type: "FRAME",
          absoluteBoundingBox: { width: 120, height: 44 },
          layoutMode: "HORIZONTAL",
          itemSpacing: 8,
          paddingTop: 10,
          paddingRight: 16,
          paddingBottom: 10,
          paddingLeft: 16,
          fills: [{ type: "SOLID", color: { r: 0, g: 0.2, b: 0.8, a: 1 } }],
          children: [{
            name: "Label",
            type: "TEXT",
            characters: "Continue",
            style: {
              fontFamily: "Inter",
              fontSize: 16,
              fontWeight: 600,
              lineHeightPx: 20,
            },
            fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
          }],
        },
      },
    },
  }, null, 2)}\n`);

  const { stdout } = await execFileAsync("node", [
    helperPath,
    figmaUrl,
    "--project-root",
    root,
    "--output",
    output,
    "--reference-image",
    referenceImage,
    "--raw-node",
    rawNodePath,
    "--dry-run",
  ]);

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.figmaNodeSource, "raw-node");
  assert.equal(path.basename(result.referenceScreenshot), "reference.png");

  const spec = JSON.parse(await fs.readFile(path.join(output, "figma-spec.json"), "utf8"));
  assert.equal(spec.referenceImagePath, "reference.png");
  assert.equal(spec.visibleText[0], "Continue");

  const payload = JSON.parse(await fs.readFile(path.join(output, "ui-eval-input.json"), "utf8"));
  assert.equal(payload.referenceScreenshot, path.join(output, "reference.png"));
  assert.equal(payload.figmaScreenshot, path.join(output, "reference.png"));
});
