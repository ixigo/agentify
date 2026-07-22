import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REPOBENCH_ATTEMPT_SCHEMA_VERSION,
  REPOBENCH_JOB_SCHEMA_VERSION,
  REPOBENCH_RETRIEVAL_SCHEMA_VERSION,
  importRepobenchJob,
  loadRepobenchManifest,
  planRepobenchRun,
  validateRepobenchDataset,
} from "../src/core/repobench.js";
import {
  buildEvalReport,
  compareEvalReports,
  renderEvalReportHtml,
  renderEvalReportMarkdown,
} from "../src/core/eval-report.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The fixture's pinned answer line; import re-derives exact match from these
// hashes, so the fixture attempts must use predictions consistent with it.
const FIXTURE_TARGET = "    return compute_total(policy)";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function fixtureVerification() {
  return {
    all_code_sha256: "a".repeat(64),
    cropped_code_sha256: "b".repeat(64),
    import_statement_sha256: "c".repeat(64),
    next_line_sha256: sha256(FIXTURE_TARGET),
    next_line_token_sha256: sha256(FIXTURE_TARGET.split(/\s+/).filter(Boolean).join(" ")),
    gold_path_sha256: sha256("pkg/helpers.py"),
    gold_snippet_sha256: "f".repeat(64),
  };
}

function fixtureManifest() {
  return {
    schema: "repobench-context-v1",
    dataset: {
      name: "tianyang/repobench_python_v1.1",
      revision: "8a7cf0c8942cc1aa066bf261839650ac55a2ff79",
      split: "cross_file_first",
    },
    pins: { claude_code: "2.1.215", agentify: "0.4.0", node: "22.22.0" },
    model: "anthropic/claude-sonnet-4-5-20250929",
    limits: {
      completion_max_budget_usd: 0.25,
      completion_max_turns: 4,
      context_snippets: 5,
      context_max_chars: 6000,
    },
    arms: ["agentify", "claude-code"],
    selection_rule: "first content-verified row per distinct repository, in dataset order, capped at 8 repositories",
    tasks: [
      {
        task_id: "cross_file_first/0",
        row_index: 0,
        repo: "owner/repo-one",
        commit: "1".repeat(40),
        file_path: "pkg/consumer.py",
        level: "2k",
        verification: fixtureVerification(),
      },
      {
        task_id: "cross_file_first/1",
        row_index: 1,
        repo: "owner/repo-two",
        commit: "2".repeat(40),
        file_path: "src/other.py",
        level: "2k",
        verification: fixtureVerification(),
      },
    ],
    suites: { smoke: { tasks: ["cross_file_first/0", "cross_file_first/1"], attempts: 1 } },
  };
}

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentify-repobench-test-"));
}

async function writeFixture(root, manifest = fixtureManifest(), prompt = "Complete `{file_path}` given {import_statement}, {context_block}, {code}.\n") {
  const repobenchRoot = path.join(root, "evals", "repobench");
  await fs.mkdir(path.join(repobenchRoot, "prompts"), { recursive: true });
  await fs.writeFile(path.join(repobenchRoot, "dataset.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(repobenchRoot, "prompts", "completion.md"), prompt);
  await fs.writeFile(path.join(repobenchRoot, "runner.py"), "# fixture\n");
  return repobenchRoot;
}

test("committed RepoBench protocol validates and plans bounded spend", async () => {
  const validation = await validateRepobenchDataset(REPO_ROOT, {});
  assert.equal(validation.ok, true, JSON.stringify(validation.problems));
  assert.equal(validation.tasks.length, 8);
  assert.equal(new Set(validation.tasks.map((task) => task.repo)).size, 8);
  assert.deepEqual(validation.answer_isolation.query_inputs, ["import_statement"]);
  assert.ok(validation.answer_isolation.committed_answer_fields_forbidden.includes("next_line"));

  const smoke = await planRepobenchRun(REPO_ROOT, {}, { suite: "smoke" });
  assert.equal(smoke.completion_trials, 2);
  assert.equal(smoke.retrieval_cost_usd, 0);
  assert.equal(smoke.max_spend_usd, 0.5);

  const full = await planRepobenchRun(REPO_ROOT, {}, { suite: "repo-8" });
  assert.equal(full.completion_trials, 16);
  assert.equal(full.max_spend_usd, 4);
  assert.equal(full.repos.length, 8);
});

test("manifest forbids answer-bearing fields, unpinned revisions, and repeated repos", async () => {
  const root = await makeRoot();
  const leaked = fixtureManifest();
  leaked.tasks[0].next_line = "return gold";
  await writeFixture(root, leaked);
  await assert.rejects(loadRepobenchManifest(root), /must not commit answer-bearing field "next_line"/);

  const floating = fixtureManifest();
  floating.dataset.revision = "main";
  await writeFixture(root, floating);
  await assert.rejects(loadRepobenchManifest(root), /full 40-character commit SHA/);

  const repeated = fixtureManifest();
  repeated.tasks[1].repo = repeated.tasks[0].repo;
  await writeFixture(root, repeated);
  await assert.rejects(loadRepobenchManifest(root), /duplicate repository/);

  const unhashed = fixtureManifest();
  delete unhashed.tasks[0].verification.next_line_sha256;
  await writeFixture(root, unhashed);
  await assert.rejects(loadRepobenchManifest(root), /verification.next_line_sha256/);
});

test("validation rejects prompts splicing non-allowlisted fields or missing required ones", async () => {
  const root = await makeRoot();
  await writeFixture(root, fixtureManifest(), "Complete {code} and hint at {next_line}.\n");
  const result = await validateRepobenchDataset(root, {});
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('"{next_line}"')));
  // Missing {context_block} would silently make both arms identical.
  assert.ok(result.problems.some((problem) => problem.includes('missing required placeholder "{context_block}"')));
});

