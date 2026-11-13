import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { runCleanArtifacts, runCleanGlobal } from "../src/core/cleanup.js";
import {
  agentifyOwnedNames,
  classifyEntry,
  measureStore,
  dirStats,
  formatBytes,
  FULL_BUDGET,
} from "../src/core/store-size.js";
import { STORE_KIND } from "../src/core/project-store.js";

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFileWithMtime(targetPath, contents, daysAgo = 0) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents);
  if (daysAgo > 0) {
    const when = new Date(Date.now() - (daysAgo * 86400000));
    await fs.utimes(targetPath, when, when);
  }
}

async function pathExists(targetPath) {
  return fs.lstat(targetPath).then(() => true).catch(() => false);
}

test("measureStore classifies top-level entries and sorts by size, largest first", async () => {
  const root = await tempDir("agentify-size-");
  const store = path.join(root, ".agentify");
  // agentify-owned
  await writeFileWithMtime(path.join(store, "context", "events.jsonl"), "x".repeat(100));
  await writeFileWithMtime(path.join(store, "index.db"), "y".repeat(50));
  // known skill artifact
  await writeFileWithMtime(path.join(store, "ui-eval", "task-a", "after.png"), "z".repeat(4000));
  // unknown
  await writeFileWithMtime(path.join(store, "harness", "big.bin"), "w".repeat(8000));

  const result = await measureStore(store, { ownedNames: agentifyOwnedNames(root) });
  assert.equal(result.exists, true);
  assert.equal(result.truncated, false);

  const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
  assert.equal(byName.context.kind, "agentify");
  assert.equal(byName["index.db"].kind, "agentify");
  assert.equal(byName["ui-eval"].kind, "skill-artifact");
  assert.equal(byName.harness.kind, "unknown");

  assert.equal(byName.harness.sizeBytes, 8000);
  assert.equal(byName["ui-eval"].sizeBytes, 4000);
  assert.equal(result.totalBytes, 100 + 50 + 4000 + 8000);
  // Largest first.
  assert.equal(result.entries[0].name, "harness");
  assert.equal(result.entries[1].name, "ui-eval");
});

test("classifyEntry labels owned, known-artifact, and unknown names", () => {
  const owned = agentifyOwnedNames(".");
  assert.equal(classifyEntry("context", owned), "agentify");
  assert.equal(classifyEntry("index.db", owned), "agentify");
  assert.equal(classifyEntry("ui-eval", owned), "skill-artifact");
  assert.equal(classifyEntry("visual", owned), "unknown"); // not referenced on this branch
  assert.equal(classifyEntry("whatever", owned), "unknown");
});

test("store-size threshold warning boundary is total vs cleanup.warnStoreSizeMb", async () => {
  const root = await tempDir("agentify-threshold-");
  const store = path.join(root, ".agentify");
  await writeFileWithMtime(path.join(store, "harness", "big.bin"), "b".repeat(2 * 1024 * 1024));

  const config = await loadConfig(root, {});
  const measured = await measureStore(store, { ownedNames: agentifyOwnedNames(root) });

  const warnBytesHigh = (config.cleanup.warnStoreSizeMb ?? 500) * 1024 * 1024;
  assert.equal(measured.totalBytes > warnBytesHigh, false); // 2 MB under the 500 MB default

  const warnBytesLow = 1 * 1024 * 1024; // 1 MB threshold
  assert.equal(measured.totalBytes > warnBytesLow, true); // 2 MB store trips it
});

test("runCleanArtifacts: dry-run reports, --yes deletes aged ui-eval task dirs, unknown never deleted", async () => {
  const root = await tempDir("agentify-artifacts-");
  const store = path.join(root, ".agentify");
  // old task dir (newest file 30 days old) -> reclaimable
  await writeFileWithMtime(path.join(store, "ui-eval", "old-task", "after.png"), "a".repeat(1000), 30);
  // fresh task dir (file written now) -> kept
  await writeFileWithMtime(path.join(store, "ui-eval", "fresh-task", "after.png"), "b".repeat(1000), 0);
  // unknown directory -> reported, never deleted
  await writeFileWithMtime(path.join(store, "harness", "big.bin"), "c".repeat(5000), 0);

  const config = await loadConfig(root, {});
  config.cleanup.artifactMaxAgeDays = 14;

  // Dry-run
  const dry = await runCleanArtifacts(root, config, { apply: false });
  assert.equal(dry.apply, false);
  assert.equal(dry.removed, 0);
  assert.equal(dry.reclaimable_bytes, 1000);
  const dryStale = dry.groups.flatMap((g) => g.items.filter((i) => i.stale)).map((i) => i.path);
  assert.deepEqual(dryStale, [".agentify/ui-eval/old-task"]);
  assert.ok(dry.unknown.some((u) => u.path === ".agentify/harness"));
  // Nothing deleted in dry-run
  assert.equal(await pathExists(path.join(store, "ui-eval", "old-task")), true);

  // Apply
  const applied = await runCleanArtifacts(root, config, { apply: true });
  assert.equal(applied.removed, 1);
  assert.equal(applied.reclaimable_bytes, 1000);
  assert.equal(await pathExists(path.join(store, "ui-eval", "old-task")), false);
  assert.equal(await pathExists(path.join(store, "ui-eval", "fresh-task")), true);
  // Unknown directory still present after apply.
  assert.equal(await pathExists(path.join(store, "harness")), true);
});

