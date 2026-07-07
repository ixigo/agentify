import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_MODEL_ROUTES,
  buildDelegateCommand,
  buildDelegatePrompt,
  describeModelRoutes,
  normalizeRouteKind,
  pickRouteTarget,
  resolveModelRoutes,
  runDelegate,
} from "../src/core/models.js";

test("resolveModelRoutes returns defaults and applies config overrides", () => {
  const defaults = resolveModelRoutes({});
  assert.deepEqual(Object.keys(defaults).sort(), Object.keys(DEFAULT_MODEL_ROUTES).sort());
  assert.equal(defaults.quick.provider, "claude");
  assert.equal(defaults.quick.model, "haiku");
  assert.equal(defaults.review.provider, "codex");

  const overridden = resolveModelRoutes({
    models: {
      routes: {
        quick: { model: "sonnet" },
        docs: { provider: "codex", model: "custom-model", use: "docs work" },
      },
    },
  });
  assert.equal(overridden.quick.model, "sonnet");
  assert.equal(overridden.quick.provider, "claude");
  assert.equal(overridden.docs.provider, "codex");
  assert.equal(overridden.docs.model, "custom-model");
});

test("normalizeRouteKind rejects unknown kinds", () => {
  const routes = resolveModelRoutes({});
  assert.equal(normalizeRouteKind("REVIEW", routes), "review");
  assert.throws(() => normalizeRouteKind("bogus", routes), /Unknown delegate kind/);
});

test("pickRouteTarget uses the route provider and falls back across vendors", () => {
  const route = { provider: "codex", model: null };
  assert.deepEqual(
    pickRouteTarget(route, { claude: true, codex: true }),
    { provider: "codex", model: null, fallback: false }
  );
  assert.deepEqual(
    pickRouteTarget(route, { claude: true, codex: false }),
    { provider: "claude", model: "opus", fallback: true }
  );
  assert.equal(pickRouteTarget(route, { claude: false, codex: false }), null);

  const claudeRoute = { provider: "claude", model: "haiku" };
  assert.deepEqual(
    pickRouteTarget(claudeRoute, { claude: false, codex: true }),
    { provider: "codex", model: null, fallback: true }
  );
});

test("buildDelegateCommand builds provider CLI invocations", () => {
  assert.deepEqual(
    buildDelegateCommand({ provider: "claude", model: "haiku" }, "fix typo"),
    ["claude", "-p", "fix typo", "--model", "haiku"]
  );
  assert.deepEqual(
    buildDelegateCommand({ provider: "claude", model: "haiku" }, "fix typo", { write: true }),
    ["claude", "-p", "fix typo", "--model", "haiku", "--permission-mode", "acceptEdits"]
  );
  assert.deepEqual(
    buildDelegateCommand({ provider: "codex", model: null }, "review this"),
    ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "review this"]
  );
  assert.deepEqual(
    buildDelegateCommand({ provider: "codex", model: "some-model" }, "do it", { write: true, lastMessagePath: "/tmp/last.md" }),
    ["codex", "exec", "--skip-git-repo-check", "--model", "some-model", "--full-auto", "--output-last-message", "/tmp/last.md", "do it"]
  );
});

test("buildDelegatePrompt frames review prompts and embeds diff sections", () => {
  const review = buildDelegatePrompt("review", "", { diffSection: "## Diff\nabc" });
  assert.match(review, /independent code review/);
  assert.match(review, /## Diff/);

  const quick = buildDelegatePrompt("quick", "rename a variable");
  assert.equal(quick, "rename a variable");
});

test("runDelegate routes through the injected runtime and reports fallback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-delegate-"));
  try {
    const calls = [];
    const result = await runDelegate(dir, {}, "quick", "fix the typo in README", {
      runtime: {
        commandExists: async (command) => command === "codex",
        exec: async (command, args) => {
          calls.push([command, ...args]);
          return { code: 0, stdout: "done\n", stderr: "" };
        },
      },
    });
    assert.equal(result.kind, "quick");
    assert.equal(result.provider, "codex");
    assert.equal(result.used_fallback, true);
    assert.equal(result.output, "done");
    assert.equal(result.exit_code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "codex");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runDelegate requires a task for non-review kinds and any available provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-delegate-err-"));
  try {
    await assert.rejects(
      () => runDelegate(dir, {}, "quick", "", {
        runtime: { commandExists: async () => true, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
      }),
      /requires a task/
    );
    await assert.rejects(
      () => runDelegate(dir, {}, "quick", "do something", {
        runtime: { commandExists: async () => false },
      }),
      /No available CLI/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("describeModelRoutes reports availability and resolution", async () => {
  const described = await describeModelRoutes({}, {
    commandExists: async (command) => command === "claude",
  });
  assert.equal(described.providers.claude, true);
  assert.equal(described.providers.codex, false);
  const review = described.routes.find((route) => route.kind === "review");
  assert.equal(review.available, true);
  assert.match(review.resolves_to, /claude\/opus \(fallback\)/);
  const quick = described.routes.find((route) => route.kind === "quick");
  assert.equal(quick.resolves_to, "claude/haiku");
});
