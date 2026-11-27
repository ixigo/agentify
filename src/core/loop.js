// `agentify loop` — the autonomous build loop.
//
// One brief in, one graded branch out: ingest the task (a Jira key, a Figma
// node, a defect, a sentence), isolate it in a fresh worktree, let an agent
// implement, run the acceptance gates, feed the failures back, and iterate
// until the gates hold or a ceiling trips. Optionally commit and open a draft
// PR, and always write a report.
//
// The division of labour is the whole design: Node owns the state machine,
// the ceilings, and the verdicts; the agent owns only the editing inside one
// iteration. That is what makes an unattended run safe to start —
//
// - the agent never decides it is finished (gates do, in loop-gates.js),
// - the agent never decides how long to keep going (max_iterations, the run
//   budget, the wall clock, and stall detection do),
// - the agent cannot touch CI config or agent guidance (forbidden paths are
//   reverted between iterations, and the violation is fed back as a failure),
// - the agent cannot push anywhere (the worktree's remote is left alone but
//   nothing in this module pushes; opening a PR is a separate opt-in step).
//
// Every attempt is recorded under .agentify/loop/runs/<run-id>/ so a killed
// run resumes, and a finished run can be read long after the terminal scrolled
// away.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";

import { checkRollingBudget, resolveBudgetPolicy } from "./budget.js";
import { VERSION } from "./cli-fast-paths.js";
import { ensureDir, exists, readJson, writeJson, writeText } from "./fs.js";
import {
  ingestLoopBrief,
  inferGates,
  loadLoopBrief,
  resolveLoopPaths,
  validateLoopBrief,
} from "./loop-brief.js";
import {
  createGateContext,
  describeFailures,
  gatesNeedIndex,
  gatesNeedServer,
  runGates,
} from "./loop-gates.js";
import { matchesForbiddenPath } from "./globs.js";
import { resolveModelRoutes, runDelegate } from "./models.js";
import { runProcess, startBackgroundProcess, waitForUrl } from "./proc.js";
import { redactSensitiveText } from "./redact.js";
import { describeWorkflows } from "./workflows.js";

const execFileAsync = promisify(execFile);

export const LOOP_RUN_SCHEMA_VERSION = "loop-run-v1";
export const LOOP_CANDIDATE_SCHEMA_VERSION = "loop-candidate-v1";

const DEFAULT_KEEP_RUNS = 20;
const SETUP_TIMEOUT_MS = 600000;
const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{6}$/;

// Two consecutive iterations that fail to beat the best score so far end the
// run. One flat iteration is normal (a fix that trades one failing gate for
// another); two in a row is a loop that has stopped converging, and paying for
// a third rarely changes that. The first iteration is exempt: it sets the
// baseline, so the earliest a run can stall is the third iteration.
const STALL_AFTER_FLAT_ITERATIONS = 2;

function loopRetention(config = {}) {
  const keep = Number(config.loop?.keepRuns);
  return Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DEFAULT_KEEP_RUNS;
}

function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
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

async function resolveCommit(root, ref) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root });
    return stdout.trim();
  } catch {
    throw new Error(`Cannot resolve "${ref}" to a commit in ${root}. base_ref must name an existing commit.`);
  }
}

function candidateId(index) {
  return `c${index + 1}`;
}

function branchName(brief, index) {
  const suffix = index === 0 ? "" : `-${candidateId(index)}`;
  return `${brief.branch_prefix}${brief.id}${suffix}`;
}

/**
 * Worst-case spend for the whole run.
 *
 * Both paid paths are counted. Missing the review gates — which spend real
 * money on every iteration — would make the reported ceiling a number the run
 * can legitimately blow through, which is worse than no number at all.
 */
export function projectMaxSpend(brief, config) {
  const routes = resolveModelRoutes(config);
  const reviewGates = brief.gates.filter((gate) => gate.kind === "review").length;
  const reviewCap = Number(routes.review?.maxBudgetUsd) || 0;
  const perIteration = brief.limits.iteration_budget_usd + reviewGates * reviewCap;
  return {
    max_spend_usd: Number((brief.candidates * brief.limits.max_iterations * perIteration).toFixed(4)),
    per_iteration_usd: Number(perIteration.toFixed(4)),
    agent_budget_usd: brief.limits.iteration_budget_usd,
    review_gates: reviewGates,
    review_cap_usd: reviewCap,
  };
}

/**
 * Resolve a brief from either a committed manifest or CLI ingest flags, without
 * touching the filesystem beyond reading.
 */
