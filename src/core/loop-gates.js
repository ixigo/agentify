// Acceptance gates for `agentify loop`.
//
// A gate is the loop's only definition of "done". The agent never decides it
// has finished: it edits, the gates run, and the verdicts decide whether the
// loop iterates again. Every gate therefore has to produce a typed, machine
// readable verdict from something deterministic — an exit code, a score against
// a threshold, an index-derived level — never from prose the model wrote about
// its own work.
//
// The one gate that consults a model (`review`) is deliberately constrained to
// emit a single parseable verdict line, and a review that does not emit one is
// an *error*, not a pass. Fail-closed is the rule everywhere here: if a gate
// cannot determine an outcome, the iteration does not get credit for it.

import { readFile as readFileBuffer } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exists, writeText } from "./fs.js";
import { runProcess } from "./proc.js";
import { compareImages, decodePng } from "./png.js";
import { redactSensitiveText } from "./redact.js";

const AGENTIFY_CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const BUNDLED_CAPTURE_SCRIPT = fileURLToPath(new URL("../../skills/ui-screenshot-eval/scripts/capture.mjs", import.meta.url));

export const LOOP_GATE_KINDS = ["command", "agentify-tests", "playwright", "visual", "review", "risk"];

const RISK_LEVELS = ["none", "low", "medium", "high"];
const DEFAULT_GATE_TIMEOUT_SECONDS = 600;
const OUTPUT_TAIL_CHARS = 4000;

// The verdict line a `review` gate requires. Anything else — including a
// thoughtful review with no verdict — fails the gate as unparseable rather than
// being optimistically read as approval.
const REVIEW_VERDICT_PATTERN = /^\s*VERDICT:\s*(pass|block)\b[ \t]*(?:[-–—:]\s*(.*))?$/im;

export const REVIEW_VERDICT_INSTRUCTION = [
  "Finish your reply with exactly one line in this form and nothing after it:",
  "VERDICT: pass — <one-line reason>",
  "or",
  "VERDICT: block — <the single most important blocking problem>",
  "",
  "Use `block` only for defects you can point at in the diff: incorrect behavior,",
  "a regression, a security or data-loss risk, or a broken contract. Style",
  "preferences and speculative concerns are not blocking.",
].join("\n");

function fail(source, message) {
  throw new Error(`Invalid loop brief${source ? ` (${source})` : ""}: ${message}`);
}

function tail(text) {
  const value = redactSensitiveText(String(text || ""));
  return value.length > OUTPUT_TAIL_CHARS ? value.slice(-OUTPUT_TAIL_CHARS) : value;
}

function requireString(value, label, source) {
  const text = String(value ?? "").trim();
  if (!text) {
    fail(source, `${label} is required`);
  }
  return text;
}

function optionalPositiveNumber(value, label, source, fallback, { integer = false } = {}) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const num = Number(value);
  if (typeof value === "boolean" || !Number.isFinite(num) || num <= 0 || (integer && !Number.isInteger(num))) {
    fail(source, `${label} must be a positive ${integer ? "integer" : "number"}, got "${value}"`);
  }
  return num;
}

function stringList(value, label, source) {
  if (value === null || value === undefined) {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.some((entry) => typeof entry !== "string" || !entry.trim())) {
    fail(source, `${label} must be a non-empty string or list of non-empty strings`);
  }
  return list.map((entry) => entry.trim());
}

/**
 * Validate and normalize the brief's gate list.
 *
 * Order is preserved and meaningful: gates run in sequence and a blocking
 * failure short-circuits the rest, so cheap checks belong before expensive ones.
 */
