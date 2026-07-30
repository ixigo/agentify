import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildNarrationPacket,
  collectThemeDiffs,
  packetPreview,
  resolveNarrationDepth,
  THEME_ID_MAP,
} from "../src/core/git-analyze/packet.js";
import {
  assembleNarration,
  buildNarrationPrompt,
  containsBareNumber,
  narrateGitAnalyze,
  resolveNarrationBudgetUsd,
  resolveNarrationProvider,
  substitutePlaceholders,
  NARRATION_INSTRUCTIONS,
} from "../src/core/git-analyze/narrate.js";
import { runCli } from "../src/main.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixtures. A synthetic report carrying a `git-analyze-v1` summary and the
// commit records its subjects come from. The theme id deliberately embeds an
// absolute path — the packet must never let it travel.
// ---------------------------------------------------------------------------

const ABSOLUTE_THEME_ID = "/Users/someone/secret-project/wt/354::issue:#123";

function syntheticReport() {
  return {
    scope: "local",
    commits: [
      { sha: "aaaaaaa1", subject: "feat(core): add the widget (#123)", files: ["src/widget.js"] },
      { sha: "bbbbbbb2", subject: "fix(core): guard the widget (#123)", files: ["src/widget.js"] },
      { sha: "ccccccc3", subject: "test(core): cover the widget (#123)", files: ["test/widget.test.js"] },
      { sha: "ddddddd4", subject: "docs: tidy the readme", files: ["README.md"] },
    ],
    summary: {
      schema: "git-analyze-v1",
      scope: "local",
      window: { label: "last 90 days", since: "2026-04-01", until: "2026-07-01", timezone: "UTC" },
      identities: { emails: ["me@example.com"] },
      repositories: [{
        name: "secret-project",
        path: "/Users/someone/secret-project",
        commits: 4,
        insertions: 40,
        deletions: 6,
        active_days: 3,
        first_commit: "2026-04-02T00:00:00Z",
        last_commit: "2026-06-20T00:00:00Z",
      }],
      totals: {
        commits: 4, insertions: 40, deletions: 6, files: 5, active_days: 3, merges: 0,
        authors: 1, repositories: 1, first_commit: "2026-04-02T00:00:00Z", last_commit: "2026-06-20T00:00:00Z",
      },
      distributions: {
        by_type: { denominator: 4, counted: 4, items: [{ key: "feat", commits: 1 }, { key: "fix", commits: 1 }] },
        by_scope: { denominator: 4, counted: 3, items: [{ key: "core", commits: 3 }] },
      },
      themes: [
        {
          id: ABSOLUTE_THEME_ID,
          repository: "secret-project",
          key_kind: "issue",
          title: "Issue #123",
          issue_keys: ["#123"],
          branches: [],
          scopes: ["core"],
          type_histogram: { feat: 1, fix: 1, test: 1 },
          commits: 3,
          insertions: 36,
          deletions: 5,
          files_changed: 4,
          first_commit: "2026-04-02T00:00:00Z",
          last_commit: "2026-06-20T00:00:00Z",
          top_files: [{ path: "src/widget.js", commits: 3 }, { path: "test/widget.test.js", commits: 1 }],
          merge_subjects: ["Merge pull request #9 from feature/widget"],
          iteration_signal: { kind: "issue", key: "#123", commits: 3 },
          shas: ["aaaaaaa1", "bbbbbbb2", "ccccccc3"],
        },
      ],
      smaller_changes: [{ repository: "secret-project", commits: 1, insertions: 4, deletions: 1, distinct_keys: 1, shas: ["ddddddd4"] }],
      evidence: {},
      limitations: ["1 merge commit(s) are reported as delivery evidence but excluded from counts."],
    },
  };
}

// A claude JSON envelope wrapping a narration payload, as the CLI returns it.
// With --json-schema the validated object is on `structured_output`; model it
// that way so the extraction path matches a real run.
function claudeEnvelope(payload, { cost = 0.0021, isError = false, subtype = "success" } = {}) {
  const envelope = {
    type: "result",
    subtype,
    is_error: isError,
    total_cost_usd: cost,
  };
  if (payload !== undefined) envelope.structured_output = payload;
  return { code: 0, stdout: JSON.stringify(envelope), stderr: "" };
}