async function writeAttempt(jobDir, { arm, task, commit, exactMatch, es, f1, cost, retrieval }) {
  const dir = path.join(jobDir, "attempts", arm, task.replace(/\//g, "-"), "1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({
    schema: REPOBENCH_ATTEMPT_SCHEMA_VERSION,
    task_id: task,
    repo: task.endsWith("0") ? "owner/repo-one" : "owner/repo-two",
    commit,
    file_path: task.endsWith("0") ? "pkg/consumer.py" : "src/other.py",
    level: "2k",
    arm,
    attempt: 1,
    model: "anthropic/claude-sonnet-4-5-20250929",
    provider: {
      exit_code: 0,
      timed_out: false,
      duration_ms: 900,
      num_turns: 1,
      tool_calls: 0,
      resolved_model: "claude-sonnet-4-5-20250929",
      observed_models: ["claude-sonnet-4-5-20250929"],
      cost_usd: cost,
      usage: { fresh_input_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 5 },
    },
    prediction: exactMatch ? FIXTURE_TARGET : "return compute_total(policy2)",
    target: FIXTURE_TARGET,
    context: {
      snippets: arm === "agentify" ? 2 : 0,
      chars: arm === "agentify" ? 300 : 0,
      files: arm === "agentify" ? ["pkg/helpers.py"] : [],
      answer_in_context: false,
      gold_in_context: arm === "agentify",
    },
    retrieval: arm === "agentify" ? { def_hit: true, gold_rank: 1, ref_edge_hit: true, impact_hit: true, ...retrieval } : null,
    score: { exact_match: exactMatch, edit_similarity: es, identifier_f1: f1 },
  }));
}

async function writeJob(root, manifest, { withRetrieval = true } = {}) {
  const jobDir = path.join(root, "evals", "repobench", "jobs", "fixture-job");
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "job.json"), JSON.stringify({
    schema: REPOBENCH_JOB_SCHEMA_VERSION,
    suite: "smoke",
    dataset: manifest.dataset,
    pins: manifest.pins,
    model: manifest.model,
    limits: manifest.limits,
    selection_rule: manifest.selection_rule,
    build: { agentify_commit: "9".repeat(40), agentify_worktree_dirty: false },
    max_spend_usd: 0.5,
    status: "graded",
    started_at: "2026-07-22T00:00:00Z",
  }));
  if (withRetrieval) {
    await fs.mkdir(path.join(jobDir, "retrieval", "tasks"), { recursive: true });
    await fs.writeFile(path.join(jobDir, "retrieval", "summary.json"), JSON.stringify({
      schema: REPOBENCH_RETRIEVAL_SCHEMA_VERSION,
      suite: "smoke",
      dataset: manifest.dataset,
      agentify: manifest.pins.agentify,
      tasks: 2,
      def_hit_rate: 1,
      hit_at_1: 0.5,
      hit_at_5: 1,
      snippet_hit_rate: 1,
      ref_edge_hit_rate: 1,
      impact_hit_rate: 0.5,
      mrr: 0.75,
      macro_precision: 0.35,
      mean_candidates: 3.5,
      cost_usd: 0,
    }));
    for (const [index, task] of manifest.tasks.entries()) {
      await fs.writeFile(
        path.join(jobDir, "retrieval", "tasks", `${task.task_id.replace(/\//g, "-")}.json`),
        JSON.stringify({
          schema: REPOBENCH_RETRIEVAL_SCHEMA_VERSION,
          task_id: task.task_id,
          repo: task.repo,
          commit: task.commit,
          def_hit: true,
          gold_path: "pkg/helpers.py",
          gold_rank: index === 0 ? 1 : 2,
          candidates: index === 0
            ? ["pkg/helpers.py", "pkg/policy.py"]
            : ["pkg/a.py", "pkg/helpers.py", "pkg/b.py", "pkg/c.py", "pkg/d.py"],
          candidate_count: index === 0 ? 2 : 5,
          snippet_hit: true,
          ref_edge_hit: true,
          impact_hit: index === 0,
        }),
      );
    }
  }
  return jobDir;
}

