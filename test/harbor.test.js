import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HARBOR_TASK_CATEGORIES,
  harborArmForAgent,
  importHarborJob,
  loadHarborManifest,
  planHarborRun,
  validateHarborDataset,
} from "../src/core/harbor.js";
import { buildEvalReport, compareEvalReports, renderEvalReportHtml, renderEvalReportMarkdown } from "../src/core/eval-report.js";
import { runEval } from "../src/core/eval.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentify-harbor-"));
}

function manifestFixture(overrides = {}) {
  // Eight tasks covering every category, mirroring the committed dataset's
  // shape without its content.
  const tasks = [
    { id: "task-a", category: "decision-recall" },
    { id: "task-b", category: "prior-failure-avoidance" },
    { id: "task-c", category: "stale-context-rejection" },
    { id: "task-d", category: "repo-intelligence" },
    { id: "task-e", category: "affected-test-selection" },
    { id: "task-f", category: "mechanical-control" },
    { id: "task-g", category: "misleading-context" },
    { id: "task-h", category: "prior-failure-avoidance" },
  ].map((task) => ({ ...task, max_cost_usd: 0.25, answer_leak_patterns: ["SOLUTION_MARKER"] }));
  return {
    schema: "harbor-dataset-v1",
    name: "fixture-bench",
    version: "1.0.0",
    model: "anthropic/claude-haiku-4-5-20251001",
    pins: { harbor: "0.2.1", claude_code: "2.0.21", agentify: "0.4.0" },
    agents: [
      { name: "agentify-claude", kind: "installed", import_path: "agents.agentify_claude:AgentifyClaudeAgent" },
      { name: "claude-code", kind: "builtin" },
    ],
    tasks,
    suites: {
      smoke: { tasks: ["task-a"], attempts: 1 },
      nightly: { tasks: tasks.map((task) => task.id), attempts: 3 },
    },
    ...overrides,
  };
}

async function writeDataset(root, manifest, { fixtureNote = "history only", testScript = "#!/usr/bin/env bash\nset -euo pipefail\ncd /app\nnode --test\n" } = {}) {
  const harborRoot = path.join(root, "evals", "harbor");
  await fs.mkdir(path.join(harborRoot, "agents"), { recursive: true });
  await fs.writeFile(path.join(harborRoot, "dataset.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(harborRoot, "agents", "agentify_claude.py"), "# stub\n");
  await fs.mkdir(path.join(harborRoot, "suites"), { recursive: true });
  for (const suite of Object.keys(manifest.suites || {})) {
    await fs.writeFile(path.join(harborRoot, "suites", `${suite}.yaml`), "jobs_dir: jobs\n");
  }
  for (const task of manifest.tasks || []) {
    const taskDir = path.join(harborRoot, "tasks", task.id);
    await fs.mkdir(path.join(taskDir, "environment", "fixtures", "agentify-context"), { recursive: true });
    await fs.mkdir(path.join(taskDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(taskDir, "solution"), { recursive: true });
    await fs.writeFile(path.join(taskDir, "task.toml"), 'version = "1.0"\n');
    await fs.writeFile(path.join(taskDir, "instruction.md"), "Do the task.\n");
    await fs.writeFile(path.join(taskDir, "environment", "Dockerfile"), "FROM node:20.18.1-bookworm-slim\n");
    await fs.writeFile(
      path.join(taskDir, "environment", "fixtures", "agentify-context", "notes.jsonl"),
      `${JSON.stringify({ ts: "2026-05-01T00:00:00.000Z", sid: "aabbccdd", note: fixtureNote })}\n`,
    );
    await fs.writeFile(path.join(taskDir, "tests", "test.sh"), testScript);
    await fs.writeFile(path.join(taskDir, "solution", "solve.sh"), "#!/usr/bin/env bash\nexit 0\n");
  }
  return harborRoot;
}

// ---------------------------------------------------------------------------
// Manifest + dataset validation
// ---------------------------------------------------------------------------

test("committed Harbor dataset validates cleanly (CI schema check, token-free)", async () => {
  const result = await validateHarborDataset(REPO_ROOT, {});
  assert.equal(result.ok, true, JSON.stringify(result.problems, null, 2));
  assert.ok(result.tasks.length >= 8);
  for (const category of HARBOR_TASK_CATEGORIES) {
    assert.ok(result.tasks.some((task) => task.category === category), `missing category ${category}`);
  }
  assert.ok(result.suites.smoke);
});

test("committed crossvendor suite plans at its ceiling and ships its adapter (#316)", async () => {
  const plan = await planHarborRun(REPO_ROOT, {}, { suite: "crossvendor" });
  assert.equal(plan.trials, 12); // 2 tasks × 2 agents × 3 attempts
  assert.equal(plan.max_spend_usd, 8.4); // 12 × $0.70
  assert.equal(plan.agents_per_task, 2);
  // The cross-vendor adapter the suite imports (Codex seed -> Claude recall)
  // must exist alongside the base agent.
  const adapter = path.join(REPO_ROOT, "evals", "harbor", "agents", "agentify_transfer.py");
  assert.ok(await fs.access(adapter).then(() => true).catch(() => false), "agentify_transfer.py missing");
});

test("manifest validation rejects unpinned versions, thin datasets, and bad suites", async () => {
  const root = await makeRoot();

  await writeDataset(root, manifestFixture({ pins: { harbor: "latest", claude_code: "2.0.21", agentify: "0.4.0" } }));
  await assert.rejects(loadHarborManifest(root), /pins\.harbor must be pinned/);

  await writeDataset(root, manifestFixture({ tasks: manifestFixture().tasks.slice(0, 5), suites: { smoke: { tasks: ["task-a"], attempts: 1 } } }));
  await assert.rejects(loadHarborManifest(root), /at least 8 tasks/);

  const missingCategory = manifestFixture();
  missingCategory.tasks = missingCategory.tasks.map((task) => ({ ...task, category: "decision-recall" }));
  await writeDataset(root, missingCategory);
  await assert.rejects(loadHarborManifest(root), /missing:/);

  await writeDataset(root, manifestFixture({ suites: { nightly: { tasks: ["task-a"], attempts: 1 } } }));
  await assert.rejects(loadHarborManifest(root), /"smoke"/);

  await writeDataset(root, manifestFixture({ suites: { smoke: { tasks: ["nope"], attempts: 1 } } }));
  await assert.rejects(loadHarborManifest(root), /known task ids/);
});

test("validation fails a fixture that leaks an answer pattern", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture(), { fixtureNote: "the fix is SOLUTION_MARKER exactly" });
  const result = await validateHarborDataset(root, {});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('leaks answer pattern "SOLUTION_MARKER"')));
});

