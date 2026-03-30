import path from "node:path";
import process from "node:process";

import { loadConfig, writeDefaultConfig } from "./core/config.js";
import { ensureBaselineArtifacts, runDoc, runScan, runUpdate, runValidate } from "./core/commands.js";
import { runExec } from "./core/exec.js";
import { installHooks, removeHooks, statusHooks } from "./core/hooks.js";
import { queryOwner, queryDeps, queryChanged } from "./core/query.js";
import { forkSession, listSessions, resumeSession } from "./core/session.js";
import { runDoctor } from "./core/toolchain.js";
import { garbageCollect, cacheStatus } from "./core/cache.js";
import { VERSION, setSilent, bold, cyan, dim, green, success, warn, error, log, newline } from "./core/ui.js";

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

function toCamelCaseFlag(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

export function parseArgs(argv) {
  const args = { _: [] };
  let seenDoubleDash = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "-v" || token === "-V") {
      args.version = true;
      continue;
    }

    if (token === "--" && !seenDoubleDash) {
      seenDoubleDash = true;
      args._exec = argv.slice(index + 1);
      break;
    }

    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = toCamelCaseFlag(rawKey);
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
  const c = (s) => bold(cyan(s));
  const d = (s) => dim(s);

  const lines = [
    `  ${bold("COMMANDS")}`,
    ``,
    `    ${c("init")}            ${d("Create baseline Agentify artifacts")}`,
    `    ${c("scan")}            ${d("Run deterministic repo scan and write index artifacts")}`,
    `    ${c("doc")}             ${d("Generate docs, metadata, and key-file headers")}`,
    `    ${c("update")}          ${d("Run scan -> doc -> validate -> test pipeline")}`,
    `    ${c("validate")}        ${d("Validate freshness, schemas, and safety rules")}`,
    `    ${c("exec")}            ${d("Wrap an agent command with auto-refresh")}`,
    `    ${c("query")}           ${d("Query the repository index (owner, deps, changed)")}`,
    `    ${c("session")}         ${d("Manage session fork/resume")}`,
    `    ${c("hooks")}           ${d("Install/remove git hooks")}`,
    `    ${c("doctor")}          ${d("Check toolchain health and capability tier")}`,
    `    ${c("cache")}           ${d("Manage the content cache")}`,
    ``,
    `  ${bold("OPTIONS")}`,
    ``,
    `    ${c("--provider")} ${d("<local|codex|claude|gemini|opencode>")}`,
    `    ${c("--strict")} ${d("<true|false>")}         Fail closed on validation issues`,
    `    ${c("--languages")} ${d("<auto|ts|python|dotnet|java|kotlin|swift>")}`,
    `    ${c("--dry-run")}                   Report planned changes without writing`,
    `    ${c("--ghost")}                     Route outputs to .current_session/`,
    `    ${c("--json")}                      Machine-readable JSON output only`,
    `    ${c("--root")} ${d("<path>")}               Target repo root (default: cwd)`,
    ``,
    `  ${bold("EXEC FLAGS")}`,
    ``,
    `    ${c("--fail-on-stale")}             Exit 80 if validation fails post-refresh`,
    `    ${c("--timeout")} ${d("<seconds>")}         Kill wrapped command after N seconds`,
    `    ${c("--skip-refresh")}              Skip post-command refresh`,
    ``,
    `  ${bold("EXAMPLES")}`,
    ``,
    `    ${d("$")} agentify init`,
    `    ${d("$")} agentify scan --provider codex`,
    `    ${d("$")} agentify update --strict`,
    `    ${d("$")} agentify exec -- codex --task "add tests"`,
    `    ${d("$")} agentify doctor`,
    ``,
  ];

  process.stderr.write(lines.join("\n") + "\n");
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  const [command = "help", subcommand] = args._;

  if (args.version) {
    process.stdout.write(`agentify v${VERSION}\n`);
    return;
  }

  if (command === "help" || args.help) {
    printHelp();
    return;
  }

  const root = path.resolve(String(args.root || process.cwd()));
  const config = await loadConfig(root, args);

  if (args.json) {
    config.json = true;
    config._suppressProgress = true;
    setSilent(true);
  }
  if (args.ghost) {
    config.ghost = true;
  }

  switch (command) {
    case "init":
      await writeDefaultConfig(root, config, { dryRun: config.dryRun });
      await ensureBaselineArtifacts(root, config);
      success("Initialized agentify artifacts");
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

    case "exec": {
      const agentCommand = args._exec || [];
      if (agentCommand.length === 0) {
        throw new Error("exec requires a command after --: agentify exec [flags] -- <command...>");
      }
      await runExec(root, config, agentCommand, {
        failOnStale: args.failOnStale || false,
        timeout: args.timeout || null,
        skipRefresh: args.skipRefresh || false,
      });
      return;
    }

    case "query": {
      let result;
      if (subcommand === "owner") {
        if (!args.file) throw new Error("query owner requires --file <path>");
        result = await queryOwner(root, args.file);
      } else if (subcommand === "deps") {
        if (!args.module) throw new Error("query deps requires --module <id>");
        result = await queryDeps(root, args.module);
      } else if (subcommand === "changed") {
        if (!args.since) throw new Error("query changed requires --since <commit>");
        result = await queryChanged(root, args.since);
      } else {
        throw new Error("query requires a subcommand: owner, deps, or changed");
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case "session": {
      if (subcommand === "fork") {
        const result = await forkSession(root, config, {
          from: args.from || null,
          tool: args.tool || null,
          name: args.name || null,
        });
        if (config.json) {
          console.log(JSON.stringify(result.manifest, null, 2));
        } else {
          success(`Session forked: ${result.manifest.session_id}`);
          log(`Path: ${dim(result.sessionDir)}`);
        }
      } else if (subcommand === "list") {
        const sessions = await listSessions(root);
        if (config.json) {
          console.log(JSON.stringify(sessions, null, 2));
        } else if (sessions.length === 0) {
          log("No sessions found.");
        } else {
          for (const s of sessions) {
            log(`${bold(s.session_id)} ${dim(s.tool || "")} ${dim(s.created_at || "")}`);
          }
        }
      } else if (subcommand === "resume") {
        if (!args.session) throw new Error("session resume requires --session <id>");
        const result = await resumeSession(root, args.session);
        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          process.stdout.write(result.bootstrap);
        }
      } else {
        throw new Error("session requires a subcommand: fork, list, or resume");
      }
      return;
    }

    case "hooks": {
      if (subcommand === "install") {
        const installed = await installHooks(root);
        if (installed.length > 0) {
          success(`Installed hooks: ${installed.join(", ")}`);
        } else {
          log("All hooks already installed.");
        }
      } else if (subcommand === "remove") {
        const removed = await removeHooks(root);
        if (removed.length > 0) {
          success(`Removed hooks: ${removed.join(", ")}`);
        } else {
          log("No Agentify hooks found.");
        }
      } else if (subcommand === "status") {
        const status = await statusHooks(root);
        if (config.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          for (const [hook, installed] of Object.entries(status)) {
            const st = installed ? green("installed") : dim("not installed");
            log(`${bold(hook)}: ${st}`);
          }
        }
      } else {
        throw new Error("hooks requires a subcommand: install, remove, or status");
      }
      return;
    }

    case "doctor":
      await runDoctor(config);
      return;

    case "cache": {
      const cacheRoot = path.join(root, ".agents", "cache");
      if (subcommand === "gc") {
        const maxAge = args.maxAge || config.cache?.maxAgeDays || 7;
        const result = await garbageCollect(cacheRoot, maxAge);
        success(`Garbage collected ${result.removed} blob(s).`);
      } else if (subcommand === "status") {
        const status = await cacheStatus(cacheRoot);
        if (config.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          log(`Blobs: ${bold(String(status.blobs))}  Size: ${bold(status.totalSize || "0 B")}`);
        }
      } else {
        throw new Error("cache requires a subcommand: gc or status");
      }
      return;
    }

    default:
      throw new Error(`unknown command "${command}"`);
  }
}
