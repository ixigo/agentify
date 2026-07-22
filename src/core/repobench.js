// RepoBench repo-context adapter (#321).
//
// The external benchmark stays out of Agentify's npm runtime. This module is
// deliberately token-, provider-, and Python-free: it validates the committed
// protocol, prints the maximum paid spend before launch, and imports finished
// runner artifacts (paired line completions plus the token-free retrieval
// summary) into Agentify's native report schema.

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { EVAL_ATTEMPT_SCHEMA_VERSION, EVAL_RUN_SCHEMA_VERSION, resolveEvalPaths } from "./eval.js";
import { ensureDir, exists, readJson, readText, walkFiles, writeJson } from "./fs.js";
import { VERSION } from "./cli-fast-paths.js";

export const REPOBENCH_MANIFEST_SCHEMA_VERSION = "repobench-context-v1";
export const REPOBENCH_JOB_SCHEMA_VERSION = "repobench-job-v1";
export const REPOBENCH_ATTEMPT_SCHEMA_VERSION = "repobench-attempt-v1";
export const REPOBENCH_RETRIEVAL_SCHEMA_VERSION = "repobench-retrieval-v1";
export const REPOBENCH_IMPORT_SCHEMA_VERSION = "repobench-import-v1";

// Committed tasks may pin identity and hash receipts only. The answer line,
// the gold label, and every promptable row payload live exclusively in the
// pinned upstream dataset.
const FORBIDDEN_TASK_FIELDS = [
  "next_line",
  "gold_path",
  "gold_snippet",
  "gold_snippet_index",
  "context",
  "all_code",
  "cropped_code",
  "import_statement",
  "snippet",
];

const REQUIRED_VERIFICATION_RECEIPTS = [
  "all_code_sha256",
  "cropped_code_sha256",
  "import_statement_sha256",
  "next_line_sha256",
  "gold_path_sha256",
  "gold_snippet_sha256",
];

// The static completion instruction may splice only these dataset fields.
const PROMPT_PLACEHOLDER_ALLOWLIST = ["file_path", "import_statement", "context_block", "code"];

export function resolveRepobenchPaths(root, config = {}) {
  const { tasksDir } = resolveEvalPaths(root, config);
  const repobenchRoot = path.join(tasksDir, "repobench");
  return {
    repobenchRoot,
    manifestPath: path.join(repobenchRoot, "dataset.json"),
    promptPath: path.join(repobenchRoot, "prompts", "completion.md"),
    runnerPath: path.join(repobenchRoot, "runner.py"),
  };
}

function fail(message) {
  throw new Error(`Invalid RepoBench dataset: ${message}`);
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

function requireSha256(value, label) {
  const text = requireString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(text)) {
    fail(`${label} must be a sha256 hex digest`);
  }
  return text.toLowerCase();
}

