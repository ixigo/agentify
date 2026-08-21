import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  MCP_TOOL_DESCRIPTIONS,
  buildMcpTools,
  resolveDescriptionSet,
} from "../src/core/mcp-server.js";
import {
  EVAL_TASK_SCHEMA_VERSION,
  buildEvalArmCommand,
  descriptionAblationLabel,
  expandArmVariants,
  isAgentifyArm,
  resolveMcpPrecondition,
  runEval,
  validateEvalTask,
} from "../src/core/eval.js";

const execFileAsync = promisify(execFile);
const FAKE_MODEL = "claude-haiku-4-5-20251001";
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SUITE_DIR = path.join(REPO_ROOT, "evals", "mcp-descriptions");
const SUITE_TASK_IDS = [
  "query-before-edit",
  "impact-before-done",
  "trivial-edit-no-lookup",
];
const TOOL_NAMES = [
  "ctx_load", "ctx_note", "ctx_match", "query",
  "risk", "test_select", "ctx_decisions", "ctx_handoff",
];

// ---------------------------------------------------------------------------
// Snapshot both description sets so a later edit to mcp-server.js cannot
// silently drift from the text this ablation compares. Set "a" is pinned
// byte-identical to the shipped wording; set "b" is pinned to the trigger text.
// ---------------------------------------------------------------------------

const EXPECTED_SET_A = {
  ctx_load: "Digest of what previous agent sessions did in this repository: session summaries, notes left for future sessions, hot files, recent commands, and commands that failed and were never fixed. Call this at the start of a task to avoid rediscovering known context.",
  ctx_note: "Record a note for future agent sessions working in this repository: gotchas, open threads, or anything worth remembering. Use type \"decision\" for durable technical decisions with rationale (\"chose X over Y because Z\") — decisions are kept queryable so settled questions are not relitigated. Notes are surfaced to later sessions when relevant.",
  ctx_match: "Find context from previous sessions related to a specific task: notes, session summaries, previously-edited files, and past command failures that look relevant. Use before starting work on a described task.",
  query: "Structural queries over the repository index. Kinds: search (full-text over symbols/files), def (find a symbol definition), refs (references to a symbol), callers (callers of a symbol), impacts (files affected if a file changes), owner (module owning a file), deps (module dependencies), changed (indexed files changed since a ref). refs and callers return real call sites with line numbers for TypeScript/JavaScript (extracted from the AST) and fall back to file-level import edges for other languages; each result is labeled with its granularity (\"call-site\" or \"file-import\"). The index is built automatically when missing and answers still come back when it is stale (with an `_agentify_index` freshness note); only an unbuildable index returns an instruction to run `agentify scan`.",
  risk: "Score the blast radius of the current change (or since a git ref): risk level, impacted modules/files/symbols, and prioritized regression test commands. Use before finishing a change.",
  test_select: "Select only the test files affected by the current change (or since a git ref) using the structural index, with ready-to-run commands — instead of running the full suite.",
  ctx_decisions: "Before you propose, endorse, or start implementing a technical direction that may already be settled — an architecture, a library or dependency, a data or file format, a naming or workflow convention — call this first to check whether a prior session already decided it. Previous sessions record durable decisions with rationale (\"chose X over Y because Z\"); read them before suggesting a direction so you do not re-propose or relitigate something already decided and rejected. Pass the topic you are about to weigh in on; omit it to review the decisions already on record. Returns matching decisions with their rationale, or a clear message when none are on record.",
  ctx_handoff: "Call this when you are wrapping up a long or multi-step task, or ending a session with work still in flight, to persist a durable handoff summary before the context is lost. It captures recent activity, decisions on record, hot files, and commands that failed and were not fixed, and writes them to a Markdown file under the context store. Returns the saved path and a preview of the contents so you can point the next session (or a teammate) at the file.",
};

