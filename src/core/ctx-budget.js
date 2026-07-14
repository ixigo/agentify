// Token-budgeted, explainable context selection (#296).
//
// The BM25 matcher (ctx.js) proposes candidates; this module decides which of
// them actually fit inside an explicit token budget, and can explain every
// include/skip/truncate decision it made. Selection is pure and deterministic:
// same candidates + same policy -> same selection, in the same order — Claude
// prompt caching is prefix-sensitive, so the injected block must never
// reshuffle between identical states.
//
// The effective budget participates in the optimization profile (#295): with
// no explicit override, a profile may only move off the default budget on
// sufficient local ablation evidence (paired eval runs with context
// ablations), mirroring the routing policy's evidence gating. More context is
// never assumed to be better.

import fs from "node:fs/promises";
import path from "node:path";

import { MIN_EVIDENCE_ATTEMPTS, resolveProfileDefinitions, resolveProfileSelection } from "./profiles.js";
import { estimateContextTokens } from "./value-telemetry.js";

export const CONTEXT_POLICY_VERSION = "context-policy-v1";

// Documented default: the dynamic per-prompt context block aims at roughly
// 1200 estimated tokens unless config, env, or ablation evidence says
// otherwise. Existing relevant/digest/off configs keep working under it.
export const DEFAULT_MAX_INJECTED_TOKENS = 1200;

// Reserved slices of the total budget. Decisions and unresolved failures are
// the safety-critical context classes: a reserve guarantees bulky-but-cheap
// items (hot files, summaries) cannot crowd them out. Reserves carve out of
// the total budget — they never extend it.
export const DEFAULT_RESERVES = { decisions: 250, failures: 250 };

// A truncated item below this many tokens carries no usable signal; skip
// instead of injecting a stub.
const MIN_TRUNCATED_TOKENS = 24;
const CHARS_PER_TOKEN = 4;

// Candidate classes, in safety-priority order (used only to break exact
// value-per-token ties deterministically).
const CLASS_PRIORITY = { failure: 0, decision: 1, note: 2, summary: 3, file: 4 };
// Rendering section shared by a class (decisions render inside the notes
// section); section overheads are charged once per section.
const CLASS_SECTION = { failure: "failures", decision: "notes", note: "notes", summary: "summaries", file: "files" };
// Reserve bucket each class draws from.
const CLASS_RESERVE = { decision: "decisions", failure: "failures" };

function nonNegativeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 && typeof value !== "boolean" ? num : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) && typeof value !== "boolean" ? num : null;
}

// Explicit budget overrides, strongest first: env (eval ablations, one-off
// runs) > repo config. The default is deliberately NOT written into
// DEFAULT_CONFIG so "user pinned 1200" stays distinguishable from "policy
// default 1200" — same pattern as models.profile (#295).
export function resolveBudgetSettings(config = {}, env = process.env) {
  const context = config.context && typeof config.context === "object" ? config.context : {};
  const reserveRaw = context.reserve && typeof context.reserve === "object" && !Array.isArray(context.reserve) ? context.reserve : {};
  const explicitEnv = nullableNumber(env?.AGENTIFY_CTX_BUDGET);
  const explicitConfig = nullableNumber(context.maxInjectedTokens);
  return {
    explicitMaxTokens: explicitEnv !== null ? Math.floor(explicitEnv) : explicitConfig !== null ? Math.floor(explicitConfig) : null,
    explicitSource: explicitEnv !== null ? "env" : explicitConfig !== null ? "config" : null,
    minScore: nullableNumber(context.minScore),
    maxAgeDays: nullableNumber(context.maxAgeDays),
    reserves: {
      decisions: Math.floor(nonNegativeNumber(reserveRaw.decisions, DEFAULT_RESERVES.decisions)),
      failures: Math.floor(nonNegativeNumber(reserveRaw.failures, DEFAULT_RESERVES.failures)),
    },
  };
}

function variantKey(mode, maxTokens) {
  return mode === "relevant" ? `relevant@${maxTokens ?? DEFAULT_MAX_INJECTED_TOKENS}` : mode;
}