export async function loadRepobenchManifest(root, config = {}) {
  const paths = resolveRepobenchPaths(root, config);
  if (!(await exists(paths.manifestPath))) {
    throw new Error(`No RepoBench manifest at ${path.relative(root, paths.manifestPath)}. See docs/repobench.md.`);
  }
  const raw = await readJson(paths.manifestPath);
  if (raw?.schema !== REPOBENCH_MANIFEST_SCHEMA_VERSION) {
    fail(`manifest schema must be "${REPOBENCH_MANIFEST_SCHEMA_VERSION}", got "${raw?.schema}"`);
  }

  const dataset = {
    name: requireString(raw.dataset?.name, "dataset.name"),
    revision: requireSha(raw.dataset?.revision, "dataset.revision"),
    split: requireString(raw.dataset?.split, "dataset.split"),
  };
  const pins = {
    claude_code: requirePinned(raw.pins?.claude_code, "pins.claude_code"),
    agentify: requirePinned(raw.pins?.agentify, "pins.agentify"),
    node: requirePinned(raw.pins?.node, "pins.node"),
  };
  const model = requirePinned(raw.model, "model");
  const limits = {
    completion_max_budget_usd: requirePositive(raw.limits?.completion_max_budget_usd, "limits.completion_max_budget_usd"),
    completion_max_turns: requirePositive(raw.limits?.completion_max_turns, "limits.completion_max_turns"),
    context_snippets: requirePositive(raw.limits?.context_snippets, "limits.context_snippets"),
    context_max_chars: requirePositive(raw.limits?.context_max_chars, "limits.context_max_chars"),
  };
  const selectionRule = requireString(raw.selection_rule, "selection_rule");

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    fail("tasks must contain a bounded committed sample");
  }
  const seenTasks = new Set();
  const seenRepos = new Set();
  const tasks = raw.tasks.map((task, index) => {
    for (const field of FORBIDDEN_TASK_FIELDS) {
      if (Object.hasOwn(task || {}, field)) {
        fail(`tasks[${index}] must not commit answer-bearing field "${field}"`);
      }
    }
    const taskId = requireString(task?.task_id, `tasks[${index}].task_id`);
    const rowIndex = Number(task?.row_index);
    if (!Number.isInteger(rowIndex) || rowIndex < 0) {
      fail(`tasks[${index}].row_index must be a non-negative integer`);
    }
    if (taskId !== `${dataset.split}/${rowIndex}`) {
      fail(`tasks[${index}].task_id must be "<split>/<row_index>", got "${taskId}"`);
    }
    if (seenTasks.has(taskId)) {
      fail(`duplicate task_id "${taskId}"`);
    }
    seenTasks.add(taskId);
    const repo = requireString(task?.repo, `tasks[${index}].repo`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      fail(`tasks[${index}].repo must be an owner/name GitHub slug`);
    }
    // The selection rule promises one task per repository; a duplicate repo
    // would let one repository's index quality dominate the sample.
    if (seenRepos.has(repo)) {
      fail(`duplicate repository "${repo}" violates the committed selection rule`);
    }
    seenRepos.add(repo);
    const verification = {};
    for (const receipt of REQUIRED_VERIFICATION_RECEIPTS) {
      verification[receipt] = requireSha256(task?.verification?.[receipt], `tasks[${index}].verification.${receipt}`);
    }
    const extraReceipts = Object.keys(task?.verification || {}).filter((key) => !REQUIRED_VERIFICATION_RECEIPTS.includes(key));
    if (extraReceipts.length > 0) {
      fail(`tasks[${index}].verification has unexpected receipt(s): ${extraReceipts.join(", ")}`);
    }
    return {
      task_id: taskId,
      row_index: rowIndex,
      repo,
      commit: requireSha(task?.commit, `tasks[${index}].commit`),
      file_path: requireString(task?.file_path, `tasks[${index}].file_path`),
      level: requireString(task?.level, `tasks[${index}].level`),
      verification,
    };
  });

  const arms = Array.isArray(raw.arms) ? raw.arms.map((arm) => requireString(arm, "arms[]")) : [];
  if (arms.length !== 2 || !arms.includes("agentify") || !arms.includes("claude-code")) {
    fail('arms must be exactly the paired "agentify" and "claude-code" arms');
  }
  if (!raw.suites || typeof raw.suites !== "object" || Array.isArray(raw.suites)) {
    fail("suites must map names to bounded task lists");
  }
  const suites = {};
  for (const [name, suite] of Object.entries(raw.suites)) {
    const taskIds = suite?.tasks;
    if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some((id) => !seenTasks.has(id))) {
      fail(`suite "${name}" must list known task ids`);
    }
    if (new Set(taskIds).size !== taskIds.length) {
      fail(`suite "${name}" contains duplicate task ids`);
    }
    const attempts = Number(suite?.attempts ?? 1);
    if (!Number.isInteger(attempts) || attempts <= 0) {
      fail(`suite "${name}" attempts must be a positive integer`);
    }
    suites[name] = { tasks: [...taskIds], attempts };
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
      selection_rule: selectionRule,
      tasks,
      suites,
    },
    paths,
  };
}

