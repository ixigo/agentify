import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { runVisualCommand } from "../src/core/cli-visual.js";
import { ensureBaseline, removeBaseline, resolveBaselineRef } from "../src/core/visual/baseline.js";
import { analyzeBuild, compareBuilds, kb, normalizeAssetName, ownerOf, signedKb, viteStatsWrapper } from "../src/core/visual/build-size.js";
import { buildStartUrl, isLocalHost, matchesBlocked } from "../src/core/visual/capture.js";
import { findConfigFile, loadVisualConfig, normalizeVisualConfig, pickById, pickViewports } from "../src/core/visual/config.js";
import { compareRgba } from "../src/core/visual/diff.js";
import { renderVisualReport } from "../src/core/visual/report.js";
import { summarizeRun } from "../src/core/visual/run.js";
import { fillPort, startServer, waitForServer } from "../src/core/visual/server.js";

function tempDir(t, prefix = "agentify-visual-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const minimal = { server: { command: ["node", "server.mjs", "--port", "{port}"] }, flows: [{ id: "home", start: { path: "/" } }] };

test("normalizeVisualConfig fills defaults and a single-step flow", () => {
  const config = normalizeVisualConfig(minimal, { root: "/repo" });
  assert.deepEqual(config.clients.map((client) => client.id), ["default"]);
  assert.deepEqual(config.defaultViewports, ["mobile"]);
  assert.deepEqual(Object.keys(config.viewports), ["mobile", "desktop"]);
  assert.equal(config.viewports.mobile.viewport.width, 390);
  assert.deepEqual(config.flows[0].steps.map((step) => step.id), ["home"]);
  assert.equal(config.server.cwd, "/repo");
  assert.equal(config.port, 4391);
  assert.ok(config.network.block.includes("googletagmanager"));
  assert.equal(config.build, null);
});

test("normalizeVisualConfig rejects configs it cannot run", () => {
  assert.throws(() => normalizeVisualConfig({ flows: minimal.flows }), /server.command .* or baseUrl/);
  assert.throws(() => normalizeVisualConfig({ ...minimal, flows: [] }), /at least one flow/);
  assert.throws(() => normalizeVisualConfig({ ...minimal, flows: [{ id: "a b", start: "/" }] }), /simple identifier/);
  assert.throws(() => normalizeVisualConfig({ ...minimal, flows: [{ id: "a" }] }), /needs start/);
  assert.throws(() => normalizeVisualConfig({ ...minimal, flows: [{ id: "a", start: "/" }, { id: "a", start: "/" }] }), /Duplicate flow id: a/);
  assert.throws(() => normalizeVisualConfig({ ...minimal, server: { command: "npm run dev" } }), /array of strings/);
  assert.throws(() => normalizeVisualConfig({ ...minimal, defaultViewports: ["tablet"] }), /unknown viewport: tablet/);
  assert.throws(() => normalizeVisualConfig({ ...minimal, build: { outDir: "dist" } }), /build needs command/);
  assert.throws(() => normalizeVisualConfig({ ...minimal, flows: [{ id: "a", start: "/", steps: [{ id: "x", run: "click" }] }] }), /must be a function/);
});

test("pickById and pickViewports filter with helpful errors", () => {
  const config = normalizeVisualConfig({ ...minimal, flows: [{ id: "home", start: "/" }, { id: "cart", start: "/cart" }] });
  assert.deepEqual(pickById(config.flows, "cart", "flow").map((flow) => flow.id), ["cart"]);
  assert.equal(pickById(config.flows, "all", "flow").length, 2);
  assert.throws(() => pickById(config.flows, "nope", "flow"), /Unknown flow: nope. Known: home, cart/);
  assert.deepEqual(pickViewports(config, "all"), ["mobile", "desktop"]);
  assert.deepEqual(pickViewports(config), ["mobile"]);
  assert.throws(() => pickViewports(config, "watch"), /Unknown viewport: watch/);
});

test("loadVisualConfig finds the default file and supports function exports", async (t) => {
  const root = tempDir(t);
  assert.throws(() => findConfigFile(root), /No visual config found/);
  write(path.join(root, ".agentify", "visual.config.mjs"), `export default ({ root }) => ({ baseUrl: "http://127.0.0.1:9", flows: [{ id: "home", start: "/", title: root.length > 0 ? "Home" : "?" }] });`);
  const { file, config } = await loadVisualConfig(root);
  assert.equal(file, path.join(root, ".agentify", "visual.config.mjs"));
  assert.equal(config.flows[0].title, "Home");
  assert.equal(config.baseUrl, "http://127.0.0.1:9");
});

test("buildStartUrl merges global, client and flow query and swaps the host", () => {
  const config = normalizeVisualConfig({ ...minimal, query: { source: "harness", theme: "base" } });
  const client = { id: "brand", host: "brand.localhost", query: { theme: "dark" } };
  const flow = { id: "menu", start: ({ client: current }) => ({ path: "/menu", query: { client: current.id, empty: undefined } }) };
  const url = new URL(buildStartUrl({ baseUrl: "http://127.0.0.1:4391", client, flow, config }));
  assert.equal(url.host, "brand.localhost:4391");
  assert.equal(url.pathname, "/menu");
  assert.deepEqual(Object.fromEntries(url.searchParams), { source: "harness", theme: "dark", client: "brand" });
});

test("host helpers keep local traffic and block analytics", () => {
  assert.ok(isLocalHost("127.0.0.1"));
  assert.ok(isLocalHost("brand.localhost"));
  assert.ok(!isLocalHost("cdn.example.com"));
  assert.ok(matchesBlocked("www.googletagmanager.com", ["googletagmanager"]));
  assert.ok(matchesBlocked("events.acme.io", [/^events\./]));
  assert.ok(!matchesBlocked("cdn.acme.io", ["googletagmanager", /^events\./]));
});

test("compareRgba counts changed pixels and treats missing rows as white", () => {
  const white = [255, 255, 255, 255];
  const red = [255, 0, 0, 255];
  const before = new Uint8ClampedArray([...white, ...white]);
  const after = new Uint8ClampedArray([...white, ...red, ...red, ...red]);
  const result = compareRgba(before, after, {
    width: 2, height: 2, tolerance: 10,
    beforeSize: { width: 2, height: 1 }, afterSize: { width: 2, height: 2 },
  });
  assert.equal(result.changed, 3);
  assert.deepEqual([...result.data.slice(4, 8)], [255, 45, 85, 255]);
  assert.equal(result.data[3], 255);
  const same = compareRgba(before, new Uint8ClampedArray([...white, 250, 250, 250, 255]), {
    width: 2, height: 1, tolerance: 10, beforeSize: { width: 2, height: 1 }, afterSize: { width: 2, height: 1 },
  });
  assert.equal(same.changed, 0);
});

test("size helpers format bytes and strip content hashes", () => {
  assert.equal(kb(512), "512 B");
  assert.equal(kb(2048), "2.0 KB");
  assert.equal(signedKb(-3072), "−3.0 KB");
  assert.equal(signedKb(100), "+100 B");
  assert.equal(normalizeAssetName("assets/index-BcE1WKLH.js"), "assets/index.js");
  assert.equal(normalizeAssetName("assets/style.a1b2c3d4e5.css"), "assets/style.css");
  assert.equal(normalizeAssetName("index.html"), "index.html");
});

test("ownerOf attributes pnpm packages, app source and bundler helpers", () => {
  const root = "/repo/app";
  assert.deepEqual(ownerOf("/repo/node_modules/.pnpm/@ixigo+iui@1.0.0-pre.24_react@19/node_modules/@ixigo/iui/dist/button.js", root), { key: "@ixigo/iui", kind: "package", version: "1.0.0-pre.24" });
  assert.deepEqual(ownerOf("/repo/app/src/pages/Home/Home.tsx", root), { key: "src/pages/Home", kind: "source" });
  assert.deepEqual(ownerOf("/repo/app/src/utils/format.ts", root), { key: "src/utils", kind: "source" });
  assert.equal(ownerOf("\0vite/preload-helper.js", root).kind, "runtime");
});

function writeBuild(root, label, { iuiVersion, pageCode, sharedCode }) {
  const dist = path.join(root, label, "dist");
  write(path.join(dist, "index.html"), `<script type="module" src="/assets/index-AAAAAAAA.js"></script><link rel="stylesheet" href="/assets/index-CCCCCCCC.css">`);
  write(path.join(dist, "assets/index-AAAAAAAA.js"), `console.log(${JSON.stringify(sharedCode)});`);
  write(path.join(dist, "assets/home-BBBBBBBB.js"), `console.log(${JSON.stringify(pageCode)});`);
  write(path.join(dist, "assets/sheet-DDDDDDDD.js"), `console.log("sheet");`);
  write(path.join(dist, "assets/index-CCCCCCCC.css"), ":root{--a:1;--b:2}a{color:red}b{color:blue}");
  const pkg = `/repo/node_modules/.pnpm/@ixigo+iui@${iuiVersion}_react@19/node_modules/@ixigo/iui/index.js`;
  return {
    label,
    root: "/repo/app",
    dist,
    seconds: 1,
    stats: {
      chunks: [
        { type: "chunk", fileName: "assets/index-AAAAAAAA.js", isEntry: true, imports: [], dynamicImports: ["assets/home-BBBBBBBB.js"], importedCss: ["assets/index-CCCCCCCC.css"], facadeModuleId: "/repo/app/src/main.tsx", modules: { "/repo/app/src/main.tsx": 10, [pkg]: 30 } },
        { type: "chunk", fileName: "assets/home-BBBBBBBB.js", isDynamicEntry: true, imports: [], dynamicImports: ["assets/sheet-DDDDDDDD.js"], importedCss: [], facadeModuleId: null, modules: { "/repo/app/src/pages/Home/index.ts": 5, [pkg]: 20 } },
        { type: "chunk", fileName: "assets/sheet-DDDDDDDD.js", isDynamicEntry: true, imports: [], dynamicImports: [], importedCss: [], facadeModuleId: "/repo/app/src/components/Sheet/index.ts", modules: { "/repo/app/src/components/Sheet/index.ts": 5 } },
        { type: "asset", fileName: "assets/index-CCCCCCCC.css" },
      ],
    },
  };
}

test("analyzeBuild totals sizes, finds first-paint files and per-page cost without a facade id", (t) => {
  const root = tempDir(t);
  const pages = [{ id: "home", label: "Home", route: "/", module: "src/pages/Home/index" }, { id: "missing", module: "src/pages/Gone/index" }];
  const result = analyzeBuild(writeBuild(root, "after", { iuiVersion: "1.0.0", pageCode: "x".repeat(4000), sharedCode: "shared" }), { pages });
  assert.equal(result.attributed, true);
  assert.equal(result.totals.jsFiles, 3);
  assert.equal(result.totals.cssRules, 3);
  assert.equal(result.totals.cssCustomProperties, 2);
  assert.ok(result.totals.initialJsGzip > 0 && result.totals.initialJsGzip < result.totals.jsGzip);
  assert.deepEqual(result.files.filter((file) => file.initial).map((file) => file.name).sort(), ["assets/index.css", "assets/index.js"]);
  const home = result.pages.find((page) => page.id === "home");
  assert.equal(home.found, true);
  assert.ok(home.pageJs > 0);
  assert.equal(home.totalJs, home.shellJs + home.pageJs);
  assert.ok(home.laterJs > 0);
  assert.equal(result.pages.find((page) => page.id === "missing").found, false);
  assert.deepEqual(result.groups.map((group) => group.key).sort(), ["@ixigo/iui", "src", "src/components/Sheet", "src/pages/Home"]);
});

test("compareBuilds explains package upgrades, per-page moves and removals", (t) => {
  const root = tempDir(t);
  const pages = [{ id: "home", label: "Home", route: "/", module: "src/pages/Home/index" }];
  const before = analyzeBuild(writeBuild(root, "before", { iuiVersion: "0.5.2", pageCode: "small", sharedCode: "y".repeat(200) }), { pages });
  const after = analyzeBuild(writeBuild(root, "after", { iuiVersion: "1.0.0", pageCode: Array.from({ length: 4000 }, (_, i) => i.toString(36)).join(""), sharedCode: "y".repeat(200) }), { pages });
  const diff = compareBuilds(before, after);
  assert.match(diff.why[0], /^Total JavaScript grew by \+/);
  assert.match(diff.why.join("\n"), /@ixigo\/iui \(0\.5\.2 → 1\.0\.0\) grew/);
  assert.match(diff.why.join("\n"), /Biggest per-page changes: Home \+/);
  assert.equal(diff.pageDiff[0].id, "home");
  assert.ok(diff.pageDiff[0].delta > 0);
  assert.equal(diff.fileDiff.find((file) => file.name === "assets/home.js").delta > 0, true);
});

test("viteStatsWrapper imports the project config and records chunk metadata", () => {
  const source = viteStatsWrapper("../../vite.config.ts");
  assert.match(source, /import projectConfig from "\.\.\/\.\.\/vite\.config\.ts";/);
  assert.match(source, /importedCss/);
  assert.match(source, /AGENTIFY_VISUAL_OUT/);
});

function gitRepo(t) {
  const root = tempDir(t, "agentify-visual-git-");
  const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  write(path.join(root, "app", "page.html"), "<h1>before</h1>");
  write(path.join(root, "app", "agentify.visual.mjs"), `export default ${JSON.stringify(minimal)};`);
  write(path.join(root, ".gitignore"), ".agentify/\n");
  run("add", "-A");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "before");
  run("checkout", "-q", "-b", "feature");
  write(path.join(root, "app", "page.html"), "<h1>after</h1>");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "after");
  return { root, app: path.join(root, "app"), run };
}

