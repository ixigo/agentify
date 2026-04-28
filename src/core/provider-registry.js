import path from "node:path";

import { exists } from "./fs.js";

function codexTemplateCommand({ prompt, root, interactive, bypassPermissions }) {
  if (interactive) {
    const args = ["codex"];
    if (root) {
      args.push("--cd", root);
    }
    if (bypassPermissions) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push(prompt);
    return args;
  }

  const args = ["codex", "exec"];
  if (bypassPermissions) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push(prompt);
  return args;
}

function claudeTemplateCommand({ prompt, interactive, bypassPermissions }) {
  const args = ["claude"];
  if (bypassPermissions) {
    args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
  }
  if (!interactive) {
    args.push("-p");
  }
  args.push(prompt);
  return args;
}

function geminiTemplateCommand({ prompt, interactive }) {
  if (interactive) {
    return ["gemini", prompt];
  }
  return ["gemini", "-p", prompt];
}

function opencodeTemplateCommand({ prompt, root, interactive }) {
  if (interactive) {
    const args = ["opencode"];
    if (root) {
      args.push("--dir", root);
    }
    args.push(prompt);
    return args;
  }

  const args = ["opencode", "run", prompt];
  if (root) {
    args.push("--dir", root);
  }
  return args;
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

export function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
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

export const PROVIDER_DEFINITIONS = {
  local: {
    name: "local",
    executable: false,
    skillInstall: false,
    bootstrap: null,
    runtime: {
      kind: "local",
    },
  },
  codex: {
    name: "codex",
    executable: true,
    skillInstall: true,
    buildTemplateCommand: codexTemplateCommand,
    bootstrap: {
      id: "codex",
      label: "Codex",
      bin: "codex",
      checkArgs: ["--version"],
      install: ["npm", "install", "-g", "@openai/codex"],
      loginCommand: "codex login",
    },
    probeAuth: probeCodexAuth,
    runtime: {
      kind: "external",
      defaultModel: "codex-default",
      runner: "codex",
    },
  },
  claude: {
    name: "claude",
    executable: true,
    skillInstall: true,
    buildTemplateCommand: claudeTemplateCommand,
    bootstrap: {
      id: "claude",
      label: "Claude Code",
      bin: "claude",
      checkArgs: ["--version"],
      install: ["npm", "install", "-g", "@anthropic-ai/claude-code"],
      loginCommand: "claude auth login",
    },
    probeAuth: probeClaudeAuth,
    runtime: {
      kind: "external",
      defaultModel: "claude-default",
      runner: "claude",
    },
  },
  gemini: {
    name: "gemini",
    executable: true,
    skillInstall: true,
    buildTemplateCommand: geminiTemplateCommand,
    bootstrap: {
      id: "gemini",
      label: "Gemini CLI",
      bin: "gemini",
      checkArgs: ["--version"],
      install: ["brew", "install", "gemini-cli"],
      loginCommand: "gemini",
    },
    probeAuth: probeGeminiAuth,
    runtime: {
      kind: "external",
      defaultModel: "gemini-default",
      runner: "gemini",
      appendJsonOnlyInstruction: true,
    },
  },
  opencode: {
    name: "opencode",
    executable: true,
    skillInstall: true,
    buildTemplateCommand: opencodeTemplateCommand,
    bootstrap: {
      id: "opencode",
      label: "OpenCode",
      bin: "opencode",
      checkArgs: ["--version"],
      install: ["brew", "install", "opencode"],
      loginCommand: "opencode providers login",
    },
    probeAuth: probeOpenCodeAuth,
    runtime: {
      kind: "external",
      defaultModel: "opencode-default",
      runner: "opencode",
      appendJsonOnlyInstruction: true,
    },
  },
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS);
export const EXECUTABLE_PROVIDER_NAMES = SUPPORTED_PROVIDERS.filter((provider) => PROVIDER_DEFINITIONS[provider].executable);
export const BOOTSTRAP_PROVIDER_NAMES = SUPPORTED_PROVIDERS.filter((provider) => PROVIDER_DEFINITIONS[provider].bootstrap);
export const SKILL_INSTALL_PROVIDER_NAMES = SUPPORTED_PROVIDERS.filter((provider) => PROVIDER_DEFINITIONS[provider].skillInstall);

export function getProviderDefinition(provider) {
  return PROVIDER_DEFINITIONS[provider] || null;
}

export function getProviderBootstrap(provider) {
  return getProviderDefinition(provider)?.bootstrap || null;
}