export async function validateRepobenchDataset(root, config = {}) {
  const { manifest, paths } = await loadRepobenchManifest(root, config);
  const problems = [];
  if (!(await exists(paths.runnerPath))) {
    problems.push(`missing ${path.relative(root, paths.runnerPath)}`);
  }
  if (!(await exists(paths.promptPath))) {
    problems.push(`missing ${path.relative(root, paths.promptPath)}`);
  } else {
    const template = await readText(paths.promptPath);
    const placeholders = [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))];
    for (const placeholder of placeholders) {
      if (!PROMPT_PLACEHOLDER_ALLOWLIST.includes(placeholder)) {
        problems.push(`completion prompt splices non-allowlisted field "{${placeholder}}"`);
      }
    }
    // Missing placeholders silently degrade the experiment: without
    // {context_block} the arms are identical, without {code} the task has no
    // completion input.
    for (const placeholder of PROMPT_PLACEHOLDER_ALLOWLIST) {
      if (!placeholders.includes(placeholder)) {
        problems.push(`completion prompt is missing required placeholder "{${placeholder}}"`);
      }
    }
  }
  return {
    command: "eval",
    action: "repobench-validate",
    ok: problems.length === 0,
    dataset: manifest.dataset,
    model: manifest.model,
    selection_rule: manifest.selection_rule,
    tasks: manifest.tasks,
    suites: manifest.suites,
    answer_isolation: {
      committed_answer_fields_forbidden: [...FORBIDDEN_TASK_FIELDS],
      consumed_fields_hash_pinned: [...REQUIRED_VERIFICATION_RECEIPTS],
      prompt_placeholder_allowlist: [...PROMPT_PLACEHOLDER_ALLOWLIST],
      query_inputs: ["import_statement"],
    },
    problems,
  };
}

