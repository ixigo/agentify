import path from "node:path";

import { exists } from "./fs.js";

function codexTemplateCommand({ prompt, root, interactive, bypassPermissions, continueSession }) {
  if (interactive) {
    const args = continueSession ? ["codex", "resume", "--last"] : ["codex"];
    if (root) {
      args.push("--cd", root);
    }
    if (bypassPermissions) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push(prompt);
    return args;
  }

  const args = continueSession ? ["codex", "exec", "resume", "--last"] : ["codex", "exec"];
  if (bypassPermissions) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push(prompt);
  return args;
}

function claudeTemplateCommand({ prompt, interactive, bypassPermissions, continueSession }) {
  const args = ["claude"];
  if (bypassPermissions) {
    args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
  }
  if (continueSession) {
    args.push("--continue");
  }
  if (!interactive) {
    args.push("-p");
  }
  args.push(prompt);
  return args;
}

function geminiTemplateCommand({ prompt, interactive, continueSession }) {
  const resumeArgs = continueSession ? ["--resume", "latest"] : [];
  if (interactive) {
    return ["gemini", ...resumeArgs, prompt];
  }
  return ["gemini", ...resumeArgs, "-p", prompt];
}

function opencodeTemplateCommand({ prompt, root, interactive, continueSession }) {
  if (interactive) {
    const args = ["opencode"];
    if (continueSession) {
      args.push("--continue");
    }
    if (root) {
      args.push("--dir", root);
    }
    args.push(prompt);
    return args;
  }

  const args = ["opencode", "run", prompt];
  if (continueSession) {
    args.push("--continue");
  }
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

// ---------------------------------------------------------------------------
// Delegate adapters (#297): every provider that can run `agentify delegate`
// work declares one contract here — how to build the headless command, how to
// parse its structured output into normalized usage, which controls it can
// enforce natively, and its per-tier models. models.js dispatches through
// these adapters instead of hard-coding vendors, so doctor/install/models/
// delegate can never disagree about what a provider supports.
// ---------------------------------------------------------------------------

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Parse `claude -p --output-format json` stdout. Returns null when the output
// is not the expected envelope (older CLI, plain-text fallback). Budget/turn
// stops arrive as a result envelope with an error subtype and possibly no
// result text, so those are accepted too.
export function parseClaudeJsonOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const isEnvelope = typeof parsed.result === "string"
    || (parsed.type === "result" && typeof parsed.subtype === "string");
  if (!isEnvelope) {
    return null;
  }
  const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
  const fresh = numberOrNull(usage.input_tokens);
  const cacheWrite = numberOrNull(usage.cache_creation_input_tokens);
  const cacheRead = numberOrNull(usage.cache_read_input_tokens);
  const outputTokens = numberOrNull(usage.output_tokens);
  const aggregateInput = (fresh || 0) + (cacheWrite || 0) + (cacheRead || 0);

  // `modelUsage` keys are the resolved model IDs behind the requested alias.
  // A single key is an unambiguous resolution; anything else stays null
  // rather than guessed.
  const modelUsage = parsed.modelUsage && typeof parsed.modelUsage === "object" && !Array.isArray(parsed.modelUsage)
    ? parsed.modelUsage
    : null;
  const resolvedModels = modelUsage ? Object.keys(modelUsage) : [];

  return {
    output: typeof parsed.result === "string" ? parsed.result.trim() : "",
    input_tokens: aggregateInput > 0 ? aggregateInput : null,
    output_tokens: outputTokens,
    cost_usd: numberOrNull(parsed.total_cost_usd),
    usage: {
      fresh_input_tokens: fresh,
      cache_write_tokens: cacheWrite,
      cache_read_tokens: cacheRead,
      output_tokens: outputTokens,
    },
    resolved_model: resolvedModels.length === 1 ? resolvedModels[0] : null,
    resolved_models: resolvedModels,
    subtype: typeof parsed.subtype === "string" ? parsed.subtype : null,
    num_turns: numberOrNull(parsed.num_turns),
  };
}

