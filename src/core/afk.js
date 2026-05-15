import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";

import { ensureDir, ensurePrivateDir, exists, readText, relative, writePrivateText, writeText } from "./fs.js";
import { getChangedFiles } from "./git.js";
import { runProjectTests } from "./project-tests.js";
import { buildProviderTemplateCommand } from "./provider-command.js";
import { runExec } from "./exec.js";
import { bold, dim, log, success } from "./ui.js";

const execFileAsync = promisify(execFile);

export const AFK_PLAN_TYPE = "agentify-afk-plan";
export const AFK_PLAN_SCHEMA_VERSION = "1.0";
export const AFK_REQUIRED_SECTIONS = [
  "Goal",
  "Non-Goals",
  "Repo Context",
  "Implementation Steps",
  "Files To Touch",
  "Tests To Run",
  "Risks",
  "Done Criteria",
  "Cleanup",
];
const AFK_EXECUTION_HANDOFF_SECTION = "AFK Execution Handoff";
const AFK_SLUG_MAX_LENGTH = 48;
const AFK_TASK_SLUG_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "above",
  "add",
  "below",
  "for",
  "from",
  "in",
  "into",
  "need",
  "needs",
  "of",
  "on",
  "over",
  "should",
  "the",
  "to",
  "with",
]);

function nowIso() {
  return new Date().toISOString();
}

export function slugifyAfkTask(value) {
  const tokens = String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  const meaningfulTokens = tokens.filter((token) => !AFK_TASK_SLUG_STOP_WORDS.has(token));
  const slug = buildCompactSlug(meaningfulTokens.length > 0 ? meaningfulTokens : tokens);
  return slug || "afk-plan";
}

function slugifyAfkSlug(value) {
  return buildCompactSlug(String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean));
}

function buildCompactSlug(tokens) {
  const chosen = [];
  let length = 0;
  for (const token of tokens) {
    const nextLength = length + token.length + (chosen.length > 0 ? 1 : 0);
    if (nextLength > AFK_SLUG_MAX_LENGTH) {
      break;
    }
    chosen.push(token);
    length = nextLength;
  }
  return chosen.join("-") || tokens.join("-").slice(0, AFK_SLUG_MAX_LENGTH).replace(/-+$/g, "");
}

function isAfkPlanSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || ""));
}

function normalizeSlug(value, fallback) {
  return value ? slugifyAfkSlug(value) : slugifyAfkTask(fallback);
}

function frontmatterError(message) {
  return new Error(`Invalid AFK plan: ${message}`);
}

function parseFrontmatter(markdown) {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n").trim();
  if (!normalized.startsWith("---\n")) {
    throw frontmatterError("missing YAML frontmatter");
  }
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    throw frontmatterError("unterminated YAML frontmatter");
  }

  const rawFrontmatter = normalized.slice(4, endIndex).trim();
  const body = normalized.slice(endIndex + 4).trim();
  let data;
  try {
    data = YAML.parse(rawFrontmatter) || {};
  } catch (error) {
    throw frontmatterError(`YAML frontmatter could not be parsed (${error.message})`);
  }
  return { markdown: normalized, frontmatter: data, body };
}

export function validateAfkPlanMarkdown(markdown) {
  const parsed = parseFrontmatter(markdown);
  const frontmatter = parsed.frontmatter;

  if (String(frontmatter.schema_version || "") !== AFK_PLAN_SCHEMA_VERSION) {
    throw frontmatterError(`schema_version must be "${AFK_PLAN_SCHEMA_VERSION}"`);
  }
  if (String(frontmatter.type || "") !== AFK_PLAN_TYPE) {
    throw frontmatterError(`type must be "${AFK_PLAN_TYPE}"`);
  }
  if (!isAfkPlanSlug(frontmatter.slug)) {
    throw frontmatterError("slug must be a non-empty lowercase URL slug");
  }
  if (!frontmatter.task || String(frontmatter.task).trim().length === 0) {
    throw frontmatterError("task is required");
  }
  if (!frontmatter.provider || String(frontmatter.provider).trim().length === 0) {
    throw frontmatterError("provider is required");
  }
  if (String(frontmatter.status || "") !== "ready") {
    throw frontmatterError('status must be "ready"');
  }

  for (const section of AFK_REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
    if (!pattern.test(parsed.body)) {
      throw frontmatterError(`missing required section "## ${section}"`);
    }
  }

  return {
    markdown: parsed.markdown,
    frontmatter,
    body: parsed.body,
  };
}

