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
import { forkSession, resolveSessionProvider, resumeSession, validateSessionId } from "../src/core/session.js";
import {
  appendRunSummary,
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
  await fs.writeFile(
    scriptPath,
    `#!/bin/sh
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

      Source transcript: .agentify/session/sess_memory/transcript.md
      We chose JSONL transcripts because they are append-friendly for durable memory capture.

  ────────────────────────────────────────────────────────
EOF
  exit 0
fi
exit 1
`,
    "utf8",
  );
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function modeOf(targetPath) {
  return (await fs.stat(targetPath)).mode & 0o777;
}

function withUmask(t, mask) {
  const previous = process.umask(mask);
  t.after(() => {
    process.umask(previous);
  });
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

test("forkSession writes session artifacts with restrictive permissions", async (t) => {
  if (process.platform === "win32") {
    return;
  }
  withUmask(t, 0o000);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-perms-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const created = await forkSession(root, config, { name: "permissions" });

  assert.equal(await modeOf(created.sessionDir), 0o700);
  for (const artifact of ["session-manifest.json", "checklist.json", "context.json", "bootstrap.md"]) {
    assert.equal(await modeOf(path.join(created.sessionDir, artifact)), 0o600, artifact);
  }
});

test("resolveSessionProvider supports legacy tool manifests", () => {
  assert.equal(resolveSessionProvider({ tool: "claude" }, "local"), "claude");
  assert.equal(resolveSessionProvider({ provider: "gemini" }, "local"), "gemini");
  assert.equal(resolveSessionProvider({}, "local"), "local");
});

test("forkSession enforces bootstrap and context size caps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-caps-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.mkdir(path.join(root, ".agentify"), { recursive: true });
  const db = openIndexDatabase(root);
  try {
    inTransaction(db, () => {
      writeRepositoryIndex(
        db,
        {
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
        },
        {
          headCommit: "nogit",
          provider: "codex",
        },
      );
    });
  } finally {
    closeIndexDatabase(db);
  }
  await initGitRepo(root);

  const config = await loadConfig(root, {
    provider: "codex",
    sessionBootstrapMaxKb: 1,
    sessionContextMaxKb: 1,
  });
  config.session.bootstrapMaxKb = 1;
  config.session.contextMaxKb = 1;

  const parent = await forkSession(root, config, { name: "parent" });
  const largeChecklist = Array.from({ length: 24 }, (_, index) => ({
    done: index % 2 === 0,
    text: `task-${index} ${"x".repeat(180)}`,
  }));
  await fs.writeFile(
    path.join(parent.sessionDir, "checklist.json"),
    `${JSON.stringify(largeChecklist, null, 2)}\n`,
    "utf8",
  );

  const result = await forkSession(root, config, {
    from: parent.sessionId,
    startHere: `- ${"read-this ".repeat(400)}`,
    parentSummary: "summary ".repeat(800),
  });
  const resumed = await resumeSession(root, result.sessionId);

  assert.ok(Buffer.byteLength(resumed.bootstrap, "utf8") <= 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(resumed.context), "utf8") <= 1024);
  assert.equal(result.manifest.metadata.bootstrap_truncated, true);
  assert.equal(result.manifest.metadata.context_truncated, true);
  assert.match(resumed.bootstrap, /host shell -> \.agentify\/index\.db/);
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
  await fs.writeFile(
    paths.transcriptPath,
    [
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
      "",
    ].join("\n"),
    "utf8",
  );

  const child = await forkSession(root, config, { from: parent.sessionId, name: "child" });
  const memory = await loadAutomaticSessionMemory(root, child.manifest, config);

  assert.equal(memory.sourceSessionId, parent.sessionId);
  assert.match(memory.markdown, /Automatic Session Memory/);
  assert.match(memory.markdown, /Refresh after the wrapped command commit lands/);
  assert.match(memory.markdown, new RegExp(parent.sessionId));
});

