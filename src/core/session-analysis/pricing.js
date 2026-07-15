// Versioned list-price table for token-derived cost ESTIMATES. Rules:
//
// - Estimates are computed only for sessions whose exact model identifier
//   (modulo a trailing -YYYYMMDD snapshot suffix) has an entry, and only
//   when the session started on/after the entry's effective date. No
//   fuzzy matching: a wrong guess is worse than an honest gap.
// - Estimated cost is never merged with provider-reported cost and is
//   never presented as billed spend — subscription users in particular
//   pay nothing per token. Coverage travels with every number.
// - Rates are USD per million tokens at public list price. To update,
//   append entries with a newer effective date and bump the version.
export const PRICING_TABLE_VERSION = "analyze-pricing-v1";

const PRICING = [
  { model: "claude-opus-4-8", effective: "2025-12-01", input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  { model: "claude-opus-4-5", effective: "2025-11-01", input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  { model: "claude-sonnet-4-5", effective: "2025-09-29", input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  { model: "claude-haiku-4-5", effective: "2025-10-01", input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  { model: "gpt-5", effective: "2025-08-07", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  { model: "gpt-5-codex", effective: "2025-09-15", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  { model: "gpt-5.1", effective: "2025-11-12", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  { model: "gpt-5.1-codex", effective: "2025-11-12", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
  { model: "gpt-5.2-codex", effective: "2026-01-15", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
];

// claude-sonnet-4-5-20250929 -> claude-sonnet-4-5. Snapshot suffixes name
// the same priced model; anything else must match exactly.
function normalizeModelId(model) {
  return String(model || "").replace(/-20\d{6}$/, "");
}

export function priceEntryFor(model, startedAt) {
  const normalized = normalizeModelId(model);
  const candidates = PRICING
    .filter((entry) => entry.model === normalized)
    .sort((a, b) => b.effective.localeCompare(a.effective));
  if (candidates.length === 0) return null;
  const sessionDate = String(startedAt || "").slice(0, 10);
  // Without a session date the newest entry is the best available guess;
  // a session that PREDATES every effective date stays unpriced because
  // the listed rate may not describe what that era actually cost.
  if (!sessionDate) return candidates[0];
  return candidates.find((entry) => entry.effective <= sessionDate) || null;
}

// One session -> { estimated_usd, basis, reason }. Sessions with zero or
// multiple models are unpriced: usage counters are per-session, so a
// multi-model session cannot attribute tokens to a rate.
export function estimateSessionCost(session) {
  if (!Array.isArray(session.models) || session.models.length !== 1) {
    return { estimated_usd: null, basis: "unavailable", reason: session.models?.length ? "multi-model session" : "no model metadata" };
  }
  const entry = priceEntryFor(session.models[0], session.started_at);
  if (!entry) {
    return { estimated_usd: null, basis: "unavailable", reason: `no list price for ${normalizeModelId(session.models[0])}` };
  }
  const usage = session.usage;
  if (usage.fresh_input_tokens === null || usage.output_tokens === null) {
    return { estimated_usd: null, basis: "unavailable", reason: "usage counters incomplete" };
  }
  const estimate = (
    usage.fresh_input_tokens * entry.input
    + (usage.cache_read_tokens ?? 0) * entry.cache_read
    + (usage.cache_write_tokens ?? 0) * entry.cache_write
    + usage.output_tokens * entry.output
  ) / 1_000_000;
  return { estimated_usd: Number(estimate.toFixed(4)), basis: "versioned-price-estimate", reason: null };
}

export function buildCostSummary(sessions, estimates) {
  let estimatedTotal = null;
  let priced = 0;
  let pricedOutputTokens = 0;
  let totalOutputTokens = 0;
  const unpricedReasons = new Map();
  for (let index = 0; index < sessions.length; index += 1) {
    const output = sessions[index].usage.output_tokens ?? 0;
    totalOutputTokens += output;
    const estimate = estimates[index];
    if (estimate.estimated_usd !== null) {
      estimatedTotal = (estimatedTotal ?? 0) + estimate.estimated_usd;
      priced += 1;
      pricedOutputTokens += output;
    } else if (estimate.reason) {
      unpricedReasons.set(estimate.reason, (unpricedReasons.get(estimate.reason) || 0) + 1);
    }
  }
  return {
    reported_usd: null,
    estimated_usd: estimatedTotal === null ? null : Number(estimatedTotal.toFixed(2)),
    basis: priced > 0 ? "versioned-price-estimate" : "unavailable",
    pricing_table: PRICING_TABLE_VERSION,
    coverage: {
      sessions_priced: priced,
      sessions_total: sessions.length,
      priced_output_token_share: totalOutputTokens > 0 ? Number((pricedOutputTokens / totalOutputTokens).toFixed(3)) : null,
      unpriced_reasons: Object.fromEntries([...unpricedReasons.entries()].sort((a, b) => b[1] - a[1])),
    },
    note: "Estimated at public list prices from the versioned table; NOT billed spend. Local stores carry no provider-reported cost, and subscription usage is not billed per token.",
  };
}