const EXPECTED_SET_B = {
  ctx_load: "When you are starting a task in this repository and have not yet loaded prior context, call this first — before reading files or planning — to avoid rediscovering what earlier sessions already established. Returns a digest of prior session summaries, notes left for future sessions, hot files, recent commands, and commands that failed and were never fixed.",
  ctx_note: "When you hit a gotcha, leave an open thread, or make a durable technical decision that a future session would waste time rediscovering or relitigating, call this to record it before you move on. Use type \"decision\" for a settled choice with rationale (\"chose X over Y because Z\"); use the default note type for everything else. Recorded items are surfaced to later sessions when relevant.",
  ctx_match: "When you are about to start work described by a task or ticket, call this first with that description to pull only the prior-session context that matches it — related notes, session summaries, previously-edited files, and past command failures — before you begin exploring.",
  query: "When you need to locate or reason about code before editing it — where a symbol is defined, who references or calls it, which files a change impacts, which module owns a file, a module's dependencies, or what changed since a ref — call this instead of guessing or grepping by hand. Kinds: search, def, refs, callers, impacts, owner, deps, changed. For TypeScript/JavaScript, refs and callers return real call sites and references with line numbers extracted from the AST; for other languages they fall back to file-level import edges, and every result is labeled with its granularity (\"call-site\" or \"file-import\"). The index is built automatically when missing and stale answers still come back with an `_agentify_index` freshness note, so call it without scanning first; only an unbuildable index asks you to run `agentify scan`.",
  risk: "When you believe a change is complete and are about to declare it done, call this first to score its blast radius before you stop: it returns the risk level, the impacted modules/files/symbols, and the prioritized regression tests to run. Pass a git ref to diff against, or omit it to score the working tree.",
  test_select: "When a change is ready to verify and you are about to run tests, call this first to get only the test files the change actually affects, with ready-to-run commands — so you do not run the whole suite. Pass a git ref to diff against, or omit it to use the working tree.",
  ctx_decisions: "When you are about to propose, endorse, or start implementing a technical direction that may already be settled — an architecture, a library or dependency, a data or file format, a naming or workflow convention — call this first, before you suggest it, to check whether a prior session already decided the question. Pass the topic you are weighing; omit it to review every decision on record. Returns matching decisions with their rationale, or a clear message when none are on record, so you do not re-propose something already decided and rejected.",
  ctx_handoff: "When you are wrapping up a long or multi-step task, or ending a session with work still in flight, call this before the context is lost to persist a durable handoff summary. It captures recent activity, decisions on record, hot files, and commands that failed and were not fixed, writes them to a Markdown file under the context store, and returns the saved path plus a preview so you can point the next session at it.",
};

test("both MCP description sets are snapshotted and cover all eight tools", () => {
  assert.deepEqual(Object.keys(MCP_TOOL_DESCRIPTIONS).sort(), ["a", "b"]);
  // Set A is the shipped default and must stay byte-identical to the base
  // branch text; set B is the pinned trigger-condition wording.
  assert.deepEqual(MCP_TOOL_DESCRIPTIONS.a, EXPECTED_SET_A, "set A drifted from the snapshot (shipped wording)");
  assert.deepEqual(MCP_TOOL_DESCRIPTIONS.b, EXPECTED_SET_B, "set B drifted from the snapshot (trigger wording)");
  // Both sets describe exactly the same eight tools, and every set-B string is
  // a real trigger-condition rewrite (differs from A, non-empty).
  assert.deepEqual(Object.keys(MCP_TOOL_DESCRIPTIONS.a).sort(), [...TOOL_NAMES].sort());
  assert.deepEqual(Object.keys(MCP_TOOL_DESCRIPTIONS.b).sort(), [...TOOL_NAMES].sort());
  for (const name of TOOL_NAMES) {
    assert.ok(MCP_TOOL_DESCRIPTIONS.b[name].trim().length > 0, `${name} set B empty`);
    assert.notEqual(MCP_TOOL_DESCRIPTIONS.b[name], MCP_TOOL_DESCRIPTIONS.a[name], `${name} set B must differ from A`);
  }
});

