import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";

import {
  DEFAULT_EVAL_ARMS,
  EVAL_TASK_SCHEMA_VERSION,
  buildEvalArmCommand,
  initEvalTask,
  listEvals,
  loadEvalTask,
  matchesForbiddenPath,
  planEvalRun,
  runEval,
  validateEvalTask,
} from "../src/core/eval.js";
import { MANAGED_BLOCK_BEGIN, buildManagedBlock, buildManagedHooks } from "../src/core/integrations.js";
import { readDelegationRecords } from "../src/core/stats.js";

const execFileAsync = promisify(execFile);

const FAKE_MODEL = "claude-haiku-4-5-20251001";

function baseTask(overrides = {}) {
  return {
    schema: EVAL_TASK_SCHEMA_VERSION,
    id: "sample",
    prompt: "create solution.txt containing done",
    base_ref: "HEAD",
    model: FAKE_MODEL,
    max_budget_usd: 0.25,
    max_turns: 6,
    timeout_seconds: 60,
    grader: { commands: ["test -f solution.txt"] },
    ...overrides,
  };
}

async function makeRepo({ withIntegration = true, gitignore = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-eval-"));
  const run = (args) => execFileAsync("git", args, { cwd: dir });
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "eval@test.local"]);
  await run(["config", "user.name", "Eval Test"]);
  await fs.writeFile(path.join(dir, "README.md"), "# Fixture repo\n");
  if (gitignore) {
    await fs.writeFile(path.join(dir, ".gitignore"), gitignore);
  }
  if (withIntegration) {
    // Committed project guidance: an Agentify managed block plus unrelated
    // project notes the plain-project arm must preserve.
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      `# Project notes\n\nAlways use tabs.\n\n${buildManagedBlock("claude")}\n`,
    );
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".claude", "settings.json"),
      `${JSON.stringify({ hooks: buildManagedHooks() }, null, 2)}\n`,
    );
  }
  await run(["add", "-A"]);
  await run(["commit", "-qm", "init"]);
  const { stdout } = await run(["rev-parse", "HEAD"]);
  return { dir, headSha: stdout.trim() };
}

// A fake `claude` CLI: logs every invocation (cwd, AGENTIFY_CTX, argv),
// creates the file the grader looks for, and prints a valid result envelope.
async function makeFakeClaude(behavior = "") {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-fakebin-"));
  const logPath = path.join(binDir, "invocations.log");
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi',
    '{ echo "cwd=$(pwd)|ctx=${AGENTIFY_CTX:-unset}|args=$*"; } >> "$FAKE_CLAUDE_LOG"',
    behavior || 'echo done > solution.txt',
    "cat <<'EOF'",
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.01,
      num_turns: 2,
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
      modelUsage: { [FAKE_MODEL]: {} },
    }),
    "EOF",
  ].join("\n");
  await fs.writeFile(path.join(binDir, "claude"), `${script}\n`, { mode: 0o755 });
  return {
    binDir,
    logPath,
    env: { PATH: `${binDir}:${process.env.PATH}`, FAKE_CLAUDE_LOG: logPath },
    async invocations() {
      try {
        return (await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean).map((line) => {
          const [cwd, ctx, args] = line.split("|");
          return {
            cwd: cwd.replace("cwd=", ""),
            ctx: ctx.replace("ctx=", ""),
            args: args.replace("args=", ""),
          };
        });
      } catch {
        return [];
      }
    },
  };
}

async function writeTask(dir, task) {
  const tasksDir = path.join(dir, "evals");
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(path.join(tasksDir, `${task.id}.yaml`), stringifyYaml(task));
}

const runtime = { commandExists: async () => true };