test("validation fails a verifier that reads the fixtures path", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture(), { testScript: "#!/usr/bin/env bash\ngrep foo /opt/agentify-fixtures/notes.jsonl\n" });
  const result = await validateHarborDataset(root, {});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("must not reference the Agentify fixtures path")));
});

// Turn one committed task into a two-phase (write -> recall) task on disk:
// a seed instruction under environment/phases/seed/ and a Dockerfile that
// bakes it into the image.
async function makeTwoPhase(harborRoot, taskId, { seedText = "Seed: investigate the repo.\n", recallText = "Do the task.\n", copySeed = true, dockerfile = null } = {}) {
  const taskDir = path.join(harborRoot, "tasks", taskId);
  await fs.mkdir(path.join(taskDir, "environment", "phases", "seed"), { recursive: true });
  await fs.writeFile(path.join(taskDir, "environment", "phases", "seed", "instruction.md"), seedText);
  await fs.writeFile(path.join(taskDir, "instruction.md"), recallText);
  await fs.writeFile(
    path.join(taskDir, "environment", "Dockerfile"),
    dockerfile !== null
      ? dockerfile
      : copySeed
        ? "FROM node:20.18.1-bookworm-slim\nCOPY phases/seed/instruction.md /opt/agentify-seed/instruction.md\n"
        : "FROM node:20.18.1-bookworm-slim\n",
  );
}

function withTwoPhaseTask(overrides = {}) {
  const manifest = manifestFixture(overrides);
  manifest.tasks = manifest.tasks.map((task) => (task.id === "task-h" ? { ...task, phases: ["seed", "recall"] } : task));
  return manifest;
}

test("validation accepts a well-formed two-phase (write->recall) task", async () => {
  const root = await makeRoot();
  const harborRoot = await writeDataset(root, withTwoPhaseTask());
  await makeTwoPhase(harborRoot, "task-h");
  const result = await validateHarborDataset(root, {});
  assert.equal(result.ok, true, JSON.stringify(result.problems, null, 2));
  const twoPhase = result.tasks.find((task) => task.id === "task-h");
  assert.deepEqual(twoPhase.phases, ["seed", "recall"]);
});

