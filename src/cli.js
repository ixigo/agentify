#!/usr/bin/env node

import { parseArgs } from "./core/cli-args.js";
import { handleFastPath, isHelpRequest, isVersionRequest } from "./core/cli-fast-paths.js";
import { recordInvocation, resolveCliInvocationCommand } from "./core/invocations.js";

const args = process.argv.slice(2);
const isJson = args.includes("--json");
const isHelp = isHelpRequest(args);
const isVersion = isVersionRequest(args);

// Resolve the command token the same way runCli does — via the real parser, so
// leading global flags (boolean or value-taking) are handled correctly, e.g.
// `agentify --dry-run acp` and `agentify --root . acp` both resolve to "acp".
const parsedArgs = parseArgs(args);
const [commandToken] = parsedArgs._;

// Quiet commands run inside Claude Code hooks, shell completion, an MCP client,
// or the ACP proxy; the banner would pollute their protocol output on stdout.
const isQuiet = commandToken === "completion"
  || commandToken === "ctx"
  || commandToken === "serve"
  || commandToken === "acp"
  || args.includes("--hook");

async function main() {
  await recordInvocation({
    command: resolveCliInvocationCommand(parsedArgs, { help: isHelp, version: isVersion }),
    source: parsedArgs.hook === true ? "hook" : "cli",
  });

  if (await handleFastPath(args)) {
    return;
  }

  const { banner, error, dim } = await import("./core/ui.js");

  if (!isJson && !isHelp && !isVersion && !isQuiet) {
    banner();
  }

  try {
    const { runCli } = await import("./main.js");
    await runCli(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(message);
    if (err instanceof Error && err.stack && !isJson) {
      process.stderr.write(`\n${dim(err.stack.split("\n").slice(1).join("\n"))}\n`);
    }
    process.exitCode = 1;
  }
}

main();