test("resolveDescriptionSet defaults to a, honors config and env, ignores garbage", () => {
  const saved = process.env.AGENTIFY_MCP_DESCRIPTIONS;
  try {
    delete process.env.AGENTIFY_MCP_DESCRIPTIONS;
    assert.equal(resolveDescriptionSet(), "a");
    assert.equal(resolveDescriptionSet({ mcpDescriptionSet: "b" }), "b");
    // Config wins over env.
    process.env.AGENTIFY_MCP_DESCRIPTIONS = "a";
    assert.equal(resolveDescriptionSet({ mcpDescriptionSet: "b" }), "b");
    // Env used when config absent.
    process.env.AGENTIFY_MCP_DESCRIPTIONS = "b";
    assert.equal(resolveDescriptionSet(), "b");
    // A bad value never throws and falls back to the shipped set.
    process.env.AGENTIFY_MCP_DESCRIPTIONS = "zzz";
    assert.equal(resolveDescriptionSet(), "a");
  } finally {
    if (saved === undefined) delete process.env.AGENTIFY_MCP_DESCRIPTIONS;
    else process.env.AGENTIFY_MCP_DESCRIPTIONS = saved;
  }
});

test("buildMcpTools swaps only descriptions between sets — names and schemas are identical", () => {
  const toolsA = buildMcpTools("/tmp/nowhere", { mcpDescriptionSet: "a" });
  const toolsB = buildMcpTools("/tmp/nowhere", { mcpDescriptionSet: "b" });
  assert.equal(toolsA.length, 8);
  assert.equal(toolsB.length, 8);
  // Default (no config, no env) is the shipped set A.
  const saved = process.env.AGENTIFY_MCP_DESCRIPTIONS;
  try {
    delete process.env.AGENTIFY_MCP_DESCRIPTIONS;
    const toolsDefault = buildMcpTools("/tmp/nowhere", {});
    for (const tool of toolsDefault) {
      assert.equal(tool.description, EXPECTED_SET_A[tool.name], `default description for ${tool.name}`);
    }
  } finally {
    if (saved === undefined) delete process.env.AGENTIFY_MCP_DESCRIPTIONS;
    else process.env.AGENTIFY_MCP_DESCRIPTIONS = saved;
  }
  for (const tool of toolsA) {
    assert.equal(tool.description, EXPECTED_SET_A[tool.name]);
  }
  for (const tool of toolsB) {
    assert.equal(tool.description, EXPECTED_SET_B[tool.name]);
  }
  // Identical tool identity across sets: same names, same input schemas.
  const schemaA = Object.fromEntries(toolsA.map((t) => [t.name, JSON.stringify(t.inputSchema)]));
  const schemaB = Object.fromEntries(toolsB.map((t) => [t.name, JSON.stringify(t.inputSchema)]));
  assert.deepEqual(schemaA, schemaB, "input schemas must not change between description sets");
});

// ---------------------------------------------------------------------------
// eval.js description-ablation mechanism (mirrors the context_ablation tests).
// ---------------------------------------------------------------------------

function baseAblationTask(overrides = {}) {
  return {
    schema: EVAL_TASK_SCHEMA_VERSION,
    id: "sample",
    prompt: "rename the helper and update every place that uses it",
    base_ref: "HEAD",
    model: FAKE_MODEL,
    max_budget_usd: 0.25,
    max_turns: 6,
    timeout_seconds: 60,
    grader: { commands: ["test -f solution.txt"] },
    arms: ["agentify", "plain-safe"],
    mcp_tools: true,
    description_ablations: ["a", "b"],
    ...overrides,
  };
}

test("description_ablations validate, label, expand, and gate on mcp_tools", () => {
  const task = validateEvalTask(baseAblationTask(), "t");
  assert.deepEqual(task.description_ablations, ["a", "b"]);
  assert.equal(task.mcp_tools, true);
  // Round-trips through re-validation (as stored in run.json).
  assert.deepEqual(validateEvalTask(task, "run.json").description_ablations, ["a", "b"]);

  // Labels: set a keeps the pairing-baseline name; set b gets its own bucket.
  assert.equal(descriptionAblationLabel("a"), "agentify");
  assert.equal(descriptionAblationLabel("b"), "agentify-desc-b");
  assert.ok(isAgentifyArm("agentify-desc-b") && isAgentifyArm("agentify") && !isAgentifyArm("plain-safe"));

  // Only the agentify arm expands; the baseline stays a single variant.
  const variants = expandArmVariants(task, ["agentify", "plain-safe"]);
  assert.deepEqual(variants.map((v) => v.arm), ["agentify", "agentify-desc-b", "plain-safe"]);
  assert.deepEqual(variants.map((v) => v.description_set), ["a", "b", null]);
  assert.ok(variants.every((v) => v.base_arm === (v.arm === "plain-safe" ? "plain-safe" : "agentify")));

  // A default task carries neither field.
  const plain = validateEvalTask({ ...baseAblationTask(), mcp_tools: undefined, description_ablations: undefined }, "t");
  assert.equal(plain.description_ablations, null);
  assert.equal(plain.mcp_tools, false);
});