test("import produces an aggregate paired RepoBench report with completion quality and retrieval receipts", async () => {
  const root = await makeRoot();
  const manifest = fixtureManifest();
  await writeFixture(root, manifest);
  const jobDir = await writeJob(root, manifest);
  await writeAttempt(jobDir, { arm: "agentify", task: "cross_file_first/0", commit: "1".repeat(40), exactMatch: true, es: 100, f1: 1, cost: 0.02 });
  await writeAttempt(jobDir, { arm: "claude-code", task: "cross_file_first/0", commit: "1".repeat(40), exactMatch: false, es: 92, f1: 0.5, cost: 0.02 });
  await writeAttempt(jobDir, { arm: "agentify", task: "cross_file_first/1", commit: "2".repeat(40), exactMatch: true, es: 100, f1: 1, cost: 0.02, retrieval: { gold_rank: 2, impact_hit: false } });
  await writeAttempt(jobDir, { arm: "claude-code", task: "cross_file_first/1", commit: "2".repeat(40), exactMatch: true, es: 100, f1: 1, cost: 0.02 });

  const imported = await importRepobenchJob(root, {}, jobDir, { now: "2026-07-22T01:00:00Z" });
  assert.equal(imported.attempts_imported, 4);
  assert.equal(imported.retrieval.def_hit_rate, 1);

  const report = await buildEvalReport(root, {}, imported.run.run_id);
  assert.equal(report.harness, "repobench");
  assert.equal(report.repobench.dataset.revision, manifest.dataset.revision);
  assert.equal(report.repobench.retrieval.hit_at_1, 0.5);
  assert.equal(report.task.base_sha, report.repobench.sample_sha256);
  assert.deepEqual(
    report.repobench.sample.map(({ task_id, repo, commit }) => ({ task_id, repo, commit })),
    manifest.suites.smoke.tasks.map((taskId) => {
      const entry = manifest.tasks.find((task) => task.task_id === taskId);
      return { task_id: taskId, repo: entry.repo, commit: entry.commit };
    }),
  );
  assert.equal(report.arms.agentify.pass_rate, 1);
  assert.equal(report.arms["claude-code"].pass_rate, 0.5);
  assert.equal(report.arms.agentify.repobench.exact_match_rate, 1);
  assert.equal(report.arms["claude-code"].repobench.mean_edit_similarity, 96);
  assert.equal(report.arms.agentify.repobench.mean_identifier_f1, 1);

  const markdown = renderEvalReportMarkdown(report);
  assert.match(markdown, /Harness: repobench/);
  assert.match(markdown, /Completion quality \(repobench\)/);
  assert.match(markdown, /Index retrieval vs gold cross-file context/);
  const html = renderEvalReportHtml(report);
  assert.match(html, /repobench harness/);
  assert.match(html, /Completion quality \(repobench\)/);
  assert.match(html, /hit@5 100%/);

  const native = structuredClone(report);
  native.harness = "native";
  assert.throws(() => compareEvalReports(report, native, "pass_rate_drop>0.05"), /harness/);

  const failedProviderPath = path.join(jobDir, "attempts", "claude-code", "cross_file_first-0", "1", "result.json");
  const failedProvider = JSON.parse(await fs.readFile(failedProviderPath, "utf8"));
  failedProvider.provider.exit_code = 1;
  await fs.writeFile(failedProviderPath, JSON.stringify(failedProvider));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /provider execution did not complete successfully/);
});

