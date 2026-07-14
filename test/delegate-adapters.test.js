import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DELEGATE_PROVIDER_NAMES,
  getDelegateAdapter,
  getProviderBootstrap,
} from "../src/core/provider-registry.js";
import {
  buildDelegateCommand,
  describeLimitEnforcement,
  describeModelRoutes,
  listUnsupportedControls,
  parseGeminiJsonOutput,
  parseOpenCodeJsonOutput,
  runDelegate,
} from "../src/core/models.js";
import {
  buildFallbackChain,
  resolveDelegateProviderPolicy,
  resolveTierModels,
} from "../src/core/profiles.js";

// Conformance fixtures (#297): every adapter is exercised against the same
// classes of provider behavior — good structured output, structured output
// with no usage info, and malformed output. A new provider cannot ship
// without entries here.
const FIXTURES = {
  claude: {
    good: JSON.stringify({
      type: "result",
      subtype: "success",
      result: "the answer",
      total_cost_usd: 0.0123,
      num_turns: 3,
      usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 50, output_tokens: 20 },
      modelUsage: { "claude-sonnet-5": {} },
    }),
    missingUsage: JSON.stringify({ type: "result", subtype: "success", result: "the answer" }),
    malformed: "I am not JSON { nope",
  },
  codex: {
    good: [
      JSON.stringify({ type: "session.created", model: "gpt-5.6-terra" }),
      "not json",
      JSON.stringify({ msg: { info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 600, output_tokens: 40 } } } }),
    ].join("\n"),
    missingUsage: JSON.stringify({ type: "turn.completed" }),
    malformed: "plain text, no events",
  },
  gemini: {
    good: JSON.stringify({
      response: "the answer",
      stats: { models: { "gemini-3.5-flash": { tokens: { prompt: 100, cached: 40, candidates: 20, thoughts: 5 } } } },
    }),
    missingUsage: JSON.stringify({ response: "the answer" }),
    malformed: "### markdown, not an envelope",
  },
  opencode: {
    good: [
      JSON.stringify({ type: "message.part.updated", properties: { part: { type: "text", text: "the answer" } } }),
      JSON.stringify({
        type: "message.updated",
        properties: { info: { modelID: "anthropic/claude-sonnet-5", cost: 0.0042, tokens: { input: 80, output: 30, reasoning: 5, cache: { read: 20, write: 10 } } } },
      }),
    ].join("\n"),
    missingUsage: JSON.stringify({ type: "session.idle" }),
    malformed: "%%% no events here",
  },
};

test("every registered delegate adapter declares the full capability contract", () => {
  assert.deepEqual(DELEGATE_PROVIDER_NAMES, ["claude", "codex", "gemini", "opencode"]);
  for (const provider of DELEGATE_PROVIDER_NAMES) {
    const adapter = getDelegateAdapter(provider);
    assert.ok(adapter, `${provider} has a delegate adapter`);
    assert.equal(typeof adapter.optIn, "boolean", `${provider} declares optIn`);
    assert.equal(typeof adapter.buildCommand, "function", `${provider} builds commands`);
    assert.equal(typeof adapter.parseOutput, "function", `${provider} parses output`);
    assert.ok(Array.isArray(adapter.aliasModels), `${provider} declares alias models`);
    for (const tier of ["economy", "balanced", "frontier"]) {
      assert.ok(tier in adapter.tierModels, `${provider} declares ${tier} tier model`);
    }
    for (const control of ["maxBudgetUsd", "maxTurns", "effort"]) {
      assert.equal(typeof adapter.controls[control], "boolean", `${provider} declares ${control} control`);
    }
    assert.ok(["native", "pre-run-only"].includes(adapter.enforcement.budget_usd));
    assert.ok(["native", "unavailable"].includes(adapter.enforcement.turns));
    assert.equal(adapter.enforcement.timeout, "agentify");
    assert.deepEqual(describeLimitEnforcement(provider), adapter.enforcement);
    assert.ok(FIXTURES[provider], `${provider} has conformance fixtures`);
  }
});

test("claude and codex stay default vendors; gemini and opencode are opt-in", () => {
  assert.equal(getDelegateAdapter("claude").optIn, false);
  assert.equal(getDelegateAdapter("codex").optIn, false);
  assert.equal(getDelegateAdapter("gemini").optIn, true);
  assert.equal(getDelegateAdapter("opencode").optIn, true);
});

