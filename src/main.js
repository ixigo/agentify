import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { applyCavemanPreamble, resolveCavemanLevel } from "./core/caveman.js";
import { loadConfig, persistProviderPreference, writeDefaultConfig } from "./core/config.js";
import { ensureBaselineArtifacts, runDoc, runScan, runUpdate, runValidate } from "./core/commands.js";
import { runExec } from "./core/exec.js";
import { writeHandoffBundle } from "./core/handoff.js";
import { installHooks, removeHooks, statusHooks } from "./core/hooks.js";
import { buildRoutedPrompt, fetchContext, normalizeContextMode as normalizeSessionContextMode, searchContext } from "./core/context.js";
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
import { buildExecutionPlan, renderPlanExplanation } from "./core/planner.js";
import { forkSession, listSessions, maybePrepareChildSession, resolveSessionProvider, resumeSession, validateSessionId } from "./core/session.js";
import { compactSessionContext, loadAutomaticRunMemory, loadAutomaticSessionMemory } from "./core/session-memory.js";
import { runDoctor } from "./core/toolchain.js";
import { garbageCollect, cacheStatus } from "./core/cache.js";
import { runClean } from "./core/cleanup.js";
import { runSemanticRefresh } from "./core/semantic.js";
import { runIssueKiller } from "./core/issue-killer.js";
import { SUPPORTED_PROVIDERS, assertSupportedProvider, buildProviderTemplateCommand } from "./core/provider-command.js";
import { runRepoSync } from "./core/repo-sync.js";
import { buildSkillInstallHint, installAllBuiltinSkills, installBuiltinSkill, listBuiltinSkills } from "./core/skills.js";
import { runBootstrapCommand } from "./core/bootstrap.js";
import { VERSION, withSilent, bold, cyan, dim, green, success, log } from "./core/ui.js";

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
  "docs",
  "headers",
  "semantic",
  "failOnStale",
  "skipRefresh",
  "explainPlan",
  "explain",
  "allowPartial",
  "reuseSession",
  "hook",
  "withContext",
  "continue",
]);

