import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".codex",
  ".claude",
  ".gemini",
  ".opencode",
  "coverage",
  ".venv",
  "venv",
  "bin",
  "obj",
]);

const HARD_EXCLUDES = [
  /^\.agentify\//,
  /^\.current_session\//,
  /^docs\//,
  /^agentify-report\.html$/,
  /^output\.txt$/,
  /(^|\/)AGENTIFY\.md$/,
];

const ignorePatternCache = new Map();
const ARTIFACT_PATH_MARKERS = new Set([
  ".agentify",
  ".current_session",
  "docs",
  "AGENTIFY.md",
  "agentify-report.html",
  "output.txt",
  ".agentignore",
  ".guardrails",
]);

async function loadAgentignore(root) {
  const ignorePath = path.join(root, ".agentignore");
  let stat = null;
  try {
    stat = await fs.stat(ignorePath, { bigint: true });
  } catch {
    // .agentignore is absent; fall through with stat=null
  }

  const cached = ignorePatternCache.get(root);
  if (cached) {
    if (stat === null && cached.mtimeNs === null) {
      return cached.patterns;
    }
    if (stat !== null && cached.mtimeNs === stat.mtimeNs && cached.size === stat.size) {
      return cached.patterns;
    }
  }

  if (stat === null) {
    ignorePatternCache.set(root, { mtimeNs: null, size: 0, patterns: [] });
    return [];
  }

  let raw;
  try {
    raw = await fs.readFile(ignorePath, "utf8");
  } catch {
    const patterns = [];
    ignorePatternCache.set(root, { mtimeNs: stat.mtimeNs, size: stat.size, patterns });
    return patterns;
  }
  const patterns = raw
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((pattern) => {
      const regexStr = pattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "{{GLOBSTAR}}")
        .replace(/\*/g, "[^/]*")
        .replace(/\{\{GLOBSTAR\}\}/g, ".*");
      return new RegExp(`^${regexStr}$`);
    });
  ignorePatternCache.set(root, { mtimeNs: stat.mtimeNs, size: stat.size, patterns });
  return patterns;
}

function isHardExcluded(relativePath) {
  return HARD_EXCLUDES.some((p) => p.test(relativePath));
}

function isAgentIgnored(relativePath, patterns) {
  return patterns.some((p) => p.test(relativePath));
}

async function loadGitIgnored(root) {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks = [];

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(new Set()));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(new Set());
        return;
      }
      const ignored = Buffer.concat(chunks)
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((ignoredPath) => ignoredPath.replace(/^\.\//, "").split(path.sep).join("/"));
      resolve(new Set(ignored));
    });
  });
}

function isGitIgnored(relativePath, ignoredPaths) {
  if (ignoredPaths.size === 0) {
    return false;
  }
  if (ignoredPaths.has(relativePath) || ignoredPaths.has(relativePath.endsWith("/") ? relativePath : `${relativePath}/`)) {
    return true;
  }
  let slashIndex = relativePath.indexOf("/");
  while (slashIndex !== -1) {
    if (ignoredPaths.has(`${relativePath.slice(0, slashIndex)}/`)) {
      return true;
    }
    slashIndex = relativePath.indexOf("/", slashIndex + 1);
  }
  return false;
}

export function resetIgnoreCache() {
  ignorePatternCache.clear();
}

export async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function assertNoSymlinkPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const { root } = path.parse(resolved);
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let startIndex = await findRepoRelativeStartIndex(resolved, root, parts);
  if (startIndex === -1) {
    startIndex = parts.findIndex((part) => ARTIFACT_PATH_MARKERS.has(part));
  }
  if (startIndex === -1) {
    return;
  }

  let current = path.join(root, ...parts.slice(0, startIndex));

  for (const part of parts.slice(startIndex)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlinked artifact path: ${current}`);
    }
  }
}

async function findRepoRelativeStartIndex(resolved, root, parts) {
  let current = resolved;
  try {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  let startIndex = -1;
  while (current && current !== root) {
    if (await hasRepoBoundaryMarker(current)) {
      const relativeToBoundary = path.relative(current, resolved);
      if (!relativeToBoundary || relativeToBoundary.startsWith("..") || path.isAbsolute(relativeToBoundary)) {
        return startIndex;
      }
      const boundaryParts = current.slice(root.length).split(path.sep).filter(Boolean);
      startIndex = Math.min(parts.length, boundaryParts.length + 1);
    }
    current = path.dirname(current);
  }

  return startIndex;
}

async function hasRepoBoundaryMarker(directory) {
  for (const marker of [".git", "package.json"]) {
    try {
      await fs.lstat(path.join(directory, marker));
      return true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
    }
  }
  return false;
}

export async function ensureDir(targetPath) {
  await assertNoSymlinkPath(targetPath);
  await fs.mkdir(targetPath, { recursive: true });
}

export async function readJson(targetPath) {
  await assertNoSymlinkPath(targetPath);
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

export async function writeJson(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await assertNoSymlinkPath(targetPath);
  const tmp = `${targetPath}.${randomUUID().slice(0, 8)}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, targetPath);
}

export async function walkFiles(root, { respectIgnore = false } = {}) {
  const files = [];
  const ignorePatterns = respectIgnore ? await loadAgentignore(root) : [];
  const gitIgnoredPaths = respectIgnore ? await loadGitIgnored(root) : new Set();

  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".DS_Store")) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      const rel = relative(root, fullPath);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        if (respectIgnore) {
          const relDir = `${rel}/`;
          if (
            isHardExcluded(relDir) ||
            isAgentIgnored(rel, ignorePatterns) ||
            isAgentIgnored(relDir, ignorePatterns) ||
            isGitIgnored(relDir, gitIgnoredPaths)
          ) {
            continue;
          }
        }
        await visit(fullPath);
        continue;
      }
      if (respectIgnore) {
        if (isHardExcluded(rel) || isAgentIgnored(rel, ignorePatterns) || isGitIgnored(rel, gitIgnoredPaths)) {
          continue;
        }
      }
      files.push(fullPath);
    }
  }

  await visit(root);
  return files;
}

export function relative(root, targetPath) {
  return path.relative(root, targetPath).split(path.sep).join("/");
}

export async function writeText(targetPath, text) {
  await ensureDir(path.dirname(targetPath));
  await assertNoSymlinkPath(targetPath);
  const tmp = `${targetPath}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, targetPath);
}

export async function appendText(targetPath, text) {
  await ensureDir(path.dirname(targetPath));
  await assertNoSymlinkPath(targetPath);
  await fs.appendFile(targetPath, text, "utf8");
}

export async function readText(targetPath) {
  await assertNoSymlinkPath(targetPath);
  return fs.readFile(targetPath, "utf8");
}

export async function statFile(targetPath) {
  await assertNoSymlinkPath(targetPath);
  return fs.stat(targetPath);
}