test("appendRunSummary retries when the session lock is temporarily unreadable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-lock-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const session = await forkSession(root, config, { name: "lock-race" });
  const paths = getSessionArtifactPaths(root, session.sessionId);
  await fs.writeFile(paths.lockPath, "{", "utf8");

  const unlock = setTimeout(() => {
    fs.unlink(paths.lockPath).catch(() => {});
  }, 50);
  try {
    const result = await appendRunSummary(
      root,
      session.sessionId,
      {
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        task: "retry lock",
        assistant_summary: "lock recovered",
        exit_code: 0,
        validation: "passed",
        phase: "complete",
        memory_backend: "none",
      },
      config,
    );

    assert.ok(result);
    assert.equal(result.run_history.at(-1).assistant_summary, "lock recovered");
  } finally {
    clearTimeout(unlock);
    await fs.unlink(paths.lockPath).catch(() => {});
  }
});

test("loadAutomaticSessionMemory searches older sessions when the direct parent is not relevant", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-search-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const earlier = await forkSession(root, config, { name: "jsonl-decision" });
  const earlierPaths = getSessionArtifactPaths(root, earlier.sessionId);
  await fs.writeFile(
    earlierPaths.transcriptPath,
    [
      "# Agentify Session Run",
      "",
      "> Current task",
      "Choose a durable transcript format for session memory.",
      "",
      "> Provider response",
      "Use JSONL transcripts because they append cleanly and are easier for memory miners to ingest later.",
      "",
    ].join("\n"),
    "utf8",
  );

  const parent = await forkSession(root, config, { name: "refresh-fix" });
  const parentPaths = getSessionArtifactPaths(root, parent.sessionId);
  await fs.writeFile(
    parentPaths.transcriptPath,
    [
      "# Agentify Session Run",
      "",
      "> Current task",
      "Fix refresh after commits.",
      "",
      "> Provider response",
      "Refresh after the wrapped command exits.",
      "",
    ].join("\n"),
    "utf8",
  );

  const child = await forkSession(root, config, { from: parent.sessionId, name: "new-task" });
  const emptyBinDir = path.join(root, "empty-bin");
  await fs.mkdir(emptyBinDir, { recursive: true });
  const originalPath = process.env.PATH;
  const originalCmd = process.env.AGENTIFY_MEMPALACE_CMD;
  process.env.PATH = emptyBinDir;
  process.env.AGENTIFY_MEMPALACE_CMD = path.join(root, "missing-mempalace");
  try {
    const memory = await loadAutomaticSessionMemory(
      root,
      child.manifest,
      config,
      "why did we choose JSONL transcripts",
    );

    assert.equal(memory.backend, "local-session-search");
    assert.equal(memory.sourceSessionId, earlier.sessionId);
    assert.match(memory.markdown, /Source transcript:/);
    assert.match(memory.markdown, /JSONL transcripts because they append cleanly/);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalCmd === undefined) {
      delete process.env.AGENTIFY_MEMPALACE_CMD;
    } else {
      process.env.AGENTIFY_MEMPALACE_CMD = originalCmd;
    }
  }
});

test("loadAutomaticRunMemory uses MemPalace automatically when the CLI is available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-run-memory-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const session = await forkSession(root, config, { name: "memory" });
  const paths = getSessionArtifactPaths(root, session.sessionId);
  await fs.writeFile(
    paths.transcriptPath,
    [
      "# Agentify Session Run",
      "",
      "> Current task",
      "Pick a durable transcript format.",
      "",
      "> Provider response",
      "Use JSONL transcripts because they are append-friendly for durable memory capture.",
      "",
    ].join("\n"),
    "utf8",
  );

  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "mempalace-calls.log");
  await fs.mkdir(binDir, { recursive: true });
  await installFakeMemPalace(binDir, logPath);

  const originalPath = process.env.PATH;
  const originalCmd = process.env.AGENTIFY_MEMPALACE_CMD;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.AGENTIFY_MEMPALACE_CMD = path.join(root, "missing-mempalace");
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
    if (originalCmd === undefined) {
      delete process.env.AGENTIFY_MEMPALACE_CMD;
    } else {
      process.env.AGENTIFY_MEMPALACE_CMD = originalCmd;
    }
  }
});

