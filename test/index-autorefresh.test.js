import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { maybeRefreshStaleIndex } from "../src/core/cli-ctx.js";
import { getHeadTree } from "../src/core/git.js";
import { resolveAgentifyPaths } from "../src/core/project-store.js";
import { writeJson } from "../src/core/fs.js";

const execFileAsync = promisify(execFile);

// A tiny real git repo with a placeholder index.db and index.meta.json. The
// refresh decision only stats index.db and reads index.meta.json, so the index
// file can be empty — no scan is ever run (spawn is injected and recorded).
async function makeRepo({ indexedTree, withIndex = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-autorefresh-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Tester"], { cwd: root });
  await fs.writeFile(path.join(root, "file.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  const paths = await resolveAgentifyPaths(root, {});
  if (withIndex) {
    await fs.mkdir(path.dirname(paths.indexDb), { recursive: true });
    await fs.writeFile(paths.indexDb, "", "utf8");
    const tree = indexedTree === "HEAD" ? await getHeadTree(root) : indexedTree;
    await writeJson(paths.indexMetaPath, { indexed_tree: tree });
  }
  return { root, paths };
}

function recordingSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {} };
  };
  return { spawn, calls };
}

test("spawns an index-only background scan when the index is stale relative to HEAD", async () => {
  const { root } = await makeRepo({ indexedTree: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  try {
    const { spawn, calls } = recordingSpawn();
    const child = await maybeRefreshStaleIndex(root, {}, { spawn });
    assert.ok(child, "expected a spawned child");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(1), ["scan", "--index-only", "--root", root]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, "ignore");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not refresh when the index already covers the current HEAD tree", async () => {
  const { root } = await makeRepo({ indexedTree: "HEAD" });
  try {
    const { spawn, calls } = recordingSpawn();
    const child = await maybeRefreshStaleIndex(root, {}, { spawn });
    assert.equal(child, null);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("never builds an index where none exists (no uninvited first scan)", async () => {
  const { root } = await makeRepo({ withIndex: false });
  try {
    const { spawn, calls } = recordingSpawn();
    const child = await maybeRefreshStaleIndex(root, {}, { spawn });
    assert.equal(child, null);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("config index.refreshOnStart:false disables the background refresh", async () => {
  const { root } = await makeRepo({ indexedTree: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  try {
    const { spawn, calls } = recordingSpawn();
    const child = await maybeRefreshStaleIndex(root, { index: { refreshOnStart: false } }, { spawn });
    assert.equal(child, null);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not refresh outside a git work tree (no HEAD to compare against)", async () => {
  // A directory with an index but no git repo: getHeadTree yields the "nogit"
  // sentinel, so staleness relative to HEAD cannot be assessed.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-autorefresh-nogit-"));
  try {
    const paths = await resolveAgentifyPaths(root, {});
    await fs.mkdir(path.dirname(paths.indexDb), { recursive: true });
    await fs.writeFile(paths.indexDb, "", "utf8");
    await writeJson(paths.indexMetaPath, { indexed_tree: "sometree" });
    const { spawn, calls } = recordingSpawn();
    const child = await maybeRefreshStaleIndex(root, {}, { spawn });
    assert.equal(child, null);
    assert.equal(calls.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
