import path from "node:path";
import process from "node:process";

import { loadConfig, writeDefaultConfig } from "./core/config.js";
import { ensureBaselineArtifacts, runScan, runUpdate, runValidate } from "./core/commands.js";
import { installHooks, removeHooks, statusHooks } from "./core/hooks.js";
import {
  installIntegration,
  integrationStatus,
  resolveIntegrationProviders,
  uninstallIntegration,
} from "./core/integrations.js";
import { contextStatus, summarizeSession } from "./core/ctx.js";
import { runCtxCommand, runCtxHook } from "./core/cli-ctx.js";
import {
  getPromptFromArgs,
  getSearchTerm,
  hasOwn,
  normalizeOptionalSince,
  parseArgs,
} from "./core/cli-args.js";
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
import { buildTestSelection, renderTestSelection, runTestSelection } from "./core/test-select.js";
import { runMcpServer } from "./core/mcp-server.js";
import { buildStatsReport, renderStatsReport } from "./core/stats.js";
import { defaultValueReportPath, buildValueReport, renderValueHtml, renderValueReport } from "./core/value-report.js";
import { getUpstreamRef, hasDiffSince } from "./core/git.js";
import { describeModelRoutes, explainRoute, runDelegate } from "./core/models.js";
import { classifyTaskIntent } from "./core/profiles.js";
import { initEvalTask, listEvals, runEval } from "./core/eval.js";
import { importHarborJob, planHarborRun, validateHarborDataset } from "./core/harbor.js";
import {
  COMPARE_EXIT_ERROR,
  EVAL_EXPORT_FORMATS,
  buildEvalReport,
  buildPromptfooExport,
  compareEvalReports,
  renderEvalReportHtml,
  renderEvalReportMarkdown,
} from "./core/eval-report.js";
import fs from "node:fs/promises";
import { describeWorkflows, installWorkflow } from "./core/workflows.js";
import { runDoctor } from "./core/toolchain.js";
import { runClean } from "./core/cleanup.js";
import { generateCompletionScript, printCompletionValues } from "./core/completion.js";
import { buildSkillInstallHint, installAllBuiltinSkills, installBuiltinSkill, listBuiltinSkills } from "./core/skills.js";
import { VERSION, printHelp } from "./core/cli-fast-paths.js";
import { resolveAgentifyPaths } from "./core/project-store.js";
import { writePrivateText } from "./core/fs.js";
import { withSilent, bold, dim, green, success, log } from "./core/ui.js";

export { parseArgs };