test("resolveBaselineRef understands merge-base and plain refs", (t) => {
  const { app, run } = gitRepo(t);
  const mainSha = run("rev-parse", "main");
  assert.equal(resolveBaselineRef(app, "merge-base:main"), mainSha);
  assert.equal(resolveBaselineRef(app, "HEAD~1"), mainSha);
  assert.throws(() => resolveBaselineRef(app, "does-not-exist"));
});

test("ensureBaseline checks out the ref in a worktree, copies the config and installs once", async (t) => {
  const { root, app, run } = gitRepo(t);
  write(path.join(app, "agentify.visual.mjs"), `export default ${JSON.stringify({ ...minimal, flows: [{ id: "new-flow", start: "/" }] })};`);
  const { config } = await loadVisualConfig(app);
  config.install = ["pnpm", "install"];
  const calls = [];
  const spawnStub = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0 };
  };
  const baseline = ensureBaseline({ root: app, ref: "main", config, spawn: spawnStub });
  assert.equal(baseline.sha, run("rev-parse", "main"));
  assert.equal(fs.readFileSync(path.join(baseline.root, "page.html"), "utf8"), "<h1>before</h1>");
  assert.match(fs.readFileSync(baseline.configFile, "utf8"), /new-flow/);
  assert.deepEqual(calls, [["pnpm", "install"]]);
  ensureBaseline({ root: app, ref: "main", config, spawn: spawnStub });
  assert.equal(calls.length, 1);
  assert.ok(run("worktree", "list").includes(path.join(app, ".agentify", "visual", "baseline", "repo")));
  assert.equal(removeBaseline(app), true);
  assert.equal(removeBaseline(app), false);
  assert.ok(fs.existsSync(root));
});