// Aggregate locally recorded eval attempts into per-context-variant evidence.
// Only agentify-arm attempts count (baseline arms run with context off by
// construction); attempts from before context ablations existed count toward
// the default relevant budget. Reads committed run artifacts only — no
// network, no estimates.
export async function loadContextEvidence(root) {
  const runsRoot = path.join(root, ".agentify", "evals", "runs");
  const evidence = { source: "eval-runs", runs_scanned: 0, variants: {} };
  let entries;
  try {
    entries = (await fs.readdir(runsRoot)).sort().reverse();
  } catch {
    return evidence;
  }
  const buckets = new Map();
  for (const name of entries) {
    const runDir = path.join(runsRoot, name);
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8"));
    } catch {
      continue;
    }
    evidence.runs_scanned += 1;
    for (const entry of meta?.plan?.order || []) {
      let record;
      try {
        record = JSON.parse(await fs.readFile(path.join(runDir, "attempts", entry.attempt_id, "result.json"), "utf8"));
      } catch {
        continue;
      }
      const arm = String(record.arm || "");
      if (arm !== "agentify" && !arm.startsWith("agentify-ctx-")) {
        continue;
      }
      const ablation = record.context_ablation && typeof record.context_ablation === "object" ? record.context_ablation : { mode: "relevant", max_injected_tokens: null };
      const mode = String(ablation.mode || "relevant");
      // A null ablation budget means "whatever the policy resolved at run
      // time" — which the attempt's own telemetry recorded. Bucketing by the
      // actual budget keeps a config-pinned 600-token run out of the
      // default-1200 evidence; the documented default is only assumed when
      // no measurement exists.
      const effectiveBudget = mode === "relevant"
        ? nullableNumber(ablation.max_injected_tokens)
          ?? nullableNumber(record.context_metrics?.budget_max_tokens)
          ?? DEFAULT_MAX_INJECTED_TOKENS
        : null;
      const key = variantKey(mode, effectiveBudget);
      const bucket = buckets.get(key) || { mode, max_injected_tokens: effectiveBudget, attempts: 0, passes: 0, cost_usd: 0, costed: 0 };
      bucket.attempts += 1;
      if (record.pass) bucket.passes += 1;
      const cost = record.provider?.cost_usd;
      if (typeof cost === "number" && Number.isFinite(cost)) {
        bucket.cost_usd += cost;
        bucket.costed += 1;
      }
      buckets.set(key, bucket);
    }
  }
  for (const [key, bucket] of buckets.entries()) {
    evidence.variants[key] = {
      mode: bucket.mode,
      max_injected_tokens: bucket.max_injected_tokens,
      attempts: bucket.attempts,
      passes: bucket.passes,
      pass_rate: bucket.attempts > 0 ? Number((bucket.passes / bucket.attempts).toFixed(4)) : null,
      // Provider-reported dollars only, and only when every attempt reported.
      cost_per_pass_usd: bucket.passes > 0 && bucket.costed === bucket.attempts
        ? Number((bucket.cost_usd / bucket.passes).toFixed(4))
        : null,
      sufficient: bucket.attempts >= MIN_EVIDENCE_ATTEMPTS,
    };
  }
  return evidence;
}

// Evidence-based budget selection for one profile. Pure and deterministic.
// Mirrors selectTier's contract: insufficient evidence keeps the default, and
// every decision carries a reason for `ctx explain`.
export function selectBudgetForProfile({ profileName, definition, evidence }) {
  const variants = Object.values(evidence?.variants || {})
    .filter((variant) => variant.mode === "relevant" && variant.sufficient && Number.isFinite(variant.max_injected_tokens))
    .sort((left, right) => left.max_injected_tokens - right.max_injected_tokens);
  const fallback = { max_tokens: DEFAULT_MAX_INJECTED_TOKENS, reason: variants.length === 0 ? "no_ablation_evidence" : "insufficient_evidence_for_change", considered: variants };

  if (profileName === "cost") {
    // Smallest evaluated budget that still meets the profile's quality floor.
    for (const variant of variants) {
      if (definition.qualityFloor !== null && variant.pass_rate >= definition.qualityFloor) {
        return { max_tokens: variant.max_injected_tokens, reason: "smallest_budget_meets_quality_floor", considered: variants };
      }
    }
    return fallback;
  }

  if (profileName === "balanced") {
    // Best measured cost-per-pass under the quality floor; ties go to the
    // smaller budget (already sorted ascending).
    let best = null;
    for (const variant of variants) {
      if (variant.cost_per_pass_usd === null) continue;
      if (definition.qualityFloor !== null && variant.pass_rate < definition.qualityFloor) continue;
      if (best === null || variant.cost_per_pass_usd < best.cost_per_pass_usd) {
        best = variant;
      }
    }
    return best
      ? { max_tokens: best.max_injected_tokens, reason: "evidence_lowest_cost_per_pass", considered: variants }
      : fallback;
  }

  if (profileName === "performance") {
    // A larger or richer context budget only when ablation evidence shows it
    // improves task success — never "more context by default".
    const baseline = variants.find((variant) => variant.max_injected_tokens === DEFAULT_MAX_INJECTED_TOKENS);
    if (baseline) {
      let best = baseline;
      for (const variant of variants) {
        if (variant.max_injected_tokens > DEFAULT_MAX_INJECTED_TOKENS && variant.pass_rate > best.pass_rate) {
          best = variant;
        }
      }
      if (best !== baseline) {
        return { max_tokens: best.max_injected_tokens, reason: "evidence_higher_pass_rate", considered: variants };
      }
    }
    return fallback;
  }

  return fallback;
}