// Human rendering shared by `route explain` and `delegate --dry-run`: the
// full routing decision — profile, signals, tier, limits, fallback chain,
// and the eval evidence behind it — without running anything.
function printRouteExplanation(result) {
  const policy = result.policy;
  const profile = policy.profile;
  log(`Profile: ${bold(profile.name)} (${profile.source}) — ${profile.objective} ${dim(`· ${policy.policy_version}`)}`);
  if (result.intent) {
    log(`Intent: ${result.intent.kind} ${dim(`(rule: ${result.intent.matched_rule}${result.intent.matched_text ? `, matched "${result.intent.matched_text}"` : ""})`)}`);
  } else {
    log(`Route: ${policy.kind} ${dim("(explicit)")}`);
  }
  const selected = policy.selected;
  log(`Selected: ${bold(`${selected.provider}${selected.model ? `/${selected.model}` : ""}`)} ${dim(`tier ${selected.tier} — ${selected.reason}`)}`);
  if (result.resolves_to) {
    const resolved = result.resolves_to;
    log(`Resolves to: ${resolved.provider}${resolved.model ? `/${resolved.model}` : ""}${resolved.fallback ? ` (fallback: ${resolved.fallback_reason})` : ""}`);
  } else {
    log("Resolves to: unavailable (no provider CLI installed for this chain)");
  }
  const limits = result.limits;
  const limitParts = [
    limits.max_budget_usd !== null ? `$${limits.max_budget_usd}/run` : "no $ cap",
    limits.max_turns !== null ? `${limits.max_turns} turns` : "no turn cap",
    limits.timeout_seconds !== null ? `${limits.timeout_seconds}s timeout` : null,
    ...(limits.effort ? [`effort ${limits.effort}`] : []),
  ].filter(Boolean).join(" · ");
  log(`Limits: ${limitParts} ${dim(`(source: ${result.budget_source})`)}`);
  if (Array.isArray(result.unsupported_controls) && result.unsupported_controls.length > 0) {
    log(dim(`Not enforced in-flight by this provider: ${result.unsupported_controls.join(", ")} — covered by the pre-run rolling budget check and the wall-clock timeout.`));
  }
  if (result.signals.remaining_budget_usd !== null && result.signals.remaining_budget_usd !== undefined) {
    log(`Remaining rolling budget: $${result.signals.remaining_budget_usd.toFixed(4)}`);
  }
  log(`Fallback chain ${dim(`(max tier ${policy.fallback_chain.max_tier})`)}:`);
  policy.fallback_chain.entries.forEach((entry, index) => {
    log(`  ${index + 1}. ${entry.provider}${entry.model ? `/${entry.model}` : dim("/(cli default)")} ${dim(`tier ${entry.tier} — ${entry.reason}`)}`);
  });
  const evidence = policy.evidence_summary;
  if (evidence.runs_scanned > 0 && evidence.considered.some((candidate) => candidate.evidence)) {
    log("Evidence:");
    for (const candidate of evidence.considered) {
      const stats = candidate.evidence;
      const detail = stats
        ? `${stats.passes}/${stats.attempts} pass (${stats.pass_rate !== null ? `${(stats.pass_rate * 100).toFixed(1)}%` : "n/a"})${stats.cost_per_pass_usd !== null ? ` · $${stats.cost_per_pass_usd}/pass` : ""}${stats.sufficient ? "" : " · underpowered"}`
        : "no recorded attempts";
      log(`  ${candidate.provider}${candidate.model ? `/${candidate.model}` : "/(cli default)"} (${candidate.role}): ${detail}`);
    }
  } else {
    log(dim(`Evidence: ${evidence.runs_scanned} eval run(s) scanned — no sufficient evidence, using configured defaults.`));
  }
  if (policy.alias_drift.requested_is_alias || policy.alias_drift.selected_is_alias) {
    log(dim("Alias drift: this route uses a version-independent alias or the provider CLI default; the resolved model can change across provider releases. Pin full model IDs under models.routes to remove drift."));
  }
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

export async function runCli(argv, _runtime = {}) {
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
  if (command === "ctx" && args.hook === true && (subcommand === "track" || subcommand === "load" || subcommand === "match" || subcommand === "precheck")) {
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
          const providerBits = result.provider_details.map((detail) => {
            const state = detail.installed ? green("available") : dim("missing");
            const optIn = detail.opt_in ? dim(detail.enabled_for_routing ? " (opt-in: enabled)" : " (opt-in)") : "";
            return `${detail.name} ${state}${optIn}`;
          });
          log(`Provider CLIs: ${providerBits.join(", ")}`);
          log(`Profile: ${bold(result.profile.name)} (${result.profile.source}) — ${result.profile.objective} ${dim(`· ${result.profile.policy_version}`)}`);
          if (result.budget.dailyUsd !== null || result.budget.monthlyUsd !== null) {
            const caps = [
              result.budget.dailyUsd !== null ? `daily $${result.budget.dailyUsd}` : null,
              result.budget.monthlyUsd !== null ? `monthly $${result.budget.monthlyUsd}` : null,
            ].filter(Boolean).join(", ");
            log(`Rolling caps: ${caps} (${result.budget.onLimit} at limit)`);
          }
          log("");
          for (const route of result.routes) {
            log(`${bold(route.kind.padEnd(10))} ${route.provider}${route.model !== "(cli default)" ? `/${route.model}` : ""} ${dim(`→ ${route.resolves_to}`)}`);
            log(`           ${dim(route.use)}`);
            const limits = route.limits;
            const limitParts = [
              limits.max_budget_usd !== null ? `$${limits.max_budget_usd}/run` : "no $ cap",
              limits.max_turns !== null ? `${limits.max_turns} turns` : "no turn cap",
              limits.timeout_seconds !== null ? `${limits.timeout_seconds}s timeout` : null,
              ...(limits.effort ? [`effort ${limits.effort}`] : []),
            ].filter(Boolean).join(" · ");
            const enforcement = route.unsupported_controls.length === 0
              ? "enforced natively"
              : `${route.unsupported_controls.join(" + ")} pre-run/timeout only (no in-flight stop on ${route.resolves_to.split("/")[0].replace(" (fallback)", "")})`;
            log(`           ${dim(`limits: ${limitParts} — ${enforcement}`)}`);
          }
          if (result.alias_drift_warning) {
            log("");
            log(dim(`Alias drift: ${result.alias_drift_warning}`));
          }
          log("");
          log(dim("Override routes and per-route limits in .agentify.yaml under models.routes; rolling caps under models.budget; profile under models.profile. Opt-in providers (gemini, opencode) join routing only via models.providers.<name>.enabled: true after the eval suite clears them."));
        }
        return;
      }

      case "route": {
        if (subcommand !== "explain") {
          throw new Error('route requires a subcommand: agentify route explain "<task>" [--kind <route>] [--profile <cost|balanced|performance>]');
        }
        const task = getPromptFromArgs(args, 2);
        if (!task && !hasOwn(args, "kind")) {
          throw new Error('route explain requires a task or --kind: agentify route explain "<task>"');
        }
        const result = await explainRoute(root, config, task, {
          kind: hasOwn(args, "kind") ? args.kind : undefined,
          profile: hasOwn(args, "profile") ? args.profile : undefined,
          write: args.write === true,
          diffRef: args.diff ? String(args.diff) : null,
          model: hasOwn(args, "model") ? args.model : undefined,
          provider: hasOwn(args, "provider") ? args.provider : undefined,
          maxBudgetUsd: hasOwn(args, "maxBudgetUsd") ? args.maxBudgetUsd : undefined,
          maxTurns: hasOwn(args, "maxTurns") ? args.maxTurns : undefined,
          effort: hasOwn(args, "effort") ? args.effort : undefined,
          timeoutSeconds: args.timeout ? Number(args.timeout) : undefined,
        });
        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printRouteExplanation(result);
        }
        return;
      }

      case "delegate": {
        let kind = subcommand;
        if (!kind) {
          throw new Error('delegate requires a kind: agentify delegate <auto|quick|implement|heavy|review|research> "task"');
        }
        const task = getPromptFromArgs(args, 2);
        let intent = null;
        if (kind === "auto") {
          if (!task) {
            throw new Error('delegate auto requires a task: agentify delegate auto "<task>"');
          }
          intent = classifyTaskIntent(task);
          kind = intent.kind;
        }
        const result = await runDelegate(root, config, kind, task, {
          diffRef: args.diff ? String(args.diff) : null,
          write: args.write === true,
          model: hasOwn(args, "model") ? args.model : undefined,
          provider: hasOwn(args, "provider") ? args.provider : undefined,
          timeoutMs: args.timeout ? Number(args.timeout) * 1000 : undefined,
          maxBudgetUsd: hasOwn(args, "maxBudgetUsd") ? args.maxBudgetUsd : undefined,
          maxTurns: hasOwn(args, "maxTurns") ? args.maxTurns : undefined,
          effort: hasOwn(args, "effort") ? args.effort : undefined,
          profile: hasOwn(args, "profile") ? args.profile : undefined,
          dryRun: args.dryRun === true,
        });
        if (intent && result.dry_run) {
          // Auto-routing classified the kind before runDelegate; surface the
          // matched rule in the explanation (human and JSON alike).
          result.intent = intent;
        }
        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.dry_run) {
          printRouteExplanation(result);
        } else {
          if (result.status === "budget_blocked") {
            throw new Error(`delegate ${kind} was not started: ${result.error}`);
          }
          if (intent) {
            log(dim(`auto-routed to "${kind}" (rule: ${intent.matched_rule}${intent.matched_text ? `, matched "${intent.matched_text}"` : ""})`));
          }
          log(dim(`delegated to ${result.provider}${result.model ? `/${result.model}` : ""}${result.used_fallback ? ` (fallback: ${result.fallback_reason})` : ""} · profile ${result.profile} (${result.profile_source})`));
          if (Array.isArray(result.unsupported_controls) && result.unsupported_controls.length > 0) {
            log(dim(`limits not enforced in-flight by ${result.provider}: ${result.unsupported_controls.join(", ")} (pre-run budget check + timeout still apply)`));
          }
          if (result.budget_warning) {
            log(dim(`budget warning: ${result.budget_warning}`));
          }
          log("");
          log(result.output || dim("(no output)"));
          if (result.status === "budget_stopped") {
            log("");
            log(`Run stopped by its budget ceiling (${result.budget_stop_reason}); the result above may be partial. Raise the route limit or pass --max-budget-usd/--max-turns to allow more.`);
          } else if (result.status === "timeout") {
            log("");
            log(`Run stopped by the wall-clock timeout, not by the provider. Raise timeoutSeconds on the route or pass --timeout.`);
          }
          if (result.exit_code !== 0 && result.status !== "budget_stopped") {
            throw new Error(`delegate ${kind} failed with exit code ${result.exit_code}${result.error ? `: ${result.error}` : ""}`);
          }
        }
        if (config.json && result.exit_code !== 0) {
          process.exitCode = 1;
        }
        return;
      }

      case "review": {
        // `review --push --hook` backs the opt-in pre-push git hook: review
        // outgoing commits against upstream, advisory, silent when there is
        // nothing to review.
        const isHook = args.hook === true;
        let diffRef = args.diff ? String(args.diff) : null;
        if (args.push === true) {
          diffRef = await getUpstreamRef(root);
          if (!diffRef) {
            if (!isHook) {
              log("No upstream configured; nothing to review against. Set one with `git push -u` or pass --diff <ref>.");
            }
            return;
          }
          if (!(await hasDiffSince(root, diffRef))) {
            if (!isHook) {
              log(`No changes since ${diffRef}; nothing to review.`);
            }
            return;
          }
        }
        const result = await runDelegate(root, config, "review", getPromptFromArgs(args, 1), {
          diffRef,
          maxBudgetUsd: hasOwn(args, "maxBudgetUsd") ? args.maxBudgetUsd : undefined,
          maxTurns: hasOwn(args, "maxTurns") ? args.maxTurns : undefined,
          effort: hasOwn(args, "effort") ? args.effort : undefined,
        });
        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.status === "budget_blocked") {
            if (isHook) return;
            throw new Error(`review was not started: ${result.error}`);
          }
          log(dim(`cross-vendor review by ${result.provider}${result.model ? `/${result.model}` : ""}${result.used_fallback ? " (fallback)" : ""}${diffRef ? ` — diff since ${diffRef}` : ""}`));
          log("");
          log(result.output || dim("(no output)"));
          if (result.status === "budget_stopped") {
            log("");
            log(`Review stopped by its budget ceiling (${result.budget_stop_reason}); findings above may be partial.`);
          }
          if (result.exit_code !== 0 && result.status !== "budget_stopped" && !isHook) {
            throw new Error(`review failed with exit code ${result.exit_code}${result.error ? `: ${result.error}` : ""}`);
          }
        }
        return;
      }

      case "eval": {
        if (subcommand === "init") {
          const result = await initEvalTask(root, args._[2] || "sample", config, { dryRun: config.dryRun });
          if (config.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            success(`Eval task ${config.dryRun ? "dry-run" : "created"}: ${path.relative(root, result.path)}`);
            log(`Edit the prompt, grader commands, and budgets, then preview with ${dim(`agentify eval run ${result.task.id} --dry-run`)}.`);
          }
          return;
        }

        if (subcommand === "run") {
          const taskRef = args._[2];
          // --resume reconstructs everything from the stored run; no task
          // argument is needed (or used).
          if (!taskRef && !hasOwn(args, "resume")) {
            throw new Error('eval run requires a task: agentify eval run <task-id-or-path> [--repeat N] [--dry-run], or agentify eval run --resume <run-id>');
          }
          const result = await runEval(root, config, taskRef, {
            repeat: hasOwn(args, "repeat") ? args.repeat : undefined,
            arms: hasOwn(args, "arms") ? String(args.arms) : undefined,
            dryRun: config.dryRun === true,
            resume: hasOwn(args, "resume") ? String(args.resume) : undefined,
            keepWorkspaces: args.keepWorkspaces === true,
          });
          if (config.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          if (result.dry_run) {
            log(`Eval dry-run for ${bold(result.task_id)} @ ${result.base_sha.slice(0, 12)} — no provider call was made.`);
            log(`Model ${bold(result.model)}, profile ${result.profile}, arms ${result.arms.join(" vs ")}, repeat ${result.repeat}.`);
            log(`Per-attempt ceiling: $${result.limits.max_budget_usd} / ${result.limits.max_turns} turns / ${result.limits.timeout_seconds}s.`);
            log(`Maximum possible spend: ${bold(`$${result.max_spend_usd}`)} (${result.attempts.length} attempt(s) × per-run cap).`);
            log("");
            for (const attempt of result.attempts) {
              log(`${bold(attempt.attempt_id.padEnd(18))} ${dim(attempt.argv.map((part) => (part.length > 60 ? `${part.slice(0, 57)}...` : part)).join(" "))}`);
            }
            return;
          }
          log(`Eval run ${bold(result.run_id)} — task ${result.task_id} @ ${result.base_sha.slice(0, 12)}, model ${result.model}.`);
          if (result.budget_warning) {
            log(dim(`budget warning: ${result.budget_warning}`));
          }
          if (result.version_warning) {
            log(dim(`version warning: ${result.version_warning}`));
          }
          log("");
          for (const [arm, bucket] of Object.entries(result.summary.by_arm)) {
            const passRate = bucket.pass_rate === null ? "n/a" : `${Math.round(bucket.pass_rate * 100)}%`;
            const cost = bucket.costed_attempts > 0 ? `$${bucket.cost_usd.toFixed(4)}` : "cost n/a";
            const costPerPass = bucket.cost_per_pass_usd !== null ? `, $${bucket.cost_per_pass_usd.toFixed(4)}/pass` : "";
            log(`${bold(arm.padEnd(14))} ${bucket.passes}/${bucket.attempts} passed (${passRate}), ${cost}${costPerPass}`);
          }
          log("");
          log(dim(`Artifacts: ${result.artifacts_root} (patches, provider output, per-attempt grades)`));
          return;
        }

        if (subcommand === "report") {
          const format = String(args.format || "json").trim().toLowerCase();
          if (!EVAL_EXPORT_FORMATS.includes(format)) {
            throw new Error(`eval report --format must be one of ${EVAL_EXPORT_FORMATS.join(", ")}, got "${args.format}"`);
          }
          const report = await buildEvalReport(root, config, args._[2]);
          const output = format === "md"
            ? renderEvalReportMarkdown(report)
            : format === "html"
              ? renderEvalReportHtml(report)
              : format === "promptfoo"
                ? JSON.stringify(buildPromptfooExport(report), null, 2)
                : JSON.stringify(report, null, 2);
          if (args.out && args.out !== true) {
            const outPath = path.resolve(root, String(args.out));
            await fs.writeFile(outPath, output, "utf8");
            log(`Report written to ${outPath}`);
          } else {
            console.log(output);
          }
          return;
        }

        if (subcommand === "compare") {
          // Documented exit codes for CI: 0 gates passed, 1 gate violated,
          // 2 invalid input — so a pipeline can distinguish "regression"
          // from "misconfigured comparison".
          let result;
          try {
            const [currentPath, baselinePath] = [args._[2], args._[3]];
            if (!currentPath || !baselinePath) {
              throw new Error("eval compare requires two JSON reports: agentify eval compare <current.json> <baseline.json> --fail-on '<gate>><threshold>'");
            }
            const readReport = async (file) => JSON.parse(await fs.readFile(path.resolve(root, String(file)), "utf8"));
            result = compareEvalReports(await readReport(currentPath), await readReport(baselinePath), args.failOn, { force: args.force === true });
          } catch (error) {
            process.exitCode = COMPARE_EXIT_ERROR;
            if (config.json) {
              console.log(JSON.stringify({ command: "eval", action: "compare", error: String(error.message || error), exit_code: COMPARE_EXIT_ERROR }, null, 2));
              return;
            }
            log(`eval compare failed: ${error.message}`);
            return;
          }
          process.exitCode = result.exit_code;
          if (config.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          if (result.forced) {
            log(dim(`forced past comparability issues: ${result.comparability_issues.join("; ")} — deltas may not be like-for-like`));
          }
          for (const gate of result.gates) {
            const detail = gate.status === "skipped"
              ? gate.reason
              : `baseline ${gate.baseline_value ?? "n/a"} -> current ${gate.current_value ?? "n/a"}${gate.delta !== undefined ? `, delta ${gate.delta}` : ""} (threshold ${gate.threshold})`;
            log(`${gate.status === "violated" ? bold("VIOLATED") : gate.status.padEnd(8)} ${gate.gate} [${gate.arm}] ${dim(detail)}`);
          }
          log("");
          log(result.passed ? green("All gates passed.") : `${result.violations.length} gate violation(s).`);
          return;
        }

        if (!subcommand || subcommand === "list") {
          const result = await listEvals(root, config);
          if (config.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          if (result.tasks.length === 0) {
            log("No eval tasks found. Create one with `agentify eval init <name>`.");
          } else {
            log(bold("Tasks:"));
            for (const task of result.tasks) {
              if (task.invalid) {
                log(`- ${task.path}: invalid (${task.error})`);
              } else {
                log(`- ${bold(task.id)} ${dim(`${task.model}, ${task.arms.join(" vs ")}, $${task.max_budget_usd}/attempt`)}${task.description ? ` — ${task.description}` : ""}`);
              }
            }
          }
          if (result.runs.length > 0) {
            log("");
            log(bold("Runs:"));
            for (const run of result.runs.slice(0, 10)) {
              const armBits = Object.entries(run.summary.by_arm)
                .map(([arm, bucket]) => `${arm} ${bucket.passes}/${bucket.attempts}`)
                .join(", ");
              log(`- ${bold(run.run_id)} ${run.task_id} (${run.attempts_completed}/${run.attempts_planned} attempts) ${dim(armBits)}`);
            }
          }
          return;
        }

        if (subcommand === "harbor") {
          // Harbor never becomes a runtime dependency: validate and plan are
          // token-free checks over the committed dataset, and import only
          // reads artifacts a harbor CLI run already produced (#298).
          const harborAction = args._[2];
          if (harborAction === "validate") {
            const result = await validateHarborDataset(root, config);
            if (config.json) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              log(`Harbor dataset ${bold(`${result.dataset.name}@${result.dataset.version}`)} — model ${result.dataset.model}, ${result.tasks.length} task(s).`);
              for (const task of result.tasks) {
                log(`${task.ok ? "ok      " : bold("invalid ")} ${task.id} ${dim(task.category)}${task.problems.length > 0 ? ` — ${task.problems.join("; ")}` : ""}`);
              }
              for (const problem of result.problems.filter((entry) => !result.tasks.some((task) => entry.startsWith(`${task.id}:`)))) {
                log(bold(`problem: ${problem}`));
              }
              log("");
              log(result.ok ? green("Dataset is valid.") : `${result.problems.length} problem(s) found.`);
            }
            if (!result.ok) {
              process.exitCode = 1;
            }
            return;
          }
          if (harborAction === "plan") {
            const result = await planHarborRun(root, config, { suite: hasOwn(args, "suite") ? String(args.suite) : undefined });
            if (config.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            log(`Harbor suite ${bold(result.suite)} — dataset ${result.dataset.name}@${result.dataset.version}, model ${result.model}.`);
            log(`Agents: ${result.agents.join(", ")}${result.agents_per_task > result.agents.length ? ` (${result.agents_per_task} agent variants per task)` : ""} · ${result.tasks.length} task(s) × ${result.agents_per_task} agent(s) × ${result.attempts_per_agent} attempt(s) = ${result.trials} trial(s).`);
            log(`Maximum possible spend: ${bold(`$${result.max_spend_usd}`)} (every trial capped by its task's max_cost_usd).`);
            log("");
            log(`Launch with: ${dim(result.harbor_command)}`);
            log(`Then import: ${dim(result.import_command)}`);
            if (result.confirmation_required) {
              log(dim("Paid run: confirm the maximum spend above before launching (CI=true skips this reminder)."));
            }
            return;
          }
          if (harborAction === "import") {
            const result = await importHarborJob(root, config, args._[3]);
            if (config.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            log(`Imported ${bold(String(result.runs.length))} run(s) from Harbor job ${result.job}${result.dataset ? ` (dataset ${result.dataset.name}@${result.dataset.version})` : ""}.`);
            for (const run of result.runs) {
              log(`- ${bold(run.run_id)} ${run.task_id} — ${run.attempts} attempt(s), arms ${run.arms.join(" vs ")} ${dim(`(${run.report_command})`)}`);
            }
            for (const entry of result.trials_skipped) {
              log(dim(`skipped ${entry.trial}: ${entry.reason}`));
            }
            return;
          }
          throw new Error("eval harbor requires a subcommand: validate, plan, or import (see docs/harbor.md)");
        }

        throw new Error("eval requires a subcommand: init, run, report, compare, list, or harbor");
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

      case "stats": {
        const days = args.days !== undefined ? Number(args.days) : undefined;
        if (args.days !== undefined && (!Number.isFinite(days) || days <= 0)) {
          throw new Error("stats --days requires a positive number");
        }
        const report = await buildStatsReport(root, { days });
        if (config.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          log(renderStatsReport(report));
        }
        return;
      }

      case "value": {
        const days = args.days !== undefined ? Number(args.days) : undefined;
        if (args.days !== undefined && (!Number.isInteger(days) || days <= 0)) {
          throw new Error("value --days requires a positive integer");
        }
        const requestedFormat = String(args.format || "text").toLowerCase();
        const format = config.json && requestedFormat !== "html" ? "json" : requestedFormat;
        if (!["text", "json", "html"].includes(format)) {
          throw new Error('value --format must be one of: text, json, html');
        }
        const report = await buildValueReport(root, { days, config });
        if (format === "html") {
          if (args.output === true) {
            throw new Error("value --output requires a file path");
          }
          const outputPath = args.output
            ? path.resolve(root, String(args.output))
            : defaultValueReportPath(root);
          await writePrivateText(outputPath, renderValueHtml(report, { projectName: path.basename(root) }), { privateDir: false });
          if (config.json) {
            console.log(JSON.stringify({ command: "value", format, path: outputPath, report }, null, 2));
          } else {
            success(`Agentify value report written: ${path.relative(root, outputPath) || outputPath}`);
          }
        } else if (format === "json") {
          console.log(JSON.stringify(report, null, 2));
        } else {
          log(renderValueReport(report));
        }
        return;
      }

      case "serve": {
        // MCP server over stdio: stdout is the protocol channel.
        await runMcpServer(root, config);
        return;
      }

      case "test": {
        let selection;
        try {
          selection = await buildTestSelection(root, {
            since: normalizeOptionalSince(args, "test"),
            config,
            artifactPaths: config._agentifyPaths,
          });
        } catch (error) {
          throwWithIndexGuidance(error, root);
        }
        if (args.run === true && selection.run_groups.some((group) => group.command)) {
          const outcome = await runTestSelection(root, selection);
          if (config.json) {
            console.log(JSON.stringify({ ...selection, run: outcome }, null, 2));
          } else {
            log(renderTestSelection(selection));
            log(outcome.passed ? green("Selected tests passed.") : "Some selected tests failed.");
          }
          if (!outcome.passed) {
            process.exitCode = 1;
          }
          return;
        }
        if (config.json) {
          console.log(JSON.stringify(selection, null, 2));
        } else {
          log(renderTestSelection(selection));
          if (selection.run_groups.some((group) => group.command)) {
            log(dim("Run them now with `agentify test --run`."));
          }
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
