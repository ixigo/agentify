import { listBuiltinSkills } from "./skills.js";
import { SUPPORTED_PROVIDERS } from "./provider-command.js";
import { DELEGATE_PROVIDER_NAMES } from "./provider-registry.js";

const LANGUAGE_VALUES = ["auto", "ts", "python", "go", "rust", "dotnet", "java", "kotlin", "swift"];
const SCOPE_VALUES = ["project", "user"];
const BOOLEAN_VALUES = ["true", "false"];
const COMPLETION_SHELLS = ["zsh", "bash", "fish"];
const DYNAMIC_VALUE_KINDS = ["providers", "skills"];

const GLOBAL_FLAGS = [
  flag("--strict", { values: BOOLEAN_VALUES, description: "Fail closed on validation issues" }),
  flag("--languages", { values: LANGUAGE_VALUES, description: "Language scanner selection" }),
  flag("--dry-run", { description: "Report planned writes without changing files" }),
  flag("--ghost", { description: "Route outputs to .current_session/" }),
  flag("--json", { description: "Print machine-readable JSON" }),
  flag("--root", { valueKind: "path", description: "Target repository root" }),
  flag("--help", { description: "Show help" }),
  flag("--version", { description: "Show version" }),
];

const COMMANDS = [
  command("install", "Install Agentify into this repo and its agent config", {
    aliases: ["init"],
    flags: [
      flag("--global", { description: "Install into ~/.claude or ~/.codex instead of the project" }),
      flag("--provider", { values: ["claude", "codex", "all"], description: "Agent integration to install" }),
    ],
  }),
  command("uninstall", "Remove the Agentify agent integration", {
    flags: [
      flag("--global", { description: "Uninstall from ~/.claude or ~/.codex" }),
      flag("--provider", { values: ["claude", "codex", "all"], description: "Agent integration to remove" }),
    ],
  }),
  command("status", "Show integration and context-tracking status", {
    flags: [
      flag("--global", { description: "Inspect the global integration" }),
      flag("--provider", { values: ["claude", "codex", "all"], description: "Agent integration to inspect" }),
    ],
  }),
  command("ctx", "Lightweight context tracking", {
    subcommands: [
      subcommand("load", "Print a digest of recent activity and notes"),
      subcommand("match", "Show context relevant to a task prompt"),
      subcommand("note", "Record a note for future sessions"),
      subcommand("track", "Record a context event from a Claude Code hook payload", {
        flags: [flag("--hook", { description: "Hook mode: read stdin, never fail" })],
      }),
      subcommand("status", "Show context tracking status"),
      subcommand("summarize", "Summarize a session into the context store", {
        flags: [flag("--session", { valueKind: "text", description: "Session id" })],
      }),
      subcommand("share", "Make notes committable team memory", {
        flags: [flag("--off", { description: "Return notes to local-only" })],
      }),
      subcommand("handoff", "Write a handoff summary"),
      subcommand("pause", "Pause tracking and digest injection"),
      subcommand("resume", "Resume tracking"),
      subcommand("clear", "Archive and reset the context store"),
    ],
  }),
  command("delegate", "Shell a task out to the right model", {
    subcommands: [
      subcommand("auto", "Classify the task and pick the route automatically"),
      subcommand("quick", "Small, low-impact edits and quick questions"),
      subcommand("implement", "Standard feature work"),
      subcommand("heavy", "Architecture and deep debugging"),
      subcommand("review", "Independent post-change review", {
        flags: [flag("--diff", { valueKind: "text", description: "Include git diff since ref" })],
      }),
      subcommand("research", "Fast lookups and summaries"),
    ],
    flags: [
      flag("--write", { description: "Allow the delegated model to apply edits" }),
      flag("--model", { valueKind: "text", description: "Override the route model" }),
      flag("--provider", { values: DELEGATE_PROVIDER_NAMES, description: "Override the route provider" }),
      flag("--timeout", { valueKind: "number", description: "Timeout in seconds" }),
      flag("--profile", { values: ["cost", "balanced", "performance"], description: "Optimization profile for this run" }),
      flag("--dry-run", { description: "Explain the routing decision without running" }),
    ],
  }),
  command("route", "Explain routing decisions", {
    subcommands: [
      subcommand("explain", "Show profile, tier, limits, fallback chain, and evidence for a task", {
        flags: [
          flag("--kind", { values: ["quick", "implement", "heavy", "review", "research"], description: "Explain a specific route instead of classifying the task" }),
          flag("--profile", { values: ["cost", "balanced", "performance"], description: "Optimization profile to explain under" }),
        ],
      }),
    ],
  }),
  command("models", "Show the model routing table and active profile"),
  command("eval", "Paired Agentify vs plain-Claude benchmarks", {
    subcommands: [
      subcommand("init", "Create a sample eval task manifest"),
      subcommand("run", "Run a paired eval task", {
        flags: [
          flag("--repeat", { valueKind: "number", description: "Attempts per arm" }),
          flag("--arms", { valueKind: "text", description: "Comma-separated arms (agentify, plain-safe, plain-project)" }),
          flag("--resume", { valueKind: "text", description: "Resume a run id, executing only missing attempts" }),
          flag("--keep-workspaces", { description: "Keep disposable clone workspaces for inspection" }),
        ],
      }),
      subcommand("list", "List eval tasks and past runs"),
      subcommand("report", "Cost-performance report for a run", {
        flags: [
          flag("--format", { values: ["json", "md", "html", "promptfoo"], description: "Report output format (promptfoo = interchange export)" }),
          flag("--out", { valueKind: "path", description: "Write the report to a file" }),
        ],
      }),
      subcommand("grid", "Model x difficulty frontier across matrix runs", {
        flags: [
          flag("--format", { values: ["json", "md"], description: "Grid output format" }),
          flag("--out", { valueKind: "path", description: "Write the grid to a file" }),
        ],
      }),
      subcommand("compare", "Regression gates between two JSON reports", {
        flags: [
          flag("--fail-on", { valueKind: "text", description: "Gate expression, e.g. pass_rate_drop>0.02 (repeatable)" }),
        ],
      }),
      subcommand("harbor", "Harbor container-benchmark adapter (validate, plan, import)", {
        flags: [
          flag("--suite", { valueKind: "text", description: "Suite for harbor plan (smoke, nightly, downshift, profiles, ...)" }),
        ],
      }),
      subcommand("swebench", "SWE-bench Verified warm/cold adapter (validate, plan, import)", {
        flags: [
          flag("--suite", { valueKind: "text", description: "Suite for swebench plan (smoke, repo-stratified-6)" }),
        ],
      }),
      subcommand("repobench", "RepoBench repo-context adapter (validate, plan, import)", {
        flags: [
          flag("--suite", { valueKind: "text", description: "Suite for repobench plan (smoke, repo-8)" }),
        ],
      }),
    ],
  }),
  command("workflow", "Prebuilt platform workflows", {
    aliases: ["workflows"],
    subcommands: [
      subcommand("list", "List workflows and CLI availability"),
      subcommand("install", "Install a platform workflow bundle", {
        flags: [
          flag("--provider", { valueKind: "providers", description: "Skill install provider or all" }),
          flag("--scope", { values: SCOPE_VALUES, description: "Install scope" }),
          flag("--force", { description: "Replace existing skill files" }),
        ],
      }),
    ],
  }),
  command("scan", "Build the SQLite repository index"),
  command("up", "Run scan and check", {
    flags: [flag("--hook", { description: "Use hook-friendly validation" })],
  }),
  command("check", "Validate index freshness and generated artifacts", {
    flags: [flag("--hook", { description: "Use hook-friendly validation" })],
  }),
  command("query", "Query the repository index", {
    subcommands: [
      subcommand("owner", "Find file owner metadata", {
        flags: [flag("--file", { valueKind: "path", description: "File path" })],
      }),
      subcommand("deps", "List module dependencies", {
        flags: [flag("--module", { valueKind: "text", description: "Module id" })],
      }),
      subcommand("changed", "List changed indexed files", {
        flags: [flag("--since", { valueKind: "text", description: "Commit or ref" })],
      }),
      subcommand("search", "Search indexed context"),
      subcommand("def", "Find symbol definition", {
        flags: [flag("--symbol", { valueKind: "text", description: "Symbol name" })],
      }),
      subcommand("refs", "Find symbol references", {
        flags: [flag("--symbol", { valueKind: "text", description: "Symbol name" })],
      }),
      subcommand("callers", "Find symbol callers", {
        flags: [flag("--symbol", { valueKind: "text", description: "Symbol name" })],
      }),
      subcommand("impacts", "Find impacted files", {
        flags: [
          flag("--file", { valueKind: "path", description: "File path" }),
          flag("--depth", { valueKind: "number", description: "Traversal depth" }),
        ],
      }),
    ],
  }),
  command("risk", "Score PR blast radius", {
    flags: [flag("--since", { valueKind: "text", description: "Commit or ref" })],
  }),
  command("serve", "Run the MCP server over stdio"),
  command("review", "Cross-vendor review of a change", {
    flags: [
      flag("--diff", { valueKind: "text", description: "Commit or ref to diff against" }),
      flag("--push", { description: "Review outgoing commits against upstream" }),
    ],
  }),
  command("stats", "Session and delegation usage stats", {
    flags: [flag("--days", { valueKind: "number", description: "Window in days (default 30)" })],
  }),
  command("value", "Evidence-backed Agentify impact report", {
    flags: [
      flag("--days", { valueKind: "number", description: "Window in days (default 7)" }),
      flag("--format", { values: ["text", "json", "html"], description: "Report format" }),
      flag("--output", { valueKind: "path", description: "HTML output path" }),
    ],
  }),
  command("analyze", "Privacy-first analysis of local Claude/Codex session history", {
    flags: [
      flag("--provider", { values: ["claude", "codex", "all"], description: "Session history provider" }),
      flag("--scope", { values: ["current-repo", "global"], description: "Analysis scope (default current-repo)" }),
      flag("--days", { valueKind: "number", description: "Window in days (default 30)" }),
      flag("--format", { values: ["text", "json", "html"], description: "Report format (default html)" }),
      flag("--output", { valueKind: "path", description: "HTML output path" }),
      flag("--no-open", { description: "Write the HTML report without opening a browser" }),
      flag("--yes", { description: "Consent to reading local session history (required non-interactively)" }),
      flag("--dry-run", { description: "Preview roots, file counts, and bytes without parsing" }),
      flag("--no-cache", { description: "Re-parse every file instead of using the private incremental cache" }),
      flag("--no-progress", { description: "Suppress the stderr progress line (progress is TTY-only anyway)" }),
      flag("--source-root", { valueKind: "text", description: "History root override as claude=<path> or codex=<path>; repeatable, replaces that provider's default" }),
      flag("--content", { values: ["metadata-only", "local-extractive"], description: "local-extractive classifies prompt text in memory (deterministic rules, nothing persisted)" }),
      flag("--include-config", { description: "Audit allowlisted global config (instruction sizes, skill/agent names; only identifier-like allowlisted values pass, all else withheld)" }),
      flag("--show-project-names", { description: "Global scope display opt-in: real project names instead of pseudonyms (badged in the report)" }),
      flag("--show-paths", { description: "Global scope display opt-in: real project paths instead of pseudonyms (badged in the report)" }),
      flag("--insights", { values: ["deterministic", "cli"], description: "cli asks the local Claude/Codex CLI to interpret the sanitized packet (paid opt-in)" }),
      flag("--insights-provider", { values: ["claude", "codex", "both"], description: "Which CLI interprets the packet (default claude)" }),
      flag("--insights-model", { valueKind: "text", description: "Model override for the insight run" }),
      flag("--max-insights-budget-usd", { valueKind: "number", description: "Spend ceiling for CLI-assisted insights (default 0.25; native cap on claude)" }),
      flag("--insights-timeout", { valueKind: "number", description: "Per-provider wall-clock timeout in seconds (default 120)" }),
      flag("--insights-dry-run", { description: "Print the exact sanitized packet and provider plan without invoking anything" }),
      flag("--keep-insights-packet", { description: "Keep the sanitized packet as a private artifact under .agentify/" }),
    ],
  }),
  command("test", "Select and run tests affected by a change", {
    flags: [
      flag("--since", { valueKind: "text", description: "Commit or ref" }),
      flag("--run", { description: "Run the selected tests" }),
    ],
  }),
  command("skill", "Manage built-in agent skills", {
    aliases: ["skills"],
    subcommands: [
      subcommand("list", "List built-in skills"),
      subcommand("install", "Install a built-in skill", {
        positionals: [positional("skill", "skills")],
        flags: [
          flag("--provider", { valueKind: "providers", description: "Install provider or all" }),
          flag("--scope", { values: SCOPE_VALUES, description: "Install scope" }),
          flag("--force", { description: "Replace existing skill files" }),
        ],
      }),
    ],
  }),
  command("hooks", "Install/remove git hooks", {
    subcommands: [
      subcommand("install", "Install enabled hooks"),
      subcommand("remove", "Remove Agentify hooks"),
      subcommand("status", "Show hook status"),
    ],
  }),
  command("doctor", "Check toolchain health", {
    flags: [flag("--fail-on-stale", { description: "Exit non-zero when stale" })],
  }),
  command("clean", "Prune stale generated artifacts", {
    flags: [
      flag("--dry-run", { description: "Report planned removals only" }),
      flag("--planned", { description: "Prune legacy planned artifacts" }),
      flag("--sessions", { description: "Prune legacy session artifacts" }),
      flag("--all", { description: "Include optional cleanup groups" }),
    ],
  }),
  command("completion", "Generate shell completion scripts", {
    subcommands: [
      subcommand("zsh", "Print zsh completion script"),
      subcommand("bash", "Print bash completion script"),
      subcommand("fish", "Print fish completion script"),
      subcommand("values", "Print dynamic completion values", {
        hidden: true,
        positionals: [positional("kind", "completion-values")],
        flags: [flag("--root", { valueKind: "path", description: "Target repository root" })],
      }),
    ],
  }),
];

