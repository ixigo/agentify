import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { ensureBaselineArtifacts } from "./commands.js";
import { loadConfig, persistProviderPreference, writeDefaultConfig } from "./config.js";
import { exists } from "./fs.js";
import * as ui from "./ui.js";

export const BOOTSTRAP_PROVIDERS = ["codex", "claude", "gemini", "opencode"];

const HOMEBREW_INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

const MACOS_REQUIRED_TOOLS = [
  {
    id: "ripgrep",
    label: "ripgrep",
    bin: "rg",
    checkArgs: ["--version"],
    install: ["brew", "install", "ripgrep"],
  },
  {
    id: "fd",
    label: "fd",
    bin: "fd",
    checkArgs: ["--version"],
    install: ["brew", "install", "fd"],
  },
  {
    id: "ast-grep",
    label: "ast-grep",
    bin: "ast-grep",
    checkArgs: ["--version"],
    install: ["brew", "install", "ast-grep"],
  },
  {
    id: "tree-sitter-cli",
    label: "tree-sitter-cli",
    bin: "tree-sitter",
    checkArgs: ["--version"],
    install: ["brew", "install", "tree-sitter-cli"],
  },
];

const NODE_INSTALL = {
  id: "node",
  label: "node",
  bin: "npm",
  checkArgs: ["--version"],
  install: ["brew", "install", "node"],
};

const PROVIDER_BOOTSTRAP = {
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    checkArgs: ["--version"],
    install: ["npm", "install", "-g", "@openai/codex"],
    loginCommand: "codex login",
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    checkArgs: ["--version"],
    install: ["npm", "install", "-g", "@anthropic-ai/claude-code"],
    loginCommand: "claude auth login",
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    checkArgs: ["--version"],
    install: ["brew", "install", "gemini-cli"],
    loginCommand: "gemini",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    checkArgs: ["--version"],
    install: ["brew", "install", "opencode"],
    loginCommand: "opencode providers login",
  },
};

function normalizeBootstrapProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider) {
    throw new Error(`provider is required. Supported providers: ${BOOTSTRAP_PROVIDERS.join(", ")}`);
  }
  if (provider === "local") {
    throw new Error(`provider "local" is not supported by "agentify this". Use ${BOOTSTRAP_PROVIDERS.join(", ")}.`);
  }
  if (!BOOTSTRAP_PROVIDERS.includes(provider)) {
    throw new Error(`unsupported provider "${provider}". Supported providers: ${BOOTSTRAP_PROVIDERS.join(", ")}`);
  }
  return provider;
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function tailText(text, maxLines = 4) {
  return String(text || "")
    .trim()
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

async function runCommandCapture(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        resolve({ code: 127, stdout: "", stderr: `${cmd}: command not found`, missing: true });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        missing: false,
      });
    });

    child.stdin.end(options.input || "");
  });
}

