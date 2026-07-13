// Routing profiles (#295): a policy layer that chooses HOW to route inside
// the budget safety envelope (budget.js) — it never widens a ceiling.
//
// Three ideas are kept deliberately separate:
// - Optimization profiles (cost | balanced | performance): what the user is
//   optimizing for on this run.
// - Capability tiers (economy | balanced | frontier): vendor-neutral strength
//   classes. A profile chooses among evaluated tiers; it is not a model name.
// - Routes (quick | implement | heavy | review | research): what kind of work
//   is being delegated. Manual routes and explicit overrides always win.
//
// Every decision here is deterministic for a fixed config/input and is
// explainable via `agentify route explain` / `--dry-run`. Evidence comes from
// locally recorded eval runs; without sufficient evidence the engine keeps
// the configured default instead of guessing. Promoting a new production
// default always requires an explicit config change — there is no
// self-modifying router.

import fs from "node:fs/promises";
import path from "node:path";

export const ROUTE_POLICY_VERSION = "route-policy-v1";
export const PROFILE_NAMES = ["cost", "balanced", "performance"];
export const CAPABILITY_TIERS = ["economy", "balanced", "frontier"];

// Evidence below this many attempts for a candidate is "insufficient": the
// engine will not move off the configured default because of it. Matches the
// eval report's underpowered threshold.
export const MIN_EVIDENCE_ATTEMPTS = 5;

export const DEFAULT_PROFILE_DEFINITIONS = {
  cost: {
    objective: "min_cost_subject_to_quality_floor",
    // A cheaper tier is only selected when its measured pass rate meets this
    // floor with sufficient samples — "cost" never means cheap failures.
    qualityFloor: 0.9,
    // Bounded escalation: how many tiers above the route's own tier a
    // fallback or evidence-based move may reach. 0 = never escalate.
    maxTierRaise: 0,
  },
  balanced: {
    objective: "min_cost_per_pass",
    qualityFloor: 0.8,
    maxTierRaise: 1,
  },
  performance: {
    objective: "max_pass_rate_subject_to_budget",
    // Performance maximizes measured pass rate inside hard ceilings; it has
    // no downgrade floor because it never downgrades on its own.
    qualityFloor: null,
    maxTierRaise: 1,
  },
};

// Vendor-neutral capability tier of each built-in route. Custom routes
// default to "balanced" unless the route config sets `tier`.
export const ROUTE_CAPABILITY_TIERS = {
  quick: "economy",
  implement: "balanced",
  heavy: "frontier",
  review: "balanced",
  research: "economy",
};

// Per-provider model for each capability tier. Claude Code accepts
// version-independent aliases; Codex uses its CLI-configured default for
// every tier (null) rather than Agentify hard-coding vendor model names.
// Known limitation: with all Codex tiers on the CLI default, a Codex
// fallback's tier label cannot be capability-verified and Codex evidence is
// indistinguishable across tiers — provider capability adapters (#297) are
// the fix; until then, pin per-tier Codex models under `models.tiers` in
// .agentify.yaml to make the bound real.
export const DEFAULT_TIER_MODELS = {
  claude: { economy: "haiku", balanced: "sonnet", frontier: "opus" },
  codex: { economy: null, balanced: null, frontier: null },
};

// Claude version-independent aliases. Aliases (and a null "CLI default"
// model) can silently change behavior across releases, so governed profiles
// get a drift warning unless full model IDs are pinned.
const CLAUDE_ALIASES = new Set(["haiku", "sonnet", "opus"]);

export function isAliasModel(provider, model) {
  if (model === null || model === undefined || model === "") {
    return true; // CLI default: resolution is outside Agentify's control.
  }
  if (provider === "claude") {
    return CLAUDE_ALIASES.has(String(model).trim().toLowerCase());
  }
  return false;
}

export function tierIndex(tier) {
  const index = CAPABILITY_TIERS.indexOf(tier);
  if (index === -1) {
    throw new Error(`Unknown capability tier "${tier}". Available: ${CAPABILITY_TIERS.join(", ")}`);
  }
  return index;
}

function clampTier(index) {
  return CAPABILITY_TIERS[Math.max(0, Math.min(CAPABILITY_TIERS.length - 1, index))];
}

export function resolveRouteTier(kind, route = {}) {
  if (route.tier !== undefined && route.tier !== null && route.tier !== "") {
    const tier = String(route.tier).trim().toLowerCase();
    tierIndex(tier);
    return tier;
  }
  return ROUTE_CAPABILITY_TIERS[kind] || "balanced";
}

