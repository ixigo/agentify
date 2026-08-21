import path from "node:path";

import { closeIndexDatabase, openIndexDatabase } from "./db/connection.js";
import { loadModuleDependencies, loadModules, searchIndex } from "./db/structural-store.js";
import { normalizeRows } from "./db/utils.js";
import { resolveAgentifyPaths } from "./project-store.js";
import { getChangedFilesSince } from "./git.js";

function normalizePath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function findOwningModule(modules, filePath) {
  const normalized = normalizePath(filePath);
  const sorted = [...modules].sort((left, right) => right.root_path.length - left.root_path.length);
  for (const moduleInfo of sorted) {
    if (
      moduleInfo.root_path === "."
      || normalized === moduleInfo.root_path
      || normalized.startsWith(`${moduleInfo.root_path}/`)
    ) {
      return moduleInfo;
    }
  }
  return null;
}

function loadSymbolsByName(db, symbol) {
  const rows = db.prepare(`
    SELECT module_id, file_path, name, kind, exported, start_line, end_line
    FROM symbols
    WHERE name = ?
    ORDER BY exported DESC, file_path ASC, start_line ASC
  `).all(String(symbol));
  return normalizeRows(rows);
}

// Cap on returned call-site rows. A hot symbol can have thousands of
// references; returning all of them would flood an agent's context. The rows
// are ordered deterministically before capping so the truncation is stable.
const CALL_SITE_CAP = 200;

const CALL_SITE_REFS_NOTE = "Call-site granularity: real references extracted from the TypeScript/JavaScript AST (kind \"call\" = an invocation, kind \"reference\" = any other use), each with the file and line where the symbol is used.";
const CALL_SITE_CALLERS_NOTE = "Call-site granularity: real call sites extracted from the TypeScript/JavaScript AST, each with the file and line of the invocation.";
const FILE_IMPORT_NOTE = "File-import granularity: results are file-level import edges into the symbol's defining file(s), not per-symbol call sites. This is the fallback for non-TypeScript/JavaScript languages (and for a symbol with no recorded call-site references); every file listed imports the defining file but may use a different export from it.";

// Real per-symbol references recorded by the indexer for TS/JS. `callsOnly`
// restricts to invocations (kind "call") for the callers query.
function loadSymbolRefs(db, symbol, { callsOnly = false } = {}) {
  const rows = callsOnly
    ? db.prepare(`
        SELECT symbol_name, from_path, line, kind
        FROM symbol_refs
        WHERE symbol_name = ? AND kind = 'call'
        ORDER BY from_path ASC, line ASC
      `).all(String(symbol))
    : db.prepare(`
        SELECT symbol_name, from_path, line, kind
        FROM symbol_refs
        WHERE symbol_name = ?
        ORDER BY from_path ASC, line ASC, kind ASC
      `).all(String(symbol));
  return normalizeRows(rows);
}

// Shape call-site rows into the returned reference objects and apply the cap.
// Field names are a superset of the file-import shape (file_path is shared) so
// a single consumer can read either granularity.
function buildCallSiteReferences(rows) {
  const capped = rows.slice(0, CALL_SITE_CAP);
  const references = capped.map((row) => ({
    kind: row.kind,
    file_path: row.from_path,
    line: row.line,
  }));
  const truncated = rows.length > CALL_SITE_CAP ? rows.length - CALL_SITE_CAP : 0;
  return { references, total: rows.length, truncated };
}

// The legacy behavior: file-level import edges into the symbol's defining
// file(s). Kept as the fallback for non-TS/JS languages.
function buildImportEdgeReferences(db, definitions) {
  const definingFiles = [...new Set(definitions.map((definition) => definition.file_path))];
  return loadImportersOf(db, definingFiles).map((edge) => ({
    kind: `import:${edge.kind}`,
    file_path: edge.from_path,
    imports: edge.to_path,
    specifier: edge.specifier,
  }));
}

function loadImportEdges(db) {
  const rows = db.prepare(`
    SELECT from_path, to_path, specifier, kind
    FROM imports
    WHERE to_path IS NOT NULL
  `).all();
  return normalizeRows(rows);
}

