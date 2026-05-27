#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUTPUT_DIR = ".figma-ui-build";
const SCAN_DIRS = ["src", "app", "pages", "components", "ui", "styles"];
const SCAN_FILE_RE = /\.(css|scss|sass|less|module\.css|tsx|ts|jsx|js|vue)$/i;

function usage() {
  return `Usage:
  node figma-ui-build.mjs "<figma-url>" [options]
  node figma-ui-build.mjs --check
  node figma-ui-build.mjs "<figma-url>" --parse-only

Options:
  --project-root <dir>              Default: .
  --component-hint <text>           Component name or UI role
  --route <path-or-url>             Local route or full preview URL
  --storybook-id <id>               Storybook story id
  --framework <name>                react|next|vue|unknown
  --output <dir>                    Default: .figma-ui-build/<timestamp>
  --reference-image <png-or-jpg>    Required visual reference supplied by the user
  --raw-node <json>                 Existing Figma node JSON; skips Figma API
  --cache-dir <dir>                 Default: <project-root>/.figma-ui-build/cache
  --refresh                         Ignore cached Figma node metadata
  --retries <count>                 Default: 2 for Figma API metadata requests
  --implementation-screenshot <png> Existing implementation screenshot path
  --eval-skill <name>               Default: ui-screenshot-eval
  --dry-run                         Fetch/analyze only; do not run eval command
  --parse-only                      Parse URL and print fileKey/nodeId only
  --check                           Verify Node fetch and token discovery
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
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

export function parseFigmaUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid Figma URL.");
  }

  if (!/figma\.com$/i.test(url.hostname) && !/\.figma\.com$/i.test(url.hostname)) {
    throw new Error("URL host is not figma.com.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const fileModeIndex = segments.findIndex((segment) => segment === "design" || segment === "file");
  const fileKey = fileModeIndex >= 0 ? segments[fileModeIndex + 1] : "";
  const rawNodeId = url.searchParams.get("node-id") || "";
  const nodeId = normalizeNodeId(rawNodeId);

  if (!fileKey || !nodeId) {
    throw new Error("Could not parse Figma file key or node-id.");
  }

  return {
    figmaUrl: rawUrl,
    fileKey,
    nodeId,
  };
}

export function normalizeNodeId(value) {
  return decodeURIComponent(String(value || "").trim()).replace(/-/g, ":");
}

function maskToken(token) {
  if (!token) {
    return "";
  }
  const suffix = token.slice(-4);
  const prefix = token.slice(0, 4);
  return `${prefix}****${suffix}`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseShellToken(content) {
  const tokenPattern = /(?:^|\n)\s*(?:export\s+)?(FIGMA_TOKEN|FIGMA_ACCESS_TOKEN)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\n#\s]+))/g;
  for (const match of content.matchAll(tokenPattern)) {
    const token = match[2] || match[3] || match[4];
    if (token) {
      return {
        name: match[1],
        token,
      };
    }
  }
  return null;
}

export async function readFigmaToken() {
  if (process.env.FIGMA_TOKEN) {
    return { name: "FIGMA_TOKEN", source: "env", token: process.env.FIGMA_TOKEN };
  }
  if (process.env.FIGMA_ACCESS_TOKEN) {
    return { name: "FIGMA_ACCESS_TOKEN", source: "env", token: process.env.FIGMA_ACCESS_TOKEN };
  }

  const home = os.homedir();
  const shellFiles = [
    ".zshrc",
    ".bashrc",
    ".profile",
    path.join(".config", "fish", "config.fish"),
  ];

  for (const relativePath of shellFiles) {
    const filePath = path.join(home, relativePath);
    if (!(await pathExists(filePath))) {
      continue;
    }
    const found = parseShellToken(await fs.readFile(filePath, "utf8"));
    if (found) {
      return {
        ...found,
        source: filePath,
      };
    }
  }

  return null;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryDelayMs(response, attempt, args) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) {
      return Math.min(seconds * 1000, 15_000);
    }
  }
  const baseDelay = parseInteger(args["retry-delay-ms"], 1000);
  return Math.min(baseDelay * 2 ** attempt, 15_000);
}

async function fetchJson(url, token, args = {}) {
  const retries = parseInteger(args.retries, 2);
  let lastStatus = 0;
  let lastText = "";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "X-Figma-Token": token,
      },
    });

    if (response.ok) {
      return response.json();
    }

    lastStatus = response.status;
    lastText = await response.text().catch(() => "");
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      await sleep(retryDelayMs(response, attempt, args));
      continue;
    }

    break;
  }

  const rateLimitHint = lastStatus === 429
    ? " Figma rate limited the request; wait before retrying, use cached metadata, or pass --raw-node to skip the API."
    : "";
  const detail = lastText ? ` ${lastText.slice(0, 200)}` : "";
  throw new Error(`Figma API returned ${lastStatus}. Check token permissions and file access.${rateLimitHint}${detail}`);
}

function safeCacheName(value) {
  return String(value || "").replace(/[^a-z0-9_.-]+/gi, "_");
}

function referenceImageName(inputPath) {
  const extension = path.extname(inputPath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw new Error("Reference image must be a png, jpg, jpeg, or webp file.");
  }
  return `reference${extension}`;
}

async function copyReferenceImage(inputPath, runDir) {
  if (!inputPath) {
    throw new Error("Provide a user-supplied node picture with --reference-image. The helper no longer exports node images from Figma.");
  }
  const absoluteInput = path.resolve(inputPath);
  if (!(await pathExists(absoluteInput))) {
    throw new Error(`Reference image was not found: ${absoluteInput}`);
  }
  const outputPath = path.join(runDir, referenceImageName(absoluteInput));
  await fs.copyFile(absoluteInput, outputPath);
  return outputPath;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fetchFigmaNodeWithCache({ parsed, tokenInfo, projectRoot, args }) {
  if (args["raw-node"]) {
    return {
      rawNode: await readJsonFile(path.resolve(args["raw-node"])),
      source: "raw-node",
      cachePath: "",
    };
  }

  const cacheDir = path.resolve(args["cache-dir"] || path.join(projectRoot, DEFAULT_OUTPUT_DIR, "cache"));
  const cachePath = path.join(cacheDir, `${safeCacheName(parsed.fileKey)}-${safeCacheName(parsed.nodeId)}.raw.json`);
  if (!args.refresh && await pathExists(cachePath)) {
    return {
      rawNode: await readJsonFile(cachePath),
      source: "cache",
      cachePath,
    };
  }

  if (!tokenInfo) {
    throw new Error("FIGMA_TOKEN not found in env, ~/.zshrc, ~/.bashrc, ~/.profile, or ~/.config/fish/config.fish.");
  }

  const nodeUrl = `https://api.figma.com/v1/files/${parsed.fileKey}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`;
  const rawNode = await fetchJson(nodeUrl, tokenInfo.token, args);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(rawNode, null, 2)}\n`);
  return {
    rawNode,
    source: "figma-api",
    cachePath,
  };
}

function colorToCss(color, opacity = 1) {
  if (!color) {
    return "";
  }
  const r = Math.round((color.r ?? 0) * 255);
  const g = Math.round((color.g ?? 0) * 255);
  const b = Math.round((color.b ?? 0) * 255);
  const a = Number((color.a ?? opacity ?? 1).toFixed(3));
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
}

function extractFills(fills = []) {
  return fills
    .filter((fill) => fill.visible !== false && fill.type === "SOLID")
    .map((fill) => colorToCss(fill.color, fill.opacity));
}

function mapLayoutMode(layoutMode) {
  if (layoutMode === "HORIZONTAL") {
    return "row";
  }
  if (layoutMode === "VERTICAL") {
    return "column";
  }
  return undefined;
}

function mapAxis(value, axis) {
  const map = {
    MIN: "flex-start",
    CENTER: "center",
    MAX: "flex-end",
    SPACE_BETWEEN: "space-between",
    BASELINE: "baseline",
  };
  if (axis === "counter" && value === "SPACE_BETWEEN") {
    return undefined;
  }
  return map[value] || undefined;
}

function walkNode(node, visitor, ancestry = []) {
  visitor(node, ancestry);
  for (const child of node.children || []) {
    walkNode(child, visitor, [...ancestry, node.name].filter(Boolean));
  }
}

export function normalizeFigmaNode(raw, parsed, screenshotPath) {
  const entry = raw.nodes?.[parsed.nodeId];
  const document = entry?.document;
  if (!document) {
    throw new Error(`Node ${parsed.nodeId} was not found in file ${parsed.fileKey}.`);
  }

  const typography = [];
  const colors = new Map();
  const effects = [];
  const assets = [];
  const visibleText = [];

  walkNode(document, (node, ancestry) => {
    for (const fill of extractFills(node.fills)) {
      colors.set(fill, { value: fill, source: node.name, property: node.type === "TEXT" ? "color" : "background" });
    }
    if (node.type === "TEXT") {
      if (node.characters) {
        visibleText.push(node.characters);
      }
      if (node.style) {
        typography.push({
          nodeName: node.name,
          text: node.characters || "",
          fontFamily: node.style.fontFamily,
          fontSize: node.style.fontSize,
          fontWeight: node.style.fontWeight,
          lineHeight: node.style.lineHeightPx,
        });
      }
    }
    for (const effect of node.effects || []) {
      if (effect.visible !== false) {
        effects.push({
          nodeName: node.name,
          type: effect.type,
          offset: effect.offset,
          radius: effect.radius,
          color: colorToCss(effect.color),
        });
      }
    }
    if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") {
      assets.push({
        nodeName: node.name,
        path: ancestry.concat(node.name).join(" / "),
        type: node.type,
      });
    }
  });

  const bounds = document.absoluteBoundingBox || {};
  const layout = {
    width: bounds.width,
    height: bounds.height,
    display: document.layoutMode ? "flex" : undefined,
    direction: mapLayoutMode(document.layoutMode),
    gap: document.itemSpacing,
    padding: {
      top: document.paddingTop,
      right: document.paddingRight,
      bottom: document.paddingBottom,
      left: document.paddingLeft,
    },
    borderRadius: document.cornerRadius ?? document.rectangleCornerRadii,
    justifyContent: mapAxis(document.primaryAxisAlignItems, "primary"),
    alignItems: mapAxis(document.counterAxisAlignItems, "counter"),
  };

  return {
    source: {
      figmaUrl: parsed.figmaUrl,
      fileKey: parsed.fileKey,
      nodeId: parsed.nodeId,
      nodeName: document.name,
      fetchedAt: new Date().toISOString(),
    },
    layout,
    typography,
    colors: [...colors.values()],
    effects,
    assets,
    visibleText,
    rawNodePath: "figma-node.raw.json",
    screenshotPath: path.basename(screenshotPath),
    referenceImagePath: path.basename(screenshotPath),
  };
}

async function walkFiles(rootDir, relativeDir, results, limit = 1500) {
  if (results.length >= limit) {
    return;
  }
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!(await pathExists(absoluteDir))) {
    return;
  }
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (results.length >= limit) {
      return;
    }
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".next")) {
      continue;
    }
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(rootDir, relativePath, results, limit);
    } else if (SCAN_FILE_RE.test(entry.name)) {
      results.push(relativePath);
    }
  }
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

async function scanCodebase(projectRoot, spec, componentHint) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    await walkFiles(projectRoot, dir, files);
  }

  const keywordSources = [
    componentHint,
    spec.source.nodeName,
    ...spec.visibleText.slice(0, 8),
    ...spec.colors.slice(0, 6).map((color) => color.value),
  ];
  const keywords = [...new Set(keywordSources.flatMap(tokenize))];
  const matches = [];

  for (const relativePath of files) {
    let content = "";
    try {
      content = await fs.readFile(path.join(projectRoot, relativePath), "utf8");
    } catch {
      continue;
    }
    const haystack = `${relativePath}\n${content}`.toLowerCase();
    let score = 0;
    const reason = [];
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) {
        score += relativePath.toLowerCase().includes(keyword) ? 4 : 1;
      }
    }
    if (/\b(card|button|badge|modal|tabs|input|panel|sheet|dialog)\b/i.test(relativePath)) {
      score += 2;
      reason.push("semantic component filename");
    }
    if (/(rounded|radius|border-radius|gap-|padding|p-\d|shadow|box-shadow)/i.test(content)) {
      score += 2;
      reason.push("contains layout or surface styling");
    }
    if (/(className|style=|styled|css`|module\.css|tailwind)/i.test(content)) {
      score += 1;
      reason.push("contains component styling");
    }
    if (score > 0) {
      matches.push({
        file: relativePath,
        confidence: Number(Math.min(0.95, score / Math.max(10, keywords.length + 8)).toFixed(2)),
        reason: reason.length ? reason : ["keyword or style signature match"],
      });
    }
  }

  matches.sort((left, right) => right.confidence - left.confidence || left.file.localeCompare(right.file));
  return {
    matches: matches.slice(0, 5),
    recommendedBase: matches[0]?.file || null,
    scannedFiles: files.length,
  };
}

