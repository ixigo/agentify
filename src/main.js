import path from "node:path";
import process from "node:process";

import { loadConfig, persistProviderPreference, writeDefaultConfig } from "./core/config.js";
import { ensureBaselineArtifacts, runDoc, runScan, runUpdate, runValidate } from "./core/commands.js";
import { runExec } from "./core/exec.js";
import { installHooks, removeHooks, statusHooks } from "./core/hooks.js";
import { queryOwner, queryDeps, queryChanged, querySearch } from "./core/query.js";
import { buildExecutionPlan } from "./core/planner.js";
import { forkSession, listSessions, resolveSessionProvider, resumeSession } from "./core/session.js";
import { runDoctor } from "./core/toolchain.js";
import { garbageCollect, cacheStatus } from "./core/cache.js";
import { runClean } from "./core/cleanup.js";
import { SUPPORTED_PROVIDERS, assertSupportedProvider, buildProviderTemplateCommand } from "./core/provider-command.js";
import { VERSION, setSilent, bold, cyan, dim, green, success, log } from "./core/ui.js";

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

const BOOLEAN_FLAGS = new Set([
  "dryRun",
  "ghost",
  "json",
  "interactive",
  "failOnStale",
  "skipRefresh",
  "explainPlan",
]);

function toCamelCaseFlag(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isProviderStickyCommand(command, subcommand) {
  return command === "run" || command === "exec" || (command === "sess" && ["run", "resume", "fork"].includes(subcommand || ""));
}

function normalizeProvider(value) {
  const provider = String(value || "").trim();
  if (!provider || provider === "true") {
    throw new Error(`--provider requires a value. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`);
  }
  assertSupportedProvider(provider);
  return provider;
}

async function maybePersistProvider(root, config, args, command, subcommand) {
  if (!hasOwn(args, "provider")) {
    return;
  }

  const provider = normalizeProvider(args.provider);
  config.provider = provider;

  if (isProviderStickyCommand(command, subcommand)) {
    await persistProviderPreference(root, provider, { dryRun: config.dryRun });
  }
}

function getExecFlags(args) {
  return {
    failOnStale: args.failOnStale || false,
    timeout: args.timeout || null,
    skipRefresh: args.skipRefresh || false,
  };
}

function getProviderTemplateOptions(args, root, provider, usingTemplateCommand) {
  const interactive = args.interactive || false;

  if (interactive && usingTemplateCommand && provider !== "codex") {
    throw new Error("--interactive is currently supported only with --provider codex.");
  }

  return {
    root,
    interactive,
  };
}

function getPromptFromArgs(args, startIndex) {
  return args._.slice(startIndex).join(" ").trim();
}

function buildRunPrompt(userPrompt) {
  if (userPrompt) {
    return userPrompt;
  }
  return "Continue implementation in this repository using small, validated changes.";
}

function buildSessionPrompt(bootstrap, userPrompt) {
  const task = userPrompt || "Continue this session from the latest repository state.";
  return [
    "You are continuing an Agentify session.",
    "",
    bootstrap.trim(),
    "",
    `Current task: ${task}`,
  ].join("\n");
}

function resolveSessionIdForResume(args) {
  if (args.session) {
    return { sessionId: String(args.session), promptStartIndex: 2 };
  }
  const positional = args._[2];
  if (positional) {
    return { sessionId: String(positional), promptStartIndex: 3 };
  }
  throw new Error("sess resume requires --session <id> or sess resume <id>");
}

function printHelp() {
  const c = (s) => bold(cyan(s));
  const d = (s) => dim(s);

  const lines = [
    `  ${bold("COMMANDS")}`,
    ``,
    `    ${c("init")}            ${d("Create baseline Agentify artifacts")}`,
    `    ${c("index")}           ${d("Build the SQLite repository index")}`,
    `    ${c("scan")}            ${d("Alias for index")}`,
    `    ${c("doc")}             ${d("Generate docs, metadata, and key-file headers")}`,
    `    ${c("up")}              ${d("Run scan -> doc -> check -> test pipeline")}`,
    `    ${c("check")}           ${d("Validate freshness, schemas, and safety rules")}`,
    `    ${c("plan")}            ${d("Preview the planner-selected context for a task")}`,
    `    ${c("run")}             ${d("Run provider template command with auto-refresh")}`,
    `    ${c("exec")}            ${d("Advanced wrapper for custom agent commands")}`,
    `    ${c("query")}           ${d("Query the repository index (owner, deps, changed)")}`,
    `    ${c("sess")}            ${d("Manage provider-backed sessions")}`,
    `    ${c("hooks")}           ${d("Install/remove git hooks")}`,
    `    ${c("doctor")}          ${d("Check toolchain health and capability tier")}`,
    `    ${c("clean")}           ${d("Prune stale generated artifacts and dead Agentify folders")}`,
    `    ${c("cache")}           ${d("Manage the content cache")}`,
    ``,
    `  ${bold("OPTIONS")}`,
    ``,
    `    ${c("--provider")} ${d(`<${SUPPORTED_PROVIDERS.join("|")}>`)}`,
    `    ${c("--strict")} ${d("<true|false>")}         Fail closed on validation issues`,
    `    ${c("--languages")} ${d("<auto|ts|python|go|rust|dotnet|java|kotlin|swift>")}`,
    `    ${c("--dry-run")}                   Report planned changes without writing`,
    `    ${c("--ghost")}                     Route outputs to .current_session/`,
    `    ${c("--json")}                      Machine-readable JSON output only`,
    `    ${c("--interactive")}, ${c("-i")}       Launch Codex interactive CLI for run/sess`,
    `    ${c("--explain-plan")}              Print planner output before executing run`,
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
    `    ${d("$")} agentify up --provider codex`,
    `    ${d("$")} agentify clean --dry-run`,
    `    ${d("$")} agentify run --provider codex "implement payment retries"`,
    `    ${d("$")} agentify run --provider codex --interactive "fix auth bug"`,
    `    ${d("$")} agentify sess run --provider codex --name "payments-v2" "add tests"`,
    `    ${d("$")} agentify sess run --provider codex --interactive --name "payments-v2" "continue in Codex TUI"`,
    `    ${d("$")} agentify exec -- codex exec "fix auth bug"`,
    ``,
  ];

  process.stderr.write(lines.join("\n") + "\n");
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
    if (token === "-i") {
      args.interactive = true;
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
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
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

  if (hasOwn(args, "tool")) {
    throw new Error("--tool was removed. Use --provider.");
  }

  if (command === "update") {
    throw new Error("command \"update\" was removed. Use \"up\".");
  }
  if (command === "validate") {
    throw new Error("command \"validate\" was removed. Use \"check\".");
  }
  if (command === "session") {
    throw new Error("command \"session\" was removed. Use \"sess\".");
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

  await maybePersistProvider(root, config, args, command, subcommand);

  switch (command) {
    case "init":
      await writeDefaultConfig(root, config, { dryRun: config.dryRun });
      await ensureBaselineArtifacts(root, config);
      success("Initialized agentify artifacts");
      return;

    case "index":
    case "scan":
      await runScan(root, config);
      return;

    case "doc":
      await runDoc(root, config);
      return;

    case "up":
      await runUpdate(root, config);
      return;

    case "check":
      await runValidate(root, config);
      return;

    case "plan": {
      const prompt = buildRunPrompt(getPromptFromArgs(args, 1));
      const plan = await buildExecutionPlan(root, config, prompt);
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    case "run": {
      const prompt = buildRunPrompt(getPromptFromArgs(args, 1));
      const usingTemplateCommand = !args._exec?.length;
      const providerOptions = getProviderTemplateOptions(args, root, config.provider, usingTemplateCommand);
      const plan = !args._exec?.length
        ? await buildExecutionPlan(root, config, prompt)
        : null;
      if (args.explainPlan && plan) {
        console.log(JSON.stringify(plan, null, 2));
      }
      const agentCommand = args._exec?.length
        ? args._exec
        : buildProviderTemplateCommand(
          config.provider,
          plan.prompt,
          providerOptions,
        );

      await runExec(root, config, agentCommand, getExecFlags(args));
      return;
    }

    case "exec": {
      const agentCommand = args._exec || [];
      if (agentCommand.length === 0) {
        throw new Error("exec requires a command after --: agentify exec [flags] -- <command...>");
      }
      await runExec(root, config, agentCommand, getExecFlags(args));
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
      } else if (subcommand === "search") {
        if (!args.term) throw new Error("query search requires --term <value>");
        result = await querySearch(root, args.term);
      } else {
        throw new Error("query requires a subcommand: owner, deps, changed, or search");
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case "sess": {
      if (subcommand === "list") {
        const sessions = await listSessions(root);
        if (config.json) {
          console.log(JSON.stringify(sessions, null, 2));
        } else if (sessions.length === 0) {
          log("No sessions found.");
        } else {
          for (const s of sessions) {
            log(`${bold(s.session_id)} ${dim(resolveSessionProvider(s, ""))} ${dim(s.created_at || "")}`);
          }
        }
        return;
      }

      if (subcommand === "fork") {
        const result = await forkSession(root, config, {
          from: args.from || null,
          provider: args.provider || null,
          name: args.name || null,
        });
        const provider = hasOwn(args, "provider")
          ? normalizeProvider(args.provider)
          : normalizeProvider(resolveSessionProvider(result.manifest, config.provider));
        const prompt = buildSessionPrompt(result.bootstrap, getPromptFromArgs(args, 2));
        const usingTemplateCommand = !args._exec?.length;
        const agentCommand = args._exec?.length
          ? args._exec
          : buildProviderTemplateCommand(
            provider,
            prompt,
            getProviderTemplateOptions(args, root, provider, usingTemplateCommand),
          );

        if (!config.json) {
          success(`Session forked: ${result.manifest.session_id}`);
          log(`Path: ${dim(result.sessionDir)}`);
        }

        await runExec(root, { ...config, provider }, agentCommand, getExecFlags(args));
        return;
      }

      if (subcommand === "resume") {
        const { sessionId, promptStartIndex } = resolveSessionIdForResume(args);
        const result = await resumeSession(root, sessionId);
        const provider = hasOwn(args, "provider")
          ? normalizeProvider(args.provider)
          : normalizeProvider(resolveSessionProvider(result.manifest, config.provider));
        const prompt = buildSessionPrompt(result.bootstrap, getPromptFromArgs(args, promptStartIndex));
        const usingTemplateCommand = !args._exec?.length;
        const agentCommand = args._exec?.length
          ? args._exec
          : buildProviderTemplateCommand(
            provider,
            prompt,
            getProviderTemplateOptions(args, root, provider, usingTemplateCommand),
          );

        await runExec(root, { ...config, provider }, agentCommand, getExecFlags(args));
        return;
      }

      if (subcommand === "run") {
        let sessionResult;
        let sessionDir;

        if (args.session) {
          sessionResult = await resumeSession(root, String(args.session));
        } else {
          const created = await forkSession(root, config, {
            from: args.from || null,
            provider: args.provider || null,
            name: args.name || null,
          });
          sessionResult = {
            manifest: created.manifest,
            context: created.context,
            bootstrap: created.bootstrap,
          };
          sessionDir = created.sessionDir;
          if (!config.json) {
            success(`Session created: ${created.manifest.session_id}`);
            log(`Path: ${dim(created.sessionDir)}`);
          }
        }

        const provider = hasOwn(args, "provider")
          ? normalizeProvider(args.provider)
          : normalizeProvider(resolveSessionProvider(sessionResult.manifest, config.provider));
        const prompt = buildSessionPrompt(sessionResult.bootstrap, getPromptFromArgs(args, 2));
        const usingTemplateCommand = !args._exec?.length;
        const agentCommand = args._exec?.length
          ? args._exec
          : buildProviderTemplateCommand(
            provider,
            prompt,
            getProviderTemplateOptions(args, root, provider, usingTemplateCommand),
          );

        if (config.json && sessionDir) {
          console.log(JSON.stringify({ ...sessionResult.manifest, session_dir: sessionDir }, null, 2));
        }

        await runExec(root, { ...config, provider }, agentCommand, getExecFlags(args));
        return;
      }

      throw new Error("sess requires a subcommand: run, fork, list, or resume");
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

    case "clean": {
      const result = await runClean(root, config);
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
      return;
    }

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
