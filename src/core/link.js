import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDir, exists, readJson, writeJson } from "./fs.js";
import { VERSION } from "./cli-fast-paths.js";
import {
  LINK_KIND,
  LINK_SCHEMA_VERSION,
  STORE_KIND,
  STORE_SCHEMA_VERSION,
  describeLocalArtifacts,
  describeSharedArtifacts,
  ensureProjectStore,
  getGitIdentity,
  readLink,
  resolveAgentifyPaths,
  resolveLocalAgentifyPaths,
} from "./project-store.js";

const execFileAsync = promisify(execFile);
const MIGRATABLE_SHARED_ARTIFACTS = ["index.db", "cache", "semantic", "context"];

async function runGit(targetPath, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetPath, ...args]);
    return stdout.trim();
  } catch {
    throw new Error(`${targetPath} is not inside a git worktree`);
  }
}

async function realpathIfPossible(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function resolveGitWorktree(targetPath) {
  const requestedPath = path.resolve(targetPath);
  const topLevel = path.resolve(await runGit(requestedPath, ["rev-parse", "--show-toplevel"]));
  const rawCommonDir = await runGit(requestedPath, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(topLevel, rawCommonDir);

  return {
    root: topLevel,
    gitCommonDir: await realpathIfPossible(gitCommonDir),
  };
}

function createFromLinkPayload({ canonical, current }) {
  return {
    schema_version: 1,
    kind: LINK_KIND,
    canonical_root: canonical.root,
    project_store: resolveLocalAgentifyPaths(canonical.root).projectStore,
    git_common_dir: current.gitCommonDir,
  };
}

function sameLinkPayload(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createAutoLinkPayload({ identity, projectStore }) {
  return {
    schema_version: LINK_SCHEMA_VERSION,
    kind: LINK_KIND,
    mode: "shared-cache",
    project_store: projectStore,
    git_common_dir: identity.commonDir,
    git_remote: identity.remote || "",
    repo_key: identity.repoKey,
    created_at: new Date().toISOString(),
    created_by_agentify_version: VERSION,
  };
}

function createStoreMetadata({ identity, existing }) {
  const now = new Date().toISOString();
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  return {
    schema_version: STORE_SCHEMA_VERSION,
    kind: STORE_KIND,
    repo_key: identity.repoKey,
    git_common_dir: identity.commonDir,
    git_remote: identity.remote || "",
    created_at: base.created_at || now,
    last_used_at: now,
    created_by_agentify_version: base.created_by_agentify_version || VERSION,
    last_used_by_agentify_version: VERSION,
  };
}

function normalizeMigrationMode(raw) {
  const value = raw === true || raw === undefined || raw === null
    ? "auto"
    : String(raw).trim().toLowerCase();
  if (value === "auto" || value === "local-to-shared" || value === "none") {
    return value;
  }
  throw new Error("--migrate must be one of: auto, local-to-shared, none");
}

async function copyArtifact(source, target) {
  const stat = await fs.stat(source);
  await ensureDir(path.dirname(target));
  if (stat.isDirectory()) {
    await fs.cp(source, target, { recursive: true, force: true });
  } else if (stat.isFile()) {
    await fs.copyFile(source, target);
  }
}

async function planSharedArtifactMigration({ root, projectStore, mode, dryRun }) {
  const localPaths = resolveLocalAgentifyPaths(root);
  const localRoot = localPaths.runtimeRoot;
  const result = {
    mode,
    dry_run: Boolean(dryRun),
    migrated: [],
    skipped: [],
    warnings: [],
  };

  if (mode === "none") {
    result.skipped.push({ reason: "migration_disabled" });
    return result;
  }

  const candidates = [];
  for (const name of MIGRATABLE_SHARED_ARTIFACTS) {
    const source = path.join(localRoot, name);
    const target = path.join(projectStore, name);
    const sourceExists = await exists(source);
    const targetExists = await exists(target);
    candidates.push({ name, source, target, sourceExists, targetExists });
  }

  const sharedHasArtifacts = candidates.some((candidate) => candidate.targetExists);
  const forceLocalToShared = mode === "local-to-shared";

  if (sharedHasArtifacts && !forceLocalToShared) {
    if (candidates.some((candidate) => candidate.sourceExists)) {
      result.warnings.push("Shared store already has reusable artifacts; keeping shared artifacts. Use --migrate=local-to-shared to overwrite them from this worktree.");
    }
    for (const candidate of candidates) {
      if (candidate.sourceExists) {
        result.skipped.push({
          artifact: candidate.name,
          source: candidate.source,
          target: candidate.target,
          reason: candidate.targetExists ? "shared_exists" : "shared_store_not_empty",
        });
      }
    }
    return result;
  }

  for (const candidate of candidates) {
    if (!candidate.sourceExists) {
      continue;
    }
    if (candidate.targetExists && !forceLocalToShared) {
      result.skipped.push({
        artifact: candidate.name,
        source: candidate.source,
        target: candidate.target,
        reason: "shared_exists",
      });
      continue;
    }
    if (!dryRun) {
      await copyArtifact(candidate.source, candidate.target);
    }
    result.migrated.push({
      artifact: candidate.name,
      source: candidate.source,
      target: candidate.target,
      action: dryRun ? "would_copy" : "copied",
    });
  }

  return result;
}

async function linkFromCanonical(root, options) {
  const from = String(options.from || "").trim();
  if (!from || from === "true") {
    throw new Error("agentify link requires --from <canonical-worktree> or --auto");
  }

  const current = await resolveGitWorktree(root);
  const canonical = await resolveGitWorktree(from);
  if (current.gitCommonDir !== canonical.gitCommonDir) {
    throw new Error("Cannot link unrelated repositories: target and canonical worktree do not share the same git common dir");
  }

  const payload = createFromLinkPayload({ canonical, current });
  const linkPath = resolveLocalAgentifyPaths(current.root).linkPath;

  if (!options.dryRun && options.prepareTarget) {
    await options.prepareTarget(current.root);
  }

  if (await exists(linkPath)) {
    const existing = await readJson(linkPath);
    if (sameLinkPayload(existing, payload)) {
      return {
        command: "link",
        mode: "from",
        root: current.root,
        from: canonical.root,
        link_path: linkPath,
        project_store: payload.project_store,
        git_common_dir: payload.git_common_dir,
        linked: true,
        changed: false,
        dry_run: Boolean(options.dryRun),
      };
    }
  }

  if (!options.dryRun) {
    await ensureDir(path.dirname(linkPath));
    await writeJson(linkPath, payload);
  }

  return {
    command: "link",
    mode: "from",
    root: current.root,
    from: canonical.root,
    link_path: linkPath,
    project_store: payload.project_store,
    git_common_dir: payload.git_common_dir,
    linked: true,
    changed: !options.dryRun,
    dry_run: Boolean(options.dryRun),
  };
}

async function linkAuto(root, options) {
  const resolvedRoot = path.resolve(root);
  const identity = await getGitIdentity(resolvedRoot);
  if (!identity) {
    const error = new Error(
      "Cannot create a shared worktree store because this directory is not inside a Git repository. "
      + "Use local mode, or run this command from a Git worktree."
    );
    error.code = "AGENTIFY_LINK_NOT_GIT";
    throw error;
  }

  const paths = await resolveAgentifyPaths(resolvedRoot, options.config || {}, options.env || process.env);
  // resolveAgentifyPaths returns linked=true if a link already exists. For --auto we
  // always recompute from the current git identity so a re-link refreshes metadata
  // and surfaces drift.
  const linkPath = paths.linkPath;
  const projectStore = paths.linked ? paths.projectStore : pickAutoStorePath(identity, options);

  if (paths.linked && paths.linkPayload && Number(paths.linkPayload.schema_version) === LINK_SCHEMA_VERSION) {
    if (paths.linkPayload.git_common_dir && paths.linkPayload.git_common_dir !== identity.commonDir && !options.force) {
      const error = new Error(
        "This worktree is linked to a different Git repository.\n"
        + `  Current Git common dir: ${identity.commonDir}\n`
        + `  Linked Git common dir:  ${paths.linkPayload.git_common_dir}\n`
        + "Refusing to reuse shared Agentify store. Pass --force only if this repository was moved."
      );
      error.code = "AGENTIFY_LINK_REPO_MISMATCH";
      throw error;
    }
  }

  if (!options.dryRun && options.prepareTarget) {
    await options.prepareTarget(resolvedRoot);
  }

  const migration = await planSharedArtifactMigration({
    root: resolvedRoot,
    projectStore,
    mode: normalizeMigrationMode(options.migrate),
    dryRun: options.dryRun,
  });

  const payload = createAutoLinkPayload({ identity, projectStore });
  let changed = true;
  let existingPayload = null;

  if (await exists(linkPath)) {
    try {
      existingPayload = await readJson(linkPath);
      if (
        existingPayload
        && existingPayload.kind === LINK_KIND
        && Number(existingPayload.schema_version) === LINK_SCHEMA_VERSION
        && existingPayload.project_store === payload.project_store
        && existingPayload.git_common_dir === payload.git_common_dir
        && existingPayload.repo_key === payload.repo_key
      ) {
        changed = false;
        // Preserve created_at when refreshing.
        payload.created_at = existingPayload.created_at || payload.created_at;
        payload.created_by_agentify_version = existingPayload.created_by_agentify_version || payload.created_by_agentify_version;
      }
    } catch {
      existingPayload = null;
    }
  }

  if (!options.dryRun) {
    await ensureDir(path.dirname(linkPath));
    await ensureProjectStore({ projectStore, locksRoot: path.join(projectStore, "locks") });

    let existingStore = null;
    const storeMetaPath = path.join(projectStore, "store.json");
    if (await exists(storeMetaPath)) {
      try {
        existingStore = await readJson(storeMetaPath);
      } catch {
        existingStore = null;
      }
    }
    const storeMeta = createStoreMetadata({ identity, existing: existingStore });
    await writeJson(storeMetaPath, storeMeta);
    await writeJson(linkPath, payload);
  }

  return {
    command: "link",
    mode: "auto",
    root: resolvedRoot,
    link_path: linkPath,
    project_store: projectStore,
    git_common_dir: identity.commonDir,
    git_remote: identity.remote || "",
    repo_key: identity.repoKey,
    shared_artifacts: describeSharedArtifacts(),
    local_artifacts: describeLocalArtifacts(),
    migration,
    linked: true,
    changed: changed && !options.dryRun,
    dry_run: Boolean(options.dryRun),
  };
}

function pickAutoStorePath(identity, options) {
  const env = options?.env || process.env;
  const explicit = env.AGENTIFY_SHARED_STORE_PATH
    || options?.config?.runtime?.sharedStorePath
    || null;
  if (explicit) {
    const expanded = explicit.startsWith("~/")
      ? path.join(process.env.HOME || "", explicit.slice(2))
      : explicit;
    return path.join(path.resolve(expanded), identity.repoKey);
  }
  return path.join(process.env.HOME || "", ".cache", "agentify", identity.repoKey);
}

async function linkStatus(root, options) {
  const resolvedRoot = path.resolve(root);
  const paths = await resolveAgentifyPaths(resolvedRoot, options.config || {}, options.env || process.env);
  const link = await readLink(paths.linkPath);

  let store = null;
  if (paths.linked) {
    if (await exists(paths.storeMetaPath)) {
      try {
        store = await readJson(paths.storeMetaPath);
      } catch {
        store = null;
      }
    }
  }

  return {
    command: "link",
    mode: "status",
    root: resolvedRoot,
    runtime_root: paths.runtimeRoot,
    project_store: paths.projectStore,
    link_path: paths.linkPath,
    runtime_mode: paths.mode,
    linked: paths.linked,
    link_present: link.present,
    link_valid: link.present ? Boolean(link.valid) : true,
    link_payload: link.valid ? link.payload : null,
    link_invalid_reason: link.valid ? null : link.reason || null,
    repo_key: paths.repoKey,
    git_common_dir: paths.gitCommonDir,
    git_remote: paths.gitRemote,
    store_meta: store,
    shared_artifacts: describeSharedArtifacts(),
    local_artifacts: describeLocalArtifacts(),
  };
}

export async function linkProject(root, options = {}) {
  if (options.status === true) {
    return linkStatus(root, options);
  }
  if (options.auto === true) {
    return linkAuto(root, options);
  }
  return linkFromCanonical(root, options);
}

export { linkAuto, linkStatus };