// Parse `codex exec --json` JSONL stdout. Usage events may appear as a plain
// `usage` object or nested token-count info; the last one seen wins (streams
// report cumulative totals). Codex reports no dollar cost — cost stays null
// rather than invented.
export function parseCodexJsonOutput(stdout) {
  let usage = null;
  let model = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const candidate = [
      event.msg?.info?.total_token_usage,
      event.info?.total_token_usage,
      event.usage,
      event.msg?.usage,
    ].find((value) => value && typeof value === "object"
      && (typeof value.input_tokens === "number" || typeof value.output_tokens === "number"));
    if (candidate) {
      usage = candidate;
    }
    const modelCandidate = [event.model, event.msg?.model].find((value) => typeof value === "string" && value.trim());
    if (modelCandidate) {
      model = modelCandidate.trim();
    }
  }
  if (!usage) {
    return null;
  }
  const inputTokens = numberOrNull(usage.input_tokens);
  const cachedTokens = numberOrNull(usage.cached_input_tokens);
  const outputTokens = numberOrNull(usage.output_tokens);
  const fresh = inputTokens !== null && cachedTokens !== null ? Math.max(0, inputTokens - cachedTokens) : inputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: null,
    usage: {
      fresh_input_tokens: fresh,
      cache_write_tokens: null,
      cache_read_tokens: cachedTokens,
      output_tokens: outputTokens,
    },
    resolved_model: model,
    resolved_models: model ? [model] : [],
  };
}

// Parse `gemini -p --output-format json` stdout: a single envelope with the
// response text and a stats object carrying per-model token counts. Gemini
// CLI reports tokens, never dollars — cost stays null rather than invented.
export function parseGeminiJsonOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const isEnvelope = typeof parsed.response === "string"
    || (parsed.stats && typeof parsed.stats === "object")
    || (parsed.error && typeof parsed.error === "object");
  if (!isEnvelope) {
    return null;
  }
  const models = parsed.stats?.models && typeof parsed.stats.models === "object" && !Array.isArray(parsed.stats.models)
    ? parsed.stats.models
    : {};
  const add = (total, value) => (value === null ? total : (total || 0) + value);
  let prompt = null;
  let cached = null;
  let output = null;
  for (const stats of Object.values(models)) {
    const tokens = stats?.tokens && typeof stats.tokens === "object" ? stats.tokens : {};
    prompt = add(prompt, numberOrNull(tokens.prompt));
    cached = add(cached, numberOrNull(tokens.cached));
    // Candidates are response tokens; thoughts are reasoning tokens — both
    // are provider output.
    output = add(output, numberOrNull(tokens.candidates));
    output = add(output, numberOrNull(tokens.thoughts));
  }
  const resolvedModels = Object.keys(models);
  const fresh = prompt !== null && cached !== null ? Math.max(0, prompt - cached) : prompt;
  return {
    output: typeof parsed.response === "string" ? parsed.response.trim() : "",
    input_tokens: prompt,
    output_tokens: output,
    cost_usd: null,
    usage: {
      fresh_input_tokens: fresh,
      cache_write_tokens: null,
      cache_read_tokens: cached,
      output_tokens: output,
    },
    resolved_model: resolvedModels.length === 1 ? resolvedModels[0] : null,
    resolved_models: resolvedModels,
    subtype: typeof parsed.error?.type === "string" ? parsed.error.type : null,
  };
}

// Depth-limited scan of one OpenCode event for the fields the normalized
// contract needs. OpenCode nests message info differently across event types
// (message.updated info, step-finish parts), so this matches shapes rather
// than exact event paths.
function scanOpenCodeEvent(node, state, depth = 0) {
  if (!node || typeof node !== "object" || depth > 4) return;
  if (Array.isArray(node)) {
    for (const item of node) scanOpenCodeEvent(item, state, depth + 1);
    return;
  }
  const tokens = node.tokens;
  if (tokens && typeof tokens === "object"
    && (typeof tokens.input === "number" || typeof tokens.output === "number")) {
    state.tokens = tokens;
    if (typeof node.cost === "number" && Number.isFinite(node.cost)) {
      state.cost = node.cost;
    }
  }
  const model = typeof node.modelID === "string" ? node.modelID : node.modelId;
  if (typeof model === "string" && model.trim()) {
    state.model = model.trim();
  }
  if (node.type === "text" && typeof node.text === "string" && node.text.trim()) {
    // Part events repeat cumulative text; the last one seen wins.
    state.text = node.text;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      scanOpenCodeEvent(value, state, depth + 1);
    }
  }
}