test("validation ties the seed file and the phases declaration together", async () => {
  // Seed file on disk but the manifest never declares phases.
  const root = await makeRoot();
  const harborRoot = await writeDataset(root, manifestFixture());
  await makeTwoPhase(harborRoot, "task-h");
  let result = await validateHarborDataset(root, {});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('does not declare "phases"')));

  // Declares phases but ships no seed instruction.
  const root2 = await makeRoot();
  await writeDataset(root2, withTwoPhaseTask());
  result = await validateHarborDataset(root2, {});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("has no environment")));
});

test("validation leak-checks both prompts and requires the seed baked into the image", async () => {
  const root = await makeRoot();
  const harborRoot = await writeDataset(root, withTwoPhaseTask());
  // Recall prompt leaks the answer; the Dockerfile never bakes the seed in.
  await makeTwoPhase(harborRoot, "task-h", { recallText: "Return SOLUTION_MARKER now.\n", copySeed: false });
  const result = await validateHarborDataset(root, {});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('instruction.md leaks answer pattern "SOLUTION_MARKER"')));
  assert.ok(result.problems.some((problem) => problem.includes("must COPY")));

  // A leak in the seed prompt is caught the same way.
  const root2 = await makeRoot();
  const harborRoot2 = await writeDataset(root2, withTwoPhaseTask());
  await makeTwoPhase(harborRoot2, "task-h", { seedText: "Hint: SOLUTION_MARKER.\n" });
  const seedLeak = await validateHarborDataset(root2, {});
  assert.equal(seedLeak.ok, false);
  assert.ok(seedLeak.problems.some((problem) => problem.includes("seed/instruction.md leaks answer pattern")));
});

test("validation requires a real COPY of the seed, not just a mention", async () => {
  // A comment naming the seed path, and a COPY to some other target, both look
  // valid to a substring check but leave /opt/agentify-seed/instruction.md
  // absent — so the agent silently skips phase A. Both must fail.
  for (const dockerfile of [
    "FROM node:20.18.1-bookworm-slim\n# TODO: bake phases/seed/instruction.md into /opt/agentify-seed\n",
    "FROM node:20.18.1-bookworm-slim\nCOPY phases/seed/instruction.md /opt/somewhere-else/instruction.md\n",
    "FROM node:20.18.1-bookworm-slim\nCOPY phases/ /opt/\n",
  ]) {
    const root = await makeRoot();
    const harborRoot = await writeDataset(root, withTwoPhaseTask());
    await makeTwoPhase(harborRoot, "task-h", { dockerfile });
    const result = await validateHarborDataset(root, {});
    assert.equal(result.ok, false, `expected failure for:\n${dockerfile}`);
    assert.ok(result.problems.some((problem) => problem.includes("must COPY")));
  }

  // A directory copy lands instruction.md inside the target dir — accepted.
  const root = await makeRoot();
  const harborRoot = await writeDataset(root, withTwoPhaseTask());
  await makeTwoPhase(harborRoot, "task-h", {
    dockerfile: "FROM node:20.18.1-bookworm-slim\nCOPY --chown=node:node phases/seed/ /opt/agentify-seed/\n",
  });
  const ok = await validateHarborDataset(root, {});
  assert.equal(ok.ok, true, JSON.stringify(ok.problems, null, 2));
});

test("validation flags missing files, undeclared dirs, and broken fixture JSONL", async () => {
  const root = await makeRoot();
  const harborRoot = await writeDataset(root, manifestFixture());
  await fs.rm(path.join(harborRoot, "tasks", "task-a", "solution", "solve.sh"));
  await fs.writeFile(path.join(harborRoot, "tasks", "task-b", "environment", "fixtures", "agentify-context", "notes.jsonl"), "not json\n");
  await fs.mkdir(path.join(harborRoot, "tasks", "rogue-task"));
  const result = await validateHarborDataset(root, {});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("task-a: missing solution/solve.sh")));
  assert.ok(result.problems.some((problem) => problem.includes("non-JSON line")));
  assert.ok(result.problems.some((problem) => problem.includes('"rogue-task" is not declared')));
});

// ---------------------------------------------------------------------------
// Spend planning
// ---------------------------------------------------------------------------

