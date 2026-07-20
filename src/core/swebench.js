// SWE-bench Verified warm/cold adapter (#320).
//
// The external benchmark stays out of Agentify's npm runtime. This module is
// deliberately token-, provider-, Docker-, and Python-free: it validates the
// committed protocol, prints the maximum paid spend before launch, and imports
// finished official-harness artifacts into Agentify's native report schema.

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { EVAL_ATTEMPT_SCHEMA_VERSION, EVAL_RUN_SCHEMA_VERSION, resolveEvalPaths } from "./eval.js";
import { ensureDir, exists, readJson, readText, walkFiles, writeJson } from "./fs.js";
import { VERSION } from "./cli-fast-paths.js";

export const SWEBENCH_MANIFEST_SCHEMA_VERSION = "swebench-warm-v1";
export const SWEBENCH_JOB_SCHEMA_VERSION = "swebench-job-v1";
export const SWEBENCH_ATTEMPT_SCHEMA_VERSION = "swebench-attempt-v1";
export const SWEBENCH_IMPORT_SCHEMA_VERSION = "swebench-import-v1";

const FORBIDDEN_INSTANCE_FIELDS = [
  "patch",
  "test_patch",
  "problem_statement",
  "hints_text",
  "FAIL_TO_PASS",
  "PASS_TO_PASS",
];

const FORBIDDEN_WARMUP_PROMPT_TERMS = [
  "problem_statement",
  "instance_id",
  "test_patch",
  "gold patch",
  "fail_to_pass",
  "pass_to_pass",
  "failing test",
];

export function resolveSwebenchPaths(root, config = {}) {
  const { tasksDir } = resolveEvalPaths(root, config);
  const swebenchRoot = path.join(tasksDir, "swebench");
  return {
    swebenchRoot,
    manifestPath: path.join(swebenchRoot, "dataset.json"),
    warmupPromptPath: path.join(swebenchRoot, "warmup", "instruction.md"),
    runnerPath: path.join(swebenchRoot, "runner.py"),
  };
}

