import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/core/config.js";
import { closeIndexDatabase, inTransaction, openIndexDatabase, writeRepositoryIndex } from "../src/core/db.js";
import { forkSession, resolveSessionProvider, resumeSession } from "../src/core/session.js";
import {
  getSessionArtifactPaths,
  loadAutomaticRunMemory,
  loadAutomaticSessionMemory,
  normalizeInteractiveCapture,
} from "../src/core/session-memory.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

async function installFakeMemPalace(binDir, logPath) {
  const scriptPath = path.join(binDir, "mempalace");
  await fs.writeFile(scriptPath, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "mine" ]; then
  mkdir -p "\${MEMPALACE_PALACE_PATH}"
  echo "mined"
  exit 0
fi
if [ "$1" = "search" ]; then
  cat <<'EOF'
============================================================
  Results for: "jsonl transcript decision"
============================================================

  [1] agentify / decisions
      Source: sess_memory.md
      Match:  0.98

      Source transcript: .agents/session/sess_memory/transcript.md
      We chose JSONL transcripts because they are append-friendly for durable memory capture.

  ────────────────────────────────────────────────────────
EOF
  exit 0
fi
exit 1
`, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

test("forkSession writes provider in manifest and bootstrap", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const result = await forkSession(root, config, { name: "payments-v2" });
  const resumed = await resumeSession(root, result.sessionId);

  assert.equal(result.manifest.provider, "codex");
  assert.match(resumed.bootstrap, /Provider: codex/);
});

test("resolveSessionProvider supports legacy tool manifests", () => {
  assert.equal(resolveSessionProvider({ tool: "claude" }, "local"), "claude");
  assert.equal(resolveSessionProvider({ provider: "gemini" }, "local"), "gemini");
  assert.equal(resolveSessionProvider({}, "local"), "local");
});

test("forkSession enforces bootstrap and context size caps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-caps-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.mkdir(path.join(root, ".agents"), { recursive: true });
  const db = openIndexDatabase(root);
  try {
    inTransaction(db, () => {
      writeRepositoryIndex(db, {
        generated_at: new Date().toISOString(),
        repo: {
          name: "agentify-session-caps",
          root,
          detected_stacks: [{ name: "ts", confidence: 1 }],
          default_stack: "ts",
          package_manager: "npm",
        },
        modules: Array.from({ length: 80 }, (_, index) => ({
          id: `module-${index}`,
          name: `module-${index}`,
          root_path: `src/module-${index}`,
          stack: "ts",
          package_name: null,
          slug: `module-${index}`,
          doc_path: `docs/modules/module-${index}.md`,
          fingerprint: `fp-${index}`,
          entry_files: [],
          key_files: [],
        })),
        files: [],
        symbols: [],
        imports: [],
        tests: [],
        commands: [],
      }, {
        headCommit: "nogit",
        provider: "codex",
      });
    });
  } finally {
    closeIndexDatabase(db);
  }
  await initGitRepo(root);

  const config = await loadConfig(root, {
    provider: "codex",
    sessionBootstrapMaxKb: 1,
    sessionContextMaxKb: 1
  });
  config.session.bootstrapMaxKb = 1;
  config.session.contextMaxKb = 1;

  const parent = await forkSession(root, config, { name: "parent" });
  const largeChecklist = Array.from({ length: 24 }, (_, index) => ({
    done: index % 2 === 0,
    text: `task-${index} ${"x".repeat(180)}`
  }));
  await fs.writeFile(path.join(parent.sessionDir, "checklist.json"), `${JSON.stringify(largeChecklist, null, 2)}\n`, "utf8");

  const result = await forkSession(root, config, {
    from: parent.sessionId,
    startHere: `- ${"read-this ".repeat(400)}`,
    parentSummary: "summary ".repeat(800)
  });
  const resumed = await resumeSession(root, result.sessionId);

  assert.ok(Buffer.byteLength(resumed.bootstrap, "utf8") <= 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(resumed.context), "utf8") <= 1024);
  assert.equal(result.manifest.metadata.bootstrap_truncated, true);
  assert.equal(result.manifest.metadata.context_truncated, true);
  assert.match(resumed.bootstrap, /host shell -> \.agents\/index\.db/);
  assert.ok((resumed.context.index_snapshot.truncated_module_ids || 0) > 0);
  assert.ok((resumed.context.checklist_summary.remaining_items || 0) > 0);
});

test("loadAutomaticSessionMemory reuses the parent transcript automatically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-memory-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const parent = await forkSession(root, config, { name: "parent" });
  const paths = getSessionArtifactPaths(root, parent.sessionId);
  await fs.writeFile(paths.transcriptPath, [
    "# Agentify Session Run",
    "",
    "> Current task",
    "Investigate why refresh after commits misses the new HEAD.",
    "",
    "> Provider response",
    "The wrapped command updates HEAD before Agentify rescans, so the index still points at the old commit.",
    "",
    "> Current task",
    "Choose the smallest fix.",
    "",
    "> Provider response",
    "Refresh after the wrapped command commit lands, then validate against the new HEAD.",
    ""
  ].join("\n"), "utf8");

  const child = await forkSession(root, config, { from: parent.sessionId, name: "child" });
  const memory = await loadAutomaticSessionMemory(root, child.manifest, config);

  assert.equal(memory.sourceSessionId, parent.sessionId);
  assert.match(memory.markdown, /Automatic Session Memory/);
  assert.match(memory.markdown, /Refresh after the wrapped command commit lands/);
  assert.match(memory.markdown, new RegExp(parent.sessionId));
});

test("loadAutomaticSessionMemory searches older sessions when the direct parent is not relevant", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-search-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const earlier = await forkSession(root, config, { name: "jsonl-decision" });
  const earlierPaths = getSessionArtifactPaths(root, earlier.sessionId);
  await fs.writeFile(earlierPaths.transcriptPath, [
    "# Agentify Session Run",
    "",
    "> Current task",
    "Choose a durable transcript format for session memory.",
    "",
    "> Provider response",
    "Use JSONL transcripts because they append cleanly and are easier for memory miners to ingest later.",
    "",
  ].join("\n"), "utf8");

  const parent = await forkSession(root, config, { name: "refresh-fix" });
  const parentPaths = getSessionArtifactPaths(root, parent.sessionId);
  await fs.writeFile(parentPaths.transcriptPath, [
    "# Agentify Session Run",
    "",
    "> Current task",
    "Fix refresh after commits.",
    "",
    "> Provider response",
    "Refresh after the wrapped command exits.",
    "",
  ].join("\n"), "utf8");

  const child = await forkSession(root, config, { from: parent.sessionId, name: "new-task" });
  const memory = await loadAutomaticSessionMemory(root, child.manifest, config, "why did we choose JSONL transcripts");

  assert.equal(memory.backend, "local-session-search");
  assert.equal(memory.sourceSessionId, earlier.sessionId);
  assert.match(memory.markdown, /Source transcript:/);
  assert.match(memory.markdown, /JSONL transcripts because they append cleanly/);
});

test("loadAutomaticRunMemory uses MemPalace automatically when the CLI is available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-run-memory-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const session = await forkSession(root, config, { name: "memory" });
  const paths = getSessionArtifactPaths(root, session.sessionId);
  await fs.writeFile(paths.transcriptPath, [
    "# Agentify Session Run",
    "",
    "> Current task",
    "Pick a durable transcript format.",
    "",
    "> Provider response",
    "Use JSONL transcripts because they are append-friendly for durable memory capture.",
    "",
  ].join("\n"), "utf8");

  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "mempalace-calls.log");
  await fs.mkdir(binDir, { recursive: true });
  await installFakeMemPalace(binDir, logPath);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    const memory = await loadAutomaticRunMemory(root, "jsonl transcript decision", config);
    const calls = await fs.readFile(logPath, "utf8");

    assert.equal(memory.backend, "mempalace");
    assert.match(memory.markdown, /Backend: mempalace/);
    assert.match(memory.markdown, /repo-local MemPalace session export index/);
    assert.match(memory.markdown, /append-friendly for durable memory capture/);
    assert.match(calls, /^mine /m);
    assert.match(calls, /^search /m);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("normalizeInteractiveCapture strips script noise and ANSI sequences", () => {
  const normalized = normalizeInteractiveCapture("\u0004\u0008\u0008Script started on now\n\u001b[31mhello\u001b[0m\r\nScript done on later\n");
  assert.equal(normalized, "hello");
});