test("plan computes the hard spend ceiling as tasks x agents x attempts x cap", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture());
  const smoke = await planHarborRun(root, {}, { suite: "smoke" });
  assert.equal(smoke.trials, 2); // 1 task × 2 agents × 1 attempt
  assert.equal(smoke.max_spend_usd, 0.5);
  assert.equal(smoke.harbor_command, "harbor run -c evals/harbor/suites/smoke.yaml");

  const nightly = await planHarborRun(root, {}, { suite: "nightly" });
  assert.equal(nightly.trials, 8 * 2 * 3);
  assert.equal(nightly.max_spend_usd, Number((8 * 2 * 3 * 0.25).toFixed(6)));

  await assert.rejects(planHarborRun(root, {}, { suite: "missing" }), /Unknown Harbor suite/);
});

test("a suite can widen its agent count for the profile matrix", async () => {
  const root = await makeRoot();
  const manifest = manifestFixture();
  manifest.suites.profiles = { tasks: ["task-a"], attempts: 2, agents: 4 };
  await writeDataset(root, manifest);
  const plan = await planHarborRun(root, {}, { suite: "profiles" });
  assert.equal(plan.trials, 8);
  assert.equal(plan.max_spend_usd, 2);
});

// ---------------------------------------------------------------------------
// Arm mapping
// ---------------------------------------------------------------------------

test("harbor agent names map onto native arm labels", () => {
  assert.equal(harborArmForAgent("agentify-claude"), "agentify");
  assert.equal(harborArmForAgent("agentify-claude", "balanced"), "agentify");
  assert.equal(harborArmForAgent("agentify-claude", "cost"), "agentify-cost");
  assert.equal(harborArmForAgent("Claude Code"), "claude-code");
  assert.equal(harborArmForAgent("oracle"), "oracle");
  assert.equal(harborArmForAgent(""), null);
  // Cross-vendor arms (#316): the transfer agent maps to the agentify arm (so
  // the paired verdict engine engages); the no-memory baseline keeps its own
  // name (no "agentify" substring) so it never masquerades as the agentify arm.
  assert.equal(harborArmForAgent("agentify-transfer"), "agentify");
  assert.equal(harborArmForAgent("crossvendor-nomem"), "crossvendor-nomem");
});

// ---------------------------------------------------------------------------
// Import -> native report
// ---------------------------------------------------------------------------

function trialResult({ task, agent, reward, cost = 0.04, inputTokens = 900, cacheRead = 600, outputTokens = 120, exception = null, profile = null, suffix = "", metadata = null, model = "anthropic/claude-haiku-4-5-20251001" }) {
  return {
    trial_name: `${task}__${agent}${profile ? `-${profile}` : ""}${suffix}`,
    task_name: task,
    agent_name: agent,
    agent_info: { name: agent, version: "1.2.3", model_name: model, ...(profile ? { kwargs: { profile } } : {}) },
    started_at: "2026-07-10T01:00:00.000Z",
    finished_at: "2026-07-10T01:04:00.000Z",
    agent_execution: { started_at: "2026-07-10T01:01:00.000Z", finished_at: "2026-07-10T01:03:30.000Z" },
    // The nested rewards mapping and n_cache_tokens spelling match real
    // harbor 0.18.0 artifacts (verified against an actual oracle job).
    verifier_result: { rewards: { reward } },
    agent_result: { cost_usd: cost, n_input_tokens: inputTokens, n_cache_tokens: cacheRead, n_output_tokens: outputTokens, ...(metadata ? { metadata } : {}) },
    ...(exception ? { exception_info: { message: exception } } : {}),
  };
}

async function writeJob(root, jobName, trials) {
  const jobDir = path.join(root, "evals", "harbor", "jobs", jobName);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "config.json"), JSON.stringify({ harbor_version: "0.2.1" }));
  for (const trial of trials) {
    const trialDir = path.join(jobDir, trial.trial_name.replace(/[^a-z0-9_-]/gi, "_"));
    await fs.mkdir(trialDir, { recursive: true });
    await fs.writeFile(path.join(trialDir, "result.json"), JSON.stringify(trial));
  }
  return jobDir;
}

