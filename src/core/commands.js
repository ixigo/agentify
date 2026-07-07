import path from "node:path";

import { ensureDir, ensurePrivateDir, exists, writeText } from "./fs.js";
import { getHeadCommit } from "./git.js";
import { ensureAgentifyGitignore } from "./gitignore.js";
import { getIndexFreshness, writeIndexMeta } from "./index-freshness.js";
import { ensureProjectStore, resolveAgentifyPaths } from "./project-store.js";
import { createRunReporter } from "./run-report.js";
import { validateRepo } from "./validate.js";
import { acquireLock, acquireProjectStoreLock } from "./lock.js";
import { closeIndexDatabase, inTransaction, openIndexDatabase } from "./db/connection.js";
import { getRepoMeta } from "./db/metadata-store.js";
import { loadModules, writeRepositoryIndex } from "./db/structural-store.js";
import { buildRepositoryIndex } from "./indexer.js";
import * as ui from "./ui.js";

function renderRepoMap(index) {
  return `# Repo Map

## Stacks
${index.repo.detected_stacks.map((stack) => `- \`${stack.name}\` (${stack.confidence})`).join("\n")}

## Entrypoints
${index.entrypoints.length > 0 ? index.entrypoints.map((entry) => `- \`${entry}\``).join("\n") : "- No entrypoints detected."}

## Modules
${index.modules.map((moduleInfo) => `- \`${moduleInfo.name}\` (\`${moduleInfo.root_path}\`)`).join("\n")}
`;
}

function renderDefaultAgentignore() {
  return `# Keep local Agentify work artifacts out of repo scans