test("server helpers fill the port, wait for readiness and report early exits", async (t) => {
  assert.deepEqual(fillPort(["vite", "--port", "{port}", "--host={port}"], 5000), ["vite", "--port", "5000", "--host=5000"]);
  let calls = 0;
  await waitForServer("http://x", { fetchImpl: async () => ({ status: ++calls > 2 ? 200 : 503 }), timeoutMs: 5_000 });
  assert.equal(calls, 3);
  const root = tempDir(t);
  write(path.join(root, "crash.mjs"), "console.error('boom'); process.exit(3);");
  const handle = startServer({ server: { command: ["node", "crash.mjs"], cwd: root, env: {} }, port: 1, label: "after", spawnImpl: spawn });
  await assert.rejects(() => waitForServer("http://127.0.0.1:1/", { handle, timeoutMs: 10_000, fetchImpl: async () => { throw new Error("down"); } }), /after server exited before it was ready[\s\S]*boom/);
});

test("visual init writes a vite-aware starter config and refuses to overwrite", async (t) => {
  const root = tempDir(t);
  write(path.join(root, "package.json"), JSON.stringify({ devDependencies: { vite: "^7.0.0" } }));
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const { file } = await runVisualCommand({ _: ["visual", "init"] }, { root });
  const content = fs.readFileSync(file, "utf8");
  assert.match(content, /node_modules\/vite\/bin\/vite\.js/);
  assert.match(content, /vite: true/);
  await assert.rejects(() => runVisualCommand({ _: ["visual", "init"] }, { root }), /already exists/);
  const listing = await runVisualCommand({ _: ["visual", "list"], json: true }, { root });
  assert.deepEqual(listing.flows.map((flow) => flow.id), ["home"]);
  assert.equal(listing.build, true);
  await assert.rejects(() => runVisualCommand({ _: ["visual"], wat: true }, { root }), /Unknown visual option: --wat/);
  await assert.rejects(() => runVisualCommand({ _: ["visual", "explode"] }, { root }), /Unknown visual command: explode/);
});

