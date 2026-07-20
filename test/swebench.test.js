import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SWEBENCH_ATTEMPT_SCHEMA_VERSION,
  SWEBENCH_JOB_SCHEMA_VERSION,
  importSwebenchJob,
  loadSwebenchManifest,
  planSwebenchRun,
  validateSwebenchDataset,
} from "../src/core/swebench.js";
import {
  buildEvalReport,
  compareEvalReports,
  renderEvalReportHtml,
  renderEvalReportMarkdown,
} from "../src/core/eval-report.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixtureManifest() {
  return {
    schema: "swebench-warm-v1",
    dataset: {
      name: "princeton-nlp/SWE-bench_Verified",
      revision: "c104f840cc67f8b6eec6f759ebc8b2693d585d4a",
      split: "test",
    },
    pins: { swebench: "4.1.0", claude_code: "2.1.215", agentify: "0.4.0", node: "22.22.0" },
    model: "anthropic/claude-sonnet-4-5-20250929",
    limits: {
      scored_max_budget_usd: 2,
      scored_max_turns: 40,
      warmup_max_budget_usd: 0.5,
      warmup_max_turns: 12,
    },
    arms: ["agentify", "claude-code"],
    instances: [
      { instance_id: "owner__repo-1", repo: "owner/repo", base_commit: "1".repeat(40), difficulty: "easy" },
      { instance_id: "owner__repo-2", repo: "owner/repo", base_commit: "2".repeat(40), difficulty: "easy" },
    ],
    suites: { smoke: { instances: ["owner__repo-1", "owner__repo-2"], attempts: 1 } },
  };
}

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentify-swebench-test-"));
}

async function writeFixture(root, manifest = fixtureManifest(), prompt = "Explore repository structure and record durable conventions.\n") {
  const swebenchRoot = path.join(root, "evals", "swebench");
  await fs.mkdir(path.join(swebenchRoot, "warmup"), { recursive: true });
  await fs.writeFile(path.join(swebenchRoot, "dataset.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(swebenchRoot, "warmup", "instruction.md"), prompt);
  await fs.writeFile(path.join(swebenchRoot, "runner.py"), "# fixture\n");
  return swebenchRoot;
}

test("committed SWE-bench protocol validates and plans bounded spend", async () => {
  const validation = await validateSwebenchDataset(REPO_ROOT, {});
  assert.equal(validation.ok, true, JSON.stringify(validation.problems));
  assert.equal(validation.instances.length, 6);
  assert.deepEqual(validation.contamination_barrier.warmup_input_allowlist, ["repo", "base_commit"]);

  const smoke = await planSwebenchRun(REPO_ROOT, {}, { suite: "smoke" });
  assert.equal(smoke.scored_trials, 2);
  assert.equal(smoke.warmup_runs, 1);
  assert.equal(smoke.max_spend_usd, 4.5);

  const stratified = await planSwebenchRun(REPO_ROOT, {}, { suite: "repo-stratified-6" });
  assert.equal(stratified.scored_trials, 12);
  assert.equal(stratified.warmup_runs, 3);
  assert.equal(stratified.max_spend_usd, 25.5);
  assert.equal(stratified.warmup_ceiling_per_instance_usd, 0.25);
});

test("manifest forbids answer-bearing fields and unpinned dataset revisions", async () => {
  const root = await makeRoot();
  const leaked = fixtureManifest();
  leaked.instances[0].patch = "gold";
  await writeFixture(root, leaked);
  await assert.rejects(loadSwebenchManifest(root), /must not commit answer-bearing field "patch"/);

  const floating = fixtureManifest();
  floating.dataset.revision = "main";
  await writeFixture(root, floating);
  await assert.rejects(loadSwebenchManifest(root), /full 40-character commit SHA/);
});

test("validation rejects instance-specific warm-up prompts", async () => {
  const root = await makeRoot();
  await writeFixture(root, fixtureManifest(), "Inspect the problem_statement before exploring.\n");
  const result = await validateSwebenchDataset(root, {});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("problem_statement")));
});

async function writeAttempt(jobDir, { arm, instance, resolved, cost, turns, firstEdit }) {
  const dir = path.join(jobDir, "attempts", arm, instance, "1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({
    schema: SWEBENCH_ATTEMPT_SCHEMA_VERSION,
    instance_id: instance,
    repo: "owner/repo",
    base_commit: instance.endsWith("1") ? "1".repeat(40) : "2".repeat(40),
    difficulty: "easy",
    arm,
    attempt: 1,
    provider: {
      exit_code: 0,
      timed_out: false,
      duration_ms: 1000,
      num_turns: turns + 3,
      turns_to_first_edit: firstEdit,
      cost_usd: cost,
      usage: { fresh_input_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 5 },
    },
    changed_paths: ["src/example.py"],
    contamination: arm === "agentify" ? { status: "passed", patterns_checked: 3 } : null,
    score: { resolved, official_report: "logs/report.json" },
  }));
}

