import fs from "node:fs";
import path from "node:path";

import { openInBrowser } from "./browser.js";
import { removeBaseline } from "./visual/baseline.js";
import { kb } from "./visual/build-size.js";
import { CONFIG_CANDIDATES, loadVisualConfig } from "./visual/config.js";
import { runVisual } from "./visual/run.js";

export const VISUAL_HELP = `Usage: agentify visual [run|init|list|clean] [options]

Walk your app's pages and flows in a real browser for every client and
viewport, screenshot each step, and write an HTML review page. With
--baseline it also checks out that ref in a git worktree, runs the same
flows there, and shows before / after / pixel diff for every screen plus a
production build-size comparison that explains why the bundle changed.

Commands:
  run (default)           Capture screens (and build size with --baseline)
  init                    Write a starter agentify.visual.mjs for this project
  list                    Show the clients, flows and viewports in the config
  clean                   Remove the baseline worktree

Options:
  --config <file>         Config file (default: ${CONFIG_CANDIDATES.join(", ")})
  --baseline <ref>        Compare against a branch, tag or sha; merge-base or
                          merge-base:<branch> uses the commit this branch started from
  --clients <ids>         Comma-separated client ids (default: all)
  --flows <ids>           Comma-separated flow ids (default: all)
  --viewports <names>     mobile, desktop, a configured name, or all (default: config)
  --build-size            Measure the build even without --baseline
  --skip-build-size       Do not build when comparing
  --skip-screens          Only measure build size
  --workers <n>           Parallel browser contexts (default: 3)
  --port <n>              Dev server port; the baseline uses port + 1 (default: 4391)
  --out <dir>             Output directory (default: .agentify/visual/runs/<timestamp>)
  --headed                Show the browser
  --open                  Open the report when done
  --json                  Print the run summary as JSON

Playwright is loaded from the project (pnpm add -D playwright), or from the
directory in AGENTIFY_PLAYWRIGHT_FROM; run "pnpm exec playwright install
chromium" once if the browser is missing.

Examples:
  agentify visual init
  agentify visual --open
  agentify visual --baseline merge-base --open
  agentify visual --baseline main --flows checkout --viewports all
  agentify visual --baseline main --skip-screens
`;

const STARTER = ({ vite, devCommand }) => `export default {
  // Started once per checkout; {port} is filled in. Point it at a mock-data mode
  // (MSW, fixtures, a stub API) so screens are stable between runs.
  server: {
    command: ${JSON.stringify(devCommand)},
    readyPath: "/",
  },

  // Re-run the same flows for each client (theme, partner, platform).
  // query is added to every start URL; host maps e.g. "brand.localhost" to 127.0.0.1.
  clients: [
    { id: "default", label: "Default" },
  ],

  // mobile (390px) and desktop (1280px) are built in; add more under viewports.
  defaultViewports: ["mobile"],

  flows: [
    {
      id: "home",
      group: "Pages",
      title: "Home",
      start: { path: "/" },
      steps: [{ id: "home", title: "Home" }],
    },
    // {
    //   id: "checkout",
    //   group: "Flows",
    //   title: "Checkout",
    //   start: { path: "/cart" },
    //   steps: [
    //     { id: "cart", title: "Cart" },
    //     { id: "pay", title: "Payment", run: async ({ page, expect }) => {
    //       await page.getByRole("button", { name: "Pay" }).click();
    //       await expect(page.getByText("Payment")).toBeVisible();
    //     } },
    //   ],
    // },
  ],

  // Used by --baseline to install the old checkout's dependencies.
  install: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],

  build: ${vite ? `{
    vite: true,
    // Optional: route chunks to report "JavaScript to open each page".
    // pages: [{ id: "home", label: "Home", route: "/", module: "src/pages/Home/index" }],
  }` : `{
    command: ["npm", "run", "build"],
    outDir: "dist",
  }`},
};
`;

function detectProject(root) {
  const pkgFile = path.join(root, "package.json");
  const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, "utf8")) : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const vite = Boolean(deps.vite);
  const devCommand = vite
    ? ["node", "node_modules/vite/bin/vite.js", "--port", "{port}", "--strictPort", "--host", "127.0.0.1"]
    : ["npm", "run", "dev", "--", "--port", "{port}"];
  return { vite, devCommand };
}

export function initVisualConfig(root, { force = false } = {}) {
  const file = path.join(root, "agentify.visual.mjs");
  if (fs.existsSync(file) && !force) throw new Error(`${file} already exists; pass --force to overwrite`);
  fs.writeFileSync(file, STARTER(detectProject(root)));
  return file;
}

