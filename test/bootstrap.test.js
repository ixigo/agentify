import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { probeProviderReadiness, resolveBootstrapInputs, runBootstrapCommand } from "../src/core/bootstrap.js";
import { setSilent } from "../src/core/ui.js";

function ok(stdout = "", stderr = "") {
  return { code: 0, stdout, stderr };
}

function fail(stderr = "") {
  return { code: 1, stdout: "", stderr };
}

function createExecMock({ repoRoot, initialBinaries = [], auth = {}, gitReady = true }) {
  const binaries = new Set(initialBinaries);
  const installs = [];

  function installFormula(name) {
    installs.push(`brew:${name}`);
    if (name === "ripgrep") binaries.add("rg");
    if (name === "fd") binaries.add("fd");
    if (name === "ast-grep") binaries.add("ast-grep");
    if (name === "tree-sitter-cli") binaries.add("tree-sitter");
    if (name === "node") binaries.add("npm");
    if (name === "gemini-cli") binaries.add("gemini");
    if (name === "opencode") binaries.add("opencode");
  }

  function installNpm(pkg) {
    installs.push(`npm:${pkg}`);
    if (pkg === "@openai/codex") binaries.add("codex");
    if (pkg === "@anthropic-ai/claude-code") binaries.add("claude");
  }

  return {
    installs,
    exec: async (argv) => {
      const [cmd, ...args] = argv;

      if (cmd === "git") {
        return gitReady
          ? ok(`${repoRoot}\n`)
          : fail("fatal: not a git repository");
      }

      if (cmd === "brew" && args[0] === "--version") {
        return binaries.has("brew") ? ok("Homebrew 4.0.0\n") : fail("brew: command not found");
      }

      if (cmd === "brew" && args[0] === "install") {
        installFormula(args[1]);
        return ok();
      }

      if (cmd === "npm" && args[0] === "--version") {
        return binaries.has("npm") ? ok("10.0.0\n") : fail("npm: command not found");
      }

      if (cmd === "npm" && args[0] === "install" && args[1] === "-g") {
        installNpm(args[2]);
        return ok();
      }

      if (cmd === "rg" && args[0] === "--version") {
        return binaries.has("rg") ? ok("ripgrep 14.0.0\n") : fail("rg: command not found");
      }
      if (cmd === "fd" && args[0] === "--version") {
        return binaries.has("fd") ? ok("fd 10.0.0\n") : fail("fd: command not found");
      }
      if (cmd === "ast-grep" && args[0] === "--version") {
        return binaries.has("ast-grep") ? ok("ast-grep 0.20.0\n") : fail("ast-grep: command not found");
      }
      if (cmd === "tree-sitter" && args[0] === "--version") {
        return binaries.has("tree-sitter") ? ok("tree-sitter 0.26.0\n") : fail("tree-sitter: command not found");
      }

      if (cmd === "codex" && args[0] === "--version") {
        return binaries.has("codex") ? ok("codex 0.117.0\n") : fail("codex: command not found");
      }
      if (cmd === "codex" && args[0] === "login" && args[1] === "status") {
        return auth.codex === "ready" ? ok("Logged in using ChatGPT\n") : fail("Not logged in\n");
      }

      if (cmd === "claude" && args[0] === "--version") {
        return binaries.has("claude") ? ok("2.1.87\n") : fail("claude: command not found");
      }
      if (cmd === "claude" && args[0] === "auth" && args[1] === "status") {
        return auth.claude === "ready"
          ? ok('{"loggedIn":true,"authMethod":"claude.ai"}\n')
          : ok('{"loggedIn":false}\n');
      }

      if (cmd === "gemini" && args[0] === "--version") {
        return binaries.has("gemini") ? ok("0.35.3\n") : fail("gemini: command not found");
      }

      if (cmd === "opencode" && args[0] === "--version") {
        return binaries.has("opencode") ? ok("1.3.0\n") : fail("opencode: command not found");
      }
      if (cmd === "opencode" && args[0] === "providers" && args[1] === "list") {
        return auth.opencode === "ready"
          ? ok("2 credentials\n1 environment variable\n")
          : ok("0 credentials\n0 environment variables\n");
      }

      return fail(`${cmd}: unexpected command`);
    },
  };
}

async function withSilent(fn) {
  setSilent(true);
  try {
    return await fn();
  } finally {
    setSilent(false);
  }
}

test("resolveBootstrapInputs prompts only for missing values", async () => {
  const asked = [];
  const cwd = path.join(os.tmpdir(), "agentify-bootstrap-default");

  const result = await resolveBootstrapInputs(
    { _: ["this"], provider: "claude" },
    {
      canPrompt: true,
      cwd,
      prompt: async (question) => {
        asked.push(question);
        return "";
      },
    },
  );

  assert.equal(result.provider, "claude");
  assert.equal(result.requestedRoot, path.resolve(cwd));
  assert.deepEqual(asked, [`Code path [${path.resolve(cwd)}]: `]);
});

test("runBootstrapCommand rejects local provider for bootstrap", async () => {
  await assert.rejects(
    () => runBootstrapCommand({ _: ["this"], provider: "local" }, { canPrompt: false, progressEnabled: false }),
    /provider "local" is not supported/,
  );
});

