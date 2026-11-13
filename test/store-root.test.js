import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { resolveStoreRoot } from "../src/core/project-store.js";
import { runCleanStrays } from "../src/core/cleanup.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
}

async function mkTempDir(prefix) {
  // realpath so macOS /var -> /private/var symlink does not break path compares.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function runCli(args, { stdin, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

const EDIT_PAYLOAD = JSON.stringify({
  session_id: "store-root-session",
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: "file.js" },
  tool_response: {},
});

test("resolveStoreRoot climbs to the nearest ancestor that already has a store", async () => {
  const root = await mkTempDir("agentify-resolve-store-");
  try {
    await initGitRepo(root);
    // An installed subproject owner (has .agentify.yaml) below the top-level.
    const sub = path.join(root, "packages", "widget");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, ".agentify.yaml"), "provider: local\n", "utf8");
    const deep = path.join(sub, "src", "deep");
    await fs.mkdir(deep, { recursive: true });
    const result = await resolveStoreRoot(deep);
    assert.equal(result.root, sub);
    assert.equal(result.source, "owner");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveStoreRoot ignores a hook stray (context only) and uses the git top-level", async () => {
  const root = await mkTempDir("agentify-resolve-stray-");
  try {
    await initGitRepo(root);
    // A hook-created stray: only context/, no index.db, no .agentify.yaml.
    const strayCtx = path.join(root, "src", ".agentify", "context");
    await fs.mkdir(strayCtx, { recursive: true });
    const deep = path.join(root, "src", "deep");
    await fs.mkdir(deep, { recursive: true });
    const result = await resolveStoreRoot(deep);
    assert.equal(result.root, root);
    assert.equal(result.source, "git-toplevel");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveStoreRoot never resolves to a path inside a .agentify store", async () => {
  const root = await mkTempDir("agentify-resolve-nested-");
  try {
    await initGitRepo(root);
    const contextDir = path.join(root, ".agentify", "context");
    await fs.mkdir(contextDir, { recursive: true });
    const result = await resolveStoreRoot(contextDir);
    // Climbs out of .agentify to the real repo root, not the store itself.
    assert.equal(result.root, root);
    assert.equal(result.source, "git-toplevel");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveStoreRoot never walks above the git top-level to a parent store", async () => {
  const outer = await mkTempDir("agentify-resolve-outer-");
  try {
    // A real store owner ABOVE the repo (mirrors ~/.agentify on the real machine,
    // except this one is even an installed owner).
    await fs.writeFile(path.join(outer, ".agentify.yaml"), "provider: local\n", "utf8");
    const repo = path.join(outer, "repo");
    await fs.mkdir(repo, { recursive: true });
    await initGitRepo(repo);
    const deep = path.join(repo, "src");
    await fs.mkdir(deep, { recursive: true });
    const result = await resolveStoreRoot(deep);
    // Stays at the repo top-level; the parent owner is never consulted.
    assert.equal(result.root, repo);
    assert.equal(result.source, "git-toplevel");
  } finally {
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test("resolveStoreRoot outside a git repo needs a real installed store, else null", async () => {
  const parent = await mkTempDir("agentify-resolve-nongit-");
  try {
    // A bare .agentify with only cache/ (like ~/.agentify) is NOT an owner.
    const bare = path.join(parent, "bare");
    await fs.mkdir(path.join(bare, ".agentify", "cache"), { recursive: true });
    assert.deepEqual(await resolveStoreRoot(bare), { root: null, source: "none" });

    // A directory whose .agentify holds index.db IS an owner.
    const installed = path.join(parent, "installed");
    await fs.mkdir(path.join(installed, ".agentify"), { recursive: true });
    await fs.writeFile(path.join(installed, ".agentify", "index.db"), "x", "utf8");
    const deep = path.join(installed, "sub");
    await fs.mkdir(deep, { recursive: true });
    const result = await resolveStoreRoot(deep);
    assert.equal(result.root, installed);
    assert.equal(result.source, "owner");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a hook fired deep in the tree writes to the root store, not a stray", async () => {
  const root = await mkTempDir("agentify-hook-deep-");
  try {
    await initGitRepo(root);
    await fs.mkdir(path.join(root, ".agentify", "context"), { recursive: true });
    const deep = path.join(root, "src", "deep", "dir");
    await fs.mkdir(deep, { recursive: true });

    const result = await runCli(["ctx", "track", "--hook"], {
      stdin: EDIT_PAYLOAD,
      cwd: deep,
      env: { XDG_CACHE_HOME: path.join(root, "global-cache") },
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const rootEvents = path.join(root, ".agentify", "context", "events.jsonl");
    const lines = (await fs.readFile(rootEvents, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    // No stray store was created in the subdirectory.
    assert.equal(await dirExists(path.join(deep, ".agentify")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a hook fired inside .agentify/context creates nothing nested", async () => {
  const root = await mkTempDir("agentify-hook-nested-");
  try {
    await initGitRepo(root);
    const contextDir = path.join(root, ".agentify", "context");
    await fs.mkdir(contextDir, { recursive: true });

    const result = await runCli(["ctx", "track", "--hook"], {
      stdin: EDIT_PAYLOAD,
      cwd: contextDir,
      env: { XDG_CACHE_HOME: path.join(root, "global-cache") },
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // The event landed in the real store, and no .agentify/context/.agentify appeared.
    const lines = (await fs.readFile(path.join(contextDir, "events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(await dirExists(path.join(contextDir, ".agentify")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a hook fired outside any repo with no store writes nothing", async () => {
  const root = await mkTempDir("agentify-hook-outside-");
  try {
    const result = await runCli(["ctx", "track", "--hook"], {
      stdin: EDIT_PAYLOAD,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "global-cache") },
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, "");
    // Nothing created anywhere under the directory.
    assert.equal(await dirExists(path.join(root, ".agentify")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an explicitly-installed subproject store is honoured over the repo root", async () => {
  const root = await mkTempDir("agentify-hook-subproject-");
  try {
    await initGitRepo(root);
    await fs.mkdir(path.join(root, ".agentify", "context"), { recursive: true });
    const sub = path.join(root, "packages", "widget");
    await fs.mkdir(path.join(sub, ".agentify", "context"), { recursive: true });
    await fs.writeFile(path.join(sub, ".agentify.yaml"), "provider: local\n", "utf8");
    const subDeep = path.join(sub, "src");
    await fs.mkdir(subDeep, { recursive: true });

    const result = await runCli(["ctx", "track", "--hook"], {
      stdin: EDIT_PAYLOAD,
      cwd: subDeep,
      env: { XDG_CACHE_HOME: path.join(root, "global-cache") },
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // Event went to the subproject store; the repo-root store stayed empty.
    const subLines = (await fs.readFile(path.join(sub, ".agentify", "context", "events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(subLines.length, 1);
    assert.equal(await fileExists(path.join(root, ".agentify", "context", "events.jsonl")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("clean --strays dry-run lists strays and apply merges with no event loss", async () => {
  const root = await mkTempDir("agentify-strays-");
  try {
    await initGitRepo(root);
    // Root store with two events and one note.
    await writeContext(root, "events.jsonl", [
      { ts: "2026-01-01T00:00:00.000Z", type: "edit", path: "a.js" },
      { ts: "2026-01-02T00:00:00.000Z", type: "edit", path: "b.js" },
    ]);
    await writeContext(root, "notes.jsonl", [
      { ts: "2026-01-01T00:00:00.000Z", note: "root note" },
    ]);

    // Stray under src/: one duplicate event + one new event, plus a new note.
    const strayA = path.join(root, "src");
    await writeContext(strayA, "events.jsonl", [
      { ts: "2026-01-02T00:00:00.000Z", type: "edit", path: "b.js" },
      { ts: "2026-01-03T00:00:00.000Z", type: "edit", path: "c.js" },
    ]);
    await writeContext(strayA, "notes.jsonl", [
      { ts: "2026-01-03T00:00:00.000Z", note: "stray note" },
    ]);

    // Explicitly-installed subproject (owner) with its own stray beneath it.
    const sub = path.join(root, "pkg");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, ".agentify.yaml"), "provider: local\n", "utf8");
    await writeContext(sub, "events.jsonl", [
      { ts: "2026-01-01T00:00:00.000Z", type: "edit", path: "pkg.js" },
    ]);
    const straySub = path.join(sub, "lib");
    await writeContext(straySub, "events.jsonl", [
      { ts: "2026-01-04T00:00:00.000Z", type: "edit", path: "lib.js" },
    ]);

    // Dry run.
    const dry = await runCleanStrays(root, {}, { apply: false });
    assert.equal(dry.strays.length, 2);
    const byPath = Object.fromEntries(dry.strays.map((s) => [s.relative_path, s]));
    assert.ok(byPath["src/.agentify"], "src stray listed");
    assert.ok(byPath["pkg/lib/.agentify"], "pkg/lib stray listed");
    // Nearest owner: pkg/lib merges into pkg, src merges into root.
    assert.equal(byPath["src/.agentify"].owner_relative_path, "./.agentify");
    assert.equal(byPath["pkg/lib/.agentify"].owner_relative_path, "pkg/.agentify");
    // Dry run changed nothing.
    assert.equal(await dirExists(path.join(strayA, ".agentify")), true);
    assert.equal((await readContext(root, "events.jsonl")).length, 2);

    // Apply.
    const applied = await runCleanStrays(root, {}, { apply: true });
    assert.equal(applied.applied, 2);
    assert.equal(await dirExists(path.join(strayA, ".agentify")), false);
    assert.equal(await dirExists(path.join(straySub, ".agentify")), false);

    const rootEvents = await readContext(root, "events.jsonl");
    // a, b, c — the duplicate b collapsed, nothing lost, timestamp order.
    assert.deepEqual(rootEvents.map((e) => e.path), ["a.js", "b.js", "c.js"]);
    const rootNotes = await readContext(root, "notes.jsonl");
    assert.deepEqual(rootNotes.map((n) => n.note), ["root note", "stray note"]);
    const subEvents = await readContext(sub, "events.jsonl");
    assert.deepEqual(subEvents.map((e) => e.path), ["pkg.js", "lib.js"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("clean --strays refuses to delete a store holding more than context, and reports it", async () => {
  const root = await mkTempDir("agentify-strays-unsafe-");
  try {
    await initGitRepo(root);
    await writeContext(root, "events.jsonl", [{ ts: "2026-01-01T00:00:00.000Z", type: "edit", path: "root.js" }]);

    // A non-owner store (no index.db / .agentify.yaml) that also holds a repo-map
    // artifact: not safe to delete, so it must be skipped, not merged or removed.
    const toolsStore = path.join(root, "tools", ".agentify");
    await writeContext(path.join(root, "tools"), "events.jsonl", [{ ts: "2026-02-01T00:00:00.000Z", type: "edit", path: "tools.js" }]);
    await fs.mkdir(path.join(toolsStore, "repo-map"), { recursive: true });
    await fs.writeFile(path.join(toolsStore, "repo-map", "map.json"), "{}", "utf8");

    const applied = await runCleanStrays(root, {}, { apply: true });
    assert.equal(applied.strays.length, 0);
    assert.equal(applied.applied, 0);
    assert.equal(applied.skipped.length, 1);
    assert.equal(applied.skipped[0].relative_path, "tools/.agentify");
    assert.match(applied.skipped[0].reason, /repo-map/);
    assert.ok(applied.skipped[0].size_bytes > 0);
    // Left untouched; the owner store did not absorb its events.
    assert.equal(await dirExists(toolsStore), true);
    assert.deepEqual((await readContext(root, "events.jsonl")).map((e) => e.path), ["root.js"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("clean --strays merges and removes a three-deep nested store", async () => {
  const root = await mkTempDir("agentify-strays-nested-");
  try {
    await initGitRepo(root);
    await writeContext(root, "events.jsonl", [{ ts: "2026-01-01T00:00:00.000Z", type: "edit", path: "root.js" }]);

    // Nested strays inside the real root store: .agentify/.agentify/.agentify and
    // .agentify/context/.agentify (two of the real-world shapes).
    const write = async (dir, record) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "events.jsonl"), JSON.stringify(record) + "\n", "utf8");
    };
    await write(path.join(root, ".agentify", ".agentify", "context"), { ts: "2026-01-02T00:00:00.000Z", type: "edit", path: "n1.js" });
    await write(path.join(root, ".agentify", ".agentify", ".agentify", "context"), { ts: "2026-01-03T00:00:00.000Z", type: "edit", path: "n2.js" });
    await write(path.join(root, ".agentify", "context", ".agentify", "context"), { ts: "2026-01-04T00:00:00.000Z", type: "edit", path: "n3.js" });

    const applied = await runCleanStrays(root, {}, { apply: true });
    assert.equal(applied.skipped.length, 0);
    // Every nested store was removed; the real root context dir survives.
    assert.equal(await dirExists(path.join(root, ".agentify", ".agentify")), false);
    assert.equal(await dirExists(path.join(root, ".agentify", "context", ".agentify")), false);
    assert.ok(await dirExists(path.join(root, ".agentify", "context")));
    assert.ok(applied.strays.every((s) => s.nested));
    const rootEvents = await readContext(root, "events.jsonl");
    assert.deepEqual(rootEvents.map((e) => e.path).sort(), ["n1.js", "n2.js", "n3.js", "root.js"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install from a subproject stays cwd-literal and creates a subproject store", async () => {
  const root = await mkTempDir("agentify-install-sub-");
  try {
    await initGitRepo(root);
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });
    const sub = path.join(root, "services", "api");
    await fs.mkdir(sub, { recursive: true });

    const result = await runCli(["install", "--home", home, "--provider", "claude", "--json"], {
      cwd: sub,
      env: { XDG_CACHE_HOME: path.join(root, "global-cache") },
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    // The config landed at the subproject, not rewritten up to the repo top-level.
    assert.equal(await fileExists(path.join(sub, ".agentify.yaml")), true);
    assert.equal(await fileExists(path.join(root, ".agentify.yaml")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeContext(dir, fileName, records) {
  const contextDir = path.join(dir, ".agentify", "context");
  await fs.mkdir(contextDir, { recursive: true });
  await fs.writeFile(path.join(contextDir, fileName), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

async function readContext(dir, fileName) {
  const target = path.join(dir, ".agentify", "context", fileName);
  const raw = await fs.readFile(target, "utf8");
  return raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function dirExists(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
