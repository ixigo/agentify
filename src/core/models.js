import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { checkRollingBudget, describeBudgetSource, resolveBudgetPolicy, resolveRouteLimits } from "./budget.js";
import { getChangedFilesSince } from "./git.js";
import {
  ROUTE_POLICY_VERSION,
  buildFallbackChain,
  classifyTaskIntent,
  isAliasModel,
  loadRouteEvidence,
  resolveDelegateProviderPolicy,
  resolveProfileDefinitions,
  resolveProfileSelection,
  resolveRouteTier,
  resolveTierModels,
  selectFromChain,
  selectTier,
} from "./profiles.js";
import {
  DELEGATE_PROVIDER_NAMES,
  getDelegateAdapter,
  getProviderBootstrap,
} from "./provider-registry.js";

// Normalized output parsers live with their adapters in the provider
// registry; re-exported here for existing consumers (eval.js, tests).
export {
  parseClaudeJsonOutput,
  parseCodexJsonOutput,
  parseGeminiJsonOutput,
  parseOpenCodeJsonOutput,
} from "./provider-registry.js";

const execFileAsync = promisify(execFile);

export const DELEGATE_TIMEOUT_MS = 600000;
export const DELEGATION_SCHEMA_VERSION = "delegation-v2";

// Route defaults are chosen to stay stable across model releases: Claude Code
// accepts version-independent aliases (haiku/sonnet/opus), and Codex uses the
// CLI's own configured default when model is null. Everything is overridable
// under `models.routes` in .agentify.yaml.
//
// Every default route carries a hard ceiling (dollars, turns, wall-clock) so
// no Agentify-initiated paid run is ever unbounded. Fallback across vendors
// keeps the original ceiling — it never resets or raises the budget.
export const DEFAULT_MODEL_ROUTES = {
  quick: {
    provider: "claude",
    model: "haiku",
    maxBudgetUsd: 0.10,
    maxTurns: 4,
    timeoutSeconds: 120,
    effort: null,
    use: "Small, low-impact edits, mechanical changes, quick questions",
  },
  implement: {
    provider: "claude",
    model: "sonnet",
    maxBudgetUsd: 1.00,
    maxTurns: 30,
    timeoutSeconds: 600,
    effort: null,
    use: "Standard feature work and multi-file refactors",
  },
  heavy: {
    provider: "claude",
    model: "opus",
    maxBudgetUsd: 2.50,
    maxTurns: 40,
    timeoutSeconds: 600,
    effort: null,
    use: "Architecture decisions, deep debugging, high-risk changes",
  },
  review: {
    provider: "codex",
    model: null,
    maxBudgetUsd: 0.75,
    maxTurns: 20,
    timeoutSeconds: 600,
    effort: null,
    use: "Independent post-change code review by a different model vendor",
  },
  research: {
    provider: "claude",
    model: "haiku",
    maxBudgetUsd: 0.25,
    maxTurns: 6,
    timeoutSeconds: 300,
    effort: null,
    use: "Fast exploration, summarization, and doc lookups",
  },
};

// Cross-vendor fallback is tier-equivalent and profile-bounded (see
// profiles.js): a missing provider falls back to the OTHER vendor's model at
// the same capability tier instead of a hard-coded model. This is what stops
// a missing Codex from silently becoming Claude opus (issue #295).

export function resolveModelRoutes(config = {}) {
  const configured = config.models?.routes && typeof config.models.routes === "object"
    ? config.models.routes
    : {};
  const routes = {};
  for (const [kind, route] of Object.entries(DEFAULT_MODEL_ROUTES)) {
    const override = configured[kind] && typeof configured[kind] === "object" ? configured[kind] : {};
    routes[kind] = { ...route, ...override };
  }
  for (const [kind, route] of Object.entries(configured)) {
    if (!routes[kind] && route && typeof route === "object" && route.provider) {
      // Custom routes get conservative default ceilings too — a route the
      // user adds must not be the one uncapped path.
      routes[kind] = {
        use: "",
        model: null,
        maxBudgetUsd: 1.00,
        maxTurns: 30,
        timeoutSeconds: 600,
        effort: null,
        ...route,
      };
    }
  }
  // Config validation derives from the registry (#297): a route naming a
  // provider without a delegate adapter fails loudly here, before any
  // routing decision can silently never resolve.
  for (const [kind, route] of Object.entries(routes)) {
    if (!getDelegateAdapter(route.provider)) {
      throw new Error(`models.routes.${kind}.provider "${route.provider}" is not a registered delegate provider. Registered: ${DELEGATE_PROVIDER_NAMES.join(", ")}`);
    }
  }
  return routes;
}