function writeImplementationPlan({ spec, matches, args }) {
  const lines = [
    `# Figma UI Implementation Plan`,
    ``,
    `Figma node: ${spec.source.nodeName} (${spec.source.nodeId})`,
    args["component-hint"] ? `Component hint: ${args["component-hint"]}` : "",
    args.route ? `Route: ${args.route}` : "",
    args["storybook-id"] ? `Storybook ID: ${args["storybook-id"]}` : "",
    ``,
    `## Design Summary`,
    ``,
    `- Size: ${Math.round(spec.layout.width || 0)}x${Math.round(spec.layout.height || 0)}`,
    `- Layout: ${spec.layout.display || "unknown"} ${spec.layout.direction || ""}`.trim(),
    `- Gap: ${spec.layout.gap ?? "not specified"}`,
    `- Radius: ${JSON.stringify(spec.layout.borderRadius ?? "not specified")}`,
    `- Text nodes: ${spec.typography.length}`,
    `- Color tokens seen: ${spec.colors.length}`,
    ``,
    `## Recommended Codebase Starting Points`,
    ``,
    ...(matches.matches.length
      ? matches.matches.map((match, index) => `${index + 1}. ${match.file} (${match.confidence}) - ${match.reason.join(", ")}`)
      : ["No strong local component match found; create a focused component using existing styling conventions."]),
    ``,
    `## Build Steps`,
    ``,
    `1. Inspect the recommended component files and nearby tests/styles.`,
    `2. Reuse existing tokens, utility classes, and component primitives.`,
    `3. Add a stable data-testid to the Figma node root implementation.`,
    `4. Run the app or Storybook target.`,
    `5. Use ui-screenshot-eval to capture the implementation and compare it with the provided reference image.`,
    ``,
  ].filter((line) => line !== "");
  return `${lines.join("\n")}\n`;
}

