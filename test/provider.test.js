import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProvider, parseCodexJsonl, ProviderExecutionError, runChild } from "../src/core/provider.js";

test("parseCodexJsonl extracts token usage from turn.completed", () => {
  const usage = parseCodexJsonl(
    [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"{\\"ok\\":true}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":30,"output_tokens":45}}',
    ].join("\n"),
  );

  assert.deepEqual(usage, {
    input_tokens: 120,
    output_tokens: 45,
    total_tokens: 165,
  });
});

test("runChild times out stalled provider subprocesses", async () => {
  await assert.rejects(
    () =>
      runChild("node", ["-e", "setInterval(() => {}, 1000);"], {
        timeoutMs: 50,
      }),
    /timed out after 50ms/,
  );
});

test("runChild closes provider stdin when prompt is passed through argv", async () => {
  const result = await runChild(
    "node",
    [
      "-e",
      ["process.stdin.resume();", "process.stdin.on('end', () => process.stdout.write('stdin closed'));"].join(""),
    ],
    {
      timeoutMs: 1000,
    },
  );

  assert.equal(result.stdout, "stdin closed");
});

test("runChild sanitizes provider subprocess env by default", async () => {
  const previousSecret = process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET;
  const previousAllowed = process.env.AGENTIFY_PROVIDER_ALLOWED;

  process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET = "secret-value";
  process.env.AGENTIFY_PROVIDER_ALLOWED = "allowed-value";

  try {
    const result = await runChild(
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write(JSON.stringify({",
          "secret: process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET || null,",
          "allowed: process.env.AGENTIFY_PROVIDER_ALLOWED || null,",
          "extra: process.env.AGENTIFY_PROVIDER_EXTRA || null",
          "}));",
        ].join(""),
      ],
      {
        providerEnv: {
          passthrough: ["AGENTIFY_PROVIDER_ALLOWED"],
          extra: {
            AGENTIFY_PROVIDER_EXTRA: "extra-value",
          },
        },
        timeoutMs: 1000,
      },
    );

    assert.deepEqual(JSON.parse(result.stdout), {
      secret: null,
      allowed: "allowed-value",
      extra: "extra-value",
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET;
    } else {
      process.env.AGENTIFY_PROVIDER_SENTINEL_SECRET = previousSecret;
    }
    if (previousAllowed === undefined) {
      delete process.env.AGENTIFY_PROVIDER_ALLOWED;
    } else {
      process.env.AGENTIFY_PROVIDER_ALLOWED = previousAllowed;
    }
  }
});

test("runChild preserves standard proxy env by default", async () => {
  const previousHttpProxy = process.env.HTTP_PROXY;
  const previousHttpsProxy = process.env.HTTPS_PROXY;
  const previousNoProxy = process.env.NO_PROXY;
  const previousLowerHttpProxy = process.env.http_proxy;
  const previousLowerHttpsProxy = process.env.https_proxy;
  const previousLowerNoProxy = process.env.no_proxy;

  process.env.HTTP_PROXY = "http://proxy.local:8080";
  process.env.HTTPS_PROXY = "https://proxy.local:8443";
  process.env.NO_PROXY = "localhost,127.0.0.1";
  process.env.http_proxy = "http://lower-proxy.local:8080";
  process.env.https_proxy = "https://lower-proxy.local:8443";
  process.env.no_proxy = "example.test";

  try {
    const result = await runChild(
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write(JSON.stringify({",
          "HTTP_PROXY: process.env.HTTP_PROXY || null,",
          "HTTPS_PROXY: process.env.HTTPS_PROXY || null,",
          "NO_PROXY: process.env.NO_PROXY || null,",
          "http_proxy: process.env.http_proxy || null,",
          "https_proxy: process.env.https_proxy || null,",
          "no_proxy: process.env.no_proxy || null",
          "}));",
        ].join(""),
      ],
      {
        timeoutMs: 1000,
      },
    );

    assert.deepEqual(JSON.parse(result.stdout), {
      HTTP_PROXY: "http://proxy.local:8080",
      HTTPS_PROXY: "https://proxy.local:8443",
      NO_PROXY: "localhost,127.0.0.1",
      http_proxy: "http://lower-proxy.local:8080",
      https_proxy: "https://lower-proxy.local:8443",
      no_proxy: "example.test",
    });
  } finally {
    for (const [key, value] of [
      ["HTTP_PROXY", previousHttpProxy],
      ["HTTPS_PROXY", previousHttpsProxy],
      ["NO_PROXY", previousNoProxy],
      ["http_proxy", previousLowerHttpProxy],
      ["https_proxy", previousLowerHttpsProxy],
      ["no_proxy", previousLowerNoProxy],
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

async function assertPathMissing(targetPath) {
  await assert.rejects(
    () => fs.access(targetPath),
    (error) => error?.code === "ENOENT",
  );
}

function restoreEnvValue(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("codex provider removes its temp directory after successful execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-codex-root-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-codex-bin-"));
  const codexPath = path.join(binDir, "codex");
  const tempDirRecordPath = path.join(root, "codex-temp-dir.txt");

  await fs.writeFile(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const outputPath = process.argv[process.argv.indexOf("--output-last-message") + 1];
fs.writeFileSync(path.join(process.cwd(), "codex-temp-dir.txt"), path.dirname(outputPath));
fs.writeFileSync(outputPath, JSON.stringify({
  repo_summary: "Codex fixture",
  shared_conventions: [],
  module_focus: [{ module_id: "auth", focus: "Keep auth simple." }]
}));
process.stdout.write(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 4, output_tokens: 2 }
}) + "\\n");
`,
    "utf8",
  );
  await fs.chmod(codexPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;

  try {
    const provider = createProvider("codex");
    const result = await provider.buildManagerPlan({
      repoName: "agentify-fixture",
      root,
      defaultStack: "ts",
      stacks: [{ name: "ts", confidence: 1 }],
      entrypoints: [],
      modules: [{ id: "auth", rootPath: "src/auth" }],
      sampleFiles: [],
    });

    assert.equal(result.plan.repo_summary, "Codex fixture");
    assert.deepEqual(result.tokenUsage, {
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: 6,
    });
    const tempDir = await fs.readFile(tempDirRecordPath, "utf8");
    assert.match(tempDir, /agentify-codex-/);
    await assertPathMissing(tempDir);
  } finally {
    restoreEnvValue("PATH", previousPath);
  }
});

test("codex provider still succeeds when temp cleanup fails after successful execution", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-codex-cleanup-root-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-codex-cleanup-bin-"));
  const codexPath = path.join(binDir, "codex");
  const tempDirRecordPath = path.join(root, "codex-temp-dir.txt");
  let tempDir = null;

  await fs.writeFile(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const outputPath = process.argv[process.argv.indexOf("--output-last-message") + 1];
fs.writeFileSync(path.join(process.cwd(), "codex-temp-dir.txt"), path.dirname(outputPath));
fs.writeFileSync(outputPath, JSON.stringify({
  repo_summary: "Codex fixture",
  shared_conventions: [],
  module_focus: [{ module_id: "auth", focus: "Keep auth simple." }]
}));
`,
    "utf8",
  );
  await fs.chmod(codexPath, 0o755);

  const previousPath = process.env.PATH;
  const originalRm = fs.rm;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  t.mock.method(fs, "rm", async (targetPath, options) => {
    if (String(targetPath).includes("agentify-codex-")) {
      tempDir = String(targetPath);
      throw Object.assign(new Error("cleanup busy"), { code: "EBUSY" });
    }
    return originalRm(targetPath, options);
  });
  t.after(async () => {
    restoreEnvValue("PATH", previousPath);
    if (tempDir) {
      await originalRm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  const provider = createProvider("codex");
  const result = await provider.buildManagerPlan({
    repoName: "agentify-fixture",
    root,
    defaultStack: "ts",
    stacks: [{ name: "ts", confidence: 1 }],
    entrypoints: [],
    modules: [{ id: "auth", rootPath: "src/auth" }],
    sampleFiles: [],
  });

  assert.equal(result.plan.repo_summary, "Codex fixture");
  tempDir = await fs.readFile(tempDirRecordPath, "utf8");
  assert.match(tempDir, /agentify-codex-/);
});

test("codex provider removes its temp directory after failed execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-codex-root-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-codex-bin-"));
  const codexPath = path.join(binDir, "codex");
  const tempDirRecordPath = path.join(root, "codex-temp-dir.txt");

  await fs.writeFile(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const outputPath = process.argv[process.argv.indexOf("--output-last-message") + 1];
fs.writeFileSync(path.join(process.cwd(), "codex-temp-dir.txt"), path.dirname(outputPath));
process.stderr.write("codex fixture failed");
process.exit(7);
`,
    "utf8",
  );
  await fs.chmod(codexPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;

  try {
    const provider = createProvider("codex");
    await assert.rejects(
      () =>
        provider.buildManagerPlan({
          repoName: "agentify-fixture",
          root,
          defaultStack: "ts",
          stacks: [{ name: "ts", confidence: 1 }],
          entrypoints: [],
          modules: [{ id: "auth", rootPath: "src/auth" }],
          sampleFiles: [],
        }),
      (error) => {
        assert.equal(error instanceof ProviderExecutionError, true);
        assert.equal(error.provider, "codex");
        assert.equal(error.phase, "manager planning");
        assert.match(error.message, /failed with code 7/);
        assert.match(error.message, /codex fixture failed/);
        return true;
      },
    );

    const tempDir = await fs.readFile(tempDirRecordPath, "utf8");
    assert.match(tempDir, /agentify-codex-/);
    await assertPathMissing(tempDir);
  } finally {
    restoreEnvValue("PATH", previousPath);
  }
});

test("external provider manager planning surfaces unavailable provider failures", async () => {
  const provider = createProvider("codex");
  const previousPath = process.env.PATH;
  process.env.PATH = "";

  try {
    await assert.rejects(
      () =>
        provider.buildManagerPlan({
          repoName: "agentify-fixture",
          root: process.cwd(),
          defaultStack: "ts",
          stacks: [{ name: "ts", confidence: 1 }],
          entrypoints: [],
          modules: [{ id: "auth", rootPath: "src/auth" }],
          sampleFiles: [],
        }),
      (error) => {
        assert.equal(error instanceof ProviderExecutionError, true);
        assert.equal(error.code, "AGENTIFY_PROVIDER_EXECUTION_FAILED");
        assert.equal(error.provider, "codex");
        assert.equal(error.phase, "manager planning");
        assert.equal(error.status, "error");
        assert.match(error.message, /spawn codex ENOENT/);
        return true;
      },
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test("external provider module generation surfaces unavailable provider failures", async () => {
  const provider = createProvider("codex");
  const previousPath = process.env.PATH;
  process.env.PATH = "";

  try {
    await assert.rejects(
      () =>
        provider.generateModuleArtifacts(
          { id: "auth", name: "auth", rootPath: "src/auth", stack: "ts", slug: "auth" },
          {
            root: process.cwd(),
            files: [{ path: "src/auth/index.ts", content: "export const login = () => true;" }],
            semantic: null,
            keyFiles: ["src/auth/index.ts"],
            dependsOn: [],
            usedBy: [],
            now: "2026-04-06T00:00:00.000Z",
            headCommit: "deadbeef",
            managerPlan: {
              repo_summary: "",
              shared_conventions: [],
              module_focus: [],
            },
            managerFocus: "",
          },
        ),
      (error) => {
        assert.equal(error instanceof ProviderExecutionError, true);
        assert.equal(error.code, "AGENTIFY_PROVIDER_EXECUTION_FAILED");
        assert.equal(error.provider, "codex");
        assert.equal(error.phase, "module artifact generation");
        assert.equal(error.status, "error");
        assert.match(error.message, /spawn codex ENOENT/);
        return true;
      },
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test("gemini provider execution preserves the readiness credential home", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-gemini-root-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-provider-gemini-bin-"));
  const geminiPath = path.join(binDir, "gemini");
  const loginHome = path.join(root, "gemini-login-home");
  const shellHome = path.join(root, "shell-home");

  await fs.mkdir(loginHome, { recursive: true });
  await fs.mkdir(shellHome, { recursive: true });
  await fs.writeFile(
    geminiPath,
    `#!/usr/bin/env node
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
`,
    "utf8",
  );
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
      total_tokens: 6,
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