async function installMemPalaceShim(binDir, searchStdout) {
  const stdoutPath = path.join(binDir, "search-stdout.txt");
  await fs.writeFile(stdoutPath, searchStdout, "utf8");
  const scriptPath = path.join(binDir, "mempalace");
  await fs.writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
if [ "$1" = "mine" ]; then
  mkdir -p "\${MEMPALACE_PALACE_PATH}"
  echo "mined"
  exit 0
fi
if [ "$1" = "search" ]; then
  cat "${stdoutPath}"
  exit 0
fi
exit 1
`,
    "utf8",
  );
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function installFailingMineMemPalaceShim(binDir) {
  const scriptPath = path.join(binDir, "mempalace");
  await fs.writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
if [ "$1" = "mine" ]; then
  echo "mine failed" >&2
  exit 42
fi
if [ "$1" = "search" ]; then
  if [ ! -f "\${MEMPALACE_PALACE_PATH}/last-good-index.txt" ]; then
    echo "No palace found at \${MEMPALACE_PALACE_PATH}"
    exit 0
  fi
  cat <<'EOF'
============================================================
  Results for: "jsonl transcript decision"
============================================================

  [1] agentify / previous-good-index
      Source: sess_previous.md
      Match:  0.97

      The previous good index still recalls JSONL transcript decisions.
EOF
  exit 0
fi
exit 1
`,
    "utf8",
  );
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function setupMemPalaceTestRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mp-guard-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);
  const config = await loadConfig(root, { provider: "codex" });
  const session = await forkSession(root, config, { name: "memory" });
  const paths = getSessionArtifactPaths(root, session.sessionId);
  await fs.writeFile(
    paths.transcriptPath,
    [
      "# Agentify Session Run",
      "",
      "> Current task",
      "Pick a transcript format.",
      "",
      "> Provider response",
      "Use JSONL transcripts because they are append-friendly for durable memory capture.",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, config };
}

test("loadAutomaticRunMemory rejects MemPalace stdout that reports a missing palace", async () => {
  const { root, config } = await setupMemPalaceTestRepo();
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  await installMemPalaceShim(
    binDir,
    [
      "  No palace found at /tmp/agentify-test/.agentify/mempalace/palace",
      "  Run: mempalace init <dir> then mempalace mine <dir>",
      "",
    ].join("\n"),
  );

  const originalPath = process.env.PATH;
  const originalCmd = process.env.AGENTIFY_MEMPALACE_CMD;
  process.env.PATH = `${binDir}:${originalPath}`;
  delete process.env.AGENTIFY_MEMPALACE_CMD;
  try {
    const memory = await loadAutomaticRunMemory(root, "transcript decision query", config);
    assert.notEqual(memory.backend, "mempalace", "MemPalace must not be selected when stdout reports no palace");
    if (memory.markdown) {
      assert.doesNotMatch(memory.markdown, /No palace found/);
      assert.doesNotMatch(memory.markdown, /mempalace init/);
    }
  } finally {
    process.env.PATH = originalPath;
    if (originalCmd === undefined) {
      delete process.env.AGENTIFY_MEMPALACE_CMD;
    } else {
      process.env.AGENTIFY_MEMPALACE_CMD = originalCmd;
    }
  }
});

