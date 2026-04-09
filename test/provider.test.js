import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProvider, parseCodexJsonl, runChild } from "../src/core/provider.js";

test("parseCodexJsonl extracts token usage from turn.completed", () => {
  const usage = parseCodexJsonl([
    '{"type":"thread.started","thread_id":"abc"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"{\\"ok\\":true}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":30,"output_tokens":45}}'
  ].join("\n"));

  assert.deepEqual(usage, {
    input_tokens: 120,
    output_tokens: 45,
    total_tokens: 165
  });
});

test("runChild times out stalled provider subprocesses", async () => {
  await assert.rejects(
    () => runChild("node", ["-e", "setInterval(() => {}, 1000);"], {
      timeoutMs: 50,
    }),
    /timed out after 50ms/,
  );
});

test("gemini provider execution preserves the readiness credential home", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-gemini-root-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-gemini-bin-"));
  const geminiPath = path.join(binDir, "gemini");
  const loginHome = path.join(root, "gemini-login-home");
  const shellHome = path.join(root, "shell-home");

  await fs.mkdir(loginHome, { recursive: true });
  await fs.mkdir(shellHome, { recursive: true });
  await fs.writeFile(geminiPath, `#!/usr/bin/env node
const payload = {
  response: JSON.stringify({
    repo_summary: \`HOME=\${process.env.HOME};GEMINI_CLI_HOME=\${process.env.GEMINI_CLI_HOME || ""}\`,
    shared_conventions: [],
    module_focus: [{ module_id: "auth", focus: "Keep Gemini auth state visible." }]
  }),
  stats: {
    models: {
      gemini: {
        tokens: { input: 4, candidates: 2, total: 6 }
      }
    }
  }
};
process.stdout.write(JSON.stringify(payload));
`, "utf8");
  await fs.chmod(geminiPath, 0o755);

  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousGeminiCliHome = process.env.GEMINI_CLI_HOME;

  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  process.env.HOME = shellHome;
  process.env.GEMINI_CLI_HOME = loginHome;

  try {
    const provider = createProvider("gemini");
    const result = await provider.buildManagerPlan({
      repoName: "agentify-fixture",
      root,
      defaultStack: "ts",
      stacks: [{ name: "ts", confidence: 1 }],
      entrypoints: [],
      modules: [{ id: "auth", rootPath: "src/auth" }],
      sampleFiles: [],
    });

    assert.equal(result.plan.repo_summary, `HOME=${loginHome};GEMINI_CLI_HOME=${loginHome}`);
    assert.deepEqual(result.tokenUsage, {
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: 6
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousGeminiCliHome === undefined) {
      delete process.env.GEMINI_CLI_HOME;
    } else {
      process.env.GEMINI_CLI_HOME = previousGeminiCliHome;
    }
  }
});