test("import converts a paired Harbor job into native runs the report can read", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture());
  const jobDir = await writeJob(root, "2026-07-10-smoke", [
    trialResult({ task: "task-a", agent: "agentify-claude", reward: 1 }),
    trialResult({ task: "task-a", agent: "claude-code", reward: 0, cost: 0.05 }),
    trialResult({ task: "task-b", agent: "agentify-claude", reward: 1 }),
    trialResult({ task: "task-b", agent: "claude-code", reward: 1 }),
  ]);

  const result = await importHarborJob(root, {}, jobDir);
  assert.equal(result.runs.length, 2);
  assert.equal(result.trials_skipped.length, 0);
  assert.equal(result.harbor_version, "0.2.1");
  assert.deepEqual(result.dataset, { name: "fixture-bench", version: "1.0.0" });

  const runA = result.runs.find((run) => run.task_id === "task-a");
  assert.deepEqual([...runA.arms].sort(), ["agentify", "claude-code"]);

  const report = await buildEvalReport(root, {}, runA.run_id);
  assert.equal(report.harness, "harbor");
  assert.equal(report.versions.harbor, "0.2.1");
  assert.equal(report.harbor.dataset.name, "fixture-bench");
  assert.equal(report.arms.agentify.passes, 1);
  assert.equal(report.arms["claude-code"].passes, 0);
  // Cost and usage import as provider-reported values.
  assert.equal(report.arms.agentify.cost.reported_usd, 0.04);
  assert.equal(report.arms.agentify.tokens.fresh_input, 300); // 900 input − 600 cache reads
  assert.equal(report.arms.agentify.tokens.cache_read, 600);
  // The paired machinery engages because the agentify arm label matched.
  assert.equal(report.paired.length, 1);
  assert.equal(report.paired[0].baseline, "claude-code");
  assert.equal(report.paired[0].discordant.agentify_only_pass, 1);
  // Provenance survives down to the attempt drill-down source records.
  const attempt = JSON.parse(await fs.readFile(path.join(root, ".agentify", "evals", "runs", runA.run_id, "attempts", "agentify-1", "result.json"), "utf8"));
  assert.equal(attempt.harness, "harbor");
  assert.equal(attempt.harbor.trial, "task-a__agentify-claude");
  assert.equal(attempt.harbor.reward, 1);
  assert.equal(attempt.harbor.dataset.version, "1.0.0");

  // Renderers surface the harness so a Harbor report can never pass as native.
  assert.match(renderEvalReportMarkdown(report), /Harness: harbor/);
  assert.match(renderEvalReportHtml(report), /Harness: <code>harbor<\/code>/);
});

test("import folds the multisession seed cost into the arm's total, keeping the split", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture());
  const jobDir = await writeJob(root, "2026-07-10-multisession", [
    trialResult({
      task: "task-a", agent: "agentify-claude", reward: 1, cost: 0.04,
      metadata: { multisession: true, seed_cost_usd: 0.03, seed_num_turns: 5, num_turns: 8 },
    }),
    trialResult({ task: "task-a", agent: "claude-code", reward: 1, cost: 0.05 }),
  ]);

  const { runs } = await importHarborJob(root, {}, jobDir);
  const runA = runs.find((run) => run.task_id === "task-a");
  const report = await buildEvalReport(root, {}, runA.run_id);
  // Cost-per-pass must count the memory investment: recall 0.04 + seed 0.03.
  assert.equal(report.arms.agentify.cost.reported_usd, 0.07);
  // The baseline has no seed phase, so its cost is untouched.
  assert.equal(report.arms["claude-code"].cost.reported_usd, 0.05);

  // The two-phase split survives on the attempt record for amortized analysis.
  const attempt = JSON.parse(await fs.readFile(path.join(root, ".agentify", "evals", "runs", runA.run_id, "attempts", "agentify-1", "result.json"), "utf8"));
  assert.equal(attempt.provider.cost_usd, 0.07);
  assert.equal(attempt.provider.multisession, true);
  assert.equal(attempt.provider.recall_cost_usd, 0.04);
  assert.equal(attempt.provider.seed_cost_usd, 0.03);
});