const NO_STORE_DEPS = {
  // A store detector that always reports "no store" and a recorder that must
  // never be called on the no-store path.
  stats: {
    resolveDelegationsPath: (root) => path.join(root, ".agentify", "delegations.jsonl"),
    recordDelegation: async () => { throw new Error("recordDelegation must not run without an existing store"); },
  },
  stat: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
};

// ---------------------------------------------------------------------------
// Packet: sanitization, opaque ids, and the metadata/diff boundary.
// ---------------------------------------------------------------------------

test("packet carries opaque theme ids and never ships an absolute path, home dir, or remote URL", () => {
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  const json = JSON.stringify(packet);

  // Opaque per-run ids only; the real (path-bearing) id stays behind the map.
  assert.deepEqual(packet.themes.map((theme) => theme.id), ["t1"]);
  assert.equal(packet[THEME_ID_MAP].get("t1"), ABSOLUTE_THEME_ID);
  // The symbol-keyed map is never serialized onto the wire.
  assert.ok(!json.includes(ABSOLUTE_THEME_ID), "the absolute theme id must not appear in the packet");
  assert.ok(!json.includes("/Users/"), "no absolute path anywhere in the packet");
  assert.ok(!json.includes(os.homedir()) || os.homedir() === "/", "no home directory in the packet");

  // No remote URL and — at --depth metadata — no diff body.
  assert.ok(!/https?:\/\//.test(json), "no URL in the packet");
  assert.ok(!json.includes("git@"), "no scp-style remote in the packet");
  assert.ok(!packet.themes.some((theme) => "diff_hunks" in theme), "no diff body at --depth metadata");

  // The packet still carries the metadata the model needs: file paths,
  // subjects, merge subjects, and the iteration signal.
  assert.deepEqual(packet.themes[0].file_paths, ["src/widget.js", "test/widget.test.js"]);
  assert.ok(packet.themes[0].subjects.length === 3);
  assert.equal(packet.themes[0].iteration_signal.commits, 3);
  assert.deepEqual(packet.identities, { emails: ["me@example.com"] });
});

test("the packet scrubs URLs and scp-style remotes from copied free text", () => {
  const report = syntheticReport();
  report.commits[0].subject = "feat: point at https://internal.example/secret and git@host:acme/repo (#123)";
  report.summary.themes[0].shas = ["aaaaaaa1"];
  const packet = buildNarrationPacket(report, { depth: "metadata" });
  const json = JSON.stringify(packet);
  assert.ok(!json.includes("https://internal.example/secret"), "a URL never travels in the packet");
  assert.ok(!json.includes("git@host:acme/repo"), "an scp-style remote never travels");
  assert.ok(json.includes("[url]"));
});

test("redaction is asserted on the packet, not merely relied upon", () => {
  const report = syntheticReport();
  // A subject and a limitation that already went through redactSensitiveText at
  // collection (#349) would be clean; assert the packet is clean regardless.
  report.commits[0].subject = "feat: wire token AWS_SECRET_ACCESS_KEY=AKIA123DEADBEEF into config (#123)";
  report.summary.limitations.push("saw Bearer abcdef0123456789 in a hook");
  const packet = buildNarrationPacket(report, { depth: "metadata" });
  const json = JSON.stringify(packet);
  assert.ok(json.includes("[REDACTED]"), "a secret-shaped token is redacted in the packet");
  assert.ok(!json.includes("AKIA123DEADBEEF"), "the raw secret value never reaches the packet");
  assert.ok(!json.includes("abcdef0123456789"), "the raw bearer token never reaches the packet");
});

test("--depth diff adds bounded redacted hunks; --depth metadata never does", async () => {
  const report = syntheticReport();
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: "diff --git a/src/widget.js b/src/widget.js\n+ const token = process.env.API_TOKEN=deadbeef01234567\n- old line\n" };
  };
  const { hunksByTheme, bytes, themesWithDiff } = await collectThemeDiffs(path.sep, report, { exec });
  assert.ok(themesWithDiff >= 1);
  assert.ok(bytes > 0);
  assert.ok(calls.every((call) => call[0] === "git" && call.includes("show") && call.includes("--literal-pathspecs")), "diff depth only ever runs git show with literal pathspecs");

  const diffPacket = buildNarrationPacket(report, { depth: "diff", diffHunksByTheme: hunksByTheme });
  assert.ok(Array.isArray(diffPacket.themes[0].diff_hunks) && diffPacket.themes[0].diff_hunks.length > 0);
  // Even diff bodies are redacted on the way into the packet.
  assert.ok(!JSON.stringify(diffPacket).includes("deadbeef01234567"), "diff hunks are redacted");

  const metaPacket = buildNarrationPacket(report, { depth: "metadata", diffHunksByTheme: hunksByTheme });
  assert.ok(!("diff_hunks" in metaPacket.themes[0]), "metadata depth ignores diff hunks");
});

