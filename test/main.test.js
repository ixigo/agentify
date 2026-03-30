import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, runCli } from "../src/main.js";

test("parseArgs normalizes dashed flags to camelCase", () => {
  const args = parseArgs([
    "doc",
    "--provider",
    "codex",
    "--module-concurrency",
    "6",
    "--max-files-per-module=12"
  ]);

  assert.equal(args.provider, "codex");
  assert.equal(args.moduleConcurrency, 6);
  assert.equal(args.maxFilesPerModule, 12);
});

test("parseArgs supports short help and version flags", () => {
  const args = parseArgs(["-h", "-V"]);
  assert.equal(args.help, true);
  assert.equal(args.version, true);
});

test("runCli rejects removed legacy command names", async () => {
  await assert.rejects(() => runCli(["update"]), /Use "up"/);
  await assert.rejects(() => runCli(["validate"]), /Use "check"/);
  await assert.rejects(() => runCli(["session"]), /Use "sess"/);
});

test("runCli rejects removed --tool flag", async () => {
  await assert.rejects(() => runCli(["scan", "--tool", "codex"]), /--tool was removed/);
});
