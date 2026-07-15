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
export const PRICING_TABLE_VERSION = "analyze-pricing-v2";

// cache_write is the 5-minute-TTL write rate (1.25x input for Claude);
// cache_write_1h is the 1-hour-TTL rate (2x input). Newer OpenAI models
// can also report explicit cache writes, priced at the published standard
// short-context rate when the local store does not expose request-level
// service/context tiers.
const PRICING = [
  { model: "claude-fable-5", effective: "2026-06-09", input: 10, output: 50, cache_read: 1, cache_write: 12.5, cache_write_1h: 20 },
  { model: "claude-opus-4-8", effective: "2025-12-01", input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, cache_write_1h: 10 },
  { model: "claude-opus-4-5", effective: "2025-11-01", input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, cache_write_1h: 10 },
  { model: "claude-sonnet-5", effective: "2026-09-01", input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 },
  { model: "claude-sonnet-5", effective: "2026-06-30", input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, cache_write_1h: 4 },
  { model: "claude-sonnet-4-5", effective: "2025-09-29", input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 },
  { model: "claude-haiku-4-5", effective: "2025-10-01", input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, cache_write_1h: 2 },
  { model: "gpt-5.6-sol", effective: "2026-07-09", input: 5, output: 30, cache_read: 0.5, cache_write: 6.25, cache_write_1h: 6.25, assumption: "standard short-context API rate (request-level context and service tier unavailable)" },
  { model: "gpt-5.6-terra", effective: "2026-07-09", input: 2.5, output: 15, cache_read: 0.25, cache_write: 3.125, cache_write_1h: 3.125, assumption: "standard short-context API rate (request-level context and service tier unavailable)" },
  { model: "gpt-5.6-luna", effective: "2026-07-09", input: 1, output: 6, cache_read: 0.1, cache_write: 1.25, cache_write_1h: 1.25, assumption: "standard short-context API rate (request-level context and service tier unavailable)" },
  { model: "gpt-5.5", effective: "2026-04-24", input: 5, output: 30, cache_read: 0.5, cache_write: 0, cache_write_1h: 0, assumption: "standard short-context API rate (request-level context and service tier unavailable)" },
  { model: "gpt-5.4", effective: "2026-03-05", input: 2.5, output: 15, cache_read: 0.25, cache_write: 0, cache_write_1h: 0, assumption: "standard short-context API rate (request-level context and service tier unavailable)" },
  { model: "gpt-5", effective: "2025-08-07", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0, cache_write_1h: 0 },
  { model: "gpt-5-codex", effective: "2025-09-15", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0, cache_write_1h: 0 },
  { model: "gpt-5.1", effective: "2025-11-12", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0, cache_write_1h: 0 },
  { model: "gpt-5.1-codex", effective: "2025-11-12", input: 1.25, output: 10, cache_read: 0.125, cache_write: 0, cache_write_1h: 0 },
  { model: "gpt-5.2-codex", effective: "2026-01-15", input: 1.75, output: 14, cache_read: 0.175, cache_write: 0, cache_write_1h: 0 },
];

