import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePrivateJson } from "./fs.js";

export const INVOCATION_SOURCES = Object.freeze(["cli", "hook", "mcp"]);

const SOURCE_SET = new Set(INVOCATION_SOURCES);
const COMMAND_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 30;

const TOP_LEVEL_COMMANDS = new Set([
  "acp", "analyze", "check", "clean", "completion", "ctx", "delegate",
  "doctor", "eval", "help", "hooks", "install", "models", "query",
  "review", "risk", "route", "scan", "serve", "skill", "stats", "status",
  "test", "uninstall", "up", "value", "version", "workflow",
]);

const SUBCOMMANDS = new Map([
  ["completion", new Set(["bash", "fish", "values", "zsh"])],
  ["ctx", new Set([
    "capture-report", "clear", "decision", "decisions", "explain", "handoff",
    "load", "match", "note", "pause", "precheck", "resume", "share",
    "status", "summarize", "track",
  ])],
  ["delegate", new Set(["auto", "heavy", "implement", "quick", "research", "review"])],
  ["eval", new Set(["compare", "grid", "harbor", "init", "list", "report", "run", "swebench"])],
  ["hooks", new Set(["install", "remove", "status"])],
  ["query", new Set(["callers", "changed", "def", "deps", "impacts", "owner", "refs", "search"])],
  ["route", new Set(["explain"])],
  ["skill", new Set(["install", "list"])],
  ["workflow", new Set(["install", "list"])],
]);

const THIRD_LEVEL_SUBCOMMANDS = new Map([
  ["eval.harbor", new Set(["import", "plan", "validate"])],
  ["eval.swebench", new Set(["import", "plan", "validate"])],
]);

function canonicalTopLevel(command) {
  if (command === "init") return "install";
  if (command === "skills") return "skill";
  if (command === "workflows") return "workflow";
  return command;
}

// Only names from the shipped command tree are retained. Positional task text,
// paths, refs, and arguments can therefore never enter the telemetry file.
export function resolveCliInvocationCommand(parsedArgs, options = {}) {
  if (options.version) return "version";
  if (options.help) return "help";

  const parts = Array.isArray(parsedArgs?._) ? parsedArgs._ : [];
  const command = canonicalTopLevel(String(parts[0] || "help").toLowerCase());
  if (!TOP_LEVEL_COMMANDS.has(command)) return "unknown";

  const allowedSubcommands = SUBCOMMANDS.get(command);
  const subcommand = String(parts[1] || "").toLowerCase();
  if (!allowedSubcommands?.has(subcommand)) return command;

  const twoLevels = `${command}.${subcommand}`;
  const allowedThirdLevel = THIRD_LEVEL_SUBCOMMANDS.get(twoLevels);
  const thirdLevel = String(parts[2] || "").toLowerCase();
  return allowedThirdLevel?.has(thirdLevel) ? `${twoLevels}.${thirdLevel}` : twoLevels;
}

export function resolveInvocationsPath({ env = process.env, home = os.homedir() } = {}) {
  const configured = String(env.XDG_CACHE_HOME || "").trim();
  const cacheHome = configured && path.isAbsolute(configured)
    ? configured
    : path.join(home, ".cache");
  return path.join(cacheHome, "agentify", "invocations.json");
}

