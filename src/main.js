import path from "node:path";
import process from "node:process";

import { parseArgs, hasOwn } from "./core/cli-args.js";
import { loadConfig } from "./core/config.js";
import { generateCompletionScript, printCompletionValues } from "./core/completion.js";
import { runBootstrapCommand } from "./core/bootstrap.js";
import { VERSION, printHelp } from "./core/cli-fast-paths.js";
import { getCommandHandler } from "./core/handlers/index.js";
import {
  enableSharedStoreConfig,
  maybePrepareWorktreeRuntime,
  shouldUseSharedStoreInit,
} from "./core/handlers/shared.js";
import { resolveAgentifyPaths } from "./core/project-store.js";
import { maybePersistProvider } from "./core/run-prompts.js";
import { withSilent } from "./core/ui.js";

export { parseArgs } from "./core/cli-args.js";
export {
  buildExecutionPrompt,
  buildMinimalRunPrompt,
  buildNoTaskRunPrompt,
  buildSessionPrompt,
  getProviderTemplateOptions,
  getSessionCaptureSettings,
  prepareSessionLaunch,
  resolveRunContextMode,
} from "./core/run-prompts.js";

function normalizeAliases(args) {
  if (args._[0] === "session") {
    args._[0] = "sess";
  }
  if (args._[0] === "sess" && args.resume === true && args._[1] !== "resume") {
    args._ = ["sess", "resume", ...args._.slice(1)];
  }
}

async function handleSpecialCommand(command, subcommand, args) {
  if (args.version) {
    process.stdout.write(`agentify v${VERSION}\n`);
    return true;
  }

  if (command === "help" || args.help) {
    await printHelp();
    return true;
  }

  if (hasOwn(args, "tool")) {
    throw new Error("--tool was removed. Use --provider.");
  }

  if (command === "update") {
    throw new Error("command \"update\" was removed. Use \"up\".");
  }
  if (command === "validate") {
    throw new Error("command \"validate\" was removed. Use \"check\".");
  }
  if (command === "this") {
    await runBootstrapCommand(args);
    return true;
  }

  if (command === "completion") {
    const root = path.resolve(String(args.root || process.cwd()));
    if (subcommand === "values") {
      const kind = args._[2];
      if (!kind) {
        throw new Error("completion values requires a kind: providers, skills, or sessions");
      }
      await printCompletionValues(kind, { root });
      return true;
    }
    process.stdout.write(generateCompletionScript(subcommand));
    return true;
  }

  return false;
}

export async function runCli(argv, runtime = {}) {
  void runtime;
  const args = parseArgs(argv);
  normalizeAliases(args);
  const [command = "help", subcommand] = args._;

  if (await handleSpecialCommand(command, subcommand, args)) {
    return;
  }

  const root = path.resolve(String(args.root || process.cwd()));
  const config = await loadConfig(root, args);
  if (shouldUseSharedStoreInit(args, command)) {
    enableSharedStoreConfig(config);
  }
  await maybePrepareWorktreeRuntime(root, config, command);
  config._agentifyPaths = await resolveAgentifyPaths(root, config);

  if (args.json) {
    config.json = true;
    config._suppressProgress = true;
  }
  if (args.ghost) {
    config.ghost = true;
  }

  const handler = getCommandHandler(command);
  if (!handler) {
    throw new Error(`unknown command "${command}"`);
  }

  const dispatch = async () => {
    await maybePersistProvider(root, config, args, command, subcommand);
    await handler({ root, config, args, command, subcommand });
  };

  if (config.json) {
    return withSilent(true, dispatch);
  }

  return dispatch();
}
