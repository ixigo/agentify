// The brief is the loop's input contract: what to build, what "done" means,
// and what the run is allowed to spend getting there.
//
// It exists as a separate, validatable artifact rather than a pile of CLI flags
// because an unattended run has nobody to ask. Every ambiguity has to be
// resolved before the first provider process starts, and every ceiling has to
// be explicit — a loop without a budget, an iteration cap, and a gate list is
// exactly the runaway this design exists to prevent.
//
// Briefs can be committed (reviewable, re-runnable) or synthesized on the fly
// from a Jira key, a Figma node, or a sentence. Synthesized briefs are written
// into the run directory so a run is always reproducible from an artifact.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { exists, readText, writeText } from "./fs.js";
import { defaultGates, normalizeGates } from "./loop-gates.js";
import { parseFigmaUrl } from "../../skills/figma-ui-build/scripts/figma-ui-build.mjs";

const execFileAsync = promisify(execFile);

export const LOOP_BRIEF_SCHEMA_VERSION = "loop-brief-v1";

export const LOOP_SOURCE_KINDS = ["text", "jira", "figma", "bug"];
export const LOOP_ROUTES = ["quick", "implement", "heavy"];
export const LOOP_PR_MODES = ["none", "draft"];

// Deliberately conservative: a first unattended run should stop early and
// cheaply rather than grind. Raise them in the brief once a repo's loop is
// trusted.
export const DEFAULT_LOOP_LIMITS = {
  max_iterations: 6,
  max_budget_usd: 6.0,
  max_turns: 30,
  timeout_seconds: 900,
};

// Paths an autonomous agent must not be able to rewrite from inside a loop
// worktree. CI definitions and agent guidance are the two that turn a bad
// iteration into a persistent compromise, so they are refused by default and
// the brief can only add to this list, never shrink it.
export const ALWAYS_FORBIDDEN_PATHS = [
  ".github/workflows/**",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  ".claude/settings.json",
  ".claude/settings.local.json",
];

export function resolveLoopPaths(root, config = {}) {
  const briefsDir = typeof config.loop?.briefsDir === "string" && config.loop.briefsDir.trim()
    ? config.loop.briefsDir.trim()
    : "loops";
  return {
    briefsDir: path.join(root, briefsDir),
    runsRoot: path.join(root, ".agentify", "loop", "runs"),
    worktreesRoot: path.join(root, ".agentify", "loop", "worktrees"),
  };
}

function fail(source, message) {
  throw new Error(`Invalid loop brief${source ? ` (${source})` : ""}: ${message}`);
}

function requirePositiveNumber(value, label, source, { integer = false } = {}) {
  const num = Number(value);
  if (value === null || value === undefined || value === "" || typeof value === "boolean"
    || !Number.isFinite(num) || num <= 0 || (integer && !Number.isInteger(num))) {
    fail(source, `${label} must be a positive ${integer ? "integer" : "number"}, got "${value}"`);
  }
  return num;
}