test("import refuses incomplete jobs, missing retrieval receipts, tool use, and pin drift", async () => {
  const root = await makeRoot();
  const manifest = fixtureManifest();
  await writeFixture(root, manifest);
  const jobDir = await writeJob(root, manifest, { withRetrieval: false });
  await writeAttempt(jobDir, { arm: "agentify", task: "cross_file_first/0", commit: "1".repeat(40), exactMatch: true, es: 100, f1: 1, cost: 0.02 });
  // The token-free retrieval summary is required evidence, not an optional
  // attachment.
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /missing its retrieval summary/);

  await writeJob(root, manifest);
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /incomplete: expected 4 scored attempts, found 1/);

  await writeAttempt(jobDir, { arm: "claude-code", task: "cross_file_first/0", commit: "1".repeat(40), exactMatch: false, es: 92, f1: 0.5, cost: 0.02 });
  await writeAttempt(jobDir, { arm: "claude-code", task: "cross_file_first/1", commit: "2".repeat(40), exactMatch: true, es: 100, f1: 1, cost: 0.02 });
  const agentifyPath = path.join(jobDir, "attempts", "agentify", "cross_file_first-1", "1");
  await fs.mkdir(agentifyPath, { recursive: true });
  await writeAttempt(jobDir, { arm: "agentify", task: "cross_file_first/1", commit: "2".repeat(40), exactMatch: true, es: 100, f1: 1, cost: 0.02, retrieval: { gold_rank: 2, impact_hit: false } });
  const record = JSON.parse(await fs.readFile(path.join(agentifyPath, "result.json"), "utf8"));
  record.retrieval = null;
  await fs.writeFile(path.join(agentifyPath, "result.json"), JSON.stringify(record));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /lacks its retrieval receipt/);

  // Attempt retrieval data that contradicts the job's own receipt is not
  // importable evidence.
  record.retrieval = { def_hit: true, gold_rank: 1, ref_edge_hit: true, impact_hit: true };
  await fs.writeFile(path.join(agentifyPath, "result.json"), JSON.stringify(record));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /disagrees with the job's retrieval receipt/);

  record.retrieval = { def_hit: true, gold_rank: 2, ref_edge_hit: true, impact_hit: false };
  record.provider.tool_calls = 2;
  await fs.writeFile(path.join(agentifyPath, "result.json"), JSON.stringify(record));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /not verifiably tool-free/);
  record.provider.tool_calls = 0;
  record.context.snippets = 99;
  await fs.writeFile(path.join(agentifyPath, "result.json"), JSON.stringify(record));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /exceeds the declared bounds/);
  record.context.snippets = 2;
  await fs.writeFile(path.join(agentifyPath, "result.json"), JSON.stringify(record));

  // A baseline that received any cross-file context is a different
  // experiment and must not import.
  const baselinePath = path.join(jobDir, "attempts", "claude-code", "cross_file_first-0", "1", "result.json");
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  baseline.context.snippets = 1;
  await fs.writeFile(baselinePath, JSON.stringify(baseline));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /baseline attempt received cross-file context/);
  baseline.context.snippets = 0;
  await fs.writeFile(baselinePath, JSON.stringify(baseline));

  // A summary copied from a different suite or produced by a different
  // agentify version is not evidence for this job.
  const summaryPath = path.join(jobDir, "retrieval", "summary.json");
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  summary.suite = "repo-8";
  await fs.writeFile(summaryPath, JSON.stringify(summary));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /names suite "repo-8"/);
  summary.suite = "smoke";
  summary.agentify = "0.3.0";
  await fs.writeFile(summaryPath, JSON.stringify(summary));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /produced by agentify "0.3.0"/);
  summary.agentify = manifest.pins.agentify;
  summary.def_hit_rate = 0.5;
  await fs.writeFile(summaryPath, JSON.stringify(summary));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /receipts recompute to 1/);
  summary.def_hit_rate = 1;
  await fs.writeFile(summaryPath, JSON.stringify(summary));
  const receiptPath = path.join(jobDir, "retrieval", "tasks", "cross_file_first-1.json");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  receipt.commit = "9".repeat(40);
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /retrieval receipt for cross_file_first\/1/);
  receipt.commit = "2".repeat(40);
  await fs.writeFile(receiptPath, JSON.stringify(receipt));

  const job = JSON.parse(await fs.readFile(path.join(jobDir, "job.json"), "utf8"));
  job.pins.agentify = "0.3.9";
  await fs.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /pin agentify does not match/);

  job.pins.agentify = manifest.pins.agentify;
  job.status = "running";
  await fs.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job));
  await assert.rejects(importRepobenchJob(root, {}, jobDir), /must be fully scored before import/);
});