test("loadAutomaticRunMemory rejects MemPalace stdout that contains zero result rows", async () => {
  const { root, config } = await setupMemPalaceTestRepo();
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  await installMemPalaceShim(
    binDir,
    [
      "============================================================",
      '  Results for: "transcript decision query"',
      "  Wing: agentify",
      "============================================================",
      "",
      "",
    ].join("\n"),
  );

  const originalPath = process.env.PATH;
  const originalCmd = process.env.AGENTIFY_MEMPALACE_CMD;
  process.env.PATH = `${binDir}:${originalPath}`;
  delete process.env.AGENTIFY_MEMPALACE_CMD;
  try {
    const memory = await loadAutomaticRunMemory(root, "transcript decision query", config);
    assert.notEqual(memory.backend, "mempalace", "MemPalace must not be selected when no result rows are present");
    const sync = JSON.parse(await fs.readFile(path.join(root, ".agentify", "mempalace", "session-sync.json"), "utf8"));
    assert.equal(sync.transcript_count, 1);
    await fs.access(path.join(root, ".agentify", "mempalace", "palace"));
  } finally {
    process.env.PATH = originalPath;
    if (originalCmd === undefined) {
      delete process.env.AGENTIFY_MEMPALACE_CMD;
    } else {
      process.env.AGENTIFY_MEMPALACE_CMD = originalCmd;
    }
  }
});

