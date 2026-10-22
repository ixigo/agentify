import fs from "node:fs";
import path from "node:path";

import { describeCheckout, ensureBaseline } from "./baseline.js";
import { analyzeBuild, compareBuilds, runBuild } from "./build-size.js";
import { createExternalRouter, runFlow, warmUp } from "./capture.js";
import { loadVisualConfig, pickById, pickViewports } from "./config.js";
import { createDiffer } from "./diff.js";
import { renderVisualReport } from "./report.js";
import { resolvePlaywright, startServer, waitForServer } from "./server.js";

export function visualRunsDir(root) {
  return path.join(root, ".agentify", "visual", "runs");
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:T]/g, "-").replace(/\..+/, "");
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async (_, slot) => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], slot);
    }
  }));
}

function summarizeFlows(flows) {
  return flows.map((flow) => ({
    id: flow.id,
    group: flow.group,
    title: flow.title,
    description: flow.description ?? null,
    steps: flow.steps.filter((step) => !step.noShot).map((step) => ({ id: step.id, title: step.title ?? step.id })),
  }));
}

export async function runVisual(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const log = options.log ?? (() => {});
  const { config } = await loadVisualConfig(root, options.config);
  const clients = pickById(config.clients, options.clients, "client");
  const flows = pickById(config.flows, options.flows, "flow");
  const viewports = pickViewports(config, options.viewports);
  const doScreens = !options.skipScreens;
  const doBuild = Boolean(config.build) && !options.skipBuildSize && (options.buildSize || Boolean(options.baseline));
  if (options.buildSize && !config.build) throw new Error("--build-size needs a build section in the visual config");

  const outDir = path.resolve(options.out ?? path.join(visualRunsDir(root), stamp()));
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();
  const port = Number(options.port ?? config.port);

  const after = { label: "after", root, config, port, baseUrl: config.baseUrl ?? `http://127.0.0.1:${port}` };
  const targets = [after];
  const checkouts = [describeCheckout(root, "after")];
  if (options.baseline) {
    if (config.baseUrl && !config.server) throw new Error("--baseline needs server.command: the baseline checkout has to be started locally");
    const baseline = ensureBaseline({ root, ref: options.baseline, config, log, spawn: options.spawnSync });
    const { config: baselineConfig } = await loadVisualConfig(baseline.root, baseline.configFile);
    targets.unshift({ label: "before", root: baseline.root, config: baselineConfig, port: port + 1, baseUrl: `http://127.0.0.1:${port + 1}` });
    checkouts.unshift({ ...describeCheckout(baseline.root, "before", options.baseline), sha: baseline.sha.slice(0, 9) });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    compare: targets.length > 1,
    diffThreshold: config.diffThreshold,
    targets: checkouts,
    clients: clients.map(({ id, label }) => ({ id, label })),
    viewports,
    flows: summarizeFlows(flows),
    results: [],
  };

  if (doBuild) {
    log("Measuring build size");
    try {
      const pages = config.build.pages;
      const builds = targets.map((target) => analyzeBuild(runBuild({ label: target.label, root: target.root, build: target.config.build ?? config.build, outRoot: path.join(outDir, "build"), log, spawn: options.spawnSync }), { pages }));
      manifest.build = builds.length === 1 ? { single: builds[0] } : compareBuilds(builds[0], builds[1]);
    } catch (error) {
      manifest.buildError = error.message;
      log(`Build size failed: ${error.message.split("\n")[0]}`);
    }
  }

  if (doScreens) {
    const servers = [];
    let browser;
    try {
      for (const target of targets) {
        if (!target.config.server?.command) continue;
        const handle = startServer({ server: target.config.server, port: target.port, label: target.label, spawnImpl: options.spawn });
        servers.push(handle);
        await waitForServer(new URL(target.config.server.readyPath, target.baseUrl).href, { timeoutMs: target.config.server.timeoutMs, handle });
      }
      const playwright = options.playwright ?? resolvePlaywright(targets.map((target) => target.root));
      const hosts = [...new Set(clients.map((client) => client.host).filter(Boolean))];
      browser = await playwright.chromium.launch({
        headless: !options.headed,
        args: hosts.length ? [`--host-resolver-rules=${hosts.map((host) => `MAP ${host} 127.0.0.1`).join(", ")}`] : [],
      });
      for (const target of targets) await warmUp(browser, target.baseUrl);

      const router = createExternalRouter({ cacheDir: path.join(root, ".agentify", "visual", "cache"), network: config.network });
      const jobs = clients.flatMap((client) => viewports.flatMap((viewport) => flows.map((flow) => ({ client, viewport, flow }))));
      log(`Running ${jobs.length} flow runs on ${targets.length} target(s)`);
      const workers = Number(options.workers ?? 3);
      const differs = Array.from({ length: workers }, () => createDiffer(browser, { dpr: config.dpr }));
      let done = 0;
      await pool(jobs, workers, async ({ client, viewport, flow }, slot) => {
        const result = { client: client.id, viewport, flow: flow.id };
        for (const target of targets) {
          const targetClient = target.config.clients.find((candidate) => candidate.id === client.id) ?? client;
          const targetFlow = target.config.flows.find((candidate) => candidate.id === flow.id);
          if (!targetFlow) {
            result[target.label] = { steps: [], error: `Flow ${flow.id} is not defined in the ${target.label} config` };
            continue;
          }
          result[target.label] = await runFlow({
            browser, expect: playwright.expect, target, config: target.config, client: targetClient, viewportName: viewport,
            flow: targetFlow, shotsDir: path.join(outDir, "shots", target.label), router,
          });
        }
        if (result.before) {
          result.diffs = {};
          for (const step of result.after.steps) {
            const previous = result.before.steps.find((candidate) => candidate.id === step.id);
            if (!step.shot || !previous?.shot) continue;
            const diffShot = path.join("shots", "diff", `${client.id}__${viewport}__${flow.id}__${step.id}.png`);
            result.diffs[step.id] = await differs[slot]
              .diff(path.join(outDir, previous.shot), path.join(outDir, step.shot), path.join(outDir, diffShot))
              .then((diff) => ({ ...diff, diffShot }))
              .catch((error) => ({ error: String(error.message).slice(0, 200) }));
          }
        }
        manifest.results.push(result);
        done += 1;
        const failure = result.after.error ?? result.after.steps.find((step) => step.error)?.error;
        const changed = Object.values(result.diffs ?? {}).filter((diff) => diff.ratio > config.diffThreshold).length;
        const status = failure ? "FAIL" : result.after.skipped ? "SKIP" : " ok ";
        log(`[${String(done).padStart(String(jobs.length).length)}/${jobs.length}] ${status} ${client.id} ${viewport} ${flow.id}${result.diffs ? ` · ${changed} changed` : ""}${failure ? ` - ${failure.slice(0, 120)}` : ""}`);
      });
      await Promise.all(differs.map((differ) => differ.close()));
    } finally {
      await browser?.close().catch(() => {});
      servers.forEach((handle) => handle.stop());
    }
  }

  manifest.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const order = new Map(jobsOrder(clients, viewports, flows));
  manifest.results.sort((a, b) => order.get(`${a.client}|${a.viewport}|${a.flow}`) - order.get(`${b.client}|${b.viewport}|${b.flow}`));
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const report = path.join(outDir, "index.html");
  fs.writeFileSync(report, renderVisualReport(manifest));
  fs.mkdirSync(visualRunsDir(root), { recursive: true });
  fs.writeFileSync(path.join(visualRunsDir(root), "LATEST"), `${path.relative(visualRunsDir(root), outDir)}\n`);
  return { outDir, report, manifest, summary: summarizeRun(manifest) };
}

function jobsOrder(clients, viewports, flows) {
  let index = 0;
  return clients.flatMap((client) => viewports.flatMap((viewport) => flows.map((flow) => [`${client.id}|${viewport}|${flow.id}`, index++])));
}

export function summarizeRun(manifest) {
  const runs = manifest.results.filter((result) => !result.after.skipped);
  const failed = runs.filter((result) => result.after.error || result.after.steps.some((step) => step.error));
  const diffs = runs.flatMap((result) => Object.values(result.diffs ?? {}).filter((diff) => !diff.error));
  return {
    runs: runs.length,
    failed: failed.length,
    skipped: manifest.results.length - runs.length,
    screens: runs.reduce((sum, result) => sum + result.after.steps.filter((step) => step.shot).length, 0),
    compared: diffs.length,
    changed: diffs.filter((diff) => diff.ratio > manifest.diffThreshold).length,
    beforeFailed: runs.filter((result) => result.before && (result.before.error || result.before.steps.some((step) => step.error))).length,
    buildWhy: manifest.build?.why ?? null,
    buildError: manifest.buildError ?? null,
  };
}
