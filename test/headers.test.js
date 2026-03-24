import test from "node:test";
import assert from "node:assert/strict";

import { applyHeaderToSource, renderHeader } from "../src/core/headers.js";
import { validateHeaderOnlyChange } from "../src/core/validate.js";

test("applyHeaderToSource inserts a JSDoc header", () => {
  const source = "import { x } from './x';\n\nexport const y = x;\n";
  const header = renderHeader({
    moduleName: "demo",
    summary: "Demo summary",
    relativePath: "src/demo.ts",
    stack: "ts"
  });
  const next = applyHeaderToSource(source, header);

  assert.match(next, /@agentify/);
  assert.match(next, /import \{ x \}/);
});

test("validateHeaderOnlyChange passes for comment header insert", () => {
  const before = "import { x } from './x';\nexport const y = x;\n";
  const after = `/** @agentify
 * module: demo
 * path: src/demo.ts
 * summary: Demo summary
 */

import { x } from './x';
export const y = x;
`;

  const result = validateHeaderOnlyChange(before, after, "src/demo.ts", 80);
  assert.equal(result.passed, true);
});

test("validateHeaderOnlyChange fails for code change", () => {
  const before = "import { x } from './x';\nexport const y = x;\n";
  const after = "import { x } from './x';\nexport const y = 2;\n";

  const result = validateHeaderOnlyChange(before, after, "src/demo.ts", 80);
  assert.equal(result.passed, false);
});
