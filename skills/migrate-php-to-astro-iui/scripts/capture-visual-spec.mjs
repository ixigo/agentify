#!/usr/bin/env node

/**
 * Capture a deterministic visual specification for one route.
 *
 * Produces, per viewport, a full-page PNG plus a computed-style/geometry
 * snapshot of every rendered element. Run it once against the legacy
 * reference and once against the migrated route, then feed both output
 * directories to compare-visual-parity.mjs.
 */

import fs from "node:fs/promises";
import path from "node:path";

const STYLE_PROPERTIES = [
  "display",
  "position",
  "float",
  "flexDirection",
  "flexWrap",
  "justifyContent",
  "alignItems",
  "alignSelf",
  "gap",
  "gridTemplateColumns",
  "gridTemplateRows",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textAlign",
  "textTransform",
  "textDecorationLine",
  "whiteSpace",
  "color",
  "backgroundColor",
  "backgroundImage",
  "backgroundSize",
  "backgroundPosition",
  "backgroundRepeat",
  "opacity",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "boxShadow",
  "textShadow",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "overflowX",
  "overflowY",
  "objectFit",
  "aspectRatio",
  "zIndex",
  "visibility",
  "transform",
  "listStyleType",
];

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
  node capture-visual-spec.mjs --url <url> --out <dir> [--label reference|candidate]
  node capture-visual-spec.mjs --check

Options:
  --check                       Verify Playwright and Chromium are installed
  --url <url>                   Route to capture (required)
  --out <dir>                   Output directory (required)
  --label <name>                Spec label. Default: derived from --out
  --viewports <list>            Comma-separated WxH. Default: 390x844,768x1024,1440x900
  --wait-for <selector>         Wait for this selector before capture
  --settle <ms>                 Extra settle delay after load. Default: 600
  --storage-state <path>        Playwright storage state JSON
  --mask <selectors>            Comma-separated selectors to blank before capture
  --max-elements <n>            Element cap per viewport. Default: 6000
  --freeze-animations <bool>    Disable animations/transitions. Default: true
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
  if (
    (await pathExists(path.join(cwd, "bun.lockb"))) ||
    (await pathExists(path.join(cwd, "bun.lock")))
  ) {
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

async function loadChromium() {
  const specifiers = ["@playwright/test", "playwright", "playwright-core"];
  for (const specifier of specifiers) {
    try {
      const module = await import(specifier);
      const chromium = module.chromium || module.default?.chromium;
      if (chromium) {
        return { chromium, specifier };
      }
    } catch {
      // Try the next specifier.
    }
  }
  return null;
}

function parseViewports(value) {
  const raw = value || "390x844,768x1024,1440x900";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+)x(\d+)$/.exec(entry);
      if (!match) {
        throw new Error(`Invalid viewport "${entry}". Expected <width>x<height>.`);
      }
      return { width: Number(match[1]), height: Number(match[2]) };
    });
}

/**
 * Runs inside the page. Returns a geometry + computed-style snapshot.
 */