export function resolveTierModels(config = {}) {
  const configured = config.models?.tiers && typeof config.models.tiers === "object" && !Array.isArray(config.models.tiers)
    ? config.models.tiers
    : {};
  const merged = {};
  for (const [provider, tiers] of Object.entries(DEFAULT_TIER_MODELS)) {
    const override = configured[provider] && typeof configured[provider] === "object" ? configured[provider] : {};
    merged[provider] = { ...tiers };
    for (const tier of CAPABILITY_TIERS) {
      if (override[tier] !== undefined) {
        merged[provider][tier] = override[tier] === null ? null : String(override[tier]);
      }
    }
  }
  return merged;
}

function normalizeFloor(value, label) {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1 || typeof value === "boolean") {
    throw new Error(`${label} must be a number between 0 and 1, got "${value}"`);
  }
  return num;
}

// Merge user profile definitions over the defaults. Only known profile names
// are accepted — profiles are a closed policy contract, not free-form routes.
export function resolveProfileDefinitions(config = {}) {
  const configured = config.models?.profiles && typeof config.models.profiles === "object" && !Array.isArray(config.models.profiles)
    ? config.models.profiles
    : {};
  for (const name of Object.keys(configured)) {
    if (!PROFILE_NAMES.includes(name)) {
      throw new Error(`Unknown profile "${name}" in models.profiles. Available: ${PROFILE_NAMES.join(", ")}`);
    }
  }
  const definitions = {};
  for (const name of PROFILE_NAMES) {
    const override = configured[name] && typeof configured[name] === "object" ? configured[name] : {};
    const merged = { ...DEFAULT_PROFILE_DEFINITIONS[name], ...override };
    merged.qualityFloor = normalizeFloor(merged.qualityFloor, `models.profiles.${name}.qualityFloor`);
    const raise = Number(merged.maxTierRaise);
    if (!Number.isInteger(raise) || raise < 0 || raise > CAPABILITY_TIERS.length - 1) {
      throw new Error(`models.profiles.${name}.maxTierRaise must be an integer between 0 and ${CAPABILITY_TIERS.length - 1}`);
    }
    merged.maxTierRaise = raise;
    definitions[name] = merged;
  }
  return definitions;
}

// Resolution precedence (issue #295):
// explicit --provider/--model > --profile > AGENTIFY_PROFILE > repo config > balanced default.
// Explicit provider/model overrides are handled by the policy engine (they
// skip tier selection); this resolves only which profile governs the run.
export function resolveProfileSelection(config = {}, options = {}, env = process.env) {
  const candidates = [
    { value: options.profile, source: "cli" },
    { value: env?.AGENTIFY_PROFILE, source: "env" },
    { value: config.models?.profile, source: "config" },
  ];
  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === null || candidate.value === "") {
      continue;
    }
    const name = String(candidate.value).trim().toLowerCase();
    if (!PROFILE_NAMES.includes(name)) {
      throw new Error(`Unknown profile "${candidate.value}" (from ${candidate.source}). Available: ${PROFILE_NAMES.join(", ")}`);
    }
    return { name, source: candidate.source };
  }
  return { name: "balanced", source: "default" };
}

// Deterministic intent classification for `agentify delegate auto`. Rules are
// ordered and keyword-based on purpose: the same task string always maps to
// the same route, and `route explain` shows which rule matched. This
// classifies the KIND of work only — it never infers a profile from urgency
// or wording (that would violate the issue's explicit-intent contract).
const INTENT_RULES = [
  { kind: "review", pattern: /\b(review|audit|critique)\b/i },
  { kind: "quick", pattern: /\b(typo|rename|bump|reformat|format|lint|comment|one-?liner?|trivial|mechanical)\b/i },
  { kind: "heavy", pattern: /\b(architect(ure)?|redesign|design\b.*\b(system|api|schema)|root[- ]cause|deadlock|race condition|migration|rewrite)\b/i },
  { kind: "research", pattern: /\b(what|how|why|where|explain|research|summar(y|ize|ise)|look ?up|compare|document)\b/i },
];

export function classifyTaskIntent(task) {
  const text = String(task || "").trim();
  for (const rule of INTENT_RULES) {
    const match = text.match(rule.pattern);
    if (match) {
      return { kind: rule.kind, matched_rule: rule.kind, matched_text: match[0] };
    }
  }
  return { kind: "implement", matched_rule: "default", matched_text: null };
}

