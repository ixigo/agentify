import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseArgs, runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

async function tmpRoot(prefix = "agentify-main-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function captureLog(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

async function captureStdout(fn) {
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, encoding, callback) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  });
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs normalizes dashed flags to camelCase booleans", () => {
  const args = parseArgs(["scan", "--dry-run", "--json"]);
  assert.deepEqual(args._, ["scan"]);
  assert.equal(args.dryRun, true);
  assert.equal(args.json, true);
});

test("parseArgs reads inline and separate flag values", () => {
  const inline = parseArgs(["query", "def", "--symbol=useAuth", "--root=/tmp/x"]);
  assert.equal(inline.symbol, "useAuth");
  assert.equal(inline.root, "/tmp/x");

  const separate = parseArgs(["query", "def", "--symbol", "useAuth"]);
  assert.equal(separate.symbol, "useAuth");
  assert.deepEqual(separate._, ["query", "def"]);
});

test("parseArgs coerces numeric and boolean-like values", () => {
  const args = parseArgs(["query", "impacts", "--depth", "4", "--strict=false"]);
  assert.equal(args.depth, 4);
  assert.equal(args.strict, false);
});

test("parseArgs treats known boolean flags as switches even before a value", () => {
  const args = parseArgs(["scan", "--strict", "false"]);
  assert.equal(args.strict, true);
  assert.deepEqual(args._, ["scan", "false"]);
});

test("parseArgs treats a trailing valueless flag as boolean true", () => {
  const args = parseArgs(["risk", "--since"]);
  assert.equal(args.since, true);
});

test("parseArgs supports short help and version flags", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
  assert.equal(parseArgs(["-V"]).version, true);
});

// ---------------------------------------------------------------------------
// dispatch + error messages
// ---------------------------------------------------------------------------

test("runCli rejects an unknown command", async () => {
  await assert.rejects(() => runCli(["frobnicate"]), /unknown command "frobnicate"/);
});

test("runCli --version prints the version banner", async () => {
  const out = await captureStdout(() => runCli(["--version"]));
  assert.match(out, /^agentify v\d+\.\d+\.\d+/);
});

test("runCli completion values providers writes provider names to stdout", async () => {
  const out = await captureStdout(() => runCli(["completion", "values", "providers"]));
  assert.deepEqual(out.trim().split("\n"), ["local", "codex", "claude", "gemini", "opencode"]);
});

// ---------------------------------------------------------------------------
// install / uninstall / status
// ---------------------------------------------------------------------------

test("runCli install --json writes managed integration and emits one payload", async () => {
  const root = await tmpRoot("agentify-main-install-");
  const lines = await captureLog(() => runCli(["install", "--root", root, "--json"]));
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.command, "install");
  assert.equal(payload.scope, "project");
  assert.equal(payload.integrations.length, 1);
  assert.equal(payload.integrations[0].provider, "claude");
  assert.ok(payload.integrations[0].memory.changed);

  const memory = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
  assert.match(memory, /<!-- agentify:begin -->/);
  const settings = JSON.parse(await fs.readFile(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.ok(Array.isArray(settings.hooks.PostToolUse));
  await fs.access(path.join(root, ".agentify.yaml"));
});

test("runCli init is an alias for install", async () => {
  const root = await tmpRoot("agentify-main-init-");
  const lines = await captureLog(() => runCli(["init", "--root", root, "--json"]));
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.command, "install");
  await fs.access(path.join(root, "CLAUDE.md"));
});

test("runCli uninstall removes the managed integration", async () => {
  const root = await tmpRoot("agentify-main-uninstall-");
  await captureLog(() => runCli(["install", "--root", root, "--json"]));
  const lines = await captureLog(() => runCli(["uninstall", "--root", root, "--json"]));
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.command, "uninstall");
  const claudeResult = payload.integrations.find((item) => item.provider === "claude");
  assert.equal(claudeResult.memory.changed, true);

  const memory = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
  assert.doesNotMatch(memory, /<!-- agentify:begin -->/);
});

