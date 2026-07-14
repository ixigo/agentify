import path from "node:path";

import { exists, readJson, writePrivateJson } from "../fs.js";

import { SESSION_PARSER_VERSION, stableHash } from "./normalize.js";

export const SESSION_ANALYSIS_CACHE_VERSION = 1;

export function resolveAnalysisCachePath(root, options = {}) {
  if (options.cachePath) return path.resolve(options.cachePath);
  const cacheRoot = options.artifactPaths?.cacheRoot || path.join(path.resolve(root), ".agentify", "cache");
  return path.join(cacheRoot, "session-analysis.json");
}

export async function readAnalysisCache(cachePath, options = {}) {
  if (options.noCache === true || !(await exists(cachePath))) {
    return { schema_version: SESSION_ANALYSIS_CACHE_VERSION, consents: [], entries: {} };
  }
  try {
    const cache = await readJson(cachePath);
    if (cache?.schema_version !== SESSION_ANALYSIS_CACHE_VERSION || !cache.entries || typeof cache.entries !== "object") {
      return { schema_version: SESSION_ANALYSIS_CACHE_VERSION, consents: [], entries: {} };
    }
    return {
      schema_version: SESSION_ANALYSIS_CACHE_VERSION,
      consents: Array.isArray(cache.consents) ? cache.consents.filter((item) => typeof item === "string") : [],
      entries: cache.entries,
    };
  } catch {
    return { schema_version: SESSION_ANALYSIS_CACHE_VERSION, consents: [], entries: {} };
  }
}

export function cacheKey(provider, filePath) {
  return stableHash(`${provider}:${path.resolve(filePath)}`, 32);
}

export function cacheSignature(provider, file, options = {}) {
  return stableHash(JSON.stringify({
    provider,
    size: file.size,
    mtime_ms: Math.trunc(file.mtime_ms),
    parser_version: SESSION_PARSER_VERSION,
    scope: options.scope || "current-repo",
    content_mode: options.contentMode || "metadata-only",
    project: stableHash(options.projectRoot || "global"),
    project_boundary: options.projectBoundary || null,
  }), 32);
}

export async function writeAnalysisCache(cachePath, cache) {
  await writePrivateJson(cachePath, {
    schema_version: SESSION_ANALYSIS_CACHE_VERSION,
    consents: [...new Set(cache.consents || [])].sort(),
    entries: cache.entries || {},
  });
}

export function cloneCached(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
