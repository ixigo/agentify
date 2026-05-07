import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

export const VERSION = pkg.version;

function agentifyArgsBeforePassthrough(args) {
  const passthroughIndex = args.indexOf("--");
  return passthroughIndex === -1 ? args : args.slice(0, passthroughIndex);
}

function hasColor() {
  return !process.env.NO_COLOR && process.stderr.isTTY;
}

function bold(msg) {
  return hasColor() ? `\u001b[1m${msg}\u001b[22m` : msg;
}

function cyan(msg) {
  return hasColor() ? `\u001b[36m${msg}\u001b[39m` : msg;
}

function dim(msg) {
  return hasColor() ? `\u001b[2m${msg}\u001b[22m` : msg;
}

export function isHelpRequest(args) {
  const agentifyArgs = agentifyArgsBeforePassthrough(args);
  return agentifyArgs.includes("--help") || agentifyArgs.includes("-h") || agentifyArgs[0] === "help" || agentifyArgs.length === 0;
}

export function isVersionRequest(args) {
  const agentifyArgs = agentifyArgsBeforePassthrough(args);
  return agentifyArgs.includes("--version") || agentifyArgs.includes("-v") || agentifyArgs.includes("-V");
}

export async function printHelp() {
  const { SUPPORTED_PROVIDERS } = await import("./provider-command.js");
  const { CONTEXT_MODE_DESCRIPTION, CONTEXT_MODE_HELP_LABEL } = await import("./context-mode.js");
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
    `    ${c("context")}         ${d("Search, fetch, compact, and inspect routed context")}`,
    `    ${c("run")}             ${d("Run provider template command with auto-refresh")}`,
    `    ${c("afk")}             ${d("Create and run fresh-session autonomous plans")}`,
    `    ${c("exec")}            ${d("Advanced wrapper for custom agent commands")}`,
    `    ${c("this")}            ${d("Bootstrap this macOS repo for a provider-backed Agentify workflow")}`,
    `    ${c("query")}           ${d("Query the repository index (owner, deps, changed, def, refs, callers, impacts)")}`,
    `    ${c("risk")}            ${d("Score PR blast radius and recommend regression tests")}`,
    `    ${c("skill")}           ${d("Manage built-in agent skills")}`,
    `    ${c("sess")}            ${d("Manage provider-backed sessions")}`,
    `    ${c("handoff")}         ${d("Write a cross-agent handoff bundle for a session")}`,
    `    ${c("memory")}          ${d("Manage agent memory helpers")}`,
    `    ${c("issue-killer")}    ${d("Launch labelled GitHub issues into supervised tmux worktrees")}`,
    `    ${c("hooks")}           ${d("Install/remove git hooks")}`,
    `    ${c("doctor")}          ${d("Check setup readiness, provider CLIs, and capability tier")}`,
    `    ${c("semantic")}        ${d("Refresh semantic project facts")}`,
    `    ${c("clean")}           ${d("Prune stale generated artifacts and dead Agentify folders")}`,
    `    ${c("cache")}           ${d("Manage the content cache")}`,
    `    ${c("completion")}      ${d("Generate shell completion scripts")}`,
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
    `    ${c("--resume")}                    Alias for run --continue; with session/sess, resume Agentify session context`,
    `    ${c("--context-mode")} ${d(CONTEXT_MODE_HELP_LABEL)}  ${CONTEXT_MODE_DESCRIPTION}`,
    `    ${c("--with-context")}              Inject planner-selected files, tests, and memory into run`,
    `    ${c("--bypass-permissions")}        Explicitly bypass provider permission prompts for issue-killer panes`,
    `    ${c("--explain-plan")}              Print planner output before executing run`,
    `    ${c("--current-worktree")}          Run AFK execution in the current checkout instead of an isolated worktree`,
    `    ${c("--allow-dirty")}               Allow AFK current-worktree execution with local changes`,
    `    ${c("--no-commit")}                 Do not auto-commit successful AFK worktree changes`,
    `    ${c("--cleanup")} ${d("<keep|delete|ask>")}  Choose AFK plan cleanup after run`,
    `    ${c("--planned")}                   Prune AFK planned artifacts with clean`,
    `    ${c("--sessions")}                  Prune AFK session artifacts with clean`,
    `    ${c("--all")}                       Include all optional clean artifact groups`,
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
    `    ${d("$")} agentify run --provider codex`,
    `    ${d("$")} agentify run --provider codex "implement payment retries"`,
    `    ${d("$")} agentify run --provider codex --resume`,
    `    ${d("$")} agentify afk create --provider codex "add checkout retries"`,
    `    ${d("$")} agentify afk run .agentify/planned/checkout-retries.md`,
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
    `    ${d("$")} agentify sess run --provider codex --name "payments-v2"`,
    `    ${d("$")} agentify sess run --provider codex --name "payments-v2" "add tests"`,
    `    ${d("$")} agentify sess run --provider codex --interactive --name "payments-v2" "continue in Codex TUI"`,
    `    ${d("$")} agentify handoff --session sess_20260101000000_abcdef "continue payments-v2"`,
    `    ${d("$")} agentify issue-killer --label agentify-ready --agent-provider codex --limit 5`,
    `    ${d("$")} agentify issue-killer --label agentify-ready --agent-provider codex --bypass-permissions`,
    `    ${d("$")} agentify completion zsh`,
    `    ${d("$")} agentify exec -- codex exec "fix auth bug"`,
    ``,
  ];

  process.stderr.write(lines.join("\n") + "\n");
}

export async function handleFastPath(args) {
  if (isVersionRequest(args)) {
    process.stdout.write(`agentify v${VERSION}\n`);
    return true;
  }
  if (isHelpRequest(args)) {
    await printHelp();
    return true;
  }
  return false;
}
