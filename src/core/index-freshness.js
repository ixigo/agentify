import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { exists, readJson, writeJson } from "./fs.js";
import { getChangedFiles, getChangedFilesSince, getCurrentBranch, getHeadCommit, getHeadTree } from "./git.js";
import { SCHEMA_VERSIONS } from "./schema.js";

const LARGE_DIFF_FILE_LIMIT = 50;
const INDEX_META_SCHEMA_VERSION = 1;

function sha1(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

function shouldTrackDirtyPath(filePath) {
  const normalized = String(filePath || "").split(path.sep).join("/");
  return Boolean(normalized)
    && !normalized.startsWith(".agentify/")
    && !normalized.startsWith(".current_session/")
    && !normalized.startsWith("docs/")
    && normalized !== "agentify-report.html"
    && normalized !== "output.txt"
    && !/(^|\/)AGENTIFY\.md$/.test(normalized);
}

function normalizeDirtyFiles(entries) {
  return [...new Set((entries || [])
    .map((entry) => entry?.path)
    .filter(shouldTrackDirtyPath))]
    .sort();
}

async function fingerprintFile(root, filePath) {
  const fullPath = path.join(root, filePath);
  try {
    const [stat, content] = await Promise.all([
      fs.stat(fullPath),
      fs.readFile(fullPath),
    ]);
    return {
      sha1: sha1(content),
      mtime_ms: Math.round(Number(stat.mtimeMs)),
      size: Number(stat.size),
    };
  } catch {
    return null;
  }
}

async function fingerprintPaths(root, filePaths) {
  const fingerprints = {};
  for (const filePath of filePaths) {
    const fingerprint = await fingerprintFile(root, filePath);
    if (fingerprint) {
      fingerprints[filePath] = fingerprint;
    }
  }
  return fingerprints;
}

function sameArray(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function sameFingerprint(left, right) {
  return Boolean(left && right)
    && left.sha1 === right.sha1
    && Number(left.size) === Number(right.size);
}

async function dirtySnapshotMatches(root, meta, dirtyFiles) {
  const previousDirtyFiles = Array.isArray(meta?.dirty_files_snapshot)
    ? [...meta.dirty_files_snapshot].sort()
    : [];
  if (!sameArray(previousDirtyFiles, dirtyFiles)) {
    return false;
  }
  if (dirtyFiles.length === 0) {
    return true;
  }

  const currentFingerprints = await fingerprintPaths(root, dirtyFiles);
  for (const filePath of dirtyFiles) {
    if (!sameFingerprint(meta?.file_fingerprints?.[filePath], currentFingerprints[filePath])) {
      return false;
    }
  }
  return true;
}

export async function readIndexMeta(indexMetaPath) {
  try {
    return await readJson(indexMetaPath);
  } catch {
    return null;
  }
}

export async function getIndexFreshness(root, artifactPaths) {
  const [meta, indexedHead, indexedTree, indexedBranch, dirtyEntries] = await Promise.all([
    readIndexMeta(artifactPaths.indexMetaPath),
    getHeadCommit(root),
    getHeadTree(root),
    getCurrentBranch(root),
    getChangedFiles(root),
  ]);
  const dirtyFiles = normalizeDirtyFiles(dirtyEntries);

  if (!(await exists(artifactPaths.indexDb))) {
    return {
      index_status: "missing",
      refresh_mode: "full",
      stale_reason: "missing_index",
      indexed_head: indexedHead,
      indexed_tree: indexedTree,
      indexed_branch: indexedBranch,
      dirty_files: dirtyFiles,
      changed_files: dirtyFiles,
    };
  }

  if (!meta) {
    return {
      index_status: "stale",
      refresh_mode: "full",
      stale_reason: "missing_meta",
      indexed_head: indexedHead,
      indexed_tree: indexedTree,
      indexed_branch: indexedBranch,
      dirty_files: dirtyFiles,
      changed_files: dirtyFiles,
    };
  }

  if (meta.agentify_index_schema !== SCHEMA_VERSIONS.INDEX) {
    return {
      index_status: "stale",
      refresh_mode: "full",
      stale_reason: "schema_mismatch",
      indexed_head: indexedHead,
      indexed_tree: indexedTree,
      indexed_branch: indexedBranch,
      dirty_files: dirtyFiles,
      changed_files: dirtyFiles,
    };
  }

  const dirtyMatchesMeta = await dirtySnapshotMatches(root, meta, dirtyFiles);
  if (meta.indexed_tree === indexedTree && dirtyMatchesMeta) {
    return {
      index_status: "warm",
      refresh_mode: "reuse",
      stale_reason: null,
      indexed_head: indexedHead,
      indexed_tree: indexedTree,
      indexed_branch: indexedBranch,
      dirty_files: dirtyFiles,
      changed_files: [],
    };
  }

  const diffEntries = meta.indexed_head
    ? await getChangedFilesSince(root, meta.indexed_head)
    : [];
  const changedFiles = [...new Set([
    ...diffEntries.map((entry) => entry?.path).filter(Boolean),
    ...(dirtyMatchesMeta ? [] : dirtyFiles),
  ])].filter(shouldTrackDirtyPath).sort();
  const smallDiff = changedFiles.length > 0 && changedFiles.length < LARGE_DIFF_FILE_LIMIT;

  return {
    index_status: "stale",
    refresh_mode: smallDiff ? "incremental" : "full",
    stale_reason: smallDiff ? "small_diff" : "large_or_unknown_diff",
    indexed_head: indexedHead,
    indexed_tree: indexedTree,
    indexed_branch: indexedBranch,
    dirty_files: dirtyFiles,
    changed_files: changedFiles,
  };
}

export async function writeIndexMeta(root, artifactPaths, snapshot, freshness) {
  const fileFingerprints = await fingerprintPaths(root, snapshot.files.map((fileInfo) => fileInfo.path));
  const payload = {
    schema_version: INDEX_META_SCHEMA_VERSION,
    agentify_index_schema: SCHEMA_VERSIONS.INDEX,
    repo_key: artifactPaths.repoKey || null,
    indexed_head: freshness.indexed_head,
    indexed_tree: freshness.indexed_tree,
    indexed_branch: freshness.indexed_branch,
    indexed_at: new Date().toISOString(),
    dirty_files_snapshot: freshness.dirty_files || [],
    file_fingerprints: fileFingerprints,
  };
  await writeJson(artifactPaths.indexMetaPath, payload);
  return payload;
}