test("runCleanGlobal classifies shared-cache stores and never deletes unrecognised entries", async () => {
  const base = await tempDir("agentify-global-");
  const liveRepoGitDir = await tempDir("agentify-live-repo-");

  // store whose repo is gone (git_common_dir missing)
  await writeFileWithMtime(
    path.join(base, "repo-gone", "store.json"),
    JSON.stringify({ kind: STORE_KIND, git_common_dir: "/nope/does/not/exist/.git", git_remote: "r1", last_used_at: new Date().toISOString() }),
  );
  await writeFileWithMtime(path.join(base, "repo-gone", "index.db"), "x".repeat(1000));

  // store unused for >90 days (repo still exists)
  await writeFileWithMtime(
    path.join(base, "repo-old", "store.json"),
    JSON.stringify({ kind: STORE_KIND, git_common_dir: liveRepoGitDir, git_remote: "r2", last_used_at: new Date(Date.now() - 200 * 86400000).toISOString() }),
  );
  await writeFileWithMtime(path.join(base, "repo-old", "index.db"), "y".repeat(2000));

  // fresh store (repo exists, recently used)
  await writeFileWithMtime(
    path.join(base, "repo-fresh", "store.json"),
    JSON.stringify({ kind: STORE_KIND, git_common_dir: liveRepoGitDir, git_remote: "r3", last_used_at: new Date().toISOString() }),
  );
  await writeFileWithMtime(path.join(base, "repo-fresh", "index.db"), "z".repeat(3000));

  // unrecognised: a file and a dir without a valid store.json
  await writeFileWithMtime(path.join(base, "invocations.json"), "{}");
  await writeFileWithMtime(path.join(base, "git-analyze", "cache.json"), "{}");

  const config = await loadConfig(base, {});
  const env = { AGENTIFY_SHARED_STORE_PATH: base };

  const dry = await runCleanGlobal(config, { apply: false }, env);
  assert.equal(dry.base, base);
  const byName = Object.fromEntries(dry.stores.map((s) => [s.name, s]));
  assert.equal(byName["repo-gone"].stale, true);
  assert.equal(byName["repo-gone"].reason, "repo gone");
  assert.equal(byName["repo-old"].stale, true);
  assert.match(byName["repo-old"].reason, /^unused/);
  assert.equal(byName["repo-fresh"].stale, false);
  assert.equal(byName["repo-fresh"].reason, "active");

  const unrec = dry.unrecognized.map((u) => u.name).sort();
  assert.deepEqual(unrec, ["git-analyze", "invocations.json"]);
  assert.equal(dry.removed, 0);

  // Apply: only the two stale stores deleted; fresh + unrecognised untouched.
  const applied = await runCleanGlobal(config, { apply: true }, env);
  assert.equal(applied.removed, 2);
  assert.equal(await pathExists(path.join(base, "repo-gone")), false);
  assert.equal(await pathExists(path.join(base, "repo-old")), false);
  assert.equal(await pathExists(path.join(base, "repo-fresh")), true);
  assert.equal(await pathExists(path.join(base, "invocations.json")), true);
  assert.equal(await pathExists(path.join(base, "git-analyze")), true);
});

