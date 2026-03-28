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

test("validateHeaderOnlyChange passes for Kotlin header insert", () => {
  const before = "class MainActivity\n";
  const after = `/* @agentify
 * module: app
 * path: app/src/main/kotlin/MainActivity.kt
 * summary: Android entrypoint
 */

class MainActivity
`;

  const result = validateHeaderOnlyChange(before, after, "app/src/main/kotlin/MainActivity.kt", 80);
  assert.equal(result.passed, true);
});

test("applyHeaderToSource refreshes existing Swift header", () => {
  const source = `/* @agentify
 * module: App
 * path: App/AppDelegate.swift
 * summary: Old summary
 */

import Foundation
`;
  const header = renderHeader({
    moduleName: "App",
    summary: "Updated iOS entrypoint summary",
    relativePath: "App/AppDelegate.swift",
    stack: "dotnet"
  });
  const next = applyHeaderToSource(source, header);

  assert.match(next, /Updated iOS entrypoint summary/);
  assert.doesNotMatch(next, /Old summary/);
});

test("applyHeaderToSource refreshes header after a license block", () => {
  const source = `/* Copyright Example Corp */

/** @agentify
 * module: demo
 * path: src/demo.ts
 * summary: Old summary
 */

export const value = 1;
`;
  const header = renderHeader({
    moduleName: "demo",
    summary: "Fresh summary",
    relativePath: "src/demo.ts",
    stack: "ts"
  });

  const next = applyHeaderToSource(source, header);

  assert.match(next, /Copyright Example Corp/);
  assert.match(next, /Fresh summary/);
  assert.equal((next.match(/@agentify/g) || []).length, 1);
});

test("validateHeaderOnlyChange passes for header insert after a license block", () => {
  const before = `/* Copyright Example Corp */

export const value = 1;
`;
  const after = `/* Copyright Example Corp */

/** @agentify
 * module: demo
 * path: src/demo.ts
 * summary: Fresh summary
 */

export const value = 1;
`;

  const result = validateHeaderOnlyChange(before, after, "src/demo.ts", 80);
  assert.equal(result.passed, true);
});

test("applyHeaderToSource preserves CRLF line endings", () => {
  const source = "/* Copyright Example Corp */\r\n\r\nexport const value = 1;\r\n";
  const header = renderHeader({
    moduleName: "demo",
    summary: "CRLF summary",
    relativePath: "src/demo.ts",
    stack: "ts"
  });

  const next = applyHeaderToSource(source, header);

  assert.match(next, /\r\n/);
  assert.doesNotMatch(next, /[^\r]\nexport const value = 1;\n/);
  assert.equal(validateHeaderOnlyChange(source, next, "src/demo.ts", 80).passed, true);
});
