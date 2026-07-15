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
  "keepWorkspaces",
  "yes",
  "noCache",
  "noProgress",
  "includeConfig",
  "showProjectNames",
  "showPaths",
]);

// Flags that may appear multiple times; repeats accumulate into an array
// instead of last-one-wins.
const REPEATABLE_FLAGS = new Set(["failOn", "sourceRoot"]);

function toCamelCaseFlag(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function assignFlag(args, key, value) {
  if (REPEATABLE_FLAGS.has(key) && hasOwn(args, key)) {
    args[key] = [].concat(args[key], value);
    return;
  }
  args[key] = value;
}

export function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function normalizeOptionalSince(args, commandName) {
  if (!hasOwn(args, "since")) {
    return null;
  }
  const since = String(args.since).trim();
  if (!since || since === "true") {
    throw new Error(`${commandName} --since requires a commit or ref value`);
  }
  return since;
}

export function getSearchTerm(args, commandName) {
  const term = args.term === undefined ? args._[2] : args.term;
  if (!term || term === true) {
    throw new Error(`${commandName} search requires --term <value> or a positional search term`);
  }
  return String(term);
}

export function getPromptFromArgs(args, startIndex) {
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

    // Split at the FIRST '=' only; the value may itself contain '='
    // (e.g. --source-root=codex=./fixtures).
    const eqIndex = token.indexOf("=", 2);
    const rawKey = eqIndex === -1 ? token.slice(2) : token.slice(2, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : token.slice(eqIndex + 1);
    const key = toCamelCaseFlag(rawKey);
    if (inlineValue !== undefined) {
      assignFlag(args, key, parseValue(inlineValue));
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      // Valueless occurrences of repeatable flags accumulate too, so a
      // malformed repeat is visible downstream instead of silently replaced.
      assignFlag(args, key, true);
      continue;
    }

    assignFlag(args, key, parseValue(next));
    index += 1;
  }
  return args;
}