const DEFAULT_SESSION_TASK = "Continue this session from the latest repository state.";
const CAVEMAN_FLAG_VALUES = new Set([
  "lite",
  "full",
  "ultra",
  "wenyan",
  "wenyan-lite",
  "wenyan-full",
  "wenyan-ultra",
  "true",
  "false",
  "1",
  "0",
  "off",
  "normal",
  "none",
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

async function maybePersistProvider(root, config, args, command, subcommand) {
  if (command === "skill" || command === "skills") {
    return;
  }

  if (!hasOwn(args, "provider")) {
    return;
  }

  const provider = normalizeProvider(args.provider);
  config.provider = provider;

  if (isProviderStickyCommand(command, subcommand)) {
    await persistProviderPreference(root, provider, { dryRun: config.dryRun });
  }
}

function getExecFlags(args, extras = {}) {
  return {
    failOnStale: args.failOnStale || false,
    timeout: args.timeout || null,
    skipRefresh: args.skipRefresh || false,
    skipCodeBodyChanges: args.hook === true,
    ...extras,
  };
}

function isMissingIndexError(error) {
  return error instanceof Error && /missing index database at /.test(error.message);
}

function createMissingIndexGuidance(root) {
  return new Error(
    `Agentify index missing for ${root}. Run "agentify scan --root ${root}" or "agentify up --root ${root}" before using plan/query/context commands.`
  );
}

function getSearchTerm(args, commandName) {
  const term = args.term === undefined ? args._[2] : args.term;
  if (!term || term === true) {
    throw new Error(`${commandName} search requires --term <value> or a positional search term`);
  }
  return String(term);
}

export function getProviderTemplateOptions(args, root, provider, usingTemplateCommand) {
  const interactiveByDefault = usingTemplateCommand;
  const interactive = hasOwn(args, "interactive") ? args.interactive === true : interactiveByDefault;

  return {
    root,
    interactive,
  };
}

export function getSessionCaptureSettings(usingTemplateCommand, providerOptions) {
  if (!usingTemplateCommand) {
    return {
      captureOutputMode: "inherit",
      captureMode: "interactive-inherit",
    };
  }

  return providerOptions.interactive
    ? {
      captureOutputMode: "pty",
      captureMode: "interactive-pty",
    }
    : {
      captureOutputMode: "pipe",
      captureMode: "captured-pipe",
    };
}

function getPromptFromArgs(args, startIndex) {
  return args._.slice(startIndex).join(" ").trim();
}

function buildRunPrompt(userPrompt) {
  return String(userPrompt || "").trim();
}

async function promptForRunTask(runtime = {}) {
  const ask = runtime.prompt || runtime.ask;
  if (ask) {
    return String(await ask("Task: ")).trim();
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('agentify run requires a task. Pass one as `agentify run "task"`.');
  }

  const prompts = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return String(await prompts.question("Task: ")).trim();
  } finally {
    prompts.close();
  }
}

async function resolveRunTask(args, startIndex, runtime = {}) {
  const task = buildRunPrompt(getPromptFromArgs(args, startIndex));
  if (task) {
    return task;
  }

  const promptedTask = await promptForRunTask(runtime);
  if (!promptedTask) {
    throw new Error('agentify run requires a non-empty task. Pass one as `agentify run "task"`.');
  }
  return promptedTask;
}

function normalizeRunContextMode(value, { fallback = "compact" } = {}) {
  const raw = value === undefined || value === null || value === false
    ? fallback
    : value;
  const mode = String(raw).trim().toLowerCase();
  if (mode === "compact" || mode === "direct") {
    return "compact";
  }
  if (mode === "routed") {
    return "routed";
  }
  throw new Error(`--context-mode must be "compact", "direct", or "routed", received "${raw}".`);
}

export function resolveRunContextMode(args = {}, config = {}) {
  return normalizeRunContextMode(
    hasOwn(args, "contextMode") ? args.contextMode : config?.context?.mode,
    { fallback: "compact" },
  );
}

function buildRoutedExecutionPrompt(task, memoryMarkdown = "", options = {}) {
  return applyCavemanPreamble(buildRoutedPrompt(task, memoryMarkdown), options.caveman, { promptKind: options.promptKind });
}

export function buildExecutionPrompt(basePrompt, memoryMarkdown = "", options = {}) {
  const prompt = String(basePrompt || "").trim();
  const promptWithMemory = [memoryMarkdown.trim(), prompt].filter(Boolean).join("\n\n");
  return applyCavemanPreamble(promptWithMemory, options.caveman, { promptKind: options.promptKind });
}

export function buildMinimalRunPrompt(userPrompt, options = {}) {
  const task = buildRunPrompt(userPrompt);
  if (!task) {
    throw new Error("buildMinimalRunPrompt requires a non-empty task");
  }
  const prompt = [
    "You are running inside an Agentify-prepared repository.",
    "Follow the user's task. Load repo docs or installed skills only when they are needed or explicitly invoked.",
    "",
    `Task: ${task}`,
  ].join("\n");
  return applyCavemanPreamble(prompt, options.caveman, { promptKind: options.promptKind });
}

export function buildSessionPrompt(bootstrap, userPrompt, memoryMarkdown = "", options = {}) {
  const task = userPrompt || DEFAULT_SESSION_TASK;
  const sections = [
    "You are continuing an Agentify session.",
    "",
    bootstrap.trim(),
  ];
  if (memoryMarkdown.trim()) {
    sections.push("", memoryMarkdown.trim());
  }
  sections.push("", `Current task: ${task}`);
  return applyCavemanPreamble(sections.join("\n"), options.caveman, { promptKind: options.promptKind });
}

export async function prepareSessionLaunch(root, config, args, sessionResult, task) {
  const memoryQuery = task || sessionResult.manifest.name || "";
  const memoryContext = await loadAutomaticSessionMemory(root, sessionResult.manifest, config, memoryQuery);
  const caveman = resolveCavemanLevel(args);
  const provider = hasOwn(args, "provider")
    ? normalizeProvider(args.provider)
    : normalizeProvider(resolveSessionProvider(sessionResult.manifest, config.provider));
  const usingTemplateCommand = !args._exec?.length;
  const providerOptions = getProviderTemplateOptions(args, root, provider, usingTemplateCommand);
  const captureSettings = getSessionCaptureSettings(usingTemplateCommand, providerOptions);
  const contextMode = hasOwn(args, "contextMode") ? normalizeSessionContextMode(args.contextMode) : "direct";
  const prompt = contextMode === "routed"
    ? buildRoutedExecutionPrompt(`${task || DEFAULT_SESSION_TASK}\n\nSession bootstrap:\n${sessionResult.bootstrap.trim()}`, memoryContext.markdown, { caveman })
    : buildSessionPrompt(sessionResult.bootstrap, task, memoryContext.markdown, { caveman });
  const agentCommand = args._exec?.length
    ? args._exec
    : buildProviderTemplateCommand(
      provider,
      prompt,
      providerOptions,
    );
  const sessionRecord = {
    sessionId: sessionResult.manifest.session_id,
    provider,
    prompt,
    task: task || DEFAULT_SESSION_TASK,
    command: agentCommand,
    memoryContext,
    captureMode: captureSettings.captureMode,
    contextMode,
  };

  return {
    provider,
    memoryContext,
    prompt,
    captureSettings,
    agentCommand,
    sessionRecord,
    runExecConfig: { ...config, provider },
    runExecFlags: getExecFlags(args, {
      captureOutputMode: captureSettings.captureOutputMode,
      sessionRecord,
      commandName: `sess ${args._?.[1] || "run"}`,
      skipCodeBodyChanges: true,
    }),
  };
}

function resolveSessionIdForResume(args) {
  if (args.session) {
    return { sessionId: validateSessionId(String(args.session), "--session id"), promptStartIndex: 2 };
  }
  const positional = args._[2];
  if (positional) {
    return { sessionId: validateSessionId(String(positional), "session id"), promptStartIndex: 3 };
  }
  throw new Error("sess resume requires --session <id> or sess resume <id>");
}

async function maybePrintPreparedChild(root, config, launch) {
  const child = await maybePrepareChildSession(root, config, launch.sessionRecord.sessionId, {
    provider: launch.provider,
  });
  if (child && !config.json) {
    success(`Prepared child session: ${child.child_session_id}`);
    log(`Resume: ${dim(child.resume_command)}`);
  }
  return child;
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
    `    ${c("up")}              ${d("Run scan -> optional doc -> check -> test pipeline")}`,
    `    ${c("sync")}            ${d("Upgrade repo-owned Agentify files, then run refresh")}`,
    `    ${c("check")}           ${d("Validate freshness, schemas, and safety rules")}`,
    `    ${c("plan")}            ${d("Preview the planner-selected context for a task")}`,
    `    ${c("context")}         ${d("Search indexed context and fetch exact bounded file slices")}`,
    `    ${c("run")}             ${d("Run provider template command with auto-refresh")}`,
    `    ${c("exec")}            ${d("Advanced wrapper for custom agent commands")}`,
    `    ${c("this")}            ${d("Bootstrap this macOS repo for a provider-backed Agentify workflow")}`,
    `    ${c("context")}         ${d("Search, fetch, compact, and inspect routed context")}`,
    `    ${c("query")}           ${d("Query the repository index (owner, deps, changed, def, refs, callers, impacts)")}`,
    `    ${c("risk")}            ${d("Score PR blast radius and recommend regression tests")}`,
    `    ${c("skill")}           ${d("Manage built-in agent skills")}`,
    `    ${c("sess")}            ${d("Manage provider-backed sessions")}`,
    `    ${c("handoff")}         ${d("Write a cross-agent handoff bundle for a session")}`,
    `    ${c("memory")}          ${d("Manage agent memory helpers")}`,
    `    ${c("issue-killer")}    ${d("Launch labelled GitHub issues into supervised tmux worktrees")}`,
    `    ${c("hooks")}           ${d("Install/remove git hooks")}`,
    `    ${c("doctor")}          ${d("Check toolchain health and capability tier")}`,
    `    ${c("semantic")}        ${d("Refresh semantic project facts")}`,
    `    ${c("clean")}           ${d("Prune stale generated artifacts and dead Agentify folders")}`,
    `    ${c("cache")}           ${d("Manage the content cache")}`,
    ``,
    `  ${bold("OPTIONS")}`,
    ``,
    `    ${c("--provider")} ${d(`<${SUPPORTED_PROVIDERS.join("|")}>`)}`,
    `                         ${d("skill install also accepts comma lists and all")}`,
    `    ${c("--strict")} ${d("<true|false>")}         Fail closed on validation issues`,
    `    ${c("--languages")} ${d("<auto|ts|python|go|rust|dotnet|java|kotlin|swift>")}`,
    `    ${c("--dry-run")}                   Report planned changes without writing`,
    `    ${c("--docs")}                      Generate docs during refresh/update flows (on by default; use --docs=false to skip)`,
    `    ${c("--headers")}                   Apply @agentify headers to source files (off by default)`,
    `    ${c("--semantic")}                  Show detailed semantic diagnostics with doctor`,
    `    ${c("--provider-timeout-ms")} ${d("<ms>")}     Fail provider doc calls after N milliseconds`,
    `    ${c("--ghost")}                     Route outputs to .current_session/`,
    `    ${c("--json")}                      Machine-readable JSON output only`,
    `    ${c("--explain")}                   Include planner score breakdowns for plan output`,
    `    ${c("--interactive")}, ${c("-i")}       Force interactive mode (template providers default to interactive for run/sess)`,
    `    ${c("--continue")}                  Resume the provider's most recent session for run`,
    `    ${c("--context-mode")} ${d("<compact|routed>")}  Use compact prompts or routed bounded retrieval prompts`,
    `    ${c("--with-context")}              Inject planner-selected files, tests, and memory into run`,
    `    ${c("--context-mode")} ${d("<direct|routed>")}     Use routed context retrieval for run/sess prompts`,
    `    ${c("--explain-plan")}              Print planner output before executing run`,
    `    ${c("--caveman[=level]")}            Terse output for run/sess (lite, full, ultra, wenyan*)`,
    `    ${c("--root")} ${d("<path>")}               Target repo root (default: cwd)`,
    `    ${c("--scope")} ${d("<project|user>")}      Skill install scope (skill command)`,
    `    ${c("--hook")}                      Hook-friendly validation for check/up: skip source body diffing`,
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
    `    ${d("$")} agentify this --provider codex`,
    `    ${d("$")} agentify up --provider codex`,
    `    ${d("$")} agentify sync`,
    `    ${d("$")} agentify clean --dry-run`,
    `    ${d("$")} agentify run --provider codex "implement payment retries"`,
    `    ${d("$")} agentify run --provider codex --caveman=ultra "summarize auth risks"`,
    `    ${d("$")} agentify run --provider codex --interactive "fix auth bug"`,
    `    ${d("$")} agentify context search analytics`,
    `    ${d("$")} agentify context fetch src/analytics/report.ts --symbol buildReport`,
    `    ${d("$")} agentify context fetch src/analytics/report.ts --lines 20:60`,
    `    ${d("$")} agentify risk --since origin/main`,
    `    ${d("$")} agentify risk --json`,
    `    ${d("$")} agentify skill list`,
    `    ${d("$")} agentify skill install all --provider codex --scope project`,
    `    ${d("$")} agentify skill install grill-me --provider claude --scope project`,
    `    ${d("$")} agentify skill install god-mode --provider all --scope project`,
    `    ${d("$")} agentify memory compress AGENTIFY.md`,
    `    ${d("$")} agentify sess run --provider codex --name "payments-v2" "add tests"`,
    `    ${d("$")} agentify sess run --provider codex --interactive --name "payments-v2" "continue in Codex TUI"`,
    `    ${d("$")} agentify handoff --session sess_20260101000000_abcdef "continue payments-v2"`,
    `    ${d("$")} agentify issue-killer --label agentify-ready --agent-provider codex --limit 5`,
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
    if (key === "caveman") {
      const next = argv[index + 1];
      if (next && !next.startsWith("--") && CAVEMAN_FLAG_VALUES.has(String(next).trim().toLowerCase())) {
        args[key] = parseValue(next);
        index += 1;
      } else {
        args[key] = true;
      }
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

export async function runCli(argv, runtime = {}) {
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

  if (command === "this") {
    await runBootstrapCommand(args);
    return;
  }

  const root = path.resolve(String(args.root || process.cwd()));
  const config = await loadConfig(root, args);

  if (args.json) {
    config.json = true;
    config._suppressProgress = true;
  }
  if (args.ghost) {
    config.ghost = true;
  }

  const dispatch = async () => {
    await maybePersistProvider(root, config, args, command, subcommand);

    switch (command) {
      case "init":
        await writeDefaultConfig(root, config, { dryRun: config.dryRun });
        await ensureBaselineArtifacts(root, config);
        const skillInstallHint = buildSkillInstallHint(config.provider, "project");
        if (config.json) {
          console.log(JSON.stringify({
            command: "init",
            root,
            dry_run: Boolean(config.dryRun),
            wrote: config.dryRun ? [] : [".agentify.yaml", ".gitignore", ".agentignore", ".guardrails", ".agentify/work", ".agents", "docs/modules"],
            skill_install_hint: skillInstallHint,
          }, null, 2));
        } else {
          success("Initialized agentify artifacts");
          log(skillInstallHint.message);
        }
        return;

      case "index":
        await runScan(root, config, { commandName: "index" });
        return;

      case "scan":
        await runScan(root, config, { commandName: "scan" });
        return;

      case "doc":
        await runDoc(root, config);
        return;

      case "up":
        await runUpdate(root, config, { skipCodeBodyChanges: args.hook === true });
        return;

      case "sync":
        await runRepoSync(root, config, { provider: args.provider });
        return;

      case "check":
        await runValidate(root, config, { skipCodeBodyChanges: args.hook === true });
        return;

      case "plan": {
        const task = buildRunPrompt(getPromptFromArgs(args, 1));
        const contextMode = normalizeRunContextMode(args.contextMode, { fallback: "compact" });
        const includeSource = contextMode !== "routed" || args.withContext === true;
        let plan;
        try {
          plan = await buildExecutionPlan(root, config, task, {
            explain: args.explain === true,
            contextMode: contextMode === "routed" ? "routed" : "selected",
            includeSource,
          });
        } catch (error) {
          if (isMissingIndexError(error)) {
            throw createMissingIndexGuidance(root);
          }
          throw error;
        }
        if (args.explain === true && !args.json) {
          process.stdout.write(renderPlanExplanation(plan));
        } else {
          console.log(JSON.stringify(plan, null, 2));
        }
        return;
      }

      case "run": {
        const task = await resolveRunTask(args, 1, runtime);
        const caveman = resolveCavemanLevel(args);
        const usingTemplateCommand = !args._exec?.length;
        const providerOptions = {
          ...getProviderTemplateOptions(args, root, config.provider, usingTemplateCommand),
          continueSession: args.continue === true,
        };
        const contextMode = resolveRunContextMode(args, config);
        const usesManagedContext = usingTemplateCommand && (
          contextMode === "routed"
          || providerOptions.interactive !== true
          || args.withContext === true
          || args.explainPlan === true
        );
        const includeSource = contextMode !== "routed" || args.withContext === true;
        const memoryContext = usesManagedContext
          ? await loadAutomaticRunMemory(root, task, config)
          : { markdown: "" };
        const plan = usesManagedContext
          ? await buildExecutionPlan(root, config, task, {
            contextMode: contextMode === "routed" ? "routed" : "selected",
            includeSource,
          })
          : null;
        if (args.explainPlan && plan) {
          console.log(JSON.stringify(plan, null, 2));
        }
        const prompt = usesManagedContext
          ? buildExecutionPrompt(plan?.prompt || task, memoryContext.markdown, { caveman })
          : buildMinimalRunPrompt(task, { caveman });
        const agentCommand = args._exec?.length
          ? args._exec
          : buildProviderTemplateCommand(
            config.provider,
            prompt,
            providerOptions,
          );

        await runExec(root, config, agentCommand, getExecFlags(args, {
          commandName: "run",
          skipCodeBodyChanges: true,
        }));
        return;
      }

      case "context": {
        let result;
        try {
          if (subcommand === "search") {
            const term = args.term || getPromptFromArgs(args, 2);
            result = await searchContext(root, term);
          } else if (subcommand === "fetch") {
            const target = args._[2] || args.file || args.path;
            if (!target) {
              throw new Error("context fetch requires <path>");
            }
            result = await fetchContext(root, target, {
              lines: args.lines,
              symbol: args.symbol,
            });
          } else if (subcommand === "compact") {
            if (!args.session) {
              throw new Error("context compact requires --session <id>");
            }
            result = await compactSessionContext(root, validateSessionId(String(args.session), "--session id"), config);
          } else if (subcommand === "status") {
            if (!args.session) {
              throw new Error("context status requires --session <id>");
            }
            const sessionId = validateSessionId(String(args.session), "--session id");
            const session = await resumeSession(root, sessionId);
            result = {
              command: "context status",
              session_id: sessionId,
              provider: resolveSessionProvider(session.manifest, null),
              context_bytes: Buffer.byteLength(JSON.stringify(session.context, null, 2), "utf8"),
              run_history_count: Array.isArray(session.context.run_history) ? session.context.run_history.length : 0,
              has_context_facts: Boolean(session.context.context_facts),
              prepared_child_session: session.manifest.prepared_child_session || null,
            };
          } else {
            throw new Error("context requires a subcommand: search, fetch, compact, or status");
          }
        } catch (error) {
          if (isMissingIndexError(error)) {
            throw createMissingIndexGuidance(root);
          }
          throw error;
        }
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      case "exec": {
        const agentCommand = args._exec || [];
        if (agentCommand.length === 0) {
          throw new Error("exec requires a command after --: agentify exec [flags] -- <command...>");
        }
        await runExec(root, config, agentCommand, getExecFlags(args, {
          commandName: "exec",
          skipCodeBodyChanges: true,
        }));
        return;
      }

      case "issue-killer":
        await runIssueKiller(root, config, args);
        return;

      case "handoff": {
        let sessionId = args.session ? validateSessionId(String(args.session), "--session id") : null;
        let promptStartIndex = 1;
        if (!sessionId && args._[1]) {
          sessionId = validateSessionId(String(args._[1]), "session id");
          promptStartIndex = 2;
        }
        if (!sessionId) {
          const sessions = await listSessions(root);
          if (sessions.length === 0) {
            throw new Error("handoff requires --session <id> when no sessions exist");
          }
          sessionId = validateSessionId(String(sessions[0].session_id), "session id");
        }

        const task = getPromptFromArgs(args, promptStartIndex);
        const result = await writeHandoffBundle(root, config, sessionId, task);
        if (config.json) {
          console.log(JSON.stringify({
            command: "handoff",
            session_id: sessionId,
            markdown_path: result.relativeMarkdownPath,
            json_path: result.relativeJsonPath,
            bundle: result.bundle,
          }, null, 2));
        } else {
          success(`Handoff written for ${sessionId}`);
          log(`Markdown: ${dim(result.relativeMarkdownPath)}`);
          log(`JSON: ${dim(result.relativeJsonPath)}`);
        }
        return;
      }

      case "query": {
        let result;
        try {
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
            result = await querySearch(root, getSearchTerm(args, "query"));
          } else if (subcommand === "def") {
            if (!args.symbol) throw new Error("query def requires --symbol <name>");
            result = await queryDef(root, args.symbol);
          } else if (subcommand === "refs") {
            if (!args.symbol) throw new Error("query refs requires --symbol <name>");
            result = await queryRefs(root, args.symbol);
          } else if (subcommand === "callers") {
            if (!args.symbol) throw new Error("query callers requires --symbol <name>");
            result = await queryCallers(root, args.symbol);
          } else if (subcommand === "impacts") {
            if (!args.file) throw new Error("query impacts requires --file <path>");
            result = await queryImpacts(root, args.file, { depth: args.depth });
          } else {
            throw new Error("query requires a subcommand: owner, deps, changed, search, def, refs, callers, or impacts");
          }
        } catch (error) {
          if (isMissingIndexError(error)) {
            throw createMissingIndexGuidance(root);
          }
          throw error;
        }
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      case "risk": {
        let result;
        try {
          result = await buildRiskReport(root, {
            since: normalizeOptionalSince(args, "risk"),
          });
        } catch (error) {
          if (isMissingIndexError(error)) {
            throw createMissingIndexGuidance(root);
          }
          throw error;
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

      case "memory": {
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
          const fromId = args.from ? validateSessionId(String(args.from), "--from id") : null;
          const result = await forkSession(root, config, {
            from: fromId,
            provider: args.provider || null,
            name: args.name || null,
          });
          const task = getPromptFromArgs(args, 2);
          const launch = await prepareSessionLaunch(root, config, args, result, task);

          if (!config.json) {
            success(`Session forked: ${result.manifest.session_id}`);
            log(`Path: ${dim(result.sessionDir)}`);
          }

          await runExec(root, launch.runExecConfig, launch.agentCommand, launch.runExecFlags);
          await maybePrintPreparedChild(root, config, launch);
          return;
        }

        if (subcommand === "resume") {
          const { sessionId, promptStartIndex } = resolveSessionIdForResume(args);
          const result = await resumeSession(root, sessionId);
          const task = getPromptFromArgs(args, promptStartIndex);
          const launch = await prepareSessionLaunch(root, config, args, result, task);

          await runExec(root, launch.runExecConfig, launch.agentCommand, launch.runExecFlags);
          await maybePrintPreparedChild(root, config, launch);
          return;
        }

        if (subcommand === "run") {
          let sessionResult;
          let sessionDir;

          if (args.session) {
            sessionResult = await resumeSession(root, validateSessionId(String(args.session), "--session id"));
          } else {
            const fromId = args.from ? validateSessionId(String(args.from), "--from id") : null;
            const created = await forkSession(root, config, {
              from: fromId,
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

          const task = getPromptFromArgs(args, 2);
          const launch = await prepareSessionLaunch(root, config, args, sessionResult, task);

          if (config.json && sessionDir) {
            console.log(JSON.stringify({ ...sessionResult.manifest, session_dir: sessionDir }, null, 2));
          }

          await runExec(root, launch.runExecConfig, launch.agentCommand, launch.runExecFlags);
          await maybePrintPreparedChild(root, config, launch);
          return;
        }

        throw new Error("sess requires a subcommand: run, fork, list, or resume");
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
        await runDoctor(root, config, { semantic: args.semantic === true, failOnStale: args.failOnStale === true });
        return;

      case "semantic":
        if (subcommand && subcommand !== "refresh") {
          throw new Error("semantic requires the refresh subcommand: agentify semantic refresh");
        }
        await runSemanticRefresh(root, config);
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
  };

  if (config.json) {
    return withSilent(true, dispatch);
  }

  return dispatch();
}