function printSummary(result) {
  const { summary, manifest, report } = result;
  if (summary.runs || summary.skipped) {
    process.stdout.write(`Screens: ${summary.screens} from ${summary.runs} runs, ${summary.failed} failed, ${summary.skipped} skipped\n`);
    if (manifest.compare) process.stdout.write(`Compared: ${summary.changed} of ${summary.compared} screens changed; ${summary.beforeFailed} runs failed on before\n`);
  }
  if (manifest.build?.why) {
    process.stdout.write("Build size:\n");
    for (const line of manifest.build.why) process.stdout.write(`  - ${line}\n`);
  } else if (manifest.build?.single) {
    const totals = manifest.build.single.totals;
    process.stdout.write(`Build size: JS ${kb(totals.jsGzip)} gzip (first paint ${kb(totals.initialJsGzip)}), CSS ${kb(totals.cssGzip)}\n`);
  }
  if (manifest.buildError) process.stdout.write(`Build size failed: ${manifest.buildError.split("\n")[0]}\n`);
  process.stdout.write(`Report: ${report}\n`);
}

const ALLOWED = new Set([
  "_", "config", "baseline", "clients", "flows", "viewports", "buildSize", "skipBuildSize", "skipScreens",
  "workers", "port", "out", "headed", "open", "json", "help", "force",
]);

export async function runVisualCommand(args, runtime = {}) {
  if (args.help) {
    process.stdout.write(VISUAL_HELP);
    return null;
  }
  for (const key of Object.keys(args)) {
    if (!ALLOWED.has(key)) throw new Error(`Unknown visual option: --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}; use --help`);
  }
  const root = path.resolve(runtime.root ?? process.cwd());
  const subcommand = args._[1] ?? "run";

  if (subcommand === "init") {
    const file = initVisualConfig(root, { force: args.force });
    process.stdout.write(`Wrote ${file}\nEdit the server command and flows, then run: agentify visual --open\n`);
    return { file };
  }
  if (subcommand === "clean") {
    const removed = removeBaseline(root);
    process.stdout.write(removed ? "Removed the baseline worktree\n" : "No baseline worktree to remove\n");
    return { removed };
  }
  if (subcommand === "list") {
    const { file, config } = await loadVisualConfig(root, args.config);
    const listing = {
      file,
      clients: config.clients.map(({ id, label }) => ({ id, label })),
      flows: config.flows.map((flow) => ({ id: flow.id, group: flow.group, title: flow.title, steps: flow.steps.map((step) => step.id) })),
      viewports: Object.keys(config.viewports),
      defaultViewports: config.defaultViewports,
      build: Boolean(config.build),
    };
    if (args.json) {
      process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`);
      return listing;
    }
    process.stdout.write(`Config: ${file}\nClients:\n`);
    for (const client of listing.clients) process.stdout.write(`  ${client.id.padEnd(16)} ${client.label}\n`);
    process.stdout.write("Flows:\n");
    for (const flow of listing.flows) process.stdout.write(`  ${flow.id.padEnd(24)} [${flow.group}] ${flow.title} (${flow.steps.length} steps)\n`);
    process.stdout.write(`Viewports: ${listing.viewports.join(", ")} (default ${listing.defaultViewports.join(", ")})\n`);
    return listing;
  }
  if (subcommand !== "run") throw new Error(`Unknown visual command: ${subcommand}; use run, init, list or clean`);

  const result = await runVisual({
    root,
    config: args.config,
    baseline: args.baseline,
    clients: args.clients,
    flows: args.flows,
    viewports: args.viewports,
    buildSize: args.buildSize,
    skipBuildSize: args.skipBuildSize,
    skipScreens: args.skipScreens,
    workers: args.workers,
    port: args.port,
    out: args.out,
    headed: args.headed,
    log: args.json ? () => {} : (line) => process.stdout.write(`${line}\n`),
    ...(runtime.visual ?? {}),
  });
  if (args.json) process.stdout.write(`${JSON.stringify({ report: result.report, summary: result.summary }, null, 2)}\n`);
  else printSummary(result);
  if (args.open) {
    await (runtime.openInBrowser ?? openInBrowser)(result.report).catch((error) => {
      process.stdout.write(`Could not open the report (${error.message}); open ${result.report}\n`);
    });
  }
  if (result.summary.failed) process.exitCode = 1;
  return result;
}