test("collectThemeDiffs bounds the total diff by BYTES even for multibyte content", async () => {
  const report = syntheticReport();
  // A large multibyte diff (each emoji is 4 UTF-8 bytes) must not overrun the
  // byte cap via character-count slicing.
  const big = `diff --git a/x b/x\n+${"🚀".repeat(100000)}\n`;
  const { bytes } = await collectThemeDiffs(path.sep, report, { exec: async () => ({ stdout: big }) });
  assert.ok(bytes <= 60000, `total diff bytes (${bytes}) must respect the 60000-byte cap`);
});

test("collectThemeDiffs never ships source under --global", async () => {
  const report = syntheticReport();
  report.scope = "global";
  let ran = false;
  const { hunksByTheme, themesWithDiff } = await collectThemeDiffs("/anything", report, { exec: async () => { ran = true; return { stdout: "x" }; } });
  assert.equal(ran, false, "global scope must not run git show");
  assert.deepEqual(hunksByTheme, {});
  assert.equal(themesWithDiff, 0);
});

test("the packet token ceiling drops the lowest-value themes and names them", () => {
  const report = syntheticReport();
  const base = report.summary.themes[0];
  // A big high-value theme and a small old low-value one.
  report.summary.themes = [
    { ...base, id: "/root::issue:#900", title: "Issue #900", commits: 50, last_commit: "2026-06-30T00:00:00Z", subjects: [], shas: ["aaaaaaa1"] },
    { ...base, id: "/root::issue:#001", title: "Issue #001", commits: 2, last_commit: "2026-04-01T00:00:00Z", shas: ["bbbbbbb2"] },
  ];
  const packet = buildNarrationPacket(report, { depth: "metadata", tokenCeiling: 1 });
  assert.ok(packet.dropped_themes.length >= 1, "over the ceiling, at least one theme is dropped");
  // The most valuable theme survives longest.
  const droppedTitles = packet.dropped_themes.map((theme) => theme.title);
  assert.ok(droppedTitles.includes("Issue #001"), "the smallest/oldest theme is dropped first");
});

// ---------------------------------------------------------------------------
// The no-invented-number validator and placeholder substitution.
// ---------------------------------------------------------------------------

test("a placeholder in title or evidence_gap is substituted, never left raw", () => {
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  const result = assembleNarration({
    entries: [{ title: "Shipped {{theme.commits}} commits", what: "did work", how_it_helped: "reduced risk", theme_ids: ["t1"], confidence: "high", evidence_gap: "only {{theme.files}} files seen" }],
  }, packet);
  const entry = result.entries[0];
  assert.equal(entry.source, "model");
  assert.equal(entry.title, "Shipped 3 commits");
  assert.equal(entry.evidence_gap, "only 4 files seen");
  assert.ok(!JSON.stringify(entry).includes("{{"), "no raw placeholder survives anywhere in the entry");
});

test("a malformed narrative field is rejected to the deterministic template, not coerced", () => {
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  const result = assembleNarration({
    entries: [
      { title: "Nully", what: null, how_it_helped: "x", theme_ids: ["t1"], confidence: "high" },
      { title: "Objecty", what: "ok", how_it_helped: { nested: true }, theme_ids: ["t1"], confidence: "high" },
    ],
  }, packet);
  assert.ok(result.entries.every((entry) => entry.source === "deterministic"));
  assert.ok(!JSON.stringify(result.entries).includes("[object Object]"), "an object field is never stringified into the entry");
  assert.ok(result.rejections.every((rej) => /invalid narrative field/.test(rej.reason)));
});

test("the token ceiling bounds non-theme fields too (limitations, smaller changes)", () => {
  const report = syntheticReport();
  report.summary.themes = [];
  report.summary.smaller_changes = [];
  report.summary.limitations = [Array.from({ length: 200 }, () => "a very long limitation line that repeats").join(" ")];
  const packet = buildNarrationPacket(report, { depth: "metadata", tokenCeiling: 100 });
  assert.ok(packetPreview(packet).token_estimate <= 100 || packet.limitations.length === 0, "the ceiling trims limitations, not only themes");
  // The headline totals always survive the ceiling.
  assert.equal(packet.totals.commits, 4);
});