export async function resolveBrief(root, config, briefRef, options = {}) {
  if (briefRef) {
    const loaded = await loadLoopBrief(root, briefRef, config);
    return { brief: loaded.brief, brief_path: path.relative(root, loaded.path), inferred_gate_notes: [] };
  }

  const inferred = await inferGates(root, {
    hasVisualReference: Boolean(options.figma) || (options.figmaImages || []).length > 0,
  });
  const draft = await ingestLoopBrief(root, { ...options, gates: options.gates || inferred.gates });
  return {
    brief: validateLoopBrief(draft, "cli"),
    brief_path: null,
    inferred_gate_notes: options.gates ? [] : inferred.notes,
  };
}

/** Apply CLI overrides to a brief. Ceilings may be lowered or raised explicitly. */
export function applyBriefOverrides(brief, options = {}) {
  const limits = { ...brief.limits };
  if (options.maxIterations !== undefined) {
    limits.max_iterations = Number(options.maxIterations);
  }
  if (options.maxBudgetUsd !== undefined) {
    limits.max_budget_usd = Number(options.maxBudgetUsd);
  }
  if (options.maxTurns !== undefined) {
    limits.max_turns = Number(options.maxTurns);
  }
  if (options.maxIterations !== undefined || options.maxBudgetUsd !== undefined) {
    // Keep the derived per-iteration cap consistent with whichever ceiling
    // moved, unless the operator pinned it explicitly.
    limits.iteration_budget_usd = options.iterationBudgetUsd !== undefined
      ? Number(options.iterationBudgetUsd)
      : Number((limits.max_budget_usd / limits.max_iterations).toFixed(4));
  }
  const next = {
    ...brief,
    limits,
    candidates: options.candidates !== undefined ? Number(options.candidates) : brief.candidates,
    route: options.route || brief.route,
    base_ref: options.baseRef || brief.base_ref,
    ship: {
      ...brief.ship,
      commit: options.commit === false ? false : brief.ship.commit,
      pr: options.pr || brief.ship.pr,
    },
  };
  // Re-validate so an override can never produce a brief the schema rejects.
  return validateLoopBrief(next, "cli overrides");
}

/** Build the full execution plan. Pure: no worktrees, no processes, no spend. */
export async function planLoopRun(root, config, briefRef, options = {}) {
  const resolved = await resolveBrief(root, config, briefRef, options);
  const brief = applyBriefOverrides(resolved.brief, options);
  const baseSha = await resolveCommit(root, brief.base_ref);
  const spend = projectMaxSpend(brief, config);

  const candidates = Array.from({ length: brief.candidates }, (_, index) => ({
    candidate_id: candidateId(index),
    branch: branchName(brief, index),
    // Candidate 1 gets the brief as written; the rest get an explicit nudge to
    // diverge, because N identical prompts produce N near-identical attempts
    // and a tournament between clones measures nothing.
    variation: index === 0 ? null : CANDIDATE_VARIATIONS[(index - 1) % CANDIDATE_VARIATIONS.length],
  }));

  return {
    brief,
    brief_path: resolved.brief_path,
    inferred_gate_notes: resolved.inferred_gate_notes,
    base_sha: baseSha,
    candidates,
    gates: brief.gates.map((gate) => ({ id: gate.id, kind: gate.kind, blocking: gate.blocking, run: gate.run })),
    needs_server: gatesNeedServer(brief.gates),
    needs_index: gatesNeedIndex(brief.gates),
    ...spend,
  };
}

// Distinct angles for tournament candidates. Each is a real engineering stance,
// not a reword: the point is to surface genuinely different solutions to
// compare, which is only worth doing when they differ.
const CANDIDATE_VARIATIONS = [
  "Favor the smallest possible diff. Reuse what already exists even when a new abstraction would look tidier.",
  "Favor clarity over brevity. Introduce the intermediate names and helpers that make the change obvious to a reader who has never seen this code.",
  "Favor the existing architecture. Find the closest analogous feature in this repo and mirror its structure, naming, and testing approach exactly.",
];

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

async function createWorktree(root, worktreePath, branch, baseSha) {
  await ensureDir(path.dirname(worktreePath));
  await fs.rm(worktreePath, { recursive: true, force: true });
  // Remove a branch left behind by an interrupted run so the loop is
  // re-runnable; -D is safe here because the name is loop-owned and derived
  // from the brief id.
  await git(root, ["worktree", "remove", "--force", worktreePath], { allowFailure: true });
  await git(root, ["branch", "-D", branch], { allowFailure: true });
  await git(root, ["worktree", "add", "--quiet", "-b", branch, worktreePath, baseSha]);
}

async function removeWorktree(root, worktreePath) {
  await git(root, ["worktree", "remove", "--force", worktreePath], { allowFailure: true });
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
}