// Resolve the full context policy for one injection: which profile governs,
// what the effective token budget is, where it came from, and the filter
// settings. `evidence` is injectable for tests; explicit overrides skip the
// evidence read entirely.
export async function resolveContextPolicy(root, config = {}, options = {}) {
  const env = options.env || process.env;
  const profile = resolveProfileSelection(config, { profile: options.profile }, env);
  const definition = resolveProfileDefinitions(config)[profile.name];
  const settings = resolveBudgetSettings(config, env);

  let maxTokens;
  let budgetSource;
  let budgetReason;
  let evidenceSummary = null;
  if (settings.explicitMaxTokens !== null) {
    maxTokens = settings.explicitMaxTokens;
    budgetSource = settings.explicitSource;
    budgetReason = "explicit_override";
  } else {
    const evidence = options.evidence !== undefined ? options.evidence : await loadContextEvidence(root);
    const selected = selectBudgetForProfile({ profileName: profile.name, definition, evidence });
    maxTokens = selected.max_tokens;
    budgetSource = selected.reason === "no_ablation_evidence" || selected.reason === "insufficient_evidence_for_change" ? "default" : "evidence";
    budgetReason = selected.reason;
    evidenceSummary = {
      source: evidence?.source ?? null,
      runs_scanned: evidence?.runs_scanned ?? 0,
      considered: selected.considered,
    };
  }

  return {
    policy_version: CONTEXT_POLICY_VERSION,
    // requested_profile carries only what the user explicitly asked for;
    // resolved_profile is what actually governs (same contract as #295).
    requested_profile: profile.source === "default" ? null : profile.name,
    resolved_profile: profile.name,
    profile_source: profile.source,
    max_injected_tokens: Math.max(0, Math.floor(maxTokens)),
    budget_source: budgetSource,
    budget_reason: budgetReason,
    min_score: settings.minScore,
    max_age_days: settings.maxAgeDays,
    reserves: settings.reserves,
    evidence: evidenceSummary,
  };
}

function ageDays(ts, now) {
  const then = Date.parse(String(ts || ""));
  if (!Number.isFinite(then)) {
    return null;
  }
  return Math.max(0, Math.floor((now - then) / 86400000));
}

function truncateLine(line, maxTokens, fullChars) {
  const marker = ` … [truncated from ${fullChars} chars]`;
  const budgetChars = maxTokens * CHARS_PER_TOKEN - marker.length;
  if (budgetChars < MIN_TRUNCATED_TOKENS * CHARS_PER_TOKEN - marker.length) {
    return null;
  }
  return `${String(line).slice(0, budgetChars).trimEnd()}${marker}`;
}

