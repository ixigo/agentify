import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addNote } from "../src/core/ctx.js";
import { buildFirstRunWin, runOneCommandInstall } from "../src/core/install.js";

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// A capabilities stub in the shape toolchain.detectCapabilities returns, so the
// orchestrator can be driven without shelling out to real provider CLIs.
function fakeDetect(providers) {
  return async () => ({ providers });
}

test("buildFirstRunWin falls back to the setup audit on a repo with no history", async () => {
  const root = await tmpDir("agentify-firstrun-empty-");
  const home = await tmpDir("agentify-firstrun-home-");

  const win = await buildFirstRunWin(root, { homeDir: home });
  assert.equal(win.source, "config-audit");
  assert.ok(Array.isArray(win.findings));
  assert.ok(win.read.includes(path.join(home, ".claude")));
});

test("buildFirstRunWin uses local history when present", async () => {
  const root = await tmpDir("agentify-firstrun-history-");
  await addNote(root, "watch out for the flaky migration test");

  const win = await buildFirstRunWin(root, { homeDir: await tmpDir("agentify-firstrun-h2-") });
  assert.equal(win.source, "history");
  assert.match(win.digest, /flaky migration test/);
});

test("runOneCommandInstall warns and continues when a provider is unauthenticated", async () => {
  const root = await tmpDir("agentify-install-unauth-");
  const home = await tmpDir("agentify-install-unauth-home-");

  const result = await runOneCommandInstall(root, {}, {
    homeDir: home,
    buildIndex: false,
    detect: fakeDetect({
      claude: { available: true, version: "1.4.0", auth: { state: "missing", detail: "login required", next_step: "claude auth login" } },
      codex: { available: false },
    }),
  });

  // Present-but-unauthenticated is a warning, not a hard failure.
  assert.ok(result.warnings.some((message) => /not authenticated/.test(message)));
  // Registration still happened for the installed provider.
  const claudeMcp = result.mcp.registrations.find((item) => item.provider === "claude");
  assert.equal(claudeMcp.registered, true);
  assert.equal(claudeMcp.changed, true);
  const claudeJson = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
  assert.deepEqual(claudeJson.mcpServers.agentify, { type: "stdio", command: "agentify", args: ["serve"] });
  // Codex is not installed, so it was neither configured nor registered.
  assert.equal(result.mcp.registrations.some((item) => item.provider === "codex"), false);
});

test("runOneCommandInstall is idempotent and reports a receipt", async () => {
  const root = await tmpDir("agentify-install-idem-");
  const home = await tmpDir("agentify-install-idem-home-");
  const detect = fakeDetect({
    claude: { available: true, version: "1.4.0", auth: { state: "ready" } },
    codex: { available: false },
  });

  const first = await runOneCommandInstall(root, {}, { homeDir: home, buildIndex: false, detect });
  assert.equal(first.command, "install");
  assert.equal(first.mcp.registrations[0].changed, true);
  // Receipt surfaces what was detected, written, and read.
  assert.ok(first.detected.providers.some((info) => info.provider === "claude" && info.installed));
  assert.ok(first.wrote.includes(".agentify.yaml"));
  assert.ok(first.read.length > 0);
  // ACP is reported as unavailable rather than assumed present.
  assert.equal(first.acp.supported, false);

  const second = await runOneCommandInstall(root, {}, { homeDir: home, buildIndex: false, detect });
  assert.equal(second.mcp.registrations[0].changed, false);
  assert.equal(second.mcp.registrations[0].action, "unchanged");
  assert.equal(second.integrations[0].memory.changed, false);

  // Exactly one registration entry survived two runs.
  const claudeJson = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
  assert.equal(Object.keys(claudeJson.mcpServers).length, 1);
});

