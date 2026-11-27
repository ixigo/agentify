import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ALWAYS_FORBIDDEN_PATHS,
  DEFAULT_LOOP_LIMITS,
  LOOP_BRIEF_SCHEMA_VERSION,
  fetchJiraWorkItem,
  inferGates,
  ingestLoopBrief,
  initLoopBrief,
  loadLoopBrief,
  slugify,
  validateLoopBrief,
} from "../src/core/loop-brief.js";

function baseBrief(overrides = {}) {
  return {
    schema: LOOP_BRIEF_SCHEMA_VERSION,
    id: "sample",
    intent: "Do the thing.",
    gates: [{ id: "build", kind: "command", run: "make" }],
    ...overrides,
  };
}

async function tempRepo() {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentify-loop-brief-"));
}

test("a brief without gates is rejected: a loop with no gates has no definition of done", () => {
  assert.throws(
    () => validateLoopBrief({ schema: LOOP_BRIEF_SCHEMA_VERSION, id: "x", intent: "y" }, "t.yaml"),
    /gates is required/,
  );
  assert.throws(() => validateLoopBrief(baseBrief({ gates: [] }), "t.yaml"), /non-empty list/);
});

test("omitted ceilings resolve to conservative defaults, never to unbounded", () => {
  const brief = validateLoopBrief(baseBrief(), "t.yaml");
  assert.equal(brief.limits.max_iterations, DEFAULT_LOOP_LIMITS.max_iterations);
  assert.equal(brief.limits.max_budget_usd, DEFAULT_LOOP_LIMITS.max_budget_usd);
  assert.equal(brief.limits.max_turns, DEFAULT_LOOP_LIMITS.max_turns);
  // The derived per-iteration cap must multiply back to the run ceiling, so the
  // documented worst case is actually the worst case.
  assert.equal(
    Number((brief.limits.iteration_budget_usd * brief.limits.max_iterations).toFixed(2)),
    brief.limits.max_budget_usd,
  );
});

test("forbidden paths always include the built-in refusals and cannot be replaced", () => {
  const brief = validateLoopBrief(baseBrief({ forbidden_paths: ["infra/**"] }), "t.yaml");
  for (const pattern of ALWAYS_FORBIDDEN_PATHS) {
    assert.ok(brief.forbidden_paths.includes(pattern), `expected ${pattern} to survive`);
  }
  assert.ok(brief.forbidden_paths.includes("infra/**"));

  // Even an explicit empty list keeps them.
  const stripped = validateLoopBrief(baseBrief({ forbidden_paths: [] }), "t.yaml");
  assert.deepEqual(stripped.forbidden_paths, ALWAYS_FORBIDDEN_PATHS);
});

test("invalid ceilings, routes, and candidate counts are refused", () => {
  assert.throws(() => validateLoopBrief(baseBrief({ limits: { max_iterations: 0 } }), "t.yaml"), /max_iterations/);
  assert.throws(() => validateLoopBrief(baseBrief({ limits: { max_budget_usd: -1 } }), "t.yaml"), /max_budget_usd/);
  assert.throws(() => validateLoopBrief(baseBrief({ route: "turbo" }), "t.yaml"), /route must be one of/);
  assert.throws(() => validateLoopBrief(baseBrief({ candidates: 99 }), "t.yaml"), /candidates must be 8 or fewer/);
  assert.throws(() => validateLoopBrief(baseBrief({ ship: { pr: "merge" } }), "t.yaml"), /ship\.pr must be one of/);
});

test("a figma source needs a node URL or a screenshot, and the URL must carry a node-id", () => {
  assert.throws(
    () => validateLoopBrief(baseBrief({ source: { kind: "figma" } }), "t.yaml"),
    /figma_url, source\.figma_images, or both/,
  );
  assert.throws(
    () => validateLoopBrief(baseBrief({ source: { kind: "figma", figma_url: "https://figma.com/design/abc/App" } }), "t.yaml"),
    /not a usable Figma node URL/,
  );

  // Either input alone is enough.
  const withUrl = validateLoopBrief(baseBrief({
    source: { kind: "figma", figma_url: "https://www.figma.com/design/abc/App?node-id=9786-23492" },
  }), "t.yaml");
  assert.equal(withUrl.source.kind, "figma");

  const withImages = validateLoopBrief(baseBrief({
    source: { kind: "figma", figma_images: ["a.png", "b.png"] },
  }), "t.yaml");
  assert.deepEqual(withImages.source.figma_images, ["a.png", "b.png"]);
});

test("ship defaults commit on and PR off, because opening a PR is outward-facing", () => {
  const brief = validateLoopBrief(baseBrief(), "t.yaml");
  assert.equal(brief.ship.commit, true);
  assert.equal(brief.ship.pr, "none");
});

