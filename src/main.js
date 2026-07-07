import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig, writeDefaultConfig } from "./core/config.js";
import { ensureBaselineArtifacts, runScan, runUpdate, runValidate } from "./core/commands.js";
import { installHooks, removeHooks, statusHooks } from "./core/hooks.js";
import {
  installIntegration,
  integrationStatus,
  resolveIntegrationProviders,
  uninstallIntegration,
} from "./core/integrations.js";
import { ensureAgentifyGitignore } from "./core/gitignore.js";
import {
  addNote,
  clearContext,
  contextStatus,
  isContextPaused,
  loadContextSnapshot,
  latestSessionId,
  matchContext,
  normalizeInjectionMode,
  pauseContext,
  readHookPayload,
  renderContextDigest,
  renderMatchDigest,
  resumeContext,
  summarizeSession,
  trackEvent,
  writeHandoff,
} from "./core/ctx.js";
import {
  queryCallers,
  queryChanged,
  queryDef,
  queryDeps,
  queryImpacts,
  queryOwner,
  queryRefs,
  querySearch,
} from "./core/query.js";
import { buildRiskReport, renderRiskReport } from "./core/risk.js";
import { describeModelRoutes, runDelegate } from "./core/models.js";
import { describeWorkflows, installWorkflow } from "./core/workflows.js";
import { runDoctor } from "./core/toolchain.js";
import { runClean } from "./core/cleanup.js";
import { generateCompletionScript, printCompletionValues } from "./core/completion.js";
import { buildSkillInstallHint, installAllBuiltinSkills, installBuiltinSkill, listBuiltinSkills } from "./core/skills.js";
import { VERSION, printHelp } from "./core/cli-fast-paths.js";
import { resolveAgentifyPaths } from "./core/project-store.js";
import { withSilent, bold, dim, green, success, log } from "./core/ui.js";

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
  "hook",
  "failOnStale",
  "force",
  "global",
  "planned",
  "sessions",
  "all",
  "strict",
  "write",
  "off",
]);