test("mcp_tools arms stream events and load+pre-approve the server headlessly; baseline does not", () => {
  const task = validateEvalTask(baseAblationTask(), "t");
  const agentify = buildEvalArmCommand("agentify", task);
  const plainSafe = buildEvalArmCommand("plain-safe", task);
  // Agentify arm: streams events (for telemetry) and wires the server in for a
  // headless run without the interactive project-approval prompt.
  assert.ok(agentify.includes("stream-json") && agentify.includes("--verbose"));
  assert.ok(agentify.includes("--mcp-config") && agentify.includes(".mcp.json"));
  assert.ok(agentify.includes("--strict-mcp-config"));
  const allowIdx = agentify.indexOf("--allowedTools");
  assert.ok(allowIdx >= 0 && agentify[allowIdx + 1] === "mcp__agentify");
  // The no-tools floor never loads the server and is not pre-approved for it.
  assert.ok(plainSafe.includes("--safe-mode"));
  assert.ok(!plainSafe.includes("--mcp-config") && !plainSafe.includes("--allowedTools"));
  // A non-mcp task keeps the compact envelope format and no MCP flags.
  const plainTask = validateEvalTask({ ...baseAblationTask(), mcp_tools: undefined, description_ablations: undefined }, "t");
  const plainArgv = buildEvalArmCommand("agentify", plainTask);
  assert.ok(plainArgv.includes("json") && !plainArgv.includes("stream-json"));
  assert.ok(!plainArgv.includes("--mcp-config"));
});

test("description_ablations reject bad shapes and confounded combinations", () => {
  assert.throws(() => validateEvalTask(baseAblationTask({ description_ablations: [] }), "t"), /non-empty/);
  assert.throws(() => validateEvalTask(baseAblationTask({ description_ablations: ["a"] }), "t"), /both "a".*and "b"/);
  assert.throws(() => validateEvalTask(baseAblationTask({ description_ablations: ["a", "c"] }), "t"), /must be one of/);
  assert.throws(() => validateEvalTask(baseAblationTask({ description_ablations: ["a", "b", "b"] }), "t"), /duplicate/);
  // Descriptions are unobservable without a registered server.
  assert.throws(() => validateEvalTask(baseAblationTask({ mcp_tools: false }), "t"), /require mcp_tools/);
  assert.throws(() => validateEvalTask(baseAblationTask({ mcp_tools: "yes" }), "t"), /mcp_tools must be a boolean/);
  // Context and description ablations cannot be combined (would confound arms).
  assert.throws(
    () => validateEvalTask(baseAblationTask({ context_ablations: ["relevant", "digest"] }), "t"),
    /cannot be combined/,
  );
});

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("resolveMcpPrecondition handshakes the real server and verifies the description switch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-mcp-pre-"));
  try {
    // No .mcp.json → not registered, invalid run (never a zero-call result).
    const absent = await resolveMcpPrecondition(dir, "a");
    assert.equal(absent.registered, false);
    assert.equal(absent.available, false);
    assert.equal(absent.tool_count, 0);
    assert.equal(absent.alias, "agentify");

    // An entry whose args do not launch the server is not a registration.
    await fs.writeFile(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { agentify: { command: process.execPath, args: ["--version"] } } }),
    );
    assert.equal((await resolveMcpPrecondition(dir, "a")).registered, false);

    // Registered against the Agentify under test → the precondition actually
    // launches it, sees eight tools, and confirms the set toggles the text.
    await fs.writeFile(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { agentify: { command: process.execPath, args: [CLI_PATH, "serve"] } } }),
    );
    const ok = await resolveMcpPrecondition(dir, "b", {
      ...process.env,
      XDG_CACHE_HOME: path.join(dir, "global-cache"),
    });
    assert.equal(ok.registered, true);
    assert.equal(ok.tool_count, 8);
    assert.equal(ok.description_switch_supported, true);
    assert.equal(ok.available, true);
    assert.equal(ok.description_set, "b");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Committed suite: every task validates, is shaped for the ablation, and its