test("init writes a brief that run would accept", async () => {
  const root = await tempRepo();
  try {
    const result = await initLoopBrief(root, "My Feature", {}, { ui: true });
    assert.equal(result.brief.id, "my-feature");
    // Round-trip through the loader: a scaffold that init emits but run
    // rejects would be worse than no scaffold.
    const loaded = await loadLoopBrief(root, "my-feature", {});
    assert.equal(loaded.brief.id, "my-feature");
    assert.ok(loaded.brief.gates.some((gate) => gate.kind === "visual"));
    assert.ok(loaded.brief.serve, "a --ui scaffold needs a serve block for its browser gates");

    await assert.rejects(() => initLoopBrief(root, "My Feature", {}), /already exists/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slugify produces branch- and filesystem-safe ids", () => {
  assert.equal(slugify("XCT-10874: Handle failed UPI payment!"), "xct-10874-handle-failed-upi-payment");
  assert.equal(slugify("   "), "loop");
  assert.ok(slugify("x".repeat(200)).length <= 48);
});

test("gate inference only proposes commands the repo actually declares", async () => {
  const root = await tempRepo();
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { build: "tsc", lint: "eslint ." },
    }));
    const { gates, notes } = await inferGates(root);
    const ids = gates.map((gate) => gate.id);
    assert.deepEqual(ids, ["build", "lint", "tests", "review"]);
    // A missing script must be reported, not silently skipped — a thin ladder
    // that reads as comprehensive is the failure mode here.
    assert.ok(notes.some((note) => note.includes("typecheck")));
    assert.equal(gates.find((gate) => gate.id === "build").run, "npm run build");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("gate inference picks up the repo package manager and a playwright config", async () => {
  const root = await tempRepo();
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "x" } }));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "");
    await fs.writeFile(path.join(root, "playwright.config.ts"), "");
    const { gates } = await inferGates(root);
    assert.equal(gates.find((gate) => gate.id === "build").run, "pnpm build");
    assert.equal(gates.find((gate) => gate.id === "e2e").kind, "playwright");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("gate inference flags an unmeasured design reference rather than emitting a broken gate", async () => {
  const root = await tempRepo();
  try {
    const { gates, notes } = await inferGates(root, { hasVisualReference: true });
    assert.ok(!gates.some((gate) => gate.kind === "visual"));
    assert.ok(notes.some((note) => note.includes("visual")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ingest builds a bug brief that is test-first and typed as a fix", async () => {
  const root = await tempRepo();
  try {
    const draft = await ingestLoopBrief(root, { bug: "Totals drop the currency symbol on refunds", gates: [{ id: "b", run: "make" }] });
    const brief = validateLoopBrief(draft, "cli");
    assert.equal(brief.source.kind, "bug");
    assert.equal(brief.ship.type, "fix");
    assert.match(brief.intent, /test that fails for this reason/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ingest fails fast when a design reference does not exist", async () => {
  const root = await tempRepo();
  try {
    await assert.rejects(
      () => ingestLoopBrief(root, { figmaImages: ["missing/node.png"], gates: [{ id: "b", run: "make" }] }),
      /reference image not found/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ingest combines a Jira ticket with a Figma design and carries the key into the commit trailer", async () => {
  const root = await tempRepo();
  try {
    await fs.writeFile(path.join(root, "node.png"), "not really a png");
    const exec = async (command, args) => {
      assert.equal(command, "acli");
      assert.deepEqual(args, ["jira", "workitem", "view", "XCT-10874", "--json"]);
      return { stdout: JSON.stringify({ fields: { summary: "Handle failed UPI payment", description: "Retry once.", issuetype: { name: "Bug" } } }) };
    };
    const draft = await ingestLoopBrief(root, {
      jira: "xct-10874",
      figma: "https://www.figma.com/design/abc/App?node-id=9786-23492",
      figmaImages: ["node.png"],
      exec,
      gates: [{ id: "build", run: "make" }],
    });
    const brief = validateLoopBrief(draft, "cli");

    assert.equal(brief.source.kind, "jira");
    assert.equal(brief.source.jira_key, "XCT-10874");
    assert.deepEqual(brief.source.figma_images, ["node.png"]);
    assert.equal(brief.ship.refs, "XCT-10874");
    // A Jira "Bug" issue type should ship as a fix, not a feat.
    assert.equal(brief.ship.type, "fix");
    assert.match(brief.intent, /Handle failed UPI payment/);
    assert.match(brief.intent, /node-id=9786-23492/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("jira fetch falls back to the text view when --json is unsupported", async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push(args.join(" "));
    if (args.includes("--json")) {
      throw Object.assign(new Error("unknown flag"), { stderr: "unknown flag: --json" });
    }
    return { stdout: "Key: ABC-1\nSummary: Something broke\n" };
  };
  const item = await fetchJiraWorkItem("ABC-1", { exec });
  assert.equal(item.format, "text");
  assert.match(item.description, /Something broke/);
  assert.equal(calls.length, 2, "should try --json first, then the plain view");
});

test("jira fetch rejects a malformed key before shelling out", async () => {
  let called = false;
  const exec = async () => { called = true; return { stdout: "" }; };
  await assert.rejects(() => fetchJiraWorkItem("not-a-key", { exec }), /is not a Jira work item key/);
  assert.equal(called, false);
});

test("ingest with no source at all explains the available inputs", async () => {
  const root = await tempRepo();
  try {
    await assert.rejects(() => ingestLoopBrief(root, {}), /--task|--jira|--figma|--bug/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