test("runCli status --json reports integration and context state", async () => {
  const root = await tmpRoot("agentify-main-status-");
  await captureLog(() => runCli(["install", "--root", root, "--json"]));
  const lines = await captureLog(() => runCli(["status", "--root", root, "--json"]));
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.command, "status");
  const claudeStatus = payload.integrations.find((item) => item.provider === "claude");
  assert.equal(claudeStatus.installed, true);
  const codexStatus = payload.integrations.find((item) => item.provider === "codex");
  assert.equal(codexStatus.installed, false);
  assert.equal(payload.context.event_count, 0);
});

// ---------------------------------------------------------------------------
// ctx routing
// ---------------------------------------------------------------------------

test("runCli ctx requires a subcommand", async () => {
  const root = await tmpRoot("agentify-main-ctx-");
  await assert.rejects(() => runCli(["ctx", "--root", root]), /ctx requires a subcommand/);
});

test("runCli ctx note rejects an empty note", async () => {
  const root = await tmpRoot("agentify-main-ctx-note-");
  await assert.rejects(() => runCli(["ctx", "note", "--root", root]), /non-empty text/);
});

test("runCli ctx note then status --json records the note", async () => {
  const root = await tmpRoot("agentify-main-ctx-status-");
  await captureLog(() => runCli(["ctx", "note", "--root", root, "--json", "remember", "the", "changelog"]));
  const lines = await captureLog(() => runCli(["ctx", "status", "--root", root, "--json"]));
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.command, "ctx status");
  assert.equal(payload.note_count, 1);
});

test("runCli ctx handoff --json writes a handoff file", async () => {
  const root = await tmpRoot("agentify-main-ctx-handoff-");
  const lines = await captureLog(() => runCli(["ctx", "handoff", "--root", root, "--json", "closing", "out"]));
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.command, "ctx handoff");
  const written = await fs.readFile(payload.path, "utf8");
  assert.match(written, /closing out/);
});

test("runCli ctx load without tracked context does not throw", async () => {
  const root = await tmpRoot("agentify-main-ctx-load-");
  await runCli(["ctx", "load", "--root", root]);
});

// ---------------------------------------------------------------------------
// scan / query / risk
// ---------------------------------------------------------------------------

async function scanFixture() {
  const root = await tmpRoot("agentify-main-scan-");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "station.ts"),
    "export function findMetroStation(query) { return query.trim(); }\n",
    "utf8",
  );
  await runCli(["scan", "--root", root, "--json"]);
  return root;
}

test("runCli scan builds the SQLite index", async () => {
  const root = await scanFixture();
  await fs.access(path.join(root, ".agentify", "index.db"));
});

test("runCli query search --json returns indexed files", async () => {
  const root = await scanFixture();
  const lines = await captureLog(() => runCli(["query", "search", "--term", "station", "--root", root, "--json"]));
  const payload = JSON.parse(lines.at(-1));
  assert.ok(payload.files.some((fileInfo) => fileInfo.path === "src/station.ts"));
});

test("runCli query def requires --symbol", async () => {
  const root = await scanFixture();
  await assert.rejects(
    () => runCli(["query", "def", "--root", root]),
    /query def requires --symbol <name>/,
  );
});

test("runCli query reports actionable guidance when the index is missing", async () => {
  const root = await tmpRoot("agentify-main-query-missing-");
  await assert.rejects(
    () => runCli(["query", "search", "--term", "x", "--root", root]),
    /Agentify index missing/,
  );
});

test("runCli up runs scan then check without error", async () => {
  const root = await tmpRoot("agentify-main-up-");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await runCli(["up", "--root", root, "--json"]);
  await fs.access(path.join(root, ".agentify", "index.db"));
});