// Parse `opencode run --format json` JSONL stdout. Returns null when no line
// parses as a JSON event at all; token fields stay null (never estimated)
// when the stream carried no usage info. OpenCode reports real dollar cost
// via its model pricing catalog, so cost_usd is provider-reported when present.
export function parseOpenCodeJsonOutput(stdout) {
  const state = { tokens: null, cost: null, model: null, text: null };
  let sawEvent = false;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    sawEvent = true;
    scanOpenCodeEvent(event, state);
  }
  if (!sawEvent) {
    return null;
  }
  const tokens = state.tokens || {};
  const input = numberOrNull(tokens.input);
  const output = numberOrNull(tokens.output);
  const reasoning = numberOrNull(tokens.reasoning);
  const cacheRead = numberOrNull(tokens.cache?.read);
  const cacheWrite = numberOrNull(tokens.cache?.write);
  const aggregateInput = input === null && cacheRead === null && cacheWrite === null
    ? null
    : (input || 0) + (cacheRead || 0) + (cacheWrite || 0);
  const totalOutput = output === null && reasoning === null ? null : (output || 0) + (reasoning || 0);
  return {
    output: typeof state.text === "string" ? state.text.trim() : "",
    input_tokens: aggregateInput,
    output_tokens: totalOutput,
    cost_usd: numberOrNull(state.cost),
    usage: {
      fresh_input_tokens: input,
      cache_write_tokens: cacheWrite,
      cache_read_tokens: cacheRead,
      output_tokens: totalOutput,
    },
    resolved_model: state.model,
    resolved_models: state.model ? [state.model] : [],
  };
}

// JSON output carries real token usage and cost alongside the result text.
function buildClaudeDelegateCommand(target, prompt, { write = false, limits = {}, persistSession = false } = {}) {
  const argv = ["claude", "-p", prompt, "--output-format", "json"];
  if (target.model) {
    argv.push("--model", target.model);
  }
  if (limits.maxBudgetUsd != null) {
    argv.push("--max-budget-usd", String(limits.maxBudgetUsd));
  }
  if (limits.maxTurns != null) {
    argv.push("--max-turns", String(limits.maxTurns));
  }
  if (limits.effort) {
    argv.push("--effort", String(limits.effort));
  }
  if (persistSession !== true) {
    // Delegated runs are one-shot; keeping session state would only add cost.
    argv.push("--no-session-persistence");
  }
  if (write) {
    argv.push("--permission-mode", "acceptEdits");
  }
  return argv;
}

// --json emits the JSONL event stream (token usage); the final answer is
// still captured via --output-last-message. Codex has no native dollar or
// turn cap — those are enforced by Agentify's pre-run check and timeout —
// but it does honor reasoning effort via config.
function buildCodexDelegateCommand(target, prompt, { write = false, limits = {}, lastMessagePath = null } = {}) {
  const argv = ["codex", "exec", "--skip-git-repo-check", "--json"];
  if (target.model) {
    argv.push("--model", target.model);
  }
  if (limits.effort) {
    argv.push("-c", `model_reasoning_effort=${limits.effort}`);
  }
  argv.push(write ? "--full-auto" : "--sandbox", ...(write ? [] : ["read-only"]));
  if (lastMessagePath) {
    argv.push("--output-last-message", lastMessagePath);
  }
  argv.push(prompt);
  return argv;
}

// Headless JSON envelope with response + stats. Gemini CLI has no native
// dollar/turn cap; write mode auto-approves edit tools only. Read-only must
// use plan mode — the default approval mode can still approve edits through
// policy config, which would break the no-write contract.
function buildGeminiDelegateCommand(target, prompt, { write = false } = {}) {
  const argv = ["gemini", "--output-format", "json"];
  if (target.model) {
    argv.push("--model", target.model);
  }
  argv.push("--approval-mode", write ? "auto_edit" : "plan");
  argv.push("-p", prompt);
  return argv;
}