// Select the highest value-per-token candidate set that fits the budget.
//
// Inputs: candidates [{ key, type, score, ts, stale, seen, line }] with type
// in failure|decision|note|summary|file; `overhead` charges the rendered
// scaffolding ({ base, sections: { failures, summaries, notes, files } })
// against the same budget so the FULL rendered block honors the cap, not just
// the item lines.
//
// Guarantees:
// - deterministic: greedy order is (value density desc, class priority asc,
//   key asc); output preserves input order within each class for rendering.
// - reserves: unfilled decision/failure reserves are held back from other
//   classes while eligible candidates of that class remain.
// - no single item may exceed the total budget: decisions/failures truncate
//   with provenance, everything else is skipped with a reason.
export function selectWithinBudget({ candidates = [], maxTokens, minScore = null, maxAgeDays = null, reserves = DEFAULT_RESERVES, overhead = { base: 0, sections: {} }, now = Date.now() } = {}) {
  const annotated = candidates.map((candidate, index) => ({
    ...candidate,
    order: index,
    chars: String(candidate.line || "").length,
    tokens: estimateContextTokens(candidate.line),
    age_days: ageDays(candidate.ts, now),
    selected: false,
    truncated: false,
    reason: null,
  }));

  const eligible = [];
  for (const candidate of annotated) {
    if (maxTokens <= 0) {
      candidate.reason = "budget_disabled";
    } else if (candidate.stale) {
      candidate.reason = "stale_refs";
    } else if (candidate.seen) {
      candidate.reason = "seen_this_session";
    } else if (minScore !== null && candidate.score < minScore) {
      candidate.reason = "below_min_score";
    } else if (maxAgeDays !== null && candidate.age_days !== null && candidate.age_days > maxAgeDays) {
      candidate.reason = "exceeds_max_age";
    } else {
      eligible.push(candidate);
    }
  }

  // Greedy order: value per token, then class safety priority, then key.
  const density = (candidate) => (candidate.tokens > 0 ? candidate.score / candidate.tokens : candidate.score);
  const ordered = [...eligible].sort((left, right) => density(right) - density(left)
    || CLASS_PRIORITY[left.type] - CLASS_PRIORITY[right.type]
    || String(left.key).localeCompare(String(right.key)));

  // Pending eligible tokens per reserve bucket: a reserve only holds budget
  // back while candidates that could still use it remain unprocessed.
  const pendingReserveTokens = { decisions: 0, failures: 0 };
  for (const candidate of ordered) {
    const bucket = CLASS_RESERVE[candidate.type];
    if (bucket) {
      pendingReserveTokens[bucket] += candidate.tokens;
    }
  }
  const usedReserveTokens = { decisions: 0, failures: 0 };

  let used = 0;
  let anySelected = false;
  const sectionCharged = new Set();

  const reserveHold = (type) => {
    let hold = 0;
    for (const bucket of Object.keys(pendingReserveTokens)) {
      if (CLASS_RESERVE[type] === bucket) continue;
      const reserve = Math.max(0, Number(reserves?.[bucket]) || 0);
      const outstanding = Math.max(0, reserve - usedReserveTokens[bucket]);
      hold += Math.min(outstanding, pendingReserveTokens[bucket]);
    }
    return hold;
  };

  for (const candidate of ordered) {
    const section = CLASS_SECTION[candidate.type];
    const overheadCost = (anySelected ? 0 : Math.max(0, Number(overhead.base) || 0))
      + (sectionCharged.has(section) ? 0 : Math.max(0, Number(overhead.sections?.[section]) || 0));
    const bucket = CLASS_RESERVE[candidate.type];
    if (bucket) {
      pendingReserveTokens[bucket] -= candidate.tokens;
    }
    const available = maxTokens - used - reserveHold(candidate.type) - overheadCost;

    let line = candidate.line;
    let tokens = candidate.tokens;
    let truncated = false;
    if (tokens > available) {
      const aloneBudget = maxTokens - (Math.max(0, Number(overhead.base) || 0)) - (Math.max(0, Number(overhead.sections?.[section]) || 0));
      if (!bucket) {
        candidate.reason = tokens > aloneBudget ? "exceeds_total_budget" : "over_budget";
        continue;
      }
      // Safety classes truncate with provenance instead of vanishing —
      // unless even a truncated stub cannot fit.
      const cap = Math.min(available, aloneBudget);
      const shortened = cap >= MIN_TRUNCATED_TOKENS ? truncateLine(candidate.line, cap, candidate.chars) : null;
      if (shortened === null) {
        candidate.reason = tokens > aloneBudget ? "exceeds_total_budget" : "over_budget";
        continue;
      }
      line = shortened;
      tokens = estimateContextTokens(shortened);
      truncated = true;
    }

    candidate.selected = true;
    candidate.truncated = truncated;
    candidate.reason = truncated ? "truncated_to_fit" : "within_budget";
    candidate.line = line;
    candidate.tokens = tokens;
    used += tokens + overheadCost;
    anySelected = true;
    sectionCharged.add(section);
    if (bucket) {
      usedReserveTokens[bucket] += tokens;
    }
  }

  // Preserve the caller's (score-ranked) order within the selection so
  // rendering stays deterministic and cache-stable.
  const selected = annotated.filter((candidate) => candidate.selected).sort((left, right) => left.order - right.order);
  return {
    selected,
    candidates: annotated,
    used_tokens: used,
    max_tokens: maxTokens,
  };
}