export function normalizeGates(raw, source = "") {
  if (raw === null || raw === undefined) {
    fail(source, "gates is required — a loop with no gates has no definition of done");
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(source, "gates must be a non-empty list");
  }

  const seen = new Set();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(source, `gates[${index}] must be a mapping`);
    }
    const id = requireString(entry.id, `gates[${index}].id`, source);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      fail(source, `gates[${index}].id must be alphanumeric with dashes/underscores, got "${entry.id}"`);
    }
    if (seen.has(id)) {
      fail(source, `duplicate gate id "${id}"`);
    }
    seen.add(id);

    const kind = String(entry.kind || "command").trim().toLowerCase();
    if (!LOOP_GATE_KINDS.includes(kind)) {
      fail(source, `gate "${id}" has unknown kind "${entry.kind}" (available: ${LOOP_GATE_KINDS.join(", ")})`);
    }

    const gate = {
      id,
      kind,
      // A non-blocking gate is measured and reported but never stops the loop
      // or holds back the ship step — useful for signals you want tracked
      // before you trust them enough to gate on.
      blocking: entry.blocking !== false,
      timeout_seconds: optionalPositiveNumber(entry.timeout_seconds, `gate "${id}" timeout_seconds`, source, DEFAULT_GATE_TIMEOUT_SECONDS),
      run: null,
    };

    if (kind === "command") {
      gate.run = requireString(entry.run, `gate "${id}" run`, source);
    } else if (kind === "playwright") {
      // Repos name this script every possible way; default to the canonical
      // runner and let the brief override.
      gate.run = String(entry.run ?? "npx playwright test").trim() || "npx playwright test";
      gate.needs_server = entry.needs_server !== false;
    } else if (kind === "agentify-tests") {
      if (entry.run) {
        fail(source, `gate "${id}" is kind agentify-tests, which derives its own command from the index; remove "run"`);
      }
    } else if (kind === "visual") {
      gate.reference = stringList(entry.reference, `gate "${id}" reference`, source);
      if (gate.reference.length === 0) {
        fail(source, `gate "${id}" requires at least one reference image path`);
      }
      gate.url = requireString(entry.url, `gate "${id}" url`, source);
      gate.test_id = entry.test_id ? String(entry.test_id).trim() : null;
      gate.selector = entry.selector ? String(entry.selector).trim() : null;
      if (!gate.test_id && !gate.selector) {
        fail(source, `gate "${id}" requires test_id or selector so the captured element is unambiguous`);
      }
      gate.viewport = String(entry.viewport || "1440x900").trim();
      if (!/^\d+x\d+$/.test(gate.viewport)) {
        fail(source, `gate "${id}" viewport must be WIDTHxHEIGHT, got "${entry.viewport}"`);
      }
      gate.wait_for = entry.wait_for ? String(entry.wait_for).trim() : null;
      gate.compare = String(entry.compare || "element").trim().toLowerCase();
      if (!["element", "full-page"].includes(gate.compare)) {
        fail(source, `gate "${id}" compare must be "element" or "full-page", got "${entry.compare}"`);
      }
      gate.min_score = optionalPositiveNumber(entry.min_score, `gate "${id}" min_score`, source, 0.9);
      if (gate.min_score > 1) {
        fail(source, `gate "${id}" min_score must be between 0 and 1, got "${entry.min_score}"`);
      }
      gate.needs_server = entry.needs_server !== false;
    } else if (kind === "review") {
      gate.focus = String(entry.focus || "").trim() || null;
    } else if (kind === "risk") {
      gate.max_level = String(entry.max_level || "medium").trim().toLowerCase();
      if (!RISK_LEVELS.includes(gate.max_level)) {
        fail(source, `gate "${id}" max_level must be one of ${RISK_LEVELS.join(", ")}, got "${entry.max_level}"`);
      }
    }

    return gate;
  });
}

/** True when any gate needs a running app before it can be evaluated. */
export function gatesNeedServer(gates) {
  return gates.some((gate) => gate.needs_server === true);
}

/** True when any gate reads the structural index, which the worktree must build. */
export function gatesNeedIndex(gates) {
  return gates.some((gate) => gate.kind === "agentify-tests" || gate.kind === "risk");
}

function verdict(gate, status, detail, extra = {}) {
  return {
    id: gate.id,
    kind: gate.kind,
    blocking: gate.blocking,
    status,
    detail,
    score: null,
    artifacts: {},
    ...extra,
  };
}

async function writeGateLog(context, gate, name, text) {
  if (!context.artifactsDir || !text.trim()) {
    return null;
  }
  const relative = path.join("gates", `${gate.id}-${name}.log`);
  await writeText(path.join(context.artifactsDir, relative), tail(text));
  return relative;
}

async function runCommandGate(context, gate, command) {
  const result = await context.runProcess(command, [], {
    cwd: context.worktree,
    env: context.env,
    timeoutMs: gate.timeout_seconds * 1000,
    shell: true,
  });
  const log = await writeGateLog(context, gate, "output", `${result.stdout}\n${result.stderr}`);
  const detail = result.timedOut
    ? `timed out after ${gate.timeout_seconds}s`
    : result.code === 0
      ? "exit 0"
      : `exit ${result.code}: ${tail(result.stderr || result.stdout).split("\n").filter(Boolean).slice(-3).join(" | ") || "no output"}`;
  return verdict(gate, result.code === 0 && !result.timedOut ? "pass" : "fail", detail, {
    command,
    exit_code: result.code,
    timed_out: result.timedOut,
    artifacts: log ? { output: log } : {},
  });
}