.agentify/work/**
`;
}

function renderDefaultGuardrails() {
  return `# Agentify Guardrails

## Git Safety
- Do not run \`git reset --hard\`, \`git checkout -- <path>\`, \`git clean -fd\`, or other destructive history or workspace resets unless the user explicitly asks.
- Do not force-push, rewrite unrelated history, or delete branches unless the user explicitly asks.

## Commit Quality
- Use clear commit messages that describe the change.
- Do not create placeholder commits like \`wip\`, \`fix\`, or \`misc\` unless the user explicitly asks.
- Do not commit knowingly broken code just to checkpoint progress.

## Protected Paths
- Do not edit \`.agentify/\` or \`docs/repo-map.md\` directly; regenerate them through Agentify commands.
- Do not edit provider-installed skill directories under \`.codex/\`, \`.claude/\`, \`.gemini/\`, or \`.opencode/\` unless the task is specifically about those files.
- Put local architecture RFCs, notes, and scratch outputs under \`.agentify/work/\`.

## Files To Avoid Touching Without Intent
- \`node_modules/\`
- lockfiles unless the task changes dependencies
- repo config such as \`.agentify.yaml\`, \`.gitignore\`, \`.agentignore\`, and \`.guardrails\` unless the task is about repo policy or tooling
`;
}

async function writeTextIfMissing(targetPath, text) {
  if (await exists(targetPath)) {
    return false;
  }
  await writeText(targetPath, text);
  return true;
}

export async function ensureBaselineArtifacts(root, config, options = {}) {
  if (config.dryRun) {
    return;
  }
  const agentifyPaths = options.paths || await resolveArtifactPaths(root, config, { artifactRoot: root });
  await ensureDir(agentifyPaths.runtimeRoot);
  await ensurePrivateDir(agentifyPaths.runsRoot);
  await ensureDir(agentifyPaths.workRoot);
  if (agentifyPaths.mode === "shared") {
    await ensureProjectStore(agentifyPaths);
  }
  await writeTextIfMissing(path.join(root, ".agentignore"), renderDefaultAgentignore());
  await writeTextIfMissing(path.join(root, ".guardrails"), renderDefaultGuardrails());
  await ensureAgentifyGitignore(root);
}

function resolveArtifactRoot(root, config, runId) {
  if (config.ghost || config.ghostMode) {
    return path.join(root, ".current_session", runId || `ghost_${Date.now()}`);
  }
  return root;
}

async function resolveArtifactPaths(root, config, { artifactRoot = root } = {}) {
  if (artifactRoot !== root) {
    return resolveAgentifyPaths(artifactRoot, config, {
      ...process.env,
      AGENTIFY_RUNTIME_STORE: "local",
      AGENTIFY_DISABLE_LINK: "1",
    });
  }
  if (config._agentifyPaths?.root === path.resolve(root)) {
    return config._agentifyPaths;
  }
  return resolveAgentifyPaths(root, config);
}

function buildRenderableIndex(root, meta, modules) {
  return {
    schema_version: "2.0",
    repo: {
      name: meta.repo_name || path.basename(root),
      root,
      detected_stacks: meta.detected_stacks || [],
      default_stack: meta.default_stack || "ts"
    },
    index: {
      generated_at: meta.generated_at || null,
      head_commit: meta.head_commit || "unknown",
      generator: {
        agentify_version: "0.3.0",
        provider: meta.provider || "local"
      }
    },
    modules: modules.map((moduleInfo) => ({
      id: moduleInfo.id,
      name: moduleInfo.name,
      root_path: moduleInfo.root_path,
      doc_path: moduleInfo.doc_path,
      metadata_path: null,
      tags: [moduleInfo.stack],
      fingerprint: moduleInfo.fingerprint,
      entry_files: moduleInfo.entry_files,
      key_files: moduleInfo.key_files
    })),
    entrypoints: modules.flatMap((moduleInfo) => moduleInfo.entry_files || []),
    symbol_index_hint: {
      enabled: true,
      note: "symbol spans are stored in .agentify/index.db"
    }
  };
}

export async function runScan(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.log("scan: starting deterministic repository scan");

  const ghostRunId = (config.ghost || config.ghostMode)
    ? (options.ghostRunId || `ghost_${Date.now()}`)
    : null;
  const artifactRoot = resolveArtifactRoot(root, config, ghostRunId);
  const artifactPaths = await resolveArtifactPaths(root, config, { artifactRoot });
  const legacyLock = await acquireLock(root, "scan");
  if (!legacyLock.acquired) {
    return emitLockContention("scan", legacyLock, progress, config, options);
  }

  const lock = await acquireProjectStoreLock(artifactPaths, "index-refresh");
  if (!lock.acquired) {
    await legacyLock.release();
    return emitLockContention("scan", lock, progress, config, options);
  }

  try {
    return await _runScanInner(root, config, options, progress, { artifactRoot, artifactPaths });
  } finally {
    await lock.release();
    await legacyLock.release();
  }
}

async function emitLockContention(phase, lock, progress, config, options) {
  const commandName = options.commandName || phase;
  const result = {
    command: commandName,
    status: "blocked",
    reason: "lock_contention",
    phase,
    holder: lock.holder || null,
    message: lock.message,
    wrote: [],
  };
  progress.log(`${phase}: ${lock.message}`);
  if (!options.skipOutput) {
    progress.setCommand(commandName);
  }
  if (phase === "scan") {
    progress.setScan(result);
  }
  if (!options.skipOutput && (config.json || !config._suppressProgress)) {
    progress.json(result);
  }
  if (!options.skipFinalize) {
    await progress.finalize();
  }
  process.exitCode = 1;
  return result;
}

async function _runScanInner(root, config, options, progress, resolvedArtifacts = {}) {
  const artifactRoot = resolvedArtifacts.artifactRoot || resolveArtifactRoot(root, config, options.ghostRunId || null);
  const artifactPaths = resolvedArtifacts.artifactPaths || await resolveArtifactPaths(root, config, { artifactRoot });
  await ensureBaselineArtifacts(artifactRoot, config, { paths: artifactPaths });
  const headCommit = await getHeadCommit(root);
  const freshness = !config.dryRun ? await getIndexFreshness(root, artifactPaths) : null;
  if (!config.dryRun && freshness?.index_status === "warm") {
    try {
      const db = openIndexDatabase(artifactPaths, { readOnly: true });
      try {
        getRepoMeta(db);
        const result = {
          command: options.commandName || "scan",
          status: "reused",
          index_status: "warm",
          refresh_mode: "reuse",
          reused_index: true,
          index_path: artifactPaths.indexDb,
          wrote: [],
        };
        progress.log("scan: reused warm index");
        progress.setCommand(options.commandName || "scan");
        progress.setScan(result);
        if (!options.skipOutput && (config.json || !config._suppressProgress)) {
          progress.json(result);
        }
        if (!options.skipFinalize) {
          await progress.finalize();
        }
        return result;
      } finally {
        closeIndexDatabase(db);
      }
    } catch {
      // Fall through and rebuild an unreadable or stale shared index.
    }
  }
  if (!config.dryRun && freshness?.refresh_mode === "incremental") {
    progress.log(`scan: refreshing changed index inputs (${freshness.changed_files.length} file(s))`);
  }
  const snapshot = options.scanSnapshot || await buildRepositoryIndex(root, config);
  progress.log(`scan: analyzed ${snapshot.files.length} files and detected ${snapshot.modules.length} modules`);

  if (!config.dryRun) {
    const db = openIndexDatabase(artifactPaths);
    try {
      inTransaction(db, () => {
        writeRepositoryIndex(db, snapshot, {
          headCommit,
          provider: config.provider,
        });
      });
      const index = buildRenderableIndex(root, getRepoMeta(db), loadModules(db));
      await writeText(path.join(artifactRoot, "docs", "repo-map.md"), renderRepoMap(index));
    } finally {
      closeIndexDatabase(db);
    }
    await writeIndexMeta(root, artifactPaths, snapshot, freshness || await getIndexFreshness(root, artifactPaths));
  }
  progress.log("scan: wrote SQLite index and repo guidance");

  const result = {
    command: options.commandName || "scan",
    index_status: freshness?.refresh_mode === "incremental" ? "incremental" : "rebuilt",
    refresh_mode: freshness?.refresh_mode || "full",
    changed_files: freshness?.changed_files || [],
    detected_stacks: snapshot.repo.detected_stacks,
    default_stack: snapshot.repo.default_stack,
    modules: snapshot.modules.map((moduleInfo) => ({ id: moduleInfo.id, root_path: moduleInfo.root_path })),
    wrote: config.dryRun ? [] : [".agentify/index.db", ".agentify/index.meta.json", "docs/repo-map.md"],
  };
  progress.setCommand(options.commandName || "scan");
  progress.setScan(result);
  if (!options.skipOutput && (config.json || !config._suppressProgress)) {
    progress.json(result);
  }
  if (!options.skipFinalize) {
    await progress.finalize();
  }
  return result;
}

export async function runValidate(root, config, options = {}) {
  const progress = options.reporter || createRunReporter(root);
  progress.percent("check", 0, "starting");
  const result = await validateRepo(root, config, options);
  progress.percent("check", 100, result.passed ? "passed" : `failed with ${result.failures.length} issue(s)`);
  progress.setCommand("check");
  progress.setValidation(result);
  if (config.json || !config._suppressProgress) {
    progress.json(result);
  }

  if (result.passed) {
    ui.success("Validation passed");
  } else {
    ui.newline();
    for (const failure of result.failures) {
      process.stderr.write(ui.formatFailure(failure) + "\n");
    }
    ui.newline();
  }

  if (!options.skipFinalize) {
    await progress.finalize();
  }
  if (!result.passed) {
    if (config.strict) {
      process.exitCode = 1;
    } else {
      ui.warn("Validation warnings found but --strict is false, continuing");
    }
  }
}

async function emitBlockedUpdate(commandName, phase, phaseResult, progress) {
  const blocked = {
    command: commandName,
    status: "blocked",
    reason: "lock_contention",
    blocked_phase: phase,
    holder: phaseResult.holder || null,
    message: phaseResult.message,
  };
  progress.log(`${commandName}: blocked at ${phase} phase — ${phaseResult.message}`);
  progress.json(blocked);
  await progress.finalize();
  process.exitCode = 1;
  return blocked;
}

export async function runUpdate(root, config, options = {}) {
  const commandName = options.commandName || "up";
  const ghostRunId = (config.ghost || config.ghostMode) ? `ghost_${Date.now()}` : null;
  const artifactRoot = resolveArtifactRoot(root, config, ghostRunId);
  const artifactPaths = await resolveArtifactPaths(root, config, { artifactRoot });
  const progress = createRunReporter(artifactRoot);
  const scanSnapshot = config.dryRun ? await buildRepositoryIndex(root, config) : null;
  progress.setCommand(commandName);
  progress.percent(commandName, 0, "starting");
  const scanResult = await runScan(root, config, { reporter: progress, skipFinalize: true, skipOutput: true, ghostRunId, scanSnapshot });
  if (scanResult?.status === "blocked") {
    return emitBlockedUpdate(commandName, "scan", scanResult, progress);
  }
  progress.percent(commandName, 50, "scan complete");
  const result = await validateRepo(root, config, {
    artifactRoot,
    artifactPaths,
    skipFreshness: config.dryRun,
    skipCodeBodyChanges: options.skipCodeBodyChanges === true,
  });
  progress.setValidation(result);
  progress.percent(commandName, 100, result.passed ? "validation passed" : `validation failed with ${result.failures.length} issue(s)`);
  const finalOutput = {
    command: commandName,
    index_status: scanResult?.index_status || (scanResult?.reused_index ? "warm" : "rebuilt"),
    scan: scanResult || null,
    validation: result,
  };
  progress.json(finalOutput);
  await progress.finalize();
  if (!result.passed) {
    if (config.strict) {
      process.exitCode = 1;
    } else {
      progress.log(`${commandName}: validation warnings found but --strict is false, continuing`);
    }
  }
  return finalOutput;
}
