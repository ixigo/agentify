import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/main.js";

async function setupBlockedRepo(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, ".agents"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agents", ".lock"),
    JSON.stringify({
      pid: process.pid,
      operation: "scan",
      acquired_at: Date.now(),
      host: os.hostname(),
    }),
    "utf8",
  );
  return root;
}

function captureStdout(fn) {
  return async () => {
    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => {
      captured.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
    };
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await fn(captured);
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
    }
  };
}

test("runCli scan exits non-zero and emits a blocked JSON payload when the lock is held", captureStdout(async (captured) => {
  const root = await setupBlockedRepo("agentify-scan-blocked-");

  await runCli(["scan", "--root", root, "--json"]);

  assert.equal(process.exitCode, 1, "scan should exit non-zero on lock contention");

  const dbExists = await fs.access(path.join(root, ".agents", "index.db")).then(() => true).catch(() => false);
  assert.equal(dbExists, false, "scan must not write the index when blocked");

  const payloads = captured
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const blocked = payloads.find((value) => value && value.status === "blocked");
  assert.ok(blocked, "scan should emit a structured JSON payload on contention");
  assert.equal(blocked.command, "scan");
  assert.equal(blocked.reason, "lock_contention");
  assert.equal(blocked.phase, "scan");
  assert.ok(blocked.holder, "blocked payload should include the lock holder");
  assert.match(blocked.message, /Lock held by PID/);
}));

test("runCli doc exits non-zero and emits a blocked JSON payload when the lock is held", captureStdout(async (captured) => {
  const root = await setupBlockedRepo("agentify-doc-blocked-");

  await runCli(["doc", "--root", root, "--json"]);

  assert.equal(process.exitCode, 1, "doc should exit non-zero on lock contention");

  const payloads = captured
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const blocked = payloads.find((value) => value && value.status === "blocked");
  assert.ok(blocked, "doc should emit a structured JSON payload on contention");
  assert.equal(blocked.command, "doc");
  assert.equal(blocked.reason, "lock_contention");
  assert.equal(blocked.phase, "doc");
}));

test("runCli up exits non-zero, reports the blocked phase, and does not claim scan completion", captureStdout(async (captured) => {
  const root = await setupBlockedRepo("agentify-up-blocked-");

  await runCli(["up", "--root", root, "--json"]);

  assert.equal(process.exitCode, 1, "up should exit non-zero when scan is blocked");

  const allOutput = captured.join("\n");
  assert.ok(
    !/scan complete/.test(allOutput),
    "up must not log 'scan complete' when scan was skipped due to a held lock",
  );

  const payloads = captured
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const blocked = payloads.find((value) => value && value.status === "blocked");
  assert.ok(blocked, "up should emit a structured JSON payload on contention");
  assert.equal(blocked.command, "up");
  assert.equal(blocked.reason, "lock_contention");
  assert.equal(blocked.blocked_phase, "scan");
  assert.ok(blocked.holder, "up blocked payload should include the lock holder");
}));