test("runBootstrapCommand blocks when Homebrew is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-bootstrap-no-brew-"));
  await fs.mkdir(path.join(root, ".git"));
  const runtime = createExecMock({
    repoRoot: root,
    initialBinaries: [],
  });

  const result = await withSilent(() =>
    runBootstrapCommand(
      { _: ["this"], provider: "codex", root },
      {
        exec: runtime.exec,
        platform: "darwin",
        canPrompt: false,
        progressEnabled: false,
        cwd: root,
      },
    )
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "missing_homebrew");
  await assert.rejects(() => fs.access(path.join(root, ".agentify.yaml")));
});

test("runBootstrapCommand blocks when target is not inside a git repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-bootstrap-no-git-"));
  const runtime = createExecMock({
    repoRoot: root,
    initialBinaries: ["brew", "rg", "fd", "ast-grep", "tree-sitter", "npm", "codex"],
    auth: { codex: "ready" },
    gitReady: false,
  });

  const result = await withSilent(() =>
    runBootstrapCommand(
      { _: ["this"], provider: "codex", root },
      {
        exec: runtime.exec,
        platform: "darwin",
        canPrompt: false,
        progressEnabled: false,
        cwd: root,
      },
    )
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "not_git_repo");
  await assert.rejects(() => fs.access(path.join(root, ".agentify.yaml")));
});

test("runBootstrapCommand bootstraps a repo and persists provider", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-bootstrap-ready-"));
  await fs.mkdir(path.join(root, ".git"));
  const runtime = createExecMock({
    repoRoot: root,
    initialBinaries: ["brew", "npm"],
    auth: { codex: "ready" },
  });

  const result = await withSilent(() =>
    runBootstrapCommand(
      { _: ["this"], provider: "codex", root },
      {
        exec: runtime.exec,
        platform: "darwin",
        canPrompt: false,
        progressEnabled: false,
        cwd: root,
      },
    )
  );

  const config = await loadConfig(root);
  assert.equal(result.status, "ready");
  assert.equal(config.provider, "codex");
  assert.deepEqual(runtime.installs, [
    "brew:ripgrep",
    "brew:fd",
    "brew:ast-grep",
    "brew:tree-sitter-cli",
    "npm:@openai/codex",
  ]);
  await assert.doesNotReject(() => fs.access(path.join(root, ".agents")));
  await assert.doesNotReject(() => fs.access(path.join(root, "docs", "modules")));
});

test("runBootstrapCommand bootstraps the exact requested root inside a larger git repository", async () => {
  const gitRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-bootstrap-subdir-"));
  const targetRoot = path.join(gitRoot, "apps", "metro-ticket-booking");
  await fs.mkdir(path.join(gitRoot, ".git"));
  await fs.mkdir(targetRoot, { recursive: true });
  const runtime = createExecMock({
    repoRoot: gitRoot,
    initialBinaries: ["brew", "npm"],
    auth: { codex: "ready" },
  });

  const result = await withSilent(() =>
    runBootstrapCommand(
      { _: ["this"], provider: "codex", root: targetRoot },
      {
        exec: runtime.exec,
        platform: "darwin",
        canPrompt: false,
        progressEnabled: false,
        cwd: targetRoot,
      },
    )
  );

  const config = await loadConfig(targetRoot);
  assert.equal(result.status, "ready");
  assert.equal(result.root, targetRoot);
  assert.equal(result.git_root, gitRoot);
  assert.equal(config.provider, "codex");
  await assert.doesNotReject(() => fs.access(path.join(targetRoot, ".agentify.yaml")));
  await assert.rejects(() => fs.access(path.join(gitRoot, ".agentify.yaml")));
});

test("runBootstrapCommand reports login required when auth cannot be verified", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-bootstrap-login-"));
  await fs.mkdir(path.join(root, ".git"));
  const runtime = createExecMock({
    repoRoot: root,
    initialBinaries: ["brew", "rg", "fd", "ast-grep", "tree-sitter", "gemini"],
  });

  const result = await withSilent(() =>
    runBootstrapCommand(
      { _: ["this"], provider: "gemini", root },
      {
        exec: runtime.exec,
        platform: "darwin",
        canPrompt: false,
        progressEnabled: false,
        cwd: root,
        env: {},
        homeDir: root,
      },
    )
  );

  assert.equal(result.status, "login_required");
  assert.equal(result.auth.nextStep, "gemini");
});

test("probeProviderReadiness accepts cached Gemini OAuth under GEMINI_CLI_HOME", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-bootstrap-gemini-home-"));
  const geminiHome = path.join(root, "gemini-home");
  await fs.mkdir(path.join(geminiHome, ".gemini"), { recursive: true });
  await fs.writeFile(path.join(geminiHome, ".gemini", "oauth_creds.json"), "{}\n", "utf8");

  const auth = await probeProviderReadiness("gemini", {
    cwd: root,
    env: { GEMINI_CLI_HOME: geminiHome },
    homeDir: path.join(root, "unused-home"),
  });

  assert.equal(auth.state, "ready");
  assert.equal(auth.detail, "oauth credentials cached");
  assert.equal(auth.nextStep, null);
});
