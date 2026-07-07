import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { installHooks, syncManagedHooks } from "../src/core/hooks.js";

const execFileAsync = promisify(execFile);

function fileMode(mode) {
  return mode & 0o777;
}

test("installHooks writes a valid post-merge refresh command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-"));
  await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });

  const result = await installHooks(root);
  assert.deepEqual(result, { installed: ["pre-commit", "post-merge"], removed: [] });

  const postMerge = await fs.readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");
  assert.match(postMerge, /Refreshes the repository index after merge/);
  assert.match(postMerge, /agentify scan --json >\/dev\/null 2>&1 \|\| true/);
  assert.doesNotMatch(postMerge, /agentify doc/);
  assert.doesNotMatch(postMerge, /--skip-finalize/);
});

test("installed post-merge hook refreshes only the scan index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-run-"));
  const hooksDir = path.join(root, ".git", "hooks");
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-bin-"));
  const logPath = path.join(root, "hook.log");
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "agentify"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$AGENTIFY_HOOK_LOG\"\n", "utf8");
  await fs.chmod(path.join(binDir, "agentify"), 0o755);

  await installHooks(root);
  await execFileAsync(path.join(hooksDir, "post-merge"), [], {
    cwd: root,
    env: {
      ...process.env,
      AGENTIFY_HOOK_LOG: logPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  const calls = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  assert.deepEqual(calls, [
    "scan --json",
  ]);
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
  await fs.chmod(path.join(hooksDir, "post-merge"), 0o700);

  const result = await installHooks(root, { preCommit: true, postMerge: false });

  assert.deepEqual(result, { installed: ["pre-commit"], removed: ["post-merge"] });
  const preCommit = await fs.readFile(path.join(hooksDir, "pre-commit"), "utf8");
  const postMerge = await fs.readFile(path.join(hooksDir, "post-merge"), "utf8");
  assert.match(preCommit, /agentify check --hook/);
  assert.equal(postMerge, "#!/bin/sh\ncustom merge step\n");
  assert.equal(fileMode((await fs.stat(path.join(hooksDir, "post-merge"))).mode), 0o700);
});

test("syncManagedHooks preserves mode when pruning disabled managed hook content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-hooks-"));
  const hooksDir = path.join(root, ".git", "hooks");
  const hookPath = path.join(hooksDir, "pre-commit");
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(
    hookPath,
    "#!/bin/sh\ncustom pre-commit step\n\n# @agentify pre-commit hook\nagentify check\n",
    "utf8",
  );
  await fs.chmod(hookPath, 0o710);

  const result = await syncManagedHooks(root, { settings: { preCommit: false, postMerge: true } });

  assert.equal(result.results.find((item) => item.name === "pre-commit")?.status, "removed_disabled");
  assert.equal(await fs.readFile(hookPath, "utf8"), "#!/bin/sh\ncustom pre-commit step\n");
  assert.equal(fileMode((await fs.stat(hookPath)).mode), 0o710);
});
