import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireLock } from "../src/core/lock.js";

test("acquireLock refuses to steal a stale lock from a live owner on the same host", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-lock-live-"));
  await fs.mkdir(path.join(root, ".agents"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agents", ".lock"),
    JSON.stringify({
      pid: process.pid,
      operation: "scan",
      acquired_at: Date.now() - 301000,
      host: os.hostname(),
    }),
    "utf8",
  );

  const result = await acquireLock(root, "doc");

  assert.equal(result.acquired, false);
  assert.equal(result.holder.pid, process.pid);
  assert.match(result.message, /Lock held by PID/);
});

test("acquireLock reclaims a stale lock when the recorded owner is gone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-lock-dead-"));
  await fs.mkdir(path.join(root, ".agents"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agents", ".lock"),
    JSON.stringify({
      pid: 2147483647,
      operation: "scan",
      acquired_at: Date.now() - 301000,
      host: os.hostname(),
    }),
    "utf8",
  );

  const result = await acquireLock(root, "doc");

  assert.equal(result.acquired, true);
  const lockData = JSON.parse(await fs.readFile(path.join(root, ".agents", ".lock"), "utf8"));
  assert.equal(lockData.pid, process.pid);
  assert.equal(lockData.operation, "doc");
  await result.release();
  await assert.rejects(() => fs.access(path.join(root, ".agents", ".lock")));
});