test("import handles a cross-vendor transfer job: agentify arm vs its own no-memory baseline (#316)", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture());
  // Codex seeds, Claude recalls: the transfer arm marks the trial two-phase but
  // the Codex seed reports no cost (unreported, never zero), so there is nothing
  // to fold — the graded recall cost stands alone.
  const jobDir = await writeJob(root, "2026-07-10-crossvendor", [
    trialResult({
      task: "task-a", agent: "agentify-transfer", reward: 1, cost: 0.05,
      metadata: {
        multisession: true, seed_cost_usd: null, cross_vendor: true,
        seed_provider: "codex", graded_provider: "claude", direction: "codex-to-claude",
      },
    }),
    trialResult({ task: "task-a", agent: "crossvendor-nomem", reward: 0, cost: 0.05 }),
  ]);

  const { runs } = await importHarborJob(root, {}, jobDir);
  const runA = runs.find((run) => run.task_id === "task-a");
  // The transfer agent imports as the agentify arm; the no-memory baseline keeps
  // its own arm label.
  assert.deepEqual([...runA.arms].sort(), ["agentify", "crossvendor-nomem"]);

  const report = await buildEvalReport(root, {}, runA.run_id);
  assert.equal(report.arms.agentify.passes, 1);
  assert.equal(report.arms["crossvendor-nomem"].passes, 0);
  // No seed cost to fold: the recall cost is the reported total.
  assert.equal(report.arms.agentify.cost.reported_usd, 0.05);
  // The paired machinery engages against the no-memory baseline — a deterministic
  // discordant pair, which is exactly what a single-vendor harness scores 0 on.
  assert.equal(report.paired.length, 1);
  assert.equal(report.paired[0].baseline, "crossvendor-nomem");
  assert.equal(report.paired[0].discordant.agentify_only_pass, 1);

  // The two-phase marker survives on the attempt record even with the Codex seed
  // cost unreported, so amortized analysis still knows it was a two-phase trial.
  const attempt = JSON.parse(await fs.readFile(path.join(root, ".agentify", "evals", "runs", runA.run_id, "attempts", "agentify-1", "result.json"), "utf8"));
  assert.equal(attempt.provider.multisession, true);
  assert.equal(attempt.provider.recall_cost_usd, 0.05);
  assert.equal(attempt.provider.seed_cost_usd, null);
});

test("import maps profiles, partial rewards, exceptions, and skips broken trials", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture());
  const jobDir = await writeJob(root, "2026-07-11-profiles", [
    trialResult({ task: "task-a", agent: "agentify-claude", reward: 1, profile: "cost" }),
    trialResult({ task: "task-a", agent: "agentify-claude", reward: 0.5 }),
    trialResult({ task: "task-a", agent: "claude-code", reward: null, exception: "container died" }),
    { trial_name: "task-a__broken", started_at: "2026-07-11T00:00:00Z" }, // no agent identity
  ]);
  const result = await importHarborJob(root, {}, jobDir);
  assert.equal(result.runs.length, 1);
  assert.equal(result.trials_skipped.length, 1);

  const report = await buildEvalReport(root, {}, result.runs[0].run_id);
  assert.deepEqual(Object.keys(report.arms).sort(), ["agentify", "agentify-cost", "claude-code"]);
  // Partial reward is a fail, and the reward is preserved for the drill-down.
  assert.equal(report.arms.agentify.passes, 0);
  assert.equal(report.attempts.find((attempt) => attempt.arm === "agentify").checks[0].output_tail, "reward 0.5");
  // An exception imports as a harness error, not a silent fail.
  assert.equal(report.attempts.find((attempt) => attempt.arm === "claude-code").status, "error");
});

test("imported runs cannot be resumed and cross-harness compare needs --force", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture());
  const jobDir = await writeJob(root, "2026-07-12-smoke", [
    trialResult({ task: "task-a", agent: "agentify-claude", reward: 1 }),
    trialResult({ task: "task-a", agent: "claude-code", reward: 1 }),
  ]);
  const { runs } = await importHarborJob(root, {}, jobDir);
  await assert.rejects(
    runEval(root, {}, null, { resume: runs[0].run_id }),
    /imported from the harbor harness and cannot be resumed/,
  );

  const harborReport = await buildEvalReport(root, {}, runs[0].run_id);
  const nativeReport = JSON.parse(JSON.stringify(harborReport));
  nativeReport.harness = "native";
  assert.throws(
    () => compareEvalReports(harborReport, nativeReport, "pass_rate_drop>0.05"),
    /harness/,
  );
  const forced = compareEvalReports(harborReport, nativeReport, "pass_rate_drop>0.05", { force: true });
  assert.equal(forced.forced, true);
});

test("external jobs never inherit the local dataset's provenance", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture());
  // A Terminal-Bench-style job: task ids the local manifest does not declare.
  const jobDir = await writeJob(root, "2026-07-13-external", [
    trialResult({ task: "tbench-hello-world", agent: "agentify-claude", reward: 1 }),
    trialResult({ task: "tbench-hello-world", agent: "claude-code", reward: 0 }),
  ]);
  const result = await importHarborJob(root, {}, jobDir);
  assert.equal(result.dataset, null);
  const report = await buildEvalReport(root, {}, result.runs[0].run_id);
  assert.equal(report.harbor.dataset, null);
  // harbor_version comes from the job's own config, never the local pin.
  assert.equal(report.versions.harbor, "0.2.1");
});

