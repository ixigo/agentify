import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createGateContext,
  describeFailures,
  gatesNeedIndex,
  gatesNeedServer,
  normalizeGates,
  parseReviewVerdict,
  runGate,
  runGates,
  scoreGates,
} from "../src/core/loop-gates.js";
import { rectPng } from "./fixtures/png.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentify-loop-gates-"));
}

function context(overrides = {}, { artifactsDir = null } = {}) {
  return createGateContext({
    root: "/repo",
    worktree: "/repo/worktree",
    config: {},
    baseSha: "a".repeat(40),
    artifactsDir,
    env: {},
    intent: "Add a retry banner.",
    delegate: async () => ({ status: "ok", output: "VERDICT: pass — looks right" }),
    overrides: { now: () => 0, ...overrides },
  });
}

test("gate ids must be unique and kinds must be known", () => {
  assert.throws(() => normalizeGates([{ id: "a", run: "x" }, { id: "a", run: "y" }], "t"), /duplicate gate id/);
  assert.throws(() => normalizeGates([{ id: "a", kind: "vibes" }], "t"), /unknown kind/);
  assert.throws(() => normalizeGates([{ id: "a" }], "t"), /run is required/);
});

test("an agentify-tests gate refuses a hand-written command", () => {
  assert.throws(
    () => normalizeGates([{ id: "t", kind: "agentify-tests", run: "npm test" }], "t"),
    /derives its own command from the index/,
  );
});

test("a visual gate must be able to resolve exactly one element against a real reference", () => {
  assert.throws(() => normalizeGates([{ id: "v", kind: "visual", url: "http://x" }], "t"), /at least one reference image/);
  assert.throws(
    () => normalizeGates([{ id: "v", kind: "visual", reference: ["a.png"], url: "http://x" }], "t"),
    /requires test_id or selector/,
  );
  assert.throws(
    () => normalizeGates([{ id: "v", kind: "visual", reference: ["a.png"], url: "http://x", test_id: "y", viewport: "big" }], "t"),
    /viewport must be WIDTHxHEIGHT/,
  );

  const [gate] = normalizeGates([{ id: "v", kind: "visual", reference: "a.png", url: "http://x", test_id: "y" }], "t");
  assert.deepEqual(gate.reference, ["a.png"], "a single reference string should normalize to a list");
  assert.equal(gate.min_score, 0.9);
  assert.equal(gate.needs_server, true);
});

test("server and index requirements are derived from the gate list", () => {
  const gates = normalizeGates([
    { id: "build", run: "make" },
    { id: "tests", kind: "agentify-tests" },
  ], "t");
  assert.equal(gatesNeedServer(gates), false);
  assert.equal(gatesNeedIndex(gates), true);

  const uiGates = normalizeGates([{ id: "e2e", kind: "playwright" }], "t");
  assert.equal(gatesNeedServer(uiGates), true);
  assert.equal(gatesNeedIndex(uiGates), false);
});