async function changedPaths(worktree, baseSha) {
  const output = await git(worktree, ["diff", "--name-only", "-z", baseSha, "--", ".", ":(exclude).agentify"], { allowFailure: true });
  const tracked = (output || "").split("\0").filter(Boolean);
  const untracked = (await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { allowFailure: true }) || "")
    .split("\0")
    .filter(Boolean)
    .filter((entry) => !entry.startsWith(".agentify/"));
  return [...new Set([...tracked, ...untracked])];
}

/**
 * Undo edits to forbidden paths.
 *
 * Reverting rather than merely reporting is the point: the next iteration must
 * start from a tree where the refusal actually held, otherwise a single
 * iteration that rewrote a CI workflow leaves that change in the branch (and
 * in the eventual PR) no matter what the report says.
 */
async function revertForbidden(worktree, baseSha, patterns) {
  const paths = await changedPaths(worktree, baseSha);
  const violations = paths.filter((entry) => matchesForbiddenPath(entry, patterns).length > 0);
  for (const violation of violations) {
    const restored = await git(worktree, ["checkout", baseSha, "--", violation], { allowFailure: true });
    if (restored === null) {
      // The path did not exist at base: the agent created it, so removing it
      // is the revert.
      await fs.rm(path.join(worktree, violation), { force: true }).catch(() => {});
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Iteration
// ---------------------------------------------------------------------------

export function buildIterationPrompt(brief, { iteration, variation, previousVerdicts, violations, worktree }) {
  const sections = [];
  sections.push(`You are iteration ${iteration} of an autonomous implementation loop running in ${worktree}.`);
  sections.push(`## Task\n\n${brief.intent}`);

  if (brief.acceptance.length > 0) {
    sections.push(`## Acceptance criteria\n\n${brief.acceptance.map((entry) => `- ${entry}`).join("\n")}`);
  }

  if (brief.source.figma_images.length > 0 || brief.source.figma_url) {
    const lines = ["## Design reference"];
    if (brief.source.figma_url) {
      lines.push(`- Figma node: ${brief.source.figma_url}`);
    }
    for (const image of brief.source.figma_images) {
      lines.push(`- Reference screenshot: ${image}`);
    }
    lines.push("", "Read the screenshots before editing. Where a screenshot and Figma metadata disagree, the screenshot is the truth about rendered appearance.");
    sections.push(lines.join("\n"));
  }

  const failures = previousVerdicts ? describeFailures(previousVerdicts) : "";
  if (failures) {
    sections.push([
      "## What failed last iteration",
      "",
      failures,
      "",
      "Fix these first. Do not start unrelated work while a gate is red.",
    ].join("\n"));
  }

  if (violations && violations.length > 0) {
    sections.push([
      "## Reverted changes",
      "",
      `You edited paths this loop refuses to change, and those edits have been reverted: ${violations.join(", ")}.`,
      "Achieve the task without touching them.",
    ].join("\n"));
  }

  if (variation) {
    sections.push(`## Approach for this candidate\n\n${variation}`);
  }

  sections.push([
    "## Rules",
    "",
    `- Follow this repository's existing conventions. Read neighbouring code before adding anything.`,
    `- Do not edit: ${brief.forbidden_paths.join(", ")}.`,
    "- Do not commit, push, or open a pull request. The harness handles that.",
    "- Do not add dependencies unless the task cannot be done without one.",
    "- Leave the working tree in a state where the acceptance gates can run.",
  ].join("\n"));

  const gateList = brief.gates
    .map((gate) => `- ${gate.id} (${gate.kind}${gate.blocking ? "" : ", advisory"})${gate.run ? `: ${gate.run}` : ""}`)
    .join("\n");
  sections.push(`## Gates that will judge this iteration\n\n${gateList}`);

  return sections.join("\n\n");
}

async function startServer(brief, worktree, env) {
  if (!brief.serve) {
    return { started: false, ready: true, handle: null };
  }
  const handle = startBackgroundProcess(brief.serve.command, { cwd: worktree, env });
  const readiness = await waitForUrl(brief.serve.url, { timeoutMs: brief.serve.ready_timeout_seconds * 1000 });
  if (!readiness.ready) {
    await handle.stop();
    return { started: true, ready: false, handle: null, error: readiness.error, output: handle.output };
  }
  return { started: true, ready: true, handle };
}

/**
 * Run one iteration: let the agent edit, enforce the refusals, then grade.
 */
async function runIteration(context, state, iteration) {
  const { brief, worktree, baseSha, iterationDir } = context;
  const startedAt = Date.now();
  await ensureDir(iterationDir);

  const prompt = buildIterationPrompt(brief, {
    iteration,
    variation: context.variation,
    previousVerdicts: state.lastVerdicts,
    violations: state.lastViolations,
    worktree,
  });
  await writeText(path.join(iterationDir, "prompt.md"), prompt);

  const agent = await context.delegate(brief.route, prompt, {
    write: true,
    maxBudgetUsd: brief.limits.iteration_budget_usd,
    maxTurns: brief.limits.max_turns,
    timeoutMs: brief.limits.timeout_seconds * 1000,
  });

  const agentRecord = {
    status: agent.status,
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    exit_code: agent.exit_code ?? null,
    cost_usd: agent.cost_usd ?? null,
    duration_ms: agent.duration_ms ?? null,
    budget_stop_reason: agent.budget_stop_reason ?? null,
    output_tail: redactSensitiveText(String(agent.output || "")).slice(-2000),
    ...(agent.error ? { error: redactSensitiveText(String(agent.error)).slice(0, 1000) } : {}),
  };
  await writeJson(path.join(iterationDir, "agent.json"), agentRecord);

  if (agent.status === "budget_blocked") {
    return {
      iteration,
      status: "budget_blocked",
      agent: agentRecord,
      verdicts: [],
      score: 0,
      gates_passed: 0,
      gates_total: brief.gates.filter((gate) => gate.blocking).length,
      passed: false,
      violations: [],
      changed_files: 0,
      duration_ms: Date.now() - startedAt,
    };
  }

  const violations = await context.revertForbidden(worktree, baseSha, brief.forbidden_paths);
  const changed = await context.changedPaths(worktree, baseSha);

  // Grading an untouched tree wastes the whole gate ladder — and if the gates
  // happen to pass on the base commit, it would ship a branch containing none
  // of the requested work.
  if (changed.length === 0) {
    return {
      iteration,
      status: "no_changes",
      agent: agentRecord,
      verdicts: [],
      score: 0,
      gates_passed: 0,
      gates_total: brief.gates.filter((gate) => gate.blocking).length,
      passed: false,
      violations,
      changed_files: 0,
      duration_ms: Date.now() - startedAt,
    };
  }

  const server = await context.startServer(brief, worktree, context.env);
  let graded;
  try {
    if (server.started && !server.ready) {
      const blocking = brief.gates.filter((gate) => gate.blocking).length;
      graded = {
        verdicts: brief.gates.map((gate) => ({
          id: gate.id,
          kind: gate.kind,
          blocking: gate.blocking,
          status: "error",
          detail: `dev server never became ready at ${brief.serve.url}: ${server.error}`,
          score: null,
          artifacts: {},
          duration_ms: 0,
        })),
        passed: false,
        score: 0,
        gates_passed: 0,
        gates_total: blocking,
      };
      await writeText(path.join(iterationDir, "serve.log"), redactSensitiveText(server.output || ""));
    } else {
      graded = await context.runGates(
        context.gateContext({ artifactsDir: iterationDir }),
        brief.gates,
      );
    }
  } finally {
    if (server.handle) {
      await server.handle.stop();
    }
  }

  return {
    iteration,
    status: "graded",
    agent: agentRecord,
    verdicts: graded.verdicts,
    score: graded.score,
    gates_passed: graded.gates_passed,
    gates_total: graded.gates_total,
    passed: graded.passed,
    violations,
    changed_files: changed.length,
    duration_ms: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

async function runSetup(brief, worktree, env) {
  for (const command of brief.setup) {
    const result = await runProcess(command, [], { cwd: worktree, env, timeoutMs: SETUP_TIMEOUT_MS, shell: true });
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`setup command failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ${command}`);
    }
  }
}

async function runCandidate(root, config, plan, candidate, runDir, options) {
  const brief = plan.brief;
  const candidateDir = path.join(runDir, "candidates", candidate.candidate_id);
  const { worktreesRoot } = resolveLoopPaths(root, config);
  const worktree = path.join(worktreesRoot, plan.run_id, candidate.candidate_id);
  await ensureDir(candidateDir);

  const state = {
    schema: LOOP_CANDIDATE_SCHEMA_VERSION,
    run_id: plan.run_id,
    candidate_id: candidate.candidate_id,
    branch: candidate.branch,
    worktree,
    base_sha: plan.base_sha,
    variation: candidate.variation,
    iterations: [],
    outcome: "running",
    best_score: 0,
    spend_usd: 0,
    cost_unreported: false,
    started_at: new Date().toISOString(),
  };
  const save = () => writeJson(path.join(candidateDir, "state.json"), state);
  await save();

  const env = { ...process.env, ...(options.env || {}) };
  // A factory rather than a function so an injected delegate knows which
  // worktree and candidate it is acting for — the real one closes over the
  // worktree too, since that is the cwd the provider must run in.
  const delegate = options.createDelegate
    ? options.createDelegate(worktree, candidate)
    : ((kind, prompt, delegateOptions) => runDelegate(worktree, config, kind, prompt, delegateOptions));

  const context = {
    brief,
    worktree,
    baseSha: plan.base_sha,
    variation: candidate.variation,
    env,
    delegate,
    iterationDir: null,
    revertForbidden: options.revertForbidden || revertForbidden,
    changedPaths: options.changedPaths || changedPaths,
    startServer: options.startServer || startServer,
    runGates: options.runGates || runGates,
    gateContext: ({ artifactsDir }) => createGateContext({
      root,
      worktree,
      config,
      baseSha: plan.base_sha,
      artifactsDir,
      env,
      intent: brief.intent,
      delegate: (kind, prompt, delegateOptions) => delegate(kind, prompt, delegateOptions),
      overrides: options.gateOverrides || {},
    }),
    lastVerdicts: null,
    lastViolations: [],
  };

  try {
    await (options.createWorktree || createWorktree)(root, worktree, candidate.branch, plan.base_sha);
    await runSetup(brief, worktree, env);
    if (plan.needs_index) {
      // query/risk/test-select all read the structural index, and it must
      // describe the worktree, not the checkout the loop was launched from.
      await (options.buildIndex || buildWorktreeIndex)(worktree, env);
    }

    let flatIterations = 0;
    for (let iteration = 1; iteration <= brief.limits.max_iterations; iteration += 1) {
      if (state.spend_usd >= brief.limits.max_budget_usd) {
        state.outcome = "budget_exhausted";
        break;
      }
      context.iterationDir = path.join(candidateDir, "iterations", String(iteration));
      const result = await runIteration(context, context, iteration);

      state.iterations.push(result);
      if (typeof result.agent.cost_usd === "number") {
        state.spend_usd = Number((state.spend_usd + result.agent.cost_usd).toFixed(6));
      } else {
        // Without a provider-reported cost the dollar ceiling cannot be
        // enforced from spend alone; the per-call caps and the iteration count
        // still bound the run, and the report says so rather than implying a
        // ceiling that was never checked.
        state.cost_unreported = true;
      }
      for (const verdict of result.verdicts) {
        if (typeof verdict.cost_usd === "number") {
          state.spend_usd = Number((state.spend_usd + verdict.cost_usd).toFixed(6));
        }
      }

      context.lastVerdicts = result.verdicts.length > 0 ? result.verdicts : context.lastVerdicts;
      context.lastViolations = result.violations;
      await save();

      if (result.passed) {
        state.outcome = "passed";
        state.best_score = 1;
        break;
      }
      if (result.status === "budget_blocked") {
        state.outcome = "budget_blocked";
        break;
      }

      if (result.score > state.best_score + 1e-9) {
        state.best_score = result.score;
        flatIterations = 0;
      } else if (iteration > 1) {
        // The first iteration establishes the baseline and can never "fail to
        // improve" on it — counting it as flat would end a hard task after two
        // attempts no matter how many iterations it was given.
        flatIterations += 1;
        if (flatIterations >= STALL_AFTER_FLAT_ITERATIONS) {
          state.outcome = "stalled";
          break;
        }
      }
    }

    if (state.outcome === "running") {
      state.outcome = "exhausted";
    }

    // Keep the diff even when the candidate lost: reviewing what a failed run
    // actually produced is most of the value of having run it.
    const patch = await git(worktree, ["diff", plan.base_sha, "--", ".", ":(exclude).agentify"], { allowFailure: true });
    if (patch) {
      await writeText(path.join(candidateDir, "patch.diff"), redactSensitiveText(patch));
      state.artifacts = { patch: path.join("candidates", candidate.candidate_id, "patch.diff") };
    }
    state.changed_files = (await changedPaths(worktree, plan.base_sha)).length;
  } catch (error) {
    state.outcome = "error";
    state.error = redactSensitiveText(String(error?.message || error)).slice(0, 2000);
  }

  state.finished_at = new Date().toISOString();
  await save();
  return state;
}

async function buildWorktreeIndex(worktree, env) {
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const result = await runProcess(process.execPath, [cli, "scan"], { cwd: worktree, env, timeoutMs: SETUP_TIMEOUT_MS });
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`agentify scan failed in the loop worktree (exit ${result.code}${result.timedOut ? ", timed out" : ""}); index-backed gates cannot run`);
  }
}

/**
 * Pick the candidate to ship.
 *
 * A passing candidate always beats a non-passing one no matter the scores:
 * "closest to done" is not the same as "done", and shipping the higher-scoring
 * failure would defeat the gates entirely.
 */
export function selectWinner(states) {
  const usable = states.filter((state) => state.outcome !== "error");
  if (usable.length === 0) {
    return null;
  }
  const ranked = [...usable].sort((left, right) => {
    const passedDelta = Number(right.outcome === "passed") - Number(left.outcome === "passed");
    if (passedDelta !== 0) return passedDelta;
    const scoreDelta = (right.best_score || 0) - (left.best_score || 0);
    if (scoreDelta !== 0) return scoreDelta;
    // Tie-break toward the cheaper, shorter path to the same result.
    const iterationDelta = left.iterations.length - right.iterations.length;
    if (iterationDelta !== 0) return iterationDelta;
    return (left.spend_usd || 0) - (right.spend_usd || 0);
  });
  return ranked[0];
}

// ---------------------------------------------------------------------------
// Ship
// ---------------------------------------------------------------------------

export function buildCommitMessage(brief) {
  const scope = brief.ship.scope ? `(${brief.ship.scope})` : "";
  const subject = `${brief.ship.type}${scope}: ${brief.title}`.slice(0, 100);
  const body = [
    brief.intent.split("\n").slice(0, 6).join("\n").trim(),
    "",
    ...(brief.ship.refs ? [`Refs: ${brief.ship.refs}`] : []),
  ].join("\n").trim();
  return { subject, body, message: body ? `${subject}\n\n${body}` : subject };
}

async function commitCandidate(worktree, brief) {
  const { subject, message } = buildCommitMessage(brief);
  await git(worktree, ["add", "-A", "--", ".", ":(exclude).agentify"]);
  const staged = await git(worktree, ["diff", "--cached", "--name-only"], { allowFailure: true });
  if (!staged || !staged.trim()) {
    return { committed: false, reason: "nothing to commit" };
  }
  // --no-verify: repo hooks may run the very checks the gates just ran, and a
  // pre-commit hook prompting or rewriting files would hang an unattended run.
  await git(worktree, ["commit", "--quiet", "--no-verify", "-m", message]);
  const sha = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  return { committed: true, sha, subject };
}

async function openDraftPr(root, worktree, brief, candidate, runtime = {}) {
  const described = await describeWorkflows(root, runtime);
  const workflow = described.workflows.find((entry) => entry.detected);
  if (!workflow) {
    return { opened: false, reason: `no GitHub/GitLab/Azure remote detected (origin: ${described.remote_url || "none"})` };
  }
  if (!workflow.cli_available) {
    return { opened: false, reason: `${workflow.cli} CLI is not installed` };
  }

  const { subject, body } = buildCommitMessage(brief);
  const push = await runProcess("git", ["push", "--set-upstream", "origin", candidate.branch], {
    cwd: worktree,
    timeoutMs: 300000,
  });
  if (push.code !== 0) {
    return { opened: false, reason: `git push failed: ${String(push.stderr).trim().slice(0, 300)}` };
  }

  const commands = {
    gh: ["pr", "create", "--draft", "--title", subject, "--body", body || subject, "--head", candidate.branch],
    glab: ["mr", "create", "--draft", "--title", subject, "--description", body || subject, "--source-branch", candidate.branch, "--yes"],
    azure: ["repos", "pr", "create", "--draft", "true", "--title", subject, "--description", body || subject, "--source-branch", candidate.branch],
  };
  const argv = commands[workflow.name];
  const result = await runProcess(workflow.cli, argv, { cwd: worktree, timeoutMs: 300000 });
  if (result.code !== 0) {
    return { opened: false, reason: `${workflow.cli} failed: ${String(result.stderr).trim().slice(0, 300)}` };
  }
  const url = (String(result.stdout).match(/https?:\/\/\S+/) || [null])[0];
  return { opened: true, platform: workflow.name, url, branch: candidate.branch };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function pruneLoopRuns(runsRoot, keepRuns) {
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

export async function runLoop(root, config, briefRef, options = {}) {
  const { runsRoot, worktreesRoot } = resolveLoopPaths(root, config);

  let plan;
  let runDir;
  let completed = [];

  if (options.resume) {
    const runId = String(options.resume).trim();
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`Invalid loop run id "${runId}"`);
    }
    runDir = path.join(runsRoot, runId);
    const metaPath = path.join(runDir, "run.json");
    if (!(await exists(metaPath))) {
      throw new Error(`No loop run found to resume at ${path.relative(root, metaPath)}`);
    }
    const stored = await readJson(metaPath);
    if (stored?.schema !== LOOP_RUN_SCHEMA_VERSION || stored?.run_id !== runId) {
      throw new Error(`Stored loop run ${runId} has unrecognized metadata (schema/run_id mismatch)`);
    }
    // Stored metadata is data, not trusted instructions: the brief is
    // re-validated and the candidate list is rebuilt from it, never replayed.
    const brief = validateLoopBrief(stored.plan?.brief, "run.json");
    const baseSha = String(stored.plan?.base_sha || "");
    if (!/^[0-9a-f]{40}$/.test(baseSha)) {
      throw new Error(`Stored loop run ${runId} has an invalid base_sha`);
    }
    plan = {
      ...stored.plan,
      brief,
      base_sha: baseSha,
      run_id: runId,
      candidates: Array.from({ length: brief.candidates }, (_, index) => ({
        candidate_id: candidateId(index),
        branch: branchName(brief, index),
        variation: index === 0 ? null : CANDIDATE_VARIATIONS[(index - 1) % CANDIDATE_VARIATIONS.length],
      })),
      needs_server: gatesNeedServer(brief.gates),
      needs_index: gatesNeedIndex(brief.gates),
    };
  } else {
    plan = await planLoopRun(root, config, briefRef, options);
    plan.run_id = newRunId();
    runDir = path.join(runsRoot, plan.run_id);
  }

  // The single dry-run path: every caller previews through runLoop, so an
  // options.dryRun can never fall through to a real run.
  if (options.dryRun) {
    return {
      command: "loop",
      action: "run",
      dry_run: true,
      run_id: plan.run_id ?? null,
      brief: plan.brief,
      brief_path: plan.brief_path,
      brief_id: plan.brief.id,
      base_sha: plan.base_sha,
      candidates: plan.candidates,
      gates: plan.gates,
      needs_server: plan.needs_server,
      needs_index: plan.needs_index,
      inferred_gate_notes: plan.inferred_gate_notes || [],
      max_spend_usd: plan.max_spend_usd,
      per_iteration_usd: plan.per_iteration_usd,
      review_gates: plan.review_gates,
    };
  }

  // The whole run's worst case must fit the rolling caps before the first
  // provider process starts.
  const policy = resolveBudgetPolicy(config);
  const rolling = await checkRollingBudget(root, policy);
  let budgetWarning = null;
  if (rolling.remaining_usd !== null && plan.max_spend_usd > rolling.remaining_usd) {
    const message = `loop max spend $${plan.max_spend_usd} exceeds the remaining models.budget headroom of $${rolling.remaining_usd.toFixed(4)}`;
    if (policy.onLimit === "block") {
      throw new Error(`loop blocked before any provider call: ${message} (set models.budget.onLimit: warn to override)`);
    }
    budgetWarning = message;
  }

  await ensureDir(path.join(runDir, "candidates"));
  if (!options.resume) {
    await pruneLoopRuns(runsRoot, loopRetention(config));
    await writeText(path.join(runDir, "brief.yaml"), stringifyYaml(plan.brief));
    await writeJson(path.join(runDir, "run.json"), {
      schema: LOOP_RUN_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run_id: plan.run_id,
      agentify_version: VERSION,
      plan: {
        brief: plan.brief,
        brief_path: plan.brief_path,
        base_sha: plan.base_sha,
        candidates: plan.candidates,
        gates: plan.gates,
        max_spend_usd: plan.max_spend_usd,
        per_iteration_usd: plan.per_iteration_usd,
      },
    });
  }

  const states = [];
  for (const candidate of plan.candidates) {
    const statePath = path.join(runDir, "candidates", candidate.candidate_id, "state.json");
    if (options.resume && await exists(statePath)) {
      const stored = await readJson(statePath);
      if (stored?.outcome && stored.outcome !== "running") {
        completed.push(candidate.candidate_id);
        states.push(stored);
        continue;
      }
    }
    states.push(await runCandidate(root, config, plan, candidate, runDir, options));
  }

  const winner = selectWinner(states);
  let ship = { committed: false, pr: { opened: false, reason: "not requested" } };
  if (winner && winner.outcome === "passed") {
    if (plan.brief.ship.commit) {
      ship = { ...ship, ...(await commitCandidate(winner.worktree, plan.brief)) };
    }
    if (plan.brief.ship.pr === "draft" && ship.committed) {
      const candidate = plan.candidates.find((entry) => entry.candidate_id === winner.candidate_id);
      ship.pr = await openDraftPr(root, winner.worktree, plan.brief, candidate, options.runtime || {});
    }
  }

  // Losing worktrees are removed unless asked for: a tournament otherwise
  // leaves N-1 full checkouts on disk after every run. Their diffs and gate
  // logs survive under the run directory either way, and the winner's worktree
  // always stays because it holds the branch.
  if (options.keepWorktrees !== true) {
    for (const state of states) {
      if (!winner || state.candidate_id !== winner.candidate_id) {
        await removeWorktree(root, state.worktree);
      }
    }
  }

  const summary = {
    command: "loop",
    action: "run",
    dry_run: false,
    run_id: plan.run_id,
    brief_id: plan.brief.id,
    title: plan.brief.title,
    base_sha: plan.base_sha,
    agentify_version: VERSION,
    resumed: Boolean(options.resume),
    reused_candidates: completed,
    max_spend_usd: plan.max_spend_usd,
    spend_usd: Number(states.reduce((total, state) => total + (state.spend_usd || 0), 0).toFixed(6)),
    cost_unreported: states.some((state) => state.cost_unreported),
    ...(budgetWarning ? { budget_warning: budgetWarning } : {}),
    outcome: winner ? winner.outcome : "error",
    winner: winner ? winner.candidate_id : null,
    candidates: states.map((state) => ({
      candidate_id: state.candidate_id,
      branch: state.branch,
      outcome: state.outcome,
      best_score: state.best_score,
      iterations: state.iterations.length,
      spend_usd: state.spend_usd,
      worktree: state.worktree,
      ...(state.error ? { error: state.error } : {}),
    })),
    ship,
    artifacts_root: path.relative(root, runDir),
    worktrees_root: path.relative(root, path.join(worktreesRoot, plan.run_id)),
  };
  await writeJson(path.join(runDir, "summary.json"), summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Read-only views
// ---------------------------------------------------------------------------

export async function loadLoopRun(root, config, runId) {
  const { runsRoot } = resolveLoopPaths(root, config);
  const resolved = String(runId || "").trim() || (await latestRunId(runsRoot));
  if (!resolved) {
    throw new Error("No loop runs found. Start one with `agentify loop run`.");
  }
  if (!RUN_ID_PATTERN.test(resolved)) {
    throw new Error(`Invalid loop run id "${resolved}"`);
  }
  const runDir = path.join(runsRoot, resolved);
  const metaPath = path.join(runDir, "run.json");
  if (!(await exists(metaPath))) {
    throw new Error(`No loop run found at ${path.relative(root, metaPath)}`);
  }
  const meta = await readJson(metaPath);
  const candidates = [];
  for (const candidate of meta.plan?.candidates || []) {
    const statePath = path.join(runDir, "candidates", candidate.candidate_id, "state.json");
    if (await exists(statePath)) {
      candidates.push(await readJson(statePath));
    }
  }
  const summaryPath = path.join(runDir, "summary.json");
  return {
    run_id: resolved,
    dir: runDir,
    meta,
    candidates,
    summary: (await exists(summaryPath)) ? await readJson(summaryPath) : null,
  };
}

async function latestRunId(runsRoot) {
  if (!(await exists(runsRoot))) {
    return null;
  }
  const entries = (await fs.readdir(runsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

export async function listLoops(root, config = {}) {
  const { briefsDir, runsRoot } = resolveLoopPaths(root, config);
  const briefs = [];
  if (await exists(briefsDir)) {
    for (const entry of (await fs.readdir(briefsDir)).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
      const briefPath = path.join(briefsDir, entry);
      try {
        const loaded = await loadLoopBrief(root, briefPath, config);
        briefs.push({
          id: loaded.brief.id,
          path: path.relative(root, briefPath),
          title: loaded.brief.title,
          gates: loaded.brief.gates.length,
          candidates: loaded.brief.candidates,
          max_budget_usd: loaded.brief.limits.max_budget_usd,
        });
      } catch (error) {
        briefs.push({ id: entry, path: path.relative(root, briefPath), invalid: true, error: String(error.message) });
      }
    }
  }

  const runs = [];
  if (await exists(runsRoot)) {
    for (const name of (await fs.readdir(runsRoot)).sort().reverse()) {
      const summaryPath = path.join(runsRoot, name, "summary.json");
      const metaPath = path.join(runsRoot, name, "run.json");
      if (!(await exists(metaPath))) continue;
      try {
        const meta = await readJson(metaPath);
        const summary = (await exists(summaryPath)) ? await readJson(summaryPath) : null;
        runs.push({
          run_id: meta.run_id,
          ts: meta.ts,
          brief_id: meta.plan?.brief?.id ?? null,
          title: meta.plan?.brief?.title ?? null,
          outcome: summary?.outcome ?? "incomplete",
          winner: summary?.winner ?? null,
          spend_usd: summary?.spend_usd ?? null,
          candidates: summary?.candidates?.length ?? (meta.plan?.candidates?.length ?? 0),
        });
      } catch {
        // Unreadable run metadata is skipped, not fatal.
      }
    }
  }

  return { command: "loop", action: "list", briefs, runs };
}