test("harbor fingerprints distinguish datasets and tasks; native fingerprints are unchanged", async () => {
  const root = await makeRoot();
  await writeDataset(root, manifestFixture());
  const jobDir = await writeJob(root, "2026-07-13-two-tasks", [
    trialResult({ task: "task-a", agent: "agentify-claude", reward: 1 }),
    trialResult({ task: "task-a", agent: "claude-code", reward: 1 }),
    trialResult({ task: "task-b", agent: "agentify-claude", reward: 1 }),
    trialResult({ task: "task-b", agent: "claude-code", reward: 1 }),
  ]);
  const { runs } = await importHarborJob(root, {}, jobDir);
  const reports = await Promise.all(runs.map((run) => buildEvalReport(root, {}, run.run_id)));
  // Same dataset, different tasks -> different fingerprints, so eval compare
  // cannot silently gate one harbor task against another (or against a
  // different dataset version) without --force.
  assert.notEqual(reports[0].task.fingerprint_sha256, reports[1].task.fingerprint_sha256);
  assert.throws(
    () => compareEvalReports(reports[0], reports[1], "pass_rate_drop>0.05"),
    /task fingerprint/,
  );
});

test("import rejects empty or missing job directories", async () => {
  const root = await makeRoot();
  await assert.rejects(importHarborJob(root, {}, "does-not-exist"), /job directory/);
  const emptyDir = path.join(root, "empty-job");
  await fs.mkdir(emptyDir, { recursive: true });
  await assert.rejects(importHarborJob(root, {}, emptyDir), /No importable Harbor trials/);
});

// ---------------------------------------------------------------------------
// Model down-shift × difficulty matrix (#317)
// ---------------------------------------------------------------------------

test("committed downshift suite plans the model×difficulty matrix and bounds its ceiling (#317)", async () => {
  const plan = await planHarborRun(REPO_ROOT, {}, { suite: "downshift" });
  // 9 tasks × 2 arms × 3 attempts × 3 model rungs.
  assert.equal(plan.models_per_task, 3);
  assert.equal(plan.trials, 162);
  assert.equal(plan.max_spend_usd, 56.7); // 162 × $0.35
  assert.equal(plan.models.length, 3);
  assert.ok(plan.models.includes("anthropic/claude-haiku-4-5-20251001"));
  // Every planned task carries a difficulty rung for the grid.
  assert.ok(plan.tasks.every((task) => ["easy", "medium", "hard"].includes(task.difficulty)));

  // Single-model suites are unchanged: the ladder is just the manifest pin.
  const nightly = await planHarborRun(REPO_ROOT, {}, { suite: "nightly" });
  assert.equal(nightly.models_per_task, 1);
  assert.deepEqual(nightly.models, ["anthropic/claude-haiku-4-5-20251001"]);
  assert.equal(nightly.trials, 48); // unchanged: 8 × 2 × 3 × 1
});

test("plan multiplies the spend ceiling by the suite's model ladder length (#317)", async () => {
  const root = await makeRoot();
  const manifest = manifestFixture();
  manifest.suites.matrix = { tasks: ["task-a", "task-b"], attempts: 2, agents: 2, models: ["anthropic/claude-a-1", "anthropic/claude-b-2", "anthropic/claude-c-3"] };
  await writeDataset(root, manifest);
  const plan = await planHarborRun(root, {}, { suite: "matrix" });
  // 2 tasks × 2 agents × 2 attempts × 3 models.
  assert.equal(plan.trials, 24);
  assert.equal(plan.models_per_task, 3);
  assert.equal(plan.max_spend_usd, Number((2 * 2 * 2 * 3 * 0.25).toFixed(6)));
});

