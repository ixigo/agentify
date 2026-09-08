// Provider model catalog: keeps the capability tiers current across vendor
// releases without a code change or an Agentify upgrade.
//
// Two mechanisms, both vendor-native and zero-network from Agentify's side:
//
// - Claude Code aliases (haiku / sonnet / opus / fable) already resolve to the
//   latest generation inside Claude Code itself, so the Claude tiers hold
//   aliases and need no probe.
// - Codex pins full model IDs, so its lineup is read from the installed CLI's
//   own ranked catalog (`codex debug models`, adapter-declared). The top-ranked
//   listed model becomes the frontier tier; a pinned tier model the vendor has
//   marked for retirement follows the vendor's own migration target. Nothing
//   else is guessed: a pinned model that simply disappears is kept and flagged.
//
// The probe result is cached under the XDG cache dir (same location as the
// invocation counters) and re-read by tier resolution. Derived tiers sit
// between the adapter defaults and `models.tiers` config, so an explicit pin
// always wins, and `agentify models` shows where each tier model came from.
// Like aliases, a derived tier is drift by design: the model can change when
// the vendor ships — which is exactly what the mechanism is for.

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DELEGATE_PROVIDER_NAMES, getDelegateAdapter } from "./provider-registry.js";

const execFileAsync = promisify(execFile);

export const MODEL_CATALOG_VERSION = "model-catalog-v1";
export const CAPABILITY_TIERS = ["economy", "balanced", "frontier"];
// A cached probe older than this is re-run by `agentify models` (when the
// catalog is enabled). Delegate runs only ever read the cache.
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15000;
const PROBE_MAX_BUFFER = 32 * 1024 * 1024;

export function resolveModelCatalogPath({ env = process.env, home = os.homedir() } = {}) {
  const configured = String(env.XDG_CACHE_HOME || "").trim();
  const cacheHome = configured && path.isAbsolute(configured)
    ? configured
    : path.join(home, ".cache");
  return path.join(cacheHome, "agentify", "model-catalog.json");
}

// models.catalog.enabled (default true) gates both the probe and applying the
// derived tiers. Off = adapter defaults + config pins only, no subprocess.
export function resolveModelCatalogPolicy(config = {}) {
  const configured = config.models?.catalog && typeof config.models.catalog === "object" && !Array.isArray(config.models.catalog)
    ? config.models.catalog
    : {};
  if (configured.enabled !== undefined && typeof configured.enabled !== "boolean") {
    throw new Error("models.catalog.enabled must be true or false");
  }
  return { enabled: configured.enabled !== false };
}

// The catalog parser lives with the other provider output parsers in the
// registry (which also declares the probe argv); re-exported for tests.
export { parseCodexModelCatalog } from "./provider-registry.js";

function rankOf(model) {
  return model.rank === null ? Number.POSITIVE_INFINITY : model.rank;
}