function stringArray(value, label, source) {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(source, `${label} must be a list of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

/** Turn arbitrary text into a stable, filesystem- and branch-safe id. */
export function slugify(value, fallback = "loop") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function normalizeSource(raw, source) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const kind = String(value.kind || "text").trim().toLowerCase();
  if (!LOOP_SOURCE_KINDS.includes(kind)) {
    fail(source, `source.kind must be one of ${LOOP_SOURCE_KINDS.join(", ")}, got "${value.kind}"`);
  }
  const figmaImages = stringArray(value.figma_images, "source.figma_images", source);
  const figmaUrl = value.figma_url ? String(value.figma_url).trim() : null;

  if (kind === "figma") {
    // Either input alone is enough: the node URL gives cached metadata, the
    // pictures give rendered truth, and most runs supply both.
    if (!figmaUrl && figmaImages.length === 0) {
      fail(source, "a figma source needs source.figma_url, source.figma_images, or both");
    }
    if (figmaUrl) {
      try {
        parseFigmaUrl(figmaUrl);
      } catch (error) {
        fail(source, `source.figma_url is not a usable Figma node URL (${error.message}); it must include a node-id`);
      }
    }
  }
  if (kind === "jira" && !value.jira_key) {
    fail(source, "a jira source needs source.jira_key");
  }

  return {
    kind,
    jira_key: value.jira_key ? String(value.jira_key).trim() : null,
    figma_url: figmaUrl,
    figma_images: figmaImages,
    url: value.url ? String(value.url).trim() : null,
  };
}

function normalizeServe(raw, source) {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(source, "serve must be a mapping with command and url");
  }
  return {
    command: requireNonEmpty(raw.command, "serve.command", source),
    url: requireNonEmpty(raw.url, "serve.url", source),
    ready_timeout_seconds: raw.ready_timeout_seconds === undefined || raw.ready_timeout_seconds === null
      ? 120
      : requirePositiveNumber(raw.ready_timeout_seconds, "serve.ready_timeout_seconds", source),
  };
}

function requireNonEmpty(value, label, source) {
  const text = String(value ?? "").trim();
  if (!text) {
    fail(source, `${label} is required`);
  }
  return text;
}

function normalizeShip(raw, source) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pr = String(value.pr || "none").trim().toLowerCase();
  if (!LOOP_PR_MODES.includes(pr)) {
    fail(source, `ship.pr must be one of ${LOOP_PR_MODES.join(", ")}, got "${value.pr}"`);
  }
  const type = String(value.type || "feat").trim();
  if (!/^[a-z]+$/.test(type)) {
    fail(source, `ship.type must be a conventional-commit type such as feat or fix, got "${value.type}"`);
  }
  return {
    // Committing is local and reversible, so it is on by default. Opening a PR
    // is outward-facing and stays opt-in.
    commit: value.commit !== false,
    pr,
    type,
    scope: value.scope ? String(value.scope).trim() : null,
    // Free-form trailer (a Jira key, an issue URL) appended to the commit body.
    refs: value.refs ? String(value.refs).trim() : null,
  };
}

/**
 * Validate and normalize a brief.
 *
 * Ceilings are mandatory by omission-with-defaults rather than by requiring the
 * author to write them: an unset limit resolves to the conservative default
 * above, never to "unbounded".
 */
export function validateLoopBrief(raw, source = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(source, "brief must be a YAML mapping");
  }
  if (raw.schema !== LOOP_BRIEF_SCHEMA_VERSION) {
    fail(source, `schema must be "${LOOP_BRIEF_SCHEMA_VERSION}", got "${raw.schema}"`);
  }
  const id = String(raw.id || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    fail(source, `id must be alphanumeric with dashes/underscores, got "${raw.id}"`);
  }
  const intent = requireNonEmpty(raw.intent, "intent", source);

  const limitsRaw = raw.limits && typeof raw.limits === "object" && !Array.isArray(raw.limits) ? raw.limits : {};
  const limits = {
    max_iterations: limitsRaw.max_iterations === undefined || limitsRaw.max_iterations === null
      ? DEFAULT_LOOP_LIMITS.max_iterations
      : requirePositiveNumber(limitsRaw.max_iterations, "limits.max_iterations", source, { integer: true }),
    max_budget_usd: limitsRaw.max_budget_usd === undefined || limitsRaw.max_budget_usd === null
      ? DEFAULT_LOOP_LIMITS.max_budget_usd
      : requirePositiveNumber(limitsRaw.max_budget_usd, "limits.max_budget_usd", source),
    max_turns: limitsRaw.max_turns === undefined || limitsRaw.max_turns === null
      ? DEFAULT_LOOP_LIMITS.max_turns
      : requirePositiveNumber(limitsRaw.max_turns, "limits.max_turns", source, { integer: true }),
    timeout_seconds: limitsRaw.timeout_seconds === undefined || limitsRaw.timeout_seconds === null
      ? DEFAULT_LOOP_LIMITS.timeout_seconds
      : requirePositiveNumber(limitsRaw.timeout_seconds, "limits.timeout_seconds", source),
  };
  // Per-iteration spend defaults to an even split of the run ceiling, so the
  // documented worst case (iterations x iteration budget) really is the run
  // ceiling rather than a number that can be exceeded by construction.
  limits.iteration_budget_usd = limitsRaw.iteration_budget_usd === undefined || limitsRaw.iteration_budget_usd === null
    ? Number((limits.max_budget_usd / limits.max_iterations).toFixed(4))
    : requirePositiveNumber(limitsRaw.iteration_budget_usd, "limits.iteration_budget_usd", source);

  const route = String(raw.route || "implement").trim().toLowerCase();
  if (!LOOP_ROUTES.includes(route)) {
    fail(source, `route must be one of ${LOOP_ROUTES.join(", ")}, got "${raw.route}"`);
  }

  const candidates = raw.candidates === undefined || raw.candidates === null
    ? 1
    : requirePositiveNumber(raw.candidates, "candidates", source, { integer: true });
  if (candidates > 8) {
    fail(source, `candidates must be 8 or fewer, got ${candidates} (each candidate is a full worktree and a full budget)`);
  }

  return {
    schema: LOOP_BRIEF_SCHEMA_VERSION,
    id,
    title: String(raw.title || "").trim() || id,
    intent,
    source: normalizeSource(raw.source, source),
    acceptance: stringArray(raw.acceptance, "acceptance", source),
    setup: stringArray(raw.setup, "setup", source),
    serve: normalizeServe(raw.serve, source),
    gates: normalizeGates(raw.gates, source),
    limits,
    route,
    candidates,
    base_ref: String(raw.base_ref || "HEAD").trim(),
    branch_prefix: String(raw.branch_prefix || "loop/").trim(),
    // The brief may extend the built-in refusals but never replace them.
    forbidden_paths: [...new Set([...ALWAYS_FORBIDDEN_PATHS, ...stringArray(raw.forbidden_paths, "forbidden_paths", source)])],
    ship: normalizeShip(raw.ship, source),
  };
}

export async function loadLoopBrief(root, ref, config = {}) {
  if (!ref || !String(ref).trim()) {
    throw new Error("loop requires a brief: agentify loop run <brief-id-or-path>");
  }
  const requested = String(ref).trim();
  const { briefsDir } = resolveLoopPaths(root, config);
  const candidates = /\.ya?ml$/i.test(requested)
    ? [path.resolve(root, requested)]
    : [path.join(briefsDir, `${requested}.yaml`), path.join(briefsDir, `${requested}.yml`)];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      const parsed = parseYaml(await readText(candidate));
      return { brief: validateLoopBrief(parsed, path.relative(root, candidate)), path: candidate };
    }
  }
  throw new Error(`No loop brief found for "${requested}" (looked in ${candidates.map((entry) => path.relative(root, entry)).join(", ")}). Create one with: agentify loop init ${requested}`);
}

export function renderLoopBrief(brief) {
  return stringifyYaml(brief);
}

export async function initLoopBrief(root, name, config = {}, { dryRun = false, ui = false } = {}) {
  const id = slugify(name || "sample");
  const { briefsDir } = resolveLoopPaths(root, config);
  const briefPath = path.join(briefsDir, `${id}.yaml`);
  if (await exists(briefPath)) {
    throw new Error(`Loop brief already exists at ${path.relative(root, briefPath)}`);
  }

  const draft = {
    schema: LOOP_BRIEF_SCHEMA_VERSION,
    id,
    title: "Describe the change in one line.",
    intent: "Replace with the implementation brief the agent should work from.",
    source: { kind: "text" },
    acceptance: ["Replace with a concrete, checkable acceptance criterion."],
    setup: [],
    serve: ui ? { command: "npm run dev", url: "http://localhost:3000", ready_timeout_seconds: 120 } : null,
    gates: defaultGates({ ui }),
    limits: { ...DEFAULT_LOOP_LIMITS },
    route: "implement",
    candidates: 1,
    base_ref: "HEAD",
    branch_prefix: "loop/",
    forbidden_paths: [],
    ship: { commit: true, pr: "none", type: "feat", scope: null },
  };
  // Validate the scaffold so `loop init` can never emit a brief that
  // `loop run` would reject.
  const brief = validateLoopBrief(draft, `${id}.yaml`);

  if (!dryRun) {
    await writeText(briefPath, stringifyYaml(draft));
  }
  return { command: "loop", action: "init", path: briefPath, brief, dry_run: dryRun };
}

// ---------------------------------------------------------------------------
// Ingest: build a brief from a ticket, a design, or a sentence.
// ---------------------------------------------------------------------------

/**
 * Fetch a Jira work item through `acli`.
 *
 * `acli` is used rather than the Atlassian MCP server because a loop is meant
 * to run unattended (and from cron): the MCP path needs an interactive OAuth
 * handshake that a headless run cannot complete. Flag support varies across
 * acli versions, so a `--json` attempt degrades to the plain text view rather
 * than failing the run.
 */
export async function fetchJiraWorkItem(key, { exec = execFileAsync, timeoutMs = 60000 } = {}) {
  const normalized = String(key || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(normalized)) {
    throw new Error(`"${key}" is not a Jira work item key (expected something like XCT-10874)`);
  }

  const attempts = [
    ["jira", "workitem", "view", normalized, "--json"],
    ["jira", "workitem", "view", normalized],
  ];
  let lastError = null;
  for (const args of attempts) {
    try {
      const { stdout } = await exec("acli", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      const text = String(stdout || "").trim();
      if (!text) {
        continue;
      }
      try {
        const parsed = JSON.parse(text);
        const fields = parsed.fields || parsed;
        return {
          key: normalized,
          summary: String(fields.summary || parsed.summary || "").trim(),
          description: String(fields.description || parsed.description || "").trim(),
          type: String(fields.issuetype?.name || parsed.type || "").trim() || null,
          raw: text,
          format: "json",
        };
      } catch {
        // Text view: keep it whole. It is the brief's body either way, and
        // guessing at a field layout across acli versions would be worse.
        return { key: normalized, summary: "", description: text, type: null, raw: text, format: "text" };
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not read Jira work item ${normalized} via acli: ${String(lastError?.stderr || lastError?.message || "acli failed").trim()}. Check that acli is installed and authenticated (acli jira workitem view ${normalized}).`);
}

