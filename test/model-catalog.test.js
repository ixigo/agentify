import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MODEL_CATALOG_VERSION,
  catalogTierOverrides,
  deriveTierModels,
  describeModelCatalog,
  isModelCatalogStale,
  loadModelCatalogCache,
  parseCodexModelCatalog,
  probeProviderCatalog,
  refreshModelCatalog,
  resetModelCatalogCache,
  resolveModelCatalogPath,
  resolveModelCatalogPolicy,
} from "../src/core/model-catalog.js";
import { buildFallbackChain, resolveTierModelSources, resolveTierModels } from "../src/core/profiles.js";
import { describeModelRoutes, refreshModelCatalogIfNeeded } from "../src/core/models.js";
import { getDelegateAdapter } from "../src/core/provider-registry.js";

// Shape of `codex debug models` as of Codex CLI 0.153 (September 2026):
// ranked by `priority` (1 = flagship), hidden internal entries, and a
// vendor retirement marker on GPT-5.4 Mini pointing at GPT-5.6 Luna.
const CODEX_CATALOG = {
  models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", priority: 1, visibility: "list", supported_in_api: true, context_window: 272000, upgrade: null },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", priority: 3, visibility: "hide", supported_in_api: true, context_window: 272000, upgrade: null },
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", priority: 6, visibility: "list", supported_in_api: true, context_window: 272000, upgrade: null },
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", priority: 7, visibility: "list", supported_in_api: true, context_window: 272000, upgrade: null },
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", priority: 8, visibility: "list", supported_in_api: true, context_window: 272000, upgrade: null },
    { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", priority: 23, visibility: "list", supported_in_api: true, context_window: 272000, upgrade: { model: "gpt-5.6-luna", retirement_at: "2026-08-31T19:00:00Z" } },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", priority: 43, visibility: "hide", supported_in_api: true, context_window: 272000, upgrade: null },
  ],
};

// A hypothetical next release: a new flagship above Astra, and Terra retired
// in favour of a successor. Exercises both derivation rules.
const CODEX_CATALOG_NEXT = {
  models: [
    { slug: "gpt-7-nova", display_name: "GPT-7-Nova", priority: 1, visibility: "list", supported_in_api: true },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", priority: 2, visibility: "list", supported_in_api: true },
    { slug: "gpt-6-terra", display_name: "GPT-6-Terra", priority: 5, visibility: "list", supported_in_api: true },
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", priority: 9, visibility: "list", supported_in_api: true, upgrade: { model: "gpt-6-terra", retirement_at: "2027-01-15T00:00:00Z" } },
  ],
};

// The release after that: the retired Terra has dropped out of the lineup
// entirely. The migration made earlier must survive its disappearance.
const CODEX_CATALOG_GONE = {
  models: [
    { slug: "gpt-7-nova", display_name: "GPT-7-Nova", priority: 1, visibility: "list", supported_in_api: true },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", priority: 2, visibility: "list", supported_in_api: true },
    { slug: "gpt-6-terra", display_name: "GPT-6-Terra", priority: 5, visibility: "list", supported_in_api: true },
  ],
};

function fakeExec(payload, { code = 0 } = {}) {
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv);
    return { code, stdout: typeof payload === "string" ? payload : JSON.stringify(payload), stderr: code === 0 ? "" : "boom" };
  };
  return { exec, calls };
}