export async function planRepobenchRun(root, config = {}, options = {}) {
  const { manifest } = await loadRepobenchManifest(root, config);
  const suiteName = options.suite || "smoke";
  const suite = manifest.suites[suiteName];
  if (!suite) {
    throw new Error(`Unknown RepoBench suite "${suiteName}" (known: ${Object.keys(manifest.suites).join(", ")})`);
  }
  const selected = suite.tasks.map((id) => manifest.tasks.find((task) => task.task_id === id));
  const repos = [...new Set(selected.map((task) => task.repo))];
  const completionTrials = selected.length * manifest.arms.length * suite.attempts;
  const maxSpend = Number((completionTrials * manifest.limits.completion_max_budget_usd).toFixed(6));
  const output = `evals/repobench/jobs/job-${suiteName}`;
  return {
    command: "eval",
    action: "repobench-plan",
    suite: suiteName,
    dataset: manifest.dataset,
    model: manifest.model,
    pins: manifest.pins,
    arms: manifest.arms,
    tasks: selected,
    repos,
    attempts_per_arm: suite.attempts,
    completion_trials: completionTrials,
    retrieval_cost_usd: 0,
    max_spend_usd: maxSpend,
    enforcement: "Claude Code caps every completion session; the runner requires --yes after this ceiling is printed. Retrieval scoring never calls a provider.",
    retrieval_command: `python3 evals/repobench/runner.py retrieval --suite ${suiteName} --output ${output}`,
    runner_command: `python3 evals/repobench/runner.py run --suite ${suiteName} --output ${output} --yes`,
    import_command: `agentify eval repobench import ${output}`,
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
  if (arm === "agentify") return "agentify";
  if (arm === "claude-code" || arm === "baseline") return "claude-code";
  return null;
}

function taskSlug(taskId) {
  return String(taskId).replace(/\//g, "-");
}

async function readRepobenchAttempts(jobDir) {
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

// The retrieval summary is the benchmark's central evidence for the index; a
// job without a valid one must not import as complete, and a copied summary
// from another job must not pass as evidence for this one. Identity fields
// and the per-task receipts are all bound to the committed suite.
async function requireRetrievalSummary(jobDir, root, job, suiteTasks, localManifest) {
  const summaryPath = path.join(jobDir, "retrieval", "summary.json");
  if (!(await exists(summaryPath))) {
    throw new Error(`RepoBench job is missing its retrieval summary at ${path.relative(root, summaryPath)}`);
  }
  const summary = await readJson(summaryPath).catch(() => null);
  if (summary?.schema !== REPOBENCH_RETRIEVAL_SCHEMA_VERSION) {
    throw new Error(`RepoBench retrieval summary schema must be "${REPOBENCH_RETRIEVAL_SCHEMA_VERSION}", got "${summary?.schema}"`);
  }
  if (summary.suite !== job.suite) {
    throw new Error(`RepoBench retrieval summary names suite "${summary.suite}", expected "${job.suite}"`);
  }
  if (summary.dataset?.name !== localManifest.dataset.name
    || summary.dataset?.revision !== localManifest.dataset.revision
    || summary.dataset?.split !== localManifest.dataset.split) {
    throw new Error("RepoBench retrieval summary dataset identity does not match the committed manifest");
  }
  if (summary.agentify !== localManifest.pins.agentify) {
    throw new Error(`RepoBench retrieval summary was produced by agentify "${summary.agentify}", expected pinned "${localManifest.pins.agentify}"`);
  }
  if (summary.tasks !== suiteTasks.length) {
    throw new Error(`RepoBench retrieval summary covers ${summary.tasks} task(s), expected ${suiteTasks.length}`);
  }
  const receipts = new Map();
  for (const task of suiteTasks) {
    const receiptPath = path.join(jobDir, "retrieval", "tasks", `${taskSlug(task.task_id)}.json`);
    const receipt = (await exists(receiptPath)) ? await readJson(receiptPath).catch(() => null) : null;
    const goldRankValid = receipt?.gold_rank === null || (Number.isInteger(receipt?.gold_rank) && receipt.gold_rank >= 1);
    if (receipt?.schema !== REPOBENCH_RETRIEVAL_SCHEMA_VERSION
      || receipt.task_id !== task.task_id
      || receipt.repo !== task.repo
      || receipt.commit !== task.commit
      || typeof receipt.def_hit !== "boolean"
      || typeof receipt.snippet_hit !== "boolean"
      || typeof receipt.ref_edge_hit !== "boolean"
      || typeof receipt.impact_hit !== "boolean"
      || !goldRankValid
      || receipt.def_hit !== (receipt.gold_rank !== null)
      || !Number.isInteger(receipt.candidate_count) || receipt.candidate_count < 0) {
      throw new Error(`RepoBench retrieval receipt for ${task.task_id} is missing or disagrees with the committed pin`);
    }
    receipts.set(task.task_id, receipt);
  }
  // Aggregates are recomputed from the per-task receipts: a summary claiming
  // rates its own receipts do not support is fabricated evidence.
  const all = [...receipts.values()];
  const rate = (predicate) => Number((all.filter(predicate).length / all.length).toFixed(4));
  const recomputed = {
    def_hit_rate: rate((receipt) => receipt.def_hit),
    hit_at_1: rate((receipt) => receipt.gold_rank === 1),
    hit_at_5: rate((receipt) => receipt.gold_rank !== null && receipt.gold_rank <= 5),
    snippet_hit_rate: rate((receipt) => receipt.snippet_hit),
    ref_edge_hit_rate: rate((receipt) => receipt.ref_edge_hit),
    impact_hit_rate: rate((receipt) => receipt.impact_hit),
    mrr: Number((all.reduce((sum, receipt) => sum + (receipt.gold_rank ? 1 / receipt.gold_rank : 0), 0) / all.length).toFixed(4)),
    macro_precision: Number((all.reduce((sum, receipt) => (
      sum + (receipt.def_hit && receipt.candidate_count > 0 ? 1 / receipt.candidate_count : 0)
    ), 0) / all.length).toFixed(4)),
  };
  for (const [metric, value] of Object.entries(recomputed)) {
    const claimed = summary[metric];
    if (typeof claimed !== "number" || !Number.isFinite(claimed) || Math.abs(claimed - value) > 0.001) {
      throw new Error(`RepoBench retrieval summary metric ${metric} is "${claimed}" but its own receipts recompute to ${value}`);
    }
  }
  return { summary, receipts };
}

export async function importRepobenchJob(root, config = {}, jobDirInput, options = {}) {
  const jobDir = path.resolve(root, String(jobDirInput || "").trim());
  if (!jobDirInput || !(await exists(jobDir))) {
    throw new Error(`RepoBench import requires a job directory, got "${jobDirInput}"`);
  }
  const jobPath = path.join(jobDir, "job.json");
  if (!(await exists(jobPath))) {
    throw new Error(`RepoBench job is missing ${path.relative(root, jobPath)}`);
  }
  const job = await readJson(jobPath);
  if (job?.schema !== REPOBENCH_JOB_SCHEMA_VERSION) {
    throw new Error(`RepoBench job schema must be "${REPOBENCH_JOB_SCHEMA_VERSION}", got "${job?.schema}"`);
  }
  if (job.status !== "graded") {
    throw new Error(`RepoBench job must be fully scored before import, got status "${job.status}"`);
  }
  const { manifest: localManifest } = await loadRepobenchManifest(root, config);
  if (job.dataset?.name !== localManifest.dataset.name
    || job.dataset?.revision !== localManifest.dataset.revision
    || job.dataset?.split !== localManifest.dataset.split) {
    throw new Error("RepoBench job dataset identity does not match the committed manifest");
  }
  const suite = localManifest.suites[job.suite];
  if (!suite) {
    throw new Error(`RepoBench job names unknown suite "${job.suite}"`);
  }
  if (job.model !== localManifest.model) {
    throw new Error(`RepoBench job model "${job.model}" does not match committed pin "${localManifest.model}"`);
  }
  for (const [name, pin] of Object.entries(localManifest.pins)) {
    if (job.pins?.[name] !== pin) {
      throw new Error(`RepoBench job pin ${name} does not match committed value "${pin}"`);
    }
  }
  for (const [name, limit] of Object.entries(localManifest.limits)) {
    if (job.limits?.[name] !== limit) {
      throw new Error(`RepoBench job limit ${name} does not match committed value "${limit}"`);
    }
  }

  const expectedTasks = new Map(suite.tasks.map((id) => {
    const task = localManifest.tasks.find((entry) => entry.task_id === id);
    return [id, task];
  }));
  const sample = suite.tasks.map((taskId) => {
    const task = expectedTasks.get(taskId);
    return {
      task_id: taskId,
      repo: task.repo,
      commit: task.commit,
      file_path: task.file_path,
    };
  });
  const sampleSha256 = createHash("sha256").update(JSON.stringify(sample)).digest("hex");
  const { summary: retrievalSummary, receipts: retrievalReceipts } = await requireRetrievalSummary(
    jobDir, root, job, suite.tasks.map((id) => expectedTasks.get(id)), localManifest,
  );

  const rawAttempts = await readRepobenchAttempts(jobDir);
  const skipped = [];
  const scored = [];
  const seenAttempts = new Set();
  for (const attempt of rawAttempts) {
    const arm = armLabel(attempt.arm);
    const expected = expectedTasks.get(attempt.task_id);
    const attemptKey = `${arm}:${attempt.task_id}:${attempt.attempt}`;
    if (attempt.schema !== REPOBENCH_ATTEMPT_SCHEMA_VERSION) {
      skipped.push({ attempt: attempt.task_id || path.relative(jobDir, attempt._source), reason: "unrecognized attempt schema" });
    } else if (!arm || !attempt.task_id || !attempt.repo) {
      skipped.push({ attempt: attempt.task_id || path.relative(jobDir, attempt._source), reason: "missing arm, task_id, or repo" });
    } else if (!expected || attempt.repo !== expected.repo || attempt.commit !== expected.commit) {
      skipped.push({ attempt: attempt.task_id, reason: "task identity is outside the committed suite or disagrees with its pin" });
    } else if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1 || attempt.attempt > suite.attempts) {
      skipped.push({ attempt: attempt.task_id, reason: "attempt index is outside the committed suite" });
    } else if (expected && attempt.file_path !== expected.file_path) {
      skipped.push({ attempt: attempt.task_id, reason: "attempt file path disagrees with the committed pin" });
    } else if (attempt.model !== job.model) {
      skipped.push({ attempt: attempt.task_id, reason: "attempt model disagrees with the job pin" });
    } else if (attempt.provider?.exit_code !== 0 || attempt.provider?.timed_out === true) {
      skipped.push({ attempt: attempt.task_id, reason: "provider execution did not complete successfully" });
    } else if (attempt.provider?.tool_calls !== 0) {
      skipped.push({ attempt: attempt.task_id, reason: "completion session was not verifiably tool-free" });
    } else if (typeof attempt.score?.exact_match !== "boolean"
      || finiteNumber(attempt.score?.edit_similarity) === null
      || attempt.score.edit_similarity < 0 || attempt.score.edit_similarity > 100
      || finiteNumber(attempt.score?.identifier_f1) === null
      || attempt.score.identifier_f1 < 0 || attempt.score.identifier_f1 > 1) {
      skipped.push({ attempt: attempt.task_id, reason: "completion score is missing or out of range" });
    } else if (typeof attempt.context?.answer_in_context !== "boolean") {
      skipped.push({ attempt: attempt.task_id, reason: "attempt lacks its answer-in-context receipt" });
    } else if (arm === "claude-code"
      && (attempt.context.snippets !== 0 || attempt.context.chars !== 0 || (attempt.context.files || []).length !== 0)) {
      // The paired claim is "the only difference is index-supplied context";
      // a baseline that received context is a different experiment.
      skipped.push({ attempt: attempt.task_id, reason: "baseline attempt received cross-file context" });
    } else if (arm === "agentify" && (
      !Number.isInteger(attempt.context.snippets) || attempt.context.snippets < 0
      || attempt.context.snippets > (job.limits?.context_snippets ?? 0)
      || !Number.isInteger(attempt.context.chars) || attempt.context.chars < 0
      || attempt.context.chars > (job.limits?.context_max_chars ?? 0)
      || !Array.isArray(attempt.context.files)
      || typeof attempt.context.gold_in_context !== "boolean")) {
      skipped.push({ attempt: attempt.task_id, reason: "agentify context exceeds the declared bounds or lacks receipts" });
    } else if (arm === "agentify" && (!attempt.retrieval || typeof attempt.retrieval.def_hit !== "boolean")) {
      skipped.push({ attempt: attempt.task_id, reason: "agentify attempt lacks its retrieval receipt" });
    } else if (arm === "agentify" && (() => {
      const receipt = retrievalReceipts.get(attempt.task_id);
      return !receipt
        || attempt.retrieval.def_hit !== receipt.def_hit
        || attempt.retrieval.gold_rank !== receipt.gold_rank
        || attempt.retrieval.ref_edge_hit !== receipt.ref_edge_hit
        || attempt.retrieval.impact_hit !== receipt.impact_hit;
    })()) {
      skipped.push({ attempt: attempt.task_id, reason: "attempt retrieval data disagrees with the job's retrieval receipt" });
    } else if (seenAttempts.has(attemptKey)) {
      skipped.push({ attempt: attempt.task_id, reason: "duplicate scored arm/task/attempt record" });
    } else {
      seenAttempts.add(attemptKey);
      scored.push({ ...attempt, arm });
    }
  }
  if (scored.length === 0) {
    throw new Error(`No scored RepoBench attempts found under ${path.relative(root, jobDir)}${skipped.length ? ` (${skipped.length} skipped)` : ""}`);
  }
  const expectedAttemptCount = suite.tasks.length * suite.attempts * localManifest.arms.length;
  if (skipped.length > 0 || scored.length !== expectedAttemptCount) {
    const reasons = [...new Set(skipped.map((entry) => entry.reason))];
    throw new Error(
      `RepoBench job is incomplete: expected ${expectedAttemptCount} scored attempts, found ${scored.length} `
      + `(${skipped.length} invalid${reasons.length ? `: ${reasons.join("; ")}` : ""})`,
    );
  }

  const pairKeys = suite.tasks.flatMap((taskId) => (
    Array.from({ length: suite.attempts }, (_, index) => `${taskId}::${index + 1}`)
  ));
  const pairIndex = new Map(pairKeys.map((key, index) => [key, index + 1]));
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

  for (const attempt of scored.sort((a, b) => `${a.task_id}:${a.arm}:${a.attempt ?? 1}`.localeCompare(`${b.task_id}:${b.arm}:${b.attempt ?? 1}`))) {
    const repeatIndex = pairIndex.get(`${attempt.task_id}::${attempt.attempt ?? 1}`);
    const attemptId = `${attempt.arm}-${repeatIndex}`;
    const pass = attempt.score.exact_match;
    const sourceResult = path.relative(root, attempt._source);
    const record = {
      schema: EVAL_ATTEMPT_SCHEMA_VERSION,
      run_id: runId,
      attempt_id: attemptId,
      arm: attempt.arm,
      base_arm: attempt.arm,
      context_ablation: null,
      repeat_index: repeatIndex,
      task_id: `repobench-${job.suite || "sample"}`,
      difficulty: attempt.level ?? null,
      base_sha: attempt.commit ?? null,
      harness: "repobench",
      repobench: {
        job: path.basename(jobDir),
        task_id: attempt.task_id,
        repo: attempt.repo,
        commit: attempt.commit,
        file_path: attempt.file_path ?? null,
        level: attempt.level ?? null,
        dataset: job.dataset,
        exact_match: attempt.score.exact_match,
        edit_similarity: finiteNumber(attempt.score.edit_similarity),
        identifier_f1: finiteNumber(attempt.score.identifier_f1),
        context: attempt.context ?? null,
        retrieval: attempt.retrieval ?? null,
        source_result: sourceResult,
      },
      // Provenance names the Agentify version that was evaluated (the job
      // pin), not whichever CLI later performed the import.
      agentify_version: job.pins?.agentify ?? VERSION,
      claude_version: job.pins?.claude_code ?? null,
      model,
      effort: null,
      requested_profile: null,
      resolved_profile: null,
      limits: {
        max_budget_usd: job.limits?.completion_max_budget_usd ?? null,
        max_turns: job.limits?.completion_max_turns ?? null,
        timeout_seconds: null,
      },
      status: "ok",
      provider: {
        exit_code: 0,
        timed_out: false,
        duration_ms: finiteNumber(attempt.provider?.duration_ms),
        subtype: attempt.provider?.subtype ?? null,
        num_turns: finiteNumber(attempt.provider?.num_turns),
        turns_to_first_edit: null,
        resolved_model: attempt.provider?.resolved_model ?? model,
        cost_usd: finiteNumber(attempt.provider?.cost_usd),
        usage: attempt.provider?.usage ?? null,
      },
      grade: {
        pass,
        forbidden_violations: [],
        checks: [{
          command: "repobench line-completion scoring (exact match)",
          exit_code: pass ? 0 : 1,
          passed: pass,
          timed_out: false,
          output_tail: `exact_match=${attempt.score.exact_match} edit_similarity=${attempt.score.edit_similarity} identifier_f1=${attempt.score.identifier_f1}`,
        }],
        changed_paths: [],
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
  const taskId = `repobench-${job.suite || "sample"}`;
  const arms = [...localManifest.arms];
  await writeJson(path.join(runDir, "run.json"), {
    schema: EVAL_RUN_SCHEMA_VERSION,
    ts: job.started_at ?? importedAt,
    run_id: runId,
    harness: "repobench",
    repobench: {
      schema: REPOBENCH_IMPORT_SCHEMA_VERSION,
      job: path.basename(jobDir),
      imported_at: importedAt,
      dataset: job.dataset,
      suite: job.suite ?? null,
      selection_rule: job.selection_rule ?? localManifest.selection_rule,
      tasks: pairKeys.length,
      repos: [...new Set(scored.map((attempt) => attempt.repo))],
      sample,
      sample_sha256: sampleSha256,
      // Treatment limits ride along so the report fingerprint changes when
      // the context budget or turn caps change.
      limits: job.limits ?? null,
      retrieval: retrievalSummary,
    },
    agentify_version: job.pins?.agentify ?? VERSION,
    claude_version: job.pins?.claude_code ?? null,
    plan: {
      task: {
        id: taskId,
        model,
        difficulty: "mixed",
        category: "repo-intelligence",
        phases: ["retrieval", "completion"],
        profile: null,
        max_budget_usd: job.limits?.completion_max_budget_usd ?? null,
        max_turns: job.limits?.completion_max_turns ?? null,
        forbidden_paths: [],
      },
      task_path: null,
      // The aggregate spans multiple repositories. Bind comparisons to the
      // exact ordered task/repo/commit tuple set instead of pretending there
      // is a single repository commit.
      base_sha: sampleSha256,
      arms,
      repeat: pairKeys.length,
      max_spend_usd: job.max_spend_usd ?? null,
      order,
    },
  });

  return {
    command: "eval",
    action: "repobench-import",
    job: path.relative(root, jobDir),
    dataset: job.dataset,
    attempts_imported: records.length,
    attempts_skipped: skipped,
    retrieval: retrievalSummary,
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