function bugIntent(text) {
  return [
    "Fix the following defect.",
    "",
    text,
    "",
    "Reproduce it first, add or extend a test that fails for this reason, then make the smallest change that makes it pass.",
  ].join("\n");
}

function figmaIntent(source, extra) {
  const lines = ["Build the UI for the following design."];
  if (source.figma_url) {
    lines.push("", `Figma node: ${source.figma_url}`);
  }
  if (source.figma_images.length > 0) {
    lines.push("", `Reference screenshots of the node (visual source of truth): ${source.figma_images.join(", ")}`);
  }
  if (extra) {
    lines.push("", extra);
  }
  lines.push(
    "",
    "Use the figma-ui-build and ui-screenshot-eval skills. Match the reference for spacing, type scale, color, radius, and states.",
    "Reuse the app's existing components and design tokens; do not add dependencies.",
  );
  return lines.join("\n");
}

/**
 * Build a brief from CLI inputs.
 *
 * The result is a plain object, validated by the caller, so a synthesized brief
 * goes through exactly the same schema as a committed one.
 */
export async function ingestLoopBrief(root, options = {}) {
  const gatesOverride = Array.isArray(options.gates) ? options.gates : null;
  const figmaImages = (options.figmaImages || []).map((entry) => String(entry).trim()).filter(Boolean);
  const task = String(options.task || "").trim();

  // Check the design references now: a missing screenshot discovered halfway
  // through an unattended run wastes a worktree and a budget.
  for (const image of figmaImages) {
    if (!(await exists(path.isAbsolute(image) ? image : path.join(root, image)))) {
      throw new Error(`Figma reference image not found: ${image}`);
    }
  }

  let source;
  let title;
  let intent;
  let refs = null;
  let idSeed;
  let shipType = "feat";

  if (options.jira) {
    const item = await fetchJiraWorkItem(options.jira, { exec: options.exec });
    source = { kind: "jira", jira_key: item.key };
    title = item.summary || `${item.key}`;
    idSeed = `${item.key}-${item.summary || ""}`;
    refs = item.key;
    shipType = /bug/i.test(item.type || "") ? "fix" : "feat";
    intent = [
      `${item.key}${item.summary ? `: ${item.summary}` : ""}`,
      "",
      item.description || "(no description on the work item)",
      ...(task ? ["", "Additional direction from the operator:", task] : []),
    ].join("\n");
    // A Figma design can accompany a ticket; keep both.
    if (options.figma || figmaImages.length > 0) {
      source.figma_url = options.figma ? String(options.figma).trim() : null;
      source.figma_images = figmaImages;
      intent = `${intent}\n\n${figmaIntent({ figma_url: source.figma_url, figma_images: figmaImages }, null)}`;
    }
  } else if (options.figma || figmaImages.length > 0) {
    source = {
      kind: "figma",
      figma_url: options.figma ? String(options.figma).trim() : null,
      figma_images: figmaImages,
    };
    const parsed = source.figma_url ? parseFigmaUrl(source.figma_url) : null;
    title = task || (parsed ? `Figma node ${parsed.nodeId}` : path.basename(figmaImages[0], path.extname(figmaImages[0])));
    idSeed = title;
    intent = figmaIntent(source, task || null);
  } else if (options.bug) {
    const text = String(options.bug).trim();
    if (!text) {
      throw new Error("loop run --bug requires a description of the defect");
    }
    source = { kind: "bug" };
    title = text.split("\n")[0].slice(0, 80);
    idSeed = title;
    shipType = "fix";
    intent = bugIntent(text);
  } else if (task) {
    source = { kind: "text" };
    title = task.split("\n")[0].slice(0, 80);
    idSeed = title;
    intent = task;
  } else {
    throw new Error('loop run needs a brief or a source: pass a brief id, or one of --task "<text>", --jira <KEY>, --figma <url>, --figma-image <path>, --bug "<text>"');
  }

  const draft = {
    schema: LOOP_BRIEF_SCHEMA_VERSION,
    id: options.id ? slugify(options.id) : slugify(idSeed),
    title,
    intent,
    source,
    acceptance: options.acceptance || [],
    setup: options.setup || [],
    serve: options.serve || null,
    gates: gatesOverride || [],
    limits: options.limits || { ...DEFAULT_LOOP_LIMITS },
    route: options.route || "implement",
    candidates: options.candidates || 1,
    base_ref: options.baseRef || "HEAD",
    branch_prefix: options.branchPrefix || "loop/",
    forbidden_paths: options.forbiddenPaths || [],
    ship: {
      commit: options.commit !== false,
      pr: options.pr || "none",
      type: options.shipType || shipType,
      scope: options.scope || null,
      refs,
    },
  };
  return draft;
}