test("import produces an aggregate paired SWE-bench report with cost/resolved and first-edit delta", async () => {
  const root = await makeRoot();
  const manifest = fixtureManifest();
  await writeFixture(root, manifest);
  const jobDir = path.join(root, "evals", "swebench", "jobs", "fixture-job");
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "job.json"), JSON.stringify({
    schema: SWEBENCH_JOB_SCHEMA_VERSION,
    suite: "smoke",
    dataset: manifest.dataset,
    pins: manifest.pins,
    model: manifest.model,
    limits: manifest.limits,
    max_spend_usd: 8.5,
    status: "graded",
    started_at: "2026-07-20T00:00:00Z",
    warmups: [{ repo: "owner/repo", provider: { cost_usd: 0.4 }, contamination: { status: "passed" } }],
  }));
  await writeAttempt(jobDir, { arm: "agentify", instance: "owner__repo-1", resolved: true, cost: 0.3, turns: 5, firstEdit: 2 });
  await writeAttempt(jobDir, { arm: "claude-code", instance: "owner__repo-1", resolved: false, cost: 0.5, turns: 8, firstEdit: 5 });
  await writeAttempt(jobDir, { arm: "agentify", instance: "owner__repo-2", resolved: true, cost: 0.3, turns: 6, firstEdit: 3 });
  await writeAttempt(jobDir, { arm: "claude-code", instance: "owner__repo-2", resolved: true, cost: 0.5, turns: 9, firstEdit: 6 });

  const imported = await importSwebenchJob(root, {}, jobDir, { now: "2026-07-20T01:00:00Z" });
  assert.equal(imported.attempts_imported, 4);
  const report = await buildEvalReport(root, {}, imported.run.run_id);
  assert.equal(report.harness, "swebench");
  assert.equal(report.swebench.dataset.revision, manifest.dataset.revision);
  assert.deepEqual(
    report.swebench.sample.map(({ instance_id, repo, base_commit }) => ({ instance_id, repo, base_commit })),
    manifest.suites.smoke.instances.map((instanceId) => {
      const instance = manifest.instances.find((entry) => entry.instance_id === instanceId);
      return { instance_id: instanceId, repo: instance.repo, base_commit: instance.base_commit };
    }),
  );
  assert.equal(report.task.base_sha, report.swebench.sample_sha256);
  assert.equal(report.versions.swebench, "4.1.0");
  assert.equal(report.arms.agentify.pass_rate, 1);
  assert.equal(report.arms["claude-code"].pass_rate, 0.5);
  // Warm-up cost is allocated once across the two warmed instances:
  // 2 × ($0.30 recall + $0.20 warm allocation) / 2 resolves.
  assert.equal(report.arms.agentify.cost.reported_usd, 1);
  assert.equal(report.arms.agentify.cost.per_pass_usd, 0.5);
  assert.equal(report.arms["claude-code"].cost.per_pass_usd, 1);
  assert.equal(report.arms.agentify.turns_to_first_edit.mean, 2.5);
  assert.equal(report.arms["claude-code"].turns_to_first_edit.mean, 5.5);
  assert.equal(report.economics.comparisons[0].phase_b.turns_to_first_edit.avoided, 6);
  assert.equal(report.economics.comparisons[0].phase_b.turns_to_first_edit.improved_pairs, 2);
  assert.equal(report.economics.comparisons[0].phase_b.turns_to_first_edit.sign_test_p, 0.5);

  const markdown = renderEvalReportMarkdown(report);
  assert.match(markdown, /Harness: swebench/);
  assert.match(markdown, /mean turns to first edit/);
  const html = renderEvalReportHtml(report);
  assert.match(html, /swebench harness/);
  assert.match(html, /mean turns to first edit/);

  const native = structuredClone(report);
  native.harness = "native";
  assert.throws(() => compareEvalReports(report, native, "pass_rate_drop>0.05"), /harness/);

  const jobWithoutWarmCost = JSON.parse(await fs.readFile(path.join(jobDir, "job.json"), "utf8"));
  jobWithoutWarmCost.warmups[0].provider.cost_usd = null;
  await fs.writeFile(path.join(jobDir, "job.json"), JSON.stringify(jobWithoutWarmCost));
  const uncosted = await importSwebenchJob(root, {}, jobDir, { now: "2026-07-20T02:00:00Z" });
  const uncostedReport = await buildEvalReport(root, {}, uncosted.run.run_id);
  assert.equal(uncostedReport.arms.agentify.cost.unreported_attempts, 2);
  assert.equal(uncostedReport.arms.agentify.cost.per_pass_usd, null);

  const failedProviderPath = path.join(jobDir, "attempts", "claude-code", "owner__repo-1", "1", "result.json");
  const failedProvider = JSON.parse(await fs.readFile(failedProviderPath, "utf8"));
  failedProvider.provider.exit_code = 1;
  await fs.writeFile(failedProviderPath, JSON.stringify(failedProvider));
  await assert.rejects(importSwebenchJob(root, {}, jobDir), /provider execution did not complete successfully/);
});

test("import refuses warm attempts without a passed contamination receipt", async () => {
  const root = await makeRoot();
  const manifest = fixtureManifest();
  await writeFixture(root, manifest);
  const jobDir = path.join(root, "job");
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "job.json"), JSON.stringify({
    schema: SWEBENCH_JOB_SCHEMA_VERSION,
    suite: "smoke",
    dataset: manifest.dataset,
    pins: manifest.pins,
    model: manifest.model,
    limits: manifest.limits,
    status: "graded",
    warmups: [],
  }));
  await writeAttempt(jobDir, { arm: "agentify", instance: "owner__repo-1", resolved: true, cost: 0.3, turns: 4, firstEdit: 1 });
  const resultPath = path.join(jobDir, "attempts", "agentify", "owner__repo-1", "1", "result.json");
  const record = JSON.parse(await fs.readFile(resultPath, "utf8"));
  record.contamination = { status: "failed" };
  await fs.writeFile(resultPath, JSON.stringify(record));
  await assert.rejects(importSwebenchJob(root, {}, jobDir), /No scored SWE-bench attempts/);
});