function createPromptAdapter(runtime) {
  if (runtime.prompt || runtime.confirm) {
    return {
      ask: runtime.prompt || (async () => ""),
      confirm: runtime.confirm || (async () => false),
      close() {},
    };
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return {
    ask(question) {
      return rl.question(question);
    },
    async confirm(question, defaultYes = true) {
      const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
      const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
      if (!answer) {
        return defaultYes;
      }
      return ["y", "yes"].includes(answer);
    },
    close() {
      rl.close();
    },
  };
}

async function stepInstalled(step, runtime) {
  const result = await runtime.exec([step.bin, ...(step.checkArgs || ["--version"])], {
    cwd: runtime.cwd,
    env: runtime.env,
  });
  return result.code === 0;
}

async function resolveGitRoot(targetPath, runtime) {
  const result = await runtime.exec(["git", "-C", targetPath, "rev-parse", "--show-toplevel"], {
    cwd: targetPath,
    env: runtime.env,
  });
  if (result.code !== 0) {
    return null;
  }
  return path.resolve(result.stdout.trim());
}

function groupInstallPlan(steps) {
  const grouped = {
    brew: [],
    npm: [],
  };

  for (const step of steps) {
    if (step.install[0] === "brew") {
      grouped.brew.push(step.install[2]);
    } else if (step.install[0] === "npm") {
      grouped.npm.push(step.install[step.install.length - 1]);
    }
  }

  return grouped;
}

function buildConfirmationSummary({ installPlan, provider, targetRoot }) {
  const grouped = groupInstallPlan(installPlan);
  const actions = [];

  if (grouped.brew.length > 0) {
    actions.push(`brew packages ${grouped.brew.join(", ")}`);
  }
  if (grouped.npm.length > 0) {
    actions.push(`npm globals ${grouped.npm.join(", ")}`);
  }

  actions.push(`set provider to ${provider}`);
  actions.push(`initialize ${targetRoot}`);

  return `Will ${actions.join("; ")}`;
}

async function promptForProvider(prompts) {
  while (true) {
    const answer = await prompts.ask(`Provider (${BOOTSTRAP_PROVIDERS.join("/")}): `);
    try {
      return normalizeBootstrapProvider(answer);
    } catch (error) {
      ui.warn(error.message);
    }
  }
}

async function promptForRoot(defaultRoot, prompts) {
  const answer = (await prompts.ask(`Code path [${defaultRoot}]: `)).trim();
  return path.resolve(answer || defaultRoot);
}

export async function resolveBootstrapInputs(args, runtime = {}) {
  const canPrompt = runtime.canPrompt ?? (!args.json && process.stdin.isTTY && process.stderr.isTTY);
  const prompts = canPrompt
    ? createPromptAdapter(runtime)
    : { close() {} };

  try {
    const provider = args.provider
      ? normalizeBootstrapProvider(args.provider)
      : canPrompt
        ? await promptForProvider(prompts)
        : null;

    if (!provider) {
      throw new Error(`agentify this requires --provider in non-interactive mode. Supported providers: ${BOOTSTRAP_PROVIDERS.join(", ")}`);
    }

    const requestedRoot = args.root
      ? path.resolve(String(args.root))
      : canPrompt
        ? await promptForRoot(path.resolve(runtime.cwd || process.cwd()), prompts)
        : path.resolve(runtime.cwd || process.cwd());

    return {
      provider,
      requestedRoot,
      canPrompt,
    };
  } finally {
    prompts.close();
  }
}

export async function buildBootstrapInstallPlan(provider, runtime = {}) {
  const mergedRuntime = {
    cwd: runtime.cwd || process.cwd(),
    env: runtime.env || process.env,
    exec: runtime.exec || runCommandCapture,
  };

  const installPlan = [];
  for (const step of MACOS_REQUIRED_TOOLS) {
    if (!await stepInstalled(step, mergedRuntime)) {
      installPlan.push({ ...step, target: "tool" });
    }
  }

  const providerStep = PROVIDER_BOOTSTRAP[provider];
  if (!providerStep) {
    throw new Error(`unsupported provider "${provider}"`);
  }

  if (providerStep.install[0] === "npm" && !await stepInstalled(NODE_INSTALL, mergedRuntime)) {
    installPlan.push({ ...NODE_INSTALL, target: "tool" });
  }

  if (!await stepInstalled(providerStep, mergedRuntime)) {
    installPlan.push({ ...providerStep, target: "provider" });
  }

  return installPlan;
}

async function probeCodexAuth(runtime) {
  const result = await runtime.exec(["codex", "login", "status"], {
    cwd: runtime.cwd,
    env: runtime.env,
  });
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.code === 0 && output.includes("logged in")) {
    return { state: "ready", detail: "logged in", nextStep: null };
  }
  if (output.includes("not logged in")) {
    return { state: "missing", detail: "login required", nextStep: "codex login" };
  }
  return { state: "unknown", detail: "auth not verified", nextStep: "codex login" };
}

async function probeClaudeAuth(runtime) {
  const result = await runtime.exec(["claude", "auth", "status"], {
    cwd: runtime.cwd,
    env: runtime.env,
  });

  try {
    const parsed = JSON.parse(result.stdout || "{}");
    if (parsed.loggedIn) {
      return { state: "ready", detail: parsed.authMethod || "logged in", nextStep: null };
    }
    return { state: "missing", detail: "login required", nextStep: "claude auth login" };
  } catch {
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (output.includes('"loggedin": true') || output.includes("logged in")) {
      return { state: "ready", detail: "logged in", nextStep: null };
    }
    return { state: "unknown", detail: "auth not verified", nextStep: "claude auth login" };
  }
}

