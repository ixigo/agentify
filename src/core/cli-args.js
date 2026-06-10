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
  "bypassPermissions",
  "hook",
  "withContext",
  "continue",
  "resume",
  "rtk",
  "currentWorktree",
  "allowDirty",
  "noCommit",
  "planned",
  "sessions",
  "all",
  "auto",
  "status",
  "force",
  "sharedStore",
]);

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

function toCamelCaseFlag(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

export function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
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
