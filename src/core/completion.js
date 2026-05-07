import { listSessions } from "./session.js";
import { listBuiltinSkills } from "./skills.js";
import { SUPPORTED_PROVIDERS } from "./provider-command.js";

const LANGUAGE_VALUES = ["auto", "ts", "python", "go", "rust", "dotnet", "java", "kotlin", "swift"];
const CONTEXT_MODE_VALUES = ["compact", "routed", "direct"];
const SCOPE_VALUES = ["project", "user"];
const BOOLEAN_VALUES = ["true", "false"];
const CAVEMAN_VALUES = ["lite", "full", "ultra", "wenyan", "wenyan-lite", "wenyan-full", "wenyan-ultra", "off", "normal", "none"];
const COMPLETION_SHELLS = ["zsh", "bash", "fish"];
const DYNAMIC_VALUE_KINDS = ["providers", "skills", "sessions"];

const GLOBAL_FLAGS = [
  flag("--provider", { valueKind: "providers", description: "Provider to use" }),
  flag("--strict", { values: BOOLEAN_VALUES, description: "Fail closed on validation issues" }),
  flag("--languages", { values: LANGUAGE_VALUES, description: "Language scanner selection" }),
  flag("--dry-run", { description: "Report planned writes without changing files" }),
  flag("--docs", { values: BOOLEAN_VALUES, description: "Generate docs during refresh flows" }),
  flag("--headers", { description: "Apply Agentify headers to source files" }),
  flag("--provider-timeout-ms", { valueKind: "number", description: "Provider timeout in milliseconds" }),
  flag("--ghost", { description: "Route outputs to .current_session/" }),
  flag("--json", { description: "Print machine-readable JSON" }),
  flag("--root", { valueKind: "path", description: "Target repository root" }),
  flag("--help", { description: "Show help" }),
  flag("--version", { description: "Show version" }),
];