function toCamelCaseFlag(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeOptionalSince(args, commandName) {
  if (!hasOwn(args, "since")) {
    return null;
  }
  const since = String(args.since).trim();
  if (!since || since === "true") {
    throw new Error(`${commandName} --since requires a commit or ref value`);
  }
  return since;
}

function isMissingIndexError(error) {
  return error instanceof Error && /missing index database at /.test(error.message);
}

function isInvalidIndexDatabaseError(error) {
  return error instanceof Error && (
    error.code === "AGENTIFY_INDEX_DATABASE_INVALID"
    || /invalid index database at /.test(error.message)
  );
}

function throwWithIndexGuidance(error, root) {
  if (isMissingIndexError(error)) {
    throw new Error(
      `Agentify index missing for ${root}. Run "agentify scan --root ${root}" before using query/risk commands.`
    );
  }
  if (isInvalidIndexDatabaseError(error)) {
    throw new Error(
      `Agentify index unreadable for ${root}. Run "agentify scan --root ${root}" to rebuild it before using query/risk commands.`
    );
  }
  throw error;
}

function getSearchTerm(args, commandName) {
  const term = args.term === undefined ? args._[2] : args.term;
  if (!term || term === true) {
    throw new Error(`${commandName} search requires --term <value> or a positional search term`);
  }
  return String(term);
}

function getPromptFromArgs(args, startIndex) {
  return args._.slice(startIndex).join(" ").trim();
}

export function parseArgs(argv) {
  const args = { _: [] };

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

async function resolveInjectionMode(root) {
  try {
    const config = await loadConfig(root, {});
    return normalizeInjectionMode(config.context?.injection);
  } catch {
    return "relevant";
  }
}

async function runCtxHook(action, root) {
  // Hook-invoked paths must never fail or pollute the transcript with errors.
  try {
    const payload = await readHookPayload();
    if (action === "track") {
      const result = await trackEvent(root, payload);
      if (
        result.tracked
        && payload?.hook_event_name === "SessionEnd"
        && payload?.session_id
      ) {
        await maybeSpawnSessionSummary(root, String(payload.session_id));
      }
      return;
    }

    if (await isContextPaused(root)) {
      return;
    }
    const mode = await resolveInjectionMode(root);
    if (mode === "off") {
      return;
    }

    if (action === "load") {
      const snapshot = await loadContextSnapshot(root);
      if (mode === "digest") {
        const digest = renderContextDigest(snapshot);
        if (digest) {
          process.stdout.write(`${digest}\n`);
        }
        return;
      }
      // relevant mode: a one-line pointer only — matched context arrives with
      // each prompt via the UserPromptSubmit hook.
      if (snapshot.summary.eventCount > 0 || snapshot.notes.length > 0) {
        process.stdout.write(`Agentify is tracking context here (${snapshot.notes.length} note(s), ${snapshot.summary.eventCount} recent event(s)). Related notes are injected per task; run \`agentify ctx load\` for the full digest.\n`);
      }
      return;
    }

    if (action === "match") {
      if (mode !== "relevant") {
        return;
      }
      const prompt = String(payload?.prompt || "");
      if (!prompt.trim()) {
        return;
      }
      const matches = await matchContext(root, prompt, { sessionId: payload?.session_id });
      const digest = renderMatchDigest(matches);
      if (digest) {
        process.stdout.write(`${digest}\n`);
      }
    }
  } catch {
    // Swallow all hook errors: a broken hook must not block the agent.
  }
}

async function maybeSpawnSessionSummary(root, sessionId) {
  try {
    const config = await loadConfig(root, {});
    if (config.context?.sessionSummaries === false) {
      return;
    }
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
    // Detached so the SessionEnd hook returns immediately; the summary lands
    // asynchronously via a delegated fast-model call.
    const child = spawn(process.execPath, [cliPath, "ctx", "summarize", "--session", sessionId, "--hook", "--root", root], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Best-effort: never block the hook.
  }
}

async function runCtxCommand(root, config, args, subcommand) {
  const isHookMode = args.hook === true;

  switch (subcommand) {
    case "track": {
      if (isHookMode) {
        await runCtxHook("track", root);
        return;
      }
      const payload = await readHookPayload();
      const result = await trackEvent(root, payload);
      console.log(JSON.stringify({ command: "ctx track", ...result }, null, 2));
      return;
    }

    case "match": {
      if (isHookMode) {
        await runCtxHook("match", root);
        return;
      }
      const prompt = getPromptFromArgs(args, 2);
      if (!prompt) {
        throw new Error('ctx match requires a prompt: agentify ctx match "<task>"');
      }
      const matches = await matchContext(root, prompt, { sessionId: args.session, recordInjection: false });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx match", ...matches }, null, 2));
      } else {
        log(renderMatchDigest(matches) || "No related context found.");
      }
      return;
    }

    case "load": {
      if (isHookMode) {
        await runCtxHook("load", root);
        return;
      }
      const snapshot = await loadContextSnapshot(root);
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx load", ...snapshot }, null, 2));
      } else {
        const digest = renderContextDigest(snapshot);
        log(digest || "No tracked context yet. Context accrues automatically once `agentify install` hooks are active.");
      }
      return;
    }

    case "note": {
      const text = getPromptFromArgs(args, 2);
      const result = await addNote(root, text, { session: args.session });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx note", ...result }, null, 2));
      } else {
        success("Noted.");
      }
      return;
    }

    case "status": {
      const result = await contextStatus(root);
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.paused) {
          log(`${bold("Tracking: paused")} — resume with \`agentify ctx resume\``);
        }
        log(`Events: ${bold(String(result.event_count))} across ${bold(String(result.session_count))} session(s)`);
        log(`Notes:  ${bold(String(result.note_count))}`);
        log(`Log:    ${dim(result.events_path)} (${result.event_log_bytes} bytes)`);
        if (result.last_event_at) {
          log(`Last activity: ${result.last_event_at}`);
        }
        for (const item of result.hot_files.slice(0, 5)) {
          log(`  ${item.file} ${dim(`(${item.edits} edits)`)}`);
        }
      }
      return;
    }

    case "handoff": {
      const result = await writeHandoff(root, { task: getPromptFromArgs(args, 2) });
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        success(`Handoff written: ${result.relative_path}`);
      }
      return;
    }

    case "summarize": {
      if (isHookMode) {
        try {
          await summarizeSession(root, config, args.session, {});
        } catch {
          // Hook-spawned: never fail.
        }
        return;
      }
      const sessionId = args.session || await latestSessionId(root);
      if (!sessionId) {
        throw new Error("ctx summarize found no tracked sessions; pass --session <id>");
      }
      const result = await summarizeSession(root, config, sessionId, {});
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.status === "written") {
        success(`Session ${result.sid} summarized.`);
        log(result.record.summary);
      } else {
        log(`No summary written (${result.status}).`);
      }
      return;
    }

    case "share": {
      const enable = args.off !== true;
      const result = await ensureAgentifyGitignore(root, { shared: enable, dryRun: config.dryRun });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx share", shared: result.shared, gitignore: result.path, status: result.status }, null, 2));
      } else if (enable) {
        success("Team-shared notes enabled.");
        log(".agentify/context/notes.jsonl is now committable — commit it and teammates' agents pick your notes up.");
        log(dim("Everything else under .agentify/ stays local. Disable with `agentify ctx share --off`."));
      } else {
        success("Team-shared notes disabled; .agentify/ is fully local again.");
      }
      return;
    }

    case "pause": {
      const result = await pauseContext(root);
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        success("Context tracking paused. New sessions start clean; nothing is tracked until `agentify ctx resume`.");
      }
      return;
    }

    case "resume": {
      const result = await resumeContext(root);
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        success(result.was_paused ? "Context tracking resumed." : "Context tracking was not paused.");
      }
      return;
    }

    case "clear": {
      const result = await clearContext(root, { archive: args.archive !== false });
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.archived.length > 0) {
        success("Context cleared.");
        for (const item of result.archived) {
          log(`archived: ${dim(item)}`);
        }
      } else {
        success("Context cleared (nothing to archive).");
      }
      return;
    }

    default:
      throw new Error("ctx requires a subcommand: track, note, load, match, status, summarize, share, handoff, pause, resume, or clear");
  }
}