const sampleManifest = {
  generatedAt: "2026-10-22T00:00:00.000Z",
  compare: true,
  diffThreshold: 0.001,
  durationSeconds: 3,
  targets: [{ label: "before", ref: "main", sha: "aaa", dirtyFiles: 0 }, { label: "after", ref: "feature", sha: "bbb", dirtyFiles: 1 }],
  clients: [{ id: "default", label: "</script><script>alert(1)</script>" }],
  viewports: ["mobile"],
  flows: [{ id: "home", group: "Pages", title: "Home", steps: [{ id: "home", title: "Home" }] }],
  results: [
    {
      client: "default", viewport: "mobile", flow: "home",
      before: { steps: [{ id: "home", title: "Home", shot: "shots/before/a.png", consoleErrors: [], networkErrors: [] }] },
      after: { steps: [{ id: "home", title: "Home", shot: "shots/after/a.png", consoleErrors: ["boom"], networkErrors: [] }] },
      diffs: { home: { ratio: 0.2, diffShot: "shots/diff/a.png", heightBefore: 800, heightAfter: 820 } },
    },
    { client: "default", viewport: "mobile", flow: "skip", after: { skipped: "not for this client", steps: [] } },
  ],
};

test("renderVisualReport embeds the manifest safely and ships a parseable script", () => {
  const html = renderVisualReport(sampleManifest);
  assert.ok(!html.includes("</script><script>alert(1)"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
  const data = html.match(/<script id="manifest" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(data).clients[0].label, sampleManifest.clients[0].label);
});

test("summarizeRun counts screens, changes and failures", () => {
  const summary = summarizeRun(sampleManifest);
  assert.deepEqual(
    { runs: summary.runs, skipped: summary.skipped, screens: summary.screens, compared: summary.compared, changed: summary.changed, failed: summary.failed },
    { runs: 1, skipped: 1, screens: 1, compared: 1, changed: 1, failed: 0 },
  );
});