async function withCacheDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-catalog-"));
  const env = { XDG_CACHE_HOME: dir };
  resetModelCatalogCache();
  try {
    return await run({ dir, env });
  } finally {
    resetModelCatalogCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("codex catalog parser keeps rank, visibility, API support, and retirement markers", () => {
  const models = parseCodexModelCatalog(JSON.stringify(CODEX_CATALOG));
  assert.equal(models.length, 7);
  const astra = models.find((model) => model.id === "gpt-6-astra");
  assert.deepEqual({ rank: astra.rank, listed: astra.listed, api: astra.api, context_window: astra.context_window }, { rank: 1, listed: true, api: true, context_window: 272000 });
  assert.equal(models.find((model) => model.id === "gpt-reserve").listed, false);
  assert.deepEqual(models.find((model) => model.id === "gpt-5.4-mini").upgrade, { model: "gpt-5.6-luna", retirement_at: "2026-08-31T19:00:00Z" });
  assert.throws(() => parseCodexModelCatalog(""), /no output/);
  assert.throws(() => parseCodexModelCatalog("not json"), /invalid JSON/);
  assert.throws(() => parseCodexModelCatalog(JSON.stringify({ nope: [] })), /no models array/);
});

test("tier derivation uses only vendor signals: ranking for frontier, retirement markers for pinned tiers", () => {
  const adapter = getDelegateAdapter("codex").tierModels;
  const current = deriveTierModels(adapter, parseCodexModelCatalog(JSON.stringify(CODEX_CATALOG)));
  // Today's lineup agrees with the adapter defaults: the frontier is sourced
  // from the catalog (it is what the vendor ranks first), nothing moves.
  assert.deepEqual(current.tiers, adapter);
  assert.equal(current.sources.frontier, "catalog");
  assert.equal(current.sources.balanced, "adapter");
  assert.deepEqual(current.notes, []);

  const next = deriveTierModels(adapter, parseCodexModelCatalog(JSON.stringify(CODEX_CATALOG_NEXT)));
  assert.equal(next.tiers.frontier, "gpt-7-nova", "a new top-ranked listed model becomes the frontier tier");
  assert.equal(next.tiers.balanced, "gpt-6-terra", "a retired pin follows the vendor's named replacement");
  assert.equal(next.tiers.economy, adapter.economy, "a pin that merely disappeared is kept, never guessed");
  assert.equal(next.sources.economy, "adapter");
  assert.match(next.notes.find((note) => note.startsWith("frontier")), /ranked first/);
  assert.match(next.notes.find((note) => note.startsWith("balanced")), /retirement \(2027-01-15\)/);
  assert.match(next.notes.find((note) => note.startsWith("economy")), /no longer lists/);

  // A migration already made survives the retired model leaving the lineup:
  // the previously derived replacement is carried, and if the vendor then
  // retires the replacement too, its marker is followed in turn.
  const gone = parseCodexModelCatalog(JSON.stringify(CODEX_CATALOG_GONE));
  const withoutPrevious = deriveTierModels(adapter, gone);
  assert.equal(withoutPrevious.tiers.balanced, adapter.balanced, "no history: keep and flag");
  const carried = deriveTierModels(adapter, gone, { previous: { balanced: "gpt-6-terra" } });
  assert.equal(carried.tiers.balanced, "gpt-6-terra");
  assert.equal(carried.sources.balanced, "catalog");
  assert.match(carried.notes.find((note) => note.startsWith("balanced")), /stays on gpt-6-terra/);
  const chained = deriveTierModels(adapter, parseCodexModelCatalog(JSON.stringify({
    models: [
      ...CODEX_CATALOG_GONE.models.filter((model) => model.slug !== "gpt-6-terra"),
      { slug: "gpt-6-terra", priority: 5, visibility: "list", supported_in_api: true, upgrade: { model: "gpt-7-terra", retirement_at: null } },
      { slug: "gpt-7-terra", priority: 4, visibility: "list", supported_in_api: true },
    ],
  })), { previous: { balanced: "gpt-6-terra" } });
  assert.equal(chained.tiers.balanced, "gpt-7-terra");
  // Chained retirements (old → middle → latest) resolve to the end of the
  // chain, stop at the last listed model when the chain dangles, and never
  // loop on a cycle.
  const chain = (extra) => parseCodexModelCatalog(JSON.stringify({
    models: [
      { slug: "gpt-7-nova", priority: 1, visibility: "list", supported_in_api: true },
      { slug: "gpt-5.6-terra", priority: 9, visibility: "list", supported_in_api: true, upgrade: { model: "gpt-6-terra", retirement_at: "2027-01-15T00:00:00Z" } },
      { slug: "gpt-6-terra", priority: 6, visibility: "list", supported_in_api: true, upgrade: { model: "gpt-7-terra", retirement_at: null } },
      ...extra,
    ],
  }));
  const deep = deriveTierModels(adapter, chain([{ slug: "gpt-7-terra", priority: 4, visibility: "list", supported_in_api: true }]));
  assert.equal(deep.tiers.balanced, "gpt-7-terra", "follows old → middle → latest to the end");
  assert.match(deep.notes.find((note) => note.startsWith("balanced")), /via 1 intermediate retirement/);
  const dangling = deriveTierModels(adapter, chain([]));
  assert.equal(dangling.tiers.balanced, "gpt-6-terra", "a replacement missing from the catalog stops the walk at the last listed model");
  const cyclic = deriveTierModels(adapter, chain([{ slug: "gpt-7-terra", priority: 4, visibility: "list", supported_in_api: true, upgrade: { model: "gpt-5.6-terra", retirement_at: null } }]));
  assert.equal(cyclic.tiers.balanced, "gpt-7-terra");
  const danglingFromPin = deriveTierModels(adapter, parseCodexModelCatalog(JSON.stringify({
    models: [
      ...CODEX_CATALOG.models.filter((model) => model.slug !== "gpt-5.6-terra"),
      { slug: "gpt-5.6-terra", priority: 7, visibility: "list", supported_in_api: true, upgrade: { model: "gpt-6-terra", retirement_at: null } },
    ],
  })));
  assert.equal(danglingFromPin.tiers.balanced, adapter.balanced);
  assert.match(danglingFromPin.notes.find((note) => note.startsWith("balanced")), /replacement gpt-6-terra is not listed yet/);
  // ...but an established migration to a still-listed model is not undone by
  // the intermediate step vanishing: old → (middle gone) with latest listed
  // and recorded as the previous choice keeps latest.
  const middleGone = deriveTierModels(adapter, parseCodexModelCatalog(JSON.stringify({
    models: [
      { slug: "gpt-7-nova", priority: 1, visibility: "list", supported_in_api: true },
      { slug: "gpt-7-terra", priority: 4, visibility: "list", supported_in_api: true },
      { slug: "gpt-5.6-terra", priority: 9, visibility: "list", supported_in_api: true, upgrade: { model: "gpt-6-terra", retirement_at: null } },
    ],
  })), { previous: { balanced: "gpt-7-terra" } });
  assert.equal(middleGone.tiers.balanced, "gpt-7-terra");
  assert.match(middleGone.notes.find((note) => note.startsWith("balanced")), /earlier catalog migration is kept/);

  // When both the adapter default and the earlier migration have vanished
  // with no successor named, the more recent choice is kept and flagged —
  // never a silent revert to the older retired ID.
  const bothGone = deriveTierModels(adapter, parseCodexModelCatalog(JSON.stringify({
    models: [{ slug: "gpt-7-nova", priority: 1, visibility: "list", supported_in_api: true }],
  })), { previous: { balanced: "gpt-6-terra" } });
  assert.equal(bothGone.tiers.balanced, "gpt-6-terra");
  assert.equal(bothGone.sources.balanced, "catalog");
  assert.match(bothGone.notes.find((note) => note.startsWith("balanced")), /neither it nor the adapter default gpt-5.6-terra is listed/);

  // A newer adapter default that is offered again wins over carried history.
  const adapterBack = deriveTierModels(adapter, parseCodexModelCatalog(JSON.stringify(CODEX_CATALOG)), { previous: { balanced: "gpt-6-terra" } });
  assert.equal(adapterBack.tiers.balanced, adapter.balanced);
  assert.equal(adapterBack.sources.balanced, "adapter");

  // Hidden entries never become a tier model even when ranked above.
  const hiddenTop = deriveTierModels(adapter, parseCodexModelCatalog(JSON.stringify({
    models: [{ slug: "gpt-secret", priority: 0, visibility: "hide" }, ...CODEX_CATALOG.models],
  })));
  assert.equal(hiddenTop.tiers.frontier, "gpt-6-astra");
});

test("probe reports failures without throwing and only runs for providers that declare one", async () => {
  const failing = fakeExec("", { code: 1 });
  const failed = await probeProviderCatalog("codex", { exec: failing.exec, now: () => new Date("2026-09-08T10:00:00Z") });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "boom");
  assert.deepEqual(failed.tiers, getDelegateAdapter("codex").tierModels, "a failed probe leaves adapter defaults untouched");
  assert.deepEqual(failing.calls, [["codex", "debug", "models"]]);

  const garbage = fakeExec("<html>");
  const unparsed = await probeProviderCatalog("codex", { exec: garbage.exec });
  assert.equal(unparsed.ok, false);
  assert.match(unparsed.error, /invalid JSON/);

  const untouched = fakeExec(CODEX_CATALOG);
  assert.equal(await probeProviderCatalog("claude", { exec: untouched.exec }), null, "Claude aliases self-update; no probe declared");
  assert.equal(await probeProviderCatalog("codex", { exec: untouched.exec, installed: false }), null, "a missing CLI is never executed");
  assert.deepEqual(untouched.calls, []);
});