test("runCli risk rejects --since without a non-blank value", async () => {
  for (const argv of [["risk", "--since"], ["risk", "--since", ""], ["risk", "--since=   "]]) {
    await assert.rejects(() => runCli(argv), /risk --since requires a commit or ref value/);
  }
});

// ---------------------------------------------------------------------------
// skill
// ---------------------------------------------------------------------------

test("runCli skill list --json lists built-in skills", async () => {
  const root = await tmpRoot("agentify-main-skill-list-");
  const lines = await captureLog(() => runCli(["skill", "list", "--root", root, "--json"]));
  const payload = JSON.parse(lines.at(-1));
  assert.ok(Array.isArray(payload.skills));
  assert.ok(payload.skills.some((skill) => skill.name === "auto-pilot"));
});

test("runCli skill install requires a skill name", async () => {
  const root = await tmpRoot("agentify-main-skill-install-");
  await assert.rejects(
    () => runCli(["skill", "install", "--root", root]),
    /skill install requires a skill name/,
  );
});

test("runCli skill requires a valid subcommand", async () => {
  const root = await tmpRoot("agentify-main-skill-bad-");
  await assert.rejects(
    () => runCli(["skill", "frobnicate", "--root", root]),
    /skill requires a subcommand/,
  );
});

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

test("runCli hooks install/status/remove manage git hooks", async () => {
  const root = await tmpRoot("agentify-main-hooks-");
  await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });

  await runCli(["hooks", "install", "--root", root]);
  await fs.access(path.join(root, ".git", "hooks", "pre-commit"));

  const statusLines = await captureLog(() => runCli(["hooks", "status", "--root", root, "--json"]));
  const status = JSON.parse(statusLines.at(-1));
  assert.equal(status.preCommit, true);
  assert.equal(status.postMerge, true);

  await runCli(["hooks", "remove", "--root", root]);
  await assert.rejects(() => fs.access(path.join(root, ".git", "hooks", "pre-commit")));
});

test("runCli hooks requires a valid subcommand", async () => {
  const root = await tmpRoot("agentify-main-hooks-bad-");
  await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });
  await assert.rejects(() => runCli(["hooks", "frobnicate", "--root", root]), /hooks requires a subcommand/);
});

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

test("runCli clean --json emits a machine-readable cleanup report", async () => {
  const root = await tmpRoot("agentify-main-clean-");
  const lines = await captureLog(() => runCli(["clean", "--root", root, "--json"]));
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.command, "clean");
  assert.ok(Array.isArray(payload.removed_paths));
  assert.equal("removed_cache_blobs" in payload, false);
});

// ---------------------------------------------------------------------------
// CLI binary smoke check
// ---------------------------------------------------------------------------

test("cli.js --version prints the version and no stderr", async () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const result = await execFileAsync(process.execPath, ["src/cli.js", "--version"], { cwd: repoRoot });
  assert.match(result.stdout, /^agentify v\d+\.\d+\.\d+/);
});

test("runCli install --provider codex writes AGENTS.md guidance", async () => {
  const root = await tmpRoot("agentify-main-install-codex-");
  const lines = await captureLog(() => runCli(["install", "--root", root, "--provider", "codex", "--json"]));
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.integrations.length, 1);
  assert.equal(payload.integrations[0].provider, "codex");
  const agentsMd = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /<!-- agentify:begin -->/);
  await assert.rejects(() => fs.access(path.join(root, ".claude", "settings.json")));
});

test("runCli install --provider all writes both integrations", async () => {
  const root = await tmpRoot("agentify-main-install-all-");
  const lines = await captureLog(() => runCli(["install", "--root", root, "--provider", "all", "--json"]));
  const payload = JSON.parse(lines[0]);
  assert.deepEqual(payload.integrations.map((item) => item.provider), ["claude", "codex"]);
  await fs.access(path.join(root, "CLAUDE.md"));
  await fs.access(path.join(root, "AGENTS.md"));
  await fs.access(path.join(root, ".claude", "settings.json"));
});