// Ordered fallback chain for a route under a profile. Entry 0 is the primary
// target; later entries are used only when earlier providers are missing.
// Cross-vendor fallback stays at the SAME capability tier (clamped by the
// profile's bounded escalation) — a missing Codex no longer silently becomes
// Claude opus regardless of what the route asked for.
export function buildFallbackChain({ kind, route, tier, profileName, config = {} }) {
  const definitions = resolveProfileDefinitions(config);
  const definition = definitions[profileName] || definitions.balanced;
  const tierModels = resolveTierModels(config);
  const routeTier = resolveRouteTier(kind, route);
  const selectedTier = tier || routeTier;
  const maxTier = clampTier(tierIndex(routeTier) + definition.maxTierRaise);

  const chain = [{
    provider: route.provider,
    model: route.model ?? null,
    tier: selectedTier,
    reason: "primary",
  }];
  const alternates = Object.keys(tierModels).filter((provider) => provider !== route.provider);
  for (const provider of alternates) {
    const fallbackTier = clampTier(Math.min(tierIndex(selectedTier), tierIndex(maxTier)));
    chain.push({
      provider,
      model: tierModels[provider]?.[fallbackTier] ?? null,
      tier: fallbackTier,
      reason: "provider_unavailable",
    });
  }
  return {
    entries: chain,
    max_tier: maxTier,
    max_tier_raise: definition.maxTierRaise,
  };
}

// Pick the first chain entry whose provider CLI is available.
export function selectFromChain(chain, availability) {
  for (let index = 0; index < chain.entries.length; index += 1) {
    const entry = chain.entries[index];
    if (availability[entry.provider]) {
      return {
        provider: entry.provider,
        model: entry.model ?? null,
        tier: entry.tier,
        fallback: index > 0,
        fallback_reason: index > 0 ? entry.reason : null,
        chain_index: index,
      };
    }
  }
  return null;
}

function evidenceKey(provider, model) {
  return `${provider}/${model === null || model === undefined || model === "" ? "(default)" : String(model).trim().toLowerCase()}`;
}

// Eval manifests pin full versioned model IDs (eval.js requires them) while
// routes usually hold version-independent aliases. The family key bridges the
// two: "claude-haiku-4-5-20251001" and "haiku" both map to "claude/~haiku",
// so recorded evidence is findable from alias routes. Exact keys always win
// over family aggregates on lookup.
function familyKey(provider, model) {
  if (provider !== "claude" || model === null || model === undefined) {
    return null;
  }
  const match = String(model).toLowerCase().match(/(haiku|sonnet|opus)/);
  return match ? `${provider}/~${match[1]}` : null;
}

// Only these eval arms feed routing evidence. Pooling treatment and baseline
// arms would blend harness effects into model competence and let two
// underpowered arms masquerade as one sufficient sample. Records without an
// arm (non-eval evidence sources) are accepted.
const EVIDENCE_ARMS = new Set(["agentify"]);

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

// Aggregate locally recorded eval attempts into per-(provider, model)
// evidence: pass rate, cost per pass, latency percentiles, sample size.
// Reads committed eval run artifacts only — no network, no estimates.
export async function loadRouteEvidence(root) {
  // Same location eval.js writes run artifacts to; kept inline (rather than
  // importing eval.js) to avoid a models -> profiles -> eval -> models cycle.
  const runsRoot = path.join(root, ".agentify", "evals", "runs");
  const evidence = { source: "eval-runs", runs_scanned: 0, models: {} };
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
      if (record.arm !== undefined && !EVIDENCE_ARMS.has(record.arm)) {
        continue;
      }
      // Eval attempts run through the Claude harness today; the provider is
      // recorded per attempt if present, defaulting to claude.
      const provider = record.provider_name || "claude";
      const keys = [evidenceKey(provider, record.model)];
      const family = familyKey(provider, record.model);
      if (family && family !== keys[0]) {
        keys.push(family);
      }
      for (const key of keys) {
        const bucket = buckets.get(key) || { attempts: 0, passes: 0, cost_usd: 0, costed: 0, durations: [] };
        bucket.attempts += 1;
        if (record.pass) bucket.passes += 1;
        const cost = record.provider?.cost_usd;
        if (typeof cost === "number" && Number.isFinite(cost)) {
          bucket.cost_usd += cost;
          bucket.costed += 1;
        }
        if (typeof record.provider?.duration_ms === "number") {
          bucket.durations.push(record.provider.duration_ms);
        }
        buckets.set(key, bucket);
      }
    }
  }
  for (const [key, bucket] of buckets.entries()) {
    const durations = bucket.durations.sort((a, b) => a - b);
    evidence.models[key] = {
      attempts: bucket.attempts,
      passes: bucket.passes,
      pass_rate: bucket.attempts > 0 ? Number((bucket.passes / bucket.attempts).toFixed(4)) : null,
      // Provider-reported dollars only; attempts without reported cost are
      // counted in attempts but never guessed at.
      cost_per_pass_usd: bucket.passes > 0 && bucket.costed === bucket.attempts
        ? Number((bucket.cost_usd / bucket.passes).toFixed(4))
        : null,
      provider_p50_ms: percentile(durations, 50),
      provider_p95_ms: percentile(durations, 95),
      sufficient: bucket.attempts >= MIN_EVIDENCE_ATTEMPTS,
    };
  }
  return evidence;
}

