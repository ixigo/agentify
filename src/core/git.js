import { execFile, spawn } from "node:child_process";
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

function readBatchEntry(buffer, offset, separator) {
  const headerEnd = buffer.indexOf(separator, offset);
  if (headerEnd === -1) {
    return null;
  }

  const header = buffer.toString("utf8", offset, headerEnd);
  if (header.endsWith(" missing")) {
    return { missing: true, nextOffset: headerEnd + 1 };
  }

  const sizeMatch = header.match(/^[0-9a-f]+ \S+ (\d+)$/);
  if (!sizeMatch) {
    return null;
  }

  const size = Number(sizeMatch[1]);
  const contentStart = headerEnd + 1;
  const contentEnd = contentStart + size;
  const nextOffset = contentEnd + 1;
  if (contentEnd > buffer.length || buffer[contentEnd] !== separator) {
    return null;
  }

  return {
    content: buffer.toString("utf8", contentStart, contentEnd),
    nextOffset,
  };
}

async function runCatFileBatchOnce(root, specs, args, separator, inputSeparator) {
  if (!specs.length) {
    return [];
  }

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderr || `git cat-file exited with code ${code}`));
        return;
      }

      const stdout = Buffer.concat(stdoutChunks);
      const entries = [];
      let offset = 0;
      for (let i = 0; i < specs.length; i += 1) {
        const entry = readBatchEntry(stdout, offset, separator);
        if (!entry) {
          reject(new Error("Unable to parse git cat-file --batch output"));
          return;
        }
        entries.push(entry.missing ? null : entry.content);
        offset = entry.nextOffset;
      }
      resolve(entries);
    });

    child.stdin.end(`${specs.join(inputSeparator)}${inputSeparator}`, "utf8");
  });
}

async function runCatFileBatch(root, specs) {
  try {
    return await runCatFileBatchOnce(root, specs, ["cat-file", "--batch", "-Z"], 0x00, "\0");
  } catch {
    return runCatFileBatchOnce(root, specs, ["cat-file", "--batch", "-z"], 0x0a, "\0");
  }
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
  const contents = await getFileContentsAtHead(root, [filePath]);
  return contents.get(filePath) ?? null;
}

export async function getFileContentsAtHead(root, filePaths) {
  const result = new Map();
  const uniquePaths = [...new Set((filePaths || []).filter(Boolean))];
  if (!uniquePaths.length) {
    return result;
  }

  try {
    const context = await getGitContext(root);
    const requests = [];
    for (const filePath of uniquePaths) {
      const gitPath = toGitRelativePath(filePath, context.rootPrefix);
      if (!gitPath) {
        result.set(filePath, null);
        continue;
      }
      requests.push({ filePath, spec: `HEAD:${gitPath}` });
    }

    const contents = await runCatFileBatch(root, requests.map((request) => request.spec));
    for (let i = 0; i < requests.length; i += 1) {
      result.set(requests[i].filePath, contents[i] ?? null);
    }
  } catch {
    for (const filePath of uniquePaths) {
      result.set(filePath, null);
    }
  }

  return result;
}
