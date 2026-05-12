import fs from "node:fs";
import path from "node:path";

const LOCAL_AGENTIFY_ENTRIES = new Set([
  ".lock",
  "link.json",
  "mempalace",
  "planned",
  "runs",
  "session",
  "work",
]);

const STORE_PATH_KEYS = [
  "shared_project_store",
  "sharedProjectStore",
  "project_store",
  "projectStore",
  "shared_store",
  "sharedStore",
  "agentify_root",
  "agentifyRoot",
];

const WORKTREE_PATH_KEYS = [
  "canonical_worktree",
  "canonicalWorktree",
  "canonical_root",
  "canonicalRoot",
  "source_worktree",
  "sourceWorktree",
];

export function getLocalAgentifyRoot(root) {
  return path.join(root, ".agentify");
}

function resolveLinkTarget(baseDir, candidate) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return null;
  }
  return path.resolve(baseDir, candidate.trim());
}

function readLinkConfig(root) {
  const linkPath = path.join(getLocalAgentifyRoot(root), "link.json");
  if (!fs.existsSync(linkPath)) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(linkPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Agentify link file at ${linkPath}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Agentify link file at ${linkPath}: expected an object`);
  }

  return { linkPath, parsed };
}

export function getSharedAgentifyRoot(root) {
  const link = readLinkConfig(root);
  if (!link) {
    return getLocalAgentifyRoot(root);
  }

  const linkDir = path.dirname(link.linkPath);
  for (const key of STORE_PATH_KEYS) {
    const target = resolveLinkTarget(linkDir, link.parsed[key]);
    if (target) {
      return target;
    }
  }

  for (const key of WORKTREE_PATH_KEYS) {
    const target = resolveLinkTarget(linkDir, link.parsed[key]);
    if (target) {
      return getLocalAgentifyRoot(target);
    }
  }

  throw new Error(`Invalid Agentify link file at ${link.linkPath}: missing shared project store path`);
}

export function resolveLocalAgentifyPath(root, ...segments) {
  return path.join(getLocalAgentifyRoot(root), ...segments);
}

export function resolveSharedAgentifyPath(root, ...segments) {
  return path.join(getSharedAgentifyRoot(root), ...segments);
}

export function resolveAgentifyPath(root, ...segments) {
  const normalizedSegments = segments
    .flatMap((segment) => String(segment).split(/[\\/]+/))
    .filter(Boolean)
    .filter((segment) => segment !== ".agentify");
  if (normalizedSegments.length === 0) {
    return getLocalAgentifyRoot(root);
  }
  const first = normalizedSegments[0] || "";
  const base = LOCAL_AGENTIFY_ENTRIES.has(first)
    ? getLocalAgentifyRoot(root)
    : getSharedAgentifyRoot(root);
  return path.join(base, ...normalizedSegments);
}