async function runInstall(root, config, args) {
  const isGlobal = args.global === true;
  const providers = resolveIntegrationProviders(args.provider);

  if (!isGlobal) {
    await writeDefaultConfig(root, config, { dryRun: config.dryRun });
    await ensureBaselineArtifacts(root, config);
  }

  const integrations = [];
  for (const provider of providers) {
    integrations.push(await installIntegration(root, {
      provider,
      global: isGlobal,
      dryRun: config.dryRun,
    }));
  }

  const result = {
    command: "install",
    root,
    scope: isGlobal ? "global" : "project",
    dry_run: Boolean(config.dryRun),
    integrations,
    wrote: isGlobal || config.dryRun ? [] : [".agentify.yaml", ".gitignore", ".agentignore", ".guardrails", ".agentify"],
  };

  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  success(`Agentify installed (${result.scope} scope)`);
  for (const integration of integrations) {
    log(`${bold(integration.provider)} guidance: ${dim(integration.memory.path)} (${integration.memory.action})`);
    if (integration.settings.path) {
      log(`${bold(integration.provider)} hooks:    ${dim(integration.settings.path)} (${integration.settings.changed ? "updated" : "already current"})`);
    } else {
      log(`${bold(integration.provider)} hooks:    ${dim("n/a — guidance-driven tracking")}`);
    }
  }
  if (!isGlobal) {
    log("");
    if (providers.includes("claude")) {
      log("Claude Code will now track context automatically in this repo.");
    }
    if (providers.includes("codex")) {
      log("Codex will follow the AGENTS.md guidance to load and record context.");
    }
    log(`Model routing configured: small work → fast models, reviews → a different vendor. ${dim("agentify models")} shows the table.`);
    log(`Optional: ${dim("agentify scan")} to build the structural index for query/risk commands.`);
    log(buildSkillInstallHint(config.provider, "project").message);
  }
}

async function runUninstall(root, config, args) {
  const providers = resolveIntegrationProviders(args.provider, { fallback: "all" });
  const results = [];
  for (const provider of providers) {
    results.push(await uninstallIntegration(root, {
      provider,
      global: args.global === true,
      dryRun: config.dryRun,
    }));
  }
  if (config.json) {
    console.log(JSON.stringify({ command: "uninstall", integrations: results }, null, 2));
    return;
  }
  success(`Agentify integration removed (${results[0].scope} scope)`);
  for (const result of results) {
    log(`${bold(result.provider)} guidance: ${dim(result.memory.path)} (${result.memory.changed ? "cleaned" : "no managed block"})`);
    if (result.settings.path) {
      log(`${bold(result.provider)} hooks:    ${dim(result.settings.path)} (${result.settings.changed ? "cleaned" : "no managed hooks"})`);
    }
  }
}

