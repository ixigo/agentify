// Harbor (Terminal-Bench 2.0) adapter for the paired eval suite (#298).
//
// Harbor is a second, standardized harness: container-isolated tasks, an
// established plain Claude Code baseline agent, and portable datasets. This
// module deliberately keeps Harbor OUT of Agentify's runtime — no Python, no
// harbor dependency, no container orchestration here. What lives in Node is
// exactly the token-free surface:
// - validate: schema + answer-leak checks over the committed dataset, safe
//   for CI because it never talks to a provider or a container runtime.
// - plan: worst-case spend calculation for a suite, so a paid run is always
//   preceded by an explicit maximum-cost number.
// - import: convert a finished Harbor job's trial artifacts into the native
//   eval-run layout so `agentify eval report` / `eval compare` read Harbor
//   and native runs through one schema, with provenance intact.
//
// The Python agent, task images, verifiers, and suite configs are data files
// under evals/harbor/ — committed, versioned, and validated here.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { EVAL_ATTEMPT_SCHEMA_VERSION, EVAL_RUN_SCHEMA_VERSION, resolveEvalPaths } from "./eval.js";
import { ensureDir, exists, readJson, readText, walkFiles, writeJson } from "./fs.js";
import { redactSensitiveText } from "./redact.js";
import { VERSION } from "./cli-fast-paths.js";

export const HARBOR_MANIFEST_SCHEMA_VERSION = "harbor-dataset-v1";
export const HARBOR_IMPORT_SCHEMA_VERSION = "harbor-import-v1";

// Task categories the portable dataset must cover (#298). Validation fails a
// manifest that drifts to unknown categories, so the dataset's intent stays
// machine-checkable.
export const HARBOR_TASK_CATEGORIES = [
  "prior-failure-avoidance",
  "decision-recall",
  "stale-context-rejection",
  "repo-intelligence",
  "affected-test-selection",
  "mechanical-control",
  "misleading-context",
];

// Files every Harbor task directory must ship. `fixtures/agentify-context` is
// Agentify-specific: it is baked into the shared image at a neutral path and
// only the agentify agent moves it into place, so both arms run the exact
// same image.
const REQUIRED_TASK_FILES = [
  "task.toml",
  "instruction.md",
  path.join("environment", "Dockerfile"),
  path.join("tests", "test.sh"),
  path.join("solution", "solve.sh"),
];
// Inside environment/ so the Dockerfile can COPY it into the image at a
// neutral path (/opt/agentify-fixtures); only the agentify agent moves it
// into the repo's .agentify/context, so both arms share one image.
const FIXTURES_DIR = path.join("environment", "fixtures", "agentify-context");
// Two-phase (write -> recall) tasks ship a phase-A seed instruction here,
// inside environment/ so the task Dockerfile can COPY it into the image at a
// neutral path (/opt/agentify-seed). Its presence marks a task as two-phase;
// see docs/harbor.md, "Multi-session tasks".
const SEED_INSTRUCTION_REL = path.join("environment", "phases", "seed", "instruction.md");
// The agent (evals/harbor/agents/agentify_claude.py) runs phase A only when it
// finds the seed instruction at this exact in-image path; the source it must be
// copied from lives at these repo-relative paths. Validation checks that the
// Dockerfile performs a COPY that actually lands the file here — a substring
// mention (a comment, or a COPY to some other target) would validate a task
// that then silently skips phase A.
const SEED_IMAGE_FILE = "/opt/agentify-seed/instruction.md";
const SEED_IMAGE_DIR = "/opt/agentify-seed";
const SEED_SRC_FILE = "phases/seed/instruction.md";
const SEED_SRC_DIR = "phases/seed";

