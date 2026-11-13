import fs from "node:fs/promises";
import path from "node:path";

import { resolveLocalAgentifyPaths } from "./project-store.js";

// Top-level directories under `.agentify/` that this repo's SKILLS write and
// agentify therefore knows how to prune by age. `ui-eval/` is written by the
// bundled `ui-screenshot-eval` skill (skills/ui-screenshot-eval/SKILL.md). The
// issue also mentions `visual/`, but nothing on this branch — no command, no
// bundled skill — references a `visual/` directory, so it is deliberately left
// OUT and will be reported as "unknown" rather than pruned.
export const KNOWN_SKILL_ARTIFACT_DIRS = new Set(["ui-eval"]);

// Names the code writes directly under `.agentify/` that are NOT basenames of
// resolveLocalAgentifyPaths: eval run artifacts (config.eval → `.agentify/evals`),
// and the merged context side-files / markers that hooks + `ctx` write and that
// `clean --strays` recognises as mergeable/ephemeral (see SAFE_STRAY_* in
// cleanup.js). Kept here so the owned set is derived from the code, not guessed.
const EXTRA_OWNED_NAMES = new Set([
  "evals",
  "archive",
  "handoffs",
  // writePrivateText targets (swebench env, kept insights packets, HTML reports).
  "private",
  // SQLite sidecars of index.db (WAL mode) — written beside the index by db.js.
  "index.db-wal",
  "index.db-shm",
  "index.db-journal",
  "events.jsonl",
  "notes.jsonl",
  "injected.json",
  "paused",
  "value-events.jsonl",
  "summary-usage.jsonl",
  "summaries.jsonl",
  "acp-capture.jsonl",
]);

// Classification labels for a top-level entry of a store.
export const ENTRY_AGENTIFY = "agentify";
export const ENTRY_ARTIFACT = "skill-artifact";
export const ENTRY_UNKNOWN = "unknown";

// The set of top-level names agentify itself owns inside a `.agentify/` store,
// derived from resolveLocalAgentifyPaths (every path entry that lives directly
// under the runtime root) plus the extra names above. Local mode is used on
// purpose so projectStore === runtimeRoot and every store artifact basename is
// visible regardless of the caller's shared/local runtime config.
export function agentifyOwnedNames(root = ".") {
  const paths = resolveLocalAgentifyPaths(root);
  const runtimeRoot = path.resolve(paths.runtimeRoot);
  const names = new Set(EXTRA_OWNED_NAMES);
  for (const value of Object.values(paths)) {
    if (typeof value !== "string") {
      continue;
    }
    const resolved = path.resolve(value);
    if (path.dirname(resolved) === runtimeRoot) {
      names.add(path.basename(resolved));
    }
  }
  return names;
}

export function classifyEntry(name, ownedNames) {
  if (ownedNames && ownedNames.has(name)) {
    return ENTRY_AGENTIFY;
  }
  if (KNOWN_SKILL_ARTIFACT_DIRS.has(name)) {
    return ENTRY_ARTIFACT;
  }
  return ENTRY_UNKNOWN;
}

// Human-readable byte size. Binary units, one decimal above KB.
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

// Per-entry measurement outcome. EXACT: walked to completion. PARTIAL: the walk
// started and accrued bytes but the shared budget stopped it, so the figure is a
// lower bound. UNMEASURED: the budget was gone before anything could be counted,
// so there is NO figure — it must never be presented as an exact 0 B.
export const MEASURED_EXACT = "exact";
export const MEASURED_PARTIAL = "partial";
export const MEASURED_UNMEASURED = "unmeasured";

// Status needs a snappy answer on a multi-GB store, so it shares a small budget
// fairly across top-level entries (walked concurrently); whatever it could not
// finish is reported as a lower bound / not measured, pointing at the full walk.
export const STATUS_BUDGET = { budgetMs: 1500, maxEntries: 200000 };
// Explicit reporting commands (`clean --artifacts`/`--global`) walk fully: a
// generous budget that a real store never hits, so their sizes are exact.
export const FULL_BUDGET = { budgetMs: 60000, maxEntries: 5000000 };

function makeShared({ budgetMs, maxEntries } = {}) {
  return {
    deadline: Date.now() + (budgetMs ?? FULL_BUDGET.budgetMs),
    maxEntries: maxEntries ?? FULL_BUDGET.maxEntries,
    count: 0,
  };
}

