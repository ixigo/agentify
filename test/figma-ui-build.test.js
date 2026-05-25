import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeNodeId,
  parseFigmaUrl,
} from "../skills/figma-ui-build/scripts/figma-ui-build.mjs";

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
