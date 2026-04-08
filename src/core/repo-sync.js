import path from "node:path";

import { ensureBaselineArtifacts, runUpdate } from "./commands.js";
import { syncConfigFile } from "./config.js";
import { exists } from "./fs.js";
import { syncManagedHooks } from "./hooks.js";
import { syncProjectBuiltinSkills } from "./skills.js";
import * as ui from "./ui.js";

const BASELINE_ARTIFACTS = [
  ".agents",
  ".agents/runs",
  ".agentify/work",
  "docs/modules",
  ".agentignore",
  ".guardrails",
];

async function syncBaselineArtifacts(root, config) {
  const before = new Map();
  for (const relativePath of BASELINE_ARTIFACTS) {
    before.set(relativePath, await exists(path.join(root, relativePath)));
  }

  await ensureBaselineArtifacts(root, config);

  return BASELINE_ARTIFACTS.map((relativePath) => {
    const existed = before.get(relativePath);
    return {
      path: path.join(root, relativePath),
      existed,
      status: existed ? "unchanged" : config.dryRun ? "would_create" : "created",
    };
  });
}

function logSyncSummary(result) {
  ui.log(`Config sync: ${result.config.status}`);
  const createdBaseline = result.baseline.filter((item) => item.status === "created" || item.status === "would_create");
  if (createdBaseline.length > 0) {
    ui.log(`Baseline artifacts: ${createdBaseline.length} path(s) ${result.dry_run ? "would be created" : "created"}.`);
  } else {
    ui.log("Baseline artifacts: unchanged.");
  }
  ui.log(`Hook sync: ${result.hooks.status}`);
  if (result.skills.providers.length > 0) {
    ui.log(`Project skills synced for: ${result.skills.providers.join(", ")}`);
  } else {
    ui.log("Project skills: no repo-scoped provider roots detected.");
  }
}

export async function runRepoSync(root, config, options = {}) {
  const skillProviderSelection =
    typeof options.provider === "string" && options.provider.trim().toLowerCase() === "local"
      ? undefined
      : options.provider;
  const maintenanceConfig = {
    ...config,
    provider: "local",
  };
  const repoSync = {
    command: "repo-sync",
    root,
    dry_run: Boolean(config.dryRun),
    maintenance_provider: maintenanceConfig.provider,
    config: await syncConfigFile(root, config, { dryRun: config.dryRun }),
    baseline: await syncBaselineArtifacts(root, config),
    hooks: await syncManagedHooks(root, { dryRun: config.dryRun }),
    skills: await syncProjectBuiltinSkills(root, {
      provider: skillProviderSelection,
      dryRun: config.dryRun,
      defaultProvider: config.provider,
    }),
  };

  if (!config.json) {
    logSyncSummary(repoSync);
  }

  return runUpdate(root, maintenanceConfig, {
    commandName: "sync",
    preflight: repoSync,
  });
}