export const COMPLETION_METADATA = Object.freeze({
  commands: COMMANDS,
  globalFlags: GLOBAL_FLAGS,
  dynamicValueKinds: DYNAMIC_VALUE_KINDS,
  staticValues: {
    "completion-shells": COMPLETION_SHELLS,
    "completion-values": DYNAMIC_VALUE_KINDS,
  },
});

export async function getCompletionValues(kind, { root: _root = process.cwd() } = {}) {
  switch (kind) {
    case "providers":
      return [...SUPPORTED_PROVIDERS];
    case "skills":
      return listBuiltinSkills().map((skill) => skill.name).sort();
    default:
      throw new Error(`unknown completion value kind "${kind}". Expected ${DYNAMIC_VALUE_KINDS.join(", ")}`);
  }
}

export async function printCompletionValues(kind, options = {}) {
  const values = await getCompletionValues(kind, options);
  if (values.length > 0) {
    process.stdout.write(`${values.join("\n")}\n`);
  }
}

export function generateCompletionScript(shell) {
  switch (shell) {
    case "zsh":
      return renderZshCompletion();
    case "bash":
      return renderBashCompletion();
    case "fish":
      return renderFishCompletion();
    default:
      throw new Error(`completion requires a shell: ${COMPLETION_SHELLS.join(", ")}`);
  }
}

