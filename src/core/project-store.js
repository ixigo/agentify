import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDir, exists, readJson } from "./fs.js";

const execFileAsync = promisify(execFile);

export const LINK_SCHEMA_VERSION = 2;
export const STORE_SCHEMA_VERSION = 1;
export const INDEX_META_SCHEMA_VERSION = 1;
export const LINK_KIND = "agentify-linked-project";
export const STORE_KIND = "agentify-project-store";

const SHARED_ARTIFACT_NAMES = ["index.db", "cache", "semantic", "context", "repo-map", "embeddings"];
const LOCAL_ARTIFACT_NAMES = ["runs", "session", "work", "tmp"];

function defaultSharedStoreBase() {
  return path.join(os.homedir(), ".cache", "agentify");
}

function expandTilde(targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    return targetPath;
  }
  if (targetPath === "~") {
    return os.homedir();
  }
  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

async function realpathIfPossible(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function runGit(targetPath, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetPath, ...args]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export function computeRepoKey({ remote, commonDir }) {
  const seed = `${remote || ""}\n${commonDir || ""}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

export async function getGitIdentity(root) {
  const topLevel = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return null;
  }
  const rawCommonDir = await runGit(root, ["rev-parse", "--git-common-dir"]);
  if (!rawCommonDir) {
    return null;
  }
  const commonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(topLevel, rawCommonDir);
  const remote = await runGit(root, ["remote", "get-url", "origin"]);

  return {
    topLevel: path.resolve(topLevel),
    commonDir: await realpathIfPossible(commonDir),
    remote: remote || "",
    repoKey: computeRepoKey({ remote: remote || "", commonDir }),
  };
}

export async function detectGitWorktree(root) {
  const topLevel = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return {
      isGitRepo: false,
      isLinkedWorktree: false,
      topLevel: null,
      gitDir: null,
      commonDir: null,
    };
  }

  const rawGitDir = await runGit(root, ["rev-parse", "--git-dir"]);
  const rawCommonDir = await runGit(root, ["rev-parse", "--git-common-dir"]);
  if (!rawGitDir || !rawCommonDir) {
    return {
      isGitRepo: true,
      isLinkedWorktree: false,
      topLevel: path.resolve(topLevel),
      gitDir: null,
      commonDir: null,
    };
  }

  const resolvedTopLevel = path.resolve(topLevel);
  const gitDir = path.isAbsolute(rawGitDir)
    ? rawGitDir
    : path.resolve(resolvedTopLevel, rawGitDir);
  const commonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(resolvedTopLevel, rawCommonDir);
  const realGitDir = await realpathIfPossible(gitDir);
  const realCommonDir = await realpathIfPossible(commonDir);

  return {
    isGitRepo: true,
    isLinkedWorktree: realGitDir !== realCommonDir,
    topLevel: resolvedTopLevel,
    gitDir: realGitDir,
    commonDir: realCommonDir,
  };
}

function isValidLinkPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if (payload.kind !== LINK_KIND) {
    return false;
  }
  const schema = Number(payload.schema_version);
  return Number.isFinite(schema) && schema >= 1 && schema <= LINK_SCHEMA_VERSION;
}

function resolveModeFromInputs(config, env) {
  const fromEnv = env?.AGENTIFY_RUNTIME_STORE;
  if (fromEnv && typeof fromEnv === "string") {
    const lowered = fromEnv.trim().toLowerCase();
    if (lowered === "local" || lowered === "shared" || lowered === "auto") {
      return lowered;
    }
  }
  const fromConfig = config?.runtime?.store;
  if (fromConfig && typeof fromConfig === "string") {
    const lowered = fromConfig.trim().toLowerCase();
    if (lowered === "local" || lowered === "shared" || lowered === "auto") {
      return lowered;
    }
  }
  return "local";
}

function resolveSharedBase(config, env) {
  const fromEnv = env?.AGENTIFY_SHARED_STORE_PATH;
  if (fromEnv && typeof fromEnv === "string" && fromEnv.trim()) {
    return path.resolve(expandTilde(fromEnv.trim()));
  }
  const fromConfig = config?.runtime?.sharedStorePath;
  if (fromConfig && typeof fromConfig === "string" && fromConfig.trim()) {
    return path.resolve(expandTilde(fromConfig.trim()));
  }
  return defaultSharedStoreBase();
}

function paths({ runtimeRoot, projectStore }) {
  return {
    indexDb: path.join(projectStore, "index.db"),
    legacyIndexJson: path.join(projectStore, "index.json"),
    cacheRoot: path.join(projectStore, "cache"),
    semanticRoot: path.join(projectStore, "semantic"),
    contextRoot: path.join(projectStore, "context"),
    repoMapRoot: path.join(projectStore, "repo-map"),
    embeddingsRoot: path.join(projectStore, "embeddings"),
    modulesRoot: path.join(projectStore, "modules"),

    runsRoot: path.join(runtimeRoot, "runs"),
    sessionRoot: path.join(runtimeRoot, "session"),
    workRoot: path.join(runtimeRoot, "work"),
    tmpRoot: path.join(runtimeRoot, "tmp"),
    plannedRoot: path.join(runtimeRoot, "planned"),
    mempalaceRoot: path.join(runtimeRoot, "mempalace"),
    lockPath: path.join(runtimeRoot, ".lock"),

    storeMetaPath: path.join(projectStore, "store.json"),
    indexMetaPath: path.join(projectStore, "index.meta.json"),
    locksRoot: path.join(projectStore, "locks"),
  };
}

export function resolveLocalAgentifyPaths(root) {
  const resolvedRoot = path.resolve(root);
  const runtimeRoot = path.join(resolvedRoot, ".agentify");
  return {
    root: resolvedRoot,
    runtimeRoot,
    projectStore: runtimeRoot,
    mode: "local",
    linked: false,
    linkPath: path.join(runtimeRoot, "link.json"),
    ...paths({ runtimeRoot, projectStore: runtimeRoot }),
    sharedArtifactNames: SHARED_ARTIFACT_NAMES,
    localArtifactNames: LOCAL_ARTIFACT_NAMES,
  };
}

export async function readLink(linkPath) {
  if (!(await exists(linkPath))) {
    return { present: false };
  }
  try {
    const payload = await readJson(linkPath);
    if (!isValidLinkPayload(payload)) {
      return { present: true, valid: false, payload, reason: "schema_unrecognized" };
    }
    return { present: true, valid: true, payload };
  } catch (error) {
    return { present: true, valid: false, reason: "unreadable", error };
  }
}

export async function resolveAgentifyPaths(root, config = {}, env = process.env) {
  const resolvedRoot = path.resolve(root);
  const runtimeRoot = path.join(resolvedRoot, ".agentify");
  const linkPath = path.join(runtimeRoot, "link.json");

  let mode = "local";
  let linked = false;
  let identity = null;
  let projectStore = runtimeRoot;
  let linkPayload = null;
  let linkInvalid = null;

  const linkDisabled = env?.AGENTIFY_DISABLE_LINK === "1" || env?.AGENTIFY_DISABLE_LINK === "true";

  if (!linkDisabled) {
    const link = await readLink(linkPath);
    if (link.present && link.valid) {
      linkPayload = link.payload;
      linked = true;
      const schema = Number(link.payload.schema_version);
      if (schema >= 2) {
        projectStore = path.resolve(link.payload.project_store);
        mode = "shared";
        identity = {
          repoKey: link.payload.repo_key || null,
          commonDir: link.payload.git_common_dir || null,
          remote: link.payload.git_remote || "",
          topLevel: null,
        };
      } else {
        projectStore = path.resolve(link.payload.project_store || link.payload.canonical_root || runtimeRoot);
        mode = "shared";
        identity = {
          repoKey: null,
          commonDir: link.payload.git_common_dir || null,
          remote: "",
          topLevel: link.payload.canonical_root || null,
        };
      }
    } else if (link.present && !link.valid) {
      linkInvalid = link;
    }
  }

  if (!linked) {
    const configuredMode = resolveModeFromInputs(config, env);
    if (configuredMode === "shared" || configuredMode === "auto") {
      const gitIdentity = await getGitIdentity(resolvedRoot);
      if (gitIdentity) {
        identity = gitIdentity;
        const base = resolveSharedBase(config, env);
        projectStore = path.join(base, gitIdentity.repoKey);
        mode = "shared";
      } else if (configuredMode === "shared") {
        // shared was explicitly requested but we are not in a git repo —
        // fall through to local mode so callers do not break.
        mode = "local";
      }
    }
  }

  return {
    root: resolvedRoot,
    runtimeRoot,
    projectStore,
    mode,
    linked,
    linkInvalid,
    linkPayload,
    repoKey: identity?.repoKey || null,
    gitCommonDir: identity?.commonDir || null,
    gitTopLevel: identity?.topLevel || null,
    gitRemote: identity?.remote || "",
    linkPath,
    ...paths({ runtimeRoot, projectStore }),
    sharedArtifactNames: SHARED_ARTIFACT_NAMES,
    localArtifactNames: LOCAL_ARTIFACT_NAMES,
  };
}

export async function ensureProjectStore(paths) {
  await ensureDir(paths.projectStore);
  await ensureDir(paths.locksRoot);
}

export function describeSharedArtifacts() {
  return [...SHARED_ARTIFACT_NAMES];
}

export function describeLocalArtifacts() {
  return [...LOCAL_ARTIFACT_NAMES];
}