const TOKEN_TYPE_ORDER = ["fresh_input", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h", "output"];

function costLineItem(tokenType, tokens, rate) {
  const count = Number(tokens) || 0;
  return {
    token_type: tokenType,
    tokens: count,
    rate_usd_per_million: rate,
    raw_usd: count * rate / 1_000_000,
  };
}

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
  // No session date means we cannot know the rate era: stay unpriced,
  // same as a session that predates every effective date.
  if (!sessionDate) return null;
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
  // Cache writes are priced per TTL when the provider reported the split
  // (5-minute at cache_write, 1-hour at cache_write_1h). Without a split
  // the 5-minute default-TTL rate applies, and the assumption is labeled.
  const assumptions = entry.assumption ? [entry.assumption] : [];
  let writeLineItems;
  if (usage.cache_write_5m_tokens != null || usage.cache_write_1h_tokens != null) {
    writeLineItems = [
      costLineItem("cache_write_5m", usage.cache_write_5m_tokens, entry.cache_write),
      costLineItem("cache_write_1h", usage.cache_write_1h_tokens, entry.cache_write_1h),
    ];
  } else {
    writeLineItems = [costLineItem("cache_write", usage.cache_write_tokens, entry.cache_write)];
    if ((usage.cache_write_tokens ?? 0) > 0 && entry.cache_write > 0) {
      assumptions.push("cache writes priced at the 5-minute TTL rate (TTL split unavailable)");
    }
  }
  const lineItems = [
    costLineItem("fresh_input", usage.fresh_input_tokens, entry.input),
    costLineItem("cache_read", usage.cache_read_tokens, entry.cache_read),
    ...writeLineItems,
    costLineItem("output", usage.output_tokens, entry.output),
  ];
  const raw = lineItems.reduce((total, item) => total + item.raw_usd, 0);
  return {
    estimated_usd: Number(raw.toFixed(4)),
    raw,
    basis: "versioned-price-estimate",
    reason: null,
    assumption: assumptions.join("; ") || null,
    model: entry.model,
    pricing_effective: entry.effective,
    line_items: lineItems,
  };
}

export function buildCostSummary(sessions, estimates) {
  let estimatedTotal = null;
  let priced = 0;
  let pricedOutputTokens = 0;
  let totalOutputTokens = 0;
  const unpricedReasons = new Map();
  const assumptions = new Map();
  const breakdown = new Map();
  for (let index = 0; index < sessions.length; index += 1) {
    const output = sessions[index].usage.output_tokens ?? 0;
    totalOutputTokens += output;
    const estimate = estimates[index];
    if (estimate.estimated_usd !== null) {
      // Sum full precision; round only the final total so a thousand tiny
      // sessions do not vanish to $0.00.
      estimatedTotal = (estimatedTotal ?? 0) + (estimate.raw ?? estimate.estimated_usd);
      priced += 1;
      pricedOutputTokens += output;
      if (estimate.assumption) {
        assumptions.set(estimate.assumption, (assumptions.get(estimate.assumption) || 0) + 1);
      }
      for (const item of estimate.line_items || []) {
        if (item.tokens === 0) continue;
        const key = [estimate.model, estimate.pricing_effective, item.token_type, item.rate_usd_per_million].join("\u0000");
        const current = breakdown.get(key) || {
          model: estimate.model,
          pricing_effective: estimate.pricing_effective,
          token_type: item.token_type,
          tokens: 0,
          rate_usd_per_million: item.rate_usd_per_million,
          raw_usd: 0,
        };
        current.tokens += item.tokens;
        current.raw_usd += item.raw_usd;
        breakdown.set(key, current);
      }
    } else if (estimate.reason) {
      unpricedReasons.set(estimate.reason, (unpricedReasons.get(estimate.reason) || 0) + 1);
    }
  }
  return {
    reported_usd: null,
    estimated_usd: estimatedTotal === null ? null : Number(estimatedTotal.toFixed(2)),
    basis: priced > 0 ? "versioned-price-estimate" : "unavailable",
    pricing_table: PRICING_TABLE_VERSION,
    breakdown: [...breakdown.values()]
      .sort((a, b) => a.model.localeCompare(b.model)
        || TOKEN_TYPE_ORDER.indexOf(a.token_type) - TOKEN_TYPE_ORDER.indexOf(b.token_type))
      .map(({ raw_usd: rawUsd, ...item }) => ({ ...item, estimated_usd: Number(rawUsd.toFixed(4)) })),
    coverage: {
      sessions_priced: priced,
      sessions_total: sessions.length,
      priced_output_token_share: totalOutputTokens > 0 ? Number((pricedOutputTokens / totalOutputTokens).toFixed(3)) : null,
      unpriced_reasons: Object.fromEntries([...unpricedReasons.entries()].sort((a, b) => b[1] - a[1])),
      assumptions: Object.fromEntries([...assumptions.entries()].sort((a, b) => b[1] - a[1])),
    },
    note: "Estimated at public list prices from the versioned table; NOT billed spend. Local stores carry no provider-reported cost, and subscription usage is not billed per token.",
  };
}