function collectSpec(properties, maxElements) {
  const roleOf = (element) => {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return `heading${tag.slice(1)}`;
    }
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "img" || tag === "svg" || tag === "picture") return "image";
    if (tag === "input" || tag === "select" || tag === "textarea") return "control";
    if (tag === "li") return "listitem";
    if (tag === "td" || tag === "th") return "cell";
    if (tag === "table") return "table";
    if (tag === "form") return "form";
    return "block";
  };

  const directText = (element) => {
    let text = "";
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue;
      }
    }
    return text.replace(/\s+/g, " ").trim();
  };

  const structuralPath = (element) => {
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < 12) {
      const tag = current.tagName.toLowerCase();
      if (tag === "html") break;
      const parent = current.parentElement;
      let index = 1;
      if (parent) {
        for (const sibling of parent.children) {
          if (sibling === current) break;
          if (sibling.tagName === current.tagName) index += 1;
        }
      }
      segments.unshift(`${tag}:${index}`);
      current = parent;
    }
    return segments.join(">");
  };

  const elements = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node = document.body;
  let truncated = false;

  while (node) {
    const tag = node.tagName.toLowerCase();
    if (!["script", "style", "noscript", "template", "link", "meta"].includes(tag)) {
      const rect = node.getBoundingClientRect();
      const styles = window.getComputedStyle(node);
      const visible =
        styles.display !== "none" &&
        styles.visibility !== "hidden" &&
        Number(styles.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0;

      if (visible) {
        const captured = {};
        for (const property of properties) {
          captured[property] = styles[property];
        }
        const entry = {
          path: structuralPath(node),
          tag,
          role: roleOf(node),
          text: directText(node).slice(0, 160),
          box: {
            x: Math.round((rect.left + window.scrollX) * 100) / 100,
            y: Math.round((rect.top + window.scrollY) * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          },
          styles: captured,
        };
        if (tag === "img") {
          entry.src = node.currentSrc || node.getAttribute("src") || "";
          entry.alt = node.getAttribute("alt") ?? null;
          entry.naturalWidth = node.naturalWidth;
          entry.naturalHeight = node.naturalHeight;
        }
        if (tag === "a") {
          entry.href = node.getAttribute("href") || "";
        }
        if (tag === "input" || tag === "select" || tag === "textarea") {
          entry.inputType = node.getAttribute("type") || tag;
          entry.placeholder = node.getAttribute("placeholder") || "";
        }
        elements.push(entry);
        if (elements.length >= maxElements) {
          truncated = true;
          break;
        }
      }
    }
    node = walker.nextNode();
  }

  const bodyStyles = window.getComputedStyle(document.body);
  return {
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    hasHorizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth + 1,
    body: {
      backgroundColor: bodyStyles.backgroundColor,
      color: bodyStyles.color,
      fontFamily: bodyStyles.fontFamily,
      fontSize: bodyStyles.fontSize,
    },
    truncated,
    elements,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === "true" || args.h === "true") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const loaded = await loadChromium();
  const manager = await detectPackageManager();

  if (args.check === "true") {
    if (!loaded) {
      process.stderr.write(
        `Playwright is not available in this project.\nInstall it with: ${manager.install}\n`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      const browser = await loaded.chromium.launch();
      await browser.close();
      process.stdout.write(
        `Playwright ready via "${loaded.specifier}" with Chromium installed.\n`,
      );
    } catch (error) {
      process.stderr.write(
        `Chromium is not installed: ${error.message}\nInstall it with: ${manager.browsers}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (!args.url || !args.out) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  if (!loaded) {
    process.stderr.write(
      `Playwright is not available in this project.\nInstall it with: ${manager.install}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const outputDir = path.resolve(args.out);
  const label = args.label && args.label !== "true" ? args.label : path.basename(outputDir);
  const viewports = parseViewports(args.viewports);
  const settle = Number(args.settle || 600);
  const maxElements = Number(args["max-elements"] || 6000);
  const freezeAnimations = args["freeze-animations"] !== "false";
  const masks = (args.mask && args.mask !== "true" ? args.mask : "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  await fs.mkdir(outputDir, { recursive: true });

  const browser = await loaded.chromium.launch();
  const contextOptions = { deviceScaleFactor: 1 };
  if (args["storage-state"] && args["storage-state"] !== "true") {
    contextOptions.storageState = args["storage-state"];
  }

  const spec = {
    label,
    url: args.url,
    capturedAt: new Date().toISOString(),
    masks,
    styleProperties: STYLE_PROPERTIES,
    viewports: [],
  };

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({ ...contextOptions, viewport });
      const page = await context.newPage();

      if (freezeAnimations) {
        await page.addStyleTag({
          content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`,
        }).catch(() => {});
      }

      await page.goto(args.url, { waitUntil: "networkidle", timeout: 60000 });

      if (freezeAnimations) {
        await page.addStyleTag({
          content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`,
        });
      }

      if (args["wait-for"] && args["wait-for"] !== "true") {
        await page.waitForSelector(args["wait-for"], { timeout: 30000 });
      }

      // Force lazy content to resolve so the full-page capture is stable.
      await page.evaluate(async () => {
        const step = Math.round(window.innerHeight * 0.8);
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        window.scrollTo(0, 0);
      });
      await page
        .evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true))
        .catch(() => {});
      await page.waitForTimeout(settle);

      if (masks.length > 0) {
        await page.evaluate((selectors) => {
          for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
              element.style.setProperty("visibility", "hidden", "important");
            }
          }
        }, masks);
      }

      const shotName = `${label}-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({
        path: path.join(outputDir, shotName),
        fullPage: true,
        animations: "disabled",
      });

      await page.addScriptTag({
        content: `window.__collectVisualSpec = ${collectSpec.toString()};`,
      });
      const captured = await page.evaluate(
        ({ properties, cap }) => window.__collectVisualSpec(properties, cap),
        { properties: STYLE_PROPERTIES, cap: maxElements },
      );

      spec.viewports.push({
        width: viewport.width,
        height: viewport.height,
        screenshot: shotName,
        ...captured,
      });

      process.stdout.write(
        `captured ${viewport.width}x${viewport.height} -> ${shotName} (${captured.elements.length} elements)\n`,
      );

      await context.close();
    }
  } finally {
    await browser.close();
  }

  const specPath = path.join(outputDir, "visual-spec.json");
  await fs.writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  process.stdout.write(`spec written to ${specPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
