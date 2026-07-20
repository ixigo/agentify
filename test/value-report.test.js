import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addNote, loadContextSnapshot, matchContext, precheckCommand, recordContextDigestInjection, renderContextDigest, trackEvent } from "../src/core/ctx.js";
import { recordDelegation } from "../src/core/stats.js";
import { buildValueReport, renderValueHtml, renderValueReport } from "../src/core/value-report.js";
import { readValueEvents, recordValueEvent, resolveValueEventsPath } from "../src/core/value-telemetry.js";
import { runCli } from "../src/main.js";

async function makeRoot(prefix = "agentify-value-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(targetPath, value) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("value telemetry is private, append-only, and skips corrupt records", async () => {
  const root = await makeRoot("agentify-value-events-");
  await recordValueEvent(root, { type: "focused_test_run", selected_test_files: 2 });
  await fs.appendFile(resolveValueEventsPath(root), "{corrupt\nnull\n", "utf8");
  await recordValueEvent(root, { type: "failed_command_repeat_intercepted" });

  const events = await readValueEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[0].schema, "value-event-v1");
  assert.equal(events[1].type, "failed_command_repeat_intercepted");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(resolveValueEventsPath(root))).mode & 0o777, 0o600);
  }
});

test("full context digests record estimated tokens and separate stale warnings", async () => {
  const root = await makeRoot("agentify-value-digest-");
  for (let index = 0; index < 6; index += 1) {
    await addNote(root, `chose sqlite option ${index} for the local cache`, { type: "decision" });
  }
  await addNote(root, "old worker lived in src/removed/worker.ts");
  const snapshot = await loadContextSnapshot(root);
  const digest = renderContextDigest(snapshot);
  await recordContextDigestInjection(root, snapshot, digest, { sessionId: "digest-session" });

  const [event] = await readValueEvents(root);
  assert.ok(event.estimated_tokens > 0);
  assert.equal(event.decisions_reused, 5);
  assert.equal(event.reasons.stale_warning, 1);
  assert.equal(event.stale_context_rejected, 0);
});

