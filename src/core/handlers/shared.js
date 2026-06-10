import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ensureBaselineArtifacts } from "../commands.js";
import { writeDefaultConfig } from "../config.js";
import { linkProject } from "../link.js";
import { detectGitWorktree, readLink, resolveLocalAgentifyPaths } from "../project-store.js";
import { log } from "../ui.js";

const WORKTREE_RUNTIME_COMMANDS = new Set(["up", "scan", "index", "run", "sess", "afk", "check"]);

export async function ensureLinkTargetPolicy(root, config) {
  await writeDefaultConfig(root, config, { dryRun: config.dryRun });
  await ensureBaselineArtifacts(root, config);
}

export function renderAutoLinkSummary(result) {
  log(`Current worktree: ${result.root}`);
  log(`Git common dir:  ${result.git_common_dir}`);
  log(`Project store:   ${result.project_store}`);
  log("");
  log("Shared artifacts:");
  for (const name of result.shared_artifacts || []) {
    log(`  - ${name}`);
  }
  log("Local artifacts:");
  for (const name of result.local_artifacts || []) {
    log(`  - ${name}`);
  }
  if (result.migration) {
    log("");
    if (result.migration.migrated?.length > 0) {
      log("Migrated reusable artifacts:");
      for (const item of result.migration.migrated) {
        log(`  - ${item.artifact}: ${item.source} -> ${item.target}`);
      }
    } else if (result.migration.mode === "none") {
      log("Migration: skipped (--migrate=none)");
    } else {
      log("Migration: no reusable local artifacts copied");
    }
    for (const warning of result.migration.warnings || []) {
      log(`Warning: ${warning}`);
    }
  }
}

export function renderLinkStatus(result) {
  log("Agentify runtime status");
  log("");
  log(`Mode:            ${result.runtime_mode}`);
  log(`Current root:    ${result.root}`);
  log(`Runtime root:    ${result.runtime_root}`);
  log(`Project store:   ${result.project_store}`);
  if (result.git_common_dir) {
    log(`Git common dir:  ${result.git_common_dir}`);
  }
  if (result.repo_key) {
    log(`Repo key:        ${result.repo_key}`);
  }
  log("");
  if (!result.link_present) {
    log("Link file:       (none)");
  } else if (!result.link_valid) {
    log(`Link file:       invalid (${result.link_invalid_reason || "unknown"})`);
  } else {
    log("Link file:       ok");
  }
  if (result.store_meta) {
    log(`Store created:   ${result.store_meta.created_at || "?"}`);
    log(`Store last used: ${result.store_meta.last_used_at || "?"}`);
  }
}

export function shouldUseSharedStoreInit(args, command) {
  return command === "init" && args.sharedStore !== false;
}

export function enableSharedStoreConfig(config) {
  config.runtime = {
    ...(config.runtime || {}),
    store: "shared",
    worktreeAutoLink: true,
  };
}

async function maybeWriteWorktreeHint(root, config) {
  if (config.json || config.dryRun || process.env.AGENTIFY_NO_WORKTREE_HINT === "1") {
    return;
  }

  const markerPath = path.join(root, ".agentify", ".worktree-hint");
  try {
    await fs.access(markerPath);
    return;
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, new Date().toISOString(), "utf8");
  log("Detected Git worktree. To reuse repo maps across worktrees, run:");
  log("  agentify link --auto");
}

export async function maybePrepareWorktreeRuntime(root, config, command) {
  if (!WORKTREE_RUNTIME_COMMANDS.has(command)) {
    return;
  }

  const localPaths = resolveLocalAgentifyPaths(root);
  const link = await readLink(localPaths.linkPath);
  if (link.present) {
    return;
  }

  const worktree = await detectGitWorktree(root);
  if (!worktree.isLinkedWorktree) {
    return;
  }

  if (config.runtime?.worktreeAutoLink === true) {
    const result = await linkProject(root, {
      auto: true,
      migrate: "auto",
      dryRun: config.dryRun,
      config,
      prepareTarget: (targetRoot) => ensureLinkTargetPolicy(targetRoot, config),
    });
    if (!config.json && result.changed) {
      log(`Linked Git worktree to shared Agentify store: ${result.project_store}`);
    }
    return;
  }

  if (String(config.runtime?.store || "local").trim().toLowerCase() === "local") {
    await maybeWriteWorktreeHint(root, config);
  }
}

export function buildCacheStatus(paths, status) {
  return {
    ...status,
    store: paths.mode === "shared" ? "shared" : "local",
    cache_root: paths.cacheRoot,
    runtime_root: paths.runtimeRoot,
    project_store: paths.projectStore,
  };
}

export function cacheCleanTargets(root, agentifyPaths, args) {
  const localPaths = resolveLocalAgentifyPaths(root);
  const wantsLocal = args.local === true;
  const wantsShared = args.shared === true;
  const wantsAll = args.all === true;
  const selectedCount = [wantsLocal, wantsShared, wantsAll].filter(Boolean).length;
  if (selectedCount !== 1) {
    throw new Error("cache clean requires exactly one of --local, --shared, or --all");
  }
  if ((wantsShared || wantsAll) && agentifyPaths.mode !== "shared") {
    throw new Error("cache clean --shared requires a linked or shared Agentify project store");
  }
  if (wantsAll && !args.dryRun && args.yes !== true) {
    throw new Error("cache clean --all requires --yes unless --dry-run is used");
  }

  const targets = [];
  if (wantsLocal || wantsAll) {
    targets.push({ store: "local", cacheRoot: localPaths.cacheRoot, shared: false });
  }
  if (wantsShared || wantsAll) {
    const alreadyIncluded = targets.some((target) => target.cacheRoot === agentifyPaths.cacheRoot);
    if (!alreadyIncluded) {
      targets.push({ store: "shared", cacheRoot: agentifyPaths.cacheRoot, shared: true });
    }
  }
  return targets;
}

export function normalizeOptionalSince(args, commandName) {
  if (!Object.prototype.hasOwnProperty.call(args, "since")) {
    return null;
  }
  const since = String(args.since).trim();
  if (!since || since === "true") {
    throw new Error(`${commandName} --since requires a commit or ref value`);
  }
  return since;
}

function isMissingIndexError(error) {
  return error instanceof Error && /missing index database at /.test(error.message);
}

function isInvalidIndexDatabaseError(error) {
  return error instanceof Error && (
    error.code === "AGENTIFY_INDEX_DATABASE_INVALID"
    || /invalid index database at /.test(error.message)
  );
}

function createMissingIndexGuidance(root) {
  return new Error(
    `Agentify index missing for ${root}. Run "agentify scan --root ${root}" or "agentify up --root ${root}" before using plan/query/context commands.`
  );
}

function createInvalidIndexGuidance(root) {
  return new Error(
    `Agentify index unreadable for ${root}. Run "agentify scan --root ${root}" or "agentify up --root ${root}" to rebuild it before using plan/query/context commands.`
  );
}

export function throwWithIndexGuidance(error, root) {
  if (isMissingIndexError(error)) {
    throw createMissingIndexGuidance(root);
  }
  if (isInvalidIndexDatabaseError(error)) {
    throw createInvalidIndexGuidance(root);
  }
  throw error;
}

export function getSearchTerm(args, commandName) {
  const term = args.term === undefined ? args._[2] : args.term;
  if (!term || term === true) {
    throw new Error(`${commandName} search requires --term <value> or a positional search term`);
  }
  return String(term);
}