// Recursively accrue size + newest-mtime of a tree into `acc` ({ size, newest,
// truncated }), checking the SHARED budget on every entry. NEVER follows symlinks
// (readdir dirents report isDirectory()/isFile() false for a symlink, so the
// entry is skipped) and tolerates permission/stat errors. On hitting the budget
// it sets `acc.truncated` and unwinds, so `size`/`newest` become lower bounds.
async function walkInto(dir, acc, shared) {
  if (shared.count >= shared.maxEntries || Date.now() > shared.deadline) {
    acc.truncated = true;
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (shared.count >= shared.maxEntries || Date.now() > shared.deadline) {
      acc.truncated = true;
      return;
    }
    shared.count += 1;
    if (entry.isSymbolicLink()) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkInto(child, acc, shared);
      if (acc.truncated) {
        return;
      }
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(child);
        acc.size += stat.size;
        if (stat.mtimeMs > acc.newest) {
          acc.newest = stat.mtimeMs;
        }
      } catch {
        // unreadable file: ignore for the size/age estimate
      }
    }
  }
}

function measuredState(acc) {
  if (!acc.truncated) {
    return MEASURED_EXACT;
  }
  return acc.size > 0 ? MEASURED_PARTIAL : MEASURED_UNMEASURED;
}

// Size + newest contained mtime of ONE directory against a shared budget.
// Returns { size, newest, measured }. A PARTIAL/UNMEASURED result means the walk
// did not complete, so callers that delete by age MUST NOT treat it as authoritative.
async function measureDir(dir, shared) {
  const acc = { size: 0, newest: 0, truncated: false };
  await walkInto(dir, acc, shared);
  return { size: acc.size, newest: acc.newest, measured: measuredState(acc) };
}

// Size + newest contained mtime of one directory, symlink-safe. By default it
// walks FULLY (FULL_BUDGET), so `measured` is "exact" on any real store; pass a
// smaller budget to bound it. `truncated` stays for back-compat (true unless exact).
export async function dirStats(dir, budget = {}) {
  const shared = makeShared({ ...FULL_BUDGET, ...budget });
  const result = await measureDir(dir, shared);
  return {
    size: result.size,
    newest: result.newest,
    measured: result.measured,
    truncated: result.measured !== MEASURED_EXACT,
  };
}

// Measure a `.agentify/` store: total size and a per-top-level-entry breakdown,
// each classified (agentify / skill-artifact / unknown) and each carrying its own
// `measured` state so a size is never printed for something that was not walked.
// Top-level entries are walked CONCURRENTLY under one shared deadline, so a single
// huge directory cannot starve the rest — every entry gets at least a partial
// figure instead of the first one eating the whole budget. Symlink-safe: a
// top-level symlink is listed with size 0, measured EXACT (it is not a tree), and
// never followed.
export async function measureStore(runtimeRoot, options = {}) {
  const ownedNames = options.ownedNames || agentifyOwnedNames(options.root || ".");
  let dirents;
  try {
    dirents = await fs.readdir(runtimeRoot, { withFileTypes: true });
  } catch {
    return { exists: false, totalBytes: 0, truncated: false, entries: [] };
  }

  const shared = makeShared(options);
  const entries = await Promise.all(dirents.map(async (dirent) => {
    const name = dirent.name;
    const isSymlink = dirent.isSymbolicLink();
    const child = path.join(runtimeRoot, name);
    let sizeBytes = 0;
    let measured = MEASURED_EXACT;
    if (!isSymlink) {
      if (dirent.isDirectory()) {
        const result = await measureDir(child, shared);
        sizeBytes = result.size;
        measured = result.measured;
      } else if (dirent.isFile()) {
        shared.count += 1;
        try {
          sizeBytes = (await fs.stat(child)).size;
        } catch {
          // ignore unreadable top-level file
        }
      }
    }
    return { name, kind: classifyEntry(name, ownedNames), sizeBytes, measured, isSymlink };
  }));

  let totalBytes = 0;
  let truncated = false;
  for (const entry of entries) {
    totalBytes += entry.sizeBytes;
    if (entry.measured !== MEASURED_EXACT) {
      truncated = true;
    }
  }

  // Largest first, but an UNMEASURED entry has no size to rank on, so it sinks to
  // the end rather than masquerading as the smallest.
  const rank = (entry) => (entry.measured === MEASURED_UNMEASURED ? 1 : 0);
  entries.sort((left, right) =>
    rank(left) - rank(right)
    || right.sizeBytes - left.sizeBytes
    || left.name.localeCompare(right.name));

  return { exists: true, totalBytes, truncated, entries };
}