test("adapter commands start with the provider binary, carry the prompt, and honor the model", () => {
  for (const provider of DELEGATE_PROVIDER_NAMES) {
    const bin = getProviderBootstrap(provider).bin;
    const readOnly = buildDelegateCommand({ provider, model: "some-model" }, "do the task");
    assert.equal(readOnly[0], bin, `${provider} command starts with its binary`);
    assert.ok(readOnly.includes("do the task"), `${provider} command carries the prompt`);
    assert.ok(readOnly.includes("some-model"), `${provider} command pins the requested model`);

    const noModel = buildDelegateCommand({ provider, model: null }, "do the task");
    assert.ok(!noModel.includes("--model"), `${provider} omits --model for the CLI default`);
    assert.ok(noModel.every((arg) => typeof arg === "string"), `${provider} argv is all strings`);
  }
});

test("write mode differs from read-only mode for every adapter", () => {
  for (const provider of DELEGATE_PROVIDER_NAMES) {
    const target = { provider, model: null };
    const readOnly = buildDelegateCommand(target, "task", { write: false });
    const write = buildDelegateCommand(target, "task", { write: true });
    assert.notDeepEqual(readOnly, write, `${provider} write mode changes the invocation`);
  }
  // Spot-check the actual flags so a swapped mapping cannot pass.
  assert.ok(buildDelegateCommand({ provider: "claude", model: null }, "t", { write: true }).includes("acceptEdits"));
  assert.ok(buildDelegateCommand({ provider: "codex", model: null }, "t", { write: true }).includes("--full-auto"));
  assert.ok(buildDelegateCommand({ provider: "codex", model: null }, "t", { write: false }).includes("read-only"));
  assert.ok(buildDelegateCommand({ provider: "gemini", model: null }, "t", { write: true }).includes("auto_edit"));
  // Gemini's default approval mode can still approve edits through policy
  // config — read-only must be strict plan mode.
  assert.ok(buildDelegateCommand({ provider: "gemini", model: null }, "t", { write: false }).includes("plan"));
  const openCodeReadOnly = buildDelegateCommand({ provider: "opencode", model: null }, "t", { write: false });
  assert.ok(openCodeReadOnly.includes("plan"), "opencode read-only pins the plan agent");
});

test("buildDelegateCommand rejects unregistered providers", () => {
  assert.throws(() => buildDelegateCommand({ provider: "mystery", model: null }, "task"), /No delegate adapter registered/);
});

test("every adapter parses its good fixture into the normalized usage contract", () => {
  for (const provider of DELEGATE_PROVIDER_NAMES) {
    const adapter = getDelegateAdapter(provider);
    const parsed = adapter.parseOutput(FIXTURES[provider].good);
    assert.ok(parsed, `${provider} parses its good fixture`);
    assert.equal(typeof parsed.input_tokens, "number", `${provider} reports input tokens`);
    assert.equal(typeof parsed.output_tokens, "number", `${provider} reports output tokens`);
    assert.ok(parsed.usage && typeof parsed.usage === "object", `${provider} reports a usage breakdown`);
    for (const key of ["fresh_input_tokens", "cache_write_tokens", "cache_read_tokens", "output_tokens"]) {
      assert.ok(key in parsed.usage, `${provider} usage has ${key}`);
    }
    assert.ok(parsed.cost_usd === null || typeof parsed.cost_usd === "number", `${provider} cost is a number or null, never invented`);
    assert.equal(adapter.reportsCostUsd, parsed.cost_usd !== null, `${provider} cost reporting matches its declared capability`);
    assert.ok(typeof parsed.resolved_model === "string" || parsed.resolved_model === null);
    assert.ok(Array.isArray(parsed.resolved_models));
  }
});

test("adapter parsers survive malformed output and missing usage without inventing numbers", () => {
  for (const provider of DELEGATE_PROVIDER_NAMES) {
    const adapter = getDelegateAdapter(provider);
    assert.equal(adapter.parseOutput(FIXTURES[provider].malformed), null, `${provider} returns null for malformed output`);
    assert.equal(adapter.parseOutput(""), null, `${provider} returns null for empty output`);

    const missing = adapter.parseOutput(FIXTURES[provider].missingUsage);
    if (missing !== null) {
      assert.equal(missing.cost_usd, null, `${provider} does not invent cost without usage`);
      assert.ok(missing.input_tokens === null || typeof missing.input_tokens === "number");
    }
  }
});