async function probeGeminiAuth(runtime) {
  if (runtime.env.GEMINI_API_KEY) {
    return { state: "ready", detail: "GEMINI_API_KEY set", nextStep: null };
  }
  if (runtime.env.GOOGLE_API_KEY) {
    return { state: "ready", detail: "GOOGLE_API_KEY set", nextStep: null };
  }
  if (runtime.env.GOOGLE_APPLICATION_CREDENTIALS && await exists(runtime.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return { state: "ready", detail: "application default credentials configured", nextStep: null };
  }

  const geminiHome = runtime.env.GEMINI_CLI_HOME || runtime.homeDir;
  const oauthFile = path.join(geminiHome, ".gemini", "oauth_creds.json");
  if (await exists(oauthFile)) {
    return { state: "ready", detail: "oauth credentials cached", nextStep: null };
  }

  return { state: "unknown", detail: "auth not verified", nextStep: "gemini" };
}

async function probeOpenCodeAuth(runtime) {
  const result = await runtime.exec(["opencode", "providers", "list"], {
    cwd: runtime.cwd,
    env: runtime.env,
  });
  const cleaned = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const credentialsCount = Number(cleaned.match(/(\d+)\s+credentials?/i)?.[1] || 0);
  const envCount = Number(cleaned.match(/(\d+)\s+environment variables?/i)?.[1] || 0);
  if (result.code === 0 && (credentialsCount > 0 || envCount > 0)) {
    return { state: "ready", detail: "credentials detected", nextStep: null };
  }
  return { state: "unknown", detail: "auth not verified", nextStep: "opencode providers login" };
}

export async function probeProviderReadiness(provider, runtime = {}) {
  const mergedRuntime = {
    cwd: runtime.cwd || process.cwd(),
    env: runtime.env || process.env,
    homeDir: runtime.homeDir || os.homedir(),
    exec: runtime.exec || runCommandCapture,
  };

  if (provider === "codex") {
    return probeCodexAuth(mergedRuntime);
  }
  if (provider === "claude") {
    return probeClaudeAuth(mergedRuntime);
  }
  if (provider === "gemini") {
    return probeGeminiAuth(mergedRuntime);
  }
  if (provider === "opencode") {
    return probeOpenCodeAuth(mergedRuntime);
  }
  throw new Error(`unsupported provider "${provider}"`);
}

function buildBlockedResult({ provider, requestedRoot, root = null, gitRoot = null, reason, detail = null }) {
  return {
    status: "blocked",
    provider,
    requested_root: requestedRoot,
    root: root || requestedRoot,
    git_root: gitRoot,
    reason,
    detail,
  };
}

function printFailure(prefix, summary, detail) {
  ui.error(summary);
  if (detail) {
    ui.log(`${prefix}: ${detail}`);
  }
}

export async function runBootstrapCommand(args, runtime = {}) {
  const mergedRuntime = {
    cwd: runtime.cwd || process.cwd(),
    env: runtime.env || process.env,
    homeDir: runtime.homeDir || os.homedir(),
    platform: runtime.platform || process.platform,
    exec: runtime.exec || runCommandCapture,
    canPrompt: runtime.canPrompt ?? (!args.json && process.stdin.isTTY && process.stderr.isTTY),
    prompt: runtime.prompt,
    confirm: runtime.confirm,
  };

  const progress = ui.createInlineProgress({
    enabled: !args.json && (runtime.progressEnabled ?? process.stderr.isTTY),
  });

  progress.update(10, "collecting bootstrap inputs");
  const { provider, requestedRoot, canPrompt } = await resolveBootstrapInputs(args, mergedRuntime);

  if (mergedRuntime.platform !== "darwin") {
    const result = buildBlockedResult({
      provider,
      requestedRoot,
      root: requestedRoot,
      reason: "unsupported_platform",
      detail: `agentify this currently supports macOS only; detected ${mergedRuntime.platform}.`,
    });
    progress.error("blocked: macOS is required");
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  }

  progress.update(30, "verifying repository and prerequisites");

  if (!await exists(requestedRoot)) {
    const result = buildBlockedResult({
      provider,
      requestedRoot,
      root: requestedRoot,
      reason: "missing_path",
      detail: `path does not exist: ${requestedRoot}`,
    });
    progress.error(`blocked: path not found (${requestedRoot})`);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  }

  const brewReady = await stepInstalled({ bin: "brew", checkArgs: ["--version"] }, mergedRuntime);
  if (!brewReady) {
    progress.clear();
    let detail = `Homebrew is required on macOS. Install it with: ${HOMEBREW_INSTALL_COMMAND}`;
    if (canPrompt) {
      const prompts = createPromptAdapter(mergedRuntime);
      try {
        const wantsCommand = await prompts.confirm("Homebrew is required on macOS and is not installed. Show install command?");
        if (wantsCommand) {
          ui.log(HOMEBREW_INSTALL_COMMAND);
        }
      } finally {
        prompts.close();
      }
    } else if (!args.json) {
      ui.log(HOMEBREW_INSTALL_COMMAND);
    }

    const result = buildBlockedResult({
      provider,
      requestedRoot,
      root: requestedRoot,
      reason: "missing_homebrew",
      detail,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  }

  const repoRoot = await resolveGitRoot(requestedRoot, mergedRuntime);
  if (!repoRoot) {
    const result = buildBlockedResult({
      provider,
      requestedRoot,
      root: requestedRoot,
      reason: "not_git_repo",
      detail: `path is not inside a Git repository: ${requestedRoot}`,
      gitRoot: null,
    });
    progress.error("blocked: target is not a git repository");
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  }

  const installPlan = await buildBootstrapInstallPlan(provider, { ...mergedRuntime, cwd: requestedRoot });
  const summary = buildConfirmationSummary({ installPlan, provider, targetRoot: requestedRoot });

  if (!args.json) {
    progress.clear();
    ui.log(summary);
    if (installPlan.length === 0) {
      ui.log("No missing dependencies detected.");
    }
  }

  if (!args.dryRun) {
    let shouldContinue = true;
    if (canPrompt) {
      const prompts = createPromptAdapter(mergedRuntime);
      try {
        shouldContinue = await prompts.confirm("Continue with bootstrap?");
      } finally {
        prompts.close();
      }
    }

    if (!shouldContinue) {
      const result = buildBlockedResult({
        provider,
        requestedRoot,
        root: requestedRoot,
        gitRoot: repoRoot,
        reason: "cancelled",
        detail: "bootstrap cancelled by user",
      });
      if (!args.json) {
        ui.warn("Bootstrap cancelled.");
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      return result;
    }
  }

  progress.update(60, installPlan.length > 0 ? "installing missing tools" : "dependencies already installed");

  if (!args.dryRun) {
    for (const step of installPlan) {
      const result = await mergedRuntime.exec(step.install, {
        cwd: repoRoot,
        env: mergedRuntime.env,
      });
      if (result.code !== 0) {
        progress.clear();
        const detail = tailText(stripAnsi(`${result.stdout}\n${result.stderr}`));
        const command = step.install.join(" ");
        if (!args.json) {
          printFailure("Install failure", `failed to install ${step.label}`, detail || command);
        }
        const blocked = buildBlockedResult({
          provider,
          requestedRoot,
          root: requestedRoot,
          gitRoot: repoRoot,
          reason: "install_failed",
          detail: `${command}${detail ? `\n${detail}` : ""}`,
        });
        if (args.json) {
          console.log(JSON.stringify(blocked, null, 2));
        }
        return blocked;
      }
    }
  }

  progress.update(85, args.dryRun ? "previewing repository initialization" : "initializing repository");

  const config = await loadConfig(requestedRoot, {
    provider,
    dryRun: Boolean(args.dryRun),
    json: Boolean(args.json),
  });
  config.provider = provider;
  config.dryRun = Boolean(args.dryRun);
  config.json = Boolean(args.json);

  await writeDefaultConfig(requestedRoot, config, { dryRun: config.dryRun });
  await persistProviderPreference(requestedRoot, provider, { dryRun: config.dryRun });
  await ensureBaselineArtifacts(requestedRoot, config);

  const auth = await probeProviderReadiness(provider, {
    ...mergedRuntime,
    cwd: requestedRoot,
  });

  const result = {
    status: auth.state === "ready" ? "ready" : "login_required",
    provider,
    requested_root: requestedRoot,
    root: requestedRoot,
    git_root: repoRoot,
    dry_run: Boolean(args.dryRun),
    installs: installPlan.map((step) => ({
      id: step.id,
      label: step.label,
      command: step.install.join(" "),
      target: step.target,
    })),
    auth,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (config.dryRun) {
    progress.success(`100% dry-run complete for ${provider} in ${requestedRoot}`);
    return result;
  }

  if (result.status === "ready") {
    progress.success(`100% ready: ${provider} configured in ${requestedRoot}`);
  } else {
    const nextStep = auth.nextStep || PROVIDER_BOOTSTRAP[provider].loginCommand;
    progress.warn(`85% login required: run ${nextStep}`);
  }

  return result;
}
