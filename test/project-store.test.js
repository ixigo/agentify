import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  computeRepoKey,
  describeLocalArtifacts,
  describeSharedArtifacts,
  getGitIdentity,
  resolveAgentifyPaths,
} from "../src/core/project-store.js";
import { linkProject } from "../src/core/link.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root, { commit = true } = {}) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  if (commit) {
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });
  }
}

async function mkTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("computeRepoKey is stable for the same inputs", () => {
  const a = computeRepoKey({ remote: "git@github.com:ixigo/agentify.git", commonDir: "/repo/.git" });
  const b = computeRepoKey({ remote: "git@github.com:ixigo/agentify.git", commonDir: "/repo/.git" });
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test("computeRepoKey differs for unrelated repos", () => {
  const a = computeRepoKey({ remote: "git@github.com:ixigo/agentify.git", commonDir: "/repo-a/.git" });
  const b = computeRepoKey({ remote: "git@github.com:ixigo/other.git", commonDir: "/repo-b/.git" });
  assert.notEqual(a, b);
});

test("getGitIdentity returns the same repo key across git worktrees", async () => {
  const parent = await mkTempDir("agentify-identity-");
  const primary = path.join(parent, "primary");
  const secondary = path.join(parent, "secondary");
  await fs.mkdir(primary, { recursive: true });
  await initGitRepo(primary);
  await execFileAsync("git", ["-C", primary, "worktree", "add", "-b", "branch-b", secondary]);

  const a = await getGitIdentity(primary);
  const b = await getGitIdentity(secondary);
  assert.ok(a, "primary identity should resolve");
  assert.ok(b, "secondary identity should resolve");
  assert.equal(a.repoKey, b.repoKey);
  assert.equal(a.commonDir, b.commonDir);
});

test("resolveAgentifyPaths returns local-only paths by default", async () => {
  const root = await mkTempDir("agentify-paths-local-");
  const paths = await resolveAgentifyPaths(root, {}, {});
  assert.equal(paths.mode, "local");
  assert.equal(paths.linked, false);
  assert.equal(paths.runtimeRoot, path.join(root, ".agentify"));
  assert.equal(paths.projectStore, path.join(root, ".agentify"));
  assert.equal(paths.indexDb, path.join(root, ".agentify", "index.db"));
  assert.equal(paths.sessionRoot, path.join(root, ".agentify", "session"));
});

test("resolveAgentifyPaths uses shared store when configured", async () => {
  const parent = await mkTempDir("agentify-paths-shared-");
  const root = path.join(parent, "repo");
  await fs.mkdir(root, { recursive: true });
  await initGitRepo(root);

  const sharedBase = path.join(parent, "shared");
  const paths = await resolveAgentifyPaths(
    root,
    { runtime: { store: "shared", sharedStorePath: sharedBase } },
    {},
  );
  assert.equal(paths.mode, "shared");
  assert.equal(paths.linked, false);
  assert.ok(paths.repoKey, "repo key should be populated in shared mode");
  assert.equal(paths.projectStore, path.join(sharedBase, paths.repoKey));
  assert.equal(paths.indexDb, path.join(sharedBase, paths.repoKey, "index.db"));
  // Local artifacts still live under the worktree.
  assert.equal(paths.runsRoot, path.join(root, ".agentify", "runs"));
  assert.equal(paths.sessionRoot, path.join(root, ".agentify", "session"));
});

test("resolveAgentifyPaths honors env var overrides over config", async () => {
  const parent = await mkTempDir("agentify-paths-env-");
  const root = path.join(parent, "repo");
  await fs.mkdir(root, { recursive: true });
  await initGitRepo(root);

  const envBase = path.join(parent, "env-shared");
  const paths = await resolveAgentifyPaths(
    root,
    { runtime: { store: "local" } },
    { AGENTIFY_RUNTIME_STORE: "shared", AGENTIFY_SHARED_STORE_PATH: envBase },
  );
  assert.equal(paths.mode, "shared");
  assert.equal(paths.projectStore, path.join(envBase, paths.repoKey));
});

test("resolveAgentifyPaths falls back to local mode outside a git repo", async () => {
  const root = await mkTempDir("agentify-paths-nogit-");
  const paths = await resolveAgentifyPaths(root, { runtime: { store: "shared" } }, {});
  assert.equal(paths.mode, "local");
  assert.equal(paths.projectStore, path.join(root, ".agentify"));
});

test("AGENTIFY_DISABLE_LINK ignores an existing link.json", async () => {
  const parent = await mkTempDir("agentify-paths-disable-");
  const root = path.join(parent, "repo");
  await fs.mkdir(path.join(root, ".agentify"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".agentify", "link.json"),
    JSON.stringify({
      schema_version: 2,
      kind: "agentify-linked-project",
      project_store: path.join(parent, "shared", "deadbeef"),
      git_common_dir: "/fake/.git",
      git_remote: "",
      repo_key: "deadbeef",
    }),
    "utf8",
  );

  const honored = await resolveAgentifyPaths(root, {}, {});
  assert.equal(honored.linked, true);
  assert.equal(honored.mode, "shared");

  const disabled = await resolveAgentifyPaths(root, {}, { AGENTIFY_DISABLE_LINK: "1" });
  assert.equal(disabled.linked, false);
  assert.equal(disabled.mode, "local");
});

test("link --auto writes a v2 link.json and store metadata", async () => {
  const parent = await mkTempDir("agentify-link-auto-");
  const root = path.join(parent, "repo");
  const sharedBase = path.join(parent, "shared");
  await fs.mkdir(root, { recursive: true });
  await initGitRepo(root);

  const result = await linkProject(root, {
    auto: true,
    config: { runtime: { sharedStorePath: sharedBase } },
    env: {},
  });

  assert.equal(result.mode, "auto");
  assert.equal(result.linked, true);
  assert.equal(result.changed, true);
  assert.equal(result.project_store, path.join(sharedBase, result.repo_key));

  const linkPath = path.join(await fs.realpath(root), ".agentify", "link.json");
  const link = JSON.parse(await fs.readFile(linkPath, "utf8"));
  assert.equal(link.schema_version, 2);
  assert.equal(link.kind, "agentify-linked-project");
  assert.equal(link.project_store, result.project_store);
  assert.equal(link.repo_key, result.repo_key);
  assert.ok(link.created_at);

  const storeMetaPath = path.join(result.project_store, "store.json");
  const storeMeta = JSON.parse(await fs.readFile(storeMetaPath, "utf8"));
  assert.equal(storeMeta.kind, "agentify-project-store");
  assert.equal(storeMeta.repo_key, result.repo_key);
  assert.ok(storeMeta.last_used_at);
});

test("link --auto in two worktrees of the same repo resolves the same project store", async () => {
  const parent = await mkTempDir("agentify-link-auto-share-");
  const primary = path.join(parent, "primary");
  const secondary = path.join(parent, "secondary");
  const sharedBase = path.join(parent, "shared");
  await fs.mkdir(primary, { recursive: true });
  await initGitRepo(primary);
  await execFileAsync("git", ["-C", primary, "worktree", "add", "-b", "task-b", secondary]);

  const a = await linkProject(primary, {
    auto: true,
    config: { runtime: { sharedStorePath: sharedBase } },
    env: {},
  });
  const b = await linkProject(secondary, {
    auto: true,
    config: { runtime: { sharedStorePath: sharedBase } },
    env: {},
  });

  assert.equal(a.project_store, b.project_store);
  assert.equal(a.repo_key, b.repo_key);

  // Local runtime roots remain per-worktree.
  const pathsA = await resolveAgentifyPaths(primary, {}, {});
  const pathsB = await resolveAgentifyPaths(secondary, {}, {});
  assert.notEqual(pathsA.sessionRoot, pathsB.sessionRoot);
  assert.equal(pathsA.indexDb, pathsB.indexDb);
});

test("link --status reports link mode and presence", async () => {
  const parent = await mkTempDir("agentify-link-status-");
  const root = path.join(parent, "repo");
  const sharedBase = path.join(parent, "shared");
  await fs.mkdir(root, { recursive: true });
  await initGitRepo(root);

  const before = await linkProject(root, { status: true, config: {}, env: {} });
  assert.equal(before.mode, "status");
  assert.equal(before.linked, false);
  assert.equal(before.runtime_mode, "local");

  await linkProject(root, {
    auto: true,
    config: { runtime: { sharedStorePath: sharedBase } },
    env: {},
  });

  const after = await linkProject(root, { status: true, config: {}, env: {} });
  assert.equal(after.linked, true);
  assert.equal(after.runtime_mode, "shared");
  assert.ok(after.store_meta);
  assert.equal(after.shared_artifacts.includes("index.db"), true);
  assert.equal(after.local_artifacts.includes("session"), true);
});

test("link --auto outside a git repo throws a clear error", async () => {
  const root = await mkTempDir("agentify-link-nogit-");
  await assert.rejects(
    () => linkProject(root, { auto: true, config: {}, env: {} }),
    /not inside a Git repository/i,
  );
});

test("describe helpers expose stable artifact categories", () => {
  assert.deepEqual(describeSharedArtifacts(), ["index.db", "cache", "semantic", "context", "repo-map", "embeddings"]);
  assert.deepEqual(describeLocalArtifacts(), ["runs", "session", "work", "tmp"]);
});