test("gemini parser normalizes envelope tokens and never reports dollars", () => {
  const parsed = parseGeminiJsonOutput(FIXTURES.gemini.good);
  assert.equal(parsed.output, "the answer");
  assert.equal(parsed.input_tokens, 100);
  assert.equal(parsed.usage.cache_read_tokens, 40);
  assert.equal(parsed.usage.fresh_input_tokens, 60);
  assert.equal(parsed.output_tokens, 25); // candidates + thoughts
  assert.equal(parsed.cost_usd, null);
  assert.equal(parsed.resolved_model, "gemini-3.5-flash");
});

test("opencode parser reads tokens, provider-reported cost, model, and final text", () => {
  const parsed = parseOpenCodeJsonOutput(FIXTURES.opencode.good);
  assert.equal(parsed.output, "the answer");
  assert.equal(parsed.input_tokens, 110); // input + cache read + cache write
  assert.equal(parsed.usage.fresh_input_tokens, 80);
  assert.equal(parsed.usage.cache_read_tokens, 20);
  assert.equal(parsed.usage.cache_write_tokens, 10);
  assert.equal(parsed.output_tokens, 35); // output + reasoning
  assert.equal(parsed.cost_usd, 0.0042);
  assert.equal(parsed.resolved_model, "anthropic/claude-sonnet-5");
});