test("identity emails and window strings are redacted like every other packet field", () => {
  const report = syntheticReport();
  report.summary.identities = { emails: ["TOKEN=abcdef0123456789@example.com"] };
  report.summary.window.label = "since TOKEN=abcdef0123456789";
  const packet = buildNarrationPacket(report, { depth: "metadata" });
  const json = JSON.stringify(packet);
  assert.ok(!json.includes("abcdef0123456789"), "a secret-shaped value never survives in identities or window");
  assert.ok(json.includes("[REDACTED]"));
});

test("containsBareNumber rejects a literal figure but allows placeholders and spelled-out words", () => {
  assert.equal(containsBareNumber("improved performance by 40%"), true);
  assert.equal(containsBareNumber("shipped {{theme.commits}} commits"), false);
  assert.equal(containsBareNumber("hardened over eight review rounds"), false);
  assert.equal(containsBareNumber("touched {{theme.files}} files over {{theme.span}}"), false);
});

test("substitutePlaceholders fills known figures and rejects an unknown placeholder", () => {
  const agg = { commits: 3, files: 4, insertions: 36, deletions: 5, first: "2026-04-02", last: "2026-06-20" };
  assert.equal(substitutePlaceholders("did {{theme.commits}} commits", agg), "did 3 commits");
  assert.equal(substitutePlaceholders("over {{theme.span}}", agg), "over 2026-04-02 → 2026-06-20");
  assert.equal(substitutePlaceholders("mystery {{theme.savings}}", agg), null, "an unknown placeholder is a defect");
});

test("assembleNarration: valid, literal-number, unknown-id, and unmapped-theme handling", () => {
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  const result = assembleNarration({
    entries: [
      { title: "Widget hardening", what: "delivered {{theme.commits}} commits", how_it_helped: "reduced regression risk in the widget", theme_ids: ["t1"], confidence: "high" },
      { title: "Bogus figure", what: "improved performance by 40%", how_it_helped: "great", theme_ids: ["t1"], confidence: "high" },
      { title: "Hallucinated", what: "x", how_it_helped: "y", theme_ids: ["t999"], confidence: "low" },
    ],
  }, packet);

  // Entry 1 accepted as a model entry with the figure rendered from evidence.
  const model = result.entries.find((entry) => entry.source === "model");
  assert.equal(model.what, "delivered 3 commits");
  // Entry 2's literal number falls it back to the deterministic template.
  const det = result.entries.find((entry) => entry.source === "deterministic");
  assert.ok(det, "a literal-number entry becomes a deterministic entry");
  assert.ok(/reason/.test(JSON.stringify(result.rejections)) || result.rejections.length >= 2);
  assert.ok(result.rejections.some((rej) => /literal number/.test(rej.reason)));
  // Entry 3's unknown theme id is rejected outright (not turned deterministic).
  assert.ok(result.rejections.some((rej) => /unknown theme id/.test(rej.reason)));
});

// ---------------------------------------------------------------------------
// narrateGitAnalyze end-to-end with an injected exec (no live provider).
// ---------------------------------------------------------------------------

async function narrateWith(execResult, { deps = NO_STORE_DEPS, root = os.tmpdir() } = {}) {
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  const exec = typeof execResult === "function" ? execResult : async () => execResult;
  return narrateGitAnalyze({ root, packet, provider: "claude", model: "haiku", exec, deps });
}

test("narrateGitAnalyze: a valid response yields entries and a privacy receipt", async () => {
  const narration = await narrateWith(claudeEnvelope({
    entries: [{ title: "Widget", what: "shipped {{theme.commits}} commits", how_it_helped: "reduced regression risk", theme_ids: ["t1"], confidence: "high" }],
  }));
  assert.equal(narration.status, "ok");
  assert.equal(narration.entries.length, 1);
  assert.equal(narration.entries[0].what, "shipped 3 commits");
  // Cited id is translated back to the real (path-bearing) id for consumers.
  assert.equal(narration.entries[0].theme_ids[0], ABSOLUTE_THEME_ID);
  // Receipt present whenever a provider ran.
  assert.ok(narration.receipt);
  assert.equal(narration.receipt.network_calls, 1);
  assert.equal(narration.receipt.cost_usd, 0.0021);
  assert.ok(narration.receipt.bytes_sent > 0);
});

