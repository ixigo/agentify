#!/usr/bin/env node

import { handleFastPath, isHelpRequest, isVersionRequest } from "./core/cli-fast-paths.js";

const args = process.argv.slice(2);
const isJson = args.includes("--json");
const isHelp = isHelpRequest(args);
const isVersion = isVersionRequest(args);
// Quiet commands run inside Claude Code hooks, shell completion, or an MCP
// client; the banner would pollute their output (stdout is the MCP channel).
const isQuiet = args.includes("completion") || args[0] === "ctx" || args[0] === "serve";

async function main() {
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