// End-to-end conformance through runDelegate with an injected runtime: the
// same read-only, write, timeout, and missing-usage expectations for every
// adapter, exercised through the real routing/budget/telemetry path.
for (const provider of DELEGATE_PROVIDER_NAMES) {
  test(`runDelegate conformance: ${provider} read-only, write, timeout, and missing usage`, async () => {
    const bin = getProviderBootstrap(provider).bin;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-conformance-${provider}-`));
    try {
      const calls = [];
      const runtimeFor = (result) => ({
        commandExists: async (command) => command === bin,
        exec: async (command, args) => {
          calls.push([command, ...args]);
          return result;
        },
      });
      const options = { provider, env: {} };

      // Read-only run with good structured output.
      const good = await runDelegate(dir, {}, "quick", "answer the question", {
        ...options,
        runtime: runtimeFor({ code: 0, stdout: FIXTURES[provider].good, stderr: "" }),
      });
      assert.equal(good.provider, provider);
      assert.equal(good.status, "ok");
      assert.ok(Array.isArray(good.unsupported_controls), "unsupported controls are always reported");
      if (provider !== "codex") {
        // Codex delivers the answer via the last-message file, absent here.
        assert.equal(good.output, "the answer");
      }
      const readOnlyArgv = calls.at(-1);
      assert.equal(readOnlyArgv[0], bin);

      // Write mode changes the invocation.
      await runDelegate(dir, {}, "quick", "apply the fix", {
        ...options,
        write: true,
        runtime: runtimeFor({ code: 0, stdout: FIXTURES[provider].good, stderr: "" }),
      });
      assert.notDeepEqual(calls.at(-1).filter((a) => a !== "apply the fix"), readOnlyArgv.filter((a) => a !== "answer the question"));

      // Timeout is classified as timeout, not provider error.
      const timedOut = await runDelegate(dir, {}, "quick", "slow task", {
        ...options,
        runtime: runtimeFor({ code: 1, stdout: "", stderr: "delegate timed out after 120s" }),
      });
      assert.equal(timedOut.status, "timeout");

      // Missing usage never fails the run or invents cost; tokens fall back
      // to estimates flagged as estimated.
      const missing = await runDelegate(dir, {}, "quick", "no usage today", {
        ...options,
        runtime: runtimeFor({ code: 0, stdout: FIXTURES[provider].missingUsage, stderr: "" }),
      });
      assert.equal(missing.status, "ok");
      assert.equal(missing.cost_usd, undefined, `${provider} reports no cost when the provider reported none`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test("effort is rejected, not silently dropped, for adapters without an effort control", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-effort-reject-"));
  try {
    for (const provider of ["gemini", "opencode"]) {
      const bin = getProviderBootstrap(provider).bin;
      let execCalls = 0;
      await assert.rejects(
        () => runDelegate(dir, {}, "quick", "task", {
          provider,
          effort: "low",
          env: {},
          runtime: {
            commandExists: async (command) => command === bin,
            exec: async () => { execCalls += 1; return { code: 0, stdout: "", stderr: "" }; },
          },
        }),
        /no effort control/,
      );
      assert.equal(execCalls, 0, `${provider} process never starts on a rejected control`);
    }
    // Codex maps effort to its reasoning-effort config instead of dropping it.
    const codexArgv = buildDelegateCommand({ provider: "codex", model: null }, "task", { limits: { effort: "high" } });
    assert.ok(codexArgv.join(" ").includes("model_reasoning_effort=high"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("dollar/turn ceilings without native enforcement are surfaced per run", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-unsupported-"));
  try {
    const result = await runDelegate(dir, {}, "review", "check the change", {
      env: {},
      runtime: {
        commandExists: async (command) => command === "codex",
        exec: async () => ({ code: 0, stdout: FIXTURES.codex.good, stderr: "" }),
      },
    });
    assert.deepEqual(result.unsupported_controls, ["max_budget_usd", "max_turns"]);
    assert.equal(result.enforcement.budget_usd, "pre-run-only");

    const native = await runDelegate(dir, {}, "quick", "small fix", {
      env: {},
      runtime: {
        commandExists: async (command) => command === "claude",
        exec: async () => ({ code: 0, stdout: FIXTURES.claude.good, stderr: "" }),
      },
    });
    assert.deepEqual(native.unsupported_controls, []);
    assert.deepEqual(listUnsupportedControls("claude", { maxBudgetUsd: 1, maxTurns: 2, effort: "low" }), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("opt-in providers stay out of fallback chains until enabled in config", () => {
  const route = { provider: "claude", model: "sonnet" };
  const defaultChain = buildFallbackChain({ kind: "implement", route, profileName: "balanced" });
  assert.deepEqual(defaultChain.entries.map((entry) => entry.provider), ["claude", "codex"]);

  const enabled = buildFallbackChain({
    kind: "implement",
    route,
    profileName: "balanced",
    config: { models: { providers: { gemini: { enabled: true } } } },
  });
  assert.deepEqual(enabled.entries.map((entry) => entry.provider), ["claude", "codex", "gemini"]);
  const geminiEntry = enabled.entries.find((entry) => entry.provider === "gemini");
  assert.equal(geminiEntry.model, "gemini-3.5-flash");
  assert.equal(geminiEntry.tier, "balanced");

  const policy = resolveDelegateProviderPolicy({});
  assert.equal(policy.gemini.enabled, false);
  assert.equal(policy.opencode.enabled, false);
  assert.equal(policy.claude.enabled, true);
  assert.throws(() => resolveDelegateProviderPolicy({ models: { providers: { mystery: {} } } }), /registered delegate provider/);
  assert.throws(() => resolveDelegateProviderPolicy({ models: { providers: { gemini: { enabled: "yes" } } } }), /must be true or false/);
});

test("config routes and pinned fallbacks cannot bypass the opt-in gate", async () => {
  // A config route whose primary is a disabled opt-in provider fails loudly
  // instead of quietly joining production routing.
  assert.throws(
    () => buildFallbackChain({ kind: "implement", route: { provider: "gemini", model: null }, profileName: "balanced" }),
    /not enabled for routing/,
  );
  // Same for pinned fallbacks: enabling is the config gate, not adapter presence.
  assert.throws(
    () => buildFallbackChain({
      kind: "implement",
      route: { provider: "claude", model: "sonnet", fallbacks: [{ provider: "gemini" }] },
      profileName: "balanced",
    }),
    /not enabled for routing/,
  );
  // Once enabled, both work.
  const config = { models: { providers: { gemini: { enabled: true } } } };
  const chain = buildFallbackChain({
    kind: "implement",
    route: { provider: "claude", model: "sonnet", fallbacks: [{ provider: "gemini" }] },
    profileName: "balanced",
    config,
  });
  assert.equal(chain.entries[1].provider, "gemini");
  // An explicit per-run --provider override still reaches an installed
  // opt-in provider without editing config.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-optin-override-"));
  try {
    const result = await runDelegate(dir, {}, "quick", "answer", {
      provider: "gemini",
      env: {},
      runtime: {
        commandExists: async (command) => command === "gemini",
        exec: async () => ({ code: 0, stdout: FIXTURES.gemini.good, stderr: "" }),
      },
    });
    assert.equal(result.provider, "gemini");
    assert.equal(result.status, "ok");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an explicit null route model means the provider CLI default, even with pinned tier models", async () => {
  // The default review route declares codex with model: null. Pinned Codex
  // tier models must not silently replace the CLI default the route asked
  // for — what `agentify models` displays is what the run executes.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-cli-default-"));
  try {
    const calls = [];
    const result = await runDelegate(dir, {}, "review", "check it", {
      env: {},
      runtime: {
        commandExists: async (command) => command === "codex",
        exec: async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: FIXTURES.codex.good, stderr: "" }; },
      },
    });
    assert.equal(result.provider, "codex");
    assert.equal(result.model, null);
    assert.ok(!calls[0].includes("--model"), "review runs on the Codex CLI default, not a substituted tier model");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fallback chains reject unknown providers, loops, and tier escalation beyond policy", () => {
  assert.throws(
    () => buildFallbackChain({ kind: "quick", route: { provider: "mystery", model: null }, profileName: "balanced" }),
    /unknown delegate provider "mystery"/i,
  );

  const route = { provider: "claude", model: "sonnet", fallbacks: [{ provider: "mystery" }] };
  assert.throws(
    () => buildFallbackChain({ kind: "implement", route, profileName: "balanced" }),
    /unknown delegate provider "mystery"/i,
  );

  const loop = { provider: "claude", model: "sonnet", fallbacks: [{ provider: "codex", model: "gpt-5.6-terra" }, { provider: "codex", model: "gpt-5.6-terra" }] };
  assert.throws(
    () => buildFallbackChain({ kind: "implement", route: loop, profileName: "balanced" }),
    /unreachable|loops/,
  );

  // Same-provider fallbacks can never be selected (availability is
  // per-provider): rejected as unreachable rather than accepted as decoys.
  const sameProvider = { provider: "claude", model: "haiku", fallbacks: [{ provider: "claude", model: "sonnet" }] };
  assert.throws(
    () => buildFallbackChain({ kind: "quick", route: sameProvider, profileName: "balanced" }),
    /unreachable/,
  );

  // cost profile allows no tier raise: a frontier fallback on a balanced
  // route is cost-tier escalation beyond policy.
  const escalation = { provider: "claude", model: "sonnet", fallbacks: [{ provider: "codex", tier: "frontier" }] };
  assert.throws(
    () => buildFallbackChain({ kind: "implement", route: escalation, profileName: "cost" }),
    /escalates .* beyond/,
  );

  // A valid pinned chain is honored in order.
  const pinned = buildFallbackChain({
    kind: "implement",
    route: { provider: "claude", model: "sonnet", fallbacks: [{ provider: "codex" }] },
    profileName: "balanced",
  });
  assert.deepEqual(pinned.entries.map((entry) => `${entry.provider}/${entry.model}`), ["claude/sonnet", "codex/gpt-5.6-terra"]);
});

test("tier model configuration is validated against the registry", () => {
  assert.throws(() => resolveTierModels({ models: { tiers: { mystery: { economy: "x" } } } }), /registered delegate provider/);
  const overridden = resolveTierModels({ models: { tiers: { codex: { economy: "gpt-5.4-mini" } } } });
  assert.equal(overridden.codex.economy, "gpt-5.4-mini");
  assert.equal(overridden.codex.frontier, "gpt-5.6-sol");
  assert.equal(overridden.gemini.economy, "gemini-3.1-flash-lite");
});

test("models command derives provider details from the registry", async () => {
  const described = await describeModelRoutes({}, { commandExists: async (command) => command === "gemini" });
  assert.equal(described.providers.gemini, true);
  assert.equal(described.providers.claude, false);
  const gemini = described.provider_details.find((detail) => detail.name === "gemini");
  assert.equal(gemini.installed, true);
  assert.equal(gemini.opt_in, true);
  assert.equal(gemini.enabled_for_routing, false);
  assert.deepEqual(gemini.controls, { maxBudgetUsd: false, maxTurns: false, effort: false });
  const claude = described.provider_details.find((detail) => detail.name === "claude");
  assert.equal(claude.opt_in, false);
  assert.equal(claude.enabled_for_routing, true);
  // Gemini is installed but not enabled: no route may resolve to it.
  for (const route of described.routes) {
    assert.ok(!route.resolves_to.startsWith("gemini"), `${route.kind} must not fall back to an opt-in provider`);
  }
});

test("routes naming unregistered providers fail config validation loudly", async () => {
  await assert.rejects(
    () => describeModelRoutes({ models: { routes: { custom: { provider: "mystery" } } } }, { commandExists: async () => true }),
    /not a registered delegate provider/,
  );
});
