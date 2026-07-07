import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireLock, acquireProjectStoreLock } from "../src/core/lock.js";

test("acquireLock refuses to steal a stale lock from a live owner on the same host", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-lock-live-"));
  await fs.mkdir(path.join(root, ".agentify"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agentify", ".lock"),
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
  await fs.mkdir(path.join(root, ".agentify"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agentify", ".lock"),
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
  const lockData = JSON.parse(await fs.readFile(path.join(root, ".agentify", ".lock"), "utf8"));
  assert.equal(lockData.pid, process.pid);
  assert.equal(lockData.operation, "doc");
  await result.release();
  await assert.rejects(() => fs.access(path.join(root, ".agentify", ".lock")));
});

test("acquireLock reclaims a stale zero-byte lock left by an interrupted write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-lock-empty-"));
  const lockPath = path.join(root, ".agentify", ".lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "", "utf8");
  const staleTime = new Date(Date.now() - 301000);
  await fs.utimes(lockPath, staleTime, staleTime);

  const result = await acquireLock(root, "doc");

  assert.equal(result.acquired, true);
  const lockData = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(lockData.pid, process.pid);
  await result.release();
});

test("acquireLock reports a fresh unreadable lock as held instead of stealing it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-lock-fresh-empty-"));
  const lockPath = path.join(root, ".agentify", ".lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "", "utf8");

  const result = await acquireLock(root, "doc");

  assert.equal(result.acquired, false);
  assert.match(result.message, /unreadable/);
});

test("acquireLock leaves no temp files behind after acquire and release", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-lock-tmp-"));
  const result = await acquireLock(root, "doc");
  assert.equal(result.acquired, true);
  await result.release();

  const leftovers = (await fs.readdir(path.join(root, ".agentify")))
    .filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("acquireProjectStoreLock writes named shared-store lock files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-store-lock-"));
  const locksRoot = path.join(root, "locks");

  const first = await acquireProjectStoreLock({ locksRoot }, "index-refresh");
  assert.equal(first.acquired, true);
  const lockPath = path.join(locksRoot, "index.lock");
  const lockData = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(lockData.pid, process.pid);
  assert.equal(lockData.hostname, os.hostname());
  assert.equal(lockData.operation, "index-refresh");
  assert.ok(lockData.created_at);

  const second = await acquireProjectStoreLock({ locksRoot }, "index-refresh");
  assert.equal(second.acquired, false);
  assert.equal(second.holder.pid, process.pid);
  assert.match(second.message, /Lock held by PID/);

  await first.release();
  await assert.rejects(() => fs.access(lockPath));
});