async function runStatus(root, config, args) {
  const providers = resolveIntegrationProviders(args.provider, { fallback: "all" });
  const integrations = [];
  for (const provider of providers) {
    integrations.push(await integrationStatus(root, { provider, global: args.global === true }));
  }
  const context = await contextStatus(root);
  const result = { command: "status", integrations, context };
  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const state = (installed) => (installed ? green("installed") : dim("not installed"));
  log(`Scope:   ${bold(integrations[0].scope)}`);
  for (const integration of integrations) {
    const memoryNote = integration.memory.installed && !integration.memory.current
      ? " (outdated block — rerun agentify install)"
      : "";
    const hooksNote = integration.settings.supported === false
      ? dim("guidance-driven")
      : state(integration.settings.installed);
    log(`${bold(integration.provider)}: guidance ${state(integration.memory.installed)}${memoryNote}, hooks ${hooksNote}`);
  }
  log(`Context: ${bold(String(context.event_count))} event(s), ${bold(String(context.note_count))} note(s)`);
}

export async function runCli(argv, runtime = {}) {
  const args = parseArgs(argv);
  const [command = "help", subcommand] = args._;

  if (args.version) {
    process.stdout.write(`agentify v${VERSION}\n`);
    return;
  }

  if (command === "help" || args.help) {
    await printHelp();
    return;
  }

  if (command === "completion") {
    const root = path.resolve(String(args.root || process.cwd()));
    if (subcommand === "values") {
      const kind = args._[2];
      if (!kind) {
        throw new Error("completion values requires a kind: providers or skills");
      }
      await printCompletionValues(kind, { root });
      return;
    }
    process.stdout.write(generateCompletionScript(subcommand));
    return;
  }

  const root = path.resolve(String(args.root || process.cwd()));

  // Hook-invoked ctx commands run before config loading so they stay fast and
  // never fail, even outside an initialized repo.
  if (command === "ctx" && args.hook === true && (subcommand === "track" || subcommand === "load" || subcommand === "match")) {
    await runCtxHook(subcommand, root);
    return;
  }
  if (command === "ctx" && args.hook === true && subcommand === "summarize") {
    try {
      const config = await loadConfig(root, {});
      await summarizeSession(root, config, args.session, {});
    } catch {
      // Detached hook child: never fail.
    }
    return;
  }

  const config = await loadConfig(root, args);
  config._agentifyPaths = await resolveAgentifyPaths(root, config);

  if (args.json) {
    config.json = true;
    config._suppressProgress = true;
  }
  if (args.ghost) {
    config.ghost = true;
  }

  const dispatch = async () => {
    switch (command) {
      case "install":
      case "init":
        await runInstall(root, config, args);
        return;

      case "uninstall":
        await runUninstall(root, config, args);
        return;

      case "status":
        await runStatus(root, config, args);
        return;

      case "ctx":
        await runCtxCommand(root, config, args, subcommand);
        return;

      case "scan":
        await runScan(root, config, { commandName: "scan" });
        return;

      case "up":
        await runUpdate(root, config, { skipCodeBodyChanges: args.hook === true });
        return;

      case "check":
        await runValidate(root, config, { skipCodeBodyChanges: args.hook === true });
        return;

      case "query": {
        let result;
        const queryOptions = { config, artifactPaths: config._agentifyPaths };
        try {
          if (subcommand === "owner") {
            if (!args.file) throw new Error("query owner requires --file <path>");
            result = await queryOwner(root, args.file, queryOptions);
          } else if (subcommand === "deps") {
            if (!args.module) throw new Error("query deps requires --module <id>");
            result = await queryDeps(root, args.module, queryOptions);
          } else if (subcommand === "changed") {
            if (!args.since) throw new Error("query changed requires --since <commit>");
            result = await queryChanged(root, args.since, queryOptions);
          } else if (subcommand === "search") {
            result = await querySearch(root, getSearchTerm(args, "query"), queryOptions);
          } else if (subcommand === "def") {
            if (!args.symbol) throw new Error("query def requires --symbol <name>");
            result = await queryDef(root, args.symbol, queryOptions);
          } else if (subcommand === "refs") {
            if (!args.symbol) throw new Error("query refs requires --symbol <name>");
            result = await queryRefs(root, args.symbol, queryOptions);
          } else if (subcommand === "callers") {
            if (!args.symbol) throw new Error("query callers requires --symbol <name>");
            result = await queryCallers(root, args.symbol, queryOptions);
          } else if (subcommand === "impacts") {
            if (!args.file) throw new Error("query impacts requires --file <path>");
            result = await queryImpacts(root, args.file, { ...queryOptions, depth: args.depth });
          } else {
            throw new Error("query requires a subcommand: owner, deps, changed, search, def, refs, callers, or impacts");
          }
        } catch (error) {
          throwWithIndexGuidance(error, root);
        }
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      case "workflow":
      case "workflows": {
        if (subcommand === "install") {
          const result = await installWorkflow(root, args._[2] || null, {
            provider: args.provider,
            scope: args.scope,
            force: args.force,
            dryRun: config.dryRun,
            defaultProvider: config.provider,
          });
          if (config.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            success(`${result.title} workflow ${config.dryRun ? "dry-run" : "installed"} (${result.skills.length} skills)`);
            if (!result.cli_available) {
              log(`${bold("note")}: ${result.cli_hint}`);
            }
            for (const item of result.skills) {
              for (const installed of item.results || []) {
                log(`${bold(item.skill)} ${installed.provider} ${installed.status} ${dim(installed.target_dir)}`);
              }
            }
            log("");
            log(bold("The flow:"));
            for (const step of result.flow) {
              log(`  - ${step}`);
            }
          }
          return;
        }

        if (!subcommand || subcommand === "list") {
          const result = await describeWorkflows(root);
          if (config.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            if (result.detected) {
              log(`Detected platform from git remote: ${bold(result.detected)} ${dim(`(${result.remote_url})`)}`);
              log("");
            }
            for (const workflow of result.workflows) {
              const cliState = workflow.cli_available ? green(`${workflow.cli} available`) : dim(`${workflow.cli} missing`);
              log(`${bold(workflow.name.padEnd(6))} ${workflow.title}${workflow.detected ? green(" (detected)") : ""} — ${cliState}`);
              log(`       ${dim(workflow.skills.join(", "))}`);
            }
            log("");
            log(dim("Install one with: agentify workflow install [gh|glab|azure] (auto-detects from the git remote when omitted)"));
          }
          return;
        }

        throw new Error("workflow requires a subcommand: list or install");
      }

      case "models": {
        const result = await describeModelRoutes(config);
        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          log(`Provider CLIs: claude ${result.providers.claude ? green("available") : dim("missing")}, codex ${result.providers.codex ? green("available") : dim("missing")}`);
          log("");
          for (const route of result.routes) {
            log(`${bold(route.kind.padEnd(10))} ${route.provider}${route.model !== "(cli default)" ? `/${route.model}` : ""} ${dim(`→ ${route.resolves_to}`)}`);
            log(`           ${dim(route.use)}`);
          }
          log("");
          log(dim("Override routes in .agentify.yaml under models.routes."));
        }
        return;
      }

      case "delegate": {
        const kind = subcommand;
        if (!kind) {
          throw new Error('delegate requires a kind: agentify delegate <quick|implement|heavy|review|research> "task"');
        }
        const task = getPromptFromArgs(args, 2);
        const result = await runDelegate(root, config, kind, task, {
          diffRef: args.diff ? String(args.diff) : null,
          write: args.write === true,
          model: hasOwn(args, "model") ? args.model : undefined,
          provider: hasOwn(args, "provider") ? args.provider : undefined,
          timeoutMs: args.timeout ? Number(args.timeout) * 1000 : undefined,
        });
        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          log(dim(`delegated to ${result.provider}${result.model ? `/${result.model}` : ""}${result.used_fallback ? " (fallback)" : ""}`));
          log("");
          log(result.output || dim("(no output)"));
          if (result.exit_code !== 0) {
            throw new Error(`delegate ${kind} failed with exit code ${result.exit_code}${result.error ? `: ${result.error}` : ""}`);
          }
        }
        if (config.json && result.exit_code !== 0) {
          process.exitCode = 1;
        }
        return;
      }

      case "risk": {
        let result;
        try {
          result = await buildRiskReport(root, {
            since: normalizeOptionalSince(args, "risk"),
            config,
            artifactPaths: config._agentifyPaths,
          });
        } catch (error) {
          throwWithIndexGuidance(error, root);
        }
        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          log(renderRiskReport(result));
        }
        return;
      }

      case "skill":
      case "skills": {
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

      case "hooks": {
        if (subcommand === "install") {
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
        await runDoctor(root, config, { failOnStale: args.failOnStale === true });
        return;

      case "clean": {
        const result = await runClean(root, config, {
          planned: args.planned === true,
          sessions: args.sessions === true,
          all: args.all === true,
        });
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
          if (result.skipped.length > 0) {
            for (const item of result.skipped) {
              log(`Skipped ${item}`);
            }
          }
        }
        return;
      }

      default:
        throw new Error(`unknown command "${command}"`);
    }
  };

  if (config.json) {
    return withSilent(true, dispatch);
  }

  return dispatch();
}
