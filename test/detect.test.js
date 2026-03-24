import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectModules, detectStacks } from "../src/core/detect.js";

async function withTempDir(setup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-detect-"));
  await setup(root);
  return root;
}

test("detectStacks identifies TypeScript repo", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "src", "index.ts"), "export const ok = true;\n");
  });

  const stacks = await detectStacks(root, { languages: "auto" });
  assert.equal(stacks[0].name, "ts");
});

test("detectModules uses src subfolders for TS modules", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.mkdir(path.join(dir, "src", "auth"), { recursive: true });
    await fs.mkdir(path.join(dir, "src", "payments"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "auth", "index.ts"), "export {};\n");
    await fs.writeFile(path.join(dir, "src", "payments", "index.ts"), "export {};\n");
  });

  const modules = await detectModules(root, { moduleStrategy: "auto" }, "ts");
  assert.deepEqual(
    modules.map((item) => item.rootPath).sort(),
    ["src/auth", "src/payments"]
  );
});

test("detectModules identifies Python package modules", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname='demo'\n");
    await fs.mkdir(path.join(dir, "src", "demo"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "demo", "__init__.py"), "\n");
  });

  const modules = await detectModules(root, { moduleStrategy: "auto" }, "python");
  assert.equal(modules[0].rootPath, "src/demo");
});