// instruction leaks no tool name (consistent with Harbor's answer_leak_patterns).
// ---------------------------------------------------------------------------

// Tool names must never appear in an instruction: naming a tool (or the CLI
// subcommand behind it) would tell the agent to call it, defeating the point of
// measuring whether the description alone triggers the call.
const TOOL_NAME_LEAK_PATTERNS = [
  /\bctx_load\b/i, /\bctx_note\b/i, /\bctx_match\b/i, /\bctx_decisions\b/i,
  /\bctx_handoff\b/i, /\btest_select\b/i, /\bquery\b/i, /\brisk\b/i,
  /mcp__agentify/i, /\bagentify\s+(serve|scan|query|risk|ctx|test)\b/i,
];

function toolNameLeaks(text) {
  return TOOL_NAME_LEAK_PATTERNS.filter((pattern) => pattern.test(String(text || "")));
}

test("the leak detector catches a planted tool-name leak (guards the check itself)", () => {
  assert.ok(toolNameLeaks("first run agentify risk to check the change").length > 0);
  assert.ok(toolNameLeaks("call the ctx_decisions tool before deciding").length > 0);
  assert.equal(toolNameLeaks("rename the helper and update every place that uses it").length, 0);
});

test("every committed suite task validates, is ablation-shaped, and leaks no tool name", async () => {
  const entries = (await fs.readdir(SUITE_DIR)).filter((name) => /\.ya?ml$/i.test(name)).sort();
  assert.deepEqual(entries.map((f) => f.replace(/\.ya?ml$/i, "")).sort(), [...SUITE_TASK_IDS].sort());

  let overTriggerControls = 0;
  for (const file of entries) {
    const raw = parseYaml(await fs.readFile(path.join(SUITE_DIR, file), "utf8"));
    const task = validateEvalTask(raw, file);
    assert.equal(task.mcp_tools, true, `${file}: mcp_tools`);
    assert.deepEqual(task.description_ablations, ["a", "b"], `${file}: paired sets`);
    assert.ok(task.arms.includes("agentify") && task.arms.includes("plain-safe"), `${file}: arms`);
    // Expands into the paired A/B arms plus the no-tools floor.
    assert.deepEqual(
      expandArmVariants(task, task.arms).map((v) => v.arm),
      ["agentify", "agentify-desc-b", "plain-safe"],
      `${file}: arm expansion`,
    );
    // The instruction must not name a tool or the CLI subcommand behind it.
    const leaks = toolNameLeaks(task.prompt);
    assert.equal(leaks.length, 0, `${file}: instruction leaks tool name(s): ${leaks.map((r) => r.source).join(", ")}`);
    if (task.id === "trivial-edit-no-lookup") overTriggerControls += 1;
  }
  // The set is weighted toward calling-is-correct situations but must include at
  // least one over-trigger control so the report can flag over-calling too.
  assert.ok(overTriggerControls >= 1, "suite must include an over-triggering control task");
});

// ---------------------------------------------------------------------------
// End-to-end (fake provider): the paired run registers the server per arm,
// pins the description set per arm, and asserts availability before spending.
// ---------------------------------------------------------------------------

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-desc-eval-"));
  const run = (args) => execFileAsync("git", args, { cwd: dir });
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "eval@test.local"]);
  await run(["config", "user.name", "Eval Test"]);
  await fs.writeFile(path.join(dir, "README.md"), "# Fixture repo\n");
  await run(["add", "-A"]);
  await run(["commit", "-qm", "init"]);
  return dir;
}

async function makeFakeClaude() {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-desc-bin-"));
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi',
    'printf "%s" "${AGENTIFY_MCP_DESCRIPTIONS:-unset}" > desc-set.txt',
    "echo done > solution.txt",
    "cat <<'EOF'",
    JSON.stringify({
      type: "result", subtype: "success", result: "done",
      total_cost_usd: 0.01, num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 1 },
      modelUsage: { [FAKE_MODEL]: {} },
    }),
    "EOF",
  ].join("\n");
  await fs.writeFile(path.join(binDir, "claude"), `${script}\n`, { mode: 0o755 });
  return { binDir, env: { PATH: `${binDir}:${process.env.PATH}` } };
}