/**
 * Infer a gate ladder from the repo when the operator supplied no brief.
 *
 * Only commands the repo actually declares become gates — a guessed `npm test`
 * that does not exist would fail every iteration forever and read as the
 * agent's fault. What cannot be inferred is simply left out, and the returned
 * notes say what was skipped, so a thin ladder is visible before the run
 * starts rather than discovered afterwards in a green report that checked
 * almost nothing.
 */
export async function inferGates(root, { hasVisualReference = false } = {}) {
  const gates = [];
  const notes = [];
  const packageJsonPath = path.join(root, "package.json");
  let scripts = {};
  if (await exists(packageJsonPath)) {
    try {
      scripts = JSON.parse(await readText(packageJsonPath)).scripts || {};
    } catch {
      scripts = {};
    }
  }

  const runner = (await exists(path.join(root, "pnpm-lock.yaml"))) ? "pnpm"
    : (await exists(path.join(root, "yarn.lock"))) ? "yarn"
      : "npm run";

  for (const script of ["build", "lint", "typecheck"]) {
    if (scripts[script]) {
      gates.push({ id: script, kind: "command", run: `${runner} ${script}` });
    } else {
      notes.push(`no "${script}" script in package.json, so no ${script} gate was inferred`);
    }
  }
  // Affected-tests is index-derived, so it works without a declared script and
  // stays cheap on large suites.
  gates.push({ id: "tests", kind: "agentify-tests" });
  if (scripts["test:e2e"] || await exists(path.join(root, "playwright.config.ts")) || await exists(path.join(root, "playwright.config.js"))) {
    gates.push({ id: "e2e", kind: "playwright", run: scripts["test:e2e"] ? `${runner} test:e2e` : "npx playwright test" });
  }
  if (hasVisualReference) {
    // A visual gate needs a URL and a stable anchor, and neither can be guessed
    // from the repo. Rather than emit a gate that would fail validation, say
    // plainly that the design reference is going in unmeasured.
    notes.push("a design reference was supplied but no visual gate was inferred: add a `visual` gate with url and test_id to a brief, or the design match will not be measured");
  }
  gates.push({ id: "review", kind: "review" });
  return { gates, notes };
}