test("validateEvalTask enforces schema, full model IDs, ceilings, and paired arms", () => {
  const task = validateEvalTask(baseTask(), "t");
  assert.equal(task.repeat, 1);
  assert.deepEqual(task.arms, DEFAULT_EVAL_ARMS);
  assert.equal(task.profile, "balanced");
  assert.equal(task.seed_context, true);

  assert.throws(() => validateEvalTask(baseTask({ schema: "eval-task-v0" }), "t"), /schema/);
  assert.throws(() => validateEvalTask(baseTask({ prompt: " " }), "t"), /prompt/);
  // A floating alias is not a valid paired-experiment model.
  assert.throws(() => validateEvalTask(baseTask({ model: "haiku" }), "t"), /full versioned Claude model ID/);
  assert.throws(() => validateEvalTask(baseTask({ max_budget_usd: 0 }), "t"), /max_budget_usd/);
  assert.throws(() => validateEvalTask(baseTask({ max_budget_usd: true }), "t"), /max_budget_usd/);
  assert.throws(() => validateEvalTask(baseTask({ max_turns: 2.5 }), "t"), /max_turns/);
  assert.throws(() => validateEvalTask(baseTask({ grader: { commands: [] } }), "t"), /grader\.commands/);
  assert.throws(() => validateEvalTask(baseTask({ arms: ["agentify"] }), "t"), /at least two/);
  assert.throws(() => validateEvalTask(baseTask({ arms: ["agentify", "bogus"] }), "t"), /unknown arm/);
});

test("matchesForbiddenPath supports ** and * globs", () => {
  assert.equal(matchesForbiddenPath(".agentify/context/notes.jsonl", [".agentify/**"]).length, 1);
  assert.equal(matchesForbiddenPath("CLAUDE.md", ["**/CLAUDE.md"]).length, 1);
  assert.equal(matchesForbiddenPath("docs/sub/CLAUDE.md", ["**/CLAUDE.md"]).length, 1);
  assert.equal(matchesForbiddenPath("src/a.js", ["src/*.js"]).length, 1);
  assert.equal(matchesForbiddenPath("src/nested/a.js", ["src/*.js"]).length, 0);
  assert.equal(matchesForbiddenPath("srcx/a.js", ["src/**"]).length, 0);
});

test("buildEvalArmCommand pins model and limits; only plain-safe gets --safe-mode", () => {
  const task = validateEvalTask(baseTask({ effort: "low" }), "t");
  const agentify = buildEvalArmCommand("agentify", task);
  const plainSafe = buildEvalArmCommand("plain-safe", task);
  const plainProject = buildEvalArmCommand("plain-project", task);

  for (const argv of [agentify, plainSafe, plainProject]) {
    assert.equal(argv[0], "claude");
    assert.ok(argv.includes("--model") && argv.includes(FAKE_MODEL));
    assert.ok(argv.includes("--max-budget-usd") && argv.includes("0.25"));
    assert.ok(argv.includes("--max-turns") && argv.includes("6"));
    assert.ok(argv.includes("--no-session-persistence"));
    assert.ok(argv.includes("--effort") && argv.includes("low"));
  }
  assert.ok(plainSafe.includes("--safe-mode"));
  assert.ok(!agentify.includes("--safe-mode"));
  assert.ok(!plainProject.includes("--safe-mode"));
});

