import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isProcessAlive,
  killChildProcess,
  runCommandCapture,
  runGit,
} from "../src/core/utils/exec-helpers.js";

test("runCommandCapture captures stdout, stderr, exit code, and input", async () => {
  const result = await runCommandCapture([
    process.execPath,
    "-e",
    "process.stdin.on('data', (chunk) => process.stdout.write(chunk)); process.stderr.write('warn');",
  ], { input: "hello" });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warn");
  assert.equal(result.missing, false);
});

test("runCommandCapture reports missing commands without throwing", async () => {
  const result = await runCommandCapture(["agentify-missing-command-for-test"]);

  assert.equal(result.code, 127);
  assert.equal(result.missing, true);
  assert.match(result.stderr, /command not found/);
});

test("runGit supports throwing, null-on-error, and custom failure messages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-utils-git-"));
  await fs.writeFile(path.join(root, "README.md"), "test\n", "utf8");
  await runGit(root, ["init"]);

  assert.match(await runGit(root, ["rev-parse", "--show-toplevel"]), /agentify-utils-git-/);
  assert.equal(await runGit(path.join(root, "missing"), ["rev-parse", "--show-toplevel"], { nullOnError: true }), null);
  await assert.rejects(
    runGit(path.join(root, "missing"), ["rev-parse", "--show-toplevel"], { failureMessage: "not a worktree" }),
    /not a worktree/,
  );
});

test("process helpers report current process and ignore already-ended children", async () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);

  const result = await runCommandCapture([process.execPath, "-e", ""]);
  assert.equal(result.code, 0);

  killChildProcess({ kill() {} }, "SIGTERM");
});