function candidateFor(provider, tier, route, baseTier, tierModels) {
  const model = tier === baseTier ? route.model ?? tierModels[provider]?.[tier] ?? null : tierModels[provider]?.[tier] ?? null;
  return { provider, model, tier };
}

// Evidence-based tier selection for one route under one profile. Pure and
// deterministic: same config + same evidence -> same answer. Returns the
// selected tier plus a reason trail for `route explain`.
export function selectTier({ kind, route, profileName, definition, evidence, config = {} }) {
  const tierModels = resolveTierModels(config);
  const baseTier = resolveRouteTier(kind, route);
  const baseIndex = tierIndex(baseTier);
  const maxIndex = Math.min(CAPABILITY_TIERS.length - 1, baseIndex + definition.maxTierRaise);
  const provider = route.provider;

  const lookup = (candidate) => {
    const exact = evidence?.models?.[evidenceKey(candidate.provider, candidate.model)];
    if (exact) {
      return exact;
    }
    const family = familyKey(candidate.provider, candidate.model);
    return (family && evidence?.models?.[family]) || null;
  };
  const base = candidateFor(provider, baseTier, route, baseTier, tierModels);
  const baseEvidence = lookup(base);

  const considered = [{ ...base, role: "default", evidence: baseEvidence }];
  let selected = { ...base, reason: "route_default" };

  if (profileName === "cost" && baseIndex > 0) {
    const lower = candidateFor(provider, CAPABILITY_TIERS[baseIndex - 1], route, baseTier, tierModels);
    const lowerEvidence = lookup(lower);
    considered.push({ ...lower, role: "cheaper_candidate", evidence: lowerEvidence });
    if (lowerEvidence?.sufficient && definition.qualityFloor !== null && lowerEvidence.pass_rate >= definition.qualityFloor) {
      selected = { ...lower, reason: "evidence_meets_quality_floor" };
    } else {
      selected.reason = lowerEvidence
        ? (lowerEvidence.sufficient ? "cheaper_tier_below_quality_floor" : "insufficient_evidence_for_downgrade")
        : "no_evidence_for_downgrade";
    }
  } else if (profileName === "performance" && maxIndex > baseIndex) {
    const higher = candidateFor(provider, CAPABILITY_TIERS[Math.min(maxIndex, baseIndex + 1)], route, baseTier, tierModels);
    const higherEvidence = lookup(higher);
    considered.push({ ...higher, role: "stronger_candidate", evidence: higherEvidence });
    // Performance is not "always the most expensive model": escalate only
    // when measured pass rate is strictly better with sufficient samples.
    if (higherEvidence?.sufficient && baseEvidence?.sufficient && higherEvidence.pass_rate > baseEvidence.pass_rate) {
      selected = { ...higher, reason: "evidence_higher_pass_rate" };
    } else {
      selected.reason = higherEvidence?.sufficient && baseEvidence?.sufficient
        ? "no_measured_improvement"
        : "insufficient_evidence_for_escalation";
    }
  } else if (profileName === "balanced") {
    // Balanced: lowest measured cost per pass among candidates meeting the
    // quality floor. Without comparable evidence, keep the route default —
    // this preserves existing manual-route behavior for repos with no data.
    const candidates = [];
    if (baseIndex > 0) candidates.push(candidateFor(provider, CAPABILITY_TIERS[baseIndex - 1], route, baseTier, tierModels));
    if (maxIndex > baseIndex) candidates.push(candidateFor(provider, CAPABILITY_TIERS[baseIndex + 1], route, baseTier, tierModels));
    // The default candidate competes under the same quality floor as the
    // alternatives — a cheap default that fails the floor must not win on
    // price alone.
    let best = baseEvidence?.sufficient && baseEvidence.cost_per_pass_usd !== null
      && (definition.qualityFloor === null || baseEvidence.pass_rate >= definition.qualityFloor)
      ? { ...base, reason: "route_default", costPerPass: baseEvidence.cost_per_pass_usd }
      : null;
    for (const candidate of candidates) {
      const candidateEvidence = lookup(candidate);
      considered.push({ ...candidate, role: "alternative", evidence: candidateEvidence });
      if (!candidateEvidence?.sufficient || candidateEvidence.cost_per_pass_usd === null) continue;
      if (definition.qualityFloor !== null && candidateEvidence.pass_rate < definition.qualityFloor) continue;
      if (best === null || candidateEvidence.cost_per_pass_usd < best.costPerPass) {
        best = { ...candidate, reason: "evidence_lower_cost_per_pass", costPerPass: candidateEvidence.cost_per_pass_usd };
      }
    }
    if (best && best.tier !== baseTier) {
      selected = { provider: best.provider, model: best.model, tier: best.tier, reason: best.reason };
    } else {
      selected.reason = best ? "route_default_lowest_cost_per_pass" : "insufficient_evidence_for_comparison";
    }
  }

  return { base_tier: baseTier, selected, considered };
}
