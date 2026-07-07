import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getChangedFilesSince } from "./git.js";

const execFileAsync = promisify(execFile);

export const DELEGATE_TIMEOUT_MS = 600000;

// Route defaults are chosen to stay stable across model releases: Claude Code
// accepts version-independent aliases (haiku/sonnet/opus), and Codex uses the
// CLI's own configured default when model is null. Everything is overridable
// under `models.routes` in .agentify.yaml.
export const DEFAULT_MODEL_ROUTES = {
  quick: {
    provider: "claude",
    model: "haiku",
    use: "Small, low-impact edits, mechanical changes, quick questions",
  },
  implement: {
    provider: "claude",
    model: "sonnet",
    use: "Standard feature work and multi-file refactors",
  },
  heavy: {
    provider: "claude",
    model: "opus",
    use: "Architecture decisions, deep debugging, high-risk changes",
  },
  review: {
    provider: "codex",
    model: null,
    use: "Independent post-change code review by a different model vendor",
  },
  research: {
    provider: "claude",
    model: "haiku",
    use: "Fast exploration, summarization, and doc lookups",
  },
};

const FALLBACKS = {
  claude: { provider: "codex", model: null },
  codex: { provider: "claude", model: "opus" },
};

export function resolveModelRoutes(config = {}) {
  const configured = config.models?.routes && typeof config.models.routes === "object"
    ? config.models.routes
    : {};
  const routes = {};
  for (const [kind, route] of Object.entries(DEFAULT_MODEL_ROUTES)) {
    const override = configured[kind] && typeof configured[kind] === "object" ? configured[kind] : {};
    routes[kind] = { ...route, ...override };
  }
  for (const [kind, route] of Object.entries(configured)) {
    if (!routes[kind] && route && typeof route === "object" && route.provider) {
      routes[kind] = { use: "", model: null, ...route };
    }
  }
  return routes;
}

export function normalizeRouteKind(value, routes) {
  const kind = String(value || "").trim().toLowerCase();
  if (!routes[kind]) {
    throw new Error(`Unknown delegate kind "${value}". Available: ${Object.keys(routes).join(", ")}`);
  }
  return kind;
}

