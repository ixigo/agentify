import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectTestCommand } from "../src/core/project-tests.js";

test("detectTestCommand prefers the declared package manager", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-command-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@9.0.0",
    scripts: {
      test: "vitest run",
    },
  }, null, 2));

  const result = await detectTestCommand(root);

  assert.deepEqual(result, { command: "pnpm", args: ["test"] });
});

test("detectTestCommand falls back to lockfile detection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-test-lockfile-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "jest",
    },
  }, null, 2));
  await fs.writeFile(path.join(root, "yarn.lock"), "");

  const result = await detectTestCommand(root);

  assert.deepEqual(result, { command: "yarn", args: ["test"] });
});
