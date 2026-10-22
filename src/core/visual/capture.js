import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHEABLE_TYPES = new Set(["image", "font", "media"]);

export function buildStartUrl({ baseUrl, client, flow, config }) {
  const start = typeof flow.start === "function" ? flow.start({ client }) : flow.start;
  const target = typeof start === "string" ? { path: start } : start;
  const url = new URL(target.path ?? "/", client.host ? withHost(baseUrl, client.host) : baseUrl);
  const query = { ...config.query, ...client.query, ...(target.query ?? {}) };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.href;
}

function withHost(baseUrl, host) {
  const url = new URL(baseUrl);
  url.hostname = host;
  return url.href;
}

export function isLocalHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]";
}

export function matchesBlocked(hostname, block) {
  return block.some((entry) => entry instanceof RegExp ? entry.test(hostname) : hostname.includes(entry));
}

export function createExternalRouter({ cacheDir, network }) {
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  return async (route) => {
    const request = route.request();
    const url = request.url();
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return route.fallback();
    }
    if (isLocalHost(hostname) || url.startsWith("data:")) return route.fallback();
    if (matchesBlocked(hostname, network.block)) return route.abort();
    if (!network.cacheExternal || !cacheDir || !CACHEABLE_TYPES.has(request.resourceType())) return route.fallback();
    const file = path.join(cacheDir, createHash("sha1").update(url).digest("hex"));
    if (fs.existsSync(file) && fs.existsSync(`${file}.json`)) {
      const meta = JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
      return route.fulfill({ status: meta.status, headers: meta.headers, body: fs.readFileSync(file) });
    }
    try {
      const response = await route.fetch({ timeout: 15_000 });
      const body = await response.body();
      if (response.ok()) {
        fs.writeFileSync(file, body);
        fs.writeFileSync(`${file}.json`, JSON.stringify({
          status: response.status(),
          headers: { "content-type": response.headers()["content-type"] ?? "application/octet-stream", "access-control-allow-origin": "*" },
        }));
      }
      return route.fulfill({ response, body });
    } catch {
      return route.abort();
    }
  };
}

export async function settle(page, mode) {
  if (mode === "none") return;
  await page.waitForLoadState("networkidle", { timeout: mode === "quick" ? 2_000 : 8_000 }).catch(() => {});
  await page.evaluate(async () => {
    await globalThis.document.fonts?.ready;
    const pending = [...globalThis.document.images].filter((image) => !image.complete);
    await Promise.race([
      Promise.all(pending.map((image) => new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      }))),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }).catch(() => {});
  await page.waitForTimeout(mode === "quick" ? 200 : 600);
}

function skipReason(rule, ctx) {
  if (!rule) return null;
  const result = typeof rule === "function" ? rule(ctx) : rule;
  if (!result) return null;
  return typeof result === "string" ? result : "skipped by config";
}

function cleanError(error) {
  return String(error?.message ?? error).split("\n").slice(0, 3).join(" ").replace(/\u001b\[[0-9;]*m/g, "").slice(0, 400);
}

export async function runFlow({ browser, expect, target, config, client, viewportName, flow, shotsDir, router }) {
  const record = { steps: [] };
  const flowSkip = skipReason(flow.skip, { client, viewport: viewportName, target: target.label });
  if (flowSkip) {
    record.skipped = flowSkip;
    return record;
  }
  fs.mkdirSync(shotsDir, { recursive: true });
  const viewport = config.viewports[viewportName];
  const context = await browser.newContext({
    ...viewport,
    deviceScaleFactor: config.dpr,
    locale: "en-US",
    colorScheme: "light",
    serviceWorkers: "allow",
    ...(flow.context ?? {}),
  });
  if (router) await context.route("**/*", router);
  for (const init of [client.init, flow.init]) {
    if (init) await init({ context, client, flow, viewport: viewportName, target: target.label });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(config.stepTimeoutMs);
  const consoleErrors = [];
  const networkErrors = [];
  const ignoreConsole = config.network.ignoreConsole;
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/^Failed to load resource/.test(text) || ignoreConsole.some((pattern) => (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)))) return;
    consoleErrors.push(text.slice(0, 300));
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error.message).slice(0, 300)}`));
  page.on("response", (response) => {
    const url = response.url();
    const tracked = config.network.track ? config.network.track(url) : isLocalHost(new URL(url).hostname);
    if (tracked && response.status() >= 500) networkErrors.push(`${response.status()} ${response.request().method()} ${new URL(url).pathname}`);
  });

  const baseUrl = target.baseUrl;
  try {
    await page.goto(buildStartUrl({ baseUrl, client, flow, config }), { waitUntil: "domcontentloaded" });
    if (config.waitForApp) await config.waitForApp({ page, client, flow });
  } catch (error) {
    record.error = `Could not open ${flow.id}: ${cleanError(error)}`;
    await context.close();
    return record;
  }

  const ctx = { page, context, expect, client, flow, viewport: viewportName, target: target.label };
  for (const step of flow.steps) {
    const stepSkip = skipReason(step.skip, ctx);
    if (stepSkip) continue;
    const consoleBefore = consoleErrors.length;
    const networkBefore = networkErrors.length;
    const stepRecord = { id: step.id, title: step.title ?? step.id };
    try {
      if (step.run) await step.run(ctx);
      await settle(page, step.settle);
    } catch (error) {
      stepRecord.error = cleanError(error);
      await settle(page, "quick");
    }
    stepRecord.url = page.url().replace(/^https?:\/\/[^/]+/, "");
    stepRecord.consoleErrors = consoleErrors.slice(consoleBefore);
    stepRecord.networkErrors = [...new Set(networkErrors.slice(networkBefore))];
    if (!step.noShot || stepRecord.error) {
      const file = `${client.id}__${viewportName}__${flow.id}__${step.id}.png`;
      const clip = config.fullPage ? await tallPageClip(page, viewport, config.maxShotHeight) : null;
      await page.screenshot({
        path: path.join(shotsDir, file),
        fullPage: config.fullPage,
        ...(clip ? { clip } : {}),
        animations: "disabled",
        caret: "hide",
        timeout: 30_000,
      }).then(() => {
        stepRecord.shot = path.join("shots", target.label, file);
      }).catch((error) => {
        stepRecord.error ??= `Screenshot failed: ${cleanError(error)}`;
      });
    }
    record.steps.push(stepRecord);
    if (stepRecord.error) break;
  }
  await context.close();
  return record;
}

async function tallPageClip(page, viewport, maxHeight) {
  const height = await page.evaluate(() => globalThis.document.documentElement.scrollHeight).catch(() => 0);
  return height > maxHeight ? { x: 0, y: 0, width: viewport.viewport.width, height: maxHeight } : null;
}

export async function warmUp(browser, url, attempts = 2) {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
  }
  await context.close();
}