test("refresh writes the XDG cache, feeds tier resolution, and yields to explicit pins", async () => {
  await withCacheDir(async ({ dir, env }) => {
    const { exec, calls } = fakeExec(CODEX_CATALOG_NEXT);
    const now = () => new Date("2026-09-08T10:00:00Z");
    const result = await refreshModelCatalog({ installed: { claude: true, codex: true, gemini: false, opencode: false }, exec, env, now });
    assert.equal(result.path, path.join(dir, "agentify", "model-catalog.json"));
    assert.equal(resolveModelCatalogPath({ env }), result.path);
    assert.deepEqual(calls, [["codex", "debug", "models"]], "only installed providers with a probe are executed");
    assert.deepEqual(result.skipped.map((entry) => entry.provider).sort(), ["claude", "gemini", "opencode"]);
    assert.match(result.skipped.find((entry) => entry.provider === "claude").reason, /aliases/);
    assert.deepEqual(result.changes, [
      { provider: "codex", tier: "balanced", from: "gpt-5.6-terra", to: "gpt-6-terra" },
      { provider: "codex", tier: "frontier", from: "gpt-6-astra", to: "gpt-7-nova" },
    ]);

    const cached = loadModelCatalogCache({ env });
    assert.equal(cached.version, MODEL_CATALOG_VERSION);
    assert.equal(cached.refreshed_at, "2026-09-08T10:00:00.000Z");
    assert.deepEqual(catalogTierOverrides(cached), { codex: { balanced: "gpt-6-terra", frontier: "gpt-7-nova" } });
    assert.equal(isModelCatalogStale(cached, { now }), false);
    assert.equal(isModelCatalogStale(cached, { now: () => new Date("2026-09-10T10:00:00Z") }), true);
    assert.equal(isModelCatalogStale(null), true);

    // Precedence: adapter < catalog < models.tiers pin.
    const sources = resolveTierModelSources({ models: { tiers: { codex: { frontier: "gpt-6-astra" } } } }, { catalog: cached });
    assert.deepEqual(sources.codex, {
      economy: { model: "gpt-5.6-luna", source: "adapter" },
      balanced: { model: "gpt-6-terra", source: "catalog" },
      frontier: { model: "gpt-6-astra", source: "config" },
    });
    assert.deepEqual(resolveTierModels({}, { catalog: cached }).codex, { economy: "gpt-5.6-luna", balanced: "gpt-6-terra", frontier: "gpt-7-nova" });
    // Reading the cache from disk (no injected catalog) gives the same answer,
    // and disabling the catalog removes the layer without touching pins.
    assert.equal(resolveTierModels({}, { env }).codex.frontier, "gpt-7-nova");
    assert.equal(resolveTierModels({ models: { catalog: { enabled: false } } }, { env }).codex.frontier, "gpt-6-astra");
    assert.throws(() => resolveModelCatalogPolicy({ models: { catalog: { enabled: "yes" } } }), /true or false/);

    // The fallback chain for a frontier route lands on the catalog frontier.
    const chain = buildFallbackChain({ kind: "heavy", route: { provider: "claude", model: "fable" }, profileName: "balanced", catalog: cached });
    assert.deepEqual(chain.entries[1], { provider: "codex", model: "gpt-7-nova", tier: "frontier", reason: "provider_unavailable" });

    // A later refresh in which the retired Terra is gone keeps the migration.
    const gone = await refreshModelCatalog({ installed: { codex: true }, exec: fakeExec(CODEX_CATALOG_GONE).exec, env, now: () => new Date("2026-09-09T10:00:00Z") });
    assert.deepEqual(gone.changes, [], "no tier moved: gpt-6-terra is carried, not reverted to the retired pin");
    assert.equal(catalogTierOverrides(loadModelCatalogCache({ env })).codex.balanced, "gpt-6-terra");

    // A transient probe failure keeps the last successful lineup in force
    // (tiers unchanged, still applied) and records the failure beside it;
    // refreshed_at advances so the broken CLI is retried on cadence.
    const broken = await refreshModelCatalog({ installed: { codex: true }, exec: fakeExec("", { code: 1 }).exec, env, now: () => new Date("2026-09-10T10:00:00Z") });
    assert.deepEqual(broken.changes, []);
    const retained = loadModelCatalogCache({ env });
    assert.equal(retained.refreshed_at, "2026-09-10T10:00:00.000Z");
    assert.equal(retained.providers.codex.ok, true);
    assert.equal(retained.providers.codex.last_error, "boom");
    assert.equal(retained.providers.codex.last_error_at, "2026-09-10T10:00:00.000Z");
    assert.equal(retained.providers.codex.probed_at, "2026-09-09T10:00:00.000Z", "probed_at stays the last successful probe");
    assert.deepEqual(catalogTierOverrides(retained), { codex: { balanced: "gpt-6-terra", frontier: "gpt-7-nova" } });
    assert.equal(describeModelCatalog(retained, { now: () => new Date("2026-09-10T11:00:00Z") }).providers.codex.last_error, "boom");
    // A CLI temporarily off PATH keeps its cached lineup (and migrations).
    const absent = await refreshModelCatalog({ installed: { codex: false }, exec: fakeExec("", { code: 1 }).exec, env, now: () => new Date("2026-09-11T10:00:00Z") });
    assert.match(absent.skipped.find((entry) => entry.provider === "codex").reason, /keeping the cached lineup/);
    assert.deepEqual(catalogTierOverrides(loadModelCatalogCache({ env })), { codex: { balanced: "gpt-6-terra", frontier: "gpt-7-nova" } });
    assert.deepEqual((await fs.readdir(path.dirname(result.path))).sort(), ["model-catalog.json"], "the cache is replaced atomically — no temp files left behind");

    // With no prior success, the failure itself is what gets cached.
    resetModelCatalogCache();
    await fs.rm(result.path, { force: true });
    const firstFailure = await refreshModelCatalog({ installed: { codex: true }, exec: fakeExec("", { code: 1 }).exec, env });
    assert.equal(firstFailure.catalog.providers.codex.ok, false);
    assert.deepEqual(catalogTierOverrides(loadModelCatalogCache({ env })), {});

    // A corrupt cache is "no catalog", never an error at routing time.
    await fs.writeFile(result.path, "{not json", "utf8");
    resetModelCatalogCache();
    assert.equal(loadModelCatalogCache({ env }), null);
    assert.equal(resolveTierModels({}, { env }).codex.frontier, "gpt-6-astra");
  });
});

