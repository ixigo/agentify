import path from "node:path";

import { installHooks, removeHooks, statusHooks } from "../hooks.js";
import { installAllBuiltinSkills, installBuiltinSkill, listBuiltinSkills } from "../skills.js";
import { bold, dim, green, success, log } from "../ui.js";

async function handleHooksInstall({ root, config }) {
  const { installed, removed } = await installHooks(root, config.hooks);
  if (installed.length > 0) {
    success(`Installed hooks: ${installed.join(", ")}`);
  }
  if (removed.length > 0) {
    success(`Removed disabled hooks: ${removed.join(", ")}`);
  }
  if (installed.length === 0 && removed.length === 0) {
    log("Enabled hooks already installed.");
  }
}

async function handleHooksRemove({ root }) {
  const removed = await removeHooks(root);
  if (removed.length > 0) {
    success(`Removed hooks: ${removed.join(", ")}`);
  } else {
    log("No Agentify hooks found.");
  }
}

async function handleHooksStatus({ root, config }) {
  const status = await statusHooks(root);
  if (config.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    for (const [hook, installed] of Object.entries(status)) {
      const st = installed ? green("installed") : dim("not installed");
      log(`${bold(hook)}: ${st}`);
    }
  }
}

const HOOK_SUBCOMMANDS = {
  install: handleHooksInstall,
  remove: handleHooksRemove,
  status: handleHooksStatus,
};

export async function handleSkill({ root, config, args, subcommand }) {
  if (subcommand === "list") {
    const skills = listBuiltinSkills();
    if (config.json) {
      console.log(JSON.stringify({ skills }, null, 2));
    } else if (skills.length === 0) {
      log("No built-in skills available.");
    } else {
      for (const skill of skills) {
        const aliases = skill.aliases.length > 0 ? ` aliases: ${skill.aliases.join(", ")}` : "";
        log(`${bold(skill.name)} ${dim(`[${skill.providers.join(", ")}]`)}${aliases ? ` ${dim(aliases)}` : ""}`);
        log(skill.description);
      }
    }
    return;
  }

  if (subcommand === "install") {
    const skillName = args._[2];
    if (!skillName) {
      throw new Error("skill install requires a skill name: agentify skill install <name|all>");
    }
    const installOptions = {
      provider: args.provider,
      scope: args.scope,
      force: args.force,
      dryRun: config.dryRun,
      defaultProvider: config.provider,
    };
    const installingAll = String(skillName).trim().toLowerCase() === "all";
    const result = installingAll
      ? await installAllBuiltinSkills(root, installOptions)
      : await installBuiltinSkill(root, {
        ...installOptions,
        name: skillName,
      });

    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (installingAll) {
        const label = config.dryRun ? "Skill install dry-run for all built-ins" : "All built-in skills ready";
        if (config.dryRun) {
          log(`${label} (${result.scope} scope).`);
        } else {
          success(`${label} (${result.scope} scope).`);
        }
        for (const skillResult of result.results) {
          for (const item of skillResult.results) {
            log(`${bold(skillResult.skill.name)} ${bold(item.provider)} ${item.status} ${dim(item.target_dir)}`);
          }
        }
      } else {
        if (result.skill.requested_name !== result.skill.name) {
          log(`Resolved alias ${result.skill.requested_name} -> ${result.skill.name}`);
        }
        if (config.dryRun) {
          log(`Skill install dry-run for ${bold(result.skill.name)} (${result.scope} scope).`);
        } else {
          success(`Skill ready: ${result.skill.name}`);
        }
        for (const item of result.results) {
          log(`${bold(item.provider)} ${item.status} ${dim(item.target_dir)}`);
        }
      }
    }
    return;
  }

  throw new Error("skill requires a subcommand: list or install");
}

export async function handleSkills(ctx) {
  await handleSkill(ctx);
}

export async function handleMemory({ root, config, args, subcommand }) {
  if (subcommand === "compress") {
    const target = args._[2];
    if (!target) {
      throw new Error("memory compress requires a file path: agentify memory compress <file>");
    }
    const result = {
      command: "memory compress",
      status: "not_implemented",
      file: path.resolve(root, String(target)),
      message:
        "TODO: memory compression is reserved for the caveman-compress follow-up. Install the placeholder with `agentify skill install caveman-compress`.",
    };
    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log(result.message);
    }
    return;
  }

  throw new Error("memory requires a subcommand: compress");
}

export async function handleHooks({ root, config, subcommand }) {
  const handler = HOOK_SUBCOMMANDS[subcommand];
  if (!handler) {
    throw new Error("hooks requires a subcommand: install, remove, or status");
  }
  await handler({ root, config });
}