function flag(name, options = {}) {
  return { name, description: "", ...options };
}

function positional(name, valueKind = "text") {
  return { name, valueKind };
}

function command(name, description, options = {}) {
  return { name, description, aliases: [], flags: [], subcommands: [], positionals: [], ...options };
}

function subcommand(name, description, options = {}) {
  return command(name, description, options);
}

function visibleSubcommands(commandInfo) {
  return (commandInfo?.subcommands || []).filter((item) => !item.hidden);
}

function allCommandNames() {
  return COMMANDS.flatMap((item) => [item.name, ...(item.aliases || [])]).sort();
}

function findCommand(name) {
  return COMMANDS.find((item) => item.name === name || item.aliases?.includes(name)) || null;
}

function flagsFor(commandName, subcommandName) {
  const seen = new Map(GLOBAL_FLAGS.map((item) => [item.name, item]));
  const commandInfo = findCommand(commandName);
  for (const item of commandInfo?.flags || []) {
    seen.set(item.name, item);
  }
  const subcommandInfo = visibleSubcommands(commandInfo).find((item) => item.name === subcommandName);
  for (const item of subcommandInfo?.flags || []) {
    seen.set(item.name, item);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function collectFlags() {
  return [
    ...GLOBAL_FLAGS,
    ...COMMANDS.flatMap((item) => [
      ...(item.flags || []),
      ...(item.subcommands || []).flatMap((sub) => sub.flags || []),
    ]),
  ];
}

function scriptData() {
  const commands = allCommandNames();
  const subcommands = Object.fromEntries(COMMANDS.map((item) => [item.name, visibleSubcommands(item).map((sub) => sub.name)]));
  for (const item of COMMANDS) {
    for (const alias of item.aliases || []) {
      subcommands[alias] = subcommands[item.name] || [];
    }
  }
  const flags = {};
  for (const commandName of commands) {
    flags[commandName] = flagsFor(commandName).map((item) => item.name);
    const commandInfo = findCommand(commandName);
    for (const sub of visibleSubcommands(commandInfo)) {
      flags[`${commandName}:${sub.name}`] = flagsFor(commandName, sub.name).map((item) => item.name);
    }
  }
  const flagKinds = Object.fromEntries(collectFlags().map((item) => [item.name, item.valueKind || (item.values ? item.name.slice(2) : null)]));
  const staticValues = {
    ...COMPLETION_METADATA.staticValues,
    provider: SUPPORTED_PROVIDERS,
    languages: LANGUAGE_VALUES,
    scope: SCOPE_VALUES,
    strict: BOOLEAN_VALUES,
  };
  return { commands, subcommands, flags, flagKinds, staticValues };
}

function shellWords(values) {
  return values.map(shellQuote).join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function bashCaseEntries(map) {
  return Object.entries(map)
    .map(([key, values]) => `    ${shellQuote(key)}) printf '%s\\n' ${shellWords(values)} ;;`)
    .join("\n");
}

function renderBashCompletion() {
  const data = scriptData();
  return `# bash completion for agentify
_agentify_dynamic_values() {
  agentify completion values "$1" --root "$PWD" 2>/dev/null
}

_agentify_static_values() {
  case "$1" in
${bashCaseEntries(data.staticValues)}
  esac
}

_agentify_subcommands() {
  case "$1" in
${bashCaseEntries(data.subcommands)}
  esac
}

_agentify_flags() {
  case "$1${"${2:+:$2}"}" in
${bashCaseEntries(data.flags)}
  esac
}

_agentify_flag_kind() {
  case "$1" in
${Object.entries(data.flagKinds).map(([key, kind]) => `    ${shellQuote(key)}) printf '%s\\n' ${shellQuote(kind || "")} ;;`).join("\n")}
  esac
}

_agentify_complete_kind() {
  case "$1" in
    providers|skills) COMPREPLY=($(compgen -W "$(_agentify_dynamic_values "$1")" -- "$cur")) ;;
    path) COMPREPLY=($(compgen -f -- "$cur")) ;;
    number|text) COMPREPLY=() ;;
    *) COMPREPLY=($(compgen -W "$(_agentify_static_values "$1")" -- "$cur")) ;;
  esac
}

_agentify_completion() {
  local cur prev cmd sub kind
  COMPREPLY=()
  cur="${"${COMP_WORDS[COMP_CWORD]}"}"
  prev="${"${COMP_WORDS[COMP_CWORD-1]}"}"
  cmd="${"${COMP_WORDS[1]}"}"
  sub="${"${COMP_WORDS[2]}"}"

  if [[ "$prev" == "--"* ]]; then
    kind="$(_agentify_flag_kind "$prev")"
    _agentify_complete_kind "$kind"
    return 0
  fi

  if [[ "$cur" == --* ]]; then
    COMPREPLY=($(compgen -W "$(_agentify_flags "$cmd" "$sub")" -- "$cur"))
    return 0
  fi

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${shellWords(data.commands)}" -- "$cur"))
    return 0
  fi

  if [[ $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=($(compgen -W "$(_agentify_subcommands "$cmd")" -- "$cur"))
    return 0
  fi

  if [[ "$cmd" == "skill" || "$cmd" == "skills" ]] && [[ "$sub" == "install" ]] && [[ $COMP_CWORD -eq 3 ]]; then
    _agentify_complete_kind skills
    return 0
  fi
  if [[ "$cmd" == "completion" ]] && [[ $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=($(compgen -W "${shellWords(COMPLETION_SHELLS)}" -- "$cur"))
    return 0
  fi
  if [[ "$cmd" == "completion" ]] && [[ "$sub" == "values" ]] && [[ $COMP_CWORD -eq 3 ]]; then
    COMPREPLY=($(compgen -W "${shellWords(DYNAMIC_VALUE_KINDS)}" -- "$cur"))
    return 0
  fi
}

complete -F _agentify_completion agentify
`;
}

function zshCaseEntries(map, functionName) {
  return `${functionName}() {
  case "$1" in
${Object.entries(map).map(([key, values]) => `    ${shellQuote(key)}) print -r -- ${shellWords(values)} ;;`).join("\n")}
  esac
}`;
}

function renderZshCompletion() {
  const data = scriptData();
  return `#compdef agentify
# zsh completion for agentify

_agentify_dynamic_values() {
  agentify completion values "$1" --root "$PWD" 2>/dev/null
}

${zshCaseEntries(data.staticValues, "_agentify_static_values")}

${zshCaseEntries(data.subcommands, "_agentify_subcommands")}

_agentify_flags() {
  case "$1${"${2:+:$2}"}" in
${bashCaseEntries(data.flags)}
  esac
}

_agentify_flag_kind() {
  case "$1" in
${Object.entries(data.flagKinds).map(([key, kind]) => `    ${shellQuote(key)}) print -r -- ${shellQuote(kind || "")} ;;`).join("\n")}
  esac
}

_agentify_add_kind() {
  local -a values
  case "$1" in
    providers|skills)
      values=("${"${(@f)$(_agentify_dynamic_values \"$1\")}" }")
      compadd -- $values
      ;;
    path) _files ;;
    number|text) ;;
    *) values=("${"${(@f)$(_agentify_static_values \"$1\")}" }"); compadd -- $values ;;
  esac
}

_agentify() {
  local cur prev cmd sub kind
  cur="$words[$CURRENT]"
  prev="$words[$((CURRENT - 1))]"
  cmd="$words[2]"
  sub="$words[3]"

  if [[ "$prev" == --* ]]; then
    kind="$(_agentify_flag_kind "$prev")"
    _agentify_add_kind "$kind"
    return
  fi

  if [[ "$cur" == --* ]]; then
    compadd -- ${"${(@f)$(_agentify_flags \"$cmd\" \"$sub\")}" }
    return
  fi

  if (( CURRENT == 2 )); then
    compadd -- ${shellWords(data.commands)}
    return
  fi

  if (( CURRENT == 3 )); then
    compadd -- ${"${(@f)$(_agentify_subcommands \"$cmd\")}" }
    return
  fi

  if [[ "$cmd" == "skill" || "$cmd" == "skills" ]] && [[ "$sub" == "install" ]] && (( CURRENT == 4 )); then
    _agentify_add_kind skills
    return
  fi
  if [[ "$cmd" == "completion" ]] && (( CURRENT == 3 )); then
    compadd -- ${shellWords(COMPLETION_SHELLS)}
    return
  fi
  if [[ "$cmd" == "completion" && "$sub" == "values" ]] && (( CURRENT == 4 )); then
    compadd -- ${shellWords(DYNAMIC_VALUE_KINDS)}
    return
  fi
}

_agentify "$@"
`;
}

