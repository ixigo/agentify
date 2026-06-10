import path from "node:path";

export function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split(path.sep)
    .join("/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

export function normalizePrefix(value) {
  return normalizePath(value).replace(/\/+$/, "");
}

export function normalizeRepoPath(value, options = {}) {
  const raw = String(value || "");
  const normalized = options.stripEmptySegments
    ? raw.split(/[\\/]+/).filter(Boolean).join("/")
    : normalizePath(raw);
  return options.nullOnEmpty && !normalized ? null : normalized;
}

export function toRootRelativePath(gitPath, rootPrefix) {
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

export function toGitRelativePath(filePath, rootPrefix) {
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