test("paired run registers the server per agentify arm and pins the description set", async () => {
  const dir = await makeRepo();
  const fake = await makeFakeClaude();
  try {
    const tasksDir = path.join(dir, "evals");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, "sample.yaml"),
      stringifyYaml(baseAblationTask({ forbidden_paths: [".claude/**", "CLAUDE.md"] })),
    );

    const result = await runEval(dir, {}, "sample", {
      env: fake.env,
      runtime: { commandExists: async () => true },
      keepWorkspaces: true,
    });

    assert.deepEqual([...result.arms].sort(), ["agentify", "agentify-desc-b", "plain-safe"]);
    const runDir = path.join(dir, result.artifacts_root);
    const byArm = {};
    for (const attempt of result.attempts) {
      byArm[attempt.arm] = JSON.parse(
        await fs.readFile(path.join(runDir, "attempts", attempt.attempt_id, "result.json"), "utf8"),
      );
    }

    for (const [arm, set] of [["agentify", "a"], ["agentify-desc-b", "b"]]) {
      const record = byArm[arm];
      const workspace = path.join(runDir, "attempts", record.attempt_id, "workspace");
      // The server is registered under the canonical alias, pointing at the
      // Agentify under test (not whatever is on PATH).
      const mcpConfig = JSON.parse(await fs.readFile(path.join(workspace, ".mcp.json"), "utf8"));
      assert.equal(mcpConfig.mcpServers.agentify.command, process.execPath, `${arm}: server command`);
      assert.ok(mcpConfig.mcpServers.agentify.args.includes("serve"), `${arm}: server args`);
      // Availability was asserted as a precondition before spending, by
      // launching the real server and confirming the switch works.
      assert.equal(record.mcp_precondition.available, true, `${arm}: precondition`);
      assert.equal(record.mcp_precondition.registered, true);
      assert.equal(record.mcp_precondition.tool_count, 8);
      assert.equal(record.mcp_precondition.description_switch_supported, true);
      assert.equal(record.description_set, set, `${arm}: recorded set`);
      // The spawned provider actually saw the pinned set (not a leaked value).
      assert.equal(await fs.readFile(path.join(workspace, "desc-set.txt"), "utf8"), set, `${arm}: env pin`);
      // The full event stream is persisted for #331 telemetry attribution.
      assert.ok(record.artifacts.provider_stream, `${arm}: stream artifact`);
      await fs.access(path.join(workspace, "..", "provider-stream.jsonl"));
      assert.equal(record.pass, true);
    }

    // The no-tools floor: no server registered, no description set, and the
    // provider saw no pinned value.
    const plain = byArm["plain-safe"];
    const plainWs = path.join(runDir, "attempts", plain.attempt_id, "workspace");
    assert.equal(await fs.access(path.join(plainWs, ".mcp.json")).then(() => true, () => false), false);
    assert.equal(plain.description_set, null);
    assert.equal(plain.mcp_precondition, undefined);
    assert.equal(await fs.readFile(path.join(plainWs, "desc-set.txt"), "utf8"), "unset");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake.binDir, { recursive: true, force: true });
  }
});

test("dry-run surfaces the MCP registration contract and per-arm description sets", async () => {
  const dir = await makeRepo();
  const fake = await makeFakeClaude();
  try {
    const tasksDir = path.join(dir, "evals");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "sample.yaml"), stringifyYaml(baseAblationTask()));
    const plan = await runEval(dir, {}, "sample", {
      dryRun: true,
      env: fake.env,
      runtime: { commandExists: async () => true },
    });
    assert.equal(plan.dry_run, true);
    assert.equal(plan.mcp_tools, true);
    assert.deepEqual(plan.mcp_registration, { alias: "agentify", command: "agentify", args: ["serve"] });
    assert.ok(Array.isArray(plan.preconditions) && /invalid/.test(plan.preconditions[0]));
    assert.deepEqual(plan.description_ablations, ["a", "b"]);
    const sets = plan.attempts.map((a) => a.description_set).sort();
    assert.deepEqual(sets, ["a", "b", null].sort());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake.binDir, { recursive: true, force: true });
  }
});