async function defaultCommandExists(command) {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", 'command -v -- "$1"', "sh", command]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

export async function detectDelegateProviders(runtime = {}) {
  const commandExists = runtime.commandExists || defaultCommandExists;
  const [claude, codex] = await Promise.all([
    commandExists("claude"),
    commandExists("codex"),
  ]);
  return { claude, codex };
}

export function pickRouteTarget(route, availability) {
  const provider = route.provider;
  if (availability[provider]) {
    return { provider, model: route.model ?? null, fallback: false };
  }
  const fallback = FALLBACKS[provider];
  if (fallback && availability[fallback.provider]) {
    return { provider: fallback.provider, model: fallback.model, fallback: true };
  }
  return null;
}

export function buildDelegateCommand(target, prompt, options = {}) {
  const write = options.write === true;

  if (target.provider === "codex") {
    const argv = ["codex", "exec", "--skip-git-repo-check"];
    if (target.model) {
      argv.push("--model", target.model);
    }
    argv.push(write ? "--full-auto" : "--sandbox", ...(write ? [] : ["read-only"]));
    if (options.lastMessagePath) {
      argv.push("--output-last-message", options.lastMessagePath);
    }
    argv.push(prompt);
    return argv;
  }

  const argv = ["claude", "-p", prompt];
  if (target.model) {
    argv.push("--model", target.model);
  }
  if (write) {
    argv.push("--permission-mode", "acceptEdits");
  }
  return argv;
}

async function buildDiffSection(root, diffRef) {
  const { stdout } = await execFileAsync("git", ["diff", diffRef], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const changed = await getChangedFilesSince(root, diffRef).catch(() => []);
  const fileList = changed.map((entry) => `- ${entry.status} ${entry.path}`).join("\n");
  return [
    `## Changed files since ${diffRef}`,
    fileList || "- (none reported by git)",
    "",
    "## Diff",
    "```diff",
    stdout.trim() || "(empty diff)",
    "```",
  ].join("\n");
}

export function buildDelegatePrompt(kind, task, options = {}) {
  const sections = [];
  if (kind === "review") {
    sections.push(
      "You are performing an independent code review. Report concrete findings (bugs, regressions, risky assumptions) with file:line references, ranked by severity. If the change looks correct, say so briefly. Do not modify any files.",
    );
  } else if (kind === "research") {
    sections.push("Answer concisely and factually. Do not modify any files.");
  }
  if (task) {
    sections.push(kind === "review" ? `Review focus: ${task}` : task);
  } else if (kind === "review") {
    sections.push("Review the change for correctness, edge cases, and unintended side effects.");
  }
  if (options.diffSection) {
    sections.push(options.diffSection);
  }
  return sections.filter(Boolean).join("\n\n");
}

export async function runDelegate(root, config, kindInput, task, options = {}) {
  const routes = resolveModelRoutes(config);
  const kind = normalizeRouteKind(kindInput, routes);
  const route = { ...routes[kind] };
  if (options.provider) {
    route.provider = String(options.provider);
    route.model = options.model ?? null;
  }
  if (options.model !== undefined && options.model !== null) {
    route.model = String(options.model);
  }

  const availability = await detectDelegateProviders(options.runtime || {});
  const target = pickRouteTarget(route, availability);
  if (!target) {
    throw new Error(
      `No available CLI for delegate kind "${kind}" (wanted ${route.provider}${route.model ? `/${route.model}` : ""}). Install the claude or codex CLI, or override the route in .agentify.yaml under models.routes.`,
    );
  }

  if (!task && kind !== "review") {
    throw new Error(`delegate ${kind} requires a task: agentify delegate ${kind} "<task>"`);
  }

  const diffSection = options.diffRef ? await buildDiffSection(root, options.diffRef) : null;
  const prompt = buildDelegatePrompt(kind, task, { diffSection });
  const lastMessagePath = target.provider === "codex"
    ? path.join(os.tmpdir(), `agentify-delegate-${process.pid}-${Math.random().toString(36).slice(2)}.md`)
    : null;
  const argv = buildDelegateCommand(target, prompt, {
    write: options.write === true,
    lastMessagePath,
  });

  const exec = options.runtime?.exec || ((command, args) => runProviderProcess(command, args, {
    cwd: root,
    timeoutMs: options.timeoutMs || DELEGATE_TIMEOUT_MS,
  }));

  const result = await exec(argv[0], argv.slice(1));

  let output = String(result.stdout || "").trim();
  if (lastMessagePath) {
    try {
      const lastMessage = (await fs.readFile(lastMessagePath, "utf8")).trim();
      if (lastMessage) {
        output = lastMessage;
      }
    } catch {
      // Fall back to captured stdout when the CLI did not write the file.
    }
    await fs.unlink(lastMessagePath).catch(() => {});
  }

  return {
    command: "delegate",
    kind,
    provider: target.provider,
    model: target.model,
    used_fallback: target.fallback,
    write: options.write === true,
    diff_ref: options.diffRef || null,
    exit_code: result.code,
    output,
    ...(result.code !== 0 ? { error: String(result.stderr || "").trim().slice(0, 2000) } : {}),
  };
}

function runProviderProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    // stdin must be closed: codex exec otherwise waits for extra input from
    // the pipe, and neither CLI needs interactive input in delegate mode.
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Delegated agent runs must not feed back into context tracking or
      // spawn their own session summaries — that would recurse.
      env: { ...process.env, AGENTIFY_CTX: "off" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        stderr += `\ndelegate timed out after ${Math.round(timeoutMs / 1000)}s`;
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function describeModelRoutes(config, runtime = {}) {
  const routes = resolveModelRoutes(config);
  const availability = await detectDelegateProviders(runtime);
  const entries = Object.entries(routes).map(([kind, route]) => {
    const target = pickRouteTarget(route, availability);
    return {
      kind,
      provider: route.provider,
      model: route.model ?? "(cli default)",
      use: route.use || "",
      available: Boolean(target),
      resolves_to: target ? `${target.provider}${target.model ? `/${target.model}` : ""}${target.fallback ? " (fallback)" : ""}` : "unavailable",
    };
  });
  return { command: "models", providers: availability, routes: entries };
}