test("initEvalTask writes a valid manifest pinned to the current commit", async () => {
  const { dir, headSha } = await makeRepo({ withIntegration: false });
  try {
    const result = await initEvalTask(dir, "demo", {});
    assert.equal(result.task.base_ref, headSha);
    const { task } = await loadEvalTask(dir, "demo", {});
    assert.equal(task.id, "demo");
    assert.equal(task.base_ref, headSha);
    await assert.rejects(initEvalTask(dir, "demo", {}), /already exists/);
    await assert.rejects(loadEvalTask(dir, "missing", {}), /No eval task found/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("dry-run prints the full plan and maximum spend without any provider call", async () => {
  const { dir, headSha } = await makeRepo();
  const fake = await makeFakeClaude();
  try {
    await writeTask(dir, baseTask({ arms: ["agentify", "plain-safe", "plain-project"] }));
    const result = await runEval(dir, {}, "sample", {
      dryRun: true,
      repeat: 2,
      env: fake.env,
      runtime,
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.base_sha, headSha);
    assert.equal(result.attempts.length, 6);
    // arms × repeats × per-run cap.
    assert.equal(result.max_spend_usd, 1.5);
    assert.ok(result.attempts.every((attempt) => attempt.argv[0] === "claude"));
    assert.equal((await fake.invocations()).length, 0);
    // Nothing is written for a dry-run.
    assert.equal(await fs.access(path.join(dir, ".agentify", "evals")).then(() => true, () => false), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake.binDir, { recursive: true, force: true });
  }
});

test("paired run isolates workspaces, wires arms correctly, and grades deterministically", async () => {
  const { dir } = await makeRepo();
  const fake = await makeFakeClaude();
  try {
    // Seeded context for the agentify arm.
    await fs.mkdir(path.join(dir, ".agentify", "context"), { recursive: true });
    await fs.writeFile(path.join(dir, ".agentify", "context", "notes.jsonl"), `${JSON.stringify({ ts: "2026-01-01", text: "seed note" })}\n`);

    await writeTask(dir, baseTask({
      arms: ["agentify", "plain-safe", "plain-project"],
      forbidden_paths: [".agentify/**"],
    }));
    const result = await runEval(dir, {}, "sample", {
      repeat: 2,
      env: fake.env,
      runtime,
      keepWorkspaces: true,
    });

    assert.equal(result.attempts.length, 6);
    assert.equal(result.executed_attempts, 6);
    for (const [arm, bucket] of Object.entries(result.summary.by_arm)) {
      assert.equal(bucket.attempts, 2, `${arm} attempts`);
      assert.equal(bucket.passes, 2, `${arm} passes`);
      assert.equal(bucket.cost_usd, 0.02, `${arm} cost`);
      assert.equal(bucket.cost_per_pass_usd, 0.01, `${arm} cost per pass`);
    }

    const invocations = await fake.invocations();
    assert.equal(invocations.length, 6);
    // Every attempt ran in its own disposable clone — never the checkout.
    const cwds = new Set(invocations.map((entry) => entry.cwd));
    assert.equal(cwds.size, 6);
    assert.ok([...cwds].every((cwd) => !path.resolve(cwd).startsWith(path.join(dir, "README")) && path.resolve(cwd) !== path.resolve(dir)));

    const runDir = path.join(dir, result.artifacts_root);
    for (const attempt of result.attempts) {
      const record = JSON.parse(await fs.readFile(path.join(runDir, "attempts", attempt.attempt_id, "result.json"), "utf8"));
      const invocation = invocations.find((entry) => entry.cwd.includes(`${path.sep}${attempt.attempt_id}${path.sep}`));
      assert.ok(invocation, `invocation for ${attempt.attempt_id}`);
      const workspace = path.join(runDir, "attempts", attempt.attempt_id, "workspace");

      if (attempt.arm === "agentify") {
        // Context hooks live: AGENTIFY_CTX not disabled, managed hooks
        // installed, context store seeded.
        assert.equal(invocation.ctx, "unset");
        const settings = await fs.readFile(path.join(workspace, ".claude", "settings.json"), "utf8");
        assert.match(settings, /agentify ctx load --hook/);
        const seeded = await fs.readFile(path.join(workspace, ".agentify", "context", "notes.jsonl"), "utf8");
        assert.match(seeded, /seed note/);
        assert.ok(!invocation.args.includes("--safe-mode"));
      } else {
        // Baseline arms provably receive no Agentify context.
        assert.equal(invocation.ctx, "off");
      }
      if (attempt.arm === "plain-safe") {
        assert.ok(invocation.args.includes("--safe-mode"));
      }
      if (attempt.arm === "plain-project") {
        const memory = await fs.readFile(path.join(workspace, "CLAUDE.md"), "utf8");
        assert.ok(!memory.includes(MANAGED_BLOCK_BEGIN), "managed block removed");
        assert.match(memory, /Always use tabs/, "unrelated guidance preserved");
        const settings = JSON.parse(await fs.readFile(path.join(workspace, ".claude", "settings.json"), "utf8"));
        assert.ok(!JSON.stringify(settings).includes("agentify ctx"), "managed hooks stripped");
        assert.ok(!invocation.args.includes("--safe-mode"));
      }

      // Deterministic grade: provider exit 0 alone is not success — the
      // grader command decided, and only provider changes are in the patch.
      assert.equal(record.pass, true);
      assert.equal(record.grade.checks[0].passed, true);
      assert.deepEqual(record.grade.forbidden_violations, []);
      assert.deepEqual(record.grade.changed_paths, ["solution.txt"]);
      const patch = await fs.readFile(path.join(runDir, "attempts", attempt.attempt_id, "patch.diff"), "utf8");
      assert.match(patch, /solution\.txt/);
      assert.equal(record.provider.cost_usd, 0.01);
      assert.equal(record.requested_profile, "balanced");
      assert.equal(record.resolved_profile, "balanced");
    }

    // Eval spend is recorded and counts toward rolling caps.
    const delegations = (await readDelegationRecords(dir)).filter((record) => record.kind === "eval");
    assert.equal(delegations.length, 6);
    assert.ok(delegations.every((record) => record.cost_usd === 0.01 && record.model === FAKE_MODEL));

    const listing = await listEvals(dir, {});
    assert.equal(listing.tasks.length, 1);
    assert.equal(listing.runs.length, 1);
    assert.equal(listing.runs[0].attempts_completed, 6);
    assert.equal(listing.runs[0].claude_version, "9.9.9 (fake)");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake.binDir, { recursive: true, force: true });
  }
});

test("failing grader and forbidden-path edits fail the attempt despite provider exit 0", async () => {
  const { dir } = await makeRepo();
  // The fake edits a forbidden file and never creates what the grader wants.
  const fake = await makeFakeClaude('echo sneaky >> README.md');
  try {
    await writeTask(dir, baseTask({
      arms: ["agentify", "plain-safe"],
      forbidden_paths: ["README.md"],
    }));
    const result = await runEval(dir, {}, "sample", { env: fake.env, runtime });
    for (const attempt of result.attempts) {
      assert.equal(attempt.status, "ok", "provider itself succeeded");
      assert.equal(attempt.pass, false, "deterministic grade failed anyway");
    }
    const runDir = path.join(dir, result.artifacts_root);
    const record = JSON.parse(await fs.readFile(path.join(runDir, "attempts", result.attempts[0].attempt_id, "result.json"), "utf8"));
    assert.equal(record.grade.forbidden_violations.length, 1);
    assert.equal(record.grade.forbidden_violations[0].path, "README.md");
    assert.equal(record.grade.checks[0].passed, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake.binDir, { recursive: true, force: true });
  }
});

test("forbidden-path edits are caught even when .gitignore hides them", async () => {
  const { dir } = await makeRepo({ gitignore: ".agentify/\n" });
  // The fake writes into an ignored, forbidden directory and also does the
  // legitimate task.
  const fake = await makeFakeClaude('mkdir -p .agentify/context && echo poisoned > .agentify/context/evil.txt && echo done > solution.txt');
  try {
    await writeTask(dir, baseTask({
      arms: ["agentify", "plain-safe"],
      forbidden_paths: [".agentify/**"],
    }));
    const result = await runEval(dir, {}, "sample", { env: fake.env, runtime });
    for (const attempt of result.attempts) {
      assert.equal(attempt.pass, false, `${attempt.attempt_id} must fail on the ignored forbidden edit`);
    }
    const runDir = path.join(dir, result.artifacts_root);
    const record = JSON.parse(await fs.readFile(path.join(runDir, "attempts", result.attempts[0].attempt_id, "result.json"), "utf8"));
    assert.deepEqual(record.grade.forbidden_violations.map((violation) => violation.path), [".agentify/context/evil.txt"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake.binDir, { recursive: true, force: true });
  }
});

test("interrupted runs resume only the missing attempts", async () => {
  const { dir } = await makeRepo();
  const fake = await makeFakeClaude();
  try {
    await writeTask(dir, baseTask({ arms: ["agentify", "plain-safe"] }));
    const first = await runEval(dir, {}, "sample", { repeat: 2, env: fake.env, runtime });
    assert.equal(first.executed_attempts, 4);

    // Simulate an interrupted attempt and resume.
    const runDir = path.join(dir, first.artifacts_root);
    const lostAttempt = first.attempts[2].attempt_id;
    await fs.rm(path.join(runDir, "attempts", lostAttempt, "result.json"));
    await fs.rm(fake.logPath, { force: true });

    const resumed = await runEval(dir, {}, "sample", { resume: first.run_id, env: fake.env, runtime });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.executed_attempts, 1);
    assert.equal(resumed.attempts.length, 4);
    assert.equal((await fake.invocations()).length, 1);
    assert.ok((await fake.invocations())[0].cwd.includes(lostAttempt));

    // Resume ids are strict single path components — no traversal, no lookup
    // of arbitrary names.
    await assert.rejects(runEval(dir, {}, "sample", { resume: "nope", env: fake.env, runtime }), /Invalid eval run id/);
    await assert.rejects(runEval(dir, {}, "sample", { resume: "../../escape", env: fake.env, runtime }), /Invalid eval run id/);
    await assert.rejects(
      runEval(dir, {}, "sample", { resume: first.run_id.replace(/.$/, (c) => (c === "0" ? "1" : "0")), env: fake.env, runtime }),
      /No eval run found to resume/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake.binDir, { recursive: true, force: true });
  }
});

test("rolling budget headroom blocks the run before any provider call", async () => {
  const { dir } = await makeRepo();
  const fake = await makeFakeClaude();
  try {
    await writeTask(dir, baseTask({ arms: ["agentify", "plain-safe"] }));
    // Max spend 2 × $0.25 = $0.50 exceeds the daily cap of $0.10.
    const blockConfig = { models: { budget: { dailyUsd: 0.10, onLimit: "block" } } };
    await assert.rejects(
      runEval(dir, blockConfig, "sample", { env: fake.env, runtime }),
      /eval blocked before any provider call/,
    );
    assert.equal((await fake.invocations()).length, 0);

    const warnConfig = { models: { budget: { dailyUsd: 0.10, onLimit: "warn" } } };
    const result = await runEval(dir, warnConfig, "sample", { env: fake.env, runtime });
    assert.match(result.budget_warning, /exceeds the remaining models\.budget headroom/);
    assert.equal(result.attempts.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake.binDir, { recursive: true, force: true });
  }
});

test("planEvalRun honors CLI arm and repeat overrides", async () => {
  const { dir, headSha } = await makeRepo({ withIntegration: false });
  try {
    await writeTask(dir, baseTask({ arms: ["agentify", "plain-safe", "plain-project"] }));
    const plan = await planEvalRun(dir, {}, "sample", { arms: "agentify,plain-safe", repeat: 3 });
    assert.equal(plan.base_sha, headSha);
    assert.deepEqual(plan.arms, ["agentify", "plain-safe"]);
    assert.equal(plan.attempts.length, 6);
    await assert.rejects(planEvalRun(dir, {}, "sample", { arms: "agentify" }), /at least two/);
    await assert.rejects(planEvalRun(dir, {}, "sample", { repeat: 0 }), /--repeat/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