test("the receipt reports the model actually used (claude defaults to haiku)", async () => {
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  // The CLI passes model: null; claude's invocation defaults to haiku, so the
  // receipt and store record must say haiku, not null.
  const narration = await narrateGitAnalyze({
    root: os.tmpdir(), packet, provider: "claude", model: null, deps: NO_STORE_DEPS,
    exec: async () => claudeEnvelope({ entries: [{ title: "W", what: "shipped {{theme.commits}} commits", how_it_helped: "reduced risk", theme_ids: ["t1"], confidence: "high" }] }),
  });
  assert.equal(narration.model, "haiku");
  assert.equal(narration.receipt.model, "haiku");
});

test("narrateGitAnalyze: a literal number is rejected for that entry and the deterministic text is used", async () => {
  const narration = await narrateWith(claudeEnvelope({
    entries: [{ title: "Perf", what: "improved performance by 40%", how_it_helped: "faster", theme_ids: ["t1"], confidence: "high" }],
  }));
  assert.equal(narration.status, "ok");
  assert.equal(narration.entries.length, 1);
  assert.equal(narration.entries[0].source, "deterministic");
  assert.ok(!/40/.test(narration.entries[0].what) || /commit/.test(narration.entries[0].what), "the invented 40 is gone; only evidence figures remain");
  assert.ok(narration.rejections.some((rej) => /literal number/.test(rej.reason)));
});

test("narrateGitAnalyze: an entry citing an unknown theme id is rejected", async () => {
  const narration = await narrateWith(claudeEnvelope({
    entries: [{ title: "Ghost", what: "did work", how_it_helped: "helped", theme_ids: ["t404"], confidence: "low" }],
  }));
  assert.equal(narration.status, "ok");
  assert.equal(narration.entries.length, 0, "no entry survives a hallucinated citation");
  assert.ok(narration.rejections.some((rej) => /unknown theme id/.test(rej.reason)));
  // The real theme is surfaced as not narrated rather than silently lost.
  assert.ok(narration.not_narrated.some((theme) => theme.id === ABSOLUTE_THEME_ID));
});

test("narrateGitAnalyze: malformed JSON degrades to the deterministic report with the reason stated", async () => {
  const narration = await narrateWith({ code: 0, stdout: "this is not json at all", stderr: "" });
  assert.equal(narration.status, "unavailable");
  assert.equal(narration.reason, "malformed_response");
  assert.ok(narration.receipt, "a provider ran, so the receipt is present");
  assert.ok(narration.notes[0].length > 0);
});

test("narrateGitAnalyze: a non-zero exit degrades to provider_error", async () => {
  const narration = await narrateWith({ code: 1, stdout: "", stderr: "claude blew up" });
  assert.equal(narration.status, "unavailable");
  assert.equal(narration.reason, "provider_error");
  assert.ok(narration.receipt);
});

test("narrateGitAnalyze: a timeout is classified as timeout, not provider_error", async () => {
  const narration = await narrateWith({ code: 1, stdout: "", stderr: "narration timed out after 120s" });
  assert.equal(narration.status, "unavailable");
  assert.equal(narration.reason, "timeout");
  assert.ok(narration.receipt);
});

test("narrateGitAnalyze: a budget stop degrades to budget_blocked", async () => {
  const narration = await narrateWith(claudeEnvelope("", { isError: true, subtype: "error_max_budget" }));
  assert.equal(narration.status, "unavailable");
  assert.equal(narration.reason, "budget_blocked");
});

test("narrateGitAnalyze: an older CLI envelope with the answer on `result` still parses", async () => {
  const payload = { entries: [{ title: "W", what: "shipped {{theme.commits}} commits", how_it_helped: "reduced risk", theme_ids: ["t1"], confidence: "high" }] };
  const envelope = { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.001, result: JSON.stringify(payload) }), stderr: "" };
  const narration = await narrateWith(envelope);
  assert.equal(narration.status, "ok");
  assert.equal(narration.entries.length, 1);
});

