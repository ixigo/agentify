import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

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

test("ctx track --hook records a redacted event end-to-end through the real CLI", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-e2e-"));
  try {
    const cacheHome = path.join(root, "global-cache");
    const payload = JSON.stringify({
      session_id: "e2e-session",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "curl -H 'Authorization: Bearer abcdef123456789012' https://api.example.com",
        description: "hit the api",
      },
      tool_response: { exitCode: 0 },
    });

    const result = await runCli(["ctx", "track", "--hook", "--root", root], {
      stdin: payload,
      env: { XDG_CACHE_HOME: cacheHome },
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    // Hook mode must stay silent so it never pollutes the transcript.
    assert.equal(result.stdout, "");

    const eventsPath = path.join(root, ".agentify", "context", "events.jsonl");
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.type, "cmd");
    assert.ok(event.cmd.includes("[REDACTED]"), `expected redacted cmd, got: ${event.cmd}`);
    assert.ok(!event.cmd.includes("abcdef123456789012"));

    const invocations = JSON.parse(await fs.readFile(path.join(cacheHome, "agentify", "invocations.json"), "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(invocations[today]["ctx.track"].hook, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ctx track --hook exits cleanly on malformed stdin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-e2e-"));
  try {
    const result = await runCli(["ctx", "track", "--hook", "--root", root], {
      stdin: "not json {",
      env: { XDG_CACHE_HOME: path.join(root, "global-cache") },
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("AGENTIFY_CTX=off suppresses context writes but not the global invocation tick", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-e2e-paused-"));
  try {
    const cacheHome = path.join(root, "global-cache");
    const payload = JSON.stringify({
      session_id: "paused-session",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { exitCode: 0 },
    });
    const result = await runCli(["ctx", "track", "--hook", "--root", root], {
      stdin: payload,
      env: { AGENTIFY_CTX: "off", XDG_CACHE_HOME: cacheHome },
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    await assert.rejects(fs.access(path.join(root, ".agentify", "context", "events.jsonl")));

    const invocations = JSON.parse(await fs.readFile(path.join(cacheHome, "agentify", "invocations.json"), "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(invocations[today]["ctx.track"].hook, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