// Affected-tests gate: `agentify test --since <base> --run`. Run through the
// Agentify under test (this package's own CLI), never whatever `agentify` is on
// PATH, so the loop always grades with the code it ships with.
async function runAgentifyTestsGate(context, gate) {
  const argv = [AGENTIFY_CLI_PATH, "test", "--since", context.baseSha, "--run", "--json"];
  const result = await context.runProcess(process.execPath, argv, {
    cwd: context.worktree,
    env: context.env,
    timeoutMs: gate.timeout_seconds * 1000,
  });
  const log = await writeGateLog(context, gate, "output", `${result.stdout}\n${result.stderr}`);

  let selection = null;
  try {
    selection = JSON.parse(result.stdout);
  } catch {
    // Non-JSON stdout means the command failed before producing a report;
    // the exit code below is then the only signal.
  }

  if (result.timedOut) {
    return verdict(gate, "fail", `timed out after ${gate.timeout_seconds}s`, { artifacts: log ? { output: log } : {} });
  }
  if (!selection) {
    return verdict(gate, "error", `agentify test produced no report (exit ${result.code}): ${tail(result.stderr).split("\n").filter(Boolean).slice(-2).join(" | ")}`, {
      exit_code: result.code,
      artifacts: log ? { output: log } : {},
    });
  }

  const selected = selection.selected_tests?.length ?? 0;
  // No affected tests is a pass, not a silent hole: the report says so
  // explicitly so "0 selected" never reads as "0 failures".
  if (!selection.run) {
    return verdict(gate, "pass", `no affected test command for ${selection.changed_file_count ?? 0} changed file(s)`, {
      selected_tests: selected,
      artifacts: log ? { output: log } : {},
    });
  }
  return verdict(gate, selection.run.passed ? "pass" : "fail", `${selected} affected test file(s), ${selection.run.passed ? "all passing" : "failures reported"}`, {
    selected_tests: selected,
    exit_code: result.code,
    artifacts: log ? { output: log } : {},
  });
}

/**
 * Locate the screenshot helper.
 *
 * It must be the copy installed *in the target repo*: the script imports
 * `playwright` as a bare specifier, which Node resolves from the script's own
 * directory upward. Agentify's bundled copy would therefore look inside
 * Agentify's own node_modules and never find the repo's Playwright. The bundled
 * path is a last resort that exists only so the failure is a clear
 * "Playwright is not available" rather than "file not found".
 */
export async function resolveCaptureScript(worktree) {
  const candidates = [
    path.join(worktree, ".claude", "skills", "ui-screenshot-eval", "scripts", "capture.mjs"),
    path.join(worktree, ".codex", "skills", "ui-screenshot-eval", "scripts", "capture.mjs"),
    path.join(worktree, ".gemini", "skills", "ui-screenshot-eval", "scripts", "capture.mjs"),
    path.join(worktree, "node_modules", "agentify", "skills", "ui-screenshot-eval", "scripts", "capture.mjs"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return { path: candidate, installed: true };
    }
  }
  return { path: BUNDLED_CAPTURE_SCRIPT, installed: false };
}

