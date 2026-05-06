import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { generateCompletionScript, getCompletionValues } from "../src/core/completion.js";
import { SUPPORTED_PROVIDERS } from "../src/core/provider-command.js";
import { forkSession } from "../src/core/session.js";
import { listBuiltinSkills } from "../src/core/skills.js";
import { runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

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

test("generateCompletionScript prints zsh, bash, and fish scripts from one metadata source", () => {
  const zsh = generateCompletionScript("zsh");
  const bash = generateCompletionScript("bash");
  const fish = generateCompletionScript("fish");

  assert.match(zsh, /^#compdef agentify/);
  assert.match(zsh, /agentify completion values "\$1" --root "\$PWD"/);
  assert.match(zsh, /compadd -- .*'completion'/);
  assert.match(zsh, /compadd -- .*'run'/);
  assert.match(zsh, /compadd -- .*'skill'/);

  assert.match(bash, /complete -F _agentify_completion agentify/);
  assert.match(bash, /agentify completion values "\$1" --root "\$PWD"/);
  assert.match(bash, /'completion'/);
  assert.match(bash, /'run'/);
  assert.match(bash, /'skill'/);

  assert.match(fish, /function __agentify_complete_providers/);
  assert.match(fish, /agentify completion values skills --root \(pwd\)/);
  assert.match(fish, /complete -c agentify .* -a 'completion'/);
  assert.match(fish, /__fish_complete_path/);
});

test("completion values use existing provider and skill sources of truth", async () => {
  assert.deepEqual(await getCompletionValues("providers"), SUPPORTED_PROVIDERS);
  assert.deepEqual(
    await getCompletionValues("skills"),
    listBuiltinSkills().map((skill) => skill.name).sort(),
  );

  const providerOutput = await captureStdout(() => runCli(["completion", "values", "providers"]));
  assert.deepEqual(providerOutput.trim().split("\n"), SUPPORTED_PROVIDERS);

  const skillOutput = await captureStdout(() => runCli(["completion", "values", "skills"]));
  assert.match(skillOutput, /^auto-pilot$/m);
  assert.match(skillOutput, /^worktree-autopilot$/m);
});

test("completion values sessions degrade silently when session state is missing or unreadable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-completion-sessions-"));
  const missingOutput = await captureStdout(() =>
    runCli(["completion", "values", "sessions", "--root", root])
  );
  assert.equal(missingOutput, "");

  await fs.mkdir(path.join(root, ".agents", "session", "broken"), { recursive: true });
  await fs.writeFile(path.join(root, ".agents", "session", "broken", "session-manifest.json"), "{", "utf8");
  const brokenOutput = await captureStdout(() =>
    runCli(["completion", "values", "sessions", "--root", root])
  );
  assert.equal(brokenOutput, "");
});

test("completion values sessions list known session ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-completion-session-list-"));
  const created = await forkSession(root, { provider: "codex" }, { name: "completion test" });

  const output = await captureStdout(() =>
    runCli(["completion", "values", "sessions", "--root", root])
  );

  assert.deepEqual(output.trim().split("\n"), [created.sessionId]);
});

test("cli completion command writes only the script to stdout", async () => {
  const result = await execFileAsync(process.execPath, ["src/cli.js", "completion", "bash"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
  });

  assert.match(result.stdout, /^# bash completion for agentify/);
  assert.equal(result.stderr, "");
});