// Deterministic tier derivation from one provider's probed lineup. Only the
// vendor's own signals are used: its ranking picks the frontier, and its
// retirement/migration marker moves a pinned model. Everything else keeps the
// adapter default and says so.
//
// `previous` is the last successful derivation for this provider (catalog-
// sourced tiers only). A migration the catalog already made must survive the
// retired model dropping out of the lineup entirely: the adapter default is
// tried first (a newer Agentify may ship a better pin), then the previously
// derived model, and only then does the tier stay put and get flagged.
export function deriveTierModels(adapterTiers, models, { previous = {} } = {}) {
  const tiers = { ...adapterTiers };
  const sources = Object.fromEntries(CAPABILITY_TIERS.map((tier) => [tier, "adapter"]));
  const notes = [];
  const byId = new Map(models.map((model) => [model.id, model]));
  const usable = (entry) => Boolean(entry && entry.listed && entry.api);
  const candidates = models
    .filter(usable)
    .sort((a, b) => rankOf(a) - rankOf(b) || a.order - b.order);

  const top = candidates[0] || null;
  if (top && top.id !== adapterTiers.frontier) {
    tiers.frontier = top.id;
    sources.frontier = "catalog";
    notes.push(`frontier → ${top.id}: ranked first by the provider CLI (adapter default ${adapterTiers.frontier ?? "(none)"})`);
  } else if (top) {
    sources.frontier = "catalog";
  }

  // Resolve a pinned model through the vendor's retirement chain
  // (old → middle → latest), with cycle detection. Returns the deepest model
  // in the chain that is still offered, or null when none is; `hops` says
  // whether the chain moved at all and `dangling` names a replacement the
  // catalog does not contain.
  const resolve = (start) => {
    const seen = new Set();
    let currentId = start;
    let best = null;
    let hops = 0;
    let dangling = null;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = byId.get(currentId);
      if (!entry) {
        dangling = currentId;
        break;
      }
      if (usable(entry)) best = { model: currentId, hops, retirement_at: hops > 0 ? byId.get(start)?.upgrade?.retirement_at ?? null : null, dangling: null };
      if (!entry.upgrade?.model) break;
      currentId = entry.upgrade.model;
      hops += 1;
    }
    if (best) best.dangling = dangling;
    return best;
  };
  const retirementSuffix = (resolved) => (resolved.retirement_at ? ` (${resolved.retirement_at.slice(0, 10)})` : "");

  for (const tier of CAPABILITY_TIERS) {
    if (tier === "frontier") continue;
    const pinned = adapterTiers[tier];
    if (pinned === null || pinned === undefined) continue;
    const fromAdapter = resolve(pinned);
    if (fromAdapter && fromAdapter.model === pinned) {
      if (fromAdapter.dangling) {
        // The adapter default is still offered but the vendor already marks
        // it for retirement and its named replacement is not in the catalog.
        // An earlier catalog migration that is still offered beats moving
        // back onto a retiring model; otherwise stay put and say so.
        const prevResolved = previous[tier] ? resolve(previous[tier]) : null;
        if (prevResolved) {
          tiers[tier] = prevResolved.model;
          sources[tier] = "catalog";
          notes.push(`${tier} stays on ${prevResolved.model}: the provider marks the adapter default ${pinned} for retirement (its named replacement ${fromAdapter.dangling} is not listed), so the earlier catalog migration is kept`);
          continue;
        }
        notes.push(`${tier} keeps ${pinned}: the provider marks it for retirement but its named replacement ${fromAdapter.dangling} is not listed yet`);
      }
      continue;
    }
    if (fromAdapter) {
      tiers[tier] = fromAdapter.model;
      sources[tier] = "catalog";
      notes.push(`${tier} → ${fromAdapter.model}: the provider marks ${pinned} for retirement${retirementSuffix(fromAdapter)} and names ${fromAdapter.model} as its replacement${fromAdapter.hops > 1 ? ` (via ${fromAdapter.hops - 1} intermediate retirement${fromAdapter.hops > 2 ? "s" : ""})` : ""}`);
      continue;
    }
    const prev = previous[tier] || null;
    const carried = prev ? resolve(prev) : null;
    if (carried) {
      tiers[tier] = carried.model;
      sources[tier] = "catalog";
      notes.push(carried.model === prev
        ? `${tier} stays on ${carried.model}: the adapter default ${pinned} is no longer listed, so the earlier catalog migration is kept`
        : `${tier} → ${carried.model}: the provider marks ${prev} for retirement${retirementSuffix(carried)} and names ${carried.model} as its replacement (adapter default ${pinned} is no longer listed)`);
      continue;
    }
    if (prev) {
      // Neither the adapter default nor the earlier migration is offered and
      // the vendor names no successor: the more recent choice is kept (never
      // a silent revert to an older retired ID) and the gap is flagged.
      tiers[tier] = prev;
      sources[tier] = "catalog";
      notes.push(`${tier} keeps ${prev} (earlier catalog migration): neither it nor the adapter default ${pinned} is listed by the provider CLI anymore — pin a replacement under models.tiers`);
      continue;
    }
    notes.push(`${tier} keeps ${pinned}, which the provider CLI no longer lists — pin a replacement under models.tiers`);
  }
  return { tiers, sources, notes };
}

async function defaultExec(argv, { timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
      timeout: timeoutMs,
      maxBuffer: PROBE_MAX_BUFFER,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || error.message };
  }
}

function catalogProbeFor(provider) {
  const adapter = getDelegateAdapter(provider);
  const probe = adapter?.catalogProbe;
  if (!probe || !Array.isArray(probe.argv) || typeof probe.parse !== "function") return null;
  return probe;
}