test("a command gate really runs a shell command, passing on exit 0 and failing otherwise", async () => {
  // No stubbed runProcess here: this is the one place the actual spawn path,
  // shell handling, and exit-code mapping are exercised end to end.
  const worktree = await tempDir();
  try {
    const [pass] = normalizeGates([{ id: "ok", run: "test -d ." }], "t");
    const [fail] = normalizeGates([{ id: "bad", run: "echo boom >&2; exit 3" }], "t");
    const ctx = createGateContext({
      root: worktree,
      worktree,
      config: {},
      baseSha: "a".repeat(40),
      artifactsDir: null,
      env: process.env,
      intent: "x",
      delegate: async () => ({ status: "ok", output: "" }),
      overrides: { now: () => 0 },
    });

    const passed = await runGate(ctx, pass);
    assert.equal(passed.status, "pass");
    assert.equal(passed.exit_code, 0);

    const failed = await runGate(ctx, fail);
    assert.equal(failed.status, "fail");
    assert.equal(failed.exit_code, 3);
    assert.match(failed.detail, /boom/);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("a gate runner that throws is an error, never a pass", async () => {
  const [gate] = normalizeGates([{ id: "ok", run: "true" }], "t");
  const result = await runGate(context({
    runProcess: async () => { throw new Error("spawn exploded"); },
  }), gate);
  assert.equal(result.status, "error");
  assert.match(result.detail, /spawn exploded/);
});

test("review verdicts parse only from an explicit VERDICT line", () => {
  assert.deepEqual(parseReviewVerdict("VERDICT: pass — fine"), { verdict: "pass", reason: "fine" });
  assert.deepEqual(parseReviewVerdict("blah\nVERDICT: block - null deref at a.js:10\n"), {
    verdict: "block",
    reason: "null deref at a.js:10",
  });
  assert.equal(parseReviewVerdict("VERDICT: pass").reason, null);
  assert.equal(parseReviewVerdict("Looks good to me, ship it."), null);
  assert.equal(parseReviewVerdict(""), null);
});

function reviewContext(reply) {
  return createGateContext({
    root: "/repo",
    worktree: "/repo/worktree",
    config: {},
    baseSha: "b".repeat(40),
    artifactsDir: null,
    env: {},
    intent: "Add a retry banner.",
    delegate: async () => reply,
    overrides: { now: () => 0 },
  });
}

test("a review with no verdict line is an error, not an approval", async () => {
  const [gate] = normalizeGates([{ id: "review", kind: "review" }], "t");

  const approved = await runGate(reviewContext({ status: "ok", output: "VERDICT: pass — fine" }), gate);
  assert.equal(approved.status, "pass");

  // A thoughtful review that forgot the contract is unusable as a gate. Reading
  // it as approval is how a truncated or crashed reviewer waves work through.
  const silent = await runGate(reviewContext({ status: "ok", output: "The change looks correct to me." }), gate);
  assert.equal(silent.status, "error");
  assert.match(silent.detail, /no VERDICT line/);
});

test("a review that blocks fails the gate and carries the reason forward", async () => {
  const [gate] = normalizeGates([{ id: "review", kind: "review" }], "t");
  const result = await runGate(
    reviewContext({ status: "ok", provider: "codex", output: "VERDICT: block — drops the error path in pay.js:42" }),
    gate,
  );
  assert.equal(result.status, "fail");
  assert.match(result.detail, /pay\.js:42/);
  assert.equal(result.provider, "codex");
});

test("a review stopped by its budget is an error, so the loop does not read it as approval", async () => {
  const [gate] = normalizeGates([{ id: "review", kind: "review" }], "t");
  const result = await runGate(
    reviewContext({ status: "budget_stopped", budget_stop_reason: "max_turns", output: "" }),
    gate,
  );
  assert.equal(result.status, "error");
  assert.match(result.detail, /max_turns/);
});

test("a risk gate compares the reported level against its ceiling", async () => {
  const [gate] = normalizeGates([{ id: "risk", kind: "risk", max_level: "medium" }], "t");

  const withinCeiling = await runGate(context({
    buildRiskReport: async () => ({ risk: { level: "medium", score: 40 }, impacted: { modules: [1, 2] } }),
  }), gate);
  assert.equal(withinCeiling.status, "pass");

  const overCeiling = await runGate(context({
    buildRiskReport: async () => ({ risk: { level: "high", score: 82 }, impacted: { modules: [] } }),
  }), gate);
  assert.equal(overCeiling.status, "fail");
  assert.match(overCeiling.detail, /ceiling medium/);
});

test("an affected-tests gate reports a pass when nothing was affected, and says so", async () => {
  const [gate] = normalizeGates([{ id: "tests", kind: "agentify-tests" }], "t");
  const result = await runGate(context({
    runProcess: async () => ({
      code: 0,
      stdout: JSON.stringify({ selected_tests: [], changed_file_count: 2 }),
      stderr: "",
      timedOut: false,
    }),
  }), gate);
  assert.equal(result.status, "pass");
  assert.match(result.detail, /no affected test command/);
});

test("an affected-tests gate that produces no report is an error, not a pass", async () => {
  const [gate] = normalizeGates([{ id: "tests", kind: "agentify-tests" }], "t");
  const result = await runGate(context({
    runProcess: async () => ({ code: 1, stdout: "", stderr: "index missing", timedOut: false }),
  }), gate);
  assert.equal(result.status, "error");
  assert.match(result.detail, /no report/);
});

test("a visual gate refuses to run when the capture helper is not installed in the repo", async () => {
  const [gate] = normalizeGates([{ id: "v", kind: "visual", reference: ["a.png"], url: "http://x", test_id: "y" }], "t");
  const result = await runGate(context({
    resolveCaptureScript: async () => ({ path: "/bundled/capture.mjs", installed: false }),
  }), gate);
  assert.equal(result.status, "error");
  assert.match(result.detail, /agentify skill install ui-screenshot-eval/);
});

test("a visual gate scores the captured element against the closest reference", async () => {
  const artifactsDir = await tempDir();
  try {
    const [gate] = normalizeGates([{
      id: "v",
      kind: "visual",
      reference: ["near.png", "far.png"],
      url: "http://localhost:3000",
      test_id: "banner",
      min_score: 0.8,
    }], "t");

    const rendered = rectPng(100, 100, { x: 10, y: 10, width: 40, height: 20 });
    const near = rectPng(200, 200, { x: 20, y: 20, width: 80, height: 40 });
    const far = rectPng(100, 100, { x: 60, y: 60, width: 40, height: 40 });
    const files = {
      [path.join(artifactsDir, "gates", "v-capture", "element.png")]: rendered,
      "/repo/near.png": near,
      "/repo/far.png": far,
    };

    const result = await runGate(context({
      runProcess: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
      resolveCaptureScript: async () => ({ path: "/repo/.claude/skills/x/capture.mjs", installed: true }),
      readFile: async (target) => {
        if (!files[target]) throw new Error(`unexpected read ${target}`);
        return files[target];
      },
    }, { artifactsDir }), gate);

    assert.equal(result.status, "pass");
    assert.equal(result.comparisons.length, 2);
    // The 2x-scaled same-layout reference should win over the moved one.
    assert.match(result.detail, /near\.png/);
    assert.equal(result.basis, "structural");
  } finally {
    await fs.rm(artifactsDir, { recursive: true, force: true });
  }
});

test("a visual gate fails below its threshold rather than reporting the best of a bad set", async () => {
  const artifactsDir = await tempDir();
  try {
    const [gate] = normalizeGates([{
      id: "v",
      kind: "visual",
      reference: ["ref.png"],
      url: "http://localhost:3000",
      test_id: "banner",
      min_score: 0.95,
    }], "t");
    const files = {
      [path.join(artifactsDir, "gates", "v-capture", "element.png")]: rectPng(80, 80, { x: 0, y: 0, width: 80, height: 40 }),
      "/repo/ref.png": rectPng(80, 80, { x: 0, y: 40, width: 80, height: 40 }),
    };
    const result = await runGate(context({
      runProcess: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
      resolveCaptureScript: async () => ({ path: "/x/capture.mjs", installed: true }),
      readFile: async (target) => files[target],
    }, { artifactsDir }), gate);

    assert.equal(result.status, "fail");
    assert.ok(result.score < 0.95);
  } finally {
    await fs.rm(artifactsDir, { recursive: true, force: true });
  }
});

test("a blocking failure short-circuits the rest of the ladder", async () => {
  const gates = normalizeGates([
    { id: "build", run: "true" },
    { id: "lint", run: "exit 1" },
    { id: "expensive", run: "echo should-not-run" },
  ], "t");

  let ran = 0;
  const ctx = context({
    runProcess: async (command) => {
      ran += 1;
      return { code: command === "exit 1" ? 1 : 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  const result = await runGates(ctx, gates);

  assert.equal(ran, 2, "the gate after a blocking failure must not be executed");
  assert.deepEqual(result.verdicts.map((entry) => entry.status), ["pass", "fail", "skipped"]);
  assert.equal(result.passed, false);
});

test("an advisory failure does not stop the ladder or count against the score", async () => {
  const gates = normalizeGates([
    { id: "flaky", run: "exit 1", blocking: false },
    { id: "build", run: "true" },
  ], "t");
  const result = await runGates(context({
    runProcess: async (command) => ({ code: command === "true" ? 0 : 1, stdout: "", stderr: "", timedOut: false }),
  }), gates);

  assert.equal(result.passed, true, "only blocking gates define done");
  assert.equal(result.score, 1);
  assert.equal(result.gates_total, 1);
});

test("scoring gives partial credit for a scored gate so progress is visible before it passes", () => {
  const partial = scoreGates([
    { id: "build", blocking: true, status: "pass", score: null },
    { id: "visual", blocking: true, status: "fail", score: 0.6 },
  ]);
  assert.equal(partial.score, 0.8);
  assert.equal(partial.passed, false);
  assert.equal(partial.gates_passed, 1);

  const none = scoreGates([]);
  assert.equal(none.passed, false, "an empty ladder is never a pass");
  assert.equal(none.score, 0);
});

test("failure digests name the gate, kind, and reason for the next iteration", () => {
  const digest = describeFailures([
    { id: "build", kind: "command", status: "pass", detail: "exit 0" },
    { id: "lint", kind: "command", status: "fail", detail: "exit 1: 3 problems" },
    { id: "review", kind: "review", status: "error", detail: "no VERDICT line" },
    { id: "e2e", kind: "playwright", status: "skipped", detail: "earlier gate failed" },
  ]);
  assert.match(digest, /gate "lint" \(command\) fail: exit 1: 3 problems/);
  assert.match(digest, /gate "review" \(review\) error/);
  assert.ok(!digest.includes("build"), "passing gates are not failures");
  assert.ok(!digest.includes("e2e"), "skipped gates carry no information for the agent");
});
