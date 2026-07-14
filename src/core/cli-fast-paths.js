import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

export const VERSION = pkg.version;

function hasColor() {
  return !process.env.NO_COLOR && process.stderr.isTTY;
}

function bold(msg) {
  return hasColor() ? `[1m${msg}[22m` : msg;
}

function cyan(msg) {
  return hasColor() ? `[36m${msg}[39m` : msg;
}

function dim(msg) {
  return hasColor() ? `[2m${msg}[22m` : msg;
}

export function isHelpRequest(args) {
  return args.includes("--help") || args.includes("-h") || args[0] === "help" || args.length === 0;
}

export function isVersionRequest(args) {
  return args.includes("--version") || args.includes("-v") || args.includes("-V");
}

export async function printHelp() {
  const c = (s) => bold(cyan(s));
  const d = (s) => dim(s);

  const lines = [
    `  ${bold("COMMANDS")}`,
    ``,
    `    ${c("install")}         ${d("Install Agentify into this repo: agent guidance + hooks (alias: init)")}`,
    `    ${c("uninstall")}       ${d("Remove the Agentify agent integration")}`,
    `    ${c("status")}          ${d("Show integration and context-tracking status")}`,
    `    ${c("ctx")}             ${d("Context tracking: load, match, explain, precheck, note, decision(s), summarize, share, track, status, handoff, pause, resume, clear")}`,
    `    ${c("delegate")}        ${d("Shell a task out to the right model: auto, quick, implement, heavy, review, research")}`,
    `    ${c("route")}           ${d("Explain the routing decision for a task without running it: explain")}`,
    `    ${c("models")}          ${d("Show the model routing table, active profile, and provider availability")}`,
    `    ${c("eval")}            ${d("Paired Agentify+Claude vs plain-Claude benchmarks: init, run, report, compare, list")}`,
    `    ${c("workflow")}        ${d("Prebuilt platform workflows for GitHub, GitLab, and Azure DevOps: list, install")}`,
    `    ${c("scan")}            ${d("Build the SQLite repository index")}`,
    `    ${c("up")}              ${d("Run scan -> check")}`,
    `    ${c("check")}           ${d("Validate index freshness and generated artifacts")}`,
    `    ${c("query")}           ${d("Query the repository index (owner, deps, changed, def, refs, callers, impacts)")}`,
    `    ${c("risk")}            ${d("Score PR blast radius and recommend regression tests")}`,
    `    ${c("test")}            ${d("Select and run only the tests affected by a change (--since, --run)")}`,
    `    ${c("serve")}           ${d("MCP server over stdio: ctx/query/risk/test tools for any MCP-capable agent")}`,
    `    ${c("stats")}           ${d("Session and delegation usage: runs, tokens, cost by kind and model (--days)")}`,
    `    ${c("value")}           ${d("Evidence-backed impact report: context, guardrails, delegation, focused tests (--days, --format)")}`,
    `    ${c("review")}          ${d("Cross-vendor review of a change (--diff <ref>, --push for outgoing commits)")}`,
    `    ${c("skill")}           ${d("Manage built-in agent skills")}`,
    `    ${c("hooks")}           ${d("Install/remove git hooks")}`,
    `    ${c("doctor")}          ${d("Check setup readiness, provider CLIs, and capability tier")}`,
    `    ${c("clean")}           ${d("Prune stale generated artifacts and dead Agentify folders")}`,
    `    ${c("completion")}      ${d("Generate shell completion scripts")}`,
    ``,
    `  ${bold("OPTIONS")}`,
    ``,
    `    ${c("--global")}                    Install/uninstall against ~/.claude or ~/.codex instead of the project`,
    `    ${c("--provider")} ${d("<claude|codex|all>")}  Agent integration for install/uninstall/status (default: claude)`,
    `    ${c("--strict")} ${d("<true|false>")}         Fail closed on validation issues`,
    `    ${c("--languages")} ${d("<auto|ts|python|go|rust|dotnet|java|kotlin|swift>")}`,
    `    ${c("--dry-run")}                   Report planned changes without writing`,
    `    ${c("--ghost")}                     Route outputs to .current_session/`,
    `    ${c("--json")}                      Machine-readable JSON output only`,
    `    ${c("--format")} ${d("<text|json|html>")}     Value report format (default: text)`,
    `    ${c("--output")} ${d("<path>")}              Value HTML output path`,
    `    ${c("--max-budget-usd")} ${d("<usd>")}      Per-run dollar ceiling for delegate/review (overrides the route limit)`,
    `    ${c("--max-turns")} ${d("<n>")}             Per-run agent-turn ceiling for delegate/review`,
    `    ${c("--effort")} ${d("<level>")}            Model effort level for delegate/review (provider-dependent)`,
    `    ${c("--profile")} ${d("<cost|balanced|performance>")}  Optimization profile for delegate/route (or AGENTIFY_PROFILE)`,
    `    ${c("--hook")}                      Hook mode: read stdin payloads, never fail (ctx), skip strict checks (check/up)`,
    `    ${c("--root")} ${d("<path>")}               Target repo root (default: cwd)`,
    `    ${c("--scope")} ${d("<project|user>")}      Skill install scope (skill command)`,
    `    ${c("--provider")} ${d("<name|all>")}       Skill install provider`,
    `    ${c("--planned")} / ${c("--sessions")} / ${c("--all")}  Optional clean groups`,
    ``,
    `  ${bold("EXAMPLES")}`,
    ``,
    `    ${d("$")} agentify install`,
    `    ${d("$")} agentify install --global`,
    `    ${d("$")} agentify install --provider codex`,
    `    ${d("$")} agentify install --provider all`,
    `    ${d("$")} agentify status`,
    `    ${d("$")} agentify ctx load`,
    `    ${d("$")} agentify ctx note "payments retry logic lives in src/pay/retry.ts"`,
    `    ${d("$")} agentify ctx handoff "wrapping up checkout refactor"`,
    `    ${d("$")} agentify delegate quick "rename getUser to fetchUser in src/api.ts" --write`,
    `    ${d("$")} agentify delegate review --diff origin/main`,
    `    ${d("$")} agentify delegate auto "fix the failing checkout flow" --profile balanced`,
    `    ${d("$")} agentify route explain "design the migration" --profile performance`,
    `    ${d("$")} agentify models`,
    `    ${d("$")} agentify eval init sample`,
    `    ${d("$")} agentify eval run sample --repeat 2 --dry-run`,
    `    ${d("$")} agentify eval report --format md`,
    `    ${d("$")} agentify eval compare current.json baseline.json --fail-on "pass_rate_drop>0.02"`,
    `    ${d("$")} agentify value --days 7 --format html`,
    `    ${d("$")} agentify workflow install`,
    `    ${d("$")} agentify workflow install azure --provider claude`,
    `    ${d("$")} agentify scan`,
    `    ${d("$")} agentify query search --term checkout`,
    `    ${d("$")} agentify query def --symbol buildReport`,
    `    ${d("$")} agentify risk --since origin/main`,
    `    ${d("$")} agentify skill list`,
    `    ${d("$")} agentify skill install grill-me --provider claude --scope project`,
    `    ${d("$")} agentify completion zsh`,
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
