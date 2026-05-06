import { listSessions } from "./session.js";
import { listBuiltinSkills } from "./skills.js";
import { SUPPORTED_PROVIDERS } from "./provider-command.js";

export const COMPLETION_SPEC = {
  command: "agentify",
  commands: [
    { name: "init", description: "Create baseline Agentify artifacts" },
    { name: "index", description: "Build the SQLite repository index" },
    { name: "scan", description: "Alias for index" },
    { name: "doc", description: "Generate docs, metadata, and key-file headers" },
    { name: "up", description: "Run scan, optional doc, check, and tests" },
    { name: "sync", description: "Upgrade repo-owned Agentify files, then refresh" },
    { name: "check", description: "Validate freshness, schemas, and safety rules" },
    { name: "plan", description: "Preview planner-selected context for a task" },
    { name: "context", description: "Search indexed context and fetch bounded slices" },
    { name: "run", description: "Run provider template command with auto-refresh" },
    { name: "exec", description: "Advanced wrapper for custom agent commands" },
    { name: "this", description: "Bootstrap this macOS repo for a provider-backed workflow" },
    { name: "query", description: "Query the repository index" },
    { name: "risk", description: "Score PR blast radius and recommend regression tests" },
    { name: "skill", description: "Manage built-in agent skills" },
    { name: "skills", description: "Alias for skill" },
    { name: "sess", description: "Manage provider-backed sessions" },
    { name: "session", description: "Alias for sess" },
    { name: "handoff", description: "Write a cross-agent handoff bundle for a session" },
    { name: "memory", description: "Manage agent memory helpers" },
    { name: "issue-killer", description: "Launch labelled GitHub issues into supervised tmux worktrees" },
    { name: "hooks", description: "Install/remove git hooks" },
    { name: "doctor", description: "Check toolchain health and capability tier" },
    { name: "semantic", description: "Refresh semantic TypeScript/JavaScript project facts" },
    { name: "clean", description: "Prune stale generated artifacts and dead Agentify folders" },
    { name: "cache", description: "Manage the content cache" },
    { name: "completion", description: "Generate shell completion scripts and dynamic values" },
  ],
  subcommands: {
    cache: ["status", "gc"],
    completion: ["zsh", "bash", "fish", "values"],
    context: ["search", "fetch", "compact", "status"],
    hooks: ["install", "status", "remove"],
    memory: ["compress"],
    query: ["owner", "deps", "changed", "search", "def", "refs", "callers", "impacts"],
    semantic: ["refresh"],
    sess: ["run", "resume", "fork", "list"],
    session: ["run", "resume", "fork", "list"],
    skill: ["list", "install"],
    skills: ["list", "install"],
  },
  flags: [
    "--provider",
    "--strict",
    "--languages",
    "--dry-run",
    "--docs",
    "--headers",
    "--semantic",
    "--provider-timeout-ms",
    "--ghost",
    "--json",
    "--explain",
    "--interactive",
    "-i",
    "--continue",
    "--resume",
    "--context-mode",
    "--with-context",
    "--bypass-permissions",
    "--explain-plan",
    "--caveman",
    "--root",
    "--scope",
    "--hook",
    "--fail-on-stale",
    "--timeout",
    "--skip-refresh",
  ],
  dynamicValues: ["providers", "skills", "sessions"],
};

function shellWords(values) {
  return values.join(" ");
}

function zshQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fishQuote(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function getTopLevelCommandNames() {
  return COMPLETION_SPEC.commands.map((command) => command.name);
}

function getSubcommandNames(command) {
  return COMPLETION_SPEC.subcommands[command] || [];
}

function renderZshCompletion() {
  const commandCases = Object.entries(COMPLETION_SPEC.subcommands)
    .filter(([command]) => command !== "completion")
    .map(([command, subcommands]) => `      ${command}) _values 'subcommands' ${subcommands.map(zshQuote).join(" ")} ;;`)
    .join("\n");

  return `#compdef agentify

_agentify() {
  local -a commands flags
  commands=(${COMPLETION_SPEC.commands.map(({ name, description }) => zshQuote(`${name}:${description}`)).join(" ")})
  flags=(${COMPLETION_SPEC.flags.map(zshQuote).join(" ")})

  case "$words[2]" in
      completion)
        if [[ "$words[3]" == "values" ]]; then
          _values 'dynamic values' ${COMPLETION_SPEC.dynamicValues.map(zshQuote).join(" ")}
        else
          _values 'subcommands' 'zsh' 'bash' 'fish' 'values'
        fi
        ;;
${commandCases}
      run|exec|this|skill|skills|sess|session|up|sync|doc|scan|index|init)
        if [[ "$words[CURRENT-1]" == "--provider" ]]; then
          _values 'providers' $(${COMPLETION_SPEC.command} completion values providers 2>/dev/null)
        elif [[ "$words[CURRENT-1]" == "--root" ]]; then
          _files -/
        elif [[ "$words[2]" == (skill|skills) && "$words[3]" == "install" ]]; then
          _values 'skills' $(${COMPLETION_SPEC.command} completion values skills 2>/dev/null)
        else
          _values 'options' $flags
        fi
        ;;
      handoff)
        if [[ "$words[CURRENT-1]" == "--session" ]]; then
          _values 'sessions' $(${COMPLETION_SPEC.command} completion values sessions 2>/dev/null)
        else
          _values 'options' $flags
        fi
        ;;
      *)
        _describe -t commands 'agentify commands' commands
        _values 'options' $flags
        ;;
  esac
}

_agentify "$@"
`;
}

function renderBashCompletion() {
  const topLevel = shellWords(getTopLevelCommandNames());
  const flags = shellWords(COMPLETION_SPEC.flags);
  const subcommandCases = Object.entries(COMPLETION_SPEC.subcommands)
    .map(([command, subcommands]) => `    ${command}) COMPREPLY=( $(compgen -W "${shellWords(subcommands)}" -- "$cur") ) ;;`)
    .join("\n");

  return `# bash completion for agentify
_agentify_completion() {
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

  case "$prev" in
    --provider) COMPREPLY=( $(compgen -W "$(${COMPLETION_SPEC.command} completion values providers 2>/dev/null)" -- "$cur") ); return ;;
    --root) COMPREPLY=( $(compgen -d -- "$cur") ); return ;;
    --session) COMPREPLY=( $(compgen -W "$(${COMPLETION_SPEC.command} completion values sessions 2>/dev/null)" -- "$cur") ); return ;;
  esac

  if [[ "$cmd" == "skill" || "$cmd" == "skills" ]] && [[ "\${COMP_WORDS[2]}" == "install" ]]; then
    COMPREPLY=( $(compgen -W "$(${COMPLETION_SPEC.command} completion values skills 2>/dev/null)" -- "$cur") )
    return
  fi

  if [[ "$cmd" == "completion" && "\${COMP_WORDS[2]}" == "values" ]]; then
    COMPREPLY=( $(compgen -W "${shellWords(COMPLETION_SPEC.dynamicValues)}" -- "$cur") )
    return
  fi

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${topLevel}" -- "$cur") )
    return
  fi

  case "$cmd" in
${subcommandCases}
    *) COMPREPLY=( $(compgen -W "${flags}" -- "$cur") ) ;;
  esac
}

complete -F _agentify_completion agentify
`;
}

function renderFishCompletion() {
  const lines = [
    "# fish completion for agentify",
    `complete -c ${COMPLETION_SPEC.command} -f`,
    ...COMPLETION_SPEC.commands.map(({ name, description }) =>
      `complete -c ${COMPLETION_SPEC.command} -n '__fish_use_subcommand' -a ${fishQuote(name)} -d ${fishQuote(description)}`
    ),
    ...COMPLETION_SPEC.flags.map((flag) => {
      if (flag.startsWith("--")) {
        return `complete -c ${COMPLETION_SPEC.command} -l ${flag.slice(2)}`;
      }
      return `complete -c ${COMPLETION_SPEC.command} -s ${flag.slice(1)}`;
    }),
  ];

  for (const [command, subcommands] of Object.entries(COMPLETION_SPEC.subcommands)) {
    for (const subcommand of subcommands) {
      lines.push(`complete -c ${COMPLETION_SPEC.command} -n '__fish_seen_subcommand_from ${fishQuote(command)}' -a ${fishQuote(subcommand)}`);
    }
  }

  lines.push(`complete -c ${COMPLETION_SPEC.command} -l provider -xa '(${COMPLETION_SPEC.command} completion values providers)'`);
  lines.push(`complete -c ${COMPLETION_SPEC.command} -l session -xa '(${COMPLETION_SPEC.command} completion values sessions)'`);
  lines.push(`complete -c ${COMPLETION_SPEC.command} -n '__fish_seen_subcommand_from skill skills; and __fish_seen_argument -w install' -xa '(${COMPLETION_SPEC.command} completion values skills)'`);

  return `${lines.join("\n")}\n`;
}

export function renderCompletionScript(shell) {
  switch (shell) {
    case "zsh":
      return renderZshCompletion();
    case "bash":
      return renderBashCompletion();
    case "fish":
      return renderFishCompletion();
    default:
      throw new Error("completion requires a shell: zsh, bash, or fish");
  }
}

export async function listCompletionValues(kind, { root = process.cwd() } = {}) {
  switch (kind) {
    case "providers":
      return SUPPORTED_PROVIDERS;
    case "skills":
      return listBuiltinSkills().map((skill) => skill.name);
    case "sessions":
      try {
        const sessions = await listSessions(root);
        return sessions
          .map((session) => session.session_id)
          .filter(Boolean);
      } catch {
        return [];
      }
    default:
      throw new Error("completion values requires one of: providers, skills, sessions");
  }
}

export function getCompletionCommandNames() {
  return getTopLevelCommandNames();
}

export function getCompletionSubcommandNames(command) {
  return getSubcommandNames(command);
}
