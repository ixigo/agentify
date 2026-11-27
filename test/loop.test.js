import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";

import { LOOP_BRIEF_SCHEMA_VERSION } from "../src/core/loop-brief.js";
import {
  applyBriefOverrides,
  buildCommitMessage,
  buildIterationPrompt,
  listLoops,
  loadLoopRun,
  planLoopRun,
  projectMaxSpend,
  runLoop,
  selectWinner,
} from "../src/core/loop.js";
import { buildLoopReport, renderLoopReportHtml, renderLoopReportText } from "../src/core/loop-report.js";

const execFileAsync = promisify(execFile);

// A repo whose only "build" gate is a marker file: the fake agent creates it to
// turn the gate green, which is enough to drive the whole state machine without
// a provider, a browser, or a dollar of spend.
async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-loop-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "loop@agentify.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "agentify-loop"], { cwd: root });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo" }));
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

async function writeBrief(root, overrides = {}) {
  const brief = {
    schema: LOOP_BRIEF_SCHEMA_VERSION,
    id: "demo",
    title: "Add the marker",
    intent: "Create a file named done.txt containing OK.",
    gates: [{ id: "marker", kind: "command", run: "test -f done.txt" }],
    limits: { max_iterations: 4, max_budget_usd: 1, max_turns: 5, timeout_seconds: 60 },
    ship: { commit: true, pr: "none", type: "feat", scope: "packages" },
    ...overrides,
  };
  await fs.mkdir(path.join(root, "loops"), { recursive: true });
  await fs.writeFile(path.join(root, "loops", "demo.yaml"), stringifyYaml(brief));
  return brief;
}

/**
 * A fake agent. `script` decides what each iteration writes; anything it
 * returns is treated as file contents to create in the worktree.
 */
function fakeAgent(script, { cost = 0.05 } = {}) {
  const prompts = [];
  const createDelegate = (worktree) => {
    let iteration = 0;
    return async (kind, prompt) => {
      if (kind === "review") {
        return { status: "ok", provider: "codex", output: "VERDICT: pass — fine", cost_usd: 0.01 };
      }
      iteration += 1;
      prompts.push(prompt);
      const writes = await script(iteration, worktree) || {};
      for (const [file, contents] of Object.entries(writes)) {
        const target = path.join(worktree, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents);
      }
      return { status: "ok", provider: "claude", model: "sonnet", exit_code: 0, cost_usd: cost, output: "done", duration_ms: 1 };
    };
  };
  return { createDelegate, prompts };
}