test("narrateGitAnalyze: a number smuggled into evidence_gap is rejected too", async () => {
  const narration = await narrateWith(claudeEnvelope({
    entries: [{ title: "W", what: "shipped {{theme.commits}} commits", how_it_helped: "reduced risk", theme_ids: ["t1"], confidence: "low", evidence_gap: "only 40% of the surface was observed" }],
  }));
  assert.equal(narration.status, "ok");
  // The bare number in evidence_gap falls the entry back to deterministic text.
  assert.equal(narration.entries[0].source, "deterministic");
  assert.ok(!JSON.stringify(narration.entries[0]).includes("40"), "no invented number survives");
});

test("narrateGitAnalyze: duplicate theme_ids are not double-counted", async () => {
  const narration = await narrateWith(claudeEnvelope({
    entries: [{ title: "W", what: "shipped {{theme.commits}} commits", how_it_helped: "reduced risk", theme_ids: ["t1", "t1"], confidence: "high" }],
  }));
  assert.equal(narration.status, "ok");
  // t1 is a 3-commit theme; the citation must not report "6 commits".
  assert.equal(narration.entries[0].what, "shipped 3 commits");
  assert.deepEqual(narration.entries[0].theme_ids, [ABSOLUTE_THEME_ID]);
});

test("narrateGitAnalyze: a paid budget-stop still records spend when a store exists", async () => {
  const recorded = [];
  const deps = {
    stats: {
      resolveDelegationsPath: (r) => path.join(r, ".agentify", "delegations.jsonl"),
      recordDelegation: async (r, record) => { recorded.push(record); },
    },
    stat: async () => ({ isDirectory: () => true }),
  };
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  const narration = await narrateGitAnalyze({
    root: os.tmpdir(), packet, provider: "claude", model: "haiku", deps,
    exec: async () => claudeEnvelope(undefined, { cost: 0.005, isError: true, subtype: "error_max_budget" }),
  });
  assert.equal(narration.reason, "budget_blocked");
  assert.equal(narration.receipt.cost_usd, 0.005);
  assert.equal(narration.receipt.cost_recorded, true, "a paid failure records spend when a store exists");
  assert.equal(recorded.length, 1);
});

test("narrateGitAnalyze: no themes means no provider is contacted", async () => {
  const report = syntheticReport();
  report.summary.themes = [];
  const packet = buildNarrationPacket(report, { depth: "metadata" });
  let ran = false;
  const narration = await narrateGitAnalyze({ root: os.tmpdir(), packet, provider: "claude", exec: async () => { ran = true; return claudeEnvelope({ entries: [] }); } });
  assert.equal(ran, false, "an empty packet never starts a provider");
  assert.equal(narration.status, "unavailable");
  assert.equal(narration.reason, "no_themes");
  assert.equal(narration.receipt, null);
});

// ---------------------------------------------------------------------------
// Zero-install: spend is reported without ever creating a store.
// ---------------------------------------------------------------------------

