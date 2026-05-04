import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installHooks } from "../src/core/hooks.js";

test("installHooks writes a valid post-merge refresh command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-"));
  await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });

  const result = await installHooks(root);
  assert.deepEqual(result, { installed: ["pre-commit", "post-merge"], removed: [] });

  const postMerge = await fs.readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");
  assert.match(postMerge, /agentify scan --json >\/dev\/null 2>&1 \|\| true/);
  assert.doesNotMatch(postMerge, /--skip-finalize/);
});

test("installHooks writes a hook-friendly pre-commit body", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-"));
  await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });

  await installHooks(root);

  const preCommit = await fs.readFile(path.join(root, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(preCommit, /agentify check --hook/);
});

test("installHooks upgrades a legacy managed pre-commit body in place", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-"));
  const hooksDir = path.join(root, ".git", "hooks");
  await fs.mkdir(hooksDir, { recursive: true });

  const legacy = "#!/bin/sh\n# @agentify pre-commit hook\n# Validates freshness and safety before commit\nagentify check\n";
  await fs.writeFile(path.join(hooksDir, "pre-commit"), legacy);

  const { installed } = await installHooks(root);

  assert.ok(installed.includes("pre-commit"), "pre-commit should be reported as updated");
  const next = await fs.readFile(path.join(hooksDir, "pre-commit"), "utf8");
  assert.match(next, /agentify check --hook/);
  assert.doesNotMatch(next, /^agentify check\s*$/m);
});

test("installHooks skips disabled hooks and removes managed disabled hooks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-"));
  const hooksDir = path.join(root, ".git", "hooks");
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(
    path.join(hooksDir, "post-merge"),
    "#!/bin/sh\ncustom merge step\n\n# @agentify post-merge hook\nagentify scan\n",
    "utf8",
  );

  const result = await installHooks(root, { preCommit: true, postMerge: false });

  assert.deepEqual(result, { installed: ["pre-commit"], removed: ["post-merge"] });
  const preCommit = await fs.readFile(path.join(hooksDir, "pre-commit"), "utf8");
  const postMerge = await fs.readFile(path.join(hooksDir, "post-merge"), "utf8");
  assert.match(preCommit, /agentify check --hook/);
  assert.equal(postMerge, "#!/bin/sh\ncustom merge step\n");
});