test("buildValueReport joins context, guardrail, delegation, tests, and eval evidence", async () => {
  const root = await makeRoot("agentify-value-aggregate-");
  const now = new Date();

  await addNote(root, "chose postgres database because transactional writes need consistency", { type: "decision" });
  const decisionMatch = await matchContext(root, "review the postgres database consistency choice", { sessionId: "new-task" });
  assert.equal(decisionMatch.notes.length, 1);

  await addNote(root, "legacy payment gateway config lives in src/payments/removed-gateway.ts");
  const staleMatch = await matchContext(root, "change the legacy payment gateway config", { sessionId: "stale-task" });
  assert.equal(staleMatch.notes.length, 0);
  assert.equal(staleMatch.stale_rejected, 1);

  await trackEvent(root, {
    session_id: "older-task",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "pnpm deploy payments" },
    tool_response: { exit_code: 1, stderr: "environment is locked" },
  });
  assert.ok(await precheckCommand(root, {
    session_id: "new-task",
    tool_name: "Bash",
    tool_input: { command: "pnpm deploy payments" },
  }));

  await recordValueEvent(root, {
    type: "focused_test_run",
    selected_test_files: 2,
    indexed_test_files: 12,
    full_suite_files_avoided: 10,
    passed: true,
    duration_ms: 900,
  });
  await recordDelegation(root, {
    schema: "delegation-v2",
    kind: "quick",
    provider: "claude",
    model: "haiku",
    exit_code: 0,
    input_tokens: 120,
    output_tokens: 30,
    cost_usd: 0.02,
    duration_ms: 1500,
    usage: { fresh_input_tokens: 120, cache_read_tokens: 0, cache_write_tokens: 0 },
  });

  const runRoot = path.join(root, ".agentify", "evals", "runs", "run-1");
  await writeJson(path.join(runRoot, "run.json"), {
    run_id: "run-1",
    ts: now.toISOString(),
    plan: {
      task: { id: "checkout", model: "claude-sonnet" },
      base_sha: "abc123",
      order: [{ attempt_id: "agentify-001" }],
    },
  });
  await writeJson(path.join(runRoot, "attempts", "agentify-001", "result.json"), {
    arm: "agentify",
    pass: true,
    duration_ms: 2000,
    provider: { cost_usd: 0.12 },
  });

  const malformedRunRoot = path.join(root, ".agentify", "evals", "runs", "run-malformed-timestamp");
  await writeJson(path.join(malformedRunRoot, "run.json"), {
    run_id: "run-malformed-timestamp",
    ts: "zzzz",
    plan: {
      task: { id: "invalid-date", model: "claude-sonnet" },
      base_sha: "abc123",
      order: [{ attempt_id: "agentify-002" }],
    },
  });
  await writeJson(path.join(malformedRunRoot, "attempts", "agentify-002", "result.json"), {
    arm: "agentify",
    pass: true,
    duration_ms: 1000,
    provider: { cost_usd: 99 },
  });

  const report = await buildValueReport(root, { days: 7, now });
  assert.equal(report.context.decisions_reused, 1);
  assert.equal(report.context.injection_events, 1);
  assert.equal(report.context.stale_context_rejected, 1);
  assert.equal(report.context.failed_command_repeats_intercepted, 1);
  assert.ok(report.context.estimated_tokens > 0);
  assert.equal(report.tests.full_suite_files_avoided, 10);
  assert.equal(report.tests.passing_runs, 1);
  assert.equal(report.delegations.runs, 1);
  assert.equal(report.delegations.cost_usd, 0.02);
  assert.equal(report.cost_per_passing_task.cost_per_passing_task_usd, 0.12);
  assert.equal(report.headline.observable_assists, 4);

  const text = renderValueReport(report);
  assert.match(text, /1 previous decision\(s\) reused/);
  assert.match(text, /\$0\.1200/);

  const html = renderValueHtml(report, { projectName: "checkout <script>" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Quiet work, made visible/);
  assert.match(html, /data-testid="agentify-value-report"/);
  assert.match(html, /checkout &lt;script&gt;/);
  assert.match(html, /<caption>Daily observable assists and delegations · Last 7 days<\/caption>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /https?:\/\//);

  const longWindow = await buildValueReport(root, { days: 30, now });
  assert.equal(longWindow.daily.length, 14);
  assert.equal(longWindow.daily[0].date, new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  assert.match(renderValueHtml(longWindow), /Most recent 14 of 30 days/);
});

test("value report carries the paired memory-economics receipt from eval reports (#319)", async () => {
  const root = await makeRoot("agentify-value-economics-");
  const now = new Date("2026-07-20T12:00:00.000Z");
  const runId = "20260720-110000-abcdef";
  const runRoot = path.join(root, ".agentify", "evals", "runs", runId);
  const attempts = [
    { arm: "agentify", repeat: 1, pass: true, totalCost: 0.05, recallCost: 0.02, seedCost: 0.03, turns: 2, tokens: [200, 100, 100] },
    { arm: "agentify", repeat: 2, pass: true, totalCost: 0.05, recallCost: 0.02, seedCost: 0.03, turns: 2, tokens: [200, 100, 100] },
    { arm: "plain-safe", repeat: 1, pass: false, totalCost: 0.06, recallCost: null, seedCost: null, turns: 5, tokens: [800, 100, 300] },
    { arm: "plain-safe", repeat: 2, pass: true, totalCost: 0.06, recallCost: null, seedCost: null, turns: 5, tokens: [800, 100, 300] },
  ];
  const order = attempts.map((attempt) => ({
    attempt_id: `${attempt.arm}-${attempt.repeat}`,
    arm: attempt.arm,
    repeat_index: attempt.repeat,
  }));
  await writeJson(path.join(runRoot, "run.json"), {
    schema: "eval-run-v1",
    run_id: runId,
    ts: "2026-07-20T11:00:00.000Z",
    plan: {
      task: {
        id: "recall-known-failure",
        prompt: "do the task",
        model: "claude-haiku-4-5-20251001",
        category: "prior-failure-avoidance",
        phases: ["seed", "recall"],
        arms: ["agentify", "plain-safe"],
        repeat: 2,
      },
      base_sha: "a".repeat(40),
      arms: ["agentify", "plain-safe"],
      repeat: 2,
      order,
    },
  });
  for (const attempt of attempts) {
    const attemptId = `${attempt.arm}-${attempt.repeat}`;
    await writeJson(path.join(runRoot, "attempts", attemptId, "result.json"), {
      schema: "eval-attempt-v1",
      attempt_id: attemptId,
      arm: attempt.arm,
      repeat_index: attempt.repeat,
      status: "ok",
      pass: attempt.pass,
      duration_ms: 1000,
      provider: {
        cost_usd: attempt.totalCost,
        num_turns: attempt.turns,
        ...(attempt.arm === "agentify" ? {
          multisession: true,
          recall_cost_usd: attempt.recallCost,
          seed_cost_usd: attempt.seedCost,
          seed_num_turns: 3,
        } : {}),
        usage: {
          fresh_input_tokens: attempt.tokens[0],
          cache_read_tokens: attempt.tokens[1],
          cache_write_tokens: 0,
          output_tokens: attempt.tokens[2],
        },
      },
      grade: { pass: attempt.pass, forbidden_violations: [], checks: [], changed_paths: [] },
    });
  }

  const report = await buildValueReport(root, { days: 7, now });
  const memory = report.cost_per_passing_task.memory_economics;
  assert.equal(report.cost_per_passing_task.cost_per_passing_task_usd, 0.05);
  assert.equal(memory.paired_recalls, 2);
  assert.equal(memory.rediscovery_avoided.tokens, 1600);
  assert.equal(memory.rediscovery_avoided.turns, 6);
  assert.equal(memory.break_even.sessions, 1);
  assert.equal(memory.break_even.agentify_amortized_cost_per_session_usd, 0.05);
  assert.equal(memory.break_even.baseline_rediscovery_cost_per_session_usd, 0.06);
  assert.equal(memory.repeated_failure_cost_avoided.cost_usd, 0.06);
  assert.equal(memory.repeated_failure_cost_avoided.turns, 5);

  const text = renderValueReport(report);
  assert.match(text, /Memory economics:/);
  assert.match(text, /break-even: by recall session 1/);

  const html = renderValueHtml(report);
  assert.match(html, /<h2>Memory economics<\/h2>/);
  assert.match(html, /Amortized and rediscovery-avoided eval economics/);
  assert.match(html, /≤ 1 recall session/);
  assert.match(html, /\$0\.0500 vs \$0\.0600/);

  // A second baseline would reuse the same Agentify recalls. The value-level
  // aggregate excludes that report rather than counting the treatment twice;
  // individual eval reports still retain both per-baseline comparisons.
  const extraAttempts = [1, 2].map((repeat) => ({
    arm: "plain-other",
    repeat,
    pass: false,
    totalCost: 0.07,
    turns: 6,
    tokens: [900, 100, 300],
  }));
  const runMeta = JSON.parse(await fs.readFile(path.join(runRoot, "run.json"), "utf8"));
  runMeta.plan.order.push(...extraAttempts.map((attempt) => ({
    attempt_id: `${attempt.arm}-${attempt.repeat}`,
    arm: attempt.arm,
    repeat_index: attempt.repeat,
  })));
  await writeJson(path.join(runRoot, "run.json"), runMeta);
  for (const attempt of extraAttempts) {
    const attemptId = `${attempt.arm}-${attempt.repeat}`;
    await writeJson(path.join(runRoot, "attempts", attemptId, "result.json"), {
      schema: "eval-attempt-v1",
      attempt_id: attemptId,
      arm: attempt.arm,
      repeat_index: attempt.repeat,
      status: "ok",
      pass: attempt.pass,
      duration_ms: 1000,
      provider: {
        cost_usd: attempt.totalCost,
        num_turns: attempt.turns,
        usage: {
          fresh_input_tokens: attempt.tokens[0],
          cache_read_tokens: attempt.tokens[1],
          cache_write_tokens: 0,
          output_tokens: attempt.tokens[2],
        },
      },
      grade: { pass: attempt.pass, forbidden_violations: [], checks: [], changed_paths: [] },
    });
  }
  const ambiguous = await buildValueReport(root, { days: 7, now });
  assert.equal(ambiguous.cost_per_passing_task.memory_economics.paired_recalls, 0);
  assert.equal(ambiguous.cost_per_passing_task.memory_economics.eligible_eval_reports, 0);
  assert.equal(ambiguous.cost_per_passing_task.memory_economics.excluded_multi_baseline_reports, 1);
});

test("value CLI writes a self-contained HTML artifact and validates options", async () => {
  const root = await makeRoot("agentify-value-cli-");
  await runCli(["value", "--days", "7", "--format", "html", "--root", root]);
  const html = await fs.readFile(path.join(root, "agentify-value-report.html"), "utf8");
  assert.match(html, /Agentify value/);
  assert.match(html, /no external assets/);

  await assert.rejects(
    () => runCli(["value", "--days", "0", "--root", root]),
    /positive integer/,
  );
  await assert.rejects(
    () => runCli(["value", "--format", "pdf", "--root", root]),
    /text, json, html/,
  );
});
