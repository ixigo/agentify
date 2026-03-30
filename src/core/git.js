import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const contextCache = new Map();

function normalizePath(value) {
  return String(value || "")
    .split("\\")
    .join("/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

function normalizePrefix(value) {
  return normalizePath(value).replace(/\/+$/, "");
}

function toRootRelativePath(gitPath, rootPrefix) {
  const normalizedPath = normalizePath(gitPath);
  const normalizedPrefix = normalizePrefix(rootPrefix);

  if (!normalizedPath) return null;
  if (!normalizedPrefix) return normalizedPath;
  if (
    normalizedPath === normalizedPrefix ||
    normalizedPath === `${normalizedPrefix}/`
  ) {
    return ".";
  }

  const prefixWithSlash = `${normalizedPrefix}/`;
  if (normalizedPath.startsWith(prefixWithSlash)) {
    return normalizedPath.slice(prefixWithSlash.length);
  }

  return null;
}

function toGitRelativePath(filePath, rootPrefix) {
  const normalizedPath = normalizePath(filePath);
  const normalizedPrefix = normalizePrefix(rootPrefix);

  if (!normalizedPath || normalizedPath === ".") {
    return normalizedPrefix;
  }
  if (!normalizedPrefix) {
    return normalizedPath;
  }
  if (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  ) {
    return normalizedPath;
  }

  return `${normalizedPrefix}/${normalizedPath}`;
}

async function getGitContext(root) {
  const cacheKey = String(root);
  if (contextCache.has(cacheKey)) {
    return contextCache.get(cacheKey);
  }

  const contextPromise = (async () => {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-prefix"], {
      cwd: root,
    });
    return {
      rootPrefix: normalizePath(stdout.trim()),
    };
  })().catch(() => ({ rootPrefix: "" }));

  contextCache.set(cacheKey, contextPromise);
  return contextPromise;
}

export async function getHeadCommit(root) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    return stdout.trim();
  } catch {
    return "nogit";
  }
}

export async function getChangedFiles(root) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z"],
      { cwd: root }
    );
    if (!stdout) return [];

    const context = await getGitContext(root);
    const entries = [];
    const parts = stdout.split("\0").filter(Boolean);
    let i = 0;

    while (i < parts.length) {
      const entry = parts[i];
      i += 1;

      const statusCode = entry.slice(0, 2);
      const sourceGitPath = normalizePath(entry.slice(3));

      if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
        const destinationGitPath = normalizePath(parts[i] || sourceGitPath);
        i += 1;

        const sourcePath = toRootRelativePath(sourceGitPath, context.rootPrefix);
        const destinationPath = toRootRelativePath(
          destinationGitPath,
          context.rootPrefix
        );
        if (!sourcePath && !destinationPath) {
          continue;
        }

        const selectedPath = destinationPath ?? sourcePath;
        const selectedGitPath = destinationPath
          ? destinationGitPath
          : sourceGitPath;

        entries.push({
          status: statusCode.trim(),
          path: selectedPath,
          gitPath: selectedGitPath,
          origPath: sourcePath,
          origGitPath: sourceGitPath,
        });
        continue;
      }

      const filePath = toRootRelativePath(sourceGitPath, context.rootPrefix);
      if (!filePath) {
        continue;
      }

      entries.push({
        status: statusCode.trim(),
        path: filePath,
        gitPath: sourceGitPath,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

export async function getChangedFilesSince(root, sinceCommit) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-status", "-z", sinceCommit, "HEAD"],
      { cwd: root }
    );
    if (!stdout) return [];

    const context = await getGitContext(root);
    const parts = stdout.split("\0").filter(Boolean);
    const entries = [];
    let i = 0;

    while (i < parts.length) {
      const rawStatus = parts[i] || "";
      i += 1;

      const statusCode = rawStatus.charAt(0);
      if (!statusCode) {
        continue;
      }

      if (statusCode === "R" || statusCode === "C") {
        const sourceGitPath = normalizePath(parts[i] || "");
        i += 1;
        const destinationGitPath = normalizePath(parts[i] || sourceGitPath);
        i += 1;

        const sourcePath = toRootRelativePath(sourceGitPath, context.rootPrefix);
        const destinationPath = toRootRelativePath(
          destinationGitPath,
          context.rootPrefix
        );
        if (!sourcePath && !destinationPath) {
          continue;
        }

        const selectedPath = destinationPath ?? sourcePath;
        const selectedGitPath = destinationPath
          ? destinationGitPath
          : sourceGitPath;

        entries.push({
          status: statusCode,
          path: selectedPath,
          gitPath: selectedGitPath,
          origPath: sourcePath,
          origGitPath: sourceGitPath,
        });
        continue;
      }

      const gitPath = normalizePath(parts[i] || "");
      i += 1;

      const filePath = toRootRelativePath(gitPath, context.rootPrefix);
      if (!filePath) {
        continue;
      }

      entries.push({
        status: statusCode,
        path: filePath,
        gitPath,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

export async function getFileContentAtHead(root, filePath) {
  try {
    const context = await getGitContext(root);
    const gitPath = toGitRelativePath(filePath, context.rootPrefix);
    if (!gitPath) {
      return null;
    }

    const { stdout } = await execFileAsync("git", ["show", `HEAD:${gitPath}`], {
      cwd: root,
    });
    return stdout;
  } catch {
    return null;
  }
}