function fishConditionForCommand(commandInfo) {
  const names = [commandInfo.name, ...(commandInfo.aliases || [])];
  return `__fish_seen_subcommand_from ${names.join(" ")}`;
}

function renderFishCompletion() {
  const data = scriptData();
  const lines = [
    "# fish completion for agentify",
    "function __agentify_complete_providers",
    "  agentify completion values providers --root (pwd) 2>/dev/null",
    "end",
    "function __agentify_complete_skills",
    "  agentify completion values skills --root (pwd) 2>/dev/null",
    "end",
    "",
  ];

  const commandNames = data.commands.join(" ");
  for (const commandInfo of COMMANDS) {
    if (commandInfo.hidden) continue;
    const names = [commandInfo.name, ...(commandInfo.aliases || [])];
    for (const name of names) {
      lines.push(`complete -c agentify -f -n 'not __fish_seen_subcommand_from ${commandNames}' -a ${shellQuote(name)} -d ${shellQuote(commandInfo.description)}`);
    }
  }

  for (const commandInfo of COMMANDS) {
    for (const sub of visibleSubcommands(commandInfo)) {
      lines.push(`complete -c agentify -f -n '${fishConditionForCommand(commandInfo)}; and not __fish_seen_subcommand_from ${visibleSubcommands(commandInfo).map((item) => item.name).join(" ")}' -a ${shellQuote(sub.name)} -d ${shellQuote(sub.description)}`);
    }
  }

  for (const flagInfo of GLOBAL_FLAGS) {
    pushFishFlag(lines, flagInfo, "");
  }

  for (const commandInfo of COMMANDS) {
    for (const flagInfo of commandInfo.flags || []) {
      pushFishFlag(lines, flagInfo, fishConditionForCommand(commandInfo));
    }
    for (const sub of visibleSubcommands(commandInfo)) {
      for (const flagInfo of sub.flags || []) {
        pushFishFlag(lines, flagInfo, `${fishConditionForCommand(commandInfo)}; and __fish_seen_subcommand_from ${sub.name}`);
      }
    }
  }

  lines.push("complete -c agentify -f -n '__fish_seen_subcommand_from skill skills; and __fish_seen_subcommand_from install' -a '(__agentify_complete_skills)'");
  lines.push("complete -c agentify -f -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from zsh bash fish values' -a 'zsh bash fish'");
  lines.push("complete -c agentify -f -n '__fish_seen_subcommand_from completion; and __fish_seen_subcommand_from values' -a 'providers skills'");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function pushFishFlag(lines, flagInfo, condition) {
  const name = flagInfo.name.replace(/^--/, "");
  const parts = ["complete -c agentify", "-l", shellQuote(name)];
  if (condition) {
    parts.push("-n", shellQuote(condition));
  }
  const args = fishArgsForFlag(flagInfo);
  if (args) {
    parts.push(...args);
  }
  if (flagInfo.description) {
    parts.push("-d", shellQuote(flagInfo.description));
  }
  lines.push(parts.join(" "));
}

function fishArgsForFlag(flagInfo) {
  const kind = flagInfo.valueKind || (flagInfo.values ? flagInfo.name.slice(2) : null);
  switch (kind) {
    case "providers":
      return ["-xa", "'(__agentify_complete_providers)'"];
    case "skills":
      return ["-xa", "'(__agentify_complete_skills)'"];
    case "path":
      return ["-r"];
    case "number":
    case "text":
      return ["-x"];
    default:
      if (flagInfo.values) {
        return ["-xa", shellQuote(flagInfo.values.join(" "))];
      }
      return null;
  }
}