test("manifest validation covers difficulty rungs and pinned model ladders (#317)", async () => {
  const root = await makeRoot();

  // A bad difficulty on a task is rejected — a typo would split a grid column.
  const badDifficulty = manifestFixture();
  badDifficulty.tasks[0] = { ...badDifficulty.tasks[0], difficulty: "trivial" };
  await writeDataset(root, badDifficulty);
  await assert.rejects(loadHarborManifest(root), /unknown difficulty "trivial"/);

  // An unpinned model rung in a suite ladder is rejected — the ceiling must be
  // reproducible.
  const unpinned = manifestFixture();
  unpinned.suites.matrix = { tasks: ["task-a"], attempts: 1, agents: 2, models: ["anthropic/claude-latest"] };
  await writeDataset(root, unpinned);
  await assert.rejects(loadHarborManifest(root), /models\[\] must be pinned/);

  // A valid ladder + difficulty load cleanly and default difficulty is "easy".
  const good = manifestFixture();
  good.tasks[1] = { ...good.tasks[1], difficulty: "hard" };
  good.suites.matrix = { tasks: ["task-a", "task-b"], attempts: 2, agents: 2, models: ["anthropic/claude-x-1", "anthropic/claude-y-2"] };
  await writeDataset(root, good);
  const { manifest } = await loadHarborManifest(root);
  assert.equal(manifest.tasks[0].difficulty, "easy"); // defaulted
  assert.equal(manifest.tasks[1].difficulty, "hard");
  assert.equal(manifest.suites.matrix.models.length, 2);
});

test("import splits a two-model job into per-(task, model) runs and stamps difficulty (#317)", async () => {
  const root = await makeRoot();
  const manifest = manifestFixture();
  manifest.tasks[0] = { ...manifest.tasks[0], difficulty: "hard" }; // task-a
  await writeDataset(root, manifest);
  const weak = "anthropic/claude-3-5-haiku-20241022";
  const strong = "anthropic/claude-sonnet-4-5-20250929";
  const jobDir = await writeJob(root, "2026-07-19-downshift", [
    trialResult({ task: "task-a", agent: "agentify-claude", reward: 1, model: weak, suffix: "-weak" }),
    trialResult({ task: "task-a", agent: "claude-code", reward: 0, model: weak, suffix: "-weak" }),
    trialResult({ task: "task-a", agent: "agentify-claude", reward: 1, model: strong, suffix: "-strong" }),
    trialResult({ task: "task-a", agent: "claude-code", reward: 1, model: strong, suffix: "-strong" }),
  ]);

  const { runs } = await importHarborJob(root, {}, jobDir);
  // Same task, two models => two single-model runs, not one mixed run.
  assert.equal(runs.length, 2);
  const byModel = new Map(runs.map((run) => [run.model, run]));
  assert.ok(byModel.has(weak) && byModel.has(strong));
  for (const run of runs) {
    assert.equal(run.task_id, "task-a");
    assert.equal(run.difficulty, "hard");
    assert.deepEqual([...run.arms].sort(), ["agentify", "claude-code"]);
    assert.equal(run.attempts, 2); // one per arm — repeat indices did not collide
  }

  // The difficulty axis reaches both the run meta and the attempt records.
  const weakRunDir = path.join(root, ".agentify", "evals", "runs", byModel.get(weak).run_id);
  const runMeta = JSON.parse(await fs.readFile(path.join(weakRunDir, "run.json"), "utf8"));
  assert.equal(runMeta.plan.task.difficulty, "hard");
  assert.equal(runMeta.plan.task.model, weak);
  const attempt = JSON.parse(await fs.readFile(path.join(weakRunDir, "attempts", "agentify-1", "result.json"), "utf8"));
  assert.equal(attempt.difficulty, "hard");
  assert.equal(attempt.model, weak);
});

test("committed difficulty variants reuse the base verifier verbatim (#317)", async () => {
  const tasksRoot = path.join(REPO_ROOT, "evals", "harbor", "tasks");
  const bases = ["recall-error-envelope", "avoid-cache-regression", "reject-stale-config-path"];
  for (const base of bases) {
    const baseVerifier = await fs.readFile(path.join(tasksRoot, base, "tests", "test.sh"), "utf8");
    for (const level of ["medium", "hard"]) {
      const dir = path.join(tasksRoot, `${base}-${level}`);
      const toml = await fs.readFile(path.join(dir, "task.toml"), "utf8");
      assert.match(toml, new RegExp(`difficulty = "${level}"`), `${base}-${level} must declare difficulty ${level}`);
      // The instruction must exist and be non-empty (the harder prompt).
      const instruction = await fs.readFile(path.join(dir, "instruction.md"), "utf8");
      assert.ok(instruction.trim().length > 0, `${base}-${level} needs an instruction`);
      // Verifier intent must be unchanged: the fair-comparison contract.
      const variantVerifier = await fs.readFile(path.join(dir, "tests", "test.sh"), "utf8");
      assert.equal(variantVerifier, baseVerifier, `${base}-${level} verifier must match its base verbatim`);
    }
  }
});
