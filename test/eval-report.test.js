import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  COMPARE_EXIT_PASS,
  COMPARE_EXIT_VIOLATION,
  buildEvalReport,
  compareEvalReports,
  parseFailOnExpressions,
  renderEvalReportHtml,
  renderEvalReportMarkdown,
  signTestPValue,
  wilsonInterval,
} from "../src/core/eval-report.js";

const BASE_SHA = "a".repeat(40);
const MODEL = "claude-haiku-4-5-20251001";
const SECRET_PROMPT = "SECRET-PROMPT-TEXT do the task";

function fixtureTask(overrides = {}) {
  return {
    schema: "eval-task-v1",
    id: "sample",
    description: "",
    prompt: SECRET_PROMPT,
    base_ref: BASE_SHA,
    model: MODEL,
    effort: null,
    max_budget_usd: 0.25,
    max_turns: 6,
    timeout_seconds: 60,
    repeat: 3,
    setup: [],
    grader: { commands: ["test -f solution.txt"] },
    forbidden_paths: ["CLAUDE.md"],
    arms: ["agentify", "plain-safe"],
    profile: "balanced",
    seed_context: true,
    ...overrides,
  };
}

function makeAttempt(arm, repeatIndex, {
  pass = true,
  cost = 0.01,
  providerMs = 5000,
  turns = 3,
  timedOut = false,
  subtype = "success",
  status = "ok",
  forbidden = [],
  usage = { fresh_input_tokens: 100, cache_write_tokens: 20, cache_read_tokens: 400, output_tokens: 50 },
  checkOutput = "ok",
} = {}) {
  return {
    schema: "eval-attempt-v1",
    run_id: "unused",
    attempt_id: `${arm}-${repeatIndex}`,
    arm,
    repeat_index: repeatIndex,
    task_id: "sample",
    base_sha: BASE_SHA,
    agentify_version: "0.4.0",
    claude_version: "9.9.9",
    model: MODEL,
    status,
    pass,
    duration_ms: providerMs + 2000,
    provider: {
      exit_code: status === "ok" ? 0 : 1,
      timed_out: timedOut,
      duration_ms: providerMs,
      subtype,
      num_turns: turns,
      resolved_model: MODEL,
      cost_usd: cost,
      usage,
    },
    grade: {
      pass,
      forbidden_violations: forbidden,
      checks: [{ command: "test -f solution.txt", exit_code: pass ? 0 : 1, passed: pass, timed_out: false, output_tail: checkOutput }],
      changed_paths: pass ? ["solution.txt"] : [],
    },
    artifacts: { patch: `attempts/${arm}-${repeatIndex}/patch.diff`, provider_stdout: `attempts/${arm}-${repeatIndex}/provider-stdout.json` },
  };
}

let runCounter = 0;

async function writeRunFixture(root, attempts, { task = fixtureTask(), planned = null } = {}) {
  runCounter += 1;
  const runId = `20260713-1000${String(runCounter).padStart(2, "0")}-abc${String(runCounter).padStart(3, "0")}`;
  const runDir = path.join(root, ".agentify", "evals", "runs", runId);
  const order = attempts.map((attempt) => ({ attempt_id: attempt.attempt_id, arm: attempt.arm, repeat_index: attempt.repeat_index }));
  if (planned) {
    for (const extra of planned) {
      order.push(extra);
    }
  }
  await fs.mkdir(path.join(runDir, "attempts"), { recursive: true });
  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify({
    schema: "eval-run-v1",
    ts: "2026-07-13T10:00:00.000Z",
    run_id: runId,
    agentify_version: "0.4.0",
    claude_version: "9.9.9",
    plan: {
      task,
      task_path: "evals/sample.yaml",
      base_sha: BASE_SHA,
      arms: task.arms,
      repeat: task.repeat,
      max_spend_usd: order.length * task.max_budget_usd,
      order,
    },
  }, null, 2));
  for (const attempt of attempts) {
    const dir = path.join(runDir, "attempts", attempt.attempt_id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(attempt, null, 2));
  }
  return runId;
}

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentify-eval-report-"));
}

