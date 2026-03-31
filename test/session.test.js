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

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
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
  assert.match(resumed.bootstrap, /\.agents\/index\.db/);
  assert.ok((resumed.context.index_snapshot.truncated_module_ids || 0) > 0);
  assert.ok((resumed.context.checklist_summary.remaining_items || 0) > 0);
});