test("runOneCommandInstall reports an updated .gitignore in the receipt", async () => {
  const root = await tmpDir("agentify-install-gitignore-");
  const home = await tmpDir("agentify-install-gitignore-home-");
  // A pre-existing .gitignore without the managed block gets updated in place.
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules\n", "utf8");

  const result = await runOneCommandInstall(root, {}, {
    homeDir: home,
    buildIndex: false,
    detect: fakeDetect({ claude: { available: true, version: "1.4.0", auth: { state: "ready" } }, codex: { available: false } }),
  });

  const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  // The user's line is preserved and the file changed, so it must be reported.
  assert.match(gitignore, /node_modules/);
  for (const generatedPath of [
    "/.agentify.yaml",
    "/.agentignore",
    "/.guardrails",
    "/.claude/settings.json",
    "/.claude/hooks/plan-to-html.mjs",
    "plans/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-*.html",
  ]) {
    assert.ok(gitignore.split("\n").includes(generatedPath), `expected ${generatedPath} to be ignored`);
  }
  assert.ok(!gitignore.split("\n").includes("CLAUDE.md"));
  assert.ok(!gitignore.split("\n").includes("AGENTS.md"));
  assert.ok(!gitignore.split("\n").includes(".agentify.yaml"));
  assert.ok(!gitignore.split("\n").includes(".agentignore"));
  assert.ok(!gitignore.split("\n").includes(".guardrails"));
  assert.ok(!gitignore.split("\n").includes(".claude/settings.json"));
  assert.ok(!gitignore.split("\n").includes(".claude/hooks/plan-to-html.mjs"));
  assert.ok(result.wrote.includes(".gitignore"), `expected .gitignore in wrote: ${JSON.stringify(result.wrote)}`);
});

