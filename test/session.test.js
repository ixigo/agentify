import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/core/config.js";
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