test("a loop iterates until the gates pass, then commits the branch", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root);
    // Iteration 1 writes the wrong file; iteration 2 writes the right one.
    const agent = fakeAgent((iteration) => (iteration === 1 ? { "other.txt": "nope" } : { "done.txt": "OK" }));

    const result = await runLoop(root, {}, "demo", { createDelegate: agent.createDelegate });

    assert.equal(result.outcome, "passed");
    assert.equal(result.winner, "c1");
    assert.equal(result.candidates[0].iterations, 2);
    assert.equal(result.ship.committed, true);
    assert.equal(result.ship.subject, "feat(packages): Add the marker");

    // The commit must exist on the loop branch and contain the agent's work.
    const { stdout: log } = await execFileAsync("git", ["log", "-1", "--pretty=%s", "loop/demo"], { cwd: root });
    assert.equal(log.trim(), "feat(packages): Add the marker");
    const { stdout: files } = await execFileAsync("git", ["show", "--name-only", "--pretty=", "loop/demo"], { cwd: root });
    assert.match(files, /done\.txt/);

    // The checkout must be untouched: isolation is the whole point. Untracked
    // run artifacts under .agentify/ are excluded (-uno) since a real repo
    // gitignores them.
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain", "-uno"], { cwd: root });
    assert.equal(status.trim(), "", "no tracked file in the checkout may change");
    assert.equal(await fs.stat(path.join(root, "done.txt")).catch(() => null), null,
      "the agent's work must exist only on the loop branch");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the next iteration is told exactly which gate failed and why", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root);
    const agent = fakeAgent((iteration) => (iteration === 1 ? { "other.txt": "nope" } : { "done.txt": "OK" }));
    await runLoop(root, {}, "demo", { createDelegate: agent.createDelegate });

    assert.equal(agent.prompts.length, 2);
    assert.ok(!agent.prompts[0].includes("What failed last iteration"), "the first iteration has no failures to report");
    assert.match(agent.prompts[1], /What failed last iteration/);
    assert.match(agent.prompts[1], /gate "marker" \(command\) fail/);
    // The brief itself must survive into every iteration, not just the first.
    assert.match(agent.prompts[1], /done\.txt containing OK/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("edits to forbidden paths are reverted, reported, and fed back to the agent", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root);
    const agent = fakeAgent((iteration) => (iteration === 1
      ? { ".github/workflows/deploy.yml": "on: push\n", "other.txt": "x" }
      : { "done.txt": "OK" }));

    const result = await runLoop(root, {}, "demo", { createDelegate: agent.createDelegate });
    const view = await loadLoopRun(root, {}, result.run_id);
    const first = view.candidates[0].iterations[0];

    assert.deepEqual(first.violations, [".github/workflows/deploy.yml"]);
    // Reverting rather than only reporting is what keeps the branch clean.
    const { stdout: files } = await execFileAsync("git", ["show", "--name-only", "--pretty=", "loop/demo"], { cwd: root });
    assert.ok(!files.includes(".github"), "a forbidden edit must not survive into the commit");
    assert.match(agent.prompts[1], /have been reverted/);
    assert.match(agent.prompts[1], /\.github\/workflows\/deploy\.yml/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a loop that stops converging stalls instead of burning its whole iteration budget", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root, { limits: { max_iterations: 8, max_budget_usd: 4, max_turns: 5, timeout_seconds: 60 } });
    // Every iteration edits something, and none of it satisfies the gate.
    const agent = fakeAgent((iteration) => ({ [`attempt-${iteration}.txt`]: "still wrong" }));

    const result = await runLoop(root, {}, "demo", { createDelegate: agent.createDelegate });

    assert.equal(result.outcome, "stalled");
    // Two flat iterations after the first ends it: 3 total, not 8.
    assert.equal(result.candidates[0].iterations, 3);
    assert.equal(result.ship.committed, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an agent that changes nothing does not get its gates run", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root, { limits: { max_iterations: 2, max_budget_usd: 1, max_turns: 5, timeout_seconds: 60 } });
    const agent = fakeAgent(() => ({}));

    const result = await runLoop(root, {}, "demo", { createDelegate: agent.createDelegate });
    const view = await loadLoopRun(root, {}, result.run_id);

    assert.equal(view.candidates[0].iterations[0].status, "no_changes");
    assert.equal(view.candidates[0].iterations[0].verdicts.length, 0);
    assert.notEqual(result.outcome, "passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("candidates race on their own branches and the winner is the one that passed", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root, {
      candidates: 2,
      limits: { max_iterations: 1, max_budget_usd: 1, max_turns: 5, timeout_seconds: 60 },
    });
    // c1 fails; c2 succeeds. The winner must be c2 regardless of order.
    const createDelegate = (worktree, candidate) => async (kind) => {
      if (kind === "review") return { status: "ok", output: "VERDICT: pass — fine" };
      if (candidate.candidate_id === "c2") {
        await fs.writeFile(path.join(worktree, "done.txt"), "OK");
      } else {
        await fs.writeFile(path.join(worktree, "wrong.txt"), "no");
      }
      return { status: "ok", provider: "claude", cost_usd: 0.02, output: "done" };
    };

    const result = await runLoop(root, {}, "demo", { createDelegate });

    assert.equal(result.winner, "c2");
    assert.equal(result.outcome, "passed");
    assert.deepEqual(result.candidates.map((entry) => entry.branch), ["loop/demo", "loop/demo-c2"]);
    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%s", "loop/demo-c2"], { cwd: root });
    assert.equal(stdout.trim(), "feat(packages): Add the marker");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("tournament candidates get materially different instructions", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root, { candidates: 3 });
    const plan = await planLoopRun(root, {}, "demo", {});
    const variations = plan.candidates.map((entry) => entry.variation);
    assert.equal(variations[0], null, "the first candidate runs the brief as written");
    assert.equal(new Set(variations.slice(1)).size, 2, "the rest must diverge from each other");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("selectWinner prefers a passing candidate over a higher-scoring failure", () => {
  const winner = selectWinner([
    { candidate_id: "c1", outcome: "stalled", best_score: 0.95, iterations: [1], spend_usd: 0.1 },
    { candidate_id: "c2", outcome: "passed", best_score: 1, iterations: [1, 2, 3], spend_usd: 0.9 },
  ]);
  assert.equal(winner.candidate_id, "c2", "closest-to-done is not done");

  // Among equals, the shorter and cheaper path wins.
  const cheaper = selectWinner([
    { candidate_id: "c1", outcome: "passed", best_score: 1, iterations: [1, 2, 3], spend_usd: 0.9 },
    { candidate_id: "c2", outcome: "passed", best_score: 1, iterations: [1], spend_usd: 0.3 },
  ]);
  assert.equal(cheaper.candidate_id, "c2");

  assert.equal(selectWinner([{ candidate_id: "c1", outcome: "error", iterations: [] }]), null);
});

test("resume reuses finished candidates instead of paying for them twice", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root, {
      candidates: 2,
      limits: { max_iterations: 1, max_budget_usd: 1, max_turns: 5, timeout_seconds: 60 },
    });
    let calls = 0;
    const createDelegate = (worktree) => async (kind) => {
      if (kind === "review") return { status: "ok", output: "VERDICT: pass — fine" };
      calls += 1;
      await fs.writeFile(path.join(worktree, "done.txt"), "OK");
      return { status: "ok", cost_usd: 0.02, output: "done" };
    };

    const first = await runLoop(root, {}, "demo", { createDelegate });
    assert.equal(calls, 2);

    const resumed = await runLoop(root, {}, null, { resume: first.run_id, createDelegate });
    assert.equal(calls, 2, "a completed candidate must not be re-run on resume");
    assert.deepEqual(resumed.reused_candidates, ["c1", "c2"]);
    assert.equal(resumed.resumed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resume rejects a bogus or unknown run id", async () => {
  const root = await makeRepo();
  try {
    await assert.rejects(() => runLoop(root, {}, null, { resume: "../etc/passwd" }), /Invalid loop run id/);
    await assert.rejects(() => runLoop(root, {}, null, { resume: "20260101-000000-abcdef" }), /No loop run found/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the run budget stops the loop even when iterations remain", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root, { limits: { max_iterations: 6, max_budget_usd: 0.5, max_turns: 5, timeout_seconds: 60 } });
    // Each iteration reports a cost that eats a third of the ceiling.
    const agent = fakeAgent((iteration) => ({ [`attempt-${iteration}.txt`]: "x" }), { cost: 0.2 });

    // Strictly improving scores, so stall detection can never be what ends
    // this run — only the budget.
    let score = 0;
    const result = await runLoop(root, {}, "demo", {
      createDelegate: agent.createDelegate,
      runGates: async () => {
        score += 0.1;
        return { verdicts: [], passed: false, score, gates_passed: 0, gates_total: 1 };
      },
    });

    assert.equal(result.outcome, "budget_exhausted");
    assert.ok(result.candidates[0].iterations <= 4, `expected the budget to bite, ran ${result.candidates[0].iterations}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a run with no provider-reported cost says so rather than implying an enforced ceiling", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root, { limits: { max_iterations: 1, max_budget_usd: 1, max_turns: 5, timeout_seconds: 60 } });
    const createDelegate = (worktree) => async (kind) => {
      if (kind === "review") return { status: "ok", output: "VERDICT: pass — fine" };
      await fs.writeFile(path.join(worktree, "done.txt"), "OK");
      return { status: "ok", output: "done" };
    };
    const result = await runLoop(root, {}, "demo", { createDelegate });
    assert.equal(result.cost_unreported, true);
    assert.match(renderLoopReportText(buildLoopReport(await loadLoopRun(root, {}, result.run_id))), /lower bound/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("losing worktrees are cleaned up unless asked for, and the winner's is kept", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root, {
      candidates: 2,
      limits: { max_iterations: 1, max_budget_usd: 1, max_turns: 5, timeout_seconds: 60 },
    });
    const createDelegate = (worktree, candidate) => async (kind) => {
      if (kind === "review") return { status: "ok", output: "VERDICT: pass — fine" };
      if (candidate.candidate_id === "c1") {
        await fs.writeFile(path.join(worktree, "done.txt"), "OK");
      } else {
        await fs.writeFile(path.join(worktree, "no.txt"), "x");
      }
      return { status: "ok", cost_usd: 0.01, output: "done" };
    };

    const result = await runLoop(root, {}, "demo", { createDelegate });
    const winner = result.candidates.find((entry) => entry.candidate_id === result.winner);
    const loser = result.candidates.find((entry) => entry.candidate_id !== result.winner);

    assert.ok(await fs.stat(winner.worktree).catch(() => null), "the winning worktree holds the branch and must survive");
    assert.equal(await fs.stat(loser.worktree).catch(() => null), null);
    // Its diff is still readable from the run directory.
    const view = await loadLoopRun(root, {}, result.run_id);
    assert.ok(view.candidates.some((entry) => entry.candidate_id === loser.candidate_id));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the projected ceiling counts review gates, not just the agent", async () => {
  const brief = {
    gates: [{ id: "a", kind: "command" }, { id: "r", kind: "review" }],
    candidates: 2,
    limits: { max_iterations: 3, iteration_budget_usd: 1 },
  };
  const spend = projectMaxSpend(brief, {});
  assert.equal(spend.review_gates, 1);
  // 2 candidates x 3 iterations x ($1 agent + $0.75 review)
  assert.equal(spend.max_spend_usd, 10.5);

  const noReview = projectMaxSpend({ ...brief, gates: [{ id: "a", kind: "command" }] }, {});
  assert.equal(noReview.max_spend_usd, 6);
});

test("CLI overrides keep the per-iteration cap consistent with the run ceiling", () => {
  const brief = applyBriefOverrides({
    schema: LOOP_BRIEF_SCHEMA_VERSION,
    id: "x",
    intent: "y",
    gates: [{ id: "a", kind: "command", run: "true" }],
    limits: { max_iterations: 4, max_budget_usd: 8, max_turns: 10, timeout_seconds: 60, iteration_budget_usd: 2 },
    ship: {},
    source: {},
  }, { maxIterations: 2 });

  assert.equal(brief.limits.max_iterations, 2);
  assert.equal(brief.limits.iteration_budget_usd, 4, "halving the iterations must not silently halve the ceiling");
});

test("commit messages follow conventional commits and carry the ticket trailer", () => {
  const message = buildCommitMessage({
    title: "Handle failed upi payment",
    intent: "Retry the charge once before showing the error.",
    ship: { type: "fix", scope: "payment", refs: "XCT-10874" },
  });
  assert.equal(message.subject, "fix(payment): Handle failed upi payment");
  assert.match(message.message, /Refs: XCT-10874/);

  const scopeless = buildCommitMessage({ title: "Tidy up", intent: "x", ship: { type: "chore", scope: null, refs: null } });
  assert.equal(scopeless.subject, "chore: Tidy up");
  assert.ok(!scopeless.message.includes("Refs:"));
});

test("the iteration prompt forbids the agent from shipping or touching CI", () => {
  const prompt = buildIterationPrompt({
    intent: "Do a thing.",
    acceptance: ["It works."],
    source: { figma_images: [], figma_url: null },
    forbidden_paths: [".github/workflows/**"],
    gates: [{ id: "build", kind: "command", blocking: true, run: "make" }],
  }, { iteration: 1, variation: null, previousVerdicts: null, violations: [], worktree: "/tmp/wt" });

  assert.match(prompt, /Do not commit, push, or open a pull request/);
  assert.match(prompt, /\.github\/workflows/);
  assert.match(prompt, /Gates that will judge this iteration/);
});

test("a report renders the gate ladder in text and HTML", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root);
    const agent = fakeAgent((iteration) => (iteration === 1 ? { "x.txt": "no" } : { "done.txt": "OK" }));
    const result = await runLoop(root, {}, "demo", { createDelegate: agent.createDelegate });

    const report = buildLoopReport(await loadLoopRun(root, {}, result.run_id));
    assert.equal(report.outcome, "passed");
    assert.equal(report.candidates[0].iterations.length, 2);

    const text = renderLoopReportText(report);
    assert.match(text, /iteration 1: 0\/1 gates/);
    assert.match(text, /PASS marker/);
    assert.match(text, /Ship: committed/);

    const html = renderLoopReportHtml(report);
    assert.match(html, /<!doctype html>/);
    assert.match(html, /Loop report/);
    // Detail text must be escaped, never interpolated raw.
    assert.ok(!html.includes("<script>"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("list surfaces briefs and finished runs", async () => {
  const root = await makeRepo();
  try {
    await writeBrief(root);
    const agent = fakeAgent(() => ({ "done.txt": "OK" }));
    const result = await runLoop(root, {}, "demo", { createDelegate: agent.createDelegate });

    const listing = await listLoops(root, {});
    assert.equal(listing.briefs.length, 1);
    assert.equal(listing.briefs[0].id, "demo");
    assert.equal(listing.runs[0].run_id, result.run_id);
    assert.equal(listing.runs[0].outcome, "passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