async function runVisualGate(context, gate) {
  const script = await context.resolveCaptureScript(context.worktree);
  if (!script.installed) {
    return verdict(gate, "error", "ui-screenshot-eval is not installed in the target repo, so Playwright cannot be resolved. Run: agentify skill install ui-screenshot-eval");
  }

  const outDir = path.join(context.artifactsDir, "gates", `${gate.id}-capture`);
  const argv = [
    script.path,
    "--url", gate.url,
    "--out", outDir,
    "--viewport", gate.viewport,
    ...(gate.test_id ? ["--test-id", gate.test_id] : ["--selector", gate.selector]),
    ...(gate.wait_for ? ["--wait-for", gate.wait_for] : []),
  ];
  const result = await context.runProcess(process.execPath, argv, {
    cwd: context.worktree,
    env: context.env,
    timeoutMs: gate.timeout_seconds * 1000,
  });
  const log = await writeGateLog(context, gate, "capture", `${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 || result.timedOut) {
    return verdict(gate, "error", `screenshot capture failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ${tail(result.stderr).split("\n").filter(Boolean).slice(-2).join(" | ")}`, {
      artifacts: log ? { capture: log } : {},
    });
  }

  const shotPath = path.join(outDir, gate.compare === "element" ? "element.png" : "full-page.png");
  let candidate;
  try {
    candidate = decodePng(await context.readFile(shotPath));
  } catch (error) {
    return verdict(gate, "error", `captured screenshot could not be read: ${error.message}`, {
      artifacts: log ? { capture: log } : {},
    });
  }

  // Score against every reference and keep the best: multiple node pictures
  // describe the same target (states, crops, breakpoints), so the closest one
  // is the relevant comparison, and the rest are reported for context.
  const comparisons = [];
  for (const reference of gate.reference) {
    const referencePath = path.isAbsolute(reference) ? reference : path.join(context.root, reference);
    try {
      const referenceImage = decodePng(await context.readFile(referencePath));
      comparisons.push({ reference, ...compareImages(referenceImage, candidate) });
    } catch (error) {
      comparisons.push({ reference, error: error.message, score: null });
    }
  }

  const scored = comparisons.filter((entry) => typeof entry.score === "number");
  if (scored.length === 0) {
    return verdict(gate, "error", `no reference image could be read (${comparisons.map((entry) => `${entry.reference}: ${entry.error}`).join("; ")})`, {
      comparisons,
      artifacts: log ? { capture: log } : {},
    });
  }

  const best = scored.reduce((left, right) => (right.score > left.score ? right : left));
  const passed = best.score >= gate.min_score;
  return verdict(gate, passed ? "pass" : "fail", `${best.basis} similarity ${best.score.toFixed(4)} vs ${best.reference} (threshold ${gate.min_score})${best.basis === "structural" ? " — sizes differ, so this is a layout-structure score, not a pixel match" : ""}`, {
    score: best.score,
    basis: best.basis,
    min_score: gate.min_score,
    comparisons,
    artifacts: {
      ...(log ? { capture: log } : {}),
      screenshot: path.relative(context.artifactsDir, shotPath),
    },
  });
}

/** Parse a reviewer's reply into a verdict, or null when it emitted none. */
export function parseReviewVerdict(output) {
  const match = REVIEW_VERDICT_PATTERN.exec(String(output || ""));
  if (!match) {
    return null;
  }
  return {
    verdict: match[1].toLowerCase(),
    reason: (match[2] || "").trim() || null,
  };
}

async function runReviewGate(context, gate) {
  const brief = String(gate.focus || context.intent || "").trim();
  const focus = [brief, REVIEW_VERDICT_INSTRUCTION].filter(Boolean).join("\n\n");

  const result = await context.delegate("review", focus, { diffRef: context.baseSha });
  const log = await writeGateLog(context, gate, "review", String(result.output || ""));

  if (result.status === "budget_blocked" || result.status === "budget_stopped") {
    return verdict(gate, "error", `review did not complete: ${result.status} (${result.budget_stop_reason || result.error || "budget"})`, {
      artifacts: log ? { review: log } : {},
    });
  }

  const parsed = context.parseReviewVerdict(result.output);
  if (!parsed) {
    // Fail-closed: an unparseable review is an unusable signal, and treating
    // it as approval would let a crashed or truncated reviewer wave work
    // through.
    return verdict(gate, "error", "reviewer returned no VERDICT line, so the review is unusable as a gate", {
      provider: result.provider ?? null,
      artifacts: log ? { review: log } : {},
    });
  }

  return verdict(gate, parsed.verdict === "pass" ? "pass" : "fail", parsed.reason || `reviewer said ${parsed.verdict}`, {
    provider: result.provider ?? null,
    model: result.model ?? null,
    cost_usd: result.cost_usd ?? null,
    artifacts: log ? { review: log } : {},
  });
}

async function runRiskGate(context, gate) {
  let report;
  try {
    report = await context.buildRiskReport(context.worktree, { since: context.baseSha, config: context.config });
  } catch (error) {
    return verdict(gate, "error", `risk report unavailable: ${error.message}`);
  }
  const level = report.risk?.level ?? "none";
  const withinCeiling = RISK_LEVELS.indexOf(level) <= RISK_LEVELS.indexOf(gate.max_level);
  return verdict(gate, withinCeiling ? "pass" : "fail", `blast radius ${level} (${report.risk?.score ?? "?"}/100), ceiling ${gate.max_level}`, {
    level,
    risk_score: report.risk?.score ?? null,
    impacted_modules: report.impacted?.modules?.length ?? 0,
  });
}

/** Run one gate and return its verdict. Never throws for gate-level failures. */
export async function runGate(context, gate) {
  const startedAt = context.now();
  let result;
  try {
    switch (gate.kind) {
      case "command":
      case "playwright":
        result = await runCommandGate(context, gate, gate.run);
        break;
      case "agentify-tests":
        result = await runAgentifyTestsGate(context, gate);
        break;
      case "visual":
        result = await runVisualGate(context, gate);
        break;
      case "review":
        result = await runReviewGate(context, gate);
        break;
      case "risk":
        result = await runRiskGate(context, gate);
        break;
      default:
        result = verdict(gate, "error", `unsupported gate kind "${gate.kind}"`);
    }
  } catch (error) {
    // A gate runner that throws is a harness fault, not a verdict about the
    // code. Surface it as "error" so it is never counted as a pass.
    result = verdict(gate, "error", `gate runner failed: ${redactSensitiveText(String(error?.message || error)).slice(0, 500)}`);
  }
  return { ...result, duration_ms: context.now() - startedAt };
}

/**
 * Run gates in order, stopping after the first blocking failure.
 *
 * Short-circuiting is what keeps an iteration cheap: there is no point paying
 * for a cross-vendor review or a browser launch when the build is broken. Gates
 * never reached are reported as "skipped" so the ladder shows how far the
 * iteration actually got.
 */
export async function runGates(context, gates) {
  const verdicts = [];
  let blocked = false;
  for (const gate of gates) {
    if (blocked) {
      verdicts.push({ ...verdict(gate, "skipped", "an earlier blocking gate failed"), duration_ms: 0 });
      continue;
    }
    const result = await runGate(context, gate);
    verdicts.push(result);
    if (gate.blocking && result.status !== "pass") {
      blocked = true;
    }
  }
  return { verdicts, ...scoreGates(verdicts) };
}

/**
 * Collapse verdicts into the number the loop compares between iterations.
 *
 * Blocking gates are what "done" means, so only they count toward the score:
 * an advisory gate flipping green must never look like progress toward
 * shipping, and must never make a stalled loop look like it is still moving.
 * A scored gate (visual similarity) contributes its own fractional score so
 * getting closer to the design registers as progress even before it passes.
 */
export function scoreGates(verdicts) {
  const blocking = verdicts.filter((entry) => entry.blocking);
  const total = blocking.length;
  let earned = 0;
  for (const entry of blocking) {
    if (entry.status === "pass") {
      earned += 1;
    } else if (typeof entry.score === "number" && Number.isFinite(entry.score)) {
      earned += Math.max(0, Math.min(1, entry.score));
    }
  }
  return {
    passed: total > 0 && blocking.every((entry) => entry.status === "pass"),
    score: total > 0 ? Number((earned / total).toFixed(4)) : 0,
    gates_passed: blocking.filter((entry) => entry.status === "pass").length,
    gates_total: total,
  };
}

/**
 * Build the failure digest handed to the next iteration.
 *
 * The agent gets what failed and the tail of why — not the whole log, which
 * would crowd out the brief itself in the prompt.
 */
export function describeFailures(verdicts) {
  return verdicts
    .filter((entry) => entry.status === "fail" || entry.status === "error")
    .map((entry) => `- gate "${entry.id}" (${entry.kind}) ${entry.status}: ${entry.detail}`)
    .join("\n");
}

export { tail as tailGateOutput };

/**
 * Assemble the injectable context a gate run needs.
 *
 * Every side effect a gate can have — spawning, reading files, paying a
 * provider, opening the index — arrives through this object, so tests drive
 * the full ladder without a browser, a repo, or a dollar of spend.
 */
export function createGateContext({
  root,
  worktree,
  config,
  baseSha,
  artifactsDir,
  env,
  intent,
  delegate,
  overrides = {},
}) {
  return {
    root,
    worktree,
    config,
    baseSha,
    artifactsDir,
    env,
    intent,
    delegate,
    runProcess,
    resolveCaptureScript,
    parseReviewVerdict,
    readFile: (target) => readFileBuffer(target),
    buildRiskReport: async (repoRoot, options) => {
      const { buildRiskReport } = await import("./risk.js");
      return buildRiskReport(repoRoot, options);
    },
    now: () => Date.now(),
    ...overrides,
  };
}

/** Default gate ladder for a scaffolded brief: cheap checks first. */
export function defaultGates({ ui = false } = {}) {
  return [
    { id: "build", kind: "command", run: "echo 'replace with the repo build command' && exit 1" },
    { id: "lint", kind: "command", run: "echo 'replace with the repo lint command' && exit 1" },
    { id: "tests", kind: "agentify-tests" },
    ...(ui
      ? [
        { id: "e2e", kind: "playwright", run: "npx playwright test" },
        {
          id: "visual",
          kind: "visual",
          reference: ["docs/design/reference.png"],
          url: "http://localhost:3000/",
          test_id: "replace-with-feature-root-testid",
          min_score: 0.9,
        },
      ]
      : []),
    { id: "review", kind: "review" },
  ];
}