// True only if the Dockerfile has a real COPY/ADD that places the seed
// instruction at SEED_IMAGE_FILE — either the file copied directly, or the
// phases/seed directory copied onto /opt/agentify-seed (which lands
// instruction.md inside it). Comments and copies to any other target are
// ignored, matching what the agent will actually read at runtime.
function dockerfileBakesSeed(dockerfile) {
  const stripQuotes = (token) => token.replace(/^[["',\s]+|[\]"',\s]+$/g, "");
  const normalize = (p) => stripQuotes(p).replace(/^\.\//, "").replace(/\/+$/, "");
  for (const rawLine of dockerfile.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = /^(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!match) continue;
    // Drop --flags (--chown, --from, …); the remaining tokens are src… dest.
    const tokens = match[1].split(/\s+/).filter((token) => token && !token.startsWith("--"));
    if (tokens.length < 2) continue;
    const dest = normalize(tokens[tokens.length - 1]);
    const sources = tokens.slice(0, -1).map(normalize);
    // Direct file copy: <…>/phases/seed/instruction.md -> /opt/agentify-seed/instruction.md
    if (dest === SEED_IMAGE_FILE && sources.some((src) => src === SEED_SRC_FILE)) {
      return true;
    }
    // Directory copy: <…>/phases/seed -> /opt/agentify-seed (instruction.md lands inside)
    if (dest === SEED_IMAGE_DIR && sources.some((src) => src === SEED_SRC_DIR)) {
      return true;
    }
  }
  return false;
}

export function resolveHarborPaths(root, config = {}) {
  const { tasksDir } = resolveEvalPaths(root, config);
  const harborRoot = path.join(tasksDir, "harbor");
  return {
    harborRoot,
    manifestPath: path.join(harborRoot, "dataset.json"),
    tasksRoot: path.join(harborRoot, "tasks"),
    agentsDir: path.join(harborRoot, "agents"),
    suitesDir: path.join(harborRoot, "suites"),
  };
}

function fail(message) {
  throw new Error(`Invalid Harbor dataset: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requirePinned(value, label) {
  const text = requireString(value, label);
  // A pin must resolve to one immutable artifact; "latest" or a bare range
  // would silently change what every future run measures.
  if (/^(latest|\*|\^|~)/.test(text) || !/\d/.test(text)) {
    fail(`${label} must be pinned to an exact version, got "${text}"`);
  }
  return text;
}

export async function loadHarborManifest(root, config = {}) {
  const paths = resolveHarborPaths(root, config);
  if (!(await exists(paths.manifestPath))) {
    throw new Error(`No Harbor dataset manifest at ${path.relative(root, paths.manifestPath)}. See docs/harbor.md.`);
  }
  const raw = await readJson(paths.manifestPath);
  if (raw?.schema !== HARBOR_MANIFEST_SCHEMA_VERSION) {
    fail(`manifest schema must be "${HARBOR_MANIFEST_SCHEMA_VERSION}", got "${raw?.schema}"`);
  }
  const manifest = {
    schema: raw.schema,
    name: requireString(raw.name, "name"),
    version: requirePinned(raw.version, "version"),
    model: requirePinned(raw.model, "model"),
    pins: {
      harbor: requirePinned(raw.pins?.harbor, "pins.harbor"),
      claude_code: requirePinned(raw.pins?.claude_code, "pins.claude_code"),
      agentify: requirePinned(raw.pins?.agentify, "pins.agentify"),
    },
    agents: raw.agents,
    tasks: raw.tasks,
    suites: raw.suites,
  };
  if (!Array.isArray(manifest.agents) || manifest.agents.length < 2) {
    fail("agents must list at least the agentify and baseline agents");
  }
  manifest.agents = manifest.agents.map((agent) => ({
    name: requireString(agent?.name, "agents[].name"),
    kind: requireString(agent?.kind, "agents[].kind"),
    ...(agent?.import_path ? { import_path: String(agent.import_path) } : {}),
    ...(agent?.profile ? { profile: String(agent.profile) } : {}),
  }));
  if (!manifest.agents.some((agent) => agent.name.includes("agentify"))
    || !manifest.agents.some((agent) => !agent.name.includes("agentify"))) {
    fail("agents must include one agentify agent and one non-agentify baseline");
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length < 8) {
    fail(`tasks must list at least 8 tasks (issue #298 dataset floor), got ${Array.isArray(manifest.tasks) ? manifest.tasks.length : 0}`);
  }
  const seen = new Set();
  manifest.tasks = manifest.tasks.map((task) => {
    const id = requireString(task?.id, "tasks[].id");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      fail(`task id "${id}" must be lowercase alphanumeric with dashes`);
    }
    if (seen.has(id)) {
      fail(`duplicate task id "${id}"`);
    }
    seen.add(id);
    const category = requireString(task?.category, `tasks[${id}].category`);
    if (!HARBOR_TASK_CATEGORIES.includes(category)) {
      fail(`task "${id}" has unknown category "${category}" (known: ${HARBOR_TASK_CATEGORIES.join(", ")})`);
    }
    const maxCost = Number(task?.max_cost_usd);
    if (!Number.isFinite(maxCost) || maxCost <= 0) {
      fail(`task "${id}" needs a positive max_cost_usd spend ceiling`);
    }
    // Machine-checkable "fixtures never leak the answer": each task names the
    // strings that constitute its expected solution, and validation greps the
    // fixtures for them. An empty list would make the leak check vacuous.
    const leakPatterns = task?.answer_leak_patterns;
    if (!Array.isArray(leakPatterns) || leakPatterns.length === 0
      || leakPatterns.some((pattern) => typeof pattern !== "string" || !pattern.trim())) {
      fail(`task "${id}" needs non-empty answer_leak_patterns for the fixture leak check`);
    }
    // Optional two-phase (write -> recall) declaration. Kept as-is so
    // validation can cross-check it against the on-disk seed instruction.
    const phases = Array.isArray(task?.phases) ? task.phases.map((phase) => String(phase)) : null;
    return {
      id,
      category,
      max_cost_usd: maxCost,
      answer_leak_patterns: leakPatterns.map((pattern) => pattern.trim()),
      ...(phases ? { phases } : {}),
    };
  });
  const missingCategories = HARBOR_TASK_CATEGORIES.filter(
    (category) => !manifest.tasks.some((task) => task.category === category),
  );
  if (missingCategories.length > 0) {
    fail(`dataset must cover every category; missing: ${missingCategories.join(", ")}`);
  }
  if (!manifest.suites || typeof manifest.suites !== "object" || Array.isArray(manifest.suites)) {
    fail("suites must be a mapping of suite name -> {tasks, attempts}");
  }
  const suites = {};
  for (const [name, suite] of Object.entries(manifest.suites)) {
    const tasks = suite?.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.some((id) => !seen.has(id))) {
      fail(`suite "${name}" must list known task ids`);
    }
    const attempts = Number(suite?.attempts);
    if (!Number.isInteger(attempts) || attempts <= 0) {
      fail(`suite "${name}" needs a positive integer attempts count`);
    }
    // Suites default to the manifest's agent pair; the profile-matrix suite
    // runs more agentify variants, so its spend plan must multiply by its
    // own agent count.
    const agents = suite?.agents === undefined ? manifest.agents.length : Number(suite.agents);
    if (!Number.isInteger(agents) || agents < 2) {
      fail(`suite "${name}" agents must be an integer >= 2 (a single arm is not a paired run)`);
    }
    suites[name] = { tasks: [...tasks], attempts, agents };
  }
  if (!suites.smoke) {
    fail('suites must include a low-cost "smoke" suite');
  }
  manifest.suites = suites;
  return { manifest, paths };
}

async function listTaskDirs(tasksRoot) {
  if (!(await exists(tasksRoot))) {
    return [];
  }
  return (await fs.readdir(tasksRoot, { withFileTypes: true }))
    // Skip hidden dirs (e.g. a stray .agentify/ from running the CLI inside
    // tasks/): a valid task id can never start with a dot, so these are never
    // tasks and must not trip the "undeclared task directory" check.
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

// Structural + leak validation over the committed dataset. Token-free and
// container-free by design: this is the check CI runs on every PR.
export async function validateHarborDataset(root, config = {}) {
  const { manifest, paths } = await loadHarborManifest(root, config);
  const problems = [];
  const checkedTasks = [];

  const taskDirs = await listTaskDirs(paths.tasksRoot);
  for (const task of manifest.tasks) {
    if (!taskDirs.includes(task.id)) {
      problems.push(`task "${task.id}" is in dataset.json but has no directory under ${path.relative(root, paths.tasksRoot)}`);
    }
  }
  for (const dir of taskDirs) {
    if (!manifest.tasks.some((task) => task.id === dir)) {
      problems.push(`task directory "${dir}" is not declared in dataset.json`);
    }
  }

  for (const task of manifest.tasks) {
    const taskDir = path.join(paths.tasksRoot, task.id);
    if (!(await exists(taskDir))) {
      continue;
    }
    const taskProblems = [];
    for (const file of REQUIRED_TASK_FILES) {
      if (!(await exists(path.join(taskDir, file)))) {
        taskProblems.push(`missing ${file}`);
      }
    }

    const fixturesDir = path.join(taskDir, FIXTURES_DIR);
    if (!(await exists(path.join(fixturesDir, "notes.jsonl")))) {
      taskProblems.push(`missing ${path.join(FIXTURES_DIR, "notes.jsonl")} (every task seeds context, even if only unrelated history)`);
    } else {
      // Fixture stores must parse as the same JSONL shape the live context
      // store writes ({ts, note}); a malformed fixture would silently seed
      // nothing and the agentify arm would measure an empty install.
      for (const name of (await fs.readdir(fixturesDir)).filter((entry) => entry.endsWith(".jsonl"))) {
        const lines = (await readText(path.join(fixturesDir, name))).split(/\r?\n/).filter((line) => line.trim());
        for (const line of lines) {
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            taskProblems.push(`${path.join(FIXTURES_DIR, name)} has a non-JSON line`);
            break;
          }
          if (!record || typeof record.ts !== "string") {
            taskProblems.push(`${path.join(FIXTURES_DIR, name)} has a record without a ts timestamp`);
            break;
          }
        }
      }

      // The leak check: no fixture file may contain any of the task's
      // declared answer strings. History and hints are the point; the final
      // patch or expected output is not.
      for (const filePath of await walkFiles(fixturesDir)) {
        const content = await readText(filePath);
        for (const pattern of task.answer_leak_patterns) {
          if (content.includes(pattern)) {
            taskProblems.push(`${path.relative(taskDir, filePath)} leaks answer pattern "${pattern}"`);
          }
        }
      }
    }

    // The verifier must be able to distinguish arms only by their work: a
    // test that greps the fixtures dir would grade the seeding, not the task.
    const testPath = path.join(taskDir, "tests", "test.sh");
    if (await exists(testPath)) {
      const testText = await readText(testPath);
      if (/agentify-fixtures|fixtures\/agentify-context/.test(testText)) {
        taskProblems.push("tests/test.sh must not reference the Agentify fixtures path");
      }
    }

    // Two-phase (write -> recall) tasks: the decisive context is produced by a
    // seed session, not pre-baked. Detect via the on-disk seed instruction and
    // cross-check the manifest's `phases` declaration. When two-phase, the
    // answer must not leak from EITHER prompt (the same guarantee the fixtures
    // already carry), and the image must actually bake the seed instruction in
    // or the seed phase silently no-ops.
    const seedPath = path.join(taskDir, SEED_INSTRUCTION_REL);
    const hasSeedFile = await exists(seedPath);
    const declaresPhases = Array.isArray(task.phases) && task.phases.includes("seed");
    if (hasSeedFile || declaresPhases) {
      if (!hasSeedFile) {
        taskProblems.push(`declares phases [${task.phases.join(", ")}] but has no ${SEED_INSTRUCTION_REL}`);
      }
      if (!declaresPhases) {
        taskProblems.push(`ships ${SEED_INSTRUCTION_REL} but dataset.json does not declare "phases": ["seed", "recall"]`);
      }
      for (const rel of ["instruction.md", SEED_INSTRUCTION_REL]) {
        const promptPath = path.join(taskDir, rel);
        if (await exists(promptPath)) {
          const content = await readText(promptPath);
          for (const pattern of task.answer_leak_patterns) {
            if (content.includes(pattern)) {
              taskProblems.push(`${rel} leaks answer pattern "${pattern}"`);
            }
          }
        }
      }
      const dockerfilePath = path.join(taskDir, "environment", "Dockerfile");
      if (await exists(dockerfilePath)) {
        const dockerfile = await readText(dockerfilePath);
        if (!dockerfileBakesSeed(dockerfile)) {
          taskProblems.push(`two-phase task: environment/Dockerfile must COPY ${SEED_SRC_FILE} to ${SEED_IMAGE_FILE}`);
        }
      }
    }

    checkedTasks.push({
      id: task.id,
      category: task.category,
      ok: taskProblems.length === 0,
      problems: taskProblems,
      ...(hasSeedFile ? { phases: task.phases || ["seed", "recall"] } : {}),
    });
    problems.push(...taskProblems.map((problem) => `${task.id}: ${problem}`));
  }

  for (const agent of manifest.agents) {
    if (agent.kind === "installed" && agent.import_path) {
      const [modulePath] = String(agent.import_path).split(":");
      const file = path.join(paths.harborRoot, `${modulePath.replace(/\./g, "/")}.py`);
      if (!(await exists(file))) {
        problems.push(`agent "${agent.name}" import_path points at ${path.relative(root, file)}, which does not exist`);
      }
    }
  }
  for (const suiteName of Object.keys(manifest.suites)) {
    const suitePath = path.join(paths.suitesDir, `${suiteName}.yaml`);
    if (!(await exists(suitePath))) {
      problems.push(`suite "${suiteName}" has no job config at ${path.relative(root, suitePath)}`);
    }
  }

  return {
    command: "eval",
    action: "harbor-validate",
    dataset: { name: manifest.name, version: manifest.version, model: manifest.model, pins: manifest.pins },
    tasks: checkedTasks,
    suites: Object.fromEntries(Object.entries(manifest.suites).map(([name, suite]) => [name, { tasks: suite.tasks.length, attempts: suite.attempts }])),
    problems,
    ok: problems.length === 0,
  };
}

// Worst-case spend for a suite before anything launches: every trial is
// bounded by its task's max_cost_usd ceiling (enforced inside the agents via
// --max-budget-usd), so the suite ceiling is tasks × agents × attempts × cap.
export async function planHarborRun(root, config = {}, options = {}) {
  const { manifest, paths } = await loadHarborManifest(root, config);
  const suiteName = String(options.suite || "smoke").trim();
  const suite = manifest.suites[suiteName];
  if (!suite) {
    throw new Error(`Unknown Harbor suite "${suiteName}" (available: ${Object.keys(manifest.suites).join(", ")})`);
  }
  const tasks = manifest.tasks.filter((task) => suite.tasks.includes(task.id));
  const trialsPerTask = suite.agents * suite.attempts;
  const maxSpend = tasks.reduce((sum, task) => sum + task.max_cost_usd * trialsPerTask, 0);
  const suitePath = path.join(paths.suitesDir, `${suiteName}.yaml`);
  return {
    command: "eval",
    action: "harbor-plan",
    suite: suiteName,
    dataset: { name: manifest.name, version: manifest.version },
    model: manifest.model,
    pins: manifest.pins,
    agents: manifest.agents.map((agent) => agent.name),
    agents_per_task: suite.agents,
    tasks: tasks.map((task) => ({ id: task.id, category: task.category, max_cost_usd: task.max_cost_usd })),
    attempts_per_agent: suite.attempts,
    trials: tasks.length * trialsPerTask,
    max_spend_usd: Number(maxSpend.toFixed(6)),
    // The agentify agent enforces the cap in-flight via --max-budget-usd.
    // Harbor's built-in claude-code agent may or may not expose an equivalent
    // budget kwarg depending on the pinned version — when it doesn't, that
    // arm is bounded only by the task/agent timeouts and the ceiling is an
    // assumption for it, not a guarantee.
    enforcement: "agentify agent: --max-budget-usd per trial; baseline: verify your harbor version's claude-code agent supports a budget kwarg, else bounded by timeouts only",
    harbor_command: `harbor run -c ${path.relative(root, suitePath)}`,
    import_command: "agentify eval harbor import <jobs/job-dir>",
    confirmation_required: process.env.CI !== "true",
  };
}

// ---------------------------------------------------------------------------
// Import: Harbor job artifacts -> native eval runs
// ---------------------------------------------------------------------------

function firstFinite(...values) {
  for (const value of values) {
    const num = Number(value);
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(num)) {
      return num;
    }
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function durationMs(startedAt, finishedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(finishedAt || "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

// Trial artifacts are read tolerantly across Harbor versions: field locations
// have moved between releases, so every metric probes the known spellings and
// degrades to null (the report already treats null cost/usage as "unreported",
// never as zero).
async function readTrial(trialDir) {
  const resultPath = path.join(trialDir, "result.json");
  if (!(await exists(resultPath))) {
    return null;
  }
  let result;
  try {
    result = await readJson(resultPath);
  } catch {
    return { name: path.basename(trialDir), error: "unparseable result.json" };
  }
  const trialConfig = (await exists(path.join(trialDir, "config.json")))
    ? await readJson(path.join(trialDir, "config.json")).catch(() => null)
    : null;

  // harbor 0.18.x nests rewards as verifier_result.rewards.reward; older
  // layouts used verifier_result.reward or a top-level reward.
  let reward = firstFinite(result?.verifier_result?.rewards?.reward, result?.verifier_result?.reward, result?.reward, result?.verifier?.reward);
  if (reward === null) {
    const rewardPath = path.join(trialDir, "verifier", "reward.txt");
    if (await exists(rewardPath)) {
      reward = firstFinite((await readText(rewardPath)).trim());
    }
  }

  const agentResult = result?.agent_result ?? result?.agent ?? {};
  const usageSource = agentResult?.token_usage ?? result?.token_usage ?? agentResult;
  const inputTokens = firstFinite(usageSource?.n_input_tokens, usageSource?.input_tokens, usageSource?.prompt_tokens);
  const outputTokens = firstFinite(usageSource?.n_output_tokens, usageSource?.output_tokens, usageSource?.completion_tokens);
  const cacheReadTokens = firstFinite(usageSource?.n_cache_tokens, usageSource?.n_cache_read_tokens, usageSource?.cache_read_tokens, usageSource?.cached_tokens);

  // Two-phase (write -> recall) trials carry the phase-A "seed" spend in the
  // agent context metadata (see agentify_claude.py). The graded reward reflects
  // only the recall phase, but the memory the arm relied on cost real money to
  // produce; folding the seed cost into the imported total keeps cost-per-pass
  // and frontier analyses from undercounting the Agentify arm. The raw seed
  // cost is preserved separately so the amortized-cost analysis (#319) can
  // still weigh the investment against the rediscovery it saves.
  const metadata = agentResult?.metadata ?? result?.metadata ?? {};
  const recallCostUsd = firstFinite(agentResult?.cost, agentResult?.cost_usd, result?.cost_usd, result?.cost);
  const seedCostUsd = firstFinite(metadata?.seed_cost_usd);
  const multisession = metadata?.multisession === true;
  const costUsd = recallCostUsd === null
    ? null
    : (multisession && seedCostUsd !== null
      ? Number((recallCostUsd + seedCostUsd).toFixed(6))
      : recallCostUsd);

  const exception = result?.exception_info ?? result?.exception ?? null;
  return {
    name: firstString(result?.trial_name, result?.name, path.basename(trialDir)),
    task: firstString(
      result?.task_name, result?.task_id, result?.task?.name, result?.task?.id,
      trialConfig?.task?.name, trialConfig?.task_name,
      // Harbor trial names are conventionally <task>__<suffix>.
      path.basename(trialDir).split("__")[0],
    ),
    agent: firstString(
      result?.agent_name, result?.agent_info?.name, trialConfig?.agent?.name, trialConfig?.agent_name,
    ),
    model: firstString(result?.agent_info?.model_name, result?.agent_info?.model_info?.name, trialConfig?.agent?.model_name, trialConfig?.model_name),
    agentVersion: firstString(result?.agent_info?.version, trialConfig?.agent?.version),
    profile: firstString(
      trialConfig?.agent?.kwargs?.profile,
      trialConfig?.agent?.env?.AGENTIFY_PROFILE,
      result?.agent_info?.kwargs?.profile,
    ),
    reward,
    exception: exception ? redactSensitiveText(String(exception.message ?? exception)).slice(0, 2000) : null,
    startedAt: firstString(result?.started_at, result?.created_at),
    finishedAt: firstString(result?.finished_at, result?.ended_at),
    agentMs: durationMs(
      firstString(result?.agent_execution?.started_at, result?.agent_setup?.started_at),
      firstString(result?.agent_execution?.finished_at),
    ) ?? durationMs(firstString(result?.started_at), firstString(result?.finished_at)),
    costUsd,
    recallCostUsd,
    seedCostUsd,
    multisession,
    usage: inputTokens !== null || outputTokens !== null
      ? {
        fresh_input_tokens: Math.max(0, (inputTokens ?? 0) - (cacheReadTokens ?? 0)),
        cache_read_tokens: cacheReadTokens ?? 0,
        cache_write_tokens: 0,
        output_tokens: outputTokens ?? 0,
      }
      : null,
  };
}

// Arm labels bridge Harbor agent names into the native report's pairing
// contract: the agentify agent becomes the "agentify" arm (so paired deltas
// and the verdict engine engage), profile variants get their own bucket, and
// baselines keep their Harbor agent name.
export function harborArmForAgent(agentName, profile = null) {
  const name = String(agentName || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) {
    return null;
  }
  if (name.includes("agentify")) {
    return profile && profile !== "balanced" ? `agentify-${profile}` : "agentify";
  }
  return name;
}

function importRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

// Convert one finished Harbor job directory into native eval runs — one run
// per Harbor task, arms across agents, repeat indices in trial order. The
// resulting runs live beside native runs and read identically through
// `eval report`, `eval compare`, and `eval list`; run.json carries
// harness: "harbor" so they can never be resumed or mistaken for native runs.
export async function importHarborJob(root, config = {}, jobDirInput, options = {}) {
  const jobDir = path.resolve(root, String(jobDirInput || "").trim());
  if (!jobDirInput || !(await exists(jobDir))) {
    throw new Error(`Harbor import requires a job directory (harbor's jobs/<name>), got "${jobDirInput}"`);
  }
  const manifest = await loadHarborManifest(root, config).then(({ manifest: value }) => value).catch(() => null);
  const jobConfig = (await exists(path.join(jobDir, "config.json")))
    ? await readJson(path.join(jobDir, "config.json")).catch(() => null)
    : null;
  const jobResult = (await exists(path.join(jobDir, "result.json")))
    ? await readJson(path.join(jobDir, "result.json")).catch(() => null)
    : null;

  const trials = [];
  const skipped = [];
  for (const entry of (await fs.readdir(jobDir, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
    const trial = await readTrial(path.join(jobDir, entry));
    if (!trial) {
      continue; // Not a trial directory (no result.json).
    }
    if (trial.error || !trial.task || !trial.agent) {
      skipped.push({ trial: entry, reason: trial.error || "missing task or agent identity in trial artifacts" });
      continue;
    }
    trials.push(trial);
  }
  if (trials.length === 0) {
    throw new Error(`No importable Harbor trials found under ${path.relative(root, jobDir)}${skipped.length > 0 ? ` (${skipped.length} skipped)` : ""}`);
  }

  const { runsRoot } = resolveEvalPaths(root, config);
  const byTask = new Map();
  for (const trial of trials) {
    if (!byTask.has(trial.task)) byTask.set(trial.task, []);
    byTask.get(trial.task).push(trial);
  }

  const importedAt = new Date().toISOString();
  // Provenance comes from the job's own artifacts; the local manifest is
  // never a fallback for the harbor version, and its dataset identity is
  // only stamped onto tasks it actually declares — an external job (e.g. a
  // Terminal-Bench subset) must not be labeled as the local dataset.
  // harbor 0.18.x records its version in the job's lock.json.
  const jobLock = (await exists(path.join(jobDir, "lock.json")))
    ? await readJson(path.join(jobDir, "lock.json")).catch(() => null)
    : null;
  const harborVersion = firstString(jobConfig?.harbor_version, jobResult?.harbor_version, jobLock?.harbor?.version);
  const runs = [];
  for (const [taskId, taskTrials] of [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const runId = importRunId(options.now ? new Date(options.now) : new Date());
    const runDir = path.join(runsRoot, runId);
    await ensureDir(path.join(runDir, "attempts"));

    const model = firstString(...taskTrials.map((trial) => trial.model), manifest?.model) ?? "unknown";
    const datasetTask = manifest?.tasks?.find((task) => task.id === taskId) ?? null;
    const datasetInfo = datasetTask && manifest ? { name: manifest.name, version: manifest.version } : null;
    const repeatCounters = new Map();
    const order = [];
    const records = [];
    for (const trial of taskTrials) {
      const arm = harborArmForAgent(trial.agent, trial.profile);
      if (!arm) {
        skipped.push({ trial: trial.name, reason: `agent name "${trial.agent}" produced no usable arm label` });
        continue;
      }
      const repeatIndex = (repeatCounters.get(arm) ?? 0) + 1;
      repeatCounters.set(arm, repeatIndex);
      const attemptId = `${arm}-${repeatIndex}`;
      // Reward is graded pass/fail exactly like the native runner: only a
      // full reward passes; partial credit is a fail with the reward kept.
      const pass = trial.reward !== null && trial.reward >= 1;
      const status = trial.exception ? "error" : "ok";
      records.push({
        schema: EVAL_ATTEMPT_SCHEMA_VERSION,
        run_id: runId,
        attempt_id: attemptId,
        arm,
        base_arm: arm.startsWith("agentify") ? "agentify" : arm,
        context_ablation: null,
        repeat_index: repeatIndex,
        task_id: taskId,
        base_sha: null,
        harness: "harbor",
        harbor: {
          job: path.basename(jobDir),
          trial: trial.name,
          agent: trial.agent,
          agent_version: trial.agentVersion,
          reward: trial.reward,
          harbor_version: harborVersion ?? null,
          dataset: datasetInfo,
        },
        agentify_version: VERSION,
        claude_version: null,
        model,
        effort: null,
        requested_profile: trial.profile ?? null,
        resolved_profile: trial.profile ?? null,
        limits: { max_budget_usd: datasetTask?.max_cost_usd ?? null, max_turns: null, timeout_seconds: null },
        status,
        ...(trial.exception ? { error: trial.exception } : {}),
        provider: {
          exit_code: trial.exception ? 1 : 0,
          timed_out: false,
          duration_ms: trial.agentMs,
          subtype: null,
          num_turns: null,
          resolved_model: model,
          // cost_usd is the full memory investment (recall + seed) so downstream
          // cost analyses don't undercount; the two-phase split is kept beside it.
          cost_usd: trial.costUsd,
          ...(trial.multisession
            ? { multisession: true, recall_cost_usd: trial.recallCostUsd, seed_cost_usd: trial.seedCostUsd }
            : {}),
          usage: trial.usage,
        },
        grade: {
          pass,
          forbidden_violations: [],
          checks: [{
            command: "harbor verifier",
            exit_code: pass ? 0 : 1,
            passed: pass,
            timed_out: false,
            output_tail: trial.reward === null ? "no reward recorded" : `reward ${trial.reward}`,
          }],
          changed_paths: [],
        },
        pass,
        duration_ms: durationMs(trial.startedAt, trial.finishedAt) ?? trial.agentMs,
        artifacts: null,
      });
      order.push({ attempt_id: attemptId, arm, repeat_index: repeatIndex });
    }
    if (records.length === 0) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    for (const record of records) {
      await ensureDir(path.join(runDir, "attempts", record.attempt_id));
      await writeJson(path.join(runDir, "attempts", record.attempt_id, "result.json"), record);
    }
    await writeJson(path.join(runDir, "run.json"), {
      schema: EVAL_RUN_SCHEMA_VERSION,
      ts: firstString(...taskTrials.map((trial) => trial.startedAt)) ?? importedAt,
      run_id: runId,
      // The harness marker is what blocks `eval run --resume` on this run and
      // labels provenance in reports.
      harness: "harbor",
      harbor: {
        schema: HARBOR_IMPORT_SCHEMA_VERSION,
        job: path.basename(jobDir),
        imported_at: importedAt,
        harbor_version: harborVersion ?? null,
        dataset: datasetInfo,
        agents: [...new Set(taskTrials.map((trial) => trial.agent))],
      },
      agentify_version: VERSION,
      claude_version: null,
      plan: {
        task: {
          id: taskId,
          model,
          profile: null,
          max_budget_usd: datasetTask?.max_cost_usd ?? null,
          forbidden_paths: [],
        },
        task_path: null,
        base_sha: null,
        arms: [...new Set(order.map((entry) => entry.arm))],
        repeat: Math.max(...repeatCounters.values()),
        max_spend_usd: datasetTask ? Number((datasetTask.max_cost_usd * order.length).toFixed(6)) : null,
        order,
      },
    });
    runs.push({
      run_id: runId,
      task_id: taskId,
      arms: [...new Set(order.map((entry) => entry.arm))],
      attempts: order.length,
      report_command: `agentify eval report ${runId}`,
    });
  }

  return {
    command: "eval",
    action: "harbor-import",
    job: path.relative(root, jobDir),
    harbor_version: harborVersion ?? null,
    // Summary-level dataset identity only when every imported task belongs to
    // the local manifest; a mixed or external job stays unlabeled here (the
    // per-run provenance already carries per-task truth).
    dataset: manifest && [...byTask.keys()].every((id) => manifest.tasks.some((task) => task.id === id))
      ? { name: manifest.name, version: manifest.version }
      : null,
    trials_imported: trials.length - skipped.filter((entry) => entry.reason.includes("arm label")).length,
    trials_skipped: skipped,
    runs,
  };
}
