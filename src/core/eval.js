// Paired Agentify+Claude vs plain-Claude benchmark runner (#293).
//
// Answers one question: "On the same commit, prompt, Claude model, budget,
// and deterministic grader, does Agentify raise pass rate or lower cost
// versus plain Claude?" Every attempt runs in a disposable clone at an
// immutable commit — never in the user's checkout — and pass/fail comes from
// deterministic checks, never from the provider exit code.
//
// This module deliberately does NOT reuse runDelegate: delegated providers
// run with AGENTIFY_CTX=off to prevent hook recursion, which would silently
// disable the very context integration the `agentify` arm exists to measure.
//
// Known limitations, accepted for a local runner (container isolation is
// #298's scope):
// - A disposable clone is process isolation, not a security boundary: task
//   manifests are repo-committed and trusted like CI config, and their setup/
//   grader commands run as the invoking user with the host environment.
// - A crash between provider spend and the local spend record can re-run one
//   attempt on resume; overshoot is bounded by that attempt's per-run cap.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { checkRollingBudget, resolveBudgetPolicy } from "./budget.js";
import { ensureDir, exists, readJson, readText, writeJson, writeText } from "./fs.js";
import { installIntegration, removeManagedBlock, stripManagedHooks } from "./integrations.js";
import { detectDelegateProviders, parseClaudeJsonOutput } from "./models.js";
import { recordDelegation } from "./stats.js";
import { redactSensitiveText } from "./redact.js";
import { VERSION } from "./cli-fast-paths.js";

const execFileAsync = promisify(execFile);

export const EVAL_TASK_SCHEMA_VERSION = "eval-task-v1";
export const EVAL_RUN_SCHEMA_VERSION = "eval-run-v1";
export const EVAL_ATTEMPT_SCHEMA_VERSION = "eval-attempt-v1";

// Arms are paired Claude runs that differ only in project integration:
// - agentify: normal Agentify install (hooks + guidance) and seeded context.
// - plain-safe: `claude --safe-mode` — no CLAUDE.md, hooks, skills, or MCP.
// - plain-project: Agentify's managed CLAUDE/settings blocks removed, all
//   unrelated project guidance preserved.
export const EVAL_ARMS = ["agentify", "plain-safe", "plain-project"];
export const DEFAULT_EVAL_ARMS = ["agentify", "plain-safe"];

const SETUP_TIMEOUT_MS = 600000;
const GRADER_TIMEOUT_MS = 300000;
const VERSION_PROBE_TIMEOUT_MS = 10000;
const OUTPUT_TAIL_CHARS = 4000;
const DEFAULT_KEEP_RUNS = 20;

export function resolveEvalPaths(root, config = {}) {
  const tasksDir = typeof config.eval?.tasksDir === "string" && config.eval.tasksDir.trim()
    ? config.eval.tasksDir.trim()
    : "evals";
  return {
    tasksDir: path.join(root, tasksDir),
    // Run artifacts live under the ignored Agentify runtime dir, never in
    // tracked paths.
    runsRoot: path.join(root, ".agentify", "evals", "runs"),
  };
}

function evalRetention(config = {}) {
  const keep = Number(config.eval?.keepRuns);
  return Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DEFAULT_KEEP_RUNS;
}

function fail(source, message) {
  throw new Error(`Invalid eval task${source ? ` (${source})` : ""}: ${message}`);
}

function requirePositiveNumber(value, label, source, { integer = false } = {}) {
  const num = Number(value);
  if (value === null || value === undefined || value === "" || typeof value === "boolean"
    || !Number.isFinite(num) || num <= 0 || (integer && !Number.isInteger(num))) {
    fail(source, `${label} must be a positive ${integer ? "integer" : "number"}, got "${value}"`);
  }
  return num;
}