function fail(message) {
  throw new Error(`Invalid SWE-bench dataset: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requirePinned(value, label) {
  const text = requireString(value, label);
  if (/^(latest|main|master|\*|\^|~)$/i.test(text) || !/\d/.test(text)) {
    fail(`${label} must be pinned to an exact version, got "${text}"`);
  }
  return text;
}

function requirePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    fail(`${label} must be a positive number`);
  }
  return number;
}

function requireSha(value, label) {
  const text = requireString(value, label);
  if (!/^[a-f0-9]{40}$/i.test(text)) {
    fail(`${label} must be a full 40-character commit SHA`);
  }
  return text.toLowerCase();
}

export async function loadSwebenchManifest(root, config = {}) {
  const paths = resolveSwebenchPaths(root, config);
  if (!(await exists(paths.manifestPath))) {
    throw new Error(`No SWE-bench manifest at ${path.relative(root, paths.manifestPath)}. See docs/swebench.md.`);
  }
  const raw = await readJson(paths.manifestPath);
  if (raw?.schema !== SWEBENCH_MANIFEST_SCHEMA_VERSION) {
    fail(`manifest schema must be "${SWEBENCH_MANIFEST_SCHEMA_VERSION}", got "${raw?.schema}"`);
  }

  const dataset = {
    name: requireString(raw.dataset?.name, "dataset.name"),
    revision: requireSha(raw.dataset?.revision, "dataset.revision"),
    split: requireString(raw.dataset?.split, "dataset.split"),
  };
  const pins = {
    swebench: requirePinned(raw.pins?.swebench, "pins.swebench"),
    claude_code: requirePinned(raw.pins?.claude_code, "pins.claude_code"),
    agentify: requirePinned(raw.pins?.agentify, "pins.agentify"),
    node: requirePinned(raw.pins?.node, "pins.node"),
  };
  const model = requirePinned(raw.model, "model");
  const limits = {
    scored_max_budget_usd: requirePositive(raw.limits?.scored_max_budget_usd, "limits.scored_max_budget_usd"),
    scored_max_turns: requirePositive(raw.limits?.scored_max_turns, "limits.scored_max_turns"),
    warmup_max_budget_usd: requirePositive(raw.limits?.warmup_max_budget_usd, "limits.warmup_max_budget_usd"),
    warmup_max_turns: requirePositive(raw.limits?.warmup_max_turns, "limits.warmup_max_turns"),
  };

  if (!Array.isArray(raw.instances) || raw.instances.length === 0) {
    fail("instances must contain a bounded committed sample");
  }
  const seenInstances = new Set();
  const instances = raw.instances.map((instance, index) => {
    for (const field of FORBIDDEN_INSTANCE_FIELDS) {
      if (Object.hasOwn(instance || {}, field)) {
        fail(`instances[${index}] must not commit answer-bearing field "${field}"`);
      }
    }
    const instanceId = requireString(instance?.instance_id, `instances[${index}].instance_id`);
    if (!/^[a-z0-9_.-]+__[a-z0-9_.-]+-\d+$/i.test(instanceId)) {
      fail(`instances[${index}].instance_id has an unexpected SWE-bench id shape`);
    }
    if (seenInstances.has(instanceId)) {
      fail(`duplicate instance_id "${instanceId}"`);
    }
    seenInstances.add(instanceId);
    return {
      instance_id: instanceId,
      repo: requireString(instance?.repo, `instances[${index}].repo`),
      base_commit: requireSha(instance?.base_commit, `instances[${index}].base_commit`),
      difficulty: requireString(instance?.difficulty, `instances[${index}].difficulty`),
    };
  });

  const arms = Array.isArray(raw.arms) ? raw.arms.map((arm) => requireString(arm, "arms[]")) : [];
  if (arms.length !== 2 || !arms.includes("agentify") || !arms.includes("claude-code")) {
    fail('arms must be exactly the paired "agentify" and "claude-code" arms');
  }
  if (!raw.suites || typeof raw.suites !== "object" || Array.isArray(raw.suites)) {
    fail("suites must map names to bounded instance lists");
  }
  const suites = {};
  for (const [name, suite] of Object.entries(raw.suites)) {
    const instanceIds = suite?.instances;
    if (!Array.isArray(instanceIds) || instanceIds.length === 0 || instanceIds.some((id) => !seenInstances.has(id))) {
      fail(`suite "${name}" must list known instance ids`);
    }
    if (new Set(instanceIds).size !== instanceIds.length) {
      fail(`suite "${name}" contains duplicate instance ids`);
    }
    const attempts = Number(suite?.attempts ?? 1);
    if (!Number.isInteger(attempts) || attempts <= 0) {
      fail(`suite "${name}" attempts must be a positive integer`);
    }
    suites[name] = { instances: [...instanceIds], attempts };
  }
  if (!suites.smoke) {
    fail('suites must include a bounded "smoke" suite');
  }

  return {
    manifest: {
      schema: raw.schema,
      dataset,
      pins,
      model,
      limits,
      arms,
      instances,
      suites,
    },
    paths,
  };
}

export async function validateSwebenchDataset(root, config = {}) {
  const { manifest, paths } = await loadSwebenchManifest(root, config);
  const problems = [];
  if (!(await exists(paths.runnerPath))) {
    problems.push(`missing ${path.relative(root, paths.runnerPath)}`);
  }
  if (!(await exists(paths.warmupPromptPath))) {
    problems.push(`missing ${path.relative(root, paths.warmupPromptPath)}`);
  } else {
    const prompt = (await readText(paths.warmupPromptPath)).toLowerCase();
    for (const term of FORBIDDEN_WARMUP_PROMPT_TERMS) {
      if (prompt.includes(term)) {
        problems.push(`warm-up prompt contains forbidden instance-specific term "${term}"`);
      }
    }
  }
  return {
    command: "eval",
    action: "swebench-validate",
    ok: problems.length === 0,
    dataset: manifest.dataset,
    model: manifest.model,
    instances: manifest.instances,
    suites: manifest.suites,
    contamination_barrier: {
      committed_answer_fields_forbidden: [...FORBIDDEN_INSTANCE_FIELDS],
      warmup_input_allowlist: ["repo", "base_commit"],
      runtime_receipt_required: true,
    },
    problems,
  };
}

export async function planSwebenchRun(root, config = {}, options = {}) {
  const { manifest } = await loadSwebenchManifest(root, config);
  const suiteName = options.suite || "smoke";
  const suite = manifest.suites[suiteName];
  if (!suite) {
    throw new Error(`Unknown SWE-bench suite "${suiteName}" (known: ${Object.keys(manifest.suites).join(", ")})`);
  }
  const selected = suite.instances.map((id) => manifest.instances.find((instance) => instance.instance_id === id));
  const repos = [...new Set(selected.map((instance) => instance.repo))];
  const scoredTrials = selected.length * manifest.arms.length * suite.attempts;
  const warmupRuns = repos.length;
  const scoredCeiling = scoredTrials * manifest.limits.scored_max_budget_usd;
  const warmupCeiling = warmupRuns * manifest.limits.warmup_max_budget_usd;
  const maxSpend = Number((scoredCeiling + warmupCeiling).toFixed(6));
  const output = `evals/swebench/jobs/job-${suiteName}`;
  return {
    command: "eval",
    action: "swebench-plan",
    suite: suiteName,
    dataset: manifest.dataset,
    model: manifest.model,
    pins: manifest.pins,
    arms: manifest.arms,
    instances: selected,
    repos,
    attempts_per_arm: suite.attempts,
    scored_trials: scoredTrials,
    warmup_runs: warmupRuns,
    scored_ceiling_usd: Number(scoredCeiling.toFixed(6)),
    warmup_ceiling_usd: Number(warmupCeiling.toFixed(6)),
    warmup_ceiling_per_instance_usd: Number((warmupCeiling / selected.length).toFixed(6)),
    max_spend_usd: maxSpend,
    enforcement: "Claude Code caps every scored and warm-up session; the runner requires --yes after this ceiling is printed",
    runner_command: `python3 evals/swebench/runner.py run --suite ${suiteName} --output ${output} --yes`,
    grade_command: `python3 evals/swebench/runner.py grade --job ${output}`,
    import_command: `agentify eval swebench import ${output}`,
    confirmation_required: String(process.env.CI || "").toLowerCase() !== "true",
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function importRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function armLabel(value) {
  const arm = String(value || "").trim().toLowerCase();
  if (arm === "agentify" || arm === "agentify-warm" || arm === "warm") return "agentify";
  if (arm === "claude-code" || arm === "cold" || arm === "baseline") return "claude-code";
  return null;
}

async function readSwebenchAttempts(jobDir) {
  const attemptsDir = path.join(jobDir, "attempts");
  if (!(await exists(attemptsDir))) return [];
  const attempts = [];
  for (const file of await walkFiles(attemptsDir)) {
    if (path.basename(file) !== "result.json") continue;
    const record = await readJson(file).catch(() => null);
    if (record) attempts.push({ ...record, _source: file });
  }
  return attempts;
}

export async function importSwebenchJob(root, config = {}, jobDirInput, options = {}) {
  const jobDir = path.resolve(root, String(jobDirInput || "").trim());
  if (!jobDirInput || !(await exists(jobDir))) {
    throw new Error(`SWE-bench import requires a job directory, got "${jobDirInput}"`);
  }
  const jobPath = path.join(jobDir, "job.json");
  if (!(await exists(jobPath))) {
    throw new Error(`SWE-bench job is missing ${path.relative(root, jobPath)}`);
  }
  const job = await readJson(jobPath);
  if (job?.schema !== SWEBENCH_JOB_SCHEMA_VERSION) {
    throw new Error(`SWE-bench job schema must be "${SWEBENCH_JOB_SCHEMA_VERSION}", got "${job?.schema}"`);
  }
  if (job.status !== "graded") {
    throw new Error(`SWE-bench job must be fully graded before import, got status "${job.status}"`);
  }
  const { manifest: localManifest } = await loadSwebenchManifest(root, config);
  if (job.dataset?.name !== localManifest.dataset.name
    || job.dataset?.revision !== localManifest.dataset.revision
    || job.dataset?.split !== localManifest.dataset.split) {
    throw new Error("SWE-bench job dataset identity does not match the committed manifest");
  }
  const suite = localManifest.suites[job.suite];
  if (!suite) {
    throw new Error(`SWE-bench job names unknown suite "${job.suite}"`);
  }
  if (job.model !== localManifest.model) {
    throw new Error(`SWE-bench job model "${job.model}" does not match committed pin "${localManifest.model}"`);
  }
  for (const [name, pin] of Object.entries(localManifest.pins)) {
    if (job.pins?.[name] !== pin) {
      throw new Error(`SWE-bench job pin ${name} does not match committed value "${pin}"`);
    }
  }
  for (const [name, limit] of Object.entries(localManifest.limits)) {
    if (job.limits?.[name] !== limit) {
      throw new Error(`SWE-bench job limit ${name} does not match committed value "${limit}"`);
    }
  }
  const expectedInstances = new Map(suite.instances.map((id) => {
    const instance = localManifest.instances.find((entry) => entry.instance_id === id);
    return [id, instance];
  }));
  const sample = suite.instances.map((instanceId) => {
    const instance = expectedInstances.get(instanceId);
    return {
      instance_id: instanceId,
      repo: instance.repo,
      base_commit: instance.base_commit,
    };
  });
  const sampleSha256 = createHash("sha256").update(JSON.stringify(sample)).digest("hex");

  const rawAttempts = await readSwebenchAttempts(jobDir);
  const skipped = [];
  const scored = [];
  const seenAttempts = new Set();
  for (const attempt of rawAttempts) {
    const arm = armLabel(attempt.arm);
    const expected = expectedInstances.get(attempt.instance_id);
    const attemptKey = `${arm}:${attempt.instance_id}:${attempt.attempt}`;
    if (attempt.schema !== SWEBENCH_ATTEMPT_SCHEMA_VERSION) {
      skipped.push({ attempt: attempt.instance_id || path.relative(jobDir, attempt._source), reason: "unrecognized attempt schema" });
    } else if (!arm || !attempt.instance_id || !attempt.repo) {
      skipped.push({ attempt: attempt.instance_id || path.relative(jobDir, attempt._source), reason: "missing arm, instance_id, or repo" });
    } else if (!expected || attempt.repo !== expected.repo || attempt.base_commit !== expected.base_commit) {
      skipped.push({ attempt: attempt.instance_id, reason: "instance identity is outside the committed suite or disagrees with its pin" });
    } else if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1 || attempt.attempt > suite.attempts) {
      skipped.push({ attempt: attempt.instance_id, reason: "attempt index is outside the committed suite" });
    } else if (attempt.provider?.exit_code !== 0 || attempt.provider?.timed_out === true) {
      skipped.push({ attempt: attempt.instance_id, reason: "provider execution did not complete successfully" });
    } else if (typeof attempt.score?.resolved !== "boolean") {
      skipped.push({ attempt: attempt.instance_id, reason: "official SWE-bench resolved score is missing" });
    } else if (arm === "agentify" && attempt.contamination?.status !== "passed") {
      skipped.push({ attempt: attempt.instance_id, reason: "warm attempt lacks a passed contamination receipt" });
    } else if (seenAttempts.has(attemptKey)) {
      skipped.push({ attempt: attempt.instance_id, reason: "duplicate scored arm/instance/attempt record" });
    } else {
      seenAttempts.add(attemptKey);
      scored.push({ ...attempt, arm });
    }
  }
  if (scored.length === 0) {
    throw new Error(`No scored SWE-bench attempts found under ${path.relative(root, jobDir)}${skipped.length ? ` (${skipped.length} skipped)` : ""}`);
  }
  const expectedAttemptCount = suite.instances.length * suite.attempts * localManifest.arms.length;
  if (skipped.length > 0 || scored.length !== expectedAttemptCount) {
    const reasons = [...new Set(skipped.map((entry) => entry.reason))];
    throw new Error(
      `SWE-bench job is incomplete: expected ${expectedAttemptCount} scored attempts, found ${scored.length} `
      + `(${skipped.length} invalid${reasons.length ? `: ${reasons.join("; ")}` : ""})`,
    );
  }

  const pairKeys = suite.instances.flatMap((instanceId) => (
    Array.from({ length: suite.attempts }, (_, index) => `${instanceId}::${index + 1}`)
  ));
  const pairIndex = new Map(pairKeys.map((key, index) => [key, index + 1]));
  const warmAttemptsByRepo = new Map();
  for (const instanceId of suite.instances) {
    const repo = expectedInstances.get(instanceId).repo;
    warmAttemptsByRepo.set(repo, (warmAttemptsByRepo.get(repo) ?? 0) + suite.attempts);
  }
  const warmups = new Map((job.warmups || []).map((warmup) => [warmup.repo, warmup]));
  const runId = importRunId(options.now ? new Date(options.now) : new Date());
  const importedAt = (options.now ? new Date(options.now) : new Date()).toISOString();
  const { runsRoot } = resolveEvalPaths(root, config);
  const runDir = path.join(runsRoot, runId);
  await ensureDir(path.join(runDir, "attempts"));
  const order = pairKeys.flatMap((key) => {
    const repeatIndex = pairIndex.get(key);
    return localManifest.arms.map((arm) => ({ attempt_id: `${arm}-${repeatIndex}`, arm, repeat_index: repeatIndex }));
  });
  const records = [];
  const model = String(job.model || localManifest?.model || "unknown");

  for (const attempt of scored.sort((a, b) => `${a.instance_id}:${a.arm}:${a.attempt ?? 1}`.localeCompare(`${b.instance_id}:${b.arm}:${b.attempt ?? 1}`))) {
    const repeatIndex = pairIndex.get(`${attempt.instance_id}::${attempt.attempt ?? 1}`);
    const attemptId = `${attempt.arm}-${repeatIndex}`;
    const warmup = attempt.arm === "agentify" ? warmups.get(attempt.repo) : null;
    const warmupCost = finiteNumber(warmup?.provider?.cost_usd);
    const allocationCount = warmAttemptsByRepo.get(attempt.repo) ?? 0;
    const allocatedWarmupCost = warmupCost !== null && allocationCount > 0 ? warmupCost / allocationCount : null;
    const recallCost = finiteNumber(attempt.provider?.cost_usd);
    // A warmed attempt is fully costed only when both the scored session and
    // its share of the one-time repo warm-up are reported. Missing warm-up
    // spend must withhold cost/resolved, never masquerade as zero.
    const totalCost = recallCost === null || (attempt.arm === "agentify" && allocatedWarmupCost === null)
      ? null
      : Number((recallCost + (allocatedWarmupCost ?? 0)).toFixed(6));
    const pass = attempt.score.resolved;
    const providerExit = Number.isInteger(attempt.provider?.exit_code) ? attempt.provider.exit_code : 0;
    const sourceResult = path.relative(root, attempt._source);
    const record = {
      schema: EVAL_ATTEMPT_SCHEMA_VERSION,
      run_id: runId,
      attempt_id: attemptId,
      arm: attempt.arm,
      base_arm: attempt.arm,
      context_ablation: null,
      repeat_index: repeatIndex,
      task_id: `swebench-${job.suite || "sample"}`,
      difficulty: attempt.difficulty ?? null,
      base_sha: attempt.base_commit ?? null,
      harness: "swebench",
      swebench: {
        job: path.basename(jobDir),
        instance_id: attempt.instance_id,
        repo: attempt.repo,
        dataset: job.dataset,
        harness_version: job.pins?.swebench ?? null,
        resolved: pass,
        source_result: sourceResult,
        contamination: attempt.contamination ?? null,
      },
      agentify_version: VERSION,
      claude_version: job.pins?.claude_code ?? null,
      model,
      effort: null,
      requested_profile: attempt.arm === "agentify" ? "balanced" : null,
      resolved_profile: attempt.arm === "agentify" ? "balanced" : null,
      limits: {
        max_budget_usd: job.limits?.scored_max_budget_usd ?? null,
        max_turns: job.limits?.scored_max_turns ?? null,
        timeout_seconds: null,
      },
      status: providerExit === 0 ? "ok" : "provider_error",
      provider: {
        exit_code: providerExit,
        timed_out: attempt.provider?.timed_out === true,
        duration_ms: finiteNumber(attempt.provider?.duration_ms),
        subtype: attempt.provider?.subtype ?? null,
        num_turns: finiteNumber(attempt.provider?.num_turns),
        turns_to_first_edit: finiteNumber(attempt.provider?.turns_to_first_edit),
        resolved_model: attempt.provider?.resolved_model ?? model,
        cost_usd: totalCost,
        ...(attempt.arm === "agentify" ? {
          multisession: true,
          recall_cost_usd: recallCost,
          seed_cost_usd: allocatedWarmupCost,
          warmup_cost_usd_total: warmupCost,
          warmup_reuse_count: allocationCount,
        } : {}),
        usage: attempt.provider?.usage ?? null,
      },
      grade: {
        pass,
        forbidden_violations: [],
        checks: [{
          command: "python -m swebench.harness.run_evaluation",
          exit_code: pass ? 0 : 1,
          passed: pass,
          timed_out: false,
          output_tail: pass ? "official harness: resolved" : "official harness: unresolved",
        }],
        changed_paths: Array.isArray(attempt.changed_paths) ? attempt.changed_paths : [],
      },
      pass,
      duration_ms: finiteNumber(attempt.duration_ms) ?? finiteNumber(attempt.provider?.duration_ms),
      artifacts: null,
    };
    records.push(record);
  }

  for (const record of records) {
    await ensureDir(path.join(runDir, "attempts", record.attempt_id));
    await writeJson(path.join(runDir, "attempts", record.attempt_id, "result.json"), record);
  }
  const taskId = `swebench-${job.suite || "sample"}`;
  const arms = [...localManifest.arms];
  await writeJson(path.join(runDir, "run.json"), {
    schema: EVAL_RUN_SCHEMA_VERSION,
    ts: job.started_at ?? importedAt,
    run_id: runId,
    harness: "swebench",
    swebench: {
      schema: SWEBENCH_IMPORT_SCHEMA_VERSION,
      job: path.basename(jobDir),
      imported_at: importedAt,
      dataset: job.dataset,
      harness_version: job.pins?.swebench ?? null,
      suite: job.suite ?? null,
      instances: pairKeys.length,
      repos: [...new Set(scored.map((attempt) => attempt.repo))],
      sample,
      sample_sha256: sampleSha256,
      warmups: job.warmups ?? [],
    },
    agentify_version: VERSION,
    claude_version: job.pins?.claude_code ?? null,
    plan: {
      task: {
        id: taskId,
        model,
        difficulty: "mixed",
        category: "repo-intelligence",
        phases: ["warmup", "scored"],
        profile: null,
        max_budget_usd: job.limits?.scored_max_budget_usd ?? null,
        forbidden_paths: [],
      },
      task_path: null,
      // The aggregate has multiple Git bases. Bind comparisons to the exact
      // ordered instance/repo/base tuple set instead of pretending there is a
      // single repository commit.
      base_sha: sampleSha256,
      arms,
      repeat: pairKeys.length,
      max_spend_usd: job.max_spend_usd ?? null,
      order,
    },
  });

  return {
    command: "eval",
    action: "swebench-import",
    job: path.relative(root, jobDir),
    dataset: job.dataset,
    attempts_imported: records.length,
    attempts_skipped: skipped,
    run: {
      run_id: runId,
      task_id: taskId,
      model,
      arms,
      attempts: records.length,
      report_command: `agentify eval report ${runId}`,
    },
  };
}