test("zero-install: --ai in a repo with no store creates no store and still reports spend", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-zeroinstall-"));
  try {
    const narration = await narrateWith(
      claudeEnvelope({ entries: [{ title: "W", what: "shipped {{theme.commits}} commits", how_it_helped: "reduced risk", theme_ids: ["t1"], confidence: "high" }] }),
      { root },
    );
    assert.equal(narration.status, "ok");
    // Spend is always reported in the receipt...
    assert.equal(narration.receipt.cost_usd, 0.0021);
    // ...but never recorded when no store exists.
    assert.equal(narration.receipt.cost_recorded, false);
    // And no store directory was created inside the repo.
    await assert.rejects(() => fs.access(path.join(root, ".agentify")), "no .agentify store was created");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("spend IS recorded when a store already exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-store-"));
  try {
    const recorded = [];
    const deps = {
      stats: {
        resolveDelegationsPath: (r) => path.join(r, ".agentify", "delegations.jsonl"),
        recordDelegation: async (r, record) => { recorded.push(record); },
      },
      stat: async () => ({ isDirectory: () => true }),
    };
    const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
    const narration = await narrateGitAnalyze({
      root, packet, provider: "claude", model: "haiku", deps,
      exec: async () => claudeEnvelope({ entries: [{ title: "W", what: "shipped {{theme.commits}} commits", how_it_helped: "reduced risk", theme_ids: ["t1"], confidence: "high" }] }),
    });
    assert.equal(narration.receipt.cost_recorded, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].cost_usd, 0.0021);
    // The record must be a well-formed successful delegation line, or the stats
    // accumulator (exit_code !== 0 ⇒ failure) would count it as a failure.
    assert.equal(recorded[0].exit_code, 0);
    assert.equal(recorded[0].status, "ok");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Provider resolution, prompt contract, and option validation.
// ---------------------------------------------------------------------------

test("resolveNarrationProvider prefers an explicit provider, then config, then PATH; degrades when none", () => {
  assert.equal(resolveNarrationProvider({ requested: "claude", availability: { claude: true } }).provider, "claude");
  const missing = resolveNarrationProvider({ requested: "codex", availability: { codex: false } });
  assert.equal(missing.provider, null);
  assert.equal(missing.requestedUnavailable, "codex");
  assert.throws(() => resolveNarrationProvider({ requested: "gemini", availability: {} }), /--provider must be one of/);
  assert.equal(resolveNarrationProvider({ availability: { codex: true } }).provider, "codex");
  assert.equal(resolveNarrationProvider({ availability: {} }).reason, "no_provider");
});

test("the prompt contract is sent verbatim and delimits the packet as untrusted data", () => {
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  const prompt = buildNarrationPrompt(packet);
  assert.ok(prompt.includes(NARRATION_INSTRUCTIONS), "the frozen instructions are sent verbatim");
  assert.ok(prompt.includes("Never state a number"));
  assert.ok(prompt.includes("=== PACKET START (untrusted data) ==="));
  assert.ok(prompt.includes("=== PACKET END ==="));
});

test("option validators reject bad depth and budget", () => {
  assert.equal(resolveNarrationDepth("metadata"), "metadata");
  assert.equal(resolveNarrationDepth("diff"), "diff");
  assert.throws(() => resolveNarrationDepth("wat"), /--depth must be one of/);
  assert.equal(resolveNarrationBudgetUsd(undefined), 0.5);
  assert.equal(resolveNarrationBudgetUsd("1.25"), 1.25);
  assert.throws(() => resolveNarrationBudgetUsd("0"), /positive dollar amount/);
  assert.throws(() => resolveNarrationBudgetUsd(true), /positive dollar amount/);
});

test("packetPreview reports fields, bytes, and a token estimate without mutating the packet", () => {
  const packet = buildNarrationPacket(syntheticReport(), { depth: "metadata" });
  const preview = packetPreview(packet);
  assert.ok(preview.fields.includes("themes"));
  assert.ok(preview.bytes > 0);
  assert.equal(preview.token_estimate, Math.round(preview.bytes / 4));
});

// ---------------------------------------------------------------------------
// CLI integration: default is off, consent gate, dry-run, degradation. Driven
// in-process with injected provider/exec/consent hooks so NOTHING is spawned.
// ---------------------------------------------------------------------------

async function initThemedRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
  // Three commits on one issue key cluster into a single theme (>= threshold).
  for (const [i, subject] of [
    "feat(core): add the widget (#123)",
    "fix(core): guard the widget (#123)",
    "test(core): cover the widget (#123)",
  ].entries()) {
    await fs.writeFile(path.join(root, `f${i}.txt`), `content ${i}\n`, "utf8");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", subject], { cwd: root });
  }
}

async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, enc, cb) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    if (typeof enc === "function") enc();
    else if (typeof cb === "function") cb();
    return true;
  });
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

