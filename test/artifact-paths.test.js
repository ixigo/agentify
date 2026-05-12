import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getLocalAgentifyRoot,
  getSharedAgentifyRoot,
  resolveAgentifyPath,
  resolveLocalAgentifyPath,
  resolveSharedAgentifyPath,
} from "../src/core/artifact-paths.js";
import { closeIndexDatabase, getIndexDbPath, getIndexSnapshot, openIndexDatabase } from "../src/core/db/connection.js";
import { acquireLock } from "../src/core/lock.js";
import { forkSession } from "../src/core/session.js";

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function writeLink(root, sharedProjectStore) {
  await fs.mkdir(path.join(root, ".agentify"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agentify", "link.json"),
    `${JSON.stringify({ shared_project_store: sharedProjectStore }, null, 2)}\n`,
    "utf8",
  );
}

test("artifact paths stay local for unlinked repositories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-artifacts-unlinked-"));

  assert.equal(getLocalAgentifyRoot(root), path.join(root, ".agentify"));
  assert.equal(getSharedAgentifyRoot(root), path.join(root, ".agentify"));
  assert.equal(resolveSharedAgentifyPath(root, "index.db"), path.join(root, ".agentify", "index.db"));
  assert.equal(resolveAgentifyPath(root, "runs", "run.json"), path.join(root, ".agentify", "runs", "run.json"));
});

test("linked artifact paths share durable store and keep volatile state local", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-artifacts-linked-"));
  const canonical = path.join(tempDir, "canonical");
  const linked = path.join(tempDir, "linked");
  const sharedStore = path.join(canonical, ".agentify");
  await fs.mkdir(linked, { recursive: true });
  await writeLink(linked, sharedStore);

  assert.equal(getSharedAgentifyRoot(linked), sharedStore);
  assert.equal(getIndexDbPath(linked), getIndexSnapshot(linked).path);
  assert.equal(getIndexDbPath(linked).startsWith(path.join(sharedStore, "indexes")), true);
  assert.equal(resolveAgentifyPath(linked, "cache", "manifest.json"), path.join(sharedStore, "cache", "manifest.json"));
  assert.equal(resolveAgentifyPath(linked, "modules", "auth.json"), path.join(sharedStore, "modules", "auth.json"));
  assert.equal(resolveAgentifyPath(linked, ".agentify"), path.join(linked, ".agentify"));
  assert.equal(resolveAgentifyPath(linked, "runs", "run.json"), path.join(linked, ".agentify", "runs", "run.json"));
  assert.equal(resolveAgentifyPath(linked, "session", "sess_a"), path.join(linked, ".agentify", "session", "sess_a"));
  assert.equal(resolveAgentifyPath(linked, "work", "scratch.md"), path.join(linked, ".agentify", "work", "scratch.md"));
  assert.equal(resolveAgentifyPath(linked, ".lock"), path.join(linked, ".agentify", ".lock"));
  assert.equal(resolveAgentifyPath(linked, "link.json"), path.join(linked, ".agentify", "link.json"));
  assert.equal(resolveLocalAgentifyPath(linked, "mempalace"), path.join(linked, ".agentify", "mempalace"));
});

test("linked index writes go to the shared store", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-index-linked-"));
  const canonical = path.join(tempDir, "canonical");
  const linked = path.join(tempDir, "linked");
  const sharedStore = path.join(canonical, ".agentify");
  await fs.mkdir(linked, { recursive: true });
  await writeLink(linked, sharedStore);

  const db = openIndexDatabase(linked);
  try {
    db.prepare("INSERT OR REPLACE INTO repo_meta (key, value_json) VALUES (?, ?)")
      .run("fixture", JSON.stringify("shared"));
  } finally {
    closeIndexDatabase(db);
  }

  assert.equal(await exists(getIndexSnapshot(linked).path), true);
  assert.equal(await exists(path.join(linked, ".agentify", "index.db")), false);
});

test("linked worktrees acquire independent local locks", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-locks-linked-"));
  const canonical = path.join(tempDir, "canonical");
  const linkedA = path.join(tempDir, "linked-a");
  const linkedB = path.join(tempDir, "linked-b");
  const sharedStore = path.join(canonical, ".agentify");
  await fs.mkdir(linkedA, { recursive: true });
  await fs.mkdir(linkedB, { recursive: true });
  await writeLink(linkedA, sharedStore);
  await writeLink(linkedB, sharedStore);

  const lockA = await acquireLock(linkedA, "scan");
  const lockB = await acquireLock(linkedB, "scan");

  try {
    assert.equal(lockA.acquired, true);
    assert.equal(lockB.acquired, true);
    assert.equal(await exists(path.join(linkedA, ".agentify", ".lock")), true);
    assert.equal(await exists(path.join(linkedB, ".agentify", ".lock")), true);
    assert.equal(await exists(path.join(sharedStore, ".lock")), false);
  } finally {
    await lockA.release();
    await lockB.release();
  }
});

test("linked sessions stay local to the current worktree", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-linked-"));
  const canonical = path.join(tempDir, "canonical");
  const linked = path.join(tempDir, "linked");
  const sharedStore = path.join(canonical, ".agentify");
  await fs.mkdir(linked, { recursive: true });
  await writeLink(linked, sharedStore);

  const result = await forkSession(linked, {
    provider: "local",
    session: { emitMarkdownArtifacts: false },
  });

  assert.equal(result.sessionDir.startsWith(path.join(linked, ".agentify", "session")), true);
  assert.equal(await exists(path.join(result.sessionDir, "session-manifest.json")), true);
  assert.equal(await exists(path.join(sharedStore, "session", result.sessionId, "session-manifest.json")), false);
});