test("symlink safety: a symlink inside a store is not followed for size nor deleted through", async () => {
  const root = await tempDir("agentify-symlink-");
  const outside = await tempDir("agentify-outside-");
  await writeFileWithMtime(path.join(outside, "secret.bin"), "s".repeat(10000), 60);

  const store = path.join(root, ".agentify");
  await fs.mkdir(path.join(store, "ui-eval"), { recursive: true });
  // A real aged task dir alongside the symlink.
  await writeFileWithMtime(path.join(store, "ui-eval", "real-task", "after.png"), "r".repeat(500), 60);
  // Symlink inside ui-eval pointing to an outside directory.
  await fs.symlink(outside, path.join(store, "ui-eval", "linked-task"), "dir");
  // Symlink at the store top level pointing outside.
  await fs.symlink(outside, path.join(store, "linky"), "dir");

  // measureStore: the outside tree is NOT counted (symlinks skipped).
  const measured = await measureStore(store, { ownedNames: agentifyOwnedNames(root) });
  const linky = measured.entries.find((e) => e.name === "linky");
  assert.equal(linky.isSymlink, true);
  assert.equal(linky.sizeBytes, 0);
  const uiEval = measured.entries.find((e) => e.name === "ui-eval");
  // ui-eval size is only the real task dir, not the symlinked outside tree.
  assert.equal(uiEval.sizeBytes, 500);

  const config = await loadConfig(root, {});
  config.cleanup.artifactMaxAgeDays = 14;
  const applied = await runCleanArtifacts(root, config, { apply: true });
  // Only the real aged task dir is pruned; the symlink is never a candidate.
  assert.equal(applied.removed, 1);
  assert.equal(await pathExists(path.join(store, "ui-eval", "real-task")), false);
  assert.equal(await pathExists(path.join(store, "ui-eval", "linked-task")), true);
  // The symlink target and its contents survive untouched.
  assert.equal(await pathExists(path.join(outside, "secret.bin")), true);
});

test("measureStore marks an unreached directory as not measured, never an exact 0 B", async () => {
  const root = await tempDir("agentify-unmeasured-");
  const store = path.join(root, ".agentify");
  // A non-empty directory and a top-level file.
  await writeFileWithMtime(path.join(store, "harness", "a.bin"), "x".repeat(4000));
  await writeFileWithMtime(path.join(store, "harness", "b.bin"), "y".repeat(4000));
  await writeFileWithMtime(path.join(store, "store.json"), "{}");

  // Budget of zero entries: no directory tree can be walked at all.
  const result = await measureStore(store, { ownedNames: agentifyOwnedNames(root), maxEntries: 0 });
  assert.equal(result.truncated, true);

  const harness = result.entries.find((e) => e.name === "harness");
  assert.equal(harness.measured, "unmeasured");
  assert.equal(harness.sizeBytes, 0);
  // Critically: it is NOT reported as an exact empty directory.
  assert.notEqual(harness.measured, "exact");

  // Top-level files are cheap and always measured exactly.
  const meta = result.entries.find((e) => e.name === "store.json");
  assert.equal(meta.measured, "exact");

  // An unmeasured entry sinks below measured entries in the ordering.
  assert.equal(result.entries[result.entries.length - 1].name, "harness");
});

test("dirStats reports a partial walk as a lower bound and a full walk as exact", async () => {
  const root = await tempDir("agentify-partial-");
  const dir = path.join(root, "tree");
  for (let i = 0; i < 5; i += 1) {
    await writeFileWithMtime(path.join(dir, `f${i}.bin`), "z".repeat(100));
  }

  const partial = await dirStats(dir, { maxEntries: 2 });
  assert.equal(partial.measured, "partial");
  assert.equal(partial.truncated, true);
  assert.ok(partial.size > 0 && partial.size < 500, `expected lower bound, got ${partial.size}`);

  const full = await dirStats(dir);
  assert.equal(full.measured, "exact");
  assert.equal(full.truncated, false);
  assert.equal(full.size, 500);

  const none = await dirStats(dir, { maxEntries: 0 });
  assert.equal(none.measured, "unmeasured");
  assert.equal(none.size, 0);
});

test("runCleanArtifacts does a full walk: exact sizes even when a status budget would truncate", async () => {
  const root = await tempDir("agentify-artifacts-exact-");
  const store = path.join(root, ".agentify");
  // Many files across an unknown dir and an aged ui-eval task dir.
  for (let i = 0; i < 40; i += 1) {
    await writeFileWithMtime(path.join(store, "visual", `v${i}.png`), "v".repeat(1000));
  }
  await writeFileWithMtime(path.join(store, "ui-eval", "old-task", "after.png"), "a".repeat(2000), 30);

  // Sanity: a tiny status-style budget truncates the big unknown dir.
  const statusView = await measureStore(store, { ownedNames: agentifyOwnedNames(root), maxEntries: 5 });
  assert.equal(statusView.truncated, true);

  // The explicit command still reports exact sizes (full walk).
  const config = await loadConfig(root, {});
  const result = await runCleanArtifacts(root, config, { apply: false });
  const visual = result.unknown.find((u) => u.path === ".agentify/visual");
  assert.ok(visual, "expected .agentify/visual in unknown");
  assert.equal(visual.measured, "exact");
  assert.equal(visual.size_bytes, 40 * 1000);

  const staleItems = result.groups.flatMap((g) => g.items.filter((i) => i.stale));
  assert.equal(staleItems.length, 1);
  assert.equal(staleItems[0].measured, "exact");
  assert.equal(staleItems[0].size_bytes, 2000);
  assert.ok(FULL_BUDGET.budgetMs >= 10000, "full budget should be generous");
});

test("formatBytes renders binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
});