test("models command surfaces the catalog, tier sources, and refreshes only when missing or stale", async () => {
  await withCacheDir(async ({ env }) => {
    const runtime = { commandExists: async (command) => command === "claude" || command === "codex", env };
    const before = await describeModelRoutes({}, runtime);
    assert.equal(before.catalog.enabled, true);
    assert.equal(before.catalog.refreshed_at, null);
    assert.match(before.catalog.hint, /models refresh/);
    const codexBefore = before.provider_details.find((detail) => detail.name === "codex");
    assert.deepEqual(codexBefore.tier_sources, { economy: "adapter", balanced: "adapter", frontier: "adapter" });
    assert.match(before.provider_details.find((detail) => detail.name === "claude").catalog_note, /aliases/);

    const { exec, calls } = fakeExec(CODEX_CATALOG_NEXT);
    const first = await refreshModelCatalogIfNeeded({}, { ...runtime, catalogExec: exec });
    assert.equal(first.refreshed, true);
    assert.equal(first.reason, "missing");
    const second = await refreshModelCatalogIfNeeded({}, { ...runtime, catalogExec: exec });
    assert.equal(second.refreshed, false);
    assert.equal(second.reason, "fresh");
    const forced = await refreshModelCatalogIfNeeded({}, { ...runtime, catalogExec: exec }, { force: true });
    assert.equal(forced.reason, "forced");
    assert.equal(calls.length, 2, "a fresh cache is not re-probed unless forced");
    const disabled = await refreshModelCatalogIfNeeded({ models: { catalog: { enabled: false } } }, { ...runtime, catalogExec: exec });
    assert.equal(disabled.reason, "disabled");

    const after = await describeModelRoutes({}, runtime);
    assert.equal(after.catalog.stale, false);
    assert.deepEqual(after.catalog.providers.codex.listed_models, ["gpt-7-nova", "gpt-6-astra", "gpt-6-terra", "gpt-5.6-terra"]);
    const codexAfter = after.provider_details.find((detail) => detail.name === "codex");
    assert.deepEqual(codexAfter.tier_models, { economy: "gpt-5.6-luna", balanced: "gpt-6-terra", frontier: "gpt-7-nova" });
    assert.deepEqual(codexAfter.tier_sources, { economy: "adapter", balanced: "catalog", frontier: "catalog" });
    const heavy = after.routes.find((route) => route.kind === "heavy");
    assert.equal(heavy.fallback_chain[1].model, "gpt-7-nova");

    const summary = describeModelCatalog(loadModelCatalogCache({ env }), { now: () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });
    assert.equal(summary.stale, true);
    assert.match(summary.hint, /refreshes it automatically/);
    assert.equal(describeModelCatalog(null, { policy: { enabled: false } }).enabled, false);
  });
});

test("frontier defaults are the September 2026 lineup and Claude aliases include fable", () => {
  assert.equal(getDelegateAdapter("codex").tierModels.frontier, "gpt-6-astra");
  assert.equal(getDelegateAdapter("claude").tierModels.frontier, "fable");
  assert.ok(getDelegateAdapter("claude").aliasModels.includes("fable"));
  assert.equal(getDelegateAdapter("claude").catalogProbe, null);
});
