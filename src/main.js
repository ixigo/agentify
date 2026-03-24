import path from "node:path";
import process from "node:process";

import { loadConfig, writeDefaultConfig } from "./core/config.js";
import { ensureBaselineArtifacts, runDoc, runScan, runUpdate, runValidate } from "./core/commands.js";

function parseValue(raw) {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const [key, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args[key] = parseValue(inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = parseValue(next);
    index += 1;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: agentify <command> [options]

Commands:
  init       Create baseline Agentify artifacts
  scan       Run deterministic repo scan and write index artifacts
  doc        Generate docs, metadata, and key-file headers
  update     Run scan -> doc -> validate
  validate   Validate freshness, schemas, and safety rules

Flags:
  --provider local|codex|claude|gemini|opencode
                               Provider to use for doc generation
  --mode branch|pr|patch       Output mode (default: branch)
  --strict true|false          Fail closed on validation issues (default: true)
  --languages auto|ts|python|dotnet
  --module-strategy auto|workspace|src-folder|namespace
  --dry-run                    Report planned changes without writing
  --max-files-per-module N     Bound file context per module
  --module-concurrency N       Parallel module agent runs (default: 4)
  --token-report true|false    Write .agents/runs/<id>.json (default: true)
  --root <path>                Target repo root (default: cwd)
`);
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  const [command = "help"] = args._;

  if (command === "help" || args.help) {
    printHelp();
    return;
  }

  const root = path.resolve(String(args.root || process.cwd()));
  const config = await loadConfig(root, args);

  switch (command) {
    case "init":
      await writeDefaultConfig(root, config, { dryRun: config.dryRun });
      await ensureBaselineArtifacts(root, config);
      return;
    case "scan":
      await runScan(root, config);
      return;
    case "doc":
      await runDoc(root, config);
      return;
    case "update":
      await runUpdate(root, config);
      return;
    case "validate":
      await runValidate(root, config);
      return;
    default:
      throw new Error(`unknown command "${command}"`);
  }
}