test("runOneCommandInstall does not ignore pre-existing mixed-ownership files", async () => {
  const root = await tmpDir("agentify-install-existing-");
  const home = await tmpDir("agentify-install-existing-home-");
  await fs.mkdir(path.join(root, ".claude", "hooks"), { recursive: true });
  await fs.writeFile(path.join(root, ".agentify.yaml"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, ".agentignore"), "custom-cache/\n", "utf8");
  await fs.writeFile(path.join(root, ".guardrails"), "# Team guardrails\n", "utf8");
  await fs.writeFile(
    path.join(root, ".claude", "settings.json"),
    `${JSON.stringify({ permissions: { allow: ["Bash"] } }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(root, ".claude", "hooks", "plan-to-html.mjs"), "// custom renderer\n", "utf8");

  await runOneCommandInstall(root, {}, {
    homeDir: home,
    buildIndex: false,
    detect: fakeDetect({ claude: { available: true, version: "1.4.0", auth: { state: "ready" } }, codex: { available: false } }),
  });

  const lines = (await fs.readFile(path.join(root, ".gitignore"), "utf8")).split("\n");
  assert.ok(!lines.includes(".agentify.yaml"));
  assert.ok(!lines.includes("/.agentify.yaml"));
  assert.ok(!lines.includes(".agentignore"));
  assert.ok(!lines.includes("/.agentignore"));
  assert.ok(!lines.includes(".guardrails"));
  assert.ok(!lines.includes("/.guardrails"));
  assert.ok(!lines.includes(".claude/settings.json"));
  assert.ok(!lines.includes("/.claude/settings.json"));
  assert.ok(!lines.includes("/.claude/hooks/plan-to-html.mjs"));
});

test("runOneCommandInstall reports ok:false when a registration cannot complete", async () => {
  const root = await tmpDir("agentify-install-fail-");
  const home = await tmpDir("agentify-install-fail-home-");
  const progress = [];
  // A claude.json that cannot be parsed must be left untouched, and the install
  // must not claim success.
  await fs.writeFile(path.join(home, ".claude.json"), "{ broken", "utf8");

  const result = await runOneCommandInstall(root, {}, {
    homeDir: home,
    buildIndex: false,
    detect: fakeDetect({
      claude: { available: true, version: "1.4.0", auth: { state: "ready" } },
      codex: { available: false },
    }),
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((message) => /did not complete/.test(message)));
  const claudeMcp = result.mcp.registrations.find((item) => item.provider === "claude");
  assert.equal(claudeMcp.registered, false);
  assert.equal(progress.find((event) => event.id === "mcp" && event.status !== "start").status, "warning");
  // File untouched.
  assert.equal(await fs.readFile(path.join(home, ".claude.json"), "utf8"), "{ broken");
});

test("runOneCommandInstall dry-run previews without writing or claiming registration", async () => {
  const root = await tmpDir("agentify-install-dry-");
  const home = await tmpDir("agentify-install-dry-home-");
  const progress = [];

  const result = await runOneCommandInstall(root, { dryRun: true }, {
    homeDir: home,
    buildIndex: false,
    detect: fakeDetect({ claude: { available: true, version: "1.4.0", auth: { state: "ready" } }, codex: { available: false } }),
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.ok, true);
  const claudeMcp = result.mcp.registrations.find((item) => item.provider === "claude");
  // A would-add has not written anything, so it must not claim registration.
  assert.equal(claudeMcp.changed, true);
  assert.equal(claudeMcp.registered, false);
  assert.equal(claudeMcp.action, "would-added");
  assert.match(progress.find((event) => event.id === "integrations" && event.status === "complete").message, /previewed/);
  assert.match(progress.find((event) => event.id === "mcp" && event.status === "complete").message, /previewed/);
  await assert.rejects(() => fs.access(path.join(home, ".claude.json")));
});

test("runOneCommandInstall falls back to claude when no provider CLI is detected", async () => {
  const root = await tmpDir("agentify-install-none-");
  const home = await tmpDir("agentify-install-none-home-");

  const result = await runOneCommandInstall(root, {}, {
    homeDir: home,
    buildIndex: false,
    detect: fakeDetect({ claude: { available: false }, codex: { available: false } }),
  });

  // Nothing installed → guidance still set up for claude, but nothing is
  // registered against an absent CLI's config.
  assert.equal(result.integrations.length, 1);
  assert.equal(result.integrations[0].provider, "claude");
  assert.equal(result.mcp.registrations.length, 0);
});

test("runOneCommandInstall reports real install phases and timings", async () => {
  const root = await tmpDir("agentify-install-progress-");
  const home = await tmpDir("agentify-install-progress-home-");
  const events = [];

  const result = await runOneCommandInstall(root, {}, {
    homeDir: home,
    buildIndex: false,
    detect: fakeDetect({ claude: { available: true, version: "1.4.0", auth: { state: "ready" } }, codex: { available: false } }),
    onProgress: (event) => events.push(event),
  });

  assert.deepEqual(
    events.map(({ id, status }) => [id, status]),
    [
      ["detect", "start"], ["detect", "complete"],
      ["workspace", "start"], ["workspace", "complete"],
      ["integrations", "start"], ["integrations", "complete"],
      ["mcp", "start"], ["mcp", "complete"],
      ["index", "start"], ["index", "complete"],
      ["summary", "start"], ["summary", "complete"],
    ],
  );
  assert.match(events.find((event) => event.id === "index" && event.status === "complete").message, /skipped/);
  assert.equal(typeof result.timings.total_ms, "number");
  assert.deepEqual(Object.keys(result.timings.phases), ["detect", "workspace", "integrations", "mcp", "index", "summary"]);
});

test("runOneCommandInstall ignores failures in presentation-only progress callbacks", async () => {
  const root = await tmpDir("agentify-install-progress-safe-");
  const home = await tmpDir("agentify-install-progress-safe-home-");

  const result = await runOneCommandInstall(root, {}, {
    homeDir: home,
    buildIndex: false,
    detect: fakeDetect({ claude: { available: false }, codex: { available: false } }),
    onProgress: (event) => {
      if (event.status === "start") return Promise.reject(new Error("async renderer failed"));
      throw new Error("sync renderer failed");
    },
  });

  assert.equal(result.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
});
