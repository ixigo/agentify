import { randomUUID } from "node:crypto";
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
  /^\.agents\//,
  /^\.current_session\//,
  /^docs\//,
  /^agentify-report\.html$/,
  /^output\.txt$/,
  /^AGENTIFY\.md$/,
];

const ignorePatternCache = new Map();

async function loadAgentignore(root) {
  if (ignorePatternCache.has(root)) {
    return ignorePatternCache.get(root);
  }
  try {
    const raw = await fs.readFile(path.join(root, ".agentignore"), "utf8");
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
    ignorePatternCache.set(root, patterns);
  } catch {
    ignorePatternCache.set(root, []);
  }
  return ignorePatternCache.get(root);
}

function isHardExcluded(relativePath) {
  return HARD_EXCLUDES.some((p) => p.test(relativePath));
}

function isAgentIgnored(relativePath, patterns) {
  return patterns.some((p) => p.test(relativePath));
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

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

export async function writeJson(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  const tmp = `${targetPath}.${randomUUID().slice(0, 8)}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, targetPath);
}

export async function walkFiles(root, { respectIgnore = false } = {}) {
  const files = [];
  const ignorePatterns = respectIgnore ? await loadAgentignore(root) : [];

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
          if (isHardExcluded(relDir) || isAgentIgnored(rel, ignorePatterns) || isAgentIgnored(relDir, ignorePatterns)) {
            continue;
          }
        }
        await visit(fullPath);
        continue;
      }
      if (respectIgnore) {
        if (isHardExcluded(rel) || isAgentIgnored(rel, ignorePatterns)) {
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
  const tmp = `${targetPath}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, targetPath);
}

export async function readText(targetPath) {
  return fs.readFile(targetPath, "utf8");
}
