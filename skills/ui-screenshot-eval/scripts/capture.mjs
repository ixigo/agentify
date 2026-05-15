#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function usage() {
  return `Usage:
  node capture.mjs --url <url> (--test-id <id> | --selector <css>) --out <dir>
  node capture.mjs --check

Options:
  --check                         Verify Playwright and Chromium are installed
  --viewport <width>x<height>      Default: 1440x900
  --wait-for <selector>            Wait for app readiness before capture
  --storage-state <path>           Playwright storage state JSON
  --full-page <true|false>         Default: true
`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager() {
  const cwd = process.cwd();
  if (await pathExists(path.join(cwd, "pnpm-lock.yaml"))) {
    return {
      install: "pnpm add -D @playwright/test",
      browsers: "pnpm exec playwright install chromium",
    };
  }
  if (await pathExists(path.join(cwd, "yarn.lock"))) {
    return {
      install: "yarn add -D @playwright/test",
      browsers: "yarn playwright install chromium",
    };
  }
  if ((await pathExists(path.join(cwd, "bun.lockb"))) || (await pathExists(path.join(cwd, "bun.lock")))) {
    return {
      install: "bun add -d @playwright/test",
      browsers: "bunx playwright install chromium",
    };
  }
  return {
    install: "npm install -D @playwright/test",
    browsers: "npx playwright install chromium",
  };
}

async function buildInstallHint() {
  const commands = await detectPackageManager();
  return `Install Playwright in the target repo, then rerun:
  ${commands.install}
  ${commands.browsers}`;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (firstError) {
    try {
      return await import("@playwright/test");
    } catch {
      throw new Error(
        `Required tool missing: Playwright is not available in this repo.\n${await buildInstallHint()}\nOriginal error: ${firstError.message}`
      );
    }
  }
}

async function launchChromium(playwright) {
  try {
    return await playwright.chromium.launch();
  } catch (error) {
    const commands = await detectPackageManager();
    throw new Error(
      `Required Playwright browser is missing or cannot launch.\nRun this in the target repo, then rerun:\n  ${commands.browsers}\nOriginal error: ${error.message}`
    );
  }
}

function parseViewport(value = "1440x900") {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid --viewport "${value}". Expected WIDTHxHEIGHT.`);
  }
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function buildSelector(args) {
  if (args.selector) {
    return args.selector;
  }
  if (args["test-id"]) {
    return `[data-testid="${args["test-id"]}"]`;
  }
  throw new Error("Pass either --test-id or --selector.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  if (args.check) {
    const playwright = await loadPlaywright();
    const browser = await launchChromium(playwright);
    await browser.close();
    console.log(JSON.stringify({ ok: true, playwright: true, chromium: true }, null, 2));
    return;
  }

  if (!args.url || !args.out) {
    console.log(usage());
    process.exit(1);
  }

  const selector = buildSelector(args);
  const outDir = path.resolve(args.out);
  const viewport = parseViewport(args.viewport);
  const fullPage = args["full-page"] !== "false";
  const playwright = await loadPlaywright();

  await fs.mkdir(outDir, { recursive: true });

  const browser = await launchChromium(playwright);
  try {
    const contextOptions = { viewport };
    if (args["storage-state"]) {
      contextOptions.storageState = path.resolve(args["storage-state"]);
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    await page.goto(args.url, { waitUntil: "domcontentloaded" });
    if (args["wait-for"]) {
      await page.waitForSelector(args["wait-for"], { state: "visible" });
    }
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    const locator = page.locator(selector);
    const count = await locator.count();
    if (count !== 1) {
      throw new Error(`Selector "${selector}" matched ${count} elements; expected exactly 1.`);
    }

    const fullPath = path.join(outDir, "full-page.png");
    const elementPath = path.join(outDir, "element.png");
    const manifestPath = path.join(outDir, "manifest.json");

    await page.screenshot({ path: fullPath, fullPage });
    await locator.screenshot({ path: elementPath });

    const manifest = {
      url: args.url,
      selector,
      count,
      viewport,
      fullPage,
      fullPageScreenshot: fullPath,
      elementScreenshot: elementPath,
      capturedAt: new Date().toISOString(),
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
