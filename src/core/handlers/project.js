import { ensureBaselineArtifacts, runDoc, runScan, runUpdate, runValidate } from "../commands.js";
import { writeDefaultConfig } from "../config.js";
import { linkProject } from "../link.js";
import { detectGitWorktree, resolveAgentifyPaths } from "../project-store.js";
import { runRepoSync } from "../repo-sync.js";
import { buildSkillInstallHint } from "../skills.js";
import { success, log } from "../ui.js";
import {
  ensureLinkTargetPolicy,
  renderAutoLinkSummary,
  renderLinkStatus,
  shouldUseSharedStoreInit,
} from "./shared.js";

export async function handleInit({ root, config, args, command }) {
  await writeDefaultConfig(root, config, { dryRun: config.dryRun });
  await ensureBaselineArtifacts(root, config);
  let sharedStoreLink = null;
  if (shouldUseSharedStoreInit(args, command)) {
    const worktree = await detectGitWorktree(root);
    if (worktree.isGitRepo) {
      sharedStoreLink = await linkProject(root, {
        auto: true,
        migrate: args.migrate,
        dryRun: config.dryRun,
        config,
        prepareTarget: (targetRoot) => ensureLinkTargetPolicy(targetRoot, config),
      });
      config._agentifyPaths = await resolveAgentifyPaths(root, config);
    }
  }
  const skillInstallHint = buildSkillInstallHint(config.provider, "project");
  if (config.json) {
    console.log(JSON.stringify({
      command: "init",
      root,
      dry_run: Boolean(config.dryRun),
      wrote: config.dryRun ? [] : [".agentify.yaml", ".gitignore", ".agentignore", ".guardrails", `.agentify`, ".agentify/runs", ".agentify/work", "docs/modules"],
      shared_store: sharedStoreLink ? {
        link_path: sharedStoreLink.link_path,
        project_store: sharedStoreLink.project_store,
        changed: sharedStoreLink.changed,
      } : null,
      skill_install_hint: skillInstallHint,
    }, null, 2));
  } else {
    success("Initialized agentify artifacts");
    if (sharedStoreLink) {
      log(`Shared store: ${sharedStoreLink.project_store}`);
    }
    log(skillInstallHint.message);
  }
}

export async function handleLink({ root, config, args }) {
  const result = await linkProject(root, {
    from: args.from,
    auto: args.auto === true,
    status: args.status === true,
    force: args.force === true,
    migrate: args.migrate,
    dryRun: config.dryRun,
    config,
    prepareTarget: (targetRoot) => ensureLinkTargetPolicy(targetRoot, config),
  });
  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.mode === "status") {
    renderLinkStatus(result);
  } else if (result.mode === "auto") {
    if (result.changed) {
      success("Linked Agentify shared project store");
    } else {
      success("Agentify shared project store link already up to date");
    }
    renderAutoLinkSummary(result);
  } else if (result.changed) {
    success("Linked Agentify project store");
    log(`Shared store: ${result.project_store}`);
  } else {
    success("Agentify project link already up to date");
    log(`Shared store: ${result.project_store}`);
  }
}

export async function handleWorktree({ root, config, args, subcommand }) {
  const sub = String(subcommand || "").toLowerCase();
  if (sub === "attach") {
    const result = await linkProject(root, {
      auto: true,
      force: args.force === true,
      migrate: args.migrate,
      dryRun: config.dryRun,
      config,
      prepareTarget: (targetRoot) => ensureLinkTargetPolicy(targetRoot, config),
    });
    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.changed) {
      success("Linked Agentify shared project store");
      renderAutoLinkSummary(result);
    } else {
      success("Agentify shared project store link already up to date");
      renderAutoLinkSummary(result);
    }
    return;
  }
  if (sub === "status" || sub === "") {
    const result = await linkProject(root, { status: true, config });
    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      renderLinkStatus(result);
    }
    return;
  }
  throw new Error(`Unknown worktree subcommand: ${subcommand}. Try \`agentify worktree attach\` or \`agentify worktree status\`.`);
}

export async function handleIndex({ root, config }) {
  await runScan(root, config, { commandName: "index" });
}

export async function handleScan({ root, config }) {
  await runScan(root, config, { commandName: "scan" });
}

export async function handleDoc({ root, config }) {
  await runDoc(root, config);
}

export async function handleUp({ root, config, args }) {
  await runUpdate(root, config, { skipCodeBodyChanges: args.hook === true });
}

export async function handleSync({ root, config, args }) {
  await runRepoSync(root, config, { provider: args.provider });
}

export async function handleCheck({ root, config, args }) {
  await runValidate(root, config, { skipCodeBodyChanges: args.hook === true });
}