function stringArray(value, label, source) {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(source, `${label} must be a list of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

// Validate and normalize a task manifest. Budgets, turns, and timeout are
// mandatory: an eval task without explicit ceilings must not exist.
export function validateEvalTask(raw, source = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(source, "manifest must be a YAML mapping");
  }
  if (raw.schema !== EVAL_TASK_SCHEMA_VERSION) {
    fail(source, `schema must be "${EVAL_TASK_SCHEMA_VERSION}", got "${raw.schema}"`);
  }
  const id = String(raw.id || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    fail(source, "id must be alphanumeric with dashes/underscores");
  }
  const prompt = String(raw.prompt || "").trim();
  if (!prompt) {
    fail(source, "prompt is required");
  }
  const baseRef = String(raw.base_ref || "").trim();
  if (!baseRef) {
    fail(source, "base_ref is required (an immutable commit to run every arm from)");
  }
  const model = String(raw.model || "").trim();
  // Paired arms need an identical, version-pinned model on both sides; a
  // floating alias could resolve differently between attempts.
  if (!model || !/\d/.test(model)) {
    fail(source, `model must be a full versioned Claude model ID (e.g. claude-haiku-4-5-20251001), got "${model || raw.model}"`);
  }
  const graderCommands = stringArray(raw.grader?.commands, "grader.commands", source);
  if (graderCommands.length === 0) {
    fail(source, "grader.commands must contain at least one deterministic check command");
  }
  const arms = raw.arms === null || raw.arms === undefined
    ? [...DEFAULT_EVAL_ARMS]
    : stringArray(raw.arms, "arms", source);
  for (const arm of arms) {
    if (!EVAL_ARMS.includes(arm)) {
      fail(source, `unknown arm "${arm}" (available: ${EVAL_ARMS.join(", ")})`);
    }
  }
  if (new Set(arms).size < 2) {
    fail(source, "arms must list at least two distinct arms to form a paired experiment");
  }
  const effortRaw = raw.effort === null || raw.effort === undefined || raw.effort === "" ? null : String(raw.effort).trim().toLowerCase();
  if (effortRaw !== null && !/^[a-z]+$/.test(effortRaw)) {
    fail(source, `effort must be a simple level name (e.g. low, medium, high), got "${raw.effort}"`);
  }
  const contextAblations = normalizeContextAblations(raw.context_ablations, source);

  return {
    schema: EVAL_TASK_SCHEMA_VERSION,
    id,
    description: String(raw.description || "").trim(),
    prompt,
    base_ref: baseRef,
    model,
    effort: effortRaw,
    max_budget_usd: requirePositiveNumber(raw.max_budget_usd, "max_budget_usd", source),
    max_turns: requirePositiveNumber(raw.max_turns, "max_turns", source, { integer: true }),
    timeout_seconds: requirePositiveNumber(raw.timeout_seconds, "timeout_seconds", source),
    repeat: raw.repeat === null || raw.repeat === undefined
      ? 1
      : requirePositiveNumber(raw.repeat, "repeat", source, { integer: true }),
    setup: stringArray(raw.setup, "setup", source),
    grader: { commands: graderCommands },
    forbidden_paths: stringArray(raw.forbidden_paths, "forbidden_paths", source),
    arms: [...new Set(arms)],
    // The profile is fixed and identical across arms so the report can never
    // confound harness value with a stronger routing policy (#295).
    profile: String(raw.profile || "balanced").trim().toLowerCase(),
    seed_context: raw.seed_context !== false,
    context_ablations: contextAblations,
  };
}

// Context ablation variants of the agentify arm (#296): same install, same
// seeded context, but the injection mode/budget is overridden per attempt via
// env so relevant/digest/off and budget levels become measurable arms.
const CONTEXT_ABLATION_MODES = new Set(["relevant", "digest", "off"]);
const CONTEXT_ABLATION_PATTERN = /^(relevant|digest|off)(?:@(\d+))?$/;

function normalizeContextAblations(raw, source) {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(source, "context_ablations must be a non-empty list");
  }
  const labels = new Set();
  const ablations = raw.map((entry) => {
    let ablation;
    if (typeof entry === "string") {
      const match = CONTEXT_ABLATION_PATTERN.exec(entry.trim().toLowerCase());
      if (!match) {
        fail(source, `context_ablations entry "${entry}" must be relevant, digest, off, or relevant@<tokens>`);
      }
      ablation = { mode: match[1], max_injected_tokens: match[2] === undefined ? null : Number(match[2]) };
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      // Normalized form, as written back to run.json and re-validated on resume.
      const mode = String(entry.mode || "").trim().toLowerCase();
      if (!CONTEXT_ABLATION_MODES.has(mode)) {
        fail(source, `context_ablations entry has unknown mode "${entry.mode}"`);
      }
      const budget = entry.max_injected_tokens === null || entry.max_injected_tokens === undefined
        ? null
        : Number(entry.max_injected_tokens);
      if (budget !== null && (!Number.isInteger(budget) || budget < 0)) {
        fail(source, `context_ablations max_injected_tokens must be a non-negative integer, got "${entry.max_injected_tokens}"`);
      }
      ablation = { mode, max_injected_tokens: budget };
    } else {
      fail(source, "context_ablations entries must be strings or {mode, max_injected_tokens} mappings");
    }
    if (ablation.max_injected_tokens !== null && ablation.mode !== "relevant") {
      fail(source, `context_ablations budget variants are only valid for relevant mode (got "${ablation.mode}@${ablation.max_injected_tokens}")`);
    }
    const label = contextAblationLabel(ablation);
    if (labels.has(label)) {
      fail(source, `context_ablations lists duplicate variant "${label}"`);
    }
    labels.add(label);
    return ablation;
  });
  return ablations;
}

// The unmodified default (relevant mode, policy-resolved budget) keeps the
// plain "agentify" arm label so it stays the pairing baseline; every other
// variant gets a distinct arm label and therefore its own report bucket.
export function contextAblationLabel(ablation) {
  if (!ablation || (ablation.mode === "relevant" && ablation.max_injected_tokens === null)) {
    return "agentify";
  }
  return `agentify-ctx-${ablation.mode}${ablation.max_injected_tokens === null ? "" : `-${ablation.max_injected_tokens}`}`;
}

export function isAgentifyArm(arm) {
  return arm === "agentify" || String(arm || "").startsWith("agentify-ctx-");
}

// Expand base arms into concrete run variants. Only the agentify arm carries
// context ablations; baseline arms run with Agentify context provably off.
export function expandArmVariants(task, arms) {
  const variants = [];
  for (const arm of arms) {
    if (arm === "agentify" && Array.isArray(task.context_ablations) && task.context_ablations.length > 0) {
      for (const ablation of task.context_ablations) {
        variants.push({ arm: contextAblationLabel(ablation), base_arm: "agentify", context_ablation: ablation });
      }
    } else {
      variants.push({ arm, base_arm: arm, context_ablation: null });
    }
  }
  return variants;
}

export async function loadEvalTask(root, ref, config = {}) {
  if (!ref || !String(ref).trim()) {
    throw new Error('eval requires a task: agentify eval run <task-id-or-path>');
  }
  const requested = String(ref).trim();
  const { tasksDir } = resolveEvalPaths(root, config);
  const candidates = /\.ya?ml$/i.test(requested)
    ? [path.resolve(root, requested)]
    : [path.join(tasksDir, `${requested}.yaml`), path.join(tasksDir, `${requested}.yml`)];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      const parsed = parseYaml(await readText(candidate));
      const task = validateEvalTask(parsed, path.relative(root, candidate));
      return { task, path: candidate };
    }
  }
  throw new Error(`No eval task found for "${requested}" (looked in ${candidates.map((c) => path.relative(root, c)).join(", ")}). Create one with: agentify eval init ${requested}`);
}

export async function initEvalTask(root, name, config = {}, { dryRun = false } = {}) {
  const id = String(name || "sample").trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error(`eval init requires an alphanumeric task name, got "${name}"`);
  }
  const { tasksDir } = resolveEvalPaths(root, config);
  const taskPath = path.join(tasksDir, `${id}.yaml`);
  if (await exists(taskPath)) {
    throw new Error(`Eval task already exists at ${path.relative(root, taskPath)}`);
  }
  const baseSha = await resolveCommit(root, "HEAD");
  const manifest = {
    schema: EVAL_TASK_SCHEMA_VERSION,
    id,
    description: "Describe what a passing attempt must achieve.",
    // Pinned at init time so every arm and every repeat starts from the same
    // immutable commit. Update deliberately, never implicitly.
    base_ref: baseSha,
    prompt: "Replace with the exact task prompt given to every arm.",
    model: "claude-haiku-4-5-20251001",
    effort: null,
    max_budget_usd: 0.25,
    max_turns: 6,
    timeout_seconds: 300,
    repeat: 1,
    arms: [...DEFAULT_EVAL_ARMS],
    setup: [],
    grader: {
      commands: [
        "echo 'replace with deterministic checks (tests, linters, forbidden-change checks)' && exit 1",
      ],
    },
    // .agentify/** needs no entry here: the harness's own runtime store is
    // always excluded from grading capture.
    forbidden_paths: [".claude/**", "CLAUDE.md"],
    profile: "balanced",
    seed_context: true,
  };
  if (!dryRun) {
    await ensureDir(tasksDir);
    await writeText(taskPath, stringifyYaml(manifest));
  }
  return { command: "eval", action: "init", path: taskPath, task: manifest, dry_run: dryRun };
}

async function resolveCommit(root, ref) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root });
    return stdout.trim();
  } catch {
    throw new Error(`Cannot resolve "${ref}" to a commit in ${root}. base_ref must name an existing commit.`);
  }
}

export function buildEvalArmCommand(arm, task) {
  const argv = [
    "claude", "-p", task.prompt,
    "--output-format", "json",
    "--model", task.model,
    "--max-budget-usd", String(task.max_budget_usd),
    "--max-turns", String(task.max_turns),
    "--no-session-persistence",
    "--permission-mode", "acceptEdits",
  ];
  if (task.effort) {
    argv.push("--effort", task.effort);
  }
  if (arm === "plain-safe") {
    // Vanilla-Claude baseline: no CLAUDE.md, hooks, skills, plugins, or MCP,
    // with auth/model/built-in tools preserved.
    argv.push("--safe-mode");
  }
  return argv;
}

function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function shuffled(items, random = Math.random) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Match git-relative changed paths against manifest globs: `**` crosses
// directory boundaries, `*` stays within one segment.
export function matchesForbiddenPath(filePath, patterns) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return (patterns || []).filter((pattern) => {
    const source = String(pattern).replace(/\\/g, "/");
    const regex = new RegExp(`^${source
      .split(/(\*\*\/|\*\*|\*)/)
      .map((part) => {
        if (part === "**/") return "(?:.*/)?";
        if (part === "**") return ".*";
        if (part === "*") return "[^/]*";
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("")}$`);
    return regex.test(normalized);
  });
}

// Build the full execution plan without touching the filesystem or starting
// any process. Dry-run output is this plan verbatim.
export async function planEvalRun(root, config, taskRef, options = {}) {
  const { task, path: taskPath } = await loadEvalTask(root, taskRef, config);
  const repeat = options.repeat === undefined || options.repeat === null
    ? task.repeat
    : requirePositiveNumber(options.repeat, "--repeat", "cli", { integer: true });
  const arms = options.arms
    ? validateEvalTask({ ...task, arms: String(options.arms).split(",").map((arm) => arm.trim()).filter(Boolean) }, "cli --arms").arms
    : task.arms;
  const baseSha = await resolveCommit(root, task.base_ref);

  const attempts = [];
  for (const variant of expandArmVariants(task, arms)) {
    for (let index = 0; index < repeat; index += 1) {
      attempts.push({
        attempt_id: `${variant.arm}-${index + 1}`,
        arm: variant.arm,
        base_arm: variant.base_arm,
        context_ablation: variant.context_ablation,
        repeat_index: index + 1,
        argv: buildEvalArmCommand(variant.base_arm, task),
      });
    }
  }

  return {
    task,
    task_path: path.relative(root, taskPath),
    base_sha: baseSha,
    // Concrete arm labels for this run, context-ablation variants included.
    arms: [...new Set(attempts.map((attempt) => attempt.arm))],
    repeat,
    attempts,
    // The hard ceiling for the whole run: every attempt is capped natively by
    // --max-budget-usd, so total spend cannot exceed arms × repeats × cap.
    max_spend_usd: Number((attempts.length * task.max_budget_usd).toFixed(6)),
    profile: task.profile,
  };
}

function childEnv(arm, extraEnv = {}, contextAblation = null) {
  const env = { ...process.env, ...extraEnv };
  // Never inherit a parent shell's ablation overrides: each attempt's context
  // configuration must come from its own plan entry only.
  delete env.AGENTIFY_CTX_INJECTION;
  delete env.AGENTIFY_CTX_BUDGET;
  if (isAgentifyArm(arm)) {
    // The whole point of this arm is live context hooks — make sure a parent
    // delegate/eval process cannot leak its recursion guard into it.
    delete env.AGENTIFY_CTX;
    if (contextAblation) {
      env.AGENTIFY_CTX_INJECTION = contextAblation.mode;
      if (contextAblation.max_injected_tokens !== null) {
        env.AGENTIFY_CTX_BUDGET = String(contextAblation.max_injected_tokens);
      }
    }
  } else {
    // Baseline arms must provably receive no Agentify context, including from
    // a global ~/.claude installation that project stripping cannot reach.
    env.AGENTIFY_CTX = "off";
  }
  return env;
}

// Keep only the newest bytes when a child floods stdout/stderr; the Claude
// result envelope arrives last, so the tail is the part that matters.
const MAX_CAPTURE_CHARS = 8 * 1024 * 1024;

function appendCapped(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE_CHARS ? next.slice(-MAX_CAPTURE_CHARS) : next;
}

function runProcess(command, args, { cwd, env, timeoutMs, shell = false }) {
  return new Promise((resolve) => {
    // detached puts the child in its own process group so a timeout kill
    // reaches grandchildren (provider subprocesses, setup script pipelines).
    const child = shell
      ? spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
      : spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${String(error.stderr || error.message).trim()}`, { cause: error });
  }
}

// Clone the repo at the immutable base commit into a per-attempt workspace.
// Never reuses a workspace between attempts and never runs in the checkout.
async function prepareWorkspace(root, workspace, baseSha) {
  await ensureDir(path.dirname(workspace));
  await git(root, ["clone", "--quiet", "--no-hardlinks", root, workspace]);
  const checkedOut = await git(workspace, ["checkout", "--quiet", "--detach", baseSha], { allowFailure: true });
  if (checkedOut === null) {
    throw new Error(`base_ref ${baseSha} is not reachable from any local branch or tag, so the disposable clone cannot check it out.`);
  }
  // The eval agent must not be able to push anywhere from the workspace.
  await git(workspace, ["remote", "remove", "origin"], { allowFailure: true });
}

async function prepareArm(root, workspace, arm, task) {
  if (isAgentifyArm(arm)) {
    await installIntegration(workspace, { provider: "claude" });
    const seedSource = path.join(root, ".agentify", "context");
    if (task.seed_context && await exists(seedSource)) {
      await fs.cp(seedSource, path.join(workspace, ".agentify", "context"), { recursive: true });
      // Seeded notes/events/summaries are the arm's memory, but telemetry and
      // the injection ledger must start empty: per-attempt context metrics
      // have to describe this attempt only, and a seeded seen-ledger would
      // suppress injections the attempt never received.
      await fs.rm(path.join(workspace, ".agentify", "context", "value-events.jsonl"), { force: true });
      await fs.rm(path.join(workspace, ".agentify", "context", "injected.json"), { force: true });
      await fs.rm(path.join(workspace, ".agentify", "context", "summary-usage.jsonl"), { force: true });
    }
    return;
  }
  if (arm === "plain-project") {
    // Remove only Agentify's managed blocks; unrelated project guidance stays.
    const memoryPath = path.join(workspace, "CLAUDE.md");
    if (await exists(memoryPath)) {
      const result = removeManagedBlock(await readText(memoryPath));
      if (result.changed) {
        await writeText(memoryPath, result.text);
      }
    }
    const settingsPath = path.join(workspace, ".claude", "settings.json");
    if (await exists(settingsPath)) {
      try {
        const result = stripManagedHooks(JSON.parse(await readText(settingsPath)));
        if (result.changed) {
          await writeText(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`);
        }
      } catch {
        // Unparseable settings stay untouched; safe-mode is the clean arm.
      }
    }
  }
}

// Stage everything, including files under forbidden patterns that the repo's
// .gitignore would normally hide (.agentify/**, .claude/** are commonly
// ignored) — otherwise a provider edit to a forbidden-but-ignored path would
// never appear in the graded diff. Ignored paths are selected with the same
// matcher the violation check uses (no git-glob divergence) and force-added
// by exact path, so a real add failure propagates instead of failing open.
async function stageAll(workspace, forbiddenPatterns = []) {
  await git(workspace, ["add", "-A"]);
  if (forbiddenPatterns.length === 0) {
    return;
  }
  // --directory collapses fully-ignored trees (node_modules/) to one entry;
  // a collapsed `dir/` entry still matches a `dir/**` pattern and force-adds
  // recursively.
  const output = await git(workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  const hidden = output.split("\0").filter(Boolean)
    // .agentify/ is harness bookkeeping, excluded from grading entirely.
    .filter((entry) => entry !== ".agentify/" && !entry.startsWith(".agentify/"))
    .filter((entry) => matchesForbiddenPath(entry, forbiddenPatterns).length > 0);
  for (let index = 0; index < hidden.length; index += 100) {
    await git(workspace, ["add", "-f", "--", ...hidden.slice(index, index + 100)]);
  }
}

// Commit arm preparation (integration install/strip, setup commands) so the
// graded diff contains only what the provider changed — never setup noise —
// and forbidden-path checks cannot fire on Agentify's own arm scaffolding.
async function sealArmSetup(workspace, forbiddenPatterns) {
  await stageAll(workspace, forbiddenPatterns);
  await git(workspace, [
    "-c", "user.name=agentify-eval",
    "-c", "user.email=eval@agentify.invalid",
    "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "agentify-eval: arm setup",
  ]);
}

function tail(text) {
  const value = redactSensitiveText(String(text || ""));
  return value.length > OUTPUT_TAIL_CHARS ? value.slice(-OUTPUT_TAIL_CHARS) : value;
}

async function captureChanges(workspace, forbiddenPatterns) {
  // Stage everything (including untracked and forbidden-but-ignored files) so
  // the patch and the forbidden-path check see the complete effect of the
  // attempt. HEAD is the arm-setup commit, so the diff is exactly the
  // provider's work.
  await stageAll(workspace, forbiddenPatterns);
  // The workspace's .agentify/ runtime store is always excluded: in the
  // agentify arm the live hooks write context events there by design, and
  // grading harness bookkeeping as provider work would corrupt the paired
  // comparison (and trip forbidden-path checks on the arm's own telemetry).
  const pathspec = ["--", ".", ":(exclude).agentify"];
  const patch = await git(workspace, ["diff", "--cached", "HEAD", ...pathspec]) || "";
  // NUL-delimited so non-ASCII/special filenames are never C-quoted into a
  // form the forbidden matcher would miss.
  const nameOutput = await git(workspace, ["diff", "--cached", "--name-only", "-z", "HEAD", ...pathspec]) || "";
  const changedPaths = nameOutput.split("\0").filter(Boolean);
  return { patch, changedPaths };
}

async function gradeAttempt(workspace, task, env) {
  const { patch, changedPaths } = await captureChanges(workspace, task.forbidden_paths);
  const forbidden = [];
  for (const filePath of changedPaths) {
    const matched = matchesForbiddenPath(filePath, task.forbidden_paths);
    if (matched.length > 0) {
      forbidden.push({ path: filePath, patterns: matched });
    }
  }
  const checks = [];
  for (const command of task.grader.commands) {
    const result = await runProcess(command, [], { cwd: workspace, env, timeoutMs: GRADER_TIMEOUT_MS, shell: true });
    checks.push({
      command,
      exit_code: result.code,
      passed: result.code === 0 && !result.timedOut,
      timed_out: result.timedOut,
      output_tail: tail(`${result.stdout}\n${result.stderr}`.trim()),
    });
  }
  return {
    // Deterministic verdict only: provider exit code plays no part.
    pass: forbidden.length === 0 && checks.every((check) => check.passed),
    forbidden_violations: forbidden,
    checks,
    changed_paths: changedPaths,
    patch,
  };
}

async function probeClaudeVersion(env) {
  const result = await runProcess("claude", ["--version"], {
    cwd: process.cwd(),
    env,
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

// Per-attempt context telemetry, read from the workspace's value-events log
// before the workspace is deleted. The agentify arm's own hooks wrote these
// during the attempt; baseline arms have none by construction.
async function collectContextMetrics(workspace) {
  const eventsPath = path.join(workspace, ".agentify", "context", "value-events.jsonl");
  if (!(await exists(eventsPath))) {
    return null;
  }
  const metrics = {
    injections: 0,
    injected_items: 0,
    estimated_tokens: 0,
    decisions_reused: 0,
    stale_context_rejected: 0,
    truncated_items: 0,
    over_budget_skips: 0,
    max_match_ms: null,
    budget_max_tokens: null,
  };
  for (const line of (await readText(eventsPath)).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || event.type !== "context_injection") continue;
    const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    metrics.injections += 1;
    metrics.injected_items += finite(event.injected_items);
    metrics.estimated_tokens += finite(event.estimated_tokens);
    metrics.decisions_reused += finite(event.decisions_reused);
    metrics.stale_context_rejected += finite(event.stale_context_rejected);
    metrics.truncated_items += finite(event.budget?.truncated_items);
    metrics.over_budget_skips += finite(event.budget?.skipped?.over_budget) + finite(event.budget?.skipped?.exceeds_total_budget);
    if (Number.isFinite(Number(event.match_ms))) {
      metrics.max_match_ms = Math.max(metrics.max_match_ms ?? 0, Number(event.match_ms));
    }
    if (Number.isFinite(Number(event.budget?.max_tokens))) {
      metrics.budget_max_tokens = Number(event.budget.max_tokens);
    }
  }
  // A present-but-empty log still returns zeros: "hooks ran, nothing was
  // injected" is a real measurement, distinct from "no log" (null).
  return metrics;
}

async function runAttempt(root, runDir, plan, attempt, options) {
  const attemptDir = path.join(runDir, "attempts", attempt.attempt_id);
  const workspace = path.join(attemptDir, "workspace");
  await ensureDir(attemptDir);
  const baseArm = attempt.base_arm || attempt.arm;
  const env = childEnv(baseArm, options.env, attempt.context_ablation ?? null);
  const task = { ...plan.task, base_sha: plan.base_sha };
  const startedAt = Date.now();

  const record = {
    schema: EVAL_ATTEMPT_SCHEMA_VERSION,
    run_id: plan.run_id,
    attempt_id: attempt.attempt_id,
    arm: attempt.arm,
    base_arm: baseArm,
    context_ablation: attempt.context_ablation ?? null,
    repeat_index: attempt.repeat_index,
    task_id: plan.task.id,
    base_sha: plan.base_sha,
    // Stamped per attempt so a resumed run cannot hide mixed harness
    // versions behind the original run.json.
    agentify_version: VERSION,
    claude_version: plan.claude_version ?? null,
    model: plan.task.model,
    effort: plan.task.effort,
    requested_profile: plan.task.profile,
    resolved_profile: plan.task.profile,
    limits: {
      max_budget_usd: plan.task.max_budget_usd,
      max_turns: plan.task.max_turns,
      timeout_seconds: plan.task.timeout_seconds,
    },
  };

  try {
    await fs.rm(workspace, { recursive: true, force: true });
    await prepareWorkspace(root, workspace, plan.base_sha);
    await prepareArm(root, workspace, baseArm, plan.task);

    for (const command of plan.task.setup) {
      const result = await runProcess(command, [], { cwd: workspace, env, timeoutMs: SETUP_TIMEOUT_MS, shell: true });
      if (result.code !== 0 || result.timedOut) {
        throw new Error(`setup command failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ${command}\n${tail(result.stderr)}`);
      }
    }
    await sealArmSetup(workspace, plan.task.forbidden_paths);

    const providerStart = Date.now();
    const providerResult = await runProcess(attempt.argv[0], attempt.argv.slice(1), {
      cwd: workspace,
      env,
      timeoutMs: plan.task.timeout_seconds * 1000,
    });
    const providerMs = Date.now() - providerStart;
    const parsed = parseClaudeJsonOutput(providerResult.stdout);

    const grade = await gradeAttempt(workspace, task, env);
    if (isAgentifyArm(baseArm)) {
      // Read before the finally-block deletes the workspace; metrics failures
      // must never fail a graded attempt.
      record.context_metrics = await collectContextMetrics(workspace).catch(() => null);
    }
    await writeText(path.join(attemptDir, "patch.diff"), redactSensitiveText(grade.patch));
    await writeText(path.join(attemptDir, "provider-stdout.json"), tail(providerResult.stdout));
    if (providerResult.stderr.trim()) {
      await writeText(path.join(attemptDir, "provider-stderr.log"), tail(providerResult.stderr));
    }
    delete grade.patch;

    Object.assign(record, {
      status: providerResult.timedOut ? "timeout" : providerResult.code === 0 ? "ok" : "provider_error",
      provider: {
        exit_code: providerResult.code,
        timed_out: providerResult.timedOut,
        duration_ms: providerMs,
        subtype: parsed?.subtype ?? null,
        num_turns: parsed?.num_turns ?? null,
        resolved_model: parsed?.resolved_model ?? null,
        cost_usd: parsed?.cost_usd ?? null,
        usage: parsed?.usage ?? null,
      },
      grade,
      pass: grade.pass,
      duration_ms: Date.now() - startedAt,
      artifacts: {
        patch: path.join("attempts", attempt.attempt_id, "patch.diff"),
        provider_stdout: path.join("attempts", attempt.attempt_id, "provider-stdout.json"),
      },
    });
  } catch (error) {
    Object.assign(record, {
      status: "error",
      error: redactSensitiveText(String(error.message || error)).slice(0, 2000),
      pass: false,
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    if (options.keepWorkspaces !== true) {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Spend is recorded before the attempt is marked complete, and the write is
  // fail-closed: if the rolling-budget ledger cannot be written, the attempt
  // is not marked done (resume re-runs it, bounded by its per-run cap) and
  // the run aborts rather than continuing with untracked spend.
  await recordDelegation(root, {
    schema: "delegation-v2",
    run_id: `${plan.run_id}/${attempt.attempt_id}`,
    kind: "eval",
    provider: "claude",
    model: plan.task.model,
    requested_provider: "claude",
    requested_model: plan.task.model,
    used_fallback: false,
    fallback_reason: null,
    write: true,
    budget_limit: plan.task.max_budget_usd,
    max_turns: plan.task.max_turns,
    budget_source: "eval-task",
    requested_profile: plan.task.profile,
    resolved_profile: plan.task.profile,
    resolved_model: record.provider?.resolved_model ?? null,
    status: record.status,
    exit_code: record.provider?.exit_code ?? 1,
    duration_ms: record.duration_ms,
    usage: record.provider?.usage ?? null,
    input_tokens: record.provider?.usage
      ? (record.provider.usage.fresh_input_tokens || 0) + (record.provider.usage.cache_write_tokens || 0) + (record.provider.usage.cache_read_tokens || 0)
      : 0,
    output_tokens: record.provider?.usage?.output_tokens ?? 0,
    tokens_estimated: !record.provider?.usage,
    cost_usd: record.provider?.cost_usd ?? null,
    cost_source: record.provider?.cost_usd != null ? "provider" : "unreported",
    budget_stop_reason: /budget/i.test(String(record.provider?.subtype || "")) ? "max_budget_usd"
      : /max_turns/i.test(String(record.provider?.subtype || "")) ? "max_turns"
        : null,
  });
  await writeJson(path.join(attemptDir, "result.json"), record);
  return record;
}

function summarizeAttempts(attempts) {
  const byArm = {};
  for (const attempt of attempts) {
    const bucket = byArm[attempt.arm] || (byArm[attempt.arm] = {
      attempts: 0, passes: 0, cost_usd: 0, costed_attempts: 0, duration_ms: 0,
    });
    bucket.attempts += 1;
    if (attempt.pass) bucket.passes += 1;
    bucket.duration_ms += attempt.duration_ms || 0;
    const cost = attempt.provider?.cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      bucket.cost_usd += cost;
      bucket.costed_attempts += 1;
    }
  }
  for (const bucket of Object.values(byArm)) {
    bucket.pass_rate = bucket.attempts > 0 ? bucket.passes / bucket.attempts : null;
    bucket.cost_usd = Number(bucket.cost_usd.toFixed(6));
    // Cost per passing attempt — the roadmap's actual routing metric (#294).
    // Only reported when every attempt has a provider-reported cost; a
    // partial subtotal divided by all passes would read falsely cheap.
    bucket.cost_per_pass_usd = bucket.passes > 0 && bucket.costed_attempts === bucket.attempts
      ? Number((bucket.cost_usd / bucket.passes).toFixed(6))
      : null;
  }
  return byArm;
}

async function pruneEvalRuns(runsRoot, keepRuns) {
  if (!(await exists(runsRoot))) {
    return;
  }
  const entries = (await fs.readdir(runsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of entries.slice(0, Math.max(0, entries.length - keepRuns))) {
    await fs.rm(path.join(runsRoot, name), { recursive: true, force: true }).catch(() => {});
  }
}

export async function runEval(root, config, taskRef, options = {}) {
  const { runsRoot } = resolveEvalPaths(root, config);

  let plan;
  let pendingAttempts;
  let completed = [];
  let runDir;

  if (options.resume) {
    // Resume re-executes only attempts without a stored result; completed
    // attempt metadata is retained untouched. Stored metadata is treated as
    // data, not trusted instructions: the run id must be a single sane path
    // component, the task is re-validated, and provider commands are rebuilt
    // from the validated task — never replayed from disk.
    const runId = String(options.resume).trim();
    if (!/^\d{8}-\d{6}-[a-f0-9]{6}$/.test(runId)) {
      throw new Error(`Invalid eval run id "${runId}"`);
    }
    runDir = path.join(runsRoot, runId);
    const runMetaPath = path.join(runDir, "run.json");
    if (!(await exists(runMetaPath))) {
      throw new Error(`No eval run found to resume at ${path.relative(root, runMetaPath)}`);
    }
    const stored = await readJson(runMetaPath);
    if (stored?.schema !== EVAL_RUN_SCHEMA_VERSION || stored?.run_id !== runId) {
      throw new Error(`Stored eval run ${runId} has unrecognized metadata (schema/run_id mismatch)`);
    }
    const task = validateEvalTask(stored.plan?.task, "run.json");
    const baseSha = String(stored.plan?.base_sha || "");
    if (!/^[0-9a-f]{40}$/.test(baseSha)) {
      throw new Error(`Stored eval run ${runId} has an invalid base_sha`);
    }
    // Every acceptable arm label (base arms plus the task's own context
    // ablation variants) is rebuilt from the validated task — a stored label
    // outside this set is corrupt, and env/argv are always rederived.
    const variantByArm = new Map(expandArmVariants(task, task.arms).map((variant) => [variant.arm, variant]));
    const seenAttemptIds = new Set();
    const order = (Array.isArray(stored.plan?.order) ? stored.plan.order : []).map((entry) => {
      const arm = String(entry?.arm || "");
      const variant = variantByArm.get(arm);
      const repeatIndex = Number(entry?.repeat_index);
      if (!variant || !Number.isInteger(repeatIndex) || repeatIndex < 1
        || entry?.attempt_id !== `${arm}-${repeatIndex}` || seenAttemptIds.has(entry.attempt_id)) {
        throw new Error(`Stored eval run ${runId} has a corrupt or duplicate attempt entry`);
      }
      seenAttemptIds.add(entry.attempt_id);
      return {
        attempt_id: entry.attempt_id,
        arm,
        base_arm: variant.base_arm,
        context_ablation: variant.context_ablation,
        repeat_index: repeatIndex,
        argv: buildEvalArmCommand(variant.base_arm, task),
      };
    });
    if (order.length === 0) {
      throw new Error(`Stored eval run ${runId} has no attempts to resume`);
    }
    plan = {
      task,
      task_path: stored.plan?.task_path ?? null,
      base_sha: baseSha,
      // The arms actually selected for this run (a CLI --arms subset may
      // differ from the manifest's arms), derived from the attempt order.
      arms: [...new Set(order.map((entry) => entry.arm))],
      repeat: Number(stored.plan?.repeat) || 1,
      max_spend_usd: Number((order.length * task.max_budget_usd).toFixed(6)),
      order,
      run_id: runId,
      stored_claude_version: stored.claude_version ?? null,
      stored_agentify_version: stored.agentify_version ?? null,
    };
    pendingAttempts = [];
    for (const attempt of order) {
      const resultPath = path.join(runDir, "attempts", attempt.attempt_id, "result.json");
      if (await exists(resultPath)) {
        completed.push(await readJson(resultPath));
      } else {
        pendingAttempts.push(attempt);
      }
    }
  } else {
    const basePlan = await planEvalRun(root, config, taskRef, options);
    const runId = newRunId();
    // Arm order is randomized per run so ordering effects (cache warmth,
    // machine load) cannot systematically favor one arm.
    const order = shuffled(basePlan.attempts, options.random);
    plan = { ...basePlan, run_id: runId, order };
    pendingAttempts = order;
    runDir = path.join(runsRoot, runId);
  }

  const maxPendingSpend = Number((pendingAttempts.length * plan.task.max_budget_usd).toFixed(6));

  if (options.dryRun) {
    return {
      command: "eval",
      action: "run",
      dry_run: true,
      run_id: plan.run_id,
      task_id: plan.task.id,
      task_path: plan.task_path,
      base_sha: plan.base_sha,
      model: plan.task.model,
      effort: plan.task.effort,
      profile: plan.task.profile,
      arms: plan.arms,
      repeat: plan.repeat,
      limits: {
        max_budget_usd: plan.task.max_budget_usd,
        max_turns: plan.task.max_turns,
        timeout_seconds: plan.task.timeout_seconds,
      },
      setup: plan.task.setup,
      grader: plan.task.grader,
      forbidden_paths: plan.task.forbidden_paths,
      attempts: pendingAttempts.map((attempt) => ({ ...attempt })),
      max_spend_usd: maxPendingSpend,
    };
  }

  const availability = await detectDelegateProviders(options.runtime || {});
  if (!availability.claude) {
    throw new Error("eval run requires the claude CLI on PATH: paired arms are Claude-specific and never fall back to another vendor.");
  }

  // The whole run's worst-case spend must fit inside the rolling caps before
  // the first provider process starts.
  const policy = resolveBudgetPolicy(config);
  const rolling = await checkRollingBudget(root, policy);
  let budgetWarning = null;
  if (rolling.remaining_usd !== null && maxPendingSpend > rolling.remaining_usd) {
    const message = `eval max spend $${maxPendingSpend} exceeds the remaining models.budget headroom of $${rolling.remaining_usd.toFixed(4)}`;
    if (policy.onLimit === "block") {
      throw new Error(`eval blocked before any provider call: ${message} (set models.budget.onLimit: warn to override)`);
    }
    budgetWarning = message;
  }

  await ensureDir(path.join(runDir, "attempts"));
  if (!options.resume) {
    // Retention never removes the run being resumed.
    await pruneEvalRuns(runsRoot, evalRetention(config));
  }
  const env = childEnv("agentify", options.env);
  const claudeVersion = await probeClaudeVersion(env);
  plan.claude_version = claudeVersion;
  let versionWarning = null;
  if (options.resume) {
    // Never rewrite run.json on resume: completed attempts keep their
    // original provenance. Mixed harness versions are surfaced, not hidden.
    const drift = [];
    if (plan.stored_claude_version && claudeVersion && plan.stored_claude_version !== claudeVersion) {
      drift.push(`claude ${plan.stored_claude_version} -> ${claudeVersion}`);
    }
    if (plan.stored_agentify_version && plan.stored_agentify_version !== VERSION) {
      drift.push(`agentify ${plan.stored_agentify_version} -> ${VERSION}`);
    }
    if (drift.length > 0) {
      versionWarning = `resumed attempts mix harness versions (${drift.join(", ")}); treat paired comparisons from this run with caution`;
    }
  } else {
    await writeJson(path.join(runDir, "run.json"), {
      schema: EVAL_RUN_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run_id: plan.run_id,
      agentify_version: VERSION,
      claude_version: claudeVersion,
      plan: {
        task: plan.task,
        task_path: plan.task_path,
        base_sha: plan.base_sha,
        arms: plan.arms,
        repeat: plan.repeat,
        max_spend_usd: plan.max_spend_usd,
        order: plan.order,
      },
    });
  }

  const results = [...completed];
  for (const attempt of pendingAttempts) {
    results.push(await runAttempt(root, runDir, plan, attempt, options));
  }

  return {
    command: "eval",
    action: "run",
    dry_run: false,
    run_id: plan.run_id,
    task_id: plan.task.id,
    base_sha: plan.base_sha,
    model: plan.task.model,
    profile: plan.task.profile,
    arms: plan.arms,
    repeat: plan.repeat,
    claude_version: claudeVersion,
    agentify_version: VERSION,
    resumed: Boolean(options.resume),
    executed_attempts: pendingAttempts.length,
    ...(budgetWarning ? { budget_warning: budgetWarning } : {}),
    ...(versionWarning ? { version_warning: versionWarning } : {}),
    max_spend_usd: plan.max_spend_usd,
    attempts: results.map((record) => ({
      attempt_id: record.attempt_id,
      arm: record.arm,
      status: record.status,
      pass: record.pass,
      cost_usd: record.provider?.cost_usd ?? null,
      num_turns: record.provider?.num_turns ?? null,
      duration_ms: record.duration_ms,
      ...(record.error ? { error: record.error } : {}),
    })),
    summary: { by_arm: summarizeAttempts(results) },
    artifacts_root: path.relative(root, runDir),
  };
}

export async function listEvals(root, config = {}) {
  const { tasksDir, runsRoot } = resolveEvalPaths(root, config);
  const tasks = [];
  if (await exists(tasksDir)) {
    for (const entry of (await fs.readdir(tasksDir)).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
      const taskPath = path.join(tasksDir, entry);
      try {
        const task = validateEvalTask(parseYaml(await readText(taskPath)), entry);
        tasks.push({
          id: task.id,
          path: path.relative(root, taskPath),
          model: task.model,
          arms: task.arms,
          repeat: task.repeat,
          max_budget_usd: task.max_budget_usd,
          description: task.description,
        });
      } catch (error) {
        tasks.push({ id: entry, path: path.relative(root, taskPath), invalid: true, error: String(error.message) });
      }
    }
  }

  const runs = [];
  if (await exists(runsRoot)) {
    for (const name of (await fs.readdir(runsRoot)).sort().reverse()) {
      const runMetaPath = path.join(runsRoot, name, "run.json");
      if (!(await exists(runMetaPath))) continue;
      try {
        const meta = await readJson(runMetaPath);
        const attempts = [];
        for (const attempt of meta.plan?.order || []) {
          const resultPath = path.join(runsRoot, name, "attempts", attempt.attempt_id, "result.json");
          if (await exists(resultPath)) {
            attempts.push(await readJson(resultPath));
          }
        }
        runs.push({
          run_id: meta.run_id,
          ts: meta.ts,
          task_id: meta.plan?.task?.id,
          base_sha: meta.plan?.base_sha,
          model: meta.plan?.task?.model,
          claude_version: meta.claude_version ?? null,
          attempts_completed: attempts.length,
          attempts_planned: (meta.plan?.order || []).length,
          summary: { by_arm: summarizeAttempts(attempts) },
        });
      } catch {
        // Unreadable run metadata is skipped, not fatal.
      }
    }
  }

  return { command: "eval", action: "list", tasks, runs };
}
