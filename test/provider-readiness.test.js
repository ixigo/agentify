import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Isolate from any real provider catalog cached on the developer's machine
// (describeModelRoutes reads XDG_CACHE_HOME/agentify/model-catalog.json).
process.env.XDG_CACHE_HOME = mkdtempSync(path.join(os.tmpdir(), "agentify-readiness-cache-"));

import {
  canonicalReadinessState,
  detectDelegateReadiness,
  probeProviderReadiness,
  readinessAvailability,
} from "../src/core/provider-readiness.js";
import { describeModelRoutes } from "../src/core/models.js";
import { detectCapabilities } from "../src/core/toolchain.js";

// A readinessExec that answers --version and the provider auth probes from a
// fixture map keyed by the joined argv. Unlisted commands succeed silently.
function fakeExec(map) {
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv.join(" "));
    const hit = map[argv.join(" ")];
    return hit || { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("canonicalReadinessState maps the three facts to one state", () => {
  assert.equal(canonicalReadinessState({ exists: false }).state, "missing");
  assert.equal(canonicalReadinessState({ exists: true, launches: false }).state, "broken");
  assert.equal(canonicalReadinessState({ exists: true, launches: true, auth: { state: "ready" } }).state, "ready");
  assert.equal(canonicalReadinessState({ exists: true, launches: true, auth: { state: "missing" } }).state, "logged_out");
  assert.equal(canonicalReadinessState({ exists: true, launches: true, auth: { state: "unknown" } }).state, "unknown");
});

test("probeProviderReadiness classifies missing, broken, logged-out, and ready", async () => {
  const missing = await probeProviderReadiness("codex", {
    commandExists: async () => false,
    exec: fakeExec({}).exec,
  });
  assert.equal(missing.state, "missing");
  assert.equal(missing.available, false);

  // Exists on PATH but crashes at launch (the real gemini dyld case): broken,
  // never "missing" and never "available".
  const broken = await probeProviderReadiness("gemini", {
    commandExists: async () => true,
    exec: fakeExec({ "gemini --version": { code: 1, stdout: "", stderr: "dyld: symbol not found" } }).exec,
  });
  assert.equal(broken.state, "broken");
  assert.equal(broken.available, false);
  assert.equal(broken.exists, true);

  const loggedOut = await probeProviderReadiness("codex", {
    commandExists: async () => true,
    exec: fakeExec({
      "codex --version": { code: 0, stdout: "codex 0.156.0", stderr: "" },
      // Codex exits non-zero when logged out (and prints "Not logged in").
      "codex login status": { code: 1, stdout: "Not logged in", stderr: "" },
    }).exec,
  });
  assert.equal(loggedOut.state, "logged_out");
  assert.equal(loggedOut.available, true, "the binary launches; only auth is missing");
  assert.equal(loggedOut.next_step, "codex login");

  const ready = await probeProviderReadiness("claude", {
    commandExists: async () => true,
    exec: fakeExec({
      "claude --version": { code: 0, stdout: "claude 2.0.0", stderr: "" },
      "claude auth status": { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }), stderr: "" },
    }).exec,
  });
  assert.equal(ready.state, "ready");

  // Presence-only (no exec seam): installed reads as ready, preserving the
  // legacy availability behavior for callers that inject only commandExists.
  const presence = await probeProviderReadiness("codex", { commandExists: async () => true });
  assert.equal(presence.state, "ready");
  assert.equal(presence.launches, null);
});

test("a broken binary reads identically in models and doctor (#395)", async () => {
  const seams = {
    commandExists: async (bin) => bin === "codex" || bin === "claude",
    readinessExec: (argv) => {
      const key = argv.join(" ");
      if (key === "codex --version") return Promise.resolve({ code: 1, stdout: "", stderr: "dyld: symbol not found" });
      if (key === "claude --version") return Promise.resolve({ code: 0, stdout: "claude 2.0.0", stderr: "" });
      if (key === "claude auth status") return Promise.resolve({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" });
      return Promise.resolve({ code: 127, stdout: "", stderr: "not found" });
    },
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-readiness-root-"));
  try {
    const models = await describeModelRoutes({}, seams);
    const caps = await detectCapabilities({ root, commandExists: seams.commandExists, readinessExec: seams.readinessExec });
    // The two commands run the same probe, so codex classifies the same way.
    assert.equal(models.provider_readiness.codex.state, "broken");
    assert.equal(caps.providers.codex.state, "broken");
    assert.equal(models.provider_readiness.codex.state, caps.providers.codex.state);
    // A broken binary is neither "available" (doctor) nor route-selectable.
    assert.equal(caps.providers.codex.available, false);
    assert.equal(readinessAvailability(await detectDelegateReadiness(seams)).codex, false);
    // Claude is ready in both.
    assert.equal(models.provider_readiness.claude.state, "ready");
    assert.equal(caps.providers.claude.state, "ready");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
