import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildInvocationReport,
  isInsideGitRepository,
  recordInvocation,
  resolveCliInvocationCommand,
  resolveInvocationsPath,
} from "../src/core/invocations.js";

test("resolveInvocationsPath honors only an absolute XDG cache home", () => {
  assert.equal(
    resolveInvocationsPath({ env: { XDG_CACHE_HOME: "/var/cache/me" }, home: "/home/me" }),
    path.join("/var/cache/me", "agentify", "invocations.json"),
  );
  assert.equal(
    resolveInvocationsPath({ env: { XDG_CACHE_HOME: "relative-cache" }, home: "/home/me" }),
    path.join("/home/me", ".cache", "agentify", "invocations.json"),
  );
});

test("resolveCliInvocationCommand keeps command names and drops positional data", () => {
  assert.equal(resolveCliInvocationCommand({ _: ["ctx", "track"] }), "ctx.track");
  assert.equal(resolveCliInvocationCommand({ _: ["eval", "harbor", "validate"] }), "eval.harbor.validate");
  assert.equal(resolveCliInvocationCommand({ _: ["delegate", "quick", "secret task text"] }), "delegate.quick");
  assert.equal(resolveCliInvocationCommand({ _: ["skills", "install", "private-skill-name"] }), "skill.install");
  assert.equal(resolveCliInvocationCommand({ _: ["private-command", "secret"] }), "unknown");
  assert.equal(resolveCliInvocationCommand({ _: [] }, { help: true }), "help");
  assert.equal(resolveCliInvocationCommand({ _: [] }, { version: true }), "version");
});

test("recordInvocation stores only daily command and source counts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-invocations-"));
  const targetPath = path.join(root, "cache", "agentify", "invocations.json");
  try {
    await recordInvocation({ command: "stats", source: "cli" }, { path: targetPath, now: "2026-08-19T01:00:00Z" });
    await recordInvocation({ command: "stats", source: "cli" }, { path: targetPath, now: "2026-08-19T02:00:00Z" });
    await recordInvocation({ command: "ctx.track", source: "hook" }, { path: targetPath, now: "2026-08-18T23:00:00Z" });
    await recordInvocation({ command: "query", source: "mcp" }, { path: targetPath, now: "2026-08-19T03:00:00Z" });
    await recordInvocation({ command: "scan", source: "cli" }, { path: targetPath, now: "2026-07-01T03:00:00Z" });

    const rejected = await recordInvocation(
      { command: "delegate.quick private task text", source: "cli" },
      { path: targetPath, now: "2026-08-19T04:00:00Z" },
    );
    assert.equal(rejected.recorded, false);

    const storedText = await fs.readFile(targetPath, "utf8");
    assert.ok(!storedText.includes("private task text"));
    assert.deepEqual(JSON.parse(storedText)["2026-08-19"], {
      stats: { cli: 2 },
      query: { mcp: 1 },
    });

    const report = await buildInvocationReport({ path: targetPath, days: 7, now: "2026-08-19T12:00:00Z" });
    assert.equal(report.total, 4);
    assert.deepEqual(report.by_source, { cli: 2, hook: 1, mcp: 1 });
    assert.equal(report.by_command.stats.total, 2);
    assert.equal(report.by_command["ctx.track"].by_source.hook, 1);
    assert.equal(report.top_commands[0].command, "stats");
    assert.deepEqual(report.daily.map((entry) => entry.date), ["2026-08-18", "2026-08-19"]);

    if (process.platform !== "win32") {
      assert.equal((await fs.stat(path.dirname(targetPath))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(targetPath)).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recordInvocation fails open when the store cannot be written", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-invocations-fail-open-"));
  try {
    const parentFile = path.join(root, "not-a-directory");
    await fs.writeFile(parentFile, "occupied", "utf8");
    const result = await recordInvocation(
      { command: "status", source: "cli" },
      { path: path.join(parentFile, "invocations.json") },
    );
    assert.deepEqual(result, { recorded: false, reason: "write_failed" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a symlinked cache path into a Git repository is never written", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-invocations-symlink-"));
  try {
    const repo = path.join(root, "repo");
    const cacheTarget = path.join(repo, "cache-target");
    const link = path.join(root, "xdg-cache");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.mkdir(cacheTarget, { recursive: true });
    await fs.symlink(cacheTarget, link, "dir");

    const targetPath = resolveInvocationsPath({ env: { XDG_CACHE_HOME: link }, home: root });
    assert.equal(await isInsideGitRepository(targetPath), true);
    const result = await recordInvocation(
      { command: "ctx.load", source: "hook" },
      { path: targetPath },
    );
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "cache_inside_git_repository");
    await assert.rejects(fs.access(path.join(cacheTarget, "agentify", "invocations.json")));

    const report = await buildInvocationReport({ path: targetPath });
    assert.equal(report.total, 0);
    assert.match(report.limitation, /inside a Git repository/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a cache path inside a bare Git repository is never written", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-invocations-bare-"));
  try {
    const bareRepo = path.join(root, "project.git");
    const targetPath = path.join(bareRepo, "cache", "agentify", "invocations.json");
    await fs.mkdir(path.join(bareRepo, "objects"), { recursive: true });
    await fs.writeFile(path.join(bareRepo, "HEAD"), "ref: refs/heads/main\n", "utf8");

    assert.equal(await isInsideGitRepository(targetPath), true);
    const result = await recordInvocation({ command: "serve", source: "cli" }, { path: targetPath });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "cache_inside_git_repository");
    await assert.rejects(fs.access(targetPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