test("signTestPValue matches exact two-sided binomial values and stays stable at large n", () => {
  assert.equal(signTestPValue(0, 0), 1);
  assert.equal(signTestPValue(5, 0), 0.0625);
  assert.equal(signTestPValue(6, 0), 0.03125);
  assert.equal(signTestPValue(3, 3), 1);
  // Large discordant counts: no overflow, no NaN, correct tail value.
  assert.ok(Math.abs(signTestPValue(544, 480) - 0.048929) < 0.0001);
  assert.equal(signTestPValue(550, 550), 1);
});

test("wilsonInterval behaves at extremes and small n", () => {
  assert.equal(wilsonInterval(0, 0), null);
  const allPass = wilsonInterval(6, 6);
  assert.ok(allPass.low > 0.55 && allPass.high === 1);
  const nonePass = wilsonInterval(0, 6);
  assert.ok(nonePass.high < 0.45 && nonePass.low === 0);
  const half = wilsonInterval(3, 6);
  assert.ok(half.low < 0.5 && half.high > 0.5);
});

test("buildEvalReport computes arm metrics, paired deltas, and frontier from a mixed run", async () => {
  const root = await makeRoot();
  try {
    // 3 paired repetitions, mixed pass/fail, cached tokens, one timeout.
    const attempts = [
      makeAttempt("agentify", 1, { pass: true, cost: 0.01, providerMs: 4000 }),
      makeAttempt("agentify", 2, { pass: true, cost: 0.02, providerMs: 5000 }),
      makeAttempt("agentify", 3, { pass: false, cost: 0.03, providerMs: 60000, timedOut: true, status: "timeout", subtype: null }),
      makeAttempt("plain-safe", 1, { pass: false, cost: 0.01, providerMs: 3000 }),
      makeAttempt("plain-safe", 2, { pass: true, cost: 0.04, providerMs: 9000 }),
      makeAttempt("plain-safe", 3, { pass: false, cost: 0.01, providerMs: 4000 }),
    ];
    const runId = await writeRunFixture(root, attempts);
    const report = await buildEvalReport(root, {}, runId);

    const agentify = report.arms.agentify;
    assert.equal(agentify.attempts, 3);
    assert.equal(agentify.passes, 2);
    assert.equal(agentify.pass_rate, 0.6667);
    assert.ok(agentify.pass_rate_ci95.low < 0.6667 && agentify.pass_rate_ci95.high > 0.6667);
    assert.equal(agentify.cost.reported_usd, 0.06);
    assert.equal(agentify.cost.per_attempt_usd, 0.02);
    assert.equal(agentify.cost.per_pass_usd, 0.03);
    assert.equal(agentify.tokens.cache_read, 1200);
    assert.equal(agentify.failure_breakdown.timeout, 1);

    const plain = report.arms["plain-safe"];
    assert.equal(plain.passes, 1);
    assert.equal(plain.cost.per_pass_usd, 0.06);

    // Paired evidence: repeat 1 discordant toward agentify, repeat 2 both
    // pass, repeat 3 both fail.
    assert.equal(report.paired.length, 1);
    const pair = report.paired[0];
    assert.equal(pair.baseline, "plain-safe");
    assert.equal(pair.pairs, 3);
    assert.equal(pair.discordant.agentify_only_pass, 1);
    assert.equal(pair.discordant.baseline_only_pass, 0);
    assert.equal(pair.pass_rate_delta, 0.3334);
    // One discordant pair is no evidence at all: p = 1.
    assert.equal(pair.sign_test_p, 1);

    // agentify dominates: higher pass rate at lower cost per pass.
    const frontierArms = report.frontier.points.filter((point) => point.on_frontier).map((point) => point.arm);
    assert.deepEqual(frontierArms, ["agentify"]);

    // 3 < MIN_ATTEMPTS_PER_ARM: labeled and no winner.
    assert.ok(report.completeness.underpowered);
    assert.deepEqual(report.completeness.labels, ["underpowered"]);
    assert.equal(report.verdict.winner, null);
    assert.match(report.verdict.reason, /fewer than 5 attempts/);

    // The raw prompt never appears; its hash does.
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(SECRET_PROMPT));
    assert.equal(report.task.prompt_sha256.length, 64);
    assert.equal(report.versions.claude, "9.9.9");
    assert.equal(report.attempts.length, 6);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("zero passes yield null cost-per-pass and no frontier membership, never divide-by-zero", async () => {
  const root = await makeRoot();
  try {
    const attempts = [
      makeAttempt("agentify", 1, { pass: false }),
      makeAttempt("plain-safe", 1, { pass: false, cost: null }),
    ];
    const runId = await writeRunFixture(root, attempts, { task: fixtureTask({ repeat: 1 }) });
    const report = await buildEvalReport(root, {}, runId);
    assert.equal(report.arms.agentify.cost.per_pass_usd, null);
    // Unreported cost is separated, not estimated into the totals.
    assert.equal(report.arms["plain-safe"].cost.reported_attempts, 0);
    assert.equal(report.arms["plain-safe"].cost.unreported_attempts, 1);
    assert.equal(report.arms["plain-safe"].cost.per_attempt_usd, null);
    assert.equal(report.frontier.points.filter((point) => point.on_frontier).length, 0);
    assert.equal(report.verdict.winner, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("partial and unpaired runs are labeled and cannot produce a winner", async () => {
  const root = await makeRoot();
  try {
    const attempts = [
      makeAttempt("agentify", 1),
      makeAttempt("agentify", 2),
      makeAttempt("plain-safe", 1),
    ];
    const runId = await writeRunFixture(root, attempts, {
      task: fixtureTask({ repeat: 2 }),
      planned: [{ attempt_id: "plain-safe-2", arm: "plain-safe", repeat_index: 2 }],
    });
    const report = await buildEvalReport(root, {}, runId);
    assert.ok(report.completeness.partial);
    assert.ok(!report.completeness.paired);
    assert.deepEqual(report.completeness.labels, ["partial", "unpaired", "underpowered"]);
    assert.equal(report.verdict.winner, null);
    assert.equal(report.verdict.eligible, false);
    // Paired deltas come from the intersecting repeat indices only; the
    // unmatched agentify-2 attempt cannot leak into a "paired" delta.
    assert.equal(report.paired[0].pairs, 1);
    assert.equal(report.paired[0].pass_rate_delta, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a powered run needs BOTH separated CIs and a significant paired sign test to declare a winner", async () => {
  const root = await makeRoot();
  try {
    // 6 discordant pairs, all toward agentify: p = 0.03125 < 0.05 → winner.
    const winning = [];
    for (let index = 1; index <= 6; index += 1) {
      winning.push(makeAttempt("agentify", index, { pass: true }));
      winning.push(makeAttempt("plain-safe", index, { pass: false }));
    }
    const winningRun = await writeRunFixture(root, winning, { task: fixtureTask({ repeat: 6 }) });
    const winningReport = await buildEvalReport(root, {}, winningRun);
    assert.deepEqual(winningReport.completeness.labels, []);
    assert.equal(winningReport.verdict.winner, "agentify");
    assert.equal(winningReport.verdict.eligible, true);

    // 5 discordant pairs, all toward agentify: CIs are separated (0.5655 vs
    // 0.4345) but the exact sign test gives p = 0.0625 — no winner.
    const underpowered = [];
    for (let index = 1; index <= 5; index += 1) {
      underpowered.push(makeAttempt("agentify", index, { pass: true }));
      underpowered.push(makeAttempt("plain-safe", index, { pass: false }));
    }
    const marginalRun = await writeRunFixture(root, underpowered, { task: fixtureTask({ repeat: 5 }) });
    const marginalReport = await buildEvalReport(root, {}, marginalRun);
    assert.deepEqual(marginalReport.completeness.labels, []);
    assert.equal(marginalReport.paired[0].sign_test_p, 0.0625);
    assert.equal(marginalReport.verdict.winner, null);
    assert.match(marginalReport.verdict.reason, /sign test is not significant/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("markdown and html renderers carry the same headline metrics, redacted and escaped", async () => {
  const root = await makeRoot();
  try {
    const attempts = [
      makeAttempt("agentify", 1, { checkOutput: "API_KEY=sk-abcdefghijklmnop123456 leaked" }),
      makeAttempt("plain-safe", 1, { pass: false, forbidden: [{ path: "<script>alert(1)</script>", patterns: ["CLAUDE.md"] }], changed: [] }),
    ];
    attempts[1].grade.changed_paths = ["<script>alert(1)</script>"];
    const runId = await writeRunFixture(root, attempts, { task: fixtureTask({ repeat: 1 }) });
    const report = await buildEvalReport(root, {}, runId);

    const md = renderEvalReportMarkdown(report);
    assert.match(md, /UNDERPOWERED/);
    assert.match(md, /\| agentify \| 1\/1/);
    assert.match(md, /Cost-quality frontier/);
    assert.ok(!md.includes(SECRET_PROMPT));

    const html = renderEvalReportHtml(report);
    assert.match(html, /Eval report/);
    assert.match(html, /UNDERPOWERED/);
    assert.ok(!html.includes("<script>alert(1)</script>"), "changed paths are HTML-escaped");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes(SECRET_PROMPT));

    // Grader output in the drill-down is redacted in every format.
    assert.ok(!JSON.stringify(report).includes("sk-abcdefghijklmnop123456"));
    assert.match(JSON.stringify(report), /\[REDACTED\]/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildEvalReport defaults to the most recent run and validates run ids", async () => {
  const root = await makeRoot();
  try {
    await writeRunFixture(root, [makeAttempt("agentify", 1), makeAttempt("plain-safe", 1)], { task: fixtureTask({ repeat: 1 }) });
    const newer = await writeRunFixture(root, [makeAttempt("agentify", 1), makeAttempt("plain-safe", 1)], { task: fixtureTask({ repeat: 1 }) });
    const report = await buildEvalReport(root, {}, undefined);
    assert.equal(report.run_id, newer);
    await assert.rejects(buildEvalReport(root, {}, "../../etc"), /Invalid eval run id/);
    await assert.rejects(buildEvalReport(root, {}, "20990101-000000-ffffff"), /No eval run found/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parseFailOnExpressions accepts repeats and comma lists, rejects unknown gates", () => {
  assert.deepEqual(parseFailOnExpressions("pass_rate_drop>0.02"), [{ metric: "pass_rate_drop", threshold: 0.02 }]);
  assert.deepEqual(
    parseFailOnExpressions(["pass_rate_drop>0.02", "cost_per_pass_increase>0.10,p95_latency_increase>0.2"]),
    [
      { metric: "pass_rate_drop", threshold: 0.02 },
      { metric: "cost_per_pass_increase", threshold: 0.1 },
      { metric: "p95_latency_increase", threshold: 0.2 },
    ],
  );
  assert.throws(() => parseFailOnExpressions(undefined), /requires at least one/);
  // Valueless --fail-on occurrences fail loudly instead of being dropped.
  assert.throws(() => parseFailOnExpressions(true), /explicit 'gate>threshold'/);
  assert.throws(() => parseFailOnExpressions([true, "pass_rate_drop>0.02"]), /explicit 'gate>threshold'/);
  assert.throws(() => parseFailOnExpressions("vibes>0.5"), /Unrecognized --fail-on/);
  assert.throws(() => parseFailOnExpressions("pass_rate_drop>-1"), /Unrecognized --fail-on/);
});

async function buildPairOfReports(currentSpec, baselineSpec) {
  const root = await makeRoot();
  try {
    const build = async (spec) => {
      const attempts = [];
      for (let index = 1; index <= spec.length; index += 1) {
        attempts.push(makeAttempt("agentify", index, spec[index - 1]));
        attempts.push(makeAttempt("plain-safe", index, spec[index - 1]));
      }
      const runId = await writeRunFixture(root, attempts, { task: fixtureTask({ repeat: spec.length }) });
      return buildEvalReport(root, {}, runId);
    };
    return { current: await build(currentSpec), baseline: await build(baselineSpec), root };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("compareEvalReports enforces gates with documented exit codes", async () => {
  const good = [{ pass: true, cost: 0.01 }, { pass: true, cost: 0.01 }, { pass: true, cost: 0.01 }, { pass: true, cost: 0.01 }];
  const worse = [{ pass: true, cost: 0.02 }, { pass: false, cost: 0.02 }, { pass: true, cost: 0.02 }, { pass: false, cost: 0.02 }];
  const { current, baseline, root } = await buildPairOfReports(worse, good);
  try {
    const failing = compareEvalReports(current, baseline, ["pass_rate_drop>0.02", "cost_per_pass_increase>0.10"]);
    assert.equal(failing.passed, false);
    assert.equal(failing.exit_code, COMPARE_EXIT_VIOLATION);
    const violatedGates = new Set(failing.violations.map((violation) => violation.gate));
    assert.ok(violatedGates.has("pass_rate_drop"), "pass rate drop 0.5 > 0.02");
    assert.ok(violatedGates.has("cost_per_pass_increase"), "cost per pass quadrupled");
    // The violated threshold is identified exactly.
    assert.ok(failing.violations.every((violation) => violation.threshold !== undefined && violation.arm && violation.delta !== undefined));

    const lenient = compareEvalReports(current, baseline, ["p95_latency_increase>0.50"]);
    assert.equal(lenient.passed, true);
    assert.equal(lenient.exit_code, COMPARE_EXIT_PASS);

    // Reversed direction: improvement never violates.
    const improving = compareEvalReports(baseline, current, ["pass_rate_drop>0.02", "cost_per_pass_increase>0.10"]);
    assert.equal(improving.passed, true);

    assert.throws(() => compareEvalReports({ schema: "bogus" }, baseline, ["pass_rate_drop>0.02"]), /expected "eval-report-v1"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("compare fails closed on vanished metrics, all-skipped gates, zero baselines, and missing arms", async () => {
  const zeroPass = [{ pass: false, cost: 0.01 }, { pass: false, cost: 0.01 }];
  const somePass = [{ pass: true, cost: 0.01 }, { pass: false, cost: 0.01 }];
  const { current, baseline, root } = await buildPairOfReports(zeroPass, somePass);
  try {
    // Baseline had cost-per-pass; current has zero passes, so the metric
    // vanished — a regression, not a skip.
    const result = compareEvalReports(current, baseline, ["cost_per_pass_increase>0.10"]);
    assert.equal(result.passed, false);
    assert.match(result.violations[0].reason, /current metric unavailable/);

    // Reversed: no baseline metric anywhere — the comparison itself is
    // invalid, never a silent pass.
    assert.throws(
      () => compareEvalReports(baseline, current, ["cost_per_pass_increase>0.10"]),
      /No gate could be evaluated/,
    );

    // A zero baseline with positive current cost is an unbounded relative
    // increase, not a skip.
    const zeroBaseline = structuredClone(baseline);
    for (const metrics of Object.values(zeroBaseline.arms)) {
      metrics.cost.per_pass_usd = 0;
    }
    const unbounded = compareEvalReports(baseline, zeroBaseline, ["cost_per_pass_increase>0.10"]);
    assert.equal(unbounded.passed, false);
    assert.match(unbounded.violations[0].reason, /unbounded relative increase/);

    // A baseline arm missing from the current run is a coverage regression.
    const armless = structuredClone(current);
    delete armless.arms["plain-safe"];
    const missingArm = compareEvalReports(armless, baseline, ["pass_rate_drop>0.99"]);
    assert.equal(missingArm.passed, false);
    assert.ok(missingArm.violations.some((violation) => violation.gate === "arm_presence" && violation.arm === "plain-safe"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("compare refuses incomparable reports unless forced", async () => {
  const spec = [{ pass: true, cost: 0.01 }, { pass: true, cost: 0.01 }];
  const { current, baseline, root } = await buildPairOfReports(spec, spec);
  try {
    // Different grader → different task fingerprint → not comparable.
    const differentTask = structuredClone(baseline);
    differentTask.task.fingerprint_sha256 = "f".repeat(64);
    assert.throws(
      () => compareEvalReports(current, differentTask, ["pass_rate_drop>0.02"]),
      /not comparable: task fingerprint/,
    );
    const forced = compareEvalReports(current, differentTask, ["pass_rate_drop>0.02"], { force: true });
    assert.equal(forced.forced, true);
    assert.ok(forced.comparability_issues.length > 0);

    // Partial/unpaired runs cannot be gated silently either — checked on the
    // canonical completeness fields, not the derived labels.
    const partial = structuredClone(baseline);
    partial.completeness.partial = true;
    partial.completeness.labels = [];
    assert.throws(
      () => compareEvalReports(current, partial, ["pass_rate_drop>0.02"]),
      /baseline run is partial/,
    );

    // A malformed report with a missing metric must not sail through as
    // "passed" via NaN arithmetic.
    const malformed = structuredClone(baseline);
    for (const metrics of Object.values(malformed.arms)) {
      delete metrics.latency;
    }
    assert.throws(
      () => compareEvalReports(current, malformed, ["p95_latency_increase>0.20"]),
      /No gate could be evaluated/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