test("loadAutomaticRunMemory preserves the previous MemPalace index when refresh mining fails", async () => {
  const { root, config } = await setupMemPalaceTestRepo();
  const mempalaceDir = path.join(root, ".agentify", "mempalace");
  const palacePath = path.join(mempalaceDir, "palace");
  const exportDir = path.join(mempalaceDir, "session-exports");
  await fs.mkdir(palacePath, { recursive: true });
  await fs.mkdir(exportDir, { recursive: true });
  await fs.writeFile(path.join(palacePath, "last-good-index.txt"), "previous palace\n", "utf8");
  await fs.writeFile(path.join(exportDir, "last-good-export.md"), "previous export\n", "utf8");
  await fs.writeFile(
    path.join(mempalaceDir, "session-sync.json"),
    `${JSON.stringify(
      {
        schema_version: "1.0",
        fingerprint: "stale-fingerprint",
        transcript_count: 1,
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  await installFailingMineMemPalaceShim(binDir);

  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);

  const originalPath = process.env.PATH;
  const originalCmd = process.env.AGENTIFY_MEMPALACE_CMD;
  process.env.PATH = `${binDir}:${originalPath}`;
  delete process.env.AGENTIFY_MEMPALACE_CMD;
  try {
    const memory = await loadAutomaticRunMemory(root, "jsonl transcript decision", config);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(memory.backend, "mempalace");
    assert.match(memory.markdown, /previous MemPalace index/);
    assert.match(memory.markdown, /previous good index still recalls JSONL transcript decisions/);
    assert.equal(await fs.readFile(path.join(palacePath, "last-good-index.txt"), "utf8"), "previous palace\n");
    assert.equal(await fs.readFile(path.join(exportDir, "last-good-export.md"), "utf8"), "previous export\n");
    assert.ok(
      warnings.some(
        (warning) =>
          warning.code === "AGENTIFY_MEMPALACE_DEGRADED" &&
          /refresh failed; keeping the previous index/.test(warning.message),
      ),
    );
  } finally {
    process.off("warning", onWarning);
    process.env.PATH = originalPath;
    if (originalCmd === undefined) {
      delete process.env.AGENTIFY_MEMPALACE_CMD;
    } else {
      process.env.AGENTIFY_MEMPALACE_CMD = originalCmd;
    }
  }
});

test("loadAutomaticRunMemory exercises the real MemPalace CLI when available", async (t) => {
  const candidate = process.env.AGENTIFY_MEMPALACE_CMD || "mempalace";
  let probeOk = false;
  try {
    await execFileAsync(candidate, ["--version"]);
    probeOk = true;
  } catch {
    /* not available */
  }
  if (!probeOk) {
    t.skip(`real mempalace not invokable (set AGENTIFY_MEMPALACE_CMD or place mempalace on PATH; tried ${candidate})`);
    return;
  }

  const { root, config } = await setupMemPalaceTestRepo();
  const originalCmd = process.env.AGENTIFY_MEMPALACE_CMD;
  process.env.AGENTIFY_MEMPALACE_CMD = candidate;
  try {
    const memory = await loadAutomaticRunMemory(root, "JSONL transcript decision", config);
    assert.equal(memory.backend, "mempalace");
    assert.match(memory.markdown, /Backend: mempalace/);
    assert.match(
      memory.markdown,
      /JSONL transcripts/i,
      "excerpt should contain the seeded term from the synthetic transcript",
    );
  } finally {
    if (originalCmd === undefined) {
      delete process.env.AGENTIFY_MEMPALACE_CMD;
    } else {
      process.env.AGENTIFY_MEMPALACE_CMD = originalCmd;
    }
  }
});

test("normalizeInteractiveCapture strips script noise and ANSI sequences", () => {
  const normalized = normalizeInteractiveCapture(
    "\u0004\u0008\u0008Script started on now\n\u001b[31mhello\u001b[0m\r\nScript done on later\n",
  );
  assert.equal(normalized, "hello");
});

test("validateSessionId accepts generated ids and rejects path-like values", () => {
  assert.equal(validateSessionId("sess_20260101000000_abcdef"), "sess_20260101000000_abcdef");
  assert.equal(validateSessionId("safe-id_42"), "safe-id_42");

  for (const bad of [
    "",
    "../escape",
    "a/../b",
    "a/b",
    "a\\b",
    "/abs/path",
    ".hidden",
    "..",
    "with space",
    "has.dot",
    "_leading-underscore",
    "-leading-dash",
  ]) {
    assert.throws(() => validateSessionId(bad), /Invalid session id/, `expected ${JSON.stringify(bad)} to be rejected`);
  }

  assert.throws(() => validateSessionId(null), /Invalid session id/);
  assert.throws(() => validateSessionId(123), /Invalid session id/);
  assert.throws(() => validateSessionId("a".repeat(200)), /Invalid session id/);
});

test("resumeSession refuses path traversal ids before touching disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-traversal-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-probe-"));
  await fs.writeFile(path.join(probeDir, "session-manifest.json"), JSON.stringify({ session_id: "forged" }));
  await fs.writeFile(path.join(probeDir, "context.json"), JSON.stringify({}));
  await fs.writeFile(path.join(probeDir, "bootstrap.md"), "forged");

  const relativeAttack = path.relative(path.join(root, ".agentify", "session"), probeDir);

  for (const malicious of [relativeAttack, "../escape", "a/../b", "/abs", "with space"]) {
    await assert.rejects(
      () => resumeSession(root, malicious),
      /Invalid session id/,
      `expected ${JSON.stringify(malicious)} to be rejected`,
    );
  }
});

test("resumeSession rejects manifests whose session_id does not match the directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-mismatch-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });
  const created = await forkSession(root, config, { name: "real" });

  const manifestPath = path.join(created.sessionDir, "session-manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.session_id = "sess_forged_id";
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  await assert.rejects(() => resumeSession(root, created.sessionId), /does not match requested id/);
});

test("forkSession rejects path-like parent ids and mismatched parent manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-session-fork-traversal-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await initGitRepo(root);

  const config = await loadConfig(root, { provider: "codex" });

  for (const malicious of ["../escape", "a/../b", "/abs", "with space", ".."]) {
    await assert.rejects(
      () => forkSession(root, config, { from: malicious }),
      /Invalid parent session id/,
      `expected ${JSON.stringify(malicious)} to be rejected`,
    );
  }

  const parent = await forkSession(root, config, { name: "parent" });
  const parentManifestPath = path.join(parent.sessionDir, "session-manifest.json");
  const parentManifest = JSON.parse(await fs.readFile(parentManifestPath, "utf8"));
  parentManifest.session_id = "sess_forged_parent";
  await fs.writeFile(parentManifestPath, JSON.stringify(parentManifest, null, 2));

  await assert.rejects(() => forkSession(root, config, { from: parent.sessionId }), /does not match requested id/);
});