function buildUiEvalPayload({ runDir, spec, args }) {
  const implementationScreenshot = args["implementation-screenshot"] || path.join(runDir, "implementation.png");
  return {
    evalSkill: args["eval-skill"] || "ui-screenshot-eval",
    referenceScreenshot: spec.referenceImagePath ? path.join(runDir, spec.referenceImagePath) : "",
    figmaScreenshot: spec.referenceImagePath ? path.join(runDir, spec.referenceImagePath) : "",
    implementationScreenshot,
    figmaSpec: path.join(runDir, "figma-spec.json"),
    codebaseMatches: path.join(runDir, "component-matches.json"),
    changedFiles: path.join(runDir, "changed-files.json"),
    targetUrl: args.route || "",
    storybookId: args["storybook-id"] || "",
    stableSelector: "",
    notes: `Compare visual parity for ${spec.source.nodeName}: spacing, typography, colors, layout, and component fidelity.`,
  };
}

async function maybeRunEvalCommand(payloadPath, args) {
  if (args["dry-run"] || !process.env.UI_EVAL_COMMAND) {
    return null;
  }

  const command = process.env.UI_EVAL_COMMAND.replace("{payload}", payloadPath);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ command, exitCode: code });
      } else {
        reject(new Error(`UI_EVAL_COMMAND exited with ${code}.`));
      }
    });
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const tokenInfo = await readFigmaToken();
  if (args.check) {
    const ok = Boolean(globalThis.fetch && tokenInfo);
    console.log(JSON.stringify({
      ok,
      fetch: Boolean(globalThis.fetch),
      tokenFound: Boolean(tokenInfo),
      tokenName: tokenInfo?.name || "",
      tokenSource: tokenInfo?.source || "",
      tokenMasked: tokenInfo ? maskToken(tokenInfo.token) : "",
    }, null, 2));
    if (!ok) {
      process.exitCode = 1;
    }
    return;
  }

  const figmaUrl = args._[0];
  if (!figmaUrl) {
    console.log(usage());
    process.exit(1);
  }

  const parsed = parseFigmaUrl(figmaUrl);
  if (args["parse-only"]) {
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }

  const projectRoot = path.resolve(args["project-root"] || ".");
  const runDir = path.resolve(args.output || path.join(DEFAULT_OUTPUT_DIR, timestamp()));
  await fs.mkdir(runDir, { recursive: true });

  const rawPath = path.join(runDir, "figma-node.raw.json");
  const screenshotPath = await copyReferenceImage(args["reference-image"] || args["node-image"], runDir);
  const { rawNode, source: nodeSource, cachePath } = await fetchFigmaNodeWithCache({
    parsed,
    tokenInfo,
    projectRoot,
    args,
  });
  await fs.writeFile(rawPath, `${JSON.stringify(rawNode, null, 2)}\n`);

  const spec = normalizeFigmaNode(rawNode, parsed, screenshotPath);
  const specPath = path.join(runDir, "figma-spec.json");
  await fs.writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

  const matches = await scanCodebase(projectRoot, spec, args["component-hint"] || "");
  const matchesPath = path.join(runDir, "component-matches.json");
  await fs.writeFile(matchesPath, `${JSON.stringify(matches, null, 2)}\n`);

  const planPath = path.join(runDir, "implementation-plan.md");
  await fs.writeFile(planPath, writeImplementationPlan({ spec, matches, args }));

  const changedFilesPath = path.join(runDir, "changed-files.json");
  if (!(await pathExists(changedFilesPath))) {
    await fs.writeFile(changedFilesPath, "[]\n");
  }

  const payload = buildUiEvalPayload({ runDir, spec, args });
  const payloadPath = path.join(runDir, "ui-eval-input.json");
  await fs.writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);

  const evalResult = await maybeRunEvalCommand(payloadPath, args);
  console.log(JSON.stringify({
    ok: true,
    runDir,
    parsed,
    tokenSource: tokenInfo?.source || "",
    tokenMasked: tokenInfo ? maskToken(tokenInfo.token) : "",
    figmaNodeSource: nodeSource,
    figmaNodeCache: cachePath,
    figmaSpec: specPath,
    referenceScreenshot: screenshotPath,
    componentMatches: matchesPath,
    implementationPlan: planPath,
    uiEvalInput: payloadPath,
    uiEvalCommand: evalResult,
  }, null, 2));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (entryPath === currentPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
