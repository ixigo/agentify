import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  COMPLETION_SPEC,
  getCompletionCommandNames,
  getCompletionSubcommandNames,
  listCompletionValues,
  renderCompletionScript,
} from "../src/core/completion.js";
import { SUPPORTED_PROVIDERS } from "../src/core/provider-command.js";
import { listBuiltinSkills } from "../src/core/skills.js";
import { runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

async function captureStdout(fn) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function write(chunk, encoding, callback) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  };

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join("");
}

async function makeSession(root, sessionId, createdAt) {
  const sessionDir = path.join(root, ".agentify", "session", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "session-manifest.json"),
    JSON.stringify({
      session_id: sessionId,
      provider: "codex",
      created_at: createdAt,
    }),
    "utf8",
  );
}

test("completion generators emit non-empty scripts with command completions", () => {
  for (const shell of ["zsh", "bash", "fish"]) {
    const script = renderCompletionScript(shell);

    assert.ok(script.length > 100, `${shell} completion should not be empty`);
    assert.match(script, /agentify/, `${shell} script should reference agentify`);
    assert.match(script, /run/, `${shell} script should include run completion`);
    assert.match(script, /context/, `${shell} script should include context completion`);
    assert.match(script, /skill/, `${shell} script should include skill completion`);
    assert.match(script, /completion values providers/, `${shell} script should call provider values endpoint`);
  }
});

test("completion metadata pins representative commands, subcommands, and flags", () => {
  const commands = getCompletionCommandNames();
  for (const command of ["run", "context", "skill", "sess", "completion"]) {
    assert.ok(commands.includes(command), `missing command completion for ${command}`);
  }

  assert.ok(getCompletionSubcommandNames("context").includes("search"), "missing context search completion");
  assert.ok(getCompletionSubcommandNames("context").includes("fetch"), "missing context fetch completion");
  assert.ok(getCompletionSubcommandNames("skill").includes("install"), "missing skill install completion");
  assert.ok(getCompletionSubcommandNames("sess").includes("resume"), "missing sess resume completion");

  for (const flag of ["--provider", "--root", "--context-mode", "--caveman"]) {
    assert.ok(COMPLETION_SPEC.flags.includes(flag), `missing flag completion for ${flag}`);
  }
});

test("provider completion values come from the provider source of truth", async () => {
  const values = await listCompletionValues("providers");

  assert.deepEqual(values, SUPPORTED_PROVIDERS);
});

test("skill completion values include built-in skill names", async () => {
  const values = await listCompletionValues("skills");
  const builtIns = listBuiltinSkills().map((skill) => skill.name);

  assert.deepEqual(values, builtIns);
  assert.ok(values.includes("gh-autopilot"));
});

test("session completion values return ids and degrade silently for missing state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-completion-sessions-"));

  assert.deepEqual(await listCompletionValues("sessions", { root }), []);

  await makeSession(root, "sess_20260507093000_newest", "2026-05-07T09:30:00.000Z");
  await makeSession(root, "sess_20260507091500_older", "2026-05-07T09:15:00.000Z");

  assert.deepEqual(await listCompletionValues("sessions", { root }), [
    "sess_20260507093000_newest",
    "sess_20260507091500_older",
  ]);

  await fs.writeFile(
    path.join(root, ".agentify", "session", "sess_20260507093000_newest", "session-manifest.json"),
    "{not-json",
    "utf8",
  );

  assert.deepEqual(await listCompletionValues("sessions", { root }), []);
});

test("runCli prints completion scripts and dynamic values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-completion-cli-"));
  await makeSession(root, "sess_20260507100000_cli", "2026-05-07T10:00:00.000Z");

  const zshScript = await captureStdout(() => runCli(["completion", "zsh", "--root", root]));
  assert.match(zshScript, /#compdef agentify/);
  assert.match(zshScript, /completion values providers/);

  const bashScript = await captureStdout(() => runCli(["completion", "bash", "--root", root]));
  assert.match(bashScript, /complete -F _agentify_completion agentify/);

  const fishScript = await captureStdout(() => runCli(["completion", "fish", "--root", root]));
  assert.match(fishScript, /complete -c agentify/);

  const providers = await captureStdout(() => runCli(["completion", "values", "providers", "--root", root]));
  for (const provider of SUPPORTED_PROVIDERS) {
    assert.match(providers, new RegExp(`(^|\\n)${provider}(\\n|$)`));
  }

  const skills = await captureStdout(() => runCli(["completion", "values", "skills", "--root", root]));
  assert.match(skills, /gh-autopilot/);

  const sessions = await captureStdout(() => runCli(["completion", "values", "sessions", "--root", root]));
  assert.equal(sessions, "sess_20260507100000_cli\n");
});

test("zsh completion reaches dynamic branches before generic subcommand cases", () => {
  const zshScript = renderCompletionScript("zsh");
  const dynamicBranchIndex = zshScript.indexOf("skill|skills|sess|session");
  const genericSkillCaseIndex = zshScript.indexOf("      skill) _values 'subcommands'");

  assert.notEqual(dynamicBranchIndex, -1);
  assert.notEqual(genericSkillCaseIndex, -1);
  assert.ok(dynamicBranchIndex < genericSkillCaseIndex);
  assert.match(zshScript, /\$\(agentify completion values skills 2>\/dev\/null\)/);
  assert.match(zshScript, /\$\(agentify completion values sessions 2>\/dev\/null\)/);
});

test("cli completion command suppresses banner after global flags", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-completion-root-"));
  const result = await execFileAsync(process.execPath, ["src/cli.js", "--root", root, "completion", "zsh"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
  });

  assert.match(result.stdout, /^#compdef agentify/);
  assert.equal(result.stderr, "");
});
