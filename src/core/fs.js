import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

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

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileAgentignorePattern(pattern) {
  let regexStr = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        regexStr += ".*";
        index += 1;
      } else {
        regexStr += "[^/]*";
      }
      continue;
    }
    regexStr += escapeRegexLiteral(char);
  }
  return new RegExp(`^${regexStr}$`);
}

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
    .map((pattern) => compileAgentignorePattern(pattern));
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
  if (
    ignoredPaths.has(relativePath) ||
    ignoredPaths.has(relativePath.endsWith("/") ? relativePath : `${relativePath}/`)
  ) {
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

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function ensurePrivateDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.chmod(targetPath, PRIVATE_DIR_MODE);
}

export async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

async function atomicWriteText(targetPath, text, options = {}) {
  const ensureParent = options.private && options.privateDir !== false ? ensurePrivateDir : ensureDir;
  await ensureParent(path.dirname(targetPath));
  const tmp = `${targetPath}.${randomUUID().slice(0, 8)}.tmp`;
  const writeOptions = options.private ? { encoding: "utf8", mode: PRIVATE_FILE_MODE } : "utf8";
  await fs.writeFile(tmp, text, writeOptions);
  if (options.private) {
    await fs.chmod(tmp, PRIVATE_FILE_MODE);
  }
  await fs.rename(tmp, targetPath);
  if (options.private) {
    await fs.chmod(targetPath, PRIVATE_FILE_MODE);
  }
}

export async function writeJson(targetPath, value) {
  await atomicWriteText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writePrivateJson(targetPath, value) {
  await atomicWriteText(targetPath, `${JSON.stringify(value, null, 2)}\n`, { private: true });
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
  await atomicWriteText(targetPath, text);
}

export async function writePrivateText(targetPath, text, options = {}) {
  await atomicWriteText(targetPath, text, { private: true, ...options });
}

export async function appendPrivateText(targetPath, text) {
  await ensurePrivateDir(path.dirname(targetPath));
  try {
    await fs.chmod(targetPath, PRIVATE_FILE_MODE);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await fs.appendFile(targetPath, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await fs.chmod(targetPath, PRIVATE_FILE_MODE);
}

export async function readText(targetPath) {
  return fs.readFile(targetPath, "utf8");
}