// JSONL event stream. Read-only mode pins the built-in plan agent (no edit
// permissions); write mode uses the default build agent.
function buildOpenCodeDelegateCommand(target, prompt, { write = false } = {}) {
  const argv = ["opencode", "run", "--format", "json"];
  if (target.model) {
    argv.push("--model", target.model);
  }
  if (!write) {
    argv.push("--agent", "plan");
  }
  argv.push(prompt);
  return argv;
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
    delegate: {
      optIn: false,
      // Pinned per-tier Codex models (July 2026 lineup) so tier-equivalent
      // fallback and evidence keys are capability-real instead of "whatever
      // the CLI default happens to be" (#295 known limitation). Overridable
      // under models.tiers.codex; route defaults may still use the CLI
      // default via model: null.
      tierModels: { economy: "gpt-5.6-luna", balanced: "gpt-5.6-terra", frontier: "gpt-5.6-sol" },
      aliasModels: [],
      controls: { maxBudgetUsd: false, maxTurns: false, effort: true },
      enforcement: { budget_usd: "pre-run-only", turns: "unavailable", timeout: "agentify" },
      reportsCostUsd: false,
      usesLastMessageFile: true,
      buildCommand: buildCodexDelegateCommand,
      parseOutput: parseCodexJsonOutput,
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
    delegate: {
      optIn: false,
      // Version-independent Claude Code aliases: stable across model
      // releases (currently the Claude 5 generation) at the cost of alias
      // drift, which `agentify models` warns about.
      tierModels: { economy: "haiku", balanced: "sonnet", frontier: "opus" },
      aliasModels: ["haiku", "sonnet", "opus"],
      controls: { maxBudgetUsd: true, maxTurns: true, effort: true },
      enforcement: { budget_usd: "native", turns: "native", timeout: "agentify" },
      reportsCostUsd: true,
      usesLastMessageFile: false,
      buildCommand: buildClaudeDelegateCommand,
      parseOutput: parseClaudeJsonOutput,
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
    delegate: {
      // Opt-in (#297): installed Gemini shows up in `agentify models`, but it
      // never joins fallback chains or default routes until the repo enables
      // it under models.providers.gemini.enabled — price alone is not
      // evidence of coding quality; the eval suite gates promotion.
      optIn: true,
      tierModels: { economy: "gemini-3.1-flash-lite", balanced: "gemini-3.5-flash", frontier: "gemini-3.1-pro-preview" },
      aliasModels: [],
      controls: { maxBudgetUsd: false, maxTurns: false, effort: false },
      enforcement: { budget_usd: "pre-run-only", turns: "unavailable", timeout: "agentify" },
      reportsCostUsd: false,
      usesLastMessageFile: false,
      buildCommand: buildGeminiDelegateCommand,
      parseOutput: parseGeminiJsonOutput,
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
    delegate: {
      // Opt-in (#297), same contract as Gemini. Tier models stay null: an
      // OpenCode model is a provider/model ref that depends entirely on which
      // upstream providers the user configured, so Agentify pins nothing.
      optIn: true,
      tierModels: { economy: null, balanced: null, frontier: null },
      aliasModels: [],
      controls: { maxBudgetUsd: false, maxTurns: false, effort: false },
      enforcement: { budget_usd: "pre-run-only", turns: "unavailable", timeout: "agentify" },
      reportsCostUsd: true,
      usesLastMessageFile: false,
      buildCommand: buildOpenCodeDelegateCommand,
      parseOutput: parseOpenCodeJsonOutput,
    },
  },
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS);
export const EXECUTABLE_PROVIDER_NAMES = SUPPORTED_PROVIDERS.filter((provider) => PROVIDER_DEFINITIONS[provider].executable);
export const BOOTSTRAP_PROVIDER_NAMES = SUPPORTED_PROVIDERS.filter((provider) => PROVIDER_DEFINITIONS[provider].bootstrap);
export const SKILL_INSTALL_PROVIDER_NAMES = SUPPORTED_PROVIDERS.filter((provider) => PROVIDER_DEFINITIONS[provider].skillInstall);
// Vendors first, opt-in eval candidates after: this order is also the
// deterministic fallback-alternate order in profiles.js.
export const DELEGATE_PROVIDER_NAMES = ["claude", "codex", "gemini", "opencode"]
  .filter((provider) => PROVIDER_DEFINITIONS[provider]?.delegate);

export function getProviderDefinition(provider) {
  return PROVIDER_DEFINITIONS[provider] || null;
}

export function getProviderBootstrap(provider) {
  return getProviderDefinition(provider)?.bootstrap || null;
}

export function getDelegateAdapter(provider) {
  return getProviderDefinition(provider)?.delegate || null;
}
