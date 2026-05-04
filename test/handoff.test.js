import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, inTransaction, openIndexDatabase } from "../src/core/db/connection.js";
import { writeRepositoryIndex } from "../src/core/db/structural-store.js";
import { writeHandoffBundle } from "../src/core/handoff.js";
import { forkSession } from "../src/core/session.js";
import { getSessionArtifactPaths } from "../src/core/session-memory.js";
import { runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

async function setupHandoffRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-handoff-"));
  await fs.mkdir(path.join(root, "src", "core"), { recursive: true });
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".agents/\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2));
  await fs.writeFile(path.join(root, "src", "core", "session.js"), [
    "export function buildSessionPrompt(task) {",
    "  return `Continue ${task}`;",
    "}",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "test", "session.test.js"), [
    "import test from 'node:test';",
    "test('session prompt', () => {});",
    "",
  ].join("\n"), "utf8");
  await initGitRepo(root);

  const db = openIndexDatabase(root);
  try {
    inTransaction(db, () => {
      writeRepositoryIndex(db, {
        generated_at: "2026-01-01T00:00:00.000Z",
        repo: {
          name: "agentify-handoff-test",
          root,
          detected_stacks: [{ name: "js", confidence: 1 }],
          default_stack: "js",
          package_manager: "npm",
        },
        modules: [{
          id: "core-session",
          name: "core-session",
          root_path: "src/core",
          stack: "js",
          package_name: null,
          slug: "core-session",
          doc_path: "docs/modules/core-session.md",
          fingerprint: "fp-core-session",
          entry_files: ["src/core/session.js"],
          key_files: ["src/core/session.js"],
        }],
        files: [
          {
            path: "src/core/session.js",
            module_id: "core-session",
            language: "js",
            size_bytes: 80,
            fingerprint: "fp-session",
            is_test: 0,
            is_config: 0,
            is_entrypoint: 1,
            is_key_file: 1,
          },
          {
            path: "test/session.test.js",
            module_id: "core-session",
            language: "js",
            size_bytes: 60,
            fingerprint: "fp-test",
            is_test: 1,
            is_config: 0,
            is_entrypoint: 0,
            is_key_file: 0,
          },
        ],
        symbols: [{
          module_id: "core-session",
          file_path: "src/core/session.js",
          name: "buildSessionPrompt",
          kind: "function",
          exported: 1,
          start_line: 1,
          end_line: 3,
        }],
        imports: [],
        tests: [{
          file_path: "test/session.test.js",
          module_id: "core-session",
          framework: "node:test",
          related_path: "src/core/session.js",
        }],
        commands: [{
          module_id: null,
          command_type: "test",
          command: "npm",
          args: ["test"],
        }],
      }, {
        headCommit: "indexed-head",
        provider: "codex",
      });
    });
  } finally {
    closeIndexDatabase(db);
  }

  return root;
}

test("writeHandoffBundle creates deterministic JSON and markdown with conflict hints", async () => {
  const root = await setupHandoffRepo();
  const config = await loadConfig(root, { provider: "codex" });
  const session = await forkSession(root, config, { name: "handoff buildSessionPrompt" });

  await fs.appendFile(
    path.join(root, "src", "core", "session.js"),
    "// TODO: decide whether handoff should run after every provider launch\n",
    "utf8",
  );

  const previousDir = path.join(root, ".agents", "session", "sess_previous");
  await fs.mkdir(previousDir, { recursive: true });
  await fs.writeFile(path.join(previousDir, "session-manifest.json"), JSON.stringify({
    schema_version: "1.0",
    session_id: "sess_previous",
    created_at: "2026-01-01T00:00:00.000Z",
    provider: "codex",
    name: "previous session",
    head_commit_at_creation: "previous-head",
  }, null, 2));
  await fs.writeFile(path.join(previousDir, "handoff.json"), JSON.stringify({
    schema_version: "1.0",
    touched_files: [{ path: "src/core/session.js", status: "M" }],
  }, null, 2));

  const first = await writeHandoffBundle(root, config, session.sessionId, "continue buildSessionPrompt handoff");
  const second = await writeHandoffBundle(root, config, session.sessionId, "continue buildSessionPrompt handoff");

  assert.deepEqual(second.bundle, first.bundle);
  assert.equal(first.relativeJsonPath, `.agents/session/${session.sessionId}/handoff.json`);
  assert.equal(first.relativeMarkdownPath, `.agents/session/${session.sessionId}/handoff.md`);
  assert.ok(first.bundle.top_ranked_context.files.some((item) => item.path === "src/core/session.js"));
  assert.ok(first.bundle.touched_files.some((item) => item.path === "src/core/session.js"));
  assert.ok(first.bundle.touched_symbol_neighborhood.some((item) =>
    item.file_path === "src/core/session.js"
    && item.symbols.some((symbol) => symbol.name === "buildSessionPrompt")
  ));
  assert.ok(first.bundle.recommended_tests.files.some((item) => item.file_path === "test/session.test.js"));
  assert.ok(first.bundle.recommended_tests.commands.some((item) => item.command === "npm" && item.args.includes("test")));
  assert.ok(first.bundle.unresolved_risks.some((item) => item.tag === "TODO"));
  assert.ok(first.bundle.conflict_hints.some((item) =>
    item.session_id === "sess_previous"
    && item.overlap_files.includes("src/core/session.js")
  ));

  const paths = getSessionArtifactPaths(root, session.sessionId);
  await assert.doesNotReject(() => fs.access(paths.handoffJsonPath));
  const markdown = await fs.readFile(paths.handoffMarkdownPath, "utf8");
  assert.match(markdown, /# Agentify Handoff/);
  assert.match(markdown, /Conflict Hints/);
});

test("runCli handoff writes the latest session bundle as JSON", async () => {
  const root = await setupHandoffRepo();
  const config = await loadConfig(root, { provider: "codex" });
  const session = await forkSession(root, config, { name: "latest handoff" });
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await runCli(["handoff", "--root", root, "--json"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.command, "handoff");
  assert.equal(payload.session_id, session.sessionId);
  assert.equal(payload.json_path, `.agents/session/${session.sessionId}/handoff.json`);
  assert.equal(payload.markdown_path, `.agents/session/${session.sessionId}/handoff.md`);
});