function stripAfkExecutionHandoff(markdown) {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n").trim();
  const handoffPattern = new RegExp(`\\n##\\s+${AFK_EXECUTION_HANDOFF_SECTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n[\\s\\S]*$`);
  return normalized.replace(handoffPattern, "").trim();
}

function appendAfkExecutionHandoff(markdown, runCommand) {
  return [
    stripAfkExecutionHandoff(markdown),
    "",
    `## ${AFK_EXECUTION_HANDOFF_SECTION}`,
    `- Agentify writes this plan file before execution: \`${runCommand.replace(/^agentify afk run\s+/, "")}\`.`,
    "- In the current provider session, run `/compact` or `/clear` before starting execution.",
    "- Then run this command from the repository root:",
    "",
    "```sh",
    runCommand,
    "```",
  ].join("\n");
}

function stripMarkdownFence(value) {
  const trimmed = String(value || "").trim();
  const fenceMatch = trimmed.match(/^```(?:md|markdown)?\s*\n([\s\S]*?)\n```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function stripTranscriptPromptPrefix(line) {
  return String(line || "")
    .replace(/^[\s>•›]+/, "")
    .trimEnd();
}

function extractLooseAfkPlanMarkdown(output) {
  const lines = String(output || "").replace(/\r\n/g, "\n").split("\n");
  let best = "";

  for (let index = 0; index < lines.length; index += 1) {
    const first = stripTranscriptPromptPrefix(lines[index]);
    if (!/^schema_version:\s*["']?1\.0["']?\s*$/.test(first)) {
      continue;
    }

    const candidateLines = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const cleaned = stripTranscriptPromptPrefix(lines[cursor]);
      if (cleaned.startsWith("Token usage:") || cleaned.startsWith("To continue this session,")) {
        break;
      }
      candidateLines.push(cleaned);
    }

    const candidate = candidateLines.join("\n").trim();
    if (new RegExp(`^type:\\s*["']?${AFK_PLAN_TYPE}["']?\\s*$`, "m").test(candidate) && candidate.includes("# AFK Plan:")) {
      best = candidate;
    }
  }

  if (!best) {
    return "";
  }

  const bodyStart = best.indexOf("# AFK Plan:");
  if (bodyStart === -1) {
    return "";
  }

  return [
    "---",
    best.slice(0, bodyStart).trim(),
    "---",
    "",
    best.slice(bodyStart).trim(),
  ].join("\n");
}

export function extractAfkPlanMarkdown(output) {
  const normalized = String(output || "").replace(/\r\n/g, "\n");
  const fenced = [...normalized.matchAll(/```(?:md|markdown)?\s*\n([\s\S]*?type:\s*["']?agentify-afk-plan["']?[\s\S]*?)\n```/gi)]
    .map((match) => match[1].trim());
  if (fenced.length > 0) {
    return stripMarkdownFence(fenced.at(-1));
  }

  const typeIndex = normalized.lastIndexOf(AFK_PLAN_TYPE);
  if (typeIndex === -1) {
    return "";
  }
  const start = normalized.lastIndexOf("\n---\n", typeIndex);
  const fallbackStart = normalized.startsWith("---\n") ? 0 : -1;
  const planStart = start === -1 ? fallbackStart : start + 1;
  if (planStart === -1) {
    return extractLooseAfkPlanMarkdown(normalized);
  }

  return normalized.slice(planStart).trim();
}

export function renderAfkPlannerPrompt(task, options = {}) {
  const slug = normalizeSlug(options.slug, task);
  const createdAt = options.createdAt || nowIso();
  const provider = options.provider || "unknown";
  const plannedPath = `.agentify/planned/${slug}.md`;
  const defaultRunCommand = `agentify afk run ${plannedPath}`;

  return [
    "You are creating an Agentify AFK implementation plan.",
    "",
    "This is a planning-only session.",
    "- If repo or user-scoped skills are installed, load and use planning-relevant skills such as `grill-me`, `domain-model`, or `to-issues` when they fit the task.",
    "- Use `grill-me`-style questioning: ask the user important clarifying questions before producing the final plan.",
    "- Gather repo context with safe read-only discovery commands such as `agentify plan`, `agentify query ...`, `agentify context ...`, `rg`, `sed`, and `ls`.",
    "- Do not edit files, install dependencies, run migrations, or implement the task.",
    "- Do not install skills during AFK create; only use skills that are already available to the provider.",
    "- Your final answer must be exactly one markdown AFK plan with YAML frontmatter.",
    "",
    "Final answer contract:",
    "```md",
    "---",
    `schema_version: "${AFK_PLAN_SCHEMA_VERSION}"`,
    `type: "${AFK_PLAN_TYPE}"`,
    `slug: "${slug}"`,
    `task: ${JSON.stringify(task)}`,
    `created_at: "${createdAt}"`,
    `provider: "${provider}"`,
    'status: "ready"',
    "---",
    "",
    `# AFK Plan: ${slug}`,
    "",
    ...AFK_REQUIRED_SECTIONS.map((section) => `## ${section}\n- Fill this section with implementation-ready details.`),
    `## ${AFK_EXECUTION_HANDOFF_SECTION}`,
    `- Agentify writes this plan file before execution: \`${plannedPath}\`.`,
    "- In the current provider session, run `/compact` or `/clear` before starting execution.",
    "- Then run this command from the repository root:",
    "",
    "```sh",
    defaultRunCommand,
    "```",
    "```",
    "",
    "User task:",
    task,
  ].join("\n");
}

function buildSessionId(slug) {
  return `afk_${Date.now()}_${slug.replace(/[^a-z0-9-]/g, "").slice(0, 40)}`;
}

async function findAvailablePlanPath(root, slug, extension = ".md") {
  const plannedDir = path.join(root, ".agentify", "planned");
  await ensureDir(plannedDir);
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const candidate = path.join(plannedDir, `${slug}${suffix}${extension}`);
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to allocate an AFK plan path for slug "${slug}"`);
}

function quietReporter() {
  return {
    log() {},
    appendSection() {},
    setCommand() {},
    setExecution() {},
    setValidation() {},
    setTests() {},
    async finalize() {},
  };
}

async function runGit(root, args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: 1024 * 1024 * 10,
    ...options,
  });
  return result.stdout.trim();
}

async function getCurrentBranch(root) {
  return runGit(root, ["branch", "--show-current"]).catch(() => "");
}

async function getDefaultBranch(root) {
  const ref = await runGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]).catch(() => "");
  return ref.replace(/^refs\/remotes\/origin\//, "") || "main";
}

async function assertCleanWorktree(root, flagName) {
  const changed = await getChangedFiles(root);
  if (changed.length > 0) {
    throw new Error(`agentify afk run requires a clean worktree. Commit/stash changes or pass ${flagName}.`);
  }
}

async function createAfkWorktree(root, slug) {
  await assertCleanWorktree(root, "--allow-dirty");
  const parent = path.dirname(root);
  const worktreePath = path.join(parent, `${path.basename(root)}.afk-${slug}`);
  const branch = `afk/${slug}`;
  if (await exists(worktreePath)) {
    throw new Error(`AFK worktree already exists at ${worktreePath}`);
  }
  await runGit(root, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  return { worktreePath, branch, created: true };
}

function isAfkCommitCandidate(filePath) {
  const normalized = String(filePath || "").replaceAll(path.sep, "/").replace(/^\.\//, "");
  return Boolean(normalized)
    && !normalized.startsWith(".agentify/")
    && !normalized.startsWith(".current_session/")
    && normalized !== "agentify-report.html"
    && normalized !== "output.txt"
    && normalized !== "AGENTIFY.md"
    && !normalized.endsWith("/AGENTIFY.md")
    && !normalized.startsWith("docs/modules/")
    && normalized !== "docs/repo-map.md";
}

async function commitAfkChanges(root, slug, task) {
  const files = (await getChangedFiles(root))
    .map((file) => file.path)
    .filter(isAfkCommitCandidate);
  if (files.length === 0) {
    return null;
  }
  await runGit(root, ["add", "--", ...files]);
  const subject = `chore: complete AFK plan ${slug}`.slice(0, 72);
  await runGit(root, ["commit", "-m", subject, "-m", String(task || "").trim()]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

export async function runAfkCreate(root, config, args) {
  const task = args._.slice(2).join(" ").trim();
  if (!task) {
    throw new Error('afk create requires a task: agentify afk create "task"');
  }

  const provider = config.provider;
  const slug = normalizeSlug(args.slug, task);
  const prompt = renderAfkPlannerPrompt(task, { slug, provider });
  const agentCommand = buildProviderTemplateCommand(provider, prompt, {
    root,
    interactive: true,
    continueSession: false,
  });
  const sessionId = buildSessionId(slug);
  const capturePath = path.join(root, ".agentify", "session", sessionId, "interactive.log");
  await ensurePrivateDir(path.dirname(capturePath));

  const result = await runExec(root, config, agentCommand, {
    commandName: "afk-create",
    skipRefresh: true,
    captureOutputMode: "pty",
    capturePath,
    skipCodeBodyChanges: true,
  });
  const output = [result.stdout, result.stderr, result.interactiveTranscript].filter(Boolean).join("\n");
  if (result.exitCode !== 0) {
    const rawPath = await findAvailablePlanPath(root, slug, ".raw.md");
    await writeText(rawPath, `${output.trim()}\n`);
    throw new Error(`AFK provider command failed with exit code ${result.exitCode}. Raw provider output was saved to ${relative(root, rawPath)}.`);
  }

  const extracted = extractAfkPlanMarkdown(output);
  let plan;
  try {
    plan = validateAfkPlanMarkdown(extracted);
  } catch (error) {
    const rawPath = await findAvailablePlanPath(root, slug, ".raw.md");
    await writeText(rawPath, `${output.trim()}\n`);
    throw new Error(`${error.message}. Raw provider output was saved to ${relative(root, rawPath)}.`);
  }

  const planPath = await findAvailablePlanPath(root, normalizeSlug(plan.frontmatter.slug, slug));
  const runCommand = `agentify afk run ${relative(root, planPath)}`;
  const savedPlanMarkdown = appendAfkExecutionHandoff(plan.markdown, runCommand);
  await writeText(planPath, `${savedPlanMarkdown}\n`);
  await writePrivateText(path.join(root, ".agentify", "session", sessionId, "afk-create.json"), `${JSON.stringify({
    schema_version: "1.0",
    type: "agentify-afk-create",
    session_id: sessionId,
    provider,
    task,
    plan_path: relative(root, planPath),
    created_at: nowIso(),
  }, null, 2)}\n`);

  return {
    command: "afk create",
    task,
    slug: path.basename(planPath, ".md"),
    provider,
    plan_path: relative(root, planPath),
    session_id: sessionId,
    run_command: runCommand,
    next_step_hint: "Before running the command, use /compact or /clear in the current provider session so execution starts with a clean prompt.",
  };
}

function resolvePlanPath(root, value) {
  if (!value) {
    throw new Error("afk run requires a plan path");
  }
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function renderAfkRunPrompt(plan) {
  return [
    "You are running an Agentify AFK plan in a fresh provider session.",
    "Do not continue previous provider history.",
    "Implement only the plan below. Keep changes scoped, run the listed tests, and stop if the plan is unsafe or ambiguous.",
    "",
    stripAfkExecutionHandoff(plan.markdown),
  ].join("\n");
}

function shouldAutoCommit(args, createdWorktree) {
  return createdWorktree && args.noCommit !== true;
}

function normalizeCleanupMode(value) {
  if (value === undefined || value === null || value === true) {
    return process.stdin.isTTY ? "ask" : "keep";
  }
  const mode = String(value).trim().toLowerCase();
  if (!["keep", "delete", "ask"].includes(mode)) {
    throw new Error("afk run --cleanup must be one of: keep, delete, ask");
  }
  return mode;
}

export async function runAfkRun(root, config, args) {
  const planPath = resolvePlanPath(root, args._[2] || args.plan);
  const plan = validateAfkPlanMarkdown(await readText(planPath));
  const slug = normalizeSlug(plan.frontmatter.slug);
  const task = String(plan.frontmatter.task || "");
  const currentWorktree = args.currentWorktree === true;
  const cleanupMode = normalizeCleanupMode(args.cleanup);
  let executionRoot = root;
  let branch = await getCurrentBranch(root);
  let createdWorktree = false;

  if (currentWorktree) {
    if (args.allowDirty !== true) {
      await assertCleanWorktree(root, "--allow-dirty");
    }
    const defaultBranch = await getDefaultBranch(root);
    if (["main", "master", defaultBranch].includes(branch) && args.noCommit !== true) {
      throw new Error("afk run --current-worktree will not auto-commit on the default/protected branch. Use the default isolated worktree flow or pass --no-commit.");
    }
  } else {
    const created = await createAfkWorktree(root, slug);
    executionRoot = created.worktreePath;
    branch = created.branch;
    createdWorktree = true;
  }

  const interactive = args.interactive === true;
  const prompt = renderAfkRunPrompt(plan);
  const agentCommand = buildProviderTemplateCommand(config.provider, prompt, {
    root: executionRoot,
    interactive,
    continueSession: false,
  });
  const captureOutputMode = interactive ? "inherit" : "pipe";

  const execResult = await runExec(executionRoot, config, agentCommand, {
    commandName: "afk-run",
    skipRefresh: true,
    captureOutputMode,
    skipCodeBodyChanges: true,
  });
  if (execResult.exitCode !== 0) {
    return {
      command: "afk run",
      status: "provider_failed",
      exit_code: execResult.exitCode,
      worktree_path: executionRoot,
      branch,
      committed: false,
      commit: null,
      cleanup: { mode: cleanupMode, keep_plan: true },
    };
  }

  const tests = await runProjectTests(executionRoot, quietReporter(), { config });
  let commit = null;
  if (tests.passed && shouldAutoCommit(args, createdWorktree)) {
    commit = await commitAfkChanges(executionRoot, slug, task);
  }
  const status = tests.passed ? "complete" : "verification_failed";
  if (status !== "complete") {
    process.exitCode = 1;
  }
  const shouldDeletePlan = status === "complete" && cleanupMode === "delete";
  if (shouldDeletePlan) {
    await fs.rm(planPath, { force: true });
  }

  return {
    command: "afk run",
    status,
    plan_path: relative(root, planPath),
    worktree_path: executionRoot,
    branch,
    created_worktree: createdWorktree,
    tests,
    committed: Boolean(commit),
    commit,
    cleanup: {
      mode: cleanupMode,
      keep_plan: !shouldDeletePlan,
      command: cleanupMode === "delete" ? null : `agentify clean --planned`,
    },
  };
}

function printAfkCreateResult(result, config) {
  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  success("AFK plan written");
  log(`Plan: ${dim(result.plan_path)}`);
  log(`${bold("Next command")}: ${dim(result.run_command)}`);
  log("Tip: run /compact or /clear in this provider session first, then paste the command into a fresh prompt.");
}

function printAfkRunResult(result, config) {
  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const status = result.status === "complete" ? "AFK run complete" : `AFK run ${result.status}`;
  result.status === "complete" ? success(status) : log(status);
  log(`${bold("Worktree")}: ${dim(result.worktree_path)}`);
  log(`${bold("Branch")}: ${dim(result.branch || "unknown")}`);
  if (result.commit) {
    log(`${bold("Commit")}: ${dim(result.commit)}`);
  }
  if (result.tests?.command) {
    log(`${bold("Tests")}: ${dim(`${result.tests.status} (${result.tests.command} ${result.tests.args?.join(" ") || ""})`)}`);
  }
  if (result.cleanup?.command) {
    log(`${bold("Cleanup")}: ${dim(result.cleanup.command)}`);
  }
}

export async function runAfk(root, config, args, runtime = {}) {
  const subcommand = args._[1];
  if (subcommand === "create") {
    return printAfkCreateResult(await runAfkCreate(root, config, args), config);
  }
  if (subcommand === "run") {
    return printAfkRunResult(await runAfkRun(root, config, args), config);
  }
  if (subcommand === "clean") {
    const runClean = runtime.runClean;
    if (!runClean) {
      throw new Error("afk clean requires cleanup support");
    }
    const result = await runClean(root, config, { planned: true, sessions: true });
    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (config.dryRun) {
      log(`AFK cleanup dry-run: ${result.removed_count} item(s) would be pruned.`);
    } else {
      success(`AFK cleanup removed ${result.removed_count} item(s).`);
    }
    return;
  }
  throw new Error("afk requires a subcommand: create, run, or clean");
}