export function normalizeRouteKind(value, routes) {
  const kind = String(value || "").trim().toLowerCase();
  if (!routes[kind]) {
    throw new Error(`Unknown delegate kind "${value}". Available: ${Object.keys(routes).join(", ")}`);
  }
  return kind;
}

async function defaultCommandExists(command) {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", 'command -v -- "$1"', "sh", command]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

export async function detectDelegateProviders(runtime = {}) {
  const commandExists = runtime.commandExists || defaultCommandExists;
  const results = await Promise.all(
    DELEGATE_PROVIDER_NAMES.map((provider) => commandExists(getProviderBootstrap(provider)?.bin || provider)),
  );
  return Object.fromEntries(DELEGATE_PROVIDER_NAMES.map((provider, index) => [provider, results[index]]));
}

export function pickRouteTarget(route, availability, { kind, profileName = "balanced", config = {} } = {}) {
  const chain = buildFallbackChain({ kind, route, profileName, config });
  const target = selectFromChain(chain, availability);
  if (!target) {
    return null;
  }
  return { provider: target.provider, model: target.model, fallback: target.fallback };
}

// Resolve the full routing decision for one delegate run: governing profile,
// capability tier (evidence-adjusted, never past hard ceilings), fallback
// chain, limits, and alias-drift status. Deterministic for a fixed
// config/evidence, and returned verbatim by `route explain` / `--dry-run`.
export async function resolveRoutePolicy(root, config, kindInput, options = {}) {
  const routes = resolveModelRoutes(config);
  const kind = normalizeRouteKind(kindInput, routes);
  const requestedRoute = routes[kind];
  const route = { ...requestedRoute };

  const profileSelection = resolveProfileSelection(config, options, options.env || process.env);
  const definitions = resolveProfileDefinitions(config);
  const definition = definitions[profileSelection.name];

  const explicitOverride = options.provider !== undefined
    || (options.model !== undefined && options.model !== null);
  if (options.provider) {
    const provider = String(options.provider).trim().toLowerCase();
    if (!getDelegateAdapter(provider)) {
      throw new Error(`Unknown delegate provider "${options.provider}". Registered: ${DELEGATE_PROVIDER_NAMES.join(", ")}`);
    }
    route.provider = provider;
    route.model = options.model ?? null;
  }
  if (options.model !== undefined && options.model !== null) {
    route.model = String(options.model);
  }

  const evidence = options.evidence !== undefined ? options.evidence : await loadRouteEvidence(root);
  let tierDecision;
  if (explicitOverride) {
    // Explicit --provider/--model wins over every profile: the profile still
    // governs budgets/telemetry, but tier selection is skipped entirely.
    const tier = resolveRouteTier(kind, route);
    tierDecision = {
      base_tier: tier,
      selected: { provider: route.provider, model: route.model ?? null, tier, reason: "explicit_override" },
      considered: [],
    };
  } else {
    tierDecision = selectTier({ kind, route, profileName: profileSelection.name, definition, evidence, config });
  }
  const selected = tierDecision.selected;

  const chain = buildFallbackChain({
    kind,
    route: { ...route, provider: selected.provider, model: selected.model },
    tier: selected.tier,
    profileName: profileSelection.name,
    config,
  });

  return {
    policy_version: ROUTE_POLICY_VERSION,
    profile: {
      name: profileSelection.name,
      source: profileSelection.source,
      objective: definition.objective,
      quality_floor: definition.qualityFloor,
      max_tier_raise: definition.maxTierRaise,
    },
    kind,
    requested: {
      provider: requestedRoute.provider,
      model: requestedRoute.model ?? null,
      tier: resolveRouteTier(kind, requestedRoute),
    },
    selected: {
      provider: selected.provider,
      model: selected.model ?? null,
      tier: selected.tier,
      reason: selected.reason,
    },
    explicit_override: explicitOverride,
    alias_drift: {
      // Aliases (or a null CLI-default model) can change behavior across
      // provider releases without a config change; pin full model IDs in
      // governed profiles to silence this.
      requested_is_alias: isAliasModel(requestedRoute.provider, requestedRoute.model),
      selected_is_alias: isAliasModel(selected.provider, selected.model),
    },
    fallback_chain: chain,
    evidence_summary: {
      source: evidence?.source ?? null,
      runs_scanned: evidence?.runs_scanned ?? 0,
      considered: tierDecision.considered.map((candidate) => ({
        provider: candidate.provider,
        model: candidate.model ?? null,
        tier: candidate.tier,
        role: candidate.role,
        evidence: candidate.evidence,
      })),
    },
  };
}

// Dry-run routing explanation for `agentify route explain` and
// `delegate --dry-run`: everything the policy would do, no provider spawned.
export async function explainRoute(root, config, task, options = {}) {
  const routes = resolveModelRoutes(config);
  let kind = options.kind ? normalizeRouteKind(options.kind, routes) : null;
  let intent = null;
  if (!kind) {
    intent = classifyTaskIntent(task);
    kind = intent.kind;
  }
  const policy = await resolveRoutePolicy(root, config, kind, options);
  const budgetPolicy = resolveBudgetPolicy(config);
  const rolling = await checkRollingBudget(root, budgetPolicy);
  const cliOverrides = {
    maxBudgetUsd: options.maxBudgetUsd,
    maxTurns: options.maxTurns,
    effort: options.effort,
    // A --timeout override must show up in the dry-run limits exactly as the
    // real run would enforce it.
    timeoutSeconds: options.timeoutMs != null ? options.timeoutMs / 1000 : options.timeoutSeconds,
  };
  const limits = resolveRouteLimits({ ...routes[kind], model: policy.selected.model, provider: policy.selected.provider }, cliOverrides);
  const availability = await detectDelegateProviders(options.runtime || {});
  const target = selectFromChain(policy.fallback_chain, availability);
  if (target) {
    // A dry run must fail exactly where the real run would.
    assertEffortSupported(target.provider, limits);
  }
  return {
    command: "route",
    task: task || null,
    intent,
    signals: {
      write: options.write === true,
      intent: intent ? intent.kind : kind,
      intent_source: intent ? intent.matched_rule : "explicit_kind",
      diff_ref: options.diffRef || null,
      remaining_budget_usd: rolling.remaining_usd,
      evidence_runs: policy.evidence_summary.runs_scanned,
    },
    policy,
    limits: {
      max_budget_usd: limits.maxBudgetUsd,
      max_turns: limits.maxTurns,
      timeout_seconds: limits.timeoutSeconds,
      effort: limits.effort,
    },
    budget_source: describeBudgetSource(kind, config, cliOverrides),
    providers: availability,
    resolves_to: target
      ? { provider: target.provider, model: target.model, tier: target.tier, fallback: target.fallback, fallback_reason: target.fallback_reason }
      : null,
    unsupported_controls: target ? listUnsupportedControls(target.provider, limits) : [],
    enforcement: describeLimitEnforcement(target ? target.provider : policy.selected.provider),
  };
}

// Which of the configured ceilings the selected provider CLI can enforce
// natively, in-flight — declared by the provider's delegate adapter.
// Anything else is covered by Agentify's pre-run rolling budget check and
// the wall-clock timeout.
export function describeLimitEnforcement(provider) {
  const adapter = getDelegateAdapter(provider);
  if (adapter) {
    return { ...adapter.enforcement };
  }
  return { budget_usd: "pre-run-only", turns: "unavailable", timeout: "agentify" };
}

function requireDelegateAdapter(provider) {
  const adapter = getDelegateAdapter(provider);
  if (!adapter) {
    throw new Error(`No delegate adapter registered for provider "${provider}". Registered: ${DELEGATE_PROVIDER_NAMES.join(", ")}`);
  }
  return adapter;
}

// Ceilings the selected adapter cannot enforce natively in-flight. These are
// surfaced per run and in `agentify models` — a configured control is never
// silently ignored (#297). Dollar/turn ceilings without native enforcement
// still have the pre-run rolling check + wall-clock timeout envelope.
export function listUnsupportedControls(provider, limits = {}) {
  const adapter = getDelegateAdapter(provider);
  if (!adapter) {
    return [];
  }
  const unsupported = [];
  if (limits.maxBudgetUsd != null && !adapter.controls.maxBudgetUsd) unsupported.push("max_budget_usd");
  if (limits.maxTurns != null && !adapter.controls.maxTurns) unsupported.push("max_turns");
  if (limits.effort && !adapter.controls.effort) unsupported.push("effort");
  return unsupported;
}

// Effort has no fallback enforcement path (unlike dollars/turns, which keep
// the pre-run + timeout envelope), so sending it to an adapter without an
// effort control would silently weaken the policy — reject instead.
function assertEffortSupported(provider, limits) {
  if (limits.effort && !requireDelegateAdapter(provider).controls.effort) {
    throw new Error(`provider "${provider}" has no effort control; unsupported controls are rejected rather than silently ignored. Remove --effort or the route's effort setting.`);
  }
}

export function buildDelegateCommand(target, prompt, options = {}) {
  const adapter = requireDelegateAdapter(target.provider);
  return adapter.buildCommand(target, prompt, {
    write: options.write === true,
    limits: options.limits || {},
    lastMessagePath: options.lastMessagePath || null,
    persistSession: options.persistSession === true,
  });
}

async function buildDiffSection(root, diffRef) {
  const { stdout } = await execFileAsync("git", ["diff", diffRef], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const changed = await getChangedFilesSince(root, diffRef).catch(() => []);
  const fileList = changed.map((entry) => `- ${entry.status} ${entry.path}`).join("\n");
  return [
    `## Changed files since ${diffRef}`,
    fileList || "- (none reported by git)",
    "",
    "## Diff",
    "```diff",
    stdout.trim() || "(empty diff)",
    "```",
  ].join("\n");
}

export function buildDelegatePrompt(kind, task, options = {}) {
  const sections = [];
  if (kind === "review") {
    sections.push(
      "You are performing an independent code review. Report concrete findings (bugs, regressions, risky assumptions) with file:line references, ranked by severity. If the change looks correct, say so briefly. Do not modify any files.",
    );
  } else if (kind === "research") {
    sections.push("Answer concisely and factually. Do not modify any files.");
  }
  if (task) {
    sections.push(kind === "review" ? `Review focus: ${task}` : task);
  } else if (kind === "review") {
    sections.push("Review the change for correctness, edge cases, and unintended side effects.");
  }
  if (options.diffSection) {
    sections.push(options.diffSection);
  }
  return sections.filter(Boolean).join("\n\n");
}

// Classify how the run ended so budget-triggered termination is
// distinguishable from provider failure and timeout in both human and JSON
// output.
function classifyRunStatus(result, parsed) {
  const subtype = String(parsed?.subtype || "");
  if (/budget/i.test(subtype)) {
    return { status: "budget_stopped", budget_stop_reason: "max_budget_usd" };
  }
  if (/max_turns/i.test(subtype)) {
    return { status: "budget_stopped", budget_stop_reason: "max_turns" };
  }
  if (/delegate timed out/.test(String(result.stderr || ""))) {
    return { status: "timeout", budget_stop_reason: null };
  }
  return { status: result.code === 0 ? "ok" : "provider_error", budget_stop_reason: null };
}

function promptHash(prompt) {
  return createHash("sha256").update(String(prompt || "")).digest("hex").slice(0, 16);
}

async function recordDelegationSafe(root, record) {
  try {
    const { recordDelegation } = await import("./stats.js");
    await recordDelegation(root, record);
  } catch {
    // Stats are best-effort; a broken log must not fail the delegation.
  }
}

export async function runDelegate(root, config, kindInput, task, options = {}) {
  const routes = resolveModelRoutes(config);
  const kind = normalizeRouteKind(kindInput, routes);

  // Dry run: return the full routing explanation without starting a provider
  // process or recording spend.
  if (options.dryRun === true) {
    const explained = await explainRoute(root, config, task, { ...options, kind });
    return { ...explained, command: "delegate", dry_run: true };
  }

  // The route carries the hard ceilings; tier/model selection below never
  // changes them. A profile chooses how to operate inside the envelope.
  const route = { ...routes[kind] };
  const routePolicy = await resolveRoutePolicy(root, config, kind, options);
  route.provider = routePolicy.selected.provider;
  route.model = routePolicy.selected.model;

  // Validate budgets before anything else: an invalid ceiling must fail
  // before a provider process can start. CLI flags override the route; a
  // manual provider/model/profile override never drops the ceiling.
  const policy = resolveBudgetPolicy(config);
  const cliOverrides = {
    maxBudgetUsd: options.maxBudgetUsd,
    maxTurns: options.maxTurns,
    effort: options.effort,
  };
  const limits = resolveRouteLimits(route, cliOverrides);
  const budgetSource = describeBudgetSource(kind, config, cliOverrides);

  const availability = await detectDelegateProviders(options.runtime || {});
  const target = selectFromChain(routePolicy.fallback_chain, availability);
  if (!target) {
    throw new Error(
      `No available CLI for delegate kind "${kind}" (wanted ${route.provider}${route.model ? `/${route.model}` : ""}). Install one of the registered provider CLIs (${DELEGATE_PROVIDER_NAMES.join(", ")}), or override the route in .agentify.yaml under models.routes.`,
    );
  }
  const adapter = requireDelegateAdapter(target.provider);
  assertEffortSupported(target.provider, limits);
  const unsupportedControls = listUnsupportedControls(target.provider, limits);

  if (!task && kind !== "review") {
    throw new Error(`delegate ${kind} requires a task: agentify delegate ${kind} "<task>"`);
  }

  const runId = options.runId || randomUUID();
  const explicitProfile = options.profile ?? (options.env || process.env)?.AGENTIFY_PROFILE ?? null;
  const baseRecord = {
    schema: DELEGATION_SCHEMA_VERSION,
    run_id: runId,
    kind,
    provider: target.provider,
    model: target.model,
    requested_provider: route.provider,
    requested_model: route.model ?? null,
    used_fallback: target.fallback,
    fallback_reason: target.fallback ? target.fallback_reason : null,
    write: options.write === true,
    budget_limit: limits.maxBudgetUsd,
    max_turns: limits.maxTurns,
    budget_source: budgetSource,
    // Ceilings the selected adapter cannot enforce natively in-flight (#297);
    // they remain covered by the pre-run rolling check and the timeout.
    unsupported_controls: unsupportedControls,
    // Profile contract (#295): requested is what the user explicitly asked
    // for this run (CLI/env), resolved is the profile that actually governed
    // routing after full precedence.
    requested_profile: explicitProfile ? String(explicitProfile).trim().toLowerCase() : null,
    resolved_profile: routePolicy.profile.name,
    profile_source: routePolicy.profile.source,
    policy_version: routePolicy.policy_version,
    capability_tier: target.tier,
    tier_reason: routePolicy.selected.reason,
  };

  // Rolling caps count spend already recorded locally; at the cap, block mode
  // refuses to start a new provider process at all.
  const rolling = await checkRollingBudget(root, policy);
  let budgetWarning = null;
  if (rolling.exceeded) {
    const w = rolling.exceeded_window;
    const message = `${w.window} spend $${w.spent_usd.toFixed(4)} has reached the models.budget cap of $${w.limit_usd}`;
    if (policy.onLimit === "block") {
      const blocked = {
        command: "delegate",
        ...baseRecord,
        status: "budget_blocked",
        budget_stop_reason: `rolling_${w.window}_cap`,
        budget_remaining: 0,
        exit_code: 2,
        duration_ms: 0,
        output: "",
        error: `budget blocked: ${message} (set models.budget.onLimit: warn to override)`,
      };
      await recordDelegationSafe(root, {
        ...baseRecord,
        status: "budget_blocked",
        budget_stop_reason: blocked.budget_stop_reason,
        budget_remaining: 0,
        exit_code: 2,
        duration_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        tokens_estimated: false,
        cost_usd: null,
      });
      return blocked;
    }
    budgetWarning = message;
  }

  const promptStart = Date.now();
  const diffSection = options.diffRef ? await buildDiffSection(root, options.diffRef) : null;
  const prompt = buildDelegatePrompt(kind, task, { diffSection });
  const promptMs = Date.now() - promptStart;

  const lastMessagePath = adapter.usesLastMessageFile
    ? path.join(os.tmpdir(), `agentify-delegate-${process.pid}-${Math.random().toString(36).slice(2)}.md`)
    : null;
  const argv = buildDelegateCommand(target, prompt, {
    write: options.write === true,
    lastMessagePath,
    limits,
    persistSession: options.persistSession === true,
  });

  const timeoutMs = options.timeoutMs
    || (limits.timeoutSeconds != null ? limits.timeoutSeconds * 1000 : DELEGATE_TIMEOUT_MS);
  const exec = options.runtime?.exec || ((command, args) => runProviderProcess(command, args, {
    cwd: root,
    timeoutMs,
  }));

  const startedAt = Date.now();
  const result = await exec(argv[0], argv.slice(1));
  const providerMs = Date.now() - startedAt;

  const parseStart = Date.now();
  let output = String(result.stdout || "").trim();
  let usage = null;
  const parsed = adapter.parseOutput ? adapter.parseOutput(result.stdout) : null;
  if (parsed) {
    usage = parsed;
    // Structured streams are not the answer text; adapters expose whatever
    // human-readable output the envelope carried (possibly none — codex
    // delivers it via the last-message file below).
    output = typeof parsed.output === "string" ? parsed.output.trim() : "";
  }
  if (lastMessagePath) {
    try {
      const lastMessage = (await fs.readFile(lastMessagePath, "utf8")).trim();
      if (lastMessage) {
        output = lastMessage;
      }
    } catch {
      // Fall back to captured stdout when the CLI did not write the file.
    }
    await fs.unlink(lastMessagePath).catch(() => {});
  }
  const parseMs = Date.now() - parseStart;
  const durationMs = Date.now() - promptStart;

  const { status, budget_stop_reason: budgetStopReason } = classifyRunStatus(result, usage);
  const costUsd = usage?.cost_usd ?? null;
  const budgetRemaining = rolling.remaining_usd === null
    ? null
    : Math.max(0, rolling.remaining_usd - (costUsd || 0));

  const tokensEstimated = usage?.input_tokens == null || usage?.output_tokens == null;
  let estimateTokens = (text) => Math.max(String(text || "").length === 0 ? 0 : 1, Math.round(String(text || "").length / 4));
  try {
    ({ estimateTokens } = await import("./stats.js"));
  } catch {
    // Keep the local estimator; stats are best-effort.
  }
  await recordDelegationSafe(root, {
    ...baseRecord,
    resolved_model: usage?.resolved_model ?? null,
    status,
    exit_code: result.code,
    duration_ms: durationMs,
    latency: {
      prompt_ms: promptMs,
      provider_ms: providerMs,
      parse_ms: parseMs,
      total_ms: durationMs,
    },
    usage: {
      fresh_input_tokens: usage?.usage?.fresh_input_tokens ?? null,
      cache_write_tokens: usage?.usage?.cache_write_tokens ?? null,
      cache_read_tokens: usage?.usage?.cache_read_tokens ?? null,
      output_tokens: usage?.usage?.output_tokens ?? null,
    },
    input_tokens: usage?.input_tokens ?? estimateTokens(prompt),
    output_tokens: usage?.output_tokens ?? estimateTokens(output),
    tokens_estimated: tokensEstimated,
    cost_usd: costUsd,
    cost_source: costUsd !== null ? "provider" : "unreported",
    budget_remaining: budgetRemaining,
    budget_stop_reason: budgetStopReason,
    prompt_sha256: promptHash(prompt),
  });

  return {
    command: "delegate",
    run_id: runId,
    kind,
    provider: target.provider,
    model: target.model,
    resolved_model: usage?.resolved_model ?? null,
    used_fallback: target.fallback,
    fallback_reason: target.fallback ? target.fallback_reason : null,
    profile: routePolicy.profile.name,
    profile_source: routePolicy.profile.source,
    policy_version: routePolicy.policy_version,
    capability_tier: target.tier,
    tier_reason: routePolicy.selected.reason,
    write: options.write === true,
    diff_ref: options.diffRef || null,
    status,
    exit_code: result.code,
    duration_ms: durationMs,
    budget_limit: limits.maxBudgetUsd,
    max_turns: limits.maxTurns,
    budget_source: budgetSource,
    unsupported_controls: unsupportedControls,
    enforcement: describeLimitEnforcement(target.provider),
    budget_stop_reason: budgetStopReason,
    budget_remaining: budgetRemaining,
    ...(budgetWarning ? { budget_warning: budgetWarning } : {}),
    ...(costUsd != null ? { cost_usd: costUsd } : {}),
    output,
    ...(result.code !== 0 ? { error: String(result.stderr || "").trim().slice(0, 2000) } : {}),
  };
}

function runProviderProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    // stdin must be closed: codex exec otherwise waits for extra input from
    // the pipe, and neither CLI needs interactive input in delegate mode.
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Delegated agent runs must not feed back into context tracking or
      // spawn their own session summaries — that would recurse.
      env: { ...process.env, AGENTIFY_CTX: "off" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        stderr += `\ndelegate timed out after ${Math.round(timeoutMs / 1000)}s`;
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function describeModelRoutes(config, runtime = {}, options = {}) {
  const routes = resolveModelRoutes(config);
  const policy = resolveBudgetPolicy(config);
  const profileSelection = resolveProfileSelection(config, options, options.env || process.env);
  const definitions = resolveProfileDefinitions(config);
  const definition = definitions[profileSelection.name];
  const availability = await detectDelegateProviders(runtime);
  const providerPolicy = resolveDelegateProviderPolicy(config);
  const tierModels = resolveTierModels(config);
  const entries = Object.entries(routes).map(([kind, route]) => {
    const chain = buildFallbackChain({ kind, route, profileName: profileSelection.name, config });
    const target = selectFromChain(chain, availability);
    const limits = resolveRouteLimits(route);
    return {
      kind,
      provider: route.provider,
      model: route.model ?? "(cli default)",
      tier: resolveRouteTier(kind, route),
      use: route.use || "",
      available: Boolean(target),
      resolves_to: target ? `${target.provider}${target.model ? `/${target.model}` : ""}${target.fallback ? " (fallback)" : ""}` : "unavailable",
      fallback_chain: chain.entries.map((entry) => ({
        provider: entry.provider,
        model: entry.model ?? "(cli default)",
        tier: entry.tier,
        reason: entry.reason,
      })),
      // Aliases resolve outside Agentify's control and can drift across
      // provider releases; governed profiles should pin full model IDs.
      model_is_alias: isAliasModel(route.provider, route.model),
      limits: {
        max_budget_usd: limits.maxBudgetUsd,
        max_turns: limits.maxTurns,
        timeout_seconds: limits.timeoutSeconds,
        effort: limits.effort,
      },
      enforcement: describeLimitEnforcement(target ? target.provider : route.provider),
      unsupported_controls: listUnsupportedControls(target ? target.provider : route.provider, limits),
    };
  });
  // One registry drives doctor/install/models/delegate alike (#297): what a
  // provider supports here is exactly what the delegate adapter declares.
  const providerDetails = DELEGATE_PROVIDER_NAMES.map((name) => {
    const adapter = getDelegateAdapter(name);
    return {
      name,
      installed: Boolean(availability[name]),
      opt_in: providerPolicy[name].optIn,
      enabled_for_routing: providerPolicy[name].enabled,
      tier_models: tierModels[name],
      controls: { ...adapter.controls },
      enforcement: { ...adapter.enforcement },
      reports_cost_usd: adapter.reportsCostUsd === true,
    };
  });
  return {
    command: "models",
    providers: availability,
    provider_details: providerDetails,
    budget: policy,
    profile: {
      name: profileSelection.name,
      source: profileSelection.source,
      objective: definition.objective,
      quality_floor: definition.qualityFloor,
      max_tier_raise: definition.maxTierRaise,
      policy_version: ROUTE_POLICY_VERSION,
    },
    alias_drift_warning: entries.some((entry) => entry.model_is_alias)
      ? "Some routes use version-independent aliases or the provider CLI default; the resolved model can change across provider releases. Pin full model IDs under models.routes to remove drift. Requested and resolved models are recorded separately per run."
      : null,
    routes: entries,
  };
}