test("default git analyze (no --ai) probes no provider and attaches no narration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-cli-default-"));
  try {
    await initThemedRepo(root);
    let detectCalled = false;
    const out = await captureStdout(() => runCli(["git", "analyze", "--days", "3650", "--json", "--root", root], {
      detectProviders: async () => { detectCalled = true; return { claude: true }; },
    }));
    const report = JSON.parse(out);
    assert.equal(detectCalled, false, "no provider is probed when --ai is absent");
    assert.ok(!("narration" in report), "no narration on the default path");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--ai --dry-run prints the packet and provider plan and sends nothing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-cli-dry-"));
  try {
    await initThemedRepo(root);
    let narrateCalled = false;
    const out = await captureStdout(() => runCli(["git", "analyze", "--days", "3650", "--ai", "--dry-run", "--root", root], {
      detectProviders: async () => ({ claude: true }),
      narrateExec: async () => { narrateCalled = true; return claudeEnvelope({ entries: [] }); },
    }));
    const payload = JSON.parse(out);
    assert.equal(payload.ai_dry_run, true);
    assert.ok(payload.packet && Array.isArray(payload.packet.themes));
    assert.ok(payload.plan && payload.plan.command === "claude");
    assert.equal(narrateCalled, false, "dry run sends nothing to the provider");
    assert.ok(!JSON.stringify(payload.packet).includes(root), "the packet carries no absolute repo path");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--ai on a no-theme repo skips consent and the provider entirely (no network)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-cli-notheme-"));
  try {
    // A single commit clusters below the theme threshold → no themes.
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Agentify Tests"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "agentify-tests@example.com"], { cwd: root });
    await fs.writeFile(path.join(root, "a.txt"), "one\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "chore: only commit"], { cwd: root });

    let detectCalled = false;
    // No --yes, non-interactive: must NOT throw for consent, because nothing
    // is ever sent.
    const out = await captureStdout(() => runCli(["git", "analyze", "--days", "3650", "--ai", "--json", "--root", root], {
      detectProviders: async () => { detectCalled = true; return { claude: true }; },
    }));
    const report = JSON.parse(out);
    assert.equal(detectCalled, false, "no provider is probed when there is nothing to narrate");
    assert.equal(report.narration.status, "unavailable");
    assert.equal(report.narration.reason, "no_themes");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--ai without --yes in non-interactive mode errors explaining consent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-cli-consent-"));
  try {
    await initThemedRepo(root);
    await assert.rejects(
      () => runCli(["git", "analyze", "--days", "3650", "--ai", "--json", "--root", root], {
        detectProviders: async () => ({ claude: true }),
        narrateExec: async () => claudeEnvelope({ entries: [] }),
      }),
      /needs explicit consent in non-interactive mode/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--ai consent refused keeps the deterministic report and says narration was declined", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-cli-refuse-"));
  try {
    await initThemedRepo(root);
    let narrateCalled = false;
    const out = await captureStdout(() => runCli(["git", "analyze", "--days", "3650", "--ai", "--json", "--root", root], {
      detectProviders: async () => ({ claude: true }),
      confirmConsent: async () => false,
      narrateExec: async () => { narrateCalled = true; return claudeEnvelope({ entries: [] }); },
    }));
    const report = JSON.parse(out);
    assert.equal(narrateCalled, false, "a refused consent never contacts the provider");
    assert.equal(report.narration.status, "unavailable");
    assert.equal(report.narration.reason, "declined");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--ai consent accepted runs narration and lands it on report.narration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-cli-accept-"));
  try {
    await initThemedRepo(root);
    const out = await captureStdout(() => runCli(["git", "analyze", "--days", "3650", "--ai", "--yes", "--json", "--root", root], {
      detectProviders: async () => ({ claude: true }),
      narrateExec: async (command, args) => {
        // The prompt carries the packet; cite the opaque id it exposes.
        const prompt = args.find((arg) => typeof arg === "string" && arg.includes("PACKET START"));
        const match = /"id":"(t\d+)"/.exec(prompt || "");
        const id = match ? match[1] : "t1";
        return claudeEnvelope({ entries: [{ title: "Widget", what: "shipped {{theme.commits}} commits", how_it_helped: "reduced regression risk in core", theme_ids: [id], confidence: "high" }] });
      },
    }));
    const report = JSON.parse(out);
    assert.equal(report.narration.status, "ok");
    assert.ok(report.narration.entries.length >= 1);
    assert.equal(report.narration.receipt.network_calls, 1);
    assert.equal(report.narration.receipt.model, "haiku", "the receipt reports the effective model, not null");
    // The entry's theme id was translated back to the real, path-bearing id.
    assert.ok(report.narration.entries[0].theme_ids[0].includes("::issue:#123"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--ai with no provider installed warns and produces the deterministic report (exit 0)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-narrate-cli-noprovider-"));
  try {
    await initThemedRepo(root);
    const out = await captureStdout(() => runCli(["git", "analyze", "--days", "3650", "--ai", "--yes", "--json", "--root", root], {
      detectProviders: async () => ({ claude: false, codex: false }),
    }));
    const report = JSON.parse(out);
    assert.equal(report.narration.status, "unavailable");
    assert.equal(report.narration.reason, "no_provider");
    assert.equal(report.narration.receipt, null, "no receipt when no provider ran");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
