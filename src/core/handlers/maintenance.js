import { runClean } from "../cleanup.js";
import { acquireProjectStoreLock } from "../lock.js";
import { runSemanticRefresh } from "../semantic.js";
import { runDoctor } from "../toolchain.js";
import { cleanCache, garbageCollect, cacheStatus, hasSharedStoreLocks } from "../cache.js";
import { bold, dim, success, log } from "../ui.js";
import { buildCacheStatus, cacheCleanTargets } from "./shared.js";

async function handleCacheGc({ config, args }) {
  const cacheRoot = config._agentifyPaths.cacheRoot;
  const maxAge = args.maxAge || config.cache?.maxAgeDays || 7;
  const lock = await acquireProjectStoreLock(config._agentifyPaths, "cache-gc");
  if (!lock.acquired) {
    throw new Error(lock.message || "Cache garbage collection lock is already held");
  }
  let result;
  try {
    result = await garbageCollect(cacheRoot, maxAge);
  } finally {
    await lock.release();
  }
  success(`Garbage collected ${result.removed} blob(s).`);
}

async function handleCacheStatus({ config }) {
  const status = buildCacheStatus(config._agentifyPaths, await cacheStatus(config._agentifyPaths.cacheRoot));
  if (config.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    log(`Store: ${bold(status.store)}  Path: ${dim(status.cache_root)}`);
    log(`Blobs: ${bold(String(status.blobs))}  Size: ${bold(status.totalSize || "0 B")}`);
  }
}

async function handleCacheClean({ root, config, args }) {
  const targets = cacheCleanTargets(root, config._agentifyPaths, args);
  const touchesShared = targets.some((target) => target.shared);
  if (touchesShared && !config.dryRun && await hasSharedStoreLocks(config._agentifyPaths.locksRoot)) {
    throw new Error(`Refusing to clean shared cache while shared store locks are present: ${config._agentifyPaths.locksRoot}`);
  }

  const cleaned = [];
  for (const target of targets) {
    cleaned.push({
      store: target.store,
      cache_root: target.cacheRoot,
      ...(await cleanCache(target.cacheRoot, { dryRun: config.dryRun })),
    });
  }
  const result = {
    command: "cache clean",
    dry_run: Boolean(config.dryRun),
    cleaned,
  };
  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of cleaned) {
      const verb = config.dryRun ? "would remove" : "removed";
      log(`Cache clean ${item.store}: ${verb} ${item.removed} item(s) from ${dim(item.cache_root)}`);
      for (const removedPath of item.removed_paths) {
        log(`  - ${removedPath}`);
      }
    }
  }
}

const CACHE_SUBCOMMANDS = {
  gc: handleCacheGc,
  status: handleCacheStatus,
  clean: handleCacheClean,
};

export async function handleDoctor({ root, config, args }) {
  await runDoctor(root, config, { semantic: args.semantic === true, failOnStale: args.failOnStale === true });
}

export async function handleSemantic({ root, config, subcommand }) {
  if (subcommand && subcommand !== "refresh") {
    throw new Error("semantic requires the refresh subcommand: agentify semantic refresh");
  }
  await runSemanticRefresh(root, config);
}

export async function handleClean({ root, config, args }) {
  const result = await runClean(root, config, {
    planned: args.planned === true,
    sessions: args.sessions === true,
    all: args.all === true,
  });
  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (config.dryRun) {
      log(`Cleanup dry-run: ${result.removed_count} item(s) would be pruned.`);
    } else {
      success(`Cleanup removed ${result.removed_count} item(s).`);
    }
    if (result.removed_paths.length > 0) {
      for (const item of result.removed_paths) {
        log(item);
      }
    }
    if (result.removed_cache_blobs > 0) {
      log(`Cache blobs removed: ${result.removed_cache_blobs}`);
    }
    if (result.skipped.length > 0) {
      for (const item of result.skipped) {
        log(`Skipped ${item}`);
      }
    }
  }
}

export async function handleCache({ root, config, args, subcommand }) {
  const handler = CACHE_SUBCOMMANDS[subcommand];
  if (!handler) {
    throw new Error("cache requires a subcommand: gc, status, or clean");
  }
  await handler({ root, config, args });
}