const COMMANDS = [
  command("init", "Create baseline Agentify artifacts"),
  command("index", "Build the SQLite repository index"),
  command("scan", "Alias for index"),
  command("doc", "Generate docs, metadata, and key-file headers"),
  command("up", "Run scan, optional doc, check, and test pipeline", {
    flags: [flag("--hook", { description: "Use hook-friendly validation" })],
  }),
  command("sync", "Upgrade repo-owned Agentify files, then run refresh"),
  command("check", "Validate freshness, schemas, and safety rules", {
    flags: [flag("--hook", { description: "Use hook-friendly validation" })],
  }),
  command("plan", "Preview planner-selected context for a task", {
    flags: [
      flag("--explain", { description: "Include planner score breakdowns" }),
      flag("--context-mode", { values: ["compact", "routed"], description: "Planner context mode" }),
      flag("--with-context", { description: "Include selected source context" }),
    ],
  }),
  command("context", "Search and fetch bounded routed context", {
    subcommands: [
      subcommand("search", "Search indexed context"),
      subcommand("fetch", "Fetch exact file slices", {
        positionals: [positional("target", "path")],
        flags: [
          flag("--lines", { valueKind: "text", description: "Line range A:B" }),
          flag("--symbol", { valueKind: "text", description: "Symbol name" }),
          flag("--file", { valueKind: "path", description: "File path" }),
          flag("--path", { valueKind: "path", description: "File path" }),
        ],
      }),
      subcommand("compact", "Compact session context", {
        flags: [flag("--session", { valueKind: "sessions", description: "Session id" })],
      }),
      subcommand("status", "Inspect routed context status", {
        flags: [flag("--session", { valueKind: "sessions", description: "Session id" })],
      }),
    ],
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
  command("run", "Run provider template command with auto-refresh", {
    flags: [
      flag("--interactive", { description: "Force interactive provider mode" }),
      flag("--continue", { description: "Resume the provider's most recent session" }),
      flag("--resume", { description: "Alias for --continue" }),
      flag("--context-mode", { values: ["compact", "routed"], description: "Run prompt context mode" }),
      flag("--with-context", { description: "Inject planner-selected context" }),
      flag("--explain-plan", { description: "Print planner output before execution" }),
      flag("--caveman", { values: CAVEMAN_VALUES, description: "Terse output level" }),
      flag("--timeout", { valueKind: "number", description: "Wrapped command timeout in seconds" }),
      flag("--skip-refresh", { description: "Skip post-command refresh" }),
      flag("--fail-on-stale", { description: "Exit 80 when validation fails" }),
      flag("--bypass-permissions", { description: "Bypass provider permission prompts" }),
    ],
  }),
  command("afk", "Create and run fresh-session autonomous plans", {
    subcommands: [
      subcommand("create", "Create an implementation-ready AFK plan", {
        flags: [
          flag("--provider", { valueKind: "providers", description: "Planning provider" }),
          flag("--slug", { valueKind: "text", description: "Plan slug" }),
        ],
      }),
      subcommand("run", "Run an AFK plan in a fresh provider session", {
        positionals: [positional("plan", "path")],
        flags: [
          flag("--provider", { valueKind: "providers", description: "Execution provider" }),
          flag("--interactive", { description: "Run provider interactively" }),
          flag("--current-worktree", { description: "Use the current checkout" }),
          flag("--allow-dirty", { description: "Allow current checkout changes" }),
          flag("--no-commit", { description: "Do not auto-commit successful worktree changes" }),
          flag("--cleanup", { values: ["keep", "delete", "ask"], description: "Plan cleanup mode after run" }),
        ],
      }),
      subcommand("clean", "Prune AFK plans and session artifacts", {
        flags: [flag("--dry-run", { description: "Report planned removals only" })],
      }),
    ],
  }),
  command("exec", "Advanced wrapper for custom agent commands", {
    flags: [
      flag("--timeout", { valueKind: "number", description: "Wrapped command timeout in seconds" }),
      flag("--skip-refresh", { description: "Skip post-command refresh" }),
      flag("--fail-on-stale", { description: "Exit 80 when validation fails" }),
    ],
  }),
  command("this", "Bootstrap this macOS repo for Agentify", {
    flags: [flag("--provider", { valueKind: "providers", description: "Bootstrap provider" })],
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
  command("sess", "Manage provider-backed sessions", {
    aliases: ["session"],
    subcommands: [
      subcommand("list", "List sessions"),
      subcommand("run", "Create or resume a session and launch provider", {
        flags: sessionLaunchFlags(),
      }),
      subcommand("fork", "Fork a session and launch provider", {
        flags: sessionLaunchFlags(),
      }),
      subcommand("resume", "Resume a session", {
        positionals: [positional("session", "sessions")],
        flags: sessionLaunchFlags(),
      }),
    ],
  }),
  command("handoff", "Write a cross-agent handoff bundle", {
    positionals: [positional("session", "sessions")],
    flags: [flag("--session", { valueKind: "sessions", description: "Session id" })],
  }),
  command("memory", "Manage agent memory helpers", {
    subcommands: [
      subcommand("compress", "Compress a memory file", {
        positionals: [positional("file", "path")],
      }),
    ],
  }),
  command("issue-killer", "Launch labelled GitHub issues into tmux worktrees", {
    flags: [
      flag("--label", { valueKind: "text", description: "GitHub issue label" }),
      flag("--agent-provider", { valueKind: "providers", description: "Provider for issue panes" }),
      flag("--limit", { valueKind: "number", description: "Maximum issues to launch" }),
      flag("--bypass-permissions", { description: "Control issue-killer YOLO mode" }),
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
    flags: [
      flag("--semantic", { description: "Show semantic diagnostics" }),
      flag("--fail-on-stale", { description: "Exit non-zero when stale" }),
    ],
  }),
  command("semantic", "Refresh semantic project facts", {
    subcommands: [subcommand("refresh", "Refresh semantic facts")],
  }),
  command("clean", "Prune stale generated artifacts", {
    flags: [
      flag("--dry-run", { description: "Report planned removals only" }),
      flag("--planned", { description: "Prune AFK planned artifacts" }),
      flag("--sessions", { description: "Prune AFK session artifacts" }),
      flag("--all", { description: "Include optional cleanup groups" }),
    ],
  }),
  command("cache", "Manage the content cache", {
    subcommands: [
      subcommand("gc", "Garbage collect cache blobs", {
        flags: [flag("--max-age", { valueKind: "number", description: "Maximum age in days" })],
      }),
      subcommand("status", "Show cache status"),
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

export async function getCompletionValues(kind, { root = process.cwd() } = {}) {
  switch (kind) {
    case "providers":
      return [...SUPPORTED_PROVIDERS];
    case "skills":
      return listBuiltinSkills().map((skill) => skill.name).sort();
    case "sessions":
      try {
        const sessions = await listSessions(root);
        return sessions.map((session) => session.session_id).filter(Boolean);
      } catch {
        return [];
      }
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

function sessionLaunchFlags() {
  return [
    flag("--provider", { valueKind: "providers", description: "Provider to launch" }),
    flag("--session", { valueKind: "sessions", description: "Session id" }),
    flag("--from", { valueKind: "sessions", description: "Parent session id" }),
    flag("--name", { valueKind: "text", description: "Session name" }),
    flag("--interactive", { description: "Force interactive provider mode" }),
    flag("--resume", { description: "Resume Agentify session context" }),
    flag("--context-mode", { values: CONTEXT_MODE_VALUES, description: "Session context mode" }),
    flag("--caveman", { values: CAVEMAN_VALUES, description: "Terse output level" }),
    flag("--timeout", { valueKind: "number", description: "Wrapped command timeout in seconds" }),
    flag("--skip-refresh", { description: "Skip post-command refresh" }),
    flag("--fail-on-stale", { description: "Exit 80 when validation fails" }),
    flag("--bypass-permissions", { description: "Bypass provider permission prompts" }),
  ];
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
    docs: BOOLEAN_VALUES,
    "context-mode": CONTEXT_MODE_VALUES,
    caveman: CAVEMAN_VALUES,
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
    providers|skills|sessions) COMPREPLY=($(compgen -W "$(_agentify_dynamic_values "$1")" -- "$cur")) ;;
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
  if [[ "$cmd" == "sess" || "$cmd" == "session" ]] && [[ "$sub" == "resume" ]] && [[ $COMP_CWORD -eq 3 ]]; then
    _agentify_complete_kind sessions
    return 0
  fi
  if [[ "$cmd" == "handoff" ]] && [[ $COMP_CWORD -eq 2 ]]; then
    _agentify_complete_kind sessions
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
  if [[ "$cmd" == "context" && "$sub" == "fetch" ]] || [[ "$cmd" == "memory" && "$sub" == "compress" ]]; then
    COMPREPLY=($(compgen -f -- "$cur"))
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
    providers|skills|sessions)
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
  if [[ "$cmd" == "sess" || "$cmd" == "session" ]] && [[ "$sub" == "resume" ]] && (( CURRENT == 4 )); then
    _agentify_add_kind sessions
    return
  fi
  if [[ "$cmd" == "handoff" ]] && (( CURRENT == 3 )); then
    _agentify_add_kind sessions
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
  if [[ "$cmd" == "context" && "$sub" == "fetch" ]] || [[ "$cmd" == "memory" && "$sub" == "compress" ]]; then
    _files
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
    "function __agentify_complete_sessions",
    "  agentify completion values sessions --root (pwd) 2>/dev/null",
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
  lines.push("complete -c agentify -f -n '__fish_seen_subcommand_from sess session; and __fish_seen_subcommand_from resume' -a '(__agentify_complete_sessions)'");
  lines.push("complete -c agentify -f -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from zsh bash fish values' -a 'zsh bash fish'");
  lines.push("complete -c agentify -f -n '__fish_seen_subcommand_from completion; and __fish_seen_subcommand_from values' -a 'providers skills sessions'");
  lines.push("complete -c agentify -n '__fish_seen_subcommand_from context; and __fish_seen_subcommand_from fetch' -a '(__fish_complete_path)'");
  lines.push("complete -c agentify -n '__fish_seen_subcommand_from memory; and __fish_seen_subcommand_from compress' -a '(__fish_complete_path)'");
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
    case "sessions":
      return ["-xa", "'(__agentify_complete_sessions)'"];
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