function previousDerivedTiers(entry) {
  const derived = {};
  if (!entry || entry.ok !== true || !entry.tiers || !entry.sources) return derived;
  for (const tier of CAPABILITY_TIERS) {
    if (entry.sources[tier] === "catalog" && entry.tiers[tier]) derived[tier] = entry.tiers[tier];
  }
  return derived;
}

// Probe one provider's installed CLI for its lineup. Returns null when the
// adapter declares no probe (aliases self-update) or the CLI is not installed.
// `previous` is this provider's last cached entry, so a migration already made
// survives the retired model leaving the lineup.
export async function probeProviderCatalog(provider, { exec = defaultExec, env = process.env, now = () => new Date(), installed = true, previous = null } = {}) {
  const probe = catalogProbeFor(provider);
  if (!probe || !installed) return null;
  const adapter = getDelegateAdapter(provider);
  const probedAt = now().toISOString();
  const result = await exec(probe.argv, { timeoutMs: PROBE_TIMEOUT_MS, env });
  if (result.code !== 0) {
    return {
      provider,
      probe: probe.argv.join(" "),
      probed_at: probedAt,
      ok: false,
      error: String(result.stderr || result.stdout || `exit ${result.code}`).trim().split("\n")[0] || `exit ${result.code}`,
      models: [],
      tiers: { ...adapter.tierModels },
      sources: Object.fromEntries(CAPABILITY_TIERS.map((tier) => [tier, "adapter"])),
      notes: [],
    };
  }
  let models;
  try {
    models = probe.parse(result.stdout);
  } catch (error) {
    return {
      provider,
      probe: probe.argv.join(" "),
      probed_at: probedAt,
      ok: false,
      error: error.message,
      models: [],
      tiers: { ...adapter.tierModels },
      sources: Object.fromEntries(CAPABILITY_TIERS.map((tier) => [tier, "adapter"])),
      notes: [],
    };
  }
  const derived = deriveTierModels(adapter.tierModels, models, { previous: previousDerivedTiers(previous) });
  return {
    provider,
    probe: probe.argv.join(" "),
    probed_at: probedAt,
    ok: true,
    error: null,
    last_error: null,
    last_error_at: null,
    models,
    ...derived,
  };
}

const catalogMemo = new Map();

export function resetModelCatalogCache() {
  catalogMemo.clear();
}

// Synchronous read of the cached probe (tier resolution is synchronous and
// called many times per run). Memoized on file path + mtime; a missing or
// unreadable cache means "no catalog" — never an error at routing time.
export function loadModelCatalogCache({ env = process.env, home = os.homedir() } = {}) {
  const filePath = resolveModelCatalogPath({ env, home });
  let stat;
  try {
    stat = fsSync.statSync(filePath);
  } catch {
    catalogMemo.delete(filePath);
    return null;
  }
  const memo = catalogMemo.get(filePath);
  if (memo && memo.mtimeMs === stat.mtimeMs) return memo.catalog;
  let catalog = null;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    catalog = isValidCatalog(parsed) ? parsed : null;
  } catch {
    catalog = null;
  }
  catalogMemo.set(filePath, { mtimeMs: stat.mtimeMs, catalog });
  return catalog;
}

function isValidCatalog(value) {
  return Boolean(value && typeof value === "object" && value.version === MODEL_CATALOG_VERSION
    && typeof value.refreshed_at === "string" && value.providers && typeof value.providers === "object");
}

// Per-provider tier overrides from the cached catalog: only tiers the probe
// actually derived (source "catalog") are returned, so adapter defaults and
// config pins are never shadowed by a stale echo of themselves.
export function catalogTierOverrides(catalog) {
  const overrides = {};
  if (!catalog) return overrides;
  for (const [provider, entry] of Object.entries(catalog.providers || {})) {
    if (!entry || entry.ok !== true || !entry.tiers || !entry.sources) continue;
    for (const tier of CAPABILITY_TIERS) {
      if (entry.sources[tier] === "catalog" && entry.tiers[tier] !== undefined) {
        overrides[provider] ??= {};
        overrides[provider][tier] = entry.tiers[tier] === null ? null : String(entry.tiers[tier]);
      }
    }
  }
  return overrides;
}