// Resolve through symlinks up to the nearest existing ancestor. The counter
// file and usually its parent do not exist on first use, so fs.realpath(target)
// alone is not enough to enforce the containment boundary.
export async function realpathNearest(targetPath) {
  let current = path.resolve(targetPath);
  const suffix = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(targetPath);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function isInsideGitRepository(targetPath) {
  let current = await realpathNearest(targetPath);
  for (;;) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return true;
    } catch {
      // A bare repository has no .git entry. HEAD plus the object database is
      // a conservative, read-only signature; false positives fail closed by
      // disabling optional telemetry rather than writing into a repository.
      try {
        const [head, objects] = await Promise.all([
          fs.lstat(path.join(current, "HEAD")),
          fs.lstat(path.join(current, "objects")),
        ]);
        if (head.isFile() && objects.isDirectory()) return true;
      } catch {
        // Keep walking to the filesystem root.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readStore(targetPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function dateKey(now = new Date()) {
  const parsed = now instanceof Date ? now : new Date(now);
  return parsed.toISOString().slice(0, 10);
}

function positiveCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// Best effort by design: telemetry must never change the invoked command's
// outcome. Atomic replacement avoids partial JSON; concurrent writers may use
// last-writer-wins rather than introducing lock contention on hook hot paths.
export async function recordInvocation(invocation, options = {}) {
  try {
    const command = String(invocation?.command || "").toLowerCase();
    const source = String(invocation?.source || "").toLowerCase();
    if (!COMMAND_PATTERN.test(command) || !SOURCE_SET.has(source)) {
      return { recorded: false, reason: "invalid_invocation" };
    }

    const targetPath = options.path || resolveInvocationsPath(options);
    if (await isInsideGitRepository(targetPath)) {
      return { recorded: false, reason: "cache_inside_git_repository", path: targetPath };
    }

    const store = await readStore(targetPath);
    const day = dateKey(options.now);
    if (!isRecord(store[day])) store[day] = {};
    if (!isRecord(store[day][command])) store[day][command] = {};
    store[day][command][source] = positiveCount(store[day][command][source]) + 1;
    await writePrivateJson(targetPath, store);
    return { recorded: true, path: targetPath };
  } catch {
    return { recorded: false, reason: "write_failed" };
  }
}

function addCount(target, key, count) {
  target[key] = (target[key] || 0) + count;
}

export async function buildInvocationReport(options = {}) {
  const days = Number.isInteger(options.days) && options.days > 0
    ? options.days
    : DEFAULT_WINDOW_DAYS;
  const targetPath = options.path || resolveInvocationsPath(options);
  const unsafe = await isInsideGitRepository(targetPath).catch(() => true);
  const empty = {
    total: 0,
    by_source: Object.fromEntries(INVOCATION_SOURCES.map((source) => [source, 0])),
    by_command: {},
    top_commands: [],
    daily: [],
    ...(unsafe ? { limitation: "Invocation store is disabled because its cache path resolves inside a Git repository." } : {}),
  };
  if (unsafe) return empty;

  const store = await readStore(targetPath);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const firstDay = dateKey(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
  const lastDay = dateKey(now);
  const bySource = { ...empty.by_source };
  const byCommand = new Map();
  const daily = [];
  let total = 0;

  for (const [day, commands] of Object.entries(store).sort(([left], [right]) => left.localeCompare(right))) {
    if (!DAY_PATTERN.test(day) || day < firstDay || day > lastDay || !isRecord(commands)) continue;
    const dailySources = Object.fromEntries(INVOCATION_SOURCES.map((source) => [source, 0]));
    let dailyTotal = 0;
    for (const [command, sources] of Object.entries(commands)) {
      if (!COMMAND_PATTERN.test(command) || !isRecord(sources)) continue;
      const commandBucket = byCommand.get(command) || {
        total: 0,
        by_source: Object.fromEntries(INVOCATION_SOURCES.map((source) => [source, 0])),
      };
      for (const source of INVOCATION_SOURCES) {
        const count = positiveCount(sources[source]);
        if (count === 0) continue;
        total += count;
        dailyTotal += count;
        commandBucket.total += count;
        addCount(bySource, source, count);
        addCount(dailySources, source, count);
        addCount(commandBucket.by_source, source, count);
      }
      byCommand.set(command, commandBucket);
    }
    if (dailyTotal > 0) daily.push({ date: day, total: dailyTotal, by_source: dailySources });
  }

  const rankedCommands = [...byCommand.entries()]
    .sort(([leftName, left], [rightName, right]) => right.total - left.total || leftName.localeCompare(rightName));

  return {
    total,
    by_source: bySource,
    by_command: Object.fromEntries([...rankedCommands].sort(([left], [right]) => left.localeCompare(right))),
    top_commands: rankedCommands.slice(0, 10).map(([command, bucket]) => ({ command, ...bucket })),
    daily,
  };
}