function loadImportersOf(db, filePaths) {
  if (filePaths.length === 0) {
    return [];
  }
  const placeholders = filePaths.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT from_path, to_path, specifier, kind
    FROM imports
    WHERE to_path IN (${placeholders})
    ORDER BY from_path ASC
  `).all(...filePaths);
  return normalizeRows(rows);
}

function symbolResolution(symbol, definitions) {
  return {
    symbol,
    ambiguous: definitions.length > 1,
    definitions,
    message: definitions.length === 0
      ? "No indexed symbol found; run `agentify scan` if the index may be stale"
      : definitions.length > 1
        ? "Multiple symbols matched; results include all candidates in deterministic order"
        : undefined,
  };
}

function normalizeDepth(depth) {
  const parsed = Number(depth ?? 3);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 3;
  }
  return Math.min(Math.floor(parsed), 6);
}

function computeImpacts(filePath, edges, maxDepth) {
  const importersByTarget = new Map();
  for (const edge of edges) {
    if (!edge.to_path || !edge.from_path || edge.from_path === edge.to_path) {
      continue;
    }
    if (!importersByTarget.has(edge.to_path)) {
      importersByTarget.set(edge.to_path, []);
    }
    importersByTarget.get(edge.to_path).push(edge);
  }

  const visited = new Set([filePath]);
  const impacts = new Map();
  let frontier = new Set([filePath]);

  for (let depth = 1; depth <= maxDepth && frontier.size > 0; depth += 1) {
    const next = new Set();
    for (const target of frontier) {
      for (const edge of importersByTarget.get(target) || []) {
        const impactedFile = edge.from_path;
        if (!impactedFile || visited.has(impactedFile)) {
          continue;
        }
        const score = (maxDepth - depth + 1) * 100;
        const via = {
          kind: `import:${edge.kind}`,
          from_file_path: edge.from_path,
          to_file_path: edge.to_path,
          specifier: edge.specifier,
        };
        const existing = impacts.get(impactedFile);
        if (!existing) {
          impacts.set(impactedFile, {
            file_path: impactedFile,
            depth,
            rank: score,
            via: [via],
          });
        } else {
          existing.rank = Math.max(existing.rank, score);
          existing.via.push(via);
        }
        next.add(impactedFile);
      }
    }
    for (const impactedFile of next) {
      visited.add(impactedFile);
    }
    frontier = next;
  }

  return Array.from(impacts.values()).sort((left, right) => {
    const depthDelta = left.depth - right.depth;
    if (depthDelta !== 0) return depthDelta;
    const rankDelta = right.rank - left.rank;
    if (rankDelta !== 0) return rankDelta;
    return left.file_path.localeCompare(right.file_path);
  });
}

async function resolveQueryPaths(root, options = {}) {
  return options.artifactPaths || await resolveAgentifyPaths(root, options.config || {});
}

export async function queryOwner(root, filePath, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const modules = loadModules(db);
    const owner = findOwningModule(modules, filePath);
    const normalized = normalizePath(filePath);

    if (!owner) {
      return { file: normalized, module_id: null, message: "No owning module found" };
    }

    return {
      file: normalized,
      module_id: owner.id,
      module_name: owner.name,
      module_root: owner.root_path,
      doc_path: owner.doc_path,
      stack: owner.stack,
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryDeps(root, moduleId, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const modules = loadModules(db);
    const moduleInfo = modules.find((item) => item.id === moduleId);
    if (!moduleInfo) {
      return { module_id: moduleId, error: "Module not found" };
    }
    const deps = loadModuleDependencies(db, moduleId);
    return {
      module_id: moduleId,
      depends_on: deps.dependsOn,
      used_by: deps.usedBy,
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryChanged(root, sinceCommit, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const modules = loadModules(db);
    const changed = await getChangedFilesSince(root, sinceCommit);
    const affectedModules = new Map();

    for (const entry of changed) {
      const owner = findOwningModule(modules, entry.path);
      if (!owner) {
        continue;
      }
      if (!affectedModules.has(owner.id)) {
        affectedModules.set(owner.id, {
          module_id: owner.id,
          module_name: owner.name,
          changed_files: [],
        });
      }
      affectedModules.get(owner.id).changed_files.push({
        status: entry.status,
        path: entry.path,
      });
    }

    return {
      since: sinceCommit,
      affected_modules: Array.from(affectedModules.values()),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function querySearch(root, term, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    return {
      term,
      ...searchIndex(db, term),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryDef(root, symbol, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    return symbolResolution(symbol, loadSymbolsByName(db, symbol));
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryRefs(root, symbol, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const definitions = loadSymbolsByName(db, symbol);
    const refRows = loadSymbolRefs(db, symbol);

    // Prefer real call-site references (TS/JS). When none exist for this symbol
    // — non-TS/JS languages, or a symbol never referenced — fall back to the
    // legacy file-level import edges, honestly labeled.
    if (refRows.length > 0) {
      const { references, total, truncated } = buildCallSiteReferences(refRows);
      return {
        ...symbolResolution(symbol, definitions),
        granularity: "call-site",
        note: truncated > 0
          ? `${CALL_SITE_REFS_NOTE} Showing the first ${references.length} of ${total} references (${truncated} more not shown).`
          : CALL_SITE_REFS_NOTE,
        references,
      };
    }

    return {
      ...symbolResolution(symbol, definitions),
      granularity: "file-import",
      note: FILE_IMPORT_NOTE,
      references: buildImportEdgeReferences(db, definitions),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryCallers(root, symbol, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const definitions = loadSymbolsByName(db, symbol);
    const resolution = symbolResolution(symbol, definitions);
    const base = {
      symbol: resolution.symbol,
      ambiguous: resolution.ambiguous,
      definitions: resolution.definitions,
      ...(resolution.message ? { message: resolution.message } : {}),
    };

    const callRows = loadSymbolRefs(db, symbol, { callsOnly: true });
    if (callRows.length > 0) {
      const { references, total, truncated } = buildCallSiteReferences(callRows);
      return {
        ...base,
        granularity: "call-site",
        note: truncated > 0
          ? `${CALL_SITE_CALLERS_NOTE} Showing the first ${references.length} of ${total} call sites (${truncated} more not shown).`
          : CALL_SITE_CALLERS_NOTE,
        callers: references,
      };
    }

    return {
      ...base,
      granularity: "file-import",
      note: FILE_IMPORT_NOTE,
      callers: buildImportEdgeReferences(db, definitions),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryImpacts(root, filePath, options = {}) {
  const db = openIndexDatabase(await resolveQueryPaths(root, options), { readOnly: true });
  try {
    const normalized = normalizePath(filePath);
    const depth = normalizeDepth(options.depth);
    return {
      file: normalized,
      depth,
      impacts: computeImpacts(normalized, loadImportEdges(db), depth),
    };
  } finally {
    closeIndexDatabase(db);
  }
}