export function isModelCatalogStale(catalog, { now = () => new Date(), maxAgeMs = MODEL_CATALOG_MAX_AGE_MS } = {}) {
  if (!catalog) return true;
  const refreshed = Date.parse(catalog.refreshed_at);
  if (!Number.isFinite(refreshed)) return true;
  return now().getTime() - refreshed > maxAgeMs;
}

// Re-probe every installed provider that declares a catalog probe and write
// the cache. `installed` maps provider -> boolean (from detectDelegateProviders).
export async function refreshModelCatalog({ installed = {}, exec, env = process.env, home = os.homedir(), now = () => new Date() } = {}) {
  const previous = loadModelCatalogCache({ env, home });
  const providers = {};
  const skipped = [];
  for (const provider of DELEGATE_PROVIDER_NAMES) {
    const probe = catalogProbeFor(provider);
    if (!probe) {
      skipped.push({ provider, reason: getDelegateAdapter(provider)?.catalogNote || "no catalog probe declared" });
      continue;
    }
    const before = previous?.providers?.[provider] || null;
    if (!installed[provider]) {
      // A CLI that is temporarily off PATH must not erase the lineup (and the
      // migrations) recorded while it was present.
      if (before) providers[provider] = before;
      skipped.push({ provider, reason: before ? "CLI not installed (keeping the cached lineup)" : "CLI not installed" });
      continue;
    }
    const probed = await probeProviderCatalog(provider, { exec, env, now, installed: true, previous: before });
    if (probed.ok || !before || before.ok !== true) {
      providers[provider] = probed;
      continue;
    }
    // A transient probe failure must not throw away a working lineup: keep
    // the last successful entry (its tiers stay in force) and record the
    // failure beside it. `refreshed_at` still advances so a broken CLI is
    // retried on the normal cadence, not on every command.
    providers[provider] = { ...before, last_error: probed.error, last_error_at: probed.probed_at };
  }
  const catalog = {
    version: MODEL_CATALOG_VERSION,
    refreshed_at: now().toISOString(),
    providers,
  };
  const filePath = resolveModelCatalogPath({ env, home });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Atomic replace: a delegate run reading the cache concurrently sees either
  // the old catalog or the new one, never a truncated file.
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
  resetModelCatalogCache();
  const changes = [];
  for (const [provider, entry] of Object.entries(providers)) {
    const before = previous?.providers?.[provider]?.tiers || getDelegateAdapter(provider).tierModels;
    for (const tier of CAPABILITY_TIERS) {
      if ((before?.[tier] ?? null) !== (entry.tiers?.[tier] ?? null)) {
        changes.push({ provider, tier, from: before?.[tier] ?? null, to: entry.tiers?.[tier] ?? null });
      }
    }
  }
  return { command: "models refresh", path: filePath, catalog, skipped, changes };
}

// Display summary for `agentify models` / `route explain`.
export function describeModelCatalog(catalog, { now = () => new Date(), policy = { enabled: true } } = {}) {
  if (!policy.enabled) {
    return { enabled: false, refreshed_at: null, stale: false, providers: {}, hint: "models.catalog.enabled is false: tier models come from adapter defaults and models.tiers only." };
  }
  if (!catalog) {
    return { enabled: true, refreshed_at: null, stale: true, providers: {}, hint: "No provider catalog cached yet — run `agentify models refresh` (or `agentify models`, which refreshes automatically)." };
  }
  const providers = {};
  for (const [provider, entry] of Object.entries(catalog.providers || {})) {
    providers[provider] = {
      ok: entry.ok === true,
      error: entry.error ?? null,
      last_error: entry.last_error ?? null,
      last_error_at: entry.last_error_at ?? null,
      probe: entry.probe ?? null,
      probed_at: entry.probed_at ?? null,
      listed_models: (entry.models || []).filter((model) => model.listed && model.api).map((model) => model.id),
      tiers: entry.tiers || {},
      sources: entry.sources || {},
      notes: entry.notes || [],
    };
  }
  const stale = isModelCatalogStale(catalog, { now });
  return {
    enabled: true,
    version: catalog.version,
    refreshed_at: catalog.refreshed_at,
    stale,
    providers,
    hint: stale ? "Catalog is older than 24h — `agentify models` refreshes it automatically; `agentify models refresh` forces it." : null,
  };
}
